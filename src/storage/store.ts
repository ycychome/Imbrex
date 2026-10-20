import { Worker } from 'node:worker_threads';
import { GatewayError } from '../core/errors.js';
import { limits } from '../core/validation.js';
import type { GatewayStore } from '../core/store.js';
import type { Methods, Response } from './protocol.js';

export class SqliteStore implements GatewayStore {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private ready: Promise<void>;
  private exited: Promise<void>;
  private closing = false;
  private failed = false;
  private closeTask?: Promise<void>;

  private constructor(path: string, onFatal: () => void) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { path } });
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    this.exited = new Promise((resolve) => this.worker.once('exit', () => resolve()));
    const failAll = () => {
      if (this.failed) return;
      this.failed = true;
      const error = new GatewayError('storage_unavailable');
      ready.reject(error);
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
      onFatal();
    };
    this.worker.on('error', failAll);
    this.worker.on('exit', () => { if (!this.closing || this.pending.size) failAll(); });
    this.worker.on('message', (message: Response) => {
      if (message.type === 'ready') { ready.resolve(); return; }
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      if (message.type === 'error') task.reject(new GatewayError(message.code));
      else task.resolve(message.result);
    });
  }
  static async open(path: string, onFatal: () => void = () => {}): Promise<SqliteStore> {
    const store = new SqliteStore(path, onFatal);
    try { await store.ready; return store; } catch (error) { await store.worker.terminate(); throw error; }
  }
  private request<K extends keyof Methods>(method: K, args: Methods[K]['args']): Promise<Methods[K]['result']> {
    if (this.failed || (this.closing && method !== 'close')) return Promise.reject(new GatewayError('storage_unavailable'));
    if (this.pending.size >= limits.queue && method !== 'close') return Promise.reject(new GatewayError('busy'));
    const id = ++this.nextId;
    return new Promise<Methods[K]['result']>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as Methods[K]['result']), reject });
      try { this.worker.postMessage({ id, method, args }); } catch { this.pending.delete(id); reject(new GatewayError('storage_unavailable')); }
    });
  }
  info: GatewayStore['info'] = () => this.request('info', []);
  append: GatewayStore['append'] = (...args) => this.request('append', args);
  read: GatewayStore['read'] = (...args) => this.request('read', args);
  lookup: GatewayStore['lookup'] = (...args) => this.request('lookup', args);
  getCall: GatewayStore['getCall'] = (...args) => this.request('getCall', args);
  listCalls: GatewayStore['listCalls'] = (...args) => this.request('listCalls', args);
  createCall: GatewayStore['createCall'] = (...args) => this.request('createCall', args);
  finishCall: GatewayStore['finishCall'] = (...args) => this.request('finishCall', args);
  close(): Promise<void> {
    return this.closeTask ??= (async () => {
      this.closing = true;
      try {
        if (!this.failed) await this.request('close', []);
      } catch (error) {
        await this.worker.terminate();
        throw error;
      } finally { await this.exited; }
    })();
  }
}

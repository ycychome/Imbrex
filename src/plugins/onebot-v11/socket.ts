import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { json, limits, object } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';

export class RequestError extends Error {
  constructor(readonly code: string, readonly dispatched: boolean) { super(code); }
}

export class OneBotSocket {
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  private socket: WebSocket;
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: RequestError) => void }>();
  private heartbeat: ReturnType<typeof setInterval>;
  private alive = true;

  constructor(url: string, token: string | undefined, onEvent: (value: Record<string, unknown>) => void, onError: (code: string) => void) {
    this.socket = new WebSocket(url, {
      maxPayload: limits.valueBytes, perMessageDeflate: false, handshakeTimeout: 5000, followRedirects: false,
      ...(token === undefined ? {} : { headers: { authorization: 'Bearer ' + token } }),
    });
    const opened = Promise.withResolvers<void>();
    this.opened = opened.promise;
    this.socket.once('open', () => opened.resolve());
    this.socket.on('error', () => { onError('onebot_transport_error'); opened.reject(new RequestError('onebot_transport_error', false)); });
    this.closed = new Promise((resolve) => this.socket.once('close', () => {
      clearInterval(this.heartbeat);
      opened.reject(new RequestError('onebot_disconnected', false));
      for (const request of [...this.pending.values()]) request.reject(new RequestError('onebot_disconnected', true));
      resolve();
    }));
    this.socket.on('pong', () => { this.alive = true; });
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState !== WebSocket.OPEN) return;
      if (!this.alive) { onError('onebot_heartbeat_timeout'); this.close(); return; }
      this.alive = false;
      this.socket.ping();
    }, 15_000);
    this.socket.on('message', (raw: RawData, binary: boolean) => {
      try {
        if (binary) throw new Error('Binary message');
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
        const value = object(json(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), limits.valueBytes, 'invalid_event'), 'invalid_event');
        if (typeof value.echo === 'string') { this.pending.get(value.echo)?.resolve(value); return; }
        onEvent(value);
      } catch { onError('onebot_invalid_frame'); this.close(); }
    });
  }

  get connected(): boolean { return this.socket.readyState === WebSocket.OPEN; }

  request(action: string, params: JsonObject = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.connected || signal?.aborted) return Promise.reject(new RequestError('onebot_not_connected', false));
    if (this.pending.size >= limits.handlers) return Promise.reject(new RequestError('onebot_busy', false));
    return new Promise((resolve, reject) => {
      const echo = randomUUID();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(echo); };
      const settle = (error?: RequestError, value?: Record<string, unknown>) => {
        if (!this.pending.has(echo)) return;
        cleanup();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => settle(new RequestError('onebot_request_cancelled', true));
      const timer = setTimeout(() => settle(new RequestError('onebot_request_timeout', true)), 5000);
      this.pending.set(echo, { resolve: (value) => settle(undefined, value), reject: (error) => settle(error) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.socket.send(JSON.stringify({ action, params, echo }), (error) => { if (error) settle(new RequestError('onebot_send_unconfirmed', true)); }); }
      catch { settle(new RequestError('onebot_send_unconfirmed', true)); }
    });
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

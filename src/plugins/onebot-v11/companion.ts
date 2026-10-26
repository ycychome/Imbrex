import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ManagedProcessConfig } from './runtime-config.js';

export type CompanionState = 'disabled' | 'external' | 'starting' | 'running' | 'unready' | 'exited' | 'stopped';

export interface CompanionStatus {
  enabled: boolean;
  state: CompanionState;
  command?: string;
  args?: string[];
  cwd?: string;
  pid?: number;
  started_at?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  logs: string[];
}

const LOG_LINES = 80;
const READY_TIMEOUT_MS = 10_000;
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'];

function redact(line: string, secrets: string[]): string {
  let next = line.replace(/(authorization:\s*bearer\s+)\S+/gi, '$1***');
  for (const secret of secrets) {
    if (secret) next = next.split(secret).join('***');
  }
  return next.length > 500 ? next.slice(0, 500) + '…' : next;
}

function portOf(wsUrl: string): { host: string; port: number } {
  const url = new URL(wsUrl);
  return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === 'wss:' ? 443 : 80 };
}

function reachable(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const abort = () => done(false);
    const done = (value: boolean) => { signal?.removeEventListener('abort', abort); socket.removeAllListeners(); socket.destroy(); resolve(value); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { done(false); return; }
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export class Companion {
  private config: ManagedProcessConfig;
  private active?: ManagedProcessConfig;
  private child?: ChildProcess;
  private launching?: Promise<void>;
  private stopTask?: Promise<void>;
  private closed = Promise.resolve();
  private cleanupOk = true;
  private generation = 0;
  private readiness = Promise.resolve();
  private readyController?: AbortController;
  private stopping = false;
  private state: CompanionState = 'disabled';
  private pid?: number;
  private startedAt?: string;
  private exitCode: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private error?: string;
  private logs: string[] = [];
  private secrets: string[] = [];
  private target: { host: string; port: number };

  constructor(config: ManagedProcessConfig, wsUrl: string, private onLog?: (line: string) => void) {
    this.config = config;
    this.target = portOf(wsUrl);
  }

  /** Persist a new descriptor; the running process is untouched until start/stop/restart. */
  update(config: ManagedProcessConfig): void {
    this.config = config;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('managed_process_stopping'));
    if (this.launching) return this.launching;
    if (this.child) return Promise.resolve();
    if (!this.cleanupOk) return Promise.reject(new Error('managed_process_cleanup_failed'));
    const work = this.launch(++this.generation);
    this.launching = work;
    work.then(() => { this.launching = undefined; }, () => { this.launching = undefined; });
    return work;
  }

  private async launch(generation: number): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      this.error = undefined;
      return;
    }
    const external = await reachable(this.target.host, this.target.port);
    if (generation !== this.generation || this.stopping) return;
    if (external) {
      this.active = { ...this.config };
      this.state = 'external';
      this.error = undefined;
      this.push('port already in use; attaching to the existing process');
      return;
    }
    this.active = { ...this.config };
    const { command, cwd } = this.active;
    if (!command || !cwd) {
      this.state = 'exited';
      this.error = 'managed_process_incomplete';
      this.push('managed process needs command and cwd');
      return;
    }
    const env = Object.create(null) as Record<string, string>;
    for (const key of [...INHERITED, ...(this.config.env_vars ?? [])]) {
      const value = process.env[key];
      if (value === undefined) {
        if ((this.config.env_vars ?? []).includes(key)) {
          this.state = 'exited'; this.error = 'managed_process_env_missing'; this.push(`missing environment variable ${key}`); return;
        }
        continue;
      }
      env[key] = value;
    }
    this.secrets = (this.config.env_vars ?? [])
      .filter((key) => /TOKEN|SECRET|PASSWORD|KEY/i.test(key))
      .map((key) => process.env[key] ?? '')
      .filter(Boolean);
    this.exitCode = null;
    this.signal = null;
    this.error = undefined;
    this.state = 'starting';
    try {
      const child = spawn('tini', ['-s', '--', process.execPath, fileURLToPath(new URL('./companion-supervisor.js', import.meta.url))], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.child = child;
      this.cleanupOk = false;
      this.startedAt = new Date().toISOString();
      this.push(`starting: ${command} ${(this.active.args ?? []).join(' ')}`.trim());
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            this.push(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
          }
          if (buffer.length > 5000) buffer = buffer.slice(-5000);
        });
      }
      child.once('error', (cause) => {
        this.cleanupOk = true; this.error = 'managed_process_spawn_failed';
        this.push(`spawn failed: ${redact(cause.message, this.secrets)}`);
      });
      child.on('message', (raw: unknown) => {
        if (this.child !== child || !raw || typeof raw !== 'object') return;
        const value = raw as Record<string, unknown>;
        if (value.type === 'started' && typeof value.pid === 'number') this.pid = value.pid;
        if (value.type === 'error') this.error = 'managed_process_spawn_failed';
        if (value.type === 'stopped') {
          this.cleanupOk = value.cleanup_ok === true;
          this.exitCode = typeof value.exit_code === 'number' ? value.exit_code : null;
          this.signal = typeof value.signal === 'string' ? value.signal as NodeJS.Signals : null;
        }
      });
      this.closed = new Promise<void>((resolve) => child.once('close', (code) => {
        this.readyController?.abort();
        this.cleanupOk = this.cleanupOk && (code === 0 || this.error === 'managed_process_spawn_failed');
        if (this.child === child) { this.child = undefined; this.pid = undefined; }
        if (!this.cleanupOk) this.error = 'managed_process_cleanup_failed';
        this.state = this.stopping && this.cleanupOk ? 'stopped' : 'exited';
        this.push(`process exited code=${this.exitCode ?? 'null'} signal=${this.signal ?? 'null'}`);
        resolve();
      }));
      child.send({ type: 'start', command, args: this.active.args ?? [], cwd, env }, (error) => {
        if (error) { this.error = 'managed_process_spawn_failed'; child.kill('SIGTERM'); }
      });
      this.readyController = new AbortController();
      this.readiness = this.waitReady(child, this.readyController.signal).catch(() => {
        if (this.child === child && !this.stopping) { this.state = 'unready'; this.error = 'managed_process_not_listening'; }
      });
    } catch (cause) {
      this.state = 'exited';
      this.error = 'managed_process_spawn_failed';
      this.push('spawn failed: managed_process_spawn_failed');
      return;
    }
  }

  private async waitReady(child: ChildProcess, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child !== child || signal.aborted || this.stopping) return;
      const listening = await reachable(this.target.host, this.target.port, signal);
      if (this.child !== child || signal.aborted || this.stopping) return;
      if (listening) {
        this.state = 'running';
        this.error = undefined;
        this.push('managed process is listening');
        return;
      }
      await delay(250, undefined, { signal }).catch(() => {});
    }
    if (this.child === child && !signal.aborted && !this.stopping) {
      this.state = 'unready';
      this.error = 'managed_process_not_listening';
      this.push(`process is running but ${this.target.host}:${this.target.port} is not listening`);
    }
  }

  private push(line: string): void {
    const value = redact(line.replace(/\r$/, ''), this.secrets);
    this.logs.push(value);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    try { this.onLog?.(value); } catch { /* Log observers cannot change process ownership. */ }
  }

  status(): CompanionStatus {
    const active = this.active ?? this.config;
    return {
      enabled: active.enabled,
      state: this.state,
      ...(active.command === undefined ? {} : { command: active.command }),
      ...(active.args === undefined ? {} : { args: [...active.args] }),
      ...(active.cwd === undefined ? {} : { cwd: active.cwd }),
      ...(this.pid === undefined ? {} : { pid: this.pid }),
      ...(this.startedAt === undefined ? {} : { started_at: this.startedAt }),
      ...(this.exitCode === null && this.signal === null ? {} : { exit_code: this.exitCode, signal: this.signal }),
      ...(this.error === undefined ? {} : { error: this.error }),
      logs: [...this.logs],
    };
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    this.generation += 1; this.readyController?.abort();
    const work = this.stopOwned();
    this.stopTask = work;
    work.then(() => { this.stopTask = undefined; this.stopping = false; }, () => { this.stopTask = undefined; this.stopping = false; });
    return work;
  }

  private async stopOwned(): Promise<void> {
    await this.launching;
    const child = this.child;
    if (child) {
      this.push('stopping managed process');
      if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error) child.kill('SIGTERM'); });
      else child.kill('SIGTERM');
      await this.closed;
    }
    await this.readiness;
    if (!this.cleanupOk) throw new Error('managed_process_cleanup_failed');
    this.state = this.config.enabled ? 'stopped' : 'disabled';
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

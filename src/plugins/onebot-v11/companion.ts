import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
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
    if (secret.length >= 6) next = next.split(secret).join('***');
  }
  return next.length > 500 ? next.slice(0, 500) + '…' : next;
}

function portOf(wsUrl: string): { host: string; port: number } {
  const url = new URL(wsUrl);
  return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === 'wss:' ? 443 : 80 };
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
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

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      this.error = undefined;
      return;
    }
    if (this.child) return;
    if (await reachable(this.target.host, this.target.port)) {
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
    this.stopping = false;
    this.exitCode = null;
    this.signal = null;
    this.error = undefined;
    this.state = 'starting';
    try {
      const child = spawn('tini', ['-s', '--', command, ...(this.active.args ?? [])], {
        cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      this.pid = child.pid;
      this.startedAt = new Date().toISOString();
      this.push(`starting pid ${child.pid ?? '?'}: ${command} ${(this.active.args ?? []).join(' ')}`.trim());
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
        this.error = cause.message;
        this.push(`spawn failed: ${cause.message}`);
      });
      child.once('exit', (code, signal) => {
        this.child = undefined;
        this.pid = undefined;
        this.exitCode = code;
        this.signal = signal;
        if (this.stopping) { this.state = 'stopped'; return; }
        this.state = 'exited';
        this.push(`process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      });
    } catch (cause) {
      this.state = 'exited';
      this.error = cause instanceof Error ? cause.message : 'managed_process_spawn_failed';
      this.push(`spawn failed: ${this.error}`);
      return;
    }
    void this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) return;
      if (await reachable(this.target.host, this.target.port)) {
        this.state = 'running';
        this.error = undefined;
        this.push('managed process is listening');
        return;
      }
      await delay(250);
    }
    if (this.child) {
      this.state = 'unready';
      this.error = 'managed_process_not_listening';
      this.push(`process is running but ${this.target.host}:${this.target.port} is not listening`);
    }
  }

  private push(line: string): void {
    const value = redact(line.replace(/\r$/, ''), this.secrets);
    this.logs.push(value);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    this.onLog?.(value);
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

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = this.config.enabled ? 'stopped' : 'disabled';
      return;
    }
    this.stopping = true;
    this.push('stopping managed process');
    const pid = child.pid;
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await Promise.race([exited, delay(3000)]);
    if (this.child) {
      if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
      await Promise.race([exited, delay(1000)]);
    }
    this.child = undefined;
    this.state = 'stopped';
    this.stopping = false;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

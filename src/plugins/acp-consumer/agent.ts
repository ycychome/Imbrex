import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, ndJsonStream, type ClientConnection, type ContentBlock, type InitializeResponse, type PromptResponse } from '@agentclientprotocol/sdk';
import { object, string } from '../../core/validation.js';
import { ConsumerError, consumerLimits, type AgentConfig } from './config.js';
import type { StartAgent } from './supervisor.js';

export class AcpAgent {
  private child: ChildProcess;
  private started = Promise.withResolvers<void>();
  private ended = Promise.withResolvers<void>();
  private connection?: ClientConnection;
  private stopping = false;
  private cleanupOk = false;
  private agentPid?: number;
  private watchdog?: ReturnType<typeof setTimeout>;
  private initialization!: InitializeResponse;
  readonly closed = this.ended.promise;

  private constructor(private config: AgentConfig, env: Record<string, string>, signal: AbortSignal) {
    this.child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const abort = () => this.stop();
    signal.addEventListener('abort', abort, { once: true });
    this.child.on('message', (value: unknown) => {
      try {
        const message = object(value);
        if (message.type === 'started' && typeof message.pid === 'number' && Number.isInteger(message.pid) && message.pid > 1) {
          this.agentPid = message.pid; this.started.resolve();
        } else if (message.type === 'stopped') this.cleanupOk = message.cleanup_ok === true;
        else throw new Error('Unexpected supervisor message');
      } catch { this.started.reject(new ConsumerError('consumer_agent_start_failed')); this.stop(); }
    });
    this.child.on('error', () => { this.started.reject(new ConsumerError('consumer_agent_start_failed')); this.stop(); });
    this.child.once('close', () => {
      clearTimeout(this.watchdog); signal.removeEventListener('abort', abort);
      this.started.reject(new ConsumerError('consumer_agent_start_failed')); this.ended.resolve();
    });
    this.child.stdin!.on('error', () => this.stop()); this.child.stdout!.on('error', () => this.stop());
    this.child.stderr!.resume();
    if (signal.aborted) this.stop();
    else {
      const message: StartAgent = { type: 'start', command: config.command, args: config.args, cwd: config.cwd, env };
      this.child.send(message, (error) => { if (error) { this.started.reject(new ConsumerError('consumer_agent_start_failed')); this.stop(); } });
    }
  }

  static async open(config: AgentConfig, env: Record<string, string>, signal: AbortSignal, onClosed: () => void, onPermissionDenied: () => void): Promise<AcpAgent> {
    const agent = new AcpAgent(config, env, signal);
    try {
      await agent.deadline(agent.started.promise, consumerLimits.setupTimeoutMs);
      if (signal.aborted || agent.stopping) throw new ConsumerError('consumer_agent_stopped');
      // Unencoded child stdout yields Uint8Array bytes; Node and DOM declarations differ for the same Web Stream.
      const output = Readable.toWeb(agent.child.stdout!) as unknown as ReadableStream<Uint8Array>;
      agent.connection = client({ name: 'imbrex-acp-consumer' })
        .onRequest('session/request_permission', () => { onPermissionDenied(); return { outcome: { outcome: 'cancelled' } }; })
        .onNotification('session/update', () => {})
        .connect(ndJsonStream(Writable.toWeb(agent.child.stdin!), output, { maxMessageBytes: consumerLimits.frameBytes }));
      agent.connection.closed.then(() => {
        if (!agent.stopping) { agent.stop(); onClosed(); }
      }).catch(() => agent.stop());
      agent.initialization = await agent.deadline(agent.connection.agent.request('initialize', {
        protocolVersion: 1, clientInfo: { name: 'imbrex', version: '0.1.0-dev' }, clientCapabilities: {},
      }), consumerLimits.setupTimeoutMs);
      if (agent.initialization.protocolVersion !== 1) throw new ConsumerError('consumer_protocol_unsupported');
      return agent;
    } catch (error) {
      await agent.close();
      throw error instanceof ConsumerError ? error : new ConsumerError('consumer_agent_initialize_failed');
    }
  }

  get info(): InitializeResponse { return this.initialization; }
  get available(): boolean { return !this.stopping && this.connection !== undefined && !this.connection.signal.aborted; }
  private get context() {
    if (!this.available) throw new ConsumerError('consumer_agent_disconnected');
    return this.connection!.agent;
  }
  private async deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new ConsumerError('consumer_agent_timeout')); this.stop(); }, milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  async newSession(): Promise<string> {
    try {
      const response = await this.deadline(this.context.request('session/new', { cwd: this.config.cwd, mcpServers: [] }), consumerLimits.setupTimeoutMs);
      return string(response.sessionId, 256);
    } catch (error) { throw error instanceof ConsumerError ? error : new ConsumerError('consumer_session_start_failed'); }
  }
  async loadSession(sessionId: string): Promise<void> {
    if (this.info.agentCapabilities?.loadSession !== true) throw new ConsumerError('consumer_session_restore_unsupported');
    try { await this.deadline(this.context.request('session/load', { sessionId, cwd: this.config.cwd, mcpServers: [] }), consumerLimits.setupTimeoutMs); }
    catch { throw new ConsumerError('consumer_session_restore_failed'); }
  }
  prompt(sessionId: string, prompt: ContentBlock[], timeoutMs: number): Promise<PromptResponse> {
    return this.deadline(this.context.request('session/prompt', { sessionId, prompt }), timeoutMs);
  }
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.connection?.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.child.connected) {
      try { this.child.send({ type: 'shutdown' }, () => {}); } catch { /* EOF also wakes the supervisor. */ }
    }
    this.child.stdin!.end();
    this.watchdog = setTimeout(() => {
      if (this.agentPid !== undefined) { try { process.kill(-this.agentPid, 'SIGKILL'); } catch {} }
      this.child.kill('SIGKILL');
    }, 6000);
  }
  async close(): Promise<void> {
    this.stop();
    await this.closed;
    if (!this.cleanupOk || this.child.exitCode !== 0) throw new ConsumerError('consumer_agent_cleanup_failed');
  }
}

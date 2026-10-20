import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, type Fiber } from 'cordis';
import { Capabilities } from '../core/capabilities.js';
import { Events } from '../core/events.js';
import { requirePermission } from '../core/access.js';
import { fail, GatewayError, publicError, type ErrorCode } from '../core/errors.js';
import { limits, namespacePattern, readOptions } from '../core/validation.js';
import { SqliteStore } from '../storage/store.js';
import type {} from '../plugins/server-http/server.js';
import type { ProtocolApi } from './protocol.js';
import { AdminRegistry } from './admin-registry.js';
import { inspectConfig } from './admin-config.js';
import type { HostConfig, PluginConfig } from './config.js';
import type { PluginModule } from './modules.js';
import type { PluginApi } from './plugin-api.js';
import type { JsonObject, Principal } from '../core/types.js';

type State = 'waiting' | 'loading' | 'active' | 'failed' | 'stopping' | 'stopped';
interface Runtime {
  config: PluginConfig; module?: PluginModule; state: State; available: boolean; controller?: AbortController; fiber?: Fiber;
  cleanup: Set<() => void>; errors: number; stopFailed: boolean; lastError?: { code: string; message: string };
}
interface HostOptions {
  report?: (code: string, fields?: Record<string, string | number | boolean>) => void;
  onFatal?: () => void;
}

export class Host {
  private root = new Context();
  private admin = new AdminRegistry();
  private runtimes = new Map<string, Runtime>();
  private bindings = new WeakMap<Fiber, PluginApi>();
  private store!: SqliteStore;
  private events!: Events;
  private capabilities!: Capabilities;
  private closing = false;
  private accepting = false;
  private failed = false;
  private closeTask?: Promise<void>;
  private ready = Promise.withResolvers<void>();
  private constructor(private config: HostConfig, private options: HostOptions) {
    this.root.logger.bufferSize = 0;
    this.root.logger.exporter({ export: (message) => {
      if (message.type !== 'error') return;
      const fiber = message.fiber?.deref();
      const runtime = this.runtimeFor(fiber);
      if (runtime) {
        runtime.errors += 1;
        if (fiber?.state === 5 || runtime.fiber?.state === 5 || runtime.state === 'stopping') this.stopFailed(runtime);
        else if (!runtime.stopFailed) runtime.lastError = { code: 'plugin_error', message: 'Plugin reported an error.' };
      }
      this.report('plugin_error');
    } });
    this.root.provide('imbrex', { forPlugin: (ctx: Context): PluginApi => {
      let fiber = ctx.fiber;
      for (;;) {
        const api = this.bindings.get(fiber);
        if (api) return api;
        if (fiber.parent.fiber === fiber) return fail('forbidden');
        fiber = fiber.parent.fiber;
      }
    } });
    this.root.provide('protocol', { forPlugin: (ctx: Context): ProtocolApi => {
      const runtime = this.runtimeFor(ctx.fiber);
      if (!runtime || !['builtin:api-rest', 'builtin:adapter-mcp', 'builtin:admin'].includes(runtime.config.module)) fail('forbidden');
      const api = ctx.imbrex.forPlugin(ctx);
      return {
        authenticate: (authorization) => { if (!this.accepting || api.signal.aborted || this.closing) fail('provider_unavailable'); return this.config.authenticate(authorization); },
        store: { info: () => this.store.info() }, events: this.events, capabilities: this.capabilities,
        plugins: () => this.plugins(), report: (code, requestId) => this.report(code, { request_id: requestId }),
        ...(runtime.config.module === 'builtin:admin' ? { admin: { registry: this.admin, configuration: (principal: Principal) => inspectConfig(this.config, principal, this.root.get('http')?.origin ?? null) } } : {}),
      };
    }, reportRequest: (ctx: Context, code: ErrorCode, requestId: string) => {
      if (this.runtimeFor(ctx.fiber)?.config.module !== 'builtin:server-http') fail('forbidden');
      this.report(code, { request_id: requestId });
    } });
    this.root.on('internal/status', (fiber) => {
      for (const runtime of this.runtimes.values()) {
        if (runtime.fiber !== fiber || runtime.state !== 'active') continue;
        if (fiber.state === 5 || fiber.state === 3) {
          runtime.controller?.abort();
          for (const dispose of runtime.cleanup) dispose();
        }
      }
    });
  }
  private report(code: string, fields?: Record<string, string | number | boolean>): void {
    try { this.options.report?.(code, fields); } catch { /* Diagnostic sinks do not control transactions or cleanup. */ }
  }
  private runtimeFor(fiber: Fiber | undefined): Runtime | undefined {
    while (fiber) {
      for (const runtime of this.runtimes.values()) if (runtime.fiber === fiber) return runtime;
      if (fiber.parent.fiber === fiber) return;
      fiber = fiber.parent.fiber;
    }
    return undefined;
  }
  private stopFailed(runtime: Runtime): void {
    runtime.state = 'failed'; runtime.stopFailed = true; runtime.available = false;
    runtime.lastError = { code: 'stop_failed', message: 'Plugin cleanup did not complete.' };
    runtime.controller?.abort();
    for (const dispose of runtime.cleanup) dispose();
    this.report('stop_failed', { plugin_instance_id: runtime.config.id });
  }
  static async open(config: HostConfig, modules: Map<string, PluginModule | undefined>, options: HostOptions = {}): Promise<Host> {
    const host = new Host(config, options);
    try {
      host.store = await SqliteStore.open(join(config.dataDir, 'gateway.db'), () => {
        host.failed = true;
        host.report('storage_worker_failed');
        queueMicrotask(() => { host.close().then(() => options.onFatal?.(), () => options.onFatal?.()); });
      });
      host.events = new Events(host.store, (code) => host.report(code));
      host.capabilities = new Capabilities(host.store, host.events, config.externalWritesEnabled);
      for (const plugin of config.plugins) host.runtimes.set(plugin.id, {
        config: plugin, module: modules.get(plugin.id), state: 'stopped', available: false, cleanup: new Set(), errors: 0, stopFailed: false,
      });
      for (const plugin of config.plugins) if (plugin.enabled) await host.startPlugin(plugin.id);
      if (host.failed) fail('storage_unavailable');
      host.accepting = true;
      host.ready.resolve();
      return host;
    } catch (error) {
      await host.close().catch(() => {});
      throw publicError(error);
    }
  }
  get port(): number { return this.root.get('http')?.port ?? 0; }
  info() { return this.store.info(); }
  plugins() {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.config.id,
      module_name: runtime.module?.name && namespacePattern.test(runtime.module.name) ? runtime.module.name : 'external',
      state: runtime.state === 'active' && runtime.fiber ? (['waiting', 'loading', 'active', 'failed', 'stopped', 'stopping'][runtime.fiber.state] ?? 'failed') : runtime.state,
      required: runtime.config.required, available: runtime.state === 'active' && runtime.fiber?.state === 2 && runtime.available,
      ...(runtime.lastError ? { last_error: runtime.lastError } : {}),
    }));
  }
  private async bounded<T>(promise: PromiseLike<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GatewayError('internal_error', 'Plugin lifecycle timeout')), limits.callTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  private api(runtime: Runtime, ctx: Context, storeId: string): PluginApi {
    const principal = this.config.principals.find((entry) => entry.id === runtime.config.principalId)!;
    const controller = runtime.controller!;
    const ensure = () => { if (this.closing || controller.signal.aborted || (ctx.fiber.state !== 1 && ctx.fiber.state !== 2)) fail('provider_unavailable'); };
    const owned = runtime.cleanup;
    const track = (dispose: () => void) => {
      const cleanup = () => { dispose(); owned.delete(cleanup); };
      owned.add(cleanup); return cleanup;
    };
    const api: PluginApi = {
      storeId, instanceId: runtime.config.id, dataDir: join(this.config.dataDir, 'plugins', runtime.config.id), signal: controller.signal,
      whenReady: async () => { ensure(); await this.ready.promise; ensure(); },
      registerAdminPanel: (panel) => { ensure(); return track(this.admin.register(runtime.config.id, controller.signal, panel)); },
      events: {
        readScope: () => { ensure(); requirePermission(principal, 'events:read'); return { principalId: principal.id, sources: structuredClone(principal.readSources) }; },
        info: async () => { ensure(); const info = await this.store.info(); return { storeId: info.storeId, latestSeq: info.latestSeq }; },
        append: (input) => { ensure(); return this.events.append(principal, storeId, input); },
        read: (options) => { ensure(); return this.events.read(principal, storeId, readOptions(options)); },
        lookup: (ref) => { ensure(); return this.events.lookup(principal, storeId, ref); },
        onAvailable: (callback) => { ensure(); return track(this.events.onAvailable(callback)); },
      },
      capabilities: {
        register: (definition) => { ensure(); return track(this.capabilities.register({ instanceId: runtime.config.id, signal: controller.signal, available: () => runtime.state === 'active' && runtime.fiber?.state === 2 && runtime.available }, definition)); },
        invoke: (id, params, options) => { ensure(); return this.capabilities.invoke(principal, storeId, id, params, options?.callId); },
        getCall: (callId) => { ensure(); return this.capabilities.getCall(principal, storeId, callId); },
      },
      setAvailable: (available, reason) => {
        if (controller.signal.aborted) return;
        runtime.available = available;
        const supplied = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined;
        const code = typeof supplied === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(supplied) ? supplied : publicError(reason).code;
        runtime.lastError = available ? undefined : { code, message: 'Plugin unavailable.' };
        if (!available) this.report('plugin_unavailable', { plugin_instance_id: runtime.config.id });
      },
    };
    this.bindings.set(ctx.fiber, api);
    return api;
  }
  async startPlugin(id: string): Promise<void> {
    if (this.closing) fail('provider_unavailable');
    const runtime = this.runtimes.get(id) ?? fail('not_found');
    if (runtime.stopFailed || ['loading', 'active', 'stopping'].includes(runtime.state)) fail('invalid_request', 'Plugin is already running or failed to stop');
    runtime.state = 'loading'; runtime.available = true; runtime.lastError = undefined;
    runtime.controller = new AbortController(); runtime.cleanup = new Set();
    try {
      const module = runtime.module ?? fail('invalid_request', 'Plugin module unavailable');
      const storeId = (await this.store.info()).storeId;
      await mkdir(join(this.config.dataDir, 'plugins', id), { recursive: true });
      runtime.fiber = this.root.plugin({
        name: id, inject: [...new Set(['imbrex', ...(module.inject ?? [])])],
        Config: module.Config,
        apply: (ctx: Context, config: JsonObject) => {
          if (runtime.stopFailed) fail('internal_error', 'stop_failed');
          if (runtime.controller?.signal.aborted) { runtime.controller = new AbortController(); runtime.cleanup = new Set(); }
          runtime.available = true;
          this.api(runtime, ctx, storeId);
          return module.apply(ctx, config);
        },
      }, runtime.config.config);
      // Cordis plugin() returns a thenable wrapper; lifecycle logs refer to the actual context fiber.
      runtime.fiber = runtime.fiber.ctx.fiber;
      await this.bounded(runtime.fiber.await());
      if (runtime.fiber.state !== 2) fail('provider_unavailable', 'Required plugin services are missing');
      runtime.state = 'active';
    } catch {
      runtime.controller.abort();
      for (const dispose of runtime.cleanup) dispose();
      if (runtime.fiber) await this.bounded(runtime.fiber.dispose()).catch(() => { this.stopFailed(runtime); });
      runtime.state = 'failed'; runtime.available = false;
      if (!runtime.stopFailed) runtime.lastError = { code: 'plugin_start_failed', message: 'Plugin initialization failed.' };
      this.report('plugin_start_failed', { plugin_instance_id: id });
      if (runtime.config.required) fail('provider_unavailable', 'Required plugin initialization failed');
    }
  }
  async stopPlugin(id: string): Promise<void> {
    const runtime = this.runtimes.get(id) ?? fail('not_found');
    if (runtime.stopFailed) fail('internal_error', 'stop_failed');
    if (runtime.state === 'stopped' || runtime.state === 'failed') return;
    if (runtime.state === 'loading') fail('invalid_request', 'Plugin is still starting');
    if (runtime.state === 'stopping') fail('invalid_request');
    runtime.state = 'stopping'; runtime.available = false;
    runtime.controller?.abort();
    const errors = runtime.errors;
    try {
      for (const dispose of runtime.cleanup) dispose();
      await this.bounded(this.capabilities.drain(id));
      if (runtime.fiber) await this.bounded(runtime.fiber.dispose());
      if (runtime.errors > errors || runtime.stopFailed) fail('internal_error', 'stop_failed');
      runtime.state = 'stopped';
    } catch {
      this.stopFailed(runtime);
      throw new GatewayError('internal_error', 'stop_failed');
    }
  }
  close(): Promise<void> {
    return this.closeTask ??= (async () => {
      this.closing = true;
      this.ready.resolve();
      let failure = this.failed;
      this.root.get('http')?.stop();
      this.capabilities?.stop();
      this.events?.stop();
      for (const runtime of this.runtimes.values()) runtime.controller?.abort();
      for (const id of [...this.runtimes.keys()].reverse()) await this.stopPlugin(id).catch(() => { failure = true; });
      await this.capabilities?.drain();
      await this.bounded(this.root.fiber.dispose()).catch(() => { failure = true; });
      await this.store?.close().catch(() => { failure = true; });
      if (failure) fail('internal_error', 'Host shutdown failed');
    })();
  }
}

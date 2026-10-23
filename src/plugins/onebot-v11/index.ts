import { open, readFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from 'cordis';
import { fail, publicError } from '../../core/errors.js';
import { fields, json, limits, object, string } from '../../core/validation.js';
import type { EventInput, EventRef, JsonObject, JsonValue } from '../../core/types.js';
import type { CallOutcome } from '../../core/store.js';
import type {} from '../../host/plugin-api.js';
import { mapMessage, nativeId, parseOneBotConfig, replyAction, replySchema } from './protocol.js';
import { OneBotSocket, RequestError } from './socket.js';
import { Companion } from './companion.js';
import {
  mergeRuntime, parseManagedProcess, parseRuntimeFilters, readRuntimeConfig, writeRuntimeConfig,
  type ManagedProcessConfig, type RuntimeConfig, type RuntimeFilters,
} from './runtime-config.js';

export const name = 'onebot-v11';
export const client = 'entry.js';
export const inject = ['imbrex'];

interface Binding { account_id: string; identity_namespace: string; app_name?: string; app_version?: string; protocol_version?: string }
interface Intercept { time: string; kind: 'group' | 'private'; conversation: string }

function responseData(value: Record<string, unknown>): Record<string, unknown> {
  if (value.status !== 'ok' || value.retcode !== 0) throw new RequestError('onebot_handshake_rejected', false);
  return object(value.data);
}

const filterSchema = {
  type: 'object',
  properties: {
    group_ids: { type: 'array', items: { type: 'string' } },
    private_user_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['group_ids', 'private_user_ids'],
  additionalProperties: false,
};
const allowSchema = {
  type: 'object',
  properties: { kind: { enum: ['group', 'private'] }, id: { type: 'string', minLength: 1, maxLength: 20 } },
  required: ['kind', 'id'],
  additionalProperties: false,
};
const managedSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    command: { type: 'string', maxLength: 4096 },
    args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string', maxLength: 4096 },
    env_vars: { type: 'array', items: { type: 'string', maxLength: 256 } },
  },
  required: ['enabled'],
  additionalProperties: false,
};
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  const hostConfig = parseOneBotConfig(input);
  const api = ctx.imbrex.forPlugin(ctx);
  const token = hostConfig.tokenEnv === undefined ? undefined : process.env[hostConfig.tokenEnv];
  if (hostConfig.tokenEnv !== undefined && (!token || !/^[\x21-\x7e]+$/.test(token))) fail('invalid_request', 'Missing or invalid OneBot token');

  const runtime = await readRuntimeConfig(api.dataDir);
  let runtimeConfig: RuntimeConfig | undefined = runtime.config;
  let runtimeError = runtime.error;
  let managedConfig: ManagedProcessConfig = runtimeConfig?.managed_process ?? { enabled: false };
  let scopeSource: 'host' | 'runtime' = runtimeConfig?.runtime_filters ? 'runtime' : 'host';
  const config = {
    ...hostConfig,
    groupIds: [...(runtimeConfig?.runtime_filters?.group_ids ?? hostConfig.groupIds)],
    privateIds: [...(runtimeConfig?.runtime_filters?.private_user_ids ?? hostConfig.privateIds)],
  };
  const companion = new Companion(managedConfig, config.wsUrl);

  const bindingPath = join(api.dataDir, 'onebot-binding.json');
  let binding: Binding | undefined;
  try {
    const saved = object(JSON.parse(await readFile(bindingPath, 'utf8')));
    binding = { account_id: nativeId(saved.account_id), identity_namespace: string(saved.identity_namespace, 64) };
    for (const key of ['app_name', 'app_version', 'protocol_version'] as const) {
      if (saved[key] !== undefined) binding[key] = string(saved[key], 128);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) fail('invalid_request', 'Cannot read OneBot identity binding');
  }
  if (binding && (binding.account_id !== config.accountId || binding.identity_namespace !== config.identityNamespace)) fail('invalid_request', 'OneBot identity binding changed; use a new plugin instance');

  let connection: OneBotSocket | undefined;
  let ready = false;
  let queue: EventInput[] = [];
  let draining = false;
  let worker = Promise.resolve();
  let lastCode = 'onebot_connecting';
  const startedAt = new Date().toISOString();
  let accepted = 0n;
  let duplicates = 0n;
  const intercepts: Intercept[] = [];
  const unavailable = (code: string) => { lastCode = code; ready = false; api.setAvailable(false, { code }); };
  unavailable(lastCode);

  const scope = (): { group_ids: string[]; private_user_ids: string[]; source: 'host' | 'runtime' } => ({
    group_ids: [...config.groupIds], private_user_ids: [...config.privateIds], source: scopeSource,
  });

  async function persistFilters(next: RuntimeFilters): Promise<void> {
    const merged = mergeRuntime(runtimeConfig, { filters: next });
    await writeRuntimeConfig(api.dataDir, merged);
    runtimeConfig = merged;
    runtimeError = undefined;
    config.groupIds = [...next.group_ids];
    config.privateIds = [...next.private_user_ids];
    scopeSource = 'runtime';
  }

  function recordIntercept(kind: 'group' | 'private', conversation: string): void {
    const index = intercepts.findIndex((item) => item.kind === kind && item.conversation === conversation);
    if (index >= 0) intercepts.splice(index, 1);
    intercepts.push({ time: new Date().toISOString(), kind, conversation });
    if (intercepts.length > 10) intercepts.splice(0, intercepts.length - 10);
  }

  function forgetIntercept(kind: 'group' | 'private', conversation: string): void {
    const index = intercepts.findIndex((item) => item.kind === kind && item.conversation === conversation);
    if (index >= 0) intercepts.splice(index, 1);
  }

  // Only messages that map cleanly but fall outside the allowlist are sampled;
  // malformed frames keep their existing error path.
  function outsideScope(value: unknown): Intercept | undefined {
    let item: Record<string, unknown>;
    try { item = object(value); } catch { return; }
    if (item.post_type !== 'message') return;
    const kind = item.message_type;
    if (kind !== 'group' && kind !== 'private') return;
    let conversation: string;
    try { conversation = nativeId(kind === 'group' ? item.group_id : item.user_id); } catch { return; }
    if ((kind === 'group' ? config.groupIds : config.privateIds).includes(conversation)) return;
    return { time: new Date().toISOString(), kind, conversation };
  }

  async function saveFilters(value: unknown): Promise<JsonValue> {
    const next = parseRuntimeFilters(value);
    await persistFilters(next);
    return { status: 'succeeded', scope: scope() };
  }

  async function allowConversation(value: unknown): Promise<JsonValue> {
    const item = object(value);
    fields(item, ['kind', 'id'], ['kind', 'id']);
    if (item.kind !== 'group' && item.kind !== 'private') fail('invalid_request');
    const id = nativeId(item.id);
    const next = {
      group_ids: item.kind === 'group' ? [...new Set([...config.groupIds, id])] : [...config.groupIds],
      private_user_ids: item.kind === 'private' ? [...new Set([...config.privateIds, id])] : [...config.privateIds],
    };
    await persistFilters(next);
    forgetIntercept(item.kind, id);
    return { status: 'succeeded', scope: scope() };
  }

  async function resetRuntime(): Promise<JsonValue> {
    const merged: RuntimeConfig = {
      version: 1,
      ...(runtimeConfig?.managed_process === undefined ? {} : { managed_process: runtimeConfig.managed_process }),
    };
    await writeRuntimeConfig(api.dataDir, merged);
    runtimeConfig = merged;
    runtimeError = undefined;
    config.groupIds = [...hostConfig.groupIds];
    config.privateIds = [...hostConfig.privateIds];
    scopeSource = 'host';
    return { status: 'succeeded', scope: scope() };
  }

  async function saveManaged(value: unknown): Promise<JsonValue> {
    const managed = parseManagedProcess(value);
    if (managed.enabled) {
      if (!managed.command) fail('invalid_request', 'command is required');
      if (!managed.cwd || !isAbsolute(managed.cwd)) fail('invalid_request', 'cwd must be an absolute path');
    }
    for (const name of managed.env_vars ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('invalid_request', 'Invalid environment name');
    const merged = mergeRuntime(runtimeConfig, { managed });
    await writeRuntimeConfig(api.dataDir, merged);
    runtimeConfig = merged;
    runtimeError = undefined;
    managedConfig = managed;
    companion.update(managed);
    return { status: 'succeeded', restart_required: true, saved: json(managed, limits.httpBytes) };
  }

  api.registerAdminPanel({
    title: 'OneBot v11', icon: 'onebot',
    actions: [
      { id: 'save-runtime-filters', title: 'Replace runtime allowlists', inputSchema: filterSchema,
        execute: async (value) => await saveFilters(value) },
      { id: 'allow-conversation', title: 'Allow one conversation', inputSchema: allowSchema,
        execute: async (value) => await allowConversation(value) },
      { id: 'reset-runtime-config', title: 'Restore host allowlists', inputSchema: emptySchema,
        execute: async () => await resetRuntime() },
      { id: 'save-managed-process', title: 'Save companion process settings', inputSchema: managedSchema,
        execute: async (value) => await saveManaged(value) },
      { id: 'start-managed-process', title: 'Start companion process', inputSchema: emptySchema,
        execute: async () => {
          if (!managedConfig.enabled) fail('feature_unavailable', 'Companion process is disabled');
          await companion.start();
          return { status: 'succeeded', process: json(companion.status(), limits.httpBytes) };
        } },
      { id: 'stop-managed-process', title: 'Stop companion process', inputSchema: emptySchema,
        execute: async () => { await companion.stop(); return { status: 'succeeded', process: json(companion.status(), limits.httpBytes) }; } },
      { id: 'restart-managed-process', title: 'Restart companion process', inputSchema: emptySchema,
        execute: async () => {
          if (!managedConfig.enabled) fail('feature_unavailable', 'Companion process is disabled');
          await companion.restart();
          return { status: 'succeeded', process: json(companion.status(), limits.httpBytes) };
        } },
      { id: 'reconnect', title: 'Reconnect WebSocket', inputSchema: emptySchema,
        execute: async () => { connection?.close(); return { status: 'succeeded', reconnecting: true }; } },
    ],
    read: () => {
      const connected = ready && Boolean(connection?.connected);
      const metrics = connection?.metrics() ?? null;
      const process = companion.status();
      return {
        status: connected
          ? { tone: 'ok', label: '已连接' }
          : { tone: ready ? 'warning' : 'error', label: ready ? '连接中' : '未连接' },
        metrics: [
          { label: '账号', value: config.accountId },
          { label: '已接纳事件', value: accepted.toString() },
          { label: '重复事件', value: duplicates.toString() },
          { label: '排队事件', value: String(queue.length) },
          { label: '接收帧', value: metrics?.received_frames ?? '未提供' },
          { label: '已发请求', value: metrics?.sent_requests ?? '未提供' },
          { label: '心跳 RTT', value: metrics?.heartbeat_rtt_ms === null || metrics?.heartbeat_rtt_ms === undefined ? '未提供' : `${metrics.heartbeat_rtt_ms} ms` },
          { label: '采集来源', value: scopeSource === 'runtime' ? '插件配置' : '宿主配置' },
          { label: '伴生进程', value: process.state },
        ],
        data: json({
          store_id: api.storeId,
          connected, account_verified: ready, account_id: config.accountId, identity_namespace: config.identityNamespace,
          binding: binding ? { ...binding } : null, started_at: startedAt, last_error: ready ? null : lastCode,
          accepted_events: accepted.toString(), duplicate_events: duplicates.toString(), queued_events: queue.length,
          connection_metrics: metrics,
          scope: scope(),
          runtime_config: { error: runtimeError ?? null },
          managed_process: { saved: managedConfig, active: process },
          intercepts: [...intercepts],
        }, limits.httpBytes) as Record<string, JsonValue>,
      };
    },
  });

  const drain = () => {
    if (draining || !ready || !queue.length || api.signal.aborted) return;
    draining = true;
    worker = (async () => {
      try {
        while (ready && queue.length && !api.signal.aborted) {
          const result = await api.events.append(queue.shift()!);
          if (result.status === 'created') accepted += 1n; else duplicates += 1n;
        }
      } catch { unavailable('onebot_ingress_failed'); connection?.close(); }
      finally { draining = false; }
    })();
  };

  ctx.effect(() => api.capabilities.register<{ input_event_ref: EventRef; text: string }, never>({
    localName: 'reply', description: 'Reply to a permitted inbound QQ message in its original conversation.',
    schemaVersion: '1', isSideEffectful: true, inputSchema: replySchema,
    handler: async ({ input_event_ref: ref, text }, invocation): Promise<CallOutcome> => {
      let action: ReturnType<typeof replyAction>;
      let target: JsonObject;
      try {
        const record = await invocation.readEvent(ref);
        action = replyAction(record, text, config);
        const data = object(record.event.data);
        target = { account_id: config.accountId, conversation_type: String(data.conversation_type), conversation_id: String(data.conversation_id) };
      } catch (error) { return { status: 'failed', reason: { code: publicError(error).code, message: 'Reply reference rejected before dispatch.' } }; }
      const active = connection;
      if (!ready || !active) return { status: 'failed', reason: { code: 'onebot_not_connected', message: 'No verified connection.' } };
      try {
        const response = await active.request(action.action, action.params, invocation.signal);
        if (response.status === 'failed' && [1400, 1401, 1403, 1404].includes(Number(response.retcode)) && typeof response.retcode === 'number') {
          return { status: 'failed', reason: { code: 'onebot_rejected', message: 'OneBot rejected the Action before execution.' } };
        }
        if (response.status !== 'ok' || response.retcode !== 0) throw new RequestError('onebot_result_unconfirmed', true);
        const messageId = nativeId(object(response.data).message_id, true);
        return { status: 'succeeded', result: { ...target, native_message_id: messageId } };
      } catch (error) {
        const known = error instanceof RequestError;
        return { status: known && !error.dispatched ? 'failed' : 'unknown', reason: {
          code: known ? error.code : 'onebot_result_unconfirmed', message: 'OneBot send result could not be confirmed.',
        } };
      }
    },
  }));

  const run = async () => {
    while (!api.signal.aborted) {
      let active: OneBotSocket | undefined;
      try {
        active = new OneBotSocket(config.wsUrl, token, (value) => {
          if (api.signal.aborted) return;
          const outside = outsideScope(value);
          if (outside) { recordIntercept(outside.kind, outside.conversation); return; }
          try {
            const event = mapMessage(value, config);
            if (!event) return;
            if (queue.length >= limits.queue) { unavailable('onebot_ingress_overflow'); active?.close(); return; }
            queue.push(event); drain();
          } catch { unavailable('onebot_invalid_event'); active?.close(); }
        }, unavailable);
        connection = active;
        await active.opened;
        const [version, login] = await Promise.all([
          active.request('get_version_info', {}, api.signal).then(responseData),
          active.request('get_login_info', {}, api.signal).then(responseData),
        ]);
        if (nativeId(login.user_id) !== config.accountId) throw new RequestError('onebot_account_mismatch', false);
        const next: Binding = { ...binding, account_id: config.accountId, identity_namespace: config.identityNamespace };
        for (const key of ['app_name', 'app_version', 'protocol_version'] as const) {
          if (version[key] !== undefined) next[key] = string(version[key], 128);
        }
        if (next.protocol_version !== undefined && !['v11', '11'].includes(next.protocol_version)) throw new RequestError('onebot_protocol_mismatch', false);
        if (binding?.app_name && next.app_name !== binding.app_name) throw new RequestError('onebot_implementation_changed', false);
        const file = await open(bindingPath + '.tmp', 'w', 0o600);
        try { await file.writeFile(JSON.stringify(next) + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(bindingPath + '.tmp', bindingPath);
        const directory = await open(api.dataDir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        binding = next;
        if (active.connected && !api.signal.aborted) {
          ready = true; api.setAvailable(true); drain();
          await active.closed;
          if (ready) unavailable('onebot_disconnected');
        }
      } catch (error) { unavailable(error instanceof RequestError ? error.code : 'onebot_handshake_failed'); }
      finally {
        ready = false; queue = [];
        active?.close(); await active?.closed; await worker;
        connection = undefined;
      }
      if (!api.signal.aborted) await delay(1000, undefined, { signal: api.signal }).catch(() => {});
    }
  };
  const abort = () => { ready = false; queue = []; connection?.close(); };
  api.signal.addEventListener('abort', abort, { once: true });
  if (managedConfig.enabled) void companion.start();
  const running = run().catch(() => unavailable('onebot_connection_failed'));
  ctx.effect(() => async () => {
    abort(); api.signal.removeEventListener('abort', abort);
    await running; await worker;
    await companion.stop();
  });
}

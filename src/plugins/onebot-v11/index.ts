import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from 'cordis';
import { fail, publicError } from '../../core/errors.js';
import { limits, object, string } from '../../core/validation.js';
import type { EventInput, EventRef, JsonObject } from '../../core/types.js';
import type { CallOutcome } from '../../core/store.js';
import type {} from '../../host/plugin-api.js';
import { mapMessage, nativeId, parseOneBotConfig, replyAction, replySchema } from './protocol.js';
import { OneBotSocket, RequestError } from './socket.js';

export const name = 'onebot-v11';
export const client = 'entry.js';
export const inject = ['imbrex'];

interface Binding { account_id: string; identity_namespace: string; app_name?: string; app_version?: string; protocol_version?: string }

function responseData(value: Record<string, unknown>): Record<string, unknown> {
  if (value.status !== 'ok' || value.retcode !== 0) throw new RequestError('onebot_handshake_rejected', false);
  return object(value.data);
}

export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  const config = parseOneBotConfig(input);
  const api = ctx.imbrex.forPlugin(ctx);
  const token = config.tokenEnv === undefined ? undefined : process.env[config.tokenEnv];
  if (config.tokenEnv !== undefined && (!token || !/^[\x21-\x7e]+$/.test(token))) fail('invalid_request', 'Missing or invalid OneBot token');
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
  const unavailable = (code: string) => { lastCode = code; ready = false; api.setAvailable(false, { code }); };
  unavailable(lastCode);
  api.registerAdminPanel({ title: 'OneBot v11', icon: 'onebot', read: () => {
    const connected = ready && Boolean(connection?.connected);
    const metrics = connection?.metrics() ?? null;
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
      ],
      data: {
        connected, account_verified: ready, account_id: config.accountId, identity_namespace: config.identityNamespace,
        binding: binding ? { ...binding } : null, started_at: startedAt, last_error: ready ? null : lastCode,
        accepted_events: accepted.toString(), duplicate_events: duplicates.toString(), queued_events: queue.length,
        connection_metrics: metrics,
      },
    };
  } });
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
  const running = run().catch(() => unavailable('onebot_connection_failed'));
  ctx.effect(() => async () => {
    abort(); api.signal.removeEventListener('abort', abort);
    await running; await worker;
  });
}

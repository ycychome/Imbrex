import type { Invocation } from '../../core/capabilities.js';
import { fail, GatewayError, publicError } from '../../core/errors.js';
import type { CallOutcome } from '../../core/store.js';
import type { EventRecord, JsonObject, JsonValue } from '../../core/types.js';
import { eventRef, json, limits, object, string } from '../../core/validation.js';
import type { PluginApi } from '../../host/plugin-api.js';
import { messageSegments, nativeId, requestId, sourceFor, type OneBotConfig } from './protocol.js';
import { RequestError } from './socket.js';

type Request = (action: string, params: JsonObject, signal: AbortSignal) => Promise<Record<string, unknown>>;
export function safeRevoke(appName: string | undefined): boolean { return Boolean(appName && !appName.toLowerCase().includes('snowluma')); }
interface Target { type: 'group' | 'private'; id: string }
const idSchema = { type: 'string', minLength: 1, maxLength: 20 };
const refSchema = { type: 'object', properties: { source: { type: 'string', minLength: 1, maxLength: 1024 }, id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['source', 'id'], additionalProperties: false };
const targetSchema = { type: 'object', properties: { type: { enum: ['group', 'private'] }, id: idSchema }, required: ['type', 'id'], additionalProperties: false };
const pageSchema = { limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 } };
const schema = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export class SentMessages {
  private entries = new Map<string, { source: string; ambiguous: boolean }>();
  remember(id: string, source: string): void {
    const previous = this.entries.get(id);
    this.entries.delete(id);
    this.entries.set(id, { source, ambiguous: previous?.ambiguous === true || (previous !== undefined && previous.source !== source) });
    if (this.entries.size > 1000) this.entries.delete(this.entries.keys().next().value!);
  }
  proves(id: string, source: string): boolean { const proof = this.entries.get(id); return proof?.source === source && !proof.ambiguous; }
  observe(id: string, source: string, self: boolean): void {
    const proof = this.entries.get(id);
    if (proof && (!self || proof.source !== source)) proof.ambiguous = true;
  }
  clear(): void { this.entries.clear(); }
}

function optionalText(value: unknown, bytes = 512): string | null { return value === undefined || value === null ? null : string(value, bytes, 'invalid_params', true); }
function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('provider_unavailable');
  return value;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail('provider_unavailable'); return value; }
function page(items: JsonObject[], params: Record<string, unknown>): JsonValue {
  const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 20);
  const selected = items.slice(offset, offset + limit);
  for (;;) {
    const next = offset + selected.length;
    const output = { items: selected, total: items.length, has_more: next < items.length, next_offset: next < items.length ? next : null };
    if (Buffer.byteLength(JSON.stringify(output)) <= limits.valueBytes) return json(output);
    if (selected.length <= 1) fail('payload_too_large');
    selected.pop();
  }
}

export function registerQQCapabilities(api: PluginApi, config: OneBotConfig, request: Request, sent: SentMessages, connectionStatus: () => JsonValue, revokeAvailable: () => boolean): () => void {
  const disposers: (() => void)[] = [];
  const source = (target: Target) => sourceFor(config, target.type, target.id);
  const allowed = (target: Target, invocation: Invocation) => {
    invocation.requireReadSource(source(target));
    if (!(target.type === 'group' ? config.groupIds : config.privateIds).includes(target.id)) fail('forbidden');
  };
  const target = (input: unknown, invocation: Invocation): Target => {
    const value = object(input, 'invalid_params');
    if (value.type !== 'group' && value.type !== 'private') fail('invalid_params');
    const result: Target = { type: value.type, id: nativeId(value.id) };
    allowed(result, invocation); return result;
  };
  const group = (params: Record<string, unknown>, invocation: Invocation): Target => target({ type: 'group', id: params.group_id }, invocation);
  const data = async (action: string, params: JsonObject, invocation: Invocation): Promise<unknown> => {
    const response = await request(action, params, invocation.signal);
    if (response.status === 'failed' && response.retcode === 1404) fail('feature_unavailable');
    if (response.status === 'failed' && response.retcode === 1403) fail('forbidden');
    if (response.status !== 'ok' || response.retcode !== 0) fail('provider_unavailable');
    return response.data;
  };
  const member = async (scope: Target, user: string, invocation: Invocation): Promise<JsonObject> => {
    const raw = object(await data('get_group_member_info', { group_id: Number(scope.id), user_id: Number(user) }, invocation));
    if (nativeId(raw.user_id) !== user || nativeId(raw.group_id) !== scope.id) fail('provider_unavailable');
    return { group_id: scope.id, user_id: user, nickname: optionalText(raw.nickname), card: optionalText(raw.card),
      role: ['owner', 'admin', 'member'].includes(String(raw.role)) ? String(raw.role) : null, join_time: optionalCount(raw.join_time) };
  };
  const administrator = async (scope: Target, invocation: Invocation): Promise<void> => {
    if (!['owner', 'admin'].includes(String((await member(scope, config.accountId, invocation)).role))) fail('forbidden');
  };
  const trusted = async (input: unknown, invocation: Invocation, expected = 'message'): Promise<{ record: EventRecord; scope: Target; body: Record<string, unknown> }> => {
    const record = await invocation.readEvent(eventRef(input));
    const body = object(record.event.data, 'invalid_params');
    const kind = expected === 'request' ? (body.request_type === 'group' ? 'group' : 'private') : body.conversation_type;
    const scope = target({ type: kind, id: body.conversation_id }, invocation);
    if (record.parents.length || body.account_id !== config.accountId || body.identity_namespace !== config.identityNamespace || record.event.source !== source(scope)) fail('invalid_params');
    if (expected === 'message') {
      if (record.event.type !== 'qq.message.' + scope.type || record.event.id !== 'message:' + nativeId(body.native_message_id, true)) fail('invalid_params');
    } else {
      const requestKind = body.request_type;
      if (requestKind !== 'friend' && requestKind !== 'group') fail('invalid_params');
      const user = nativeId(body.user_id), subtype = string(body.sub_type, 16, 'invalid_params');
      if ((requestKind === 'friend' && (scope.id !== user || subtype !== 'friend')) || (requestKind === 'group' && (nativeId(body.group_id) !== scope.id || !['add', 'invite'].includes(subtype)))) fail('invalid_params');
      if (record.event.type !== 'qq.request.' + requestKind || record.event.id !== requestId(config, requestKind, scope.id, user, subtype, string(body.flag, 2048, 'invalid_params'))) fail('invalid_params');
    }
    return { record, scope, body };
  };
  const segment = (body: Record<string, unknown>, index: unknown, type: string): Record<string, unknown> => {
    const segments = array(body.message_segments);
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) fail('invalid_params');
    const item = object(segments[index], 'invalid_params');
    if (item.type !== type) fail('invalid_params');
    return object(item.data, 'invalid_params');
  };
  const normalizeMessage = (input: unknown, scope: Target, expectedId?: string, anchored = false): JsonObject => {
    const raw = object(input, 'invalid_params');
    const messageId = nativeId(raw.message_id, true);
    if (expectedId !== undefined && messageId !== expectedId) fail('provider_unavailable');
    if (raw.message_type !== scope.type) fail('forbidden');
    const sender = nativeId(object(raw.sender).user_id);
    if (scope.type === 'group') {
      if (raw.group_id !== undefined ? nativeId(raw.group_id) !== scope.id : !anchored) fail('forbidden');
      if (raw.target_id !== undefined && nativeId(raw.target_id) !== scope.id) fail('forbidden');
    } else {
      if (sender !== config.accountId && sender !== scope.id) fail('forbidden');
      if (sender === config.accountId) {
        if (raw.target_id !== undefined ? nativeId(raw.target_id) !== scope.id : !anchored && !sent.proves(messageId, source(scope))) fail('forbidden');
      } else if (raw.target_id !== undefined && nativeId(raw.target_id) !== config.accountId) fail('forbidden');
      if (raw.user_id !== undefined && nativeId(raw.user_id) !== config.accountId && nativeId(raw.user_id) !== scope.id) fail('forbidden');
    }
    return { native_message_id: messageId, conversation_type: scope.type, conversation_id: scope.id, sender_id: sender,
      time: optionalCount(raw.time), segments: messageSegments(raw.message) };
  };
  const readMessage = async (scope: Target, id: string, invocation: Invocation, anchored = false) => normalizeMessage(await data('get_msg', { message_id: Number(id) }, invocation), scope, id, anchored);
  const read = (name: string, description: string, inputSchema: object, handler: (params: Record<string, unknown>, invocation: Invocation) => Promise<JsonValue> | JsonValue) => {
    disposers.push(api.capabilities.register<JsonObject>({ localName: name, description, inputSchema, schemaVersion: '1', isSideEffectful: false,
      handler: async (params, invocation) => {
        try { return json(await handler(params, invocation)); }
        catch (error) { if (error instanceof GatewayError) throw error; fail('provider_unavailable'); }
      },
    }));
  };
  const write = (name: string, description: string, inputSchema: object, prepare: (params: Record<string, unknown>, invocation: Invocation) => Promise<{ action: string; params: JsonObject; scope: Target; sends?: boolean }>, available?: () => boolean) => {
    disposers.push(api.capabilities.register<JsonObject, never>({ localName: name, description, inputSchema, available, schemaVersion: '1', isSideEffectful: true,
      handler: async (params, invocation): Promise<CallOutcome> => {
        let operation: Awaited<ReturnType<typeof prepare>>;
        try { operation = await prepare(params, invocation); }
        catch (error) { return { status: 'failed', reason: { code: error instanceof RequestError ? error.code : publicError(error).code, message: 'QQ operation rejected before dispatch.' } }; }
        try {
          allowed(operation.scope, invocation);
        } catch (error) { return { status: 'failed', reason: { code: publicError(error).code, message: 'QQ target rejected before dispatch.' } }; }
        try {
          const response = await request(operation.action, operation.params, invocation.signal);
          if (response.status === 'failed' && typeof response.retcode === 'number' && [1400, 1401, 1403, 1404].includes(response.retcode)) return { status: 'failed', reason: { code: 'onebot_rejected', message: 'OneBot explicitly rejected the Action.' } };
          if (response.status !== 'ok' || response.retcode !== 0) throw new RequestError('onebot_result_unconfirmed', true);
          const result: JsonObject = { account_id: config.accountId, conversation_type: operation.scope.type, conversation_id: operation.scope.id };
          if (operation.sends) {
            const id = nativeId(object(response.data).message_id, true);
            result.native_message_id = id; sent.remember(id, source(operation.scope));
          }
          return { status: 'succeeded', result };
        } catch (error) {
          return { status: error instanceof RequestError && !error.dispatched ? 'failed' : 'unknown', reason: { code: error instanceof RequestError ? error.code : 'onebot_result_unconfirmed', message: 'QQ operation result could not be confirmed.' } };
        }
      },
    }));
  };

  read('get_login_info', 'Read this verified QQ account identity.', schema({}), async (_params, invocation) => {
    const raw = object(await data('get_login_info', {}, invocation));
    if (nativeId(raw.user_id) !== config.accountId) fail('provider_unavailable');
    return { account_id: config.accountId, nickname: optionalText(raw.nickname) };
  });
  read('get_connection_status', 'Read verified connection status and measured transport metrics.', schema({}), () => connectionStatus());
  for (const kind of ['group', 'private'] as const) {
    read(kind === 'group' ? 'list_groups' : 'list_friends', 'List only permitted QQ ' + (kind === 'group' ? 'groups' : 'friends') + '; offset pages are live, not snapshots.', schema(pageSchema, []), async (params, invocation) => {
      const raw = array(await data(kind === 'group' ? 'get_group_list' : 'get_friend_list', {}, invocation));
      const items: JsonObject[] = [];
      for (const input of raw) {
        const item = object(input), id = nativeId(item[kind === 'group' ? 'group_id' : 'user_id']);
        if (!(kind === 'group' ? config.groupIds : config.privateIds).includes(id)) continue;
        try { invocation.requireReadSource(source({ type: kind, id })); } catch (error) { if (error instanceof GatewayError && error.code === 'forbidden') continue; throw error; }
        items.push(kind === 'group' ? { group_id: id, group_name: optionalText(item.group_name) } : { user_id: id, nickname: optionalText(item.nickname), remark: optionalText(item.remark) });
      }
      items.sort((a, b) => String(a.group_id ?? a.user_id).localeCompare(String(b.group_id ?? b.user_id), 'en'));
      return page(items, params);
    });
  }
  read('get_group_info', 'Read information for a permitted QQ group.', schema({ group_id: idSchema }), async (params, invocation) => {
    const scope = group(params, invocation), raw = object(await data('get_group_info', { group_id: Number(scope.id) }, invocation));
    if (nativeId(raw.group_id) !== scope.id) fail('provider_unavailable');
    return { group_id: scope.id, group_name: optionalText(raw.group_name), member_count: optionalCount(raw.member_count), max_member_count: optionalCount(raw.max_member_count) };
  });
  read('list_group_members', 'Read a live page of members in a permitted group; upstream response is bounded.', schema({ group_id: idSchema, ...pageSchema }, ['group_id']), async (params, invocation) => {
    const scope = group(params, invocation), raw = array(await data('get_group_member_list', { group_id: Number(scope.id) }, invocation));
    const items = raw.map((input) => {
      const item = object(input);
      if (item.group_id !== undefined && nativeId(item.group_id) !== scope.id) fail('provider_unavailable');
      return { user_id: nativeId(item.user_id), nickname: optionalText(item.nickname), card: optionalText(item.card), role: ['owner', 'admin', 'member'].includes(String(item.role)) ? String(item.role) : null };
    });
    items.sort((a, b) => a.user_id.localeCompare(b.user_id, 'en'));
    return page(items, params);
  });
  read('get_group_member_info', 'Read one member in a permitted group.', schema({ group_id: idSchema, user_id: idSchema }), (params, invocation) => member(group(params, invocation), nativeId(params.user_id), invocation));
  read('get_user_info', 'Read an authorized private peer or a member of an authorized group, never an arbitrary global user.', schema({ user_id: idSchema, context: targetSchema }, ['user_id']), async (params, invocation) => {
    const user = nativeId(params.user_id);
    const scope = params.context === undefined ? target({ type: 'private', id: user }, invocation) : target(params.context, invocation);
    if (scope.type === 'group') return member(scope, user, invocation);
    if (scope.id !== user) fail('forbidden');
    const raw = object(await data('get_stranger_info', { user_id: Number(user) }, invocation));
    if (nativeId(raw.user_id) !== user) fail('provider_unavailable');
    return { user_id: user, nickname: optionalText(raw.nickname), sex: optionalText(raw.sex, 32), age: optionalCount(raw.age) };
  });
  read('get_message', 'Read a scoped message; missing remote target metadata requires a trusted input_event_ref or confirmed send proof.', schema({ target: targetSchema, message_id: idSchema, input_event_ref: refSchema }, ['target', 'message_id']), async (params, invocation) => {
    const scope = target(params.target, invocation), id = nativeId(params.message_id, true);
    let anchored = sent.proves(id, source(scope));
    if (params.input_event_ref !== undefined) {
      const original = await trusted(params.input_event_ref, invocation);
      if (source(original.scope) !== source(scope) || nativeId(original.body.native_message_id, true) !== id) fail('invalid_params');
      anchored = true;
    }
    return readMessage(scope, id, invocation, anchored);
  });
  read('get_reply_context', 'Read the reply referenced by a trusted, permitted QQ message.', schema({ input_event_ref: refSchema }), async (params, invocation) => {
    const original = await trusted(params.input_event_ref, invocation);
    const replies = array(original.body.message_segments).map((item) => object(item)).filter((item) => item.type === 'reply');
    if (replies.length !== 1) fail('invalid_params');
    return readMessage(original.scope, nativeId(object(replies[0]!.data).id, true), invocation, true);
  });
  for (const kind of ['group', 'private'] as const) {
    const key = kind === 'group' ? 'group_id' : 'user_id';
    read(kind === 'group' ? 'get_group_history' : 'get_private_history', 'Read bounded QQ history as a result only, never append or trigger old events.', schema({ [key]: idSchema, count: { type: 'integer', minimum: 1, maximum: 50 } }, [key]), async (params, invocation) => {
      const scope = target({ type: kind, id: params[key] }, invocation);
      const raw = object(await data(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', { [key]: Number(scope.id), count: Number(params.count ?? 20) }, invocation));
      const messages = array(raw.messages);
      const items = messages.slice(0, Number(params.count ?? 20)).map((item) => normalizeMessage(item, scope, undefined, true));
      let truncated = messages.length > items.length;
      while (items.length && Buffer.byteLength(JSON.stringify({ items })) > limits.valueBytes - 256) { items.pop(); truncated = true; }
      return { items, has_more: false, truncated, ...(truncated ? { truncation_reason: 'byte_or_count_limit' } : {}) };
    });
  }
  read('get_forward_message', 'Expand a forward from its trusted parent event, at most 3 levels and 50 total nodes; truncated explicitly marks incomplete content.', schema({ input_event_ref: refSchema, segment_index: { type: 'integer', minimum: 0, maximum: 127 } }), async (params, invocation) => {
    const original = await trusted(params.input_event_ref, invocation);
    const rootId = string(segment(original.body, params.segment_index, 'forward').id, 256, 'invalid_params');
    let count = 0, bytes = 256, queries = 0, reason: string | undefined;
    const visited = new Set<string>();
    const expand = async (id: string, depth: number): Promise<JsonObject[]> => {
      if (depth > 3) { reason ??= 'depth_limit'; return []; }
      if (count >= 50 || queries >= 50) { reason ??= 'node_limit'; return []; }
      if (visited.has(id)) { reason ??= 'depth_limit'; return []; }
      visited.add(id); queries += 1;
      const raw = object(await data('get_forward_msg', { id }, invocation));
      const nodes: JsonObject[] = [];
      for (const input of array(raw.messages)) {
        if (count >= 50) { reason ??= 'node_limit'; break; }
        const item = object(input), sender = object(item.sender);
        const segments = messageSegments(item.message ?? item.content);
        const node: JsonObject = { sender_id: nativeId(sender.user_id), nickname: optionalText(sender.nickname), time: optionalCount(item.time), segments };
        const size = Buffer.byteLength(JSON.stringify(node)) + 64;
        if (bytes + size > limits.valueBytes - 256) { reason ??= 'byte_limit'; break; }
        bytes += size; count += 1;
        const children: JsonObject[] = [];
        for (const item of segments) if (item.type === 'forward') children.push(...await expand(string(object(item.data).id, 256), depth + 1));
        if (children.length) node.nodes = children;
        nodes.push(node);
      }
      visited.delete(id); return nodes;
    };
    const nodes = await expand(rootId, 1);
    return { nodes, has_more: false, truncated: reason !== undefined, ...(reason === undefined ? {} : { truncation_reason: reason }) };
  });

  const imageSchema = { oneOf: [
    schema({ url: { type: 'string', minLength: 1, maxLength: 2048 } }),
    schema({ input_event_ref: refSchema, segment_index: { type: 'integer', minimum: 0, maximum: 127 } }),
  ] };
  const segmentSchema = { oneOf: [
    schema({ type: { const: 'text' }, data: schema({ text: { type: 'string', minLength: 1, maxLength: 2000 } }) }),
    schema({ type: { const: 'at' }, data: schema({ qq: { type: 'string', minLength: 1, maxLength: 20 } }) }),
    schema({ type: { const: 'reply' }, data: schema({ message_id: idSchema, input_event_ref: refSchema }, ['message_id']) }),
    schema({ type: { const: 'image' }, data: imageSchema }),
  ] };
  write('send_message', 'Send text, mentions, a proven reply, or trusted images to an authorized QQ target. Preserve call_id after unknown.', schema({ target: targetSchema, segments: { type: 'array', items: segmentSchema, minItems: 1, maxItems: 32 } }), async (params, invocation) => {
    const scope = target(params.target, invocation), outgoing: JsonObject[] = [];
    for (const input of array(params.segments)) {
      const item = object(input), body = object(item.data);
      if (item.type === 'text') outgoing.push({ type: 'text', data: { text: string(body.text, 8000, 'invalid_params') } });
      if (item.type === 'at') {
        if (scope.type !== 'group') fail('invalid_params');
        if (body.qq === 'all') await administrator(scope, invocation);
        else await member(scope, nativeId(body.qq), invocation);
        outgoing.push({ type: 'at', data: { qq: body.qq as string } });
      }
      if (item.type === 'reply') {
        const id = nativeId(body.message_id, true);
        if (body.input_event_ref === undefined) { if (!sent.proves(id, source(scope))) fail('invalid_params'); }
        else {
          const original = await trusted(body.input_event_ref, invocation);
          if (source(original.scope) !== source(scope) || nativeId(original.body.native_message_id, true) !== id) fail('invalid_params');
        }
        outgoing.push({ type: 'reply', data: { id } });
      }
      if (item.type === 'image') {
        let file: string;
        if (body.url !== undefined) {
          if (body.input_event_ref !== undefined || body.segment_index !== undefined) fail('invalid_params');
          file = string(body.url, 2048, 'invalid_params');
          if (!file.toLowerCase().startsWith('http://') && !file.toLowerCase().startsWith('https://')) fail('invalid_params');
        } else {
          const original = await trusted(body.input_event_ref, invocation);
          const media = segment(original.body, body.segment_index, 'image');
          file = string(media.url ?? media.file, 2048, 'invalid_params');
          if (!file.toLowerCase().startsWith('https://') && !file.toLowerCase().startsWith('http://') && !/^[A-Za-z0-9_.-]{1,256}$/.test(file)) fail('invalid_params');
        }
        if (file.toLowerCase().startsWith('https://') || file.toLowerCase().startsWith('http://')) {
          let url: URL; try { url = new URL(file); } catch { return fail('invalid_params'); }
          if (url.username || url.password) fail('invalid_params');
          file = string(url.href, 2048, 'invalid_params');
        }
        outgoing.push({ type: 'image', data: { file } });
      }
    }
    json(outgoing);
    return { action: scope.type === 'group' ? 'send_group_msg' : 'send_private_msg', params: { [scope.type === 'group' ? 'group_id' : 'user_id']: Number(scope.id), message: outgoing }, scope, sends: true };
  });
  write('revoke_message', 'Revoke a recent confirmed message in the same authorized conversation after current ownership checks. Unavailable with SnowLuma until atomic ownership checking is supported; proof is lost after restart or 1000 sends.', schema({ target: targetSchema, message_id: idSchema }), async (params, invocation) => {
    const scope = target(params.target, invocation), id = nativeId(params.message_id, true);
    if (!sent.proves(id, source(scope))) fail('invalid_params');
    const raw = object(await data('get_msg', { message_id: Number(id) }, invocation));
    normalizeMessage(raw, scope, id);
    if (nativeId(object(raw.sender).user_id) !== config.accountId ||
        (scope.type === 'group' ? raw.group_id === undefined : raw.target_id === undefined) || !sent.proves(id, source(scope))) fail('forbidden');
    return { action: 'delete_msg', params: { message_id: Number(id) }, scope };
  }, revokeAvailable);
  for (const name of ['set_member_mute', 'kick_member', 'set_member_card', 'set_group_name'] as const) {
    const properties: Record<string, object> = { group_id: idSchema };
    if (name !== 'set_group_name') properties.user_id = idSchema;
    if (name === 'set_member_mute') properties.duration_seconds = { type: 'integer', minimum: 0, maximum: 2592000 };
    if (name === 'kick_member') properties.reject_add_request = { type: 'boolean' };
    if (name === 'set_member_card') properties.card = { type: 'string', maxLength: 60 };
    if (name === 'set_group_name') properties.name = { type: 'string', minLength: 1, maxLength: 30 };
    write(name, 'Perform one authorized QQ group operation with explicit parameters and platform role checks.', schema(properties, Object.keys(properties).filter((key) => key !== 'reject_add_request')), async (params, invocation) => {
      const scope = group(params, invocation), user = name === 'set_group_name' ? undefined : nativeId(params.user_id);
      if (name !== 'set_member_card' || user !== config.accountId) await administrator(scope, invocation);
      if (user !== undefined) {
        const actual = await member(scope, user, invocation);
        if ((name === 'set_member_mute' || name === 'kick_member') && (user === config.accountId || actual.role !== 'member')) fail('forbidden');
      }
      const outgoing: JsonObject = { group_id: Number(scope.id), ...(user === undefined ? {} : { user_id: Number(user) }) };
      if (name === 'set_member_mute') outgoing.duration = Number(params.duration_seconds);
      if (name === 'kick_member') outgoing.reject_add_request = params.reject_add_request === true;
      if (name === 'set_member_card') outgoing.card = string(params.card, 60, 'invalid_params', true);
      if (name === 'set_group_name') outgoing.group_name = string(params.name, 120, 'invalid_params');
      return { action: { set_member_mute: 'set_group_ban', kick_member: 'set_group_kick', set_member_card: 'set_group_card', set_group_name: 'set_group_name' }[name], params: outgoing, scope };
    });
  }
  for (const kind of ['friend', 'group'] as const) {
    write('handle_' + kind + '_request', 'Approve or reject a trusted QQ request explicitly; never guess flags or broaden permissions.', schema({ input_event_ref: refSchema, approve: { type: 'boolean' }, ...(kind === 'group' ? { reason: { type: 'string', maxLength: 256 } } : {}) }, ['input_event_ref', 'approve']), async (params, invocation) => {
      const original = await trusted(params.input_event_ref, invocation, 'request');
      if (original.body.request_type !== kind) fail('invalid_params');
      if (kind === 'group' && original.body.sub_type === 'add') await administrator(original.scope, invocation);
      const outgoing: JsonObject = { flag: string(original.body.flag, 2048, 'invalid_params'), approve: params.approve as boolean };
      if (kind === 'group') {
        outgoing.sub_type = String(original.body.sub_type);
        if (params.reason !== undefined) outgoing.reason = string(params.reason, 1024, 'invalid_params', true);
      } else if (params.reason !== undefined) fail('invalid_params');
      return { action: kind === 'group' ? 'set_group_add_request' : 'set_friend_add_request', params: outgoing, scope: original.scope };
    });
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); sent.clear(); };
}

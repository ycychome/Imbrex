import { fail } from '../../core/errors.js';
import { fields, json, limits, namespacePattern, object, string } from '../../core/validation.js';
import type { EventInput, EventRecord, JsonObject } from '../../core/types.js';

export interface OneBotConfig {
  wsUrl: string; tokenEnv?: string; accountId: string; identityNamespace: string;
  privateIds: string[]; groupIds: string[];
}

export function nativeId(value: unknown, message = false): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('invalid_event', 'Inexact native ID');
  const text = typeof value === 'number' ? String(value) : string(value, 20, 'invalid_event');
  if (!(message ? /^(0|-?[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(text)) fail('invalid_event', 'Invalid native ID');
  const integer = BigInt(text);
  if (message ? integer < -2147483648n || integer > 2147483647n : integer > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_event', 'Unsupported native ID range');
  return text;
}

export function parseOneBotConfig(input: unknown): OneBotConfig {
  const value = object(input);
  const required = ['transport', 'ws_url', 'account_id', 'identity_namespace', 'compatibility_profile', 'allow_private_ids', 'allow_group_ids'];
  fields(value, [...required, 'access_token_env'], required);
  if (value.transport !== 'ws-forward' || value.compatibility_profile !== 'generic') fail('invalid_request', 'Unsupported OneBot transport or profile');
  const wsUrl = string(value.ws_url, 4096);
  let url: URL;
  try { url = new URL(wsUrl); } catch { return fail('invalid_request', 'Invalid OneBot URL'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('invalid_request', 'Use a WebSocket URL without embedded credentials');
  const identityNamespace = string(value.identity_namespace, 64);
  if (!namespacePattern.test(identityNamespace)) fail('invalid_request');
  const ids = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.length > 1024 || input.some((id) => typeof id !== 'string')) fail('invalid_request');
    const result = input.map((id) => nativeId(id));
    if (new Set(result).size !== result.length) fail('invalid_request');
    return result;
  };
  if (typeof value.account_id !== 'string') fail('invalid_request');
  const tokenEnv = value.access_token_env === undefined ? undefined : string(value.access_token_env, 256);
  if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) fail('invalid_request');
  return { wsUrl, tokenEnv, accountId: nativeId(value.account_id), identityNamespace, privateIds: ids(value.allow_private_ids), groupIds: ids(value.allow_group_ids) };
}

export function normalizeSegments(value: unknown): JsonObject[] {
  const decode = (text: string) => text.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&');
  if (typeof value === 'string') {
    string(value, limits.valueBytes, 'invalid_event', true);
    const result: JsonObject[] = [];
    let offset = 0;
    for (const match of value.matchAll(/\[CQ:([^\]]*)\]/g)) {
      const prefix = value.slice(offset, match.index);
      if (prefix.includes('[CQ:')) fail('invalid_event', 'Malformed CQ segment');
      if (prefix) result.push({ type: 'text', data: { text: decode(prefix) } });
      const raw = match[1]!.replaceAll('&#44;', '\u0000');
      const [type, ...entries] = raw.split(',');
      const params = new Map<string, string>();
      for (const entry of entries) {
        const at = entry.indexOf('=');
        if (at < 1) fail('invalid_event', 'Malformed CQ parameters');
        const key = entry.slice(0, at);
        if (params.has(key)) fail('invalid_event', 'Duplicate CQ parameter');
        params.set(key, entry.slice(at + 1).replaceAll('\u0000', ',').replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&'));
      }
      if (type === 'reply' && params.size === 1 && params.has('id')) result.push({ type: 'reply', data: { id: nativeId(params.get('id'), true) } });
      else if (type === 'at' && params.size === 1 && params.has('qq')) {
        const qq = params.get('qq')!;
        result.push({ type: 'at', data: { qq: qq === 'all' ? 'all' : nativeId(qq) } });
      } else if (type === 'face' && params.size === 1 && params.has('id')) {
        const id = params.get('id')!;
        if (!/^(0|[1-9][0-9]*)$/.test(id) || Number(id) > Number.MAX_SAFE_INTEGER) fail('invalid_event', 'Invalid face ID');
        result.push({ type: 'face', data: { id } });
      } else if (type === 'image' && [...params.keys()].every((key) => key === 'file' || key === 'url') && params.has('file')) {
        const file = string(params.get('file'), 4096, 'invalid_event', true);
        const url = params.get('url');
        result.push({ type: 'image', data: { file, ...(url === undefined ? {} : { url: string(url, 4096, 'invalid_event', true) }) } });
      } else fail('invalid_event', 'Unsupported message segment');
      offset = match.index + match[0].length;
    }
    const suffix = value.slice(offset);
    if (suffix.includes('[CQ:')) fail('invalid_event', 'Malformed CQ segment');
    if (suffix) result.push({ type: 'text', data: { text: decode(suffix) } });
    return normalizeSegments(result);
  }
  if (!Array.isArray(value) || value.length > 128) fail('invalid_event', 'Unsupported message segments');
  return value.map((entry): JsonObject => {
    const segment = object(entry, 'invalid_event');
    const data = object(segment.data, 'invalid_event');
    if (segment.type === 'text') return { type: 'text', data: { text: string(data.text, limits.valueBytes, 'invalid_event', true) } };
    if (segment.type === 'reply') return { type: 'reply', data: { id: nativeId(data.id, true) } };
    if (segment.type === 'at') {
      if (data.qq === 'all') return { type: 'at', data: { qq: 'all' } };
      return { type: 'at', data: { qq: nativeId(data.qq) } };
    }
    if (segment.type === 'image') {
      const file = string(data.file, 4096, 'invalid_event', true);
      const url = data.url === undefined ? undefined : string(data.url, 4096, 'invalid_event', true);
      return { type: 'image', data: { file, ...(url === undefined ? {} : { url }) } };
    }
    if (segment.type === 'face') {
      const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id >= 0 ? String(data.id) : string(data.id, 16, 'invalid_event');
      if (!/^(0|[1-9][0-9]*)$/.test(id) || Number(id) > Number.MAX_SAFE_INTEGER) fail('invalid_event', 'Invalid face ID');
      return { type: 'face', data: { id } };
    }
    return fail('invalid_event', 'Unsupported message segment');
  });
}

export function sourceFor(config: OneBotConfig, kind: string, conversation: string): string {
  return 'imbrex://qq/' + [config.accountId, config.identityNamespace, kind, conversation].map(encodeURIComponent).join('/');
}

export function mapMessage(input: unknown, config: OneBotConfig): EventInput | undefined {
  const value = object(input, 'invalid_event');
  if (value.post_type !== 'message') return;
  if (nativeId(value.self_id) !== config.accountId) fail('invalid_event', 'OneBot account mismatch');
  const kind = value.message_type;
  if (kind !== 'group' && kind !== 'private') return;
  if (kind === 'group' && value.sub_type !== 'normal') return;
  const sender = nativeId(value.user_id);
  const conversation = kind === 'group' ? nativeId(value.group_id) : sender;
  if (!(kind === 'group' ? config.groupIds : config.privateIds).includes(conversation)) return;
  const messageId = nativeId(value.message_id, true);
  const messageSegments = normalizeSegments(value.message);
  const text = messageSegments.filter((segment) => segment.type === 'text').map((segment) => object(segment.data).text).join('');
  let time: string | undefined;
  if (value.time !== undefined) {
    if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0 || value.time > 253402300799) fail('invalid_event', 'Invalid source timestamp');
    time = new Date(value.time * 1000).toISOString();
  }
  const data: JsonObject = {
    account_id: config.accountId, identity_namespace: config.identityNamespace, conversation_type: kind,
    conversation_id: conversation, sender_id: sender, native_message_id: messageId,
    direction: sender === config.accountId ? 'outbound' : 'inbound', text, message_segments: messageSegments,
  };
  let senderSnapshot: Record<string, unknown> | undefined;
  try {
    const snapshot = value.sender === undefined ? undefined : object(value.sender, 'invalid_event');
    if (snapshot && (snapshot.user_id === undefined || nativeId(snapshot.user_id) === sender)) senderSnapshot = snapshot;
  } catch { /* Optional aliases never invalidate the original message identity or text. */ }
  if (senderSnapshot && typeof senderSnapshot.nickname === 'string') data.sender_nickname = string(senderSnapshot.nickname, 256, 'invalid_event', true);
  if (senderSnapshot && typeof senderSnapshot.card === 'string') data.sender_card = string(senderSnapshot.card, 256, 'invalid_event', true);
  json(data, limits.valueBytes, 'invalid_event');
  return { event: {
    specversion: '1.0', datacontenttype: 'application/json', source: sourceFor(config, kind, conversation),
    id: 'message:' + messageId, type: 'qq.message.' + kind, data, ...(time === undefined ? {} : { time }),
  }, parents: [] };
}

export function replyAction(record: EventRecord, text: string, config: OneBotConfig): { action: string; params: JsonObject } {
  const event = record.event;
  const data = object(event.data, 'invalid_params');
  const kind = data.conversation_type;
  if (kind !== 'group' && kind !== 'private') fail('invalid_params');
  const conversation = nativeId(data.conversation_id);
  const messageId = nativeId(data.native_message_id, true);
  if (record.parents.length || event.type !== 'qq.message.' + kind || event.source !== sourceFor(config, kind, conversation) ||
      event.id !== 'message:' + messageId || data.account_id !== config.accountId || data.identity_namespace !== config.identityNamespace ||
      data.direction !== 'inbound' || nativeId(data.sender_id) === config.accountId || (kind === 'private' && data.sender_id !== conversation) ||
      !(kind === 'group' ? config.groupIds : config.privateIds).includes(conversation)) fail('invalid_params', 'Untrusted reply reference');
  return { action: kind === 'group' ? 'send_group_msg' : 'send_private_msg', params: {
    [kind === 'group' ? 'group_id' : 'user_id']: Number(conversation),
    message: [{ type: 'reply', data: { id: messageId } }, { type: 'text', data: { text } }],
  } };
}

export const replySchema = {
  type: 'object', properties: {
    input_event_ref: { type: 'object', properties: { source: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } }, required: ['source', 'id'], additionalProperties: false },
    text: { type: 'string', minLength: 1, maxLength: 2000 },
  }, required: ['input_event_ref', 'text'], additionalProperties: false,
};

export const resolveImageSchema = {
  type: 'object', properties: {
    input_event_ref: { type: 'object', properties: { source: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } }, required: ['source', 'id'], additionalProperties: false },
    segment_index: { type: 'integer', minimum: 0, maximum: 127 },
  }, required: ['input_event_ref', 'segment_index'], additionalProperties: false,
};

export function imageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) fail('invalid_params', 'Image URL is unavailable');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('invalid_params', 'Image URL is unavailable'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) fail('invalid_params', 'Image URL is unavailable');
  return parsed.toString();
}

export function imageFile(value: unknown): string {
  const file = string(value, 4096, 'invalid_params', true);
  if (!file || file.startsWith('/') || file.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(file) || /^file:/i.test(file) || file.split(/[\\/]/).includes('..')) {
    fail('invalid_params', 'Image file reference is unavailable');
  }
  return file;
}

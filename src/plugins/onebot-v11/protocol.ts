import { createHash } from 'node:crypto';
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

export function messageSegments(value: unknown): JsonObject[] {
  const decode = (text: string) => text.replaceAll('&#44;', ',').replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&');
  if (typeof value === 'string') {
    string(value, limits.valueBytes, 'invalid_event', true);
    const result: JsonObject[] = [];
    let offset = 0;
    for (const match of value.matchAll(/\[CQ:([^\]]*)\]/g)) {
      const prefix = value.slice(offset, match.index);
      if (prefix.includes('[CQ:')) fail('invalid_event', 'Malformed CQ segment');
      if (prefix) result.push({ type: 'text', data: { text: decode(prefix) } });
      const [type, ...pairs] = match[1]!.split(',');
      const data: JsonObject = {};
      for (const pair of pairs) {
        const equal = pair.indexOf('=');
        if (equal < 1 || Object.hasOwn(data, pair.slice(0, equal))) fail('invalid_event');
        data[pair.slice(0, equal)] = decode(pair.slice(equal + 1));
      }
      result.push({ type: type!, data });
      offset = match.index + match[0].length;
    }
    const suffix = value.slice(offset);
    if (suffix.includes('[CQ:')) fail('invalid_event', 'Malformed CQ segment');
    if (suffix) result.push({ type: 'text', data: { text: decode(suffix) } });
    return messageSegments(result);
  }
  if (!Array.isArray(value) || value.length > 128) fail('invalid_event', 'Unsupported message segments');
  return value.map((entry): JsonObject => {
    const segment = object(entry, 'invalid_event');
    const type = string(segment.type, 64, 'invalid_event');
    const data = segment.data === undefined ? {} : object(segment.data, 'invalid_event');
    if (segment.type === 'text') return { type: 'text', data: { text: string(data.text, limits.valueBytes, 'invalid_event', true) } };
    if (segment.type === 'reply') return { type: 'reply', data: { id: nativeId(data.id, true) } };
    if (type === 'at') return { type, data: { qq: data.qq === 'all' ? 'all' : nativeId(data.qq) } };
    if (type === 'forward') return { type, data: { id: string(data.id, 256, 'invalid_event') } };
    if (type === 'image') {
      const media: JsonObject = {};
      if (typeof data.file === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(data.file)) media.file = data.file;
      if (data.url !== undefined) {
        const url = string(data.url, 2048, 'invalid_event');
        if (url.toLowerCase().startsWith('https://') || url.toLowerCase().startsWith('http://')) media.url = url;
      }
      if (data.summary !== undefined) media.summary = string(data.summary, 256, 'invalid_event', true);
      return { type, data: media };
    }
    if (type === 'face' && (typeof data.id === 'string' || typeof data.id === 'number')) return { type, data: { id: string(String(data.id), 16, 'invalid_event') } };
    return { type: 'unsupported', data: { type } };
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
  if (kind === 'private' && sender === config.accountId && value.target_id === undefined) return;
  const conversation = kind === 'group' ? nativeId(value.group_id) : sender === config.accountId ? nativeId(value.target_id) : sender;
  if (!(kind === 'group' ? config.groupIds : config.privateIds).includes(conversation)) return;
  const messageId = nativeId(value.message_id, true);
  const normalized = messageSegments(value.message);
  const text = normalized.filter((segment) => segment.type === 'text').map((segment) => object(segment.data).text).join('');
  let time: string | undefined;
  if (value.time !== undefined) {
    if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0 || value.time > 253402300799) fail('invalid_event', 'Invalid source timestamp');
    time = new Date(value.time * 1000).toISOString();
  }
  const data: JsonObject = {
    account_id: config.accountId, identity_namespace: config.identityNamespace, conversation_type: kind,
    conversation_id: conversation, sender_id: sender, native_message_id: messageId,
    direction: sender === config.accountId ? 'outbound' : 'inbound', text, message_segments: normalized,
  };
  json(data, limits.valueBytes, 'invalid_event');
  return { event: {
    specversion: '1.0', datacontenttype: 'application/json', source: sourceFor(config, kind, conversation),
    id: 'message:' + messageId, type: 'qq.message.' + kind, data, ...(time === undefined ? {} : { time }),
  }, parents: [] };
}

export function requestId(config: OneBotConfig, kind: string, conversation: string, user: string, subtype: string, flag: string): string {
  const digest = createHash('sha256').update(JSON.stringify([config.accountId, config.identityNamespace, kind, conversation, user, subtype, flag])).digest('hex');
  return 'request:' + kind + ':' + conversation + ':' + digest;
}

export function mapRequest(input: unknown, config: OneBotConfig): EventInput | undefined {
  const value = object(input, 'invalid_event');
  if (value.post_type !== 'request') return;
  if (nativeId(value.self_id) !== config.accountId) fail('invalid_event');
  const kind = value.request_type;
  if (kind !== 'friend' && kind !== 'group') return;
  const user = nativeId(value.user_id);
  const conversation = kind === 'group' ? nativeId(value.group_id) : user;
  const subtype = kind === 'group' ? string(value.sub_type, 16, 'invalid_event') : 'friend';
  if (kind === 'group' && !['add', 'invite'].includes(subtype)) fail('invalid_event');
  if (!(kind === 'group' ? config.groupIds : config.privateIds).includes(conversation)) return;
  const flag = string(value.flag, 2048, 'invalid_event');
  const data: JsonObject = {
    account_id: config.accountId, identity_namespace: config.identityNamespace,
    request_type: kind, sub_type: subtype, user_id: user, conversation_id: conversation,
    flag, comment: value.comment === undefined ? '' : string(value.comment, 4096, 'invalid_event', true),
    ...(kind === 'group' ? { group_id: conversation } : {}),
  };
  let time: string | undefined;
  if (value.time !== undefined) {
    if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0 || value.time > 253402300799) fail('invalid_event');
    time = new Date(value.time * 1000).toISOString();
  }
  return { event: { specversion: '1.0', datacontenttype: 'application/json',
    source: sourceFor(config, kind === 'group' ? 'group' : 'private', conversation),
    id: requestId(config, kind, conversation, user, subtype, flag), type: 'qq.request.' + kind,
    data, ...(time === undefined ? {} : { time }),
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

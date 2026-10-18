import { fail, type ErrorCode } from './errors.js';
import type { CloudEvent, EventInput, EventRef, JsonValue, ReadOptions } from './types.js';

export const limits = Object.freeze({
  httpBytes: 256 * 1024, valueBytes: 64 * 1024, schemaBytes: 16 * 1024,
  depth: 32, parents: 16, page: 100, capabilities: 128, queue: 32, handlers: 8, callTimeoutMs: 15_000,
});
export const maxSeq = 9223372036854775807n;
export const namespacePattern = /^[a-z][a-z0-9_-]{0,63}$/;
export const capabilityPattern = /^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_]{0,63}$/;
export const callIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function object(value: unknown, code: ErrorCode = 'invalid_request'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], code: ErrorCode = 'invalid_request'): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) fail(code);
}

export function string(value: unknown, maxBytes: number, code: ErrorCode = 'invalid_request', allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.length)) fail(code);
  if (Buffer.byteLength(value) > maxBytes) fail('payload_too_large');
  return value;
}

export function uri(value: unknown, code: ErrorCode = 'invalid_event'): string {
  const text = string(value, 1024, code);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) || /[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/.test(text) || /%(?![a-fA-F0-9]{2})/.test(text)) fail(code);
  const parts = /^(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([^#]*))?$/.exec(text.slice(text.indexOf(':') + 1));
  if (!parts || parts.slice(2).some((part) => part !== undefined && /[\[\]]/.test(part)) || (parts[1]?.split('@').length ?? 0) > 2) fail(code);
  try { new URL(text); } catch { fail(code); }
  return text;
}

// Validate before serializing: JSON.stringify alone drops undefined and converts non-finite numbers.
export function json(value: unknown, maxBytes = limits.valueBytes, code: ErrorCode = 'invalid_params'): JsonValue {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > limits.depth) fail('payload_too_large');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object') fail(code);
    if (ancestors.has(item)) fail(code);
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail(code);
      for (let index = 0; index < item.length; index += 1) visit(item[index], depth + 1);
    } else {
      object(item, code);
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail('payload_too_large');
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function position(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) fail('invalid_position');
  const seq = BigInt(value);
  if (seq > maxSeq) fail('invalid_position');
  return seq;
}

export function readOptions(value: { afterSeq: unknown; limit?: unknown; sourcePrefix?: unknown; type?: unknown }): ReadOptions {
  if (typeof value.afterSeq !== 'bigint' || value.afterSeq < 0n || value.afterSeq > maxSeq) fail('invalid_position');
  const count = value.limit === undefined ? 50 : value.limit;
  if (!Number.isInteger(count) || typeof count !== 'number' || count < 1 || count > limits.page) fail('invalid_request');
  return {
    afterSeq: value.afterSeq, limit: count,
    ...(value.sourcePrefix === undefined ? {} : { sourcePrefix: string(value.sourcePrefix, 1024) }),
    ...(value.type === undefined ? {} : { type: string(value.type, 256) }),
  };
}

export function eventRef(value: unknown): EventRef {
  const item = object(value, 'invalid_event');
  fields(item, ['source', 'id'], ['source', 'id'], 'invalid_event');
  return { source: uri(item.source), id: string(item.id, 256, 'invalid_event') };
}

function timestamp(value: unknown): string {
  const text = string(value, 256, 'invalid_event');
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) fail('invalid_event');
  const [, year, month, day, hour, minute, second, offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > (days[m - 1] ?? 0) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) fail('invalid_event');
  if (offset?.length === 6 && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) fail('invalid_event');
  if (Number(second) === 60) {
    // RFC 3339 leap seconds occur at the end of a UTC month, shifted by the supplied offset.
    const preceding = new Date(text.toUpperCase().replace(/:60(?=[.Z+-])/, ':59'));
    const following = new Date(preceding.getTime() + 1000);
    if (preceding.getUTCHours() !== 23 || preceding.getUTCMinutes() !== 59 || following.getUTCDate() !== 1) fail('invalid_event');
  }
  return text;
}

export function eventInput(value: unknown): EventInput {
  const envelope = object(value, 'invalid_event');
  fields(envelope, ['event', 'parents'], ['event'], 'invalid_event');
  const item = object(envelope.event, 'invalid_event');
  fields(item, ['specversion', 'source', 'id', 'type', 'datacontenttype', 'data', 'time', 'subject', 'dataschema'],
    ['specversion', 'source', 'id', 'type', 'datacontenttype', 'data'], 'invalid_event');
  if (item.specversion !== '1.0' || item.datacontenttype !== 'application/json') fail('invalid_event');
  const event: CloudEvent = {
    specversion: '1.0', datacontenttype: 'application/json', source: uri(item.source),
    id: string(item.id, 256, 'invalid_event'), type: string(item.type, 256, 'invalid_event'), data: json(item.data, limits.valueBytes, 'invalid_event'),
    ...(item.time === undefined ? {} : { time: timestamp(item.time) }),
    ...(item.subject === undefined ? {} : { subject: string(item.subject, 256, 'invalid_event', true) }),
    ...(item.dataschema === undefined ? {} : { dataschema: uri(item.dataschema) }),
  };
  const parents = envelope.parents === undefined ? [] : envelope.parents;
  if (!Array.isArray(parents)) fail('invalid_event');
  if (parents.length > limits.parents) fail('payload_too_large');
  const refs = parents.map(eventRef);
  if (new Set(refs.map((ref) => JSON.stringify([ref.source, ref.id]))).size !== refs.length) fail('invalid_event');
  const input = { event, parents: refs };
  json(input, limits.valueBytes, 'invalid_event');
  return input;
}

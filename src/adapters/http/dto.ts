import { fields, object, string, position, readOptions, eventInput, eventRef, json, callIdPattern } from '../../core/validation.js';
import { fail } from '../../core/errors.js';
import type { AppendResult, EventPage, EventRecord } from '../../core/types.js';

function query(params: URLSearchParams, allowed: string[], required: string[]): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) fail('invalid_request');
    values[key] = value;
  }
  fields(values, allowed, required);
  return values;
}

export function storeQuery(params: URLSearchParams): string {
  return string(query(params, ['store_id'], ['store_id']).store_id, 256);
}

export function readQuery(params: URLSearchParams) {
  const value = query(params, ['store_id', 'after_seq', 'limit', 'source_prefix', 'type'], ['store_id', 'after_seq']);
  if (value.limit !== undefined && !/^[1-9][0-9]*$/.test(value.limit)) fail('invalid_request');
  return {
    storeId: string(value.store_id, 256),
    options: readOptions({ afterSeq: position(value.after_seq), limit: value.limit === undefined ? undefined : Number(value.limit), sourcePrefix: value.source_prefix, type: value.type }),
  };
}

export function lookupQuery(params: URLSearchParams) {
  const value = query(params, ['store_id', 'source', 'id'], ['store_id', 'source', 'id']);
  return { storeId: string(value.store_id, 256), ref: eventRef({ source: value.source, id: value.id }) };
}

export function appendBody(input: unknown) {
  const value = object(input);
  fields(value, ['store_id', 'event', 'parents'], ['store_id', 'event']);
  return { storeId: string(value.store_id, 256), input: eventInput({ event: value.event, ...(value.parents === undefined ? {} : { parents: value.parents }) }) };
}

export function invokeBody(input: unknown) {
  const value = object(input);
  fields(value, ['store_id', 'params', 'call_id'], ['store_id', 'params']);
  const callId = value.call_id === undefined ? undefined : string(value.call_id, 128);
  if (callId !== undefined && !callIdPattern.test(callId)) fail('invalid_request');
  return { storeId: string(value.store_id, 256), params: json(value.params), callId };
}

export function wireRecord(record: EventRecord) {
  return { seq: record.seq.toString(), accepted_at: record.acceptedAt, event: record.event, parents: record.parents };
}
export function wirePage(page: EventPage) {
  return { store_id: page.storeId, records: page.records.map(wireRecord), through_seq: page.throughSeq.toString(), next_after_seq: page.nextAfterSeq.toString(), caught_up: page.caughtUp };
}
export function wireAppend(result: AppendResult) {
  return { status: result.status, store_id: result.storeId, seq: result.seq.toString(), accepted_at: result.acceptedAt, event_ref: result.eventRef };
}

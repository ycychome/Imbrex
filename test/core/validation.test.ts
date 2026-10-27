import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventInput, json, maxSeq, position } from '../../src/core/validation.js';
import { compileSchema } from '../../src/core/schema.js';
import { appendBody, readQuery, wireRecord } from '../../src/core/wire.js';

const event = { specversion: '1.0', source: 'imbrex://fixture/messages', id: 'message-1', type: 'fixture.message.created', datacontenttype: 'application/json', data: { text: 'hello' } };

test('HTTP positions reject rounding and noncanonical forms and preserve 64-bit output', () => {
  for (const value of ['9007199254740993', maxSeq.toString()]) assert.equal(position(value).toString(), value);
  for (const value of ['01', '-1', '1.0', '1e3', '', '9223372036854775808', 1]) assert.throws(() => position(value), { code: 'invalid_position' });
  const page = readQuery(new URLSearchParams('store_id=fixture&after_seq=9007199254740993'));
  assert.equal(page.options.afterSeq, 9007199254740993n);
  assert.equal(page.options.limit, 50);
  for (const suffix of ['&after_seq=2', '&limit=0', '&limit=101', '&limit=', '&unknown=x']) {
    assert.throws(() => readQuery(new URLSearchParams('store_id=fixture&after_seq=0' + suffix)));
  }
  const record = wireRecord({ ...eventInput({ event }), seq: maxSeq, acceptedAt: '2026-10-18T00:00:00.000Z' });
  assert.equal(JSON.parse(JSON.stringify(record)).seq, maxSeq.toString());
});

test('event validation bounds input, preserves identity, and snapshots mutable data', () => {
  const source = 'imbrex://Fixture/%6dessages';
  const input = { event: { ...event, source, data: { text: 'before' } } };
  const accepted = eventInput(input);
  input.event.data.text = 'after';
  assert.equal(accepted.event.source, source);
  assert.deepEqual(accepted.event.data, { text: 'before' });
  assert.deepEqual(accepted.parents, []);
  const ref = { source, id: 'parent' };
  for (const parents of [null, [ref, ref], Array.from({ length: 17 }, (_, i) => ({ source, id: String(i) }))]) assert.throws(() => eventInput({ event, parents }));
  for (const patch of [{ seq: '1' }, { source: '/relative' }, { source: 'imbrex://bad/%q' }, { time: '2026-02-30T00:00:00Z' }, { data: { missing: undefined } }]) {
    assert.throws(() => eventInput({ event: { ...event, ...patch } }));
  }
  assert.throws(() => appendBody({ store_id: 'fixture', event, caller_id: 'forged' }));
  assert.throws(() => eventInput({ event: { ...event, id: '汉'.repeat(86) } }), { code: 'payload_too_large' });
});

test('JSON limits reject values that serialization would silently alter', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), cyclic, [undefined], Array(1)]) assert.throws(() => json(value));
  let nested: unknown = null;
  for (let i = 0; i < 34; i += 1) nested = [nested];
  assert.throws(() => json(nested), { code: 'payload_too_large' });
  assert.throws(() => json('x'.repeat(65536)), { code: 'payload_too_large' });
});

test('capability schemas reject unsupported execution/reference features without mutating inputs', () => {
  for (const schema of [{ $ref: 'https://example.invalid/schema' }, { type: 'string', pattern: '.*' }, { type: 'object', properties: { x: { format: 'uri' } } }]) assert.throws(() => compileSchema(schema));
  const { validate } = compileSchema({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false });
  assert.equal(validate({ text: 'hello' }), true);
  const invalid = { text: 7, extra: true };
  assert.equal(validate(invalid), false);
  assert.deepEqual(invalid, { text: 7, extra: true });
});

test('schema compilation supports booleans and cannot satisfy JSON properties through prototypes', () => {
  assert.equal(compileSchema(true).validate(null), true);
  assert.equal(compileSchema(false).validate(null), false);
  const schema = { type: 'object', properties: { constructor: true }, required: ['constructor'] };
  const { validate } = compileSchema(schema);
  assert.equal(validate({}), false);
  assert.equal(validate({ constructor: 'own value' }), true);
  assert.throws(() => compileSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"integer"}}}')), { code: 'invalid_params' });
});

test('event identity rejects illegal URI characters and leap seconds respect UTC position', () => {
  for (const source of ['imbrex://fixture/{message}', 'imbrex://fixture/back\\slash', 'imbrex://fixture/[path]', 'imbrex://fixture/#one#two', 'imbrex://user[name]@fixture/messages', 'imbrex://user:pass[word]@fixture/messages']) {
    assert.throws(() => eventInput({ event: { ...event, source } }), { code: 'invalid_event' });
  }
  const source = 'imbrex://fixture/%7Bmessage%7D';
  assert.equal(eventInput({ event: { ...event, source } }).event.source, source);
  for (const source of ['imbrex://[::1]/messages', 'imbrex://user%5Bname%5D@fixture/messages']) assert.equal(eventInput({ event: { ...event, source } }).event.source, source);
  for (const time of ['2026-10-18T12:34:60Z', '2016-12-31T23:59:60+01:00']) {
    assert.throws(() => eventInput({ event: { ...event, time } }), { code: 'invalid_event' });
  }
  for (const time of ['2016-12-31T23:59:60Z', '2017-01-01T00:59:60+01:00']) {
    assert.equal(eventInput({ event: { ...event, time } }).event.time, time);
  }
});

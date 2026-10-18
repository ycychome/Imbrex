import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Events } from '../../src/core/events.js';
import { eventInput, maxSeq } from '../../src/core/validation.js';
import type { Principal } from '../../src/core/types.js';
import { SqliteStore } from '../../src/storage/store.js';

const principal: Principal = { id: 'fixture', permissions: ['events:read', 'events:write'], readSources: [{ prefix: 'imbrex://' }], writeSources: [{ prefix: 'imbrex://' }], invokeCapabilities: [] };
const input = (id: string, source = 'imbrex://fixture/messages') => ({ event: { specversion: '1.0', datacontenttype: 'application/json', source, id, type: 'fixture.message.created', data: { text: id } } });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-events-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'gateway.db');
  const store = await SqliteStore.open(path);
  t.after(() => store.close());
  const info = await store.info();
  return { store, path, id: info.storeId };
}

test('commit survives throwing/rejecting listeners, and duplicate identity never rewrites or renotifies', async (t) => {
  const { store, id } = await fixture(t);
  let notifications = 0;
  let failures = 0;
  const events = new Events(store, () => { failures += 1; });
  events.onAvailable(() => { throw new Error('fixture'); });
  events.onAvailable(async () => { throw new Error('fixture'); });
  events.onAvailable(() => { notifications += 1; });
  const first = await events.append(principal, id, input('one'));
  assert.equal(first.status, 'created');
  await setImmediate();
  assert.equal(notifications, 1); assert.equal(failures, 2);
  const second = await events.append(principal, id, { event: { ...input('one').event, data: 'replacement' } });
  assert.equal(second.status, 'duplicate_identity');
  assert.equal(second.seq, first.seq); assert.equal(second.acceptedAt, first.acceptedAt);
  assert.deepEqual((await events.lookup(principal, id, first.eventRef)).event.data, { text: 'one' });
  await setImmediate(); assert.equal(notifications, 1);
  const readOnly = { ...principal, permissions: ['events:read'] as Principal['permissions'] };
  await assert.rejects(events.append(readOnly, id, input('two')), { code: 'forbidden' });
  await assert.rejects(events.append({ ...principal, readSources: [] }, id, { ...input('two'), parents: [first.eventRef] }), { code: 'forbidden' });
});

test('filtered pages advance only past returned matches and enforce literal authorized prefixes', async (t) => {
  const { store, id } = await fixture(t);
  const events = new Events(store);
  const receipts = [];
  for (const [key, source] of [['a', 'imbrex://A/%25_'], ['b', 'imbrex://A/other'], ['c', 'imbrex://A/%25_'], ['d', 'imbrex://a/%25_'], ['e', 'imbrex://A/%25_']]) {
    receipts.push(await events.append(principal, id, input(key!, source)));
  }
  const scoped = { ...principal, readSources: [{ prefix: 'imbrex://A/' }] };
  const first = await events.read(scoped, id, { afterSeq: 0n, limit: 2, sourcePrefix: 'imbrex://A/%' });
  assert.deepEqual(first.records.map((record) => record.event.id), ['a', 'c']);
  assert.equal(first.caughtUp, false); assert.equal(first.nextAfterSeq, receipts[2]!.seq);
  const second = await events.read(scoped, id, { afterSeq: first.nextAfterSeq, limit: 2, sourcePrefix: 'imbrex://A/%' });
  assert.deepEqual(second.records.map((record) => record.event.id), ['e']);
  assert.equal(second.caughtUp, true); assert.equal(second.nextAfterSeq, receipts[4]!.seq);
  const empty = await events.read(scoped, id, { afterSeq: 0n, limit: 2, type: 'missing' });
  assert.equal(empty.records.length, 0); assert.equal(empty.nextAfterSeq, receipts[4]!.seq);
  const nulFilter = await events.read(scoped, id, { afterSeq: 0n, limit: 2, sourcePrefix: 'imbrex://A/\0denied' });
  assert.equal(nulFilter.records.length, 0);
  const nulScope = await events.read({ ...principal, readSources: [{ prefix: 'imbrex://A/\0denied' }] }, id, { afterSeq: 0n, limit: 2 });
  assert.equal(nulScope.records.length, 0);
  await assert.rejects(events.read(scoped, 'another-store', { afterSeq: 0n, limit: 2 }), { code: 'store_mismatch' });
  await assert.rejects(events.read(scoped, id, { afterSeq: 1000n, limit: 2 }), { code: 'position_ahead' });
  await assert.rejects(events.lookup(scoped, id, { source: 'imbrex://a/%25_', id: 'd' }), { code: 'forbidden' });
  const snapshot = events.read(scoped, id, { afterSeq: 0n, limit: 100 });
  const append = events.append(principal, id, input('concurrent', 'imbrex://A/new'));
  assert.equal((await snapshot).throughSeq, receipts[4]!.seq);
  const added = await append;
  assert.equal((await events.read(scoped, id, { afterSeq: receipts[4]!.seq, limit: 100 })).records[0]?.seq, added.seq);
});

test('worker persists identity, reads large sequences, and fails writes without false success', async (t) => {
  const { store, path, id } = await fixture(t);
  await store.close();
  const seed = new DatabaseSync(path);
  seed.prepare("INSERT INTO sqlite_sequence (name,seq) VALUES ('events',?)").run(9007199254740992n);
  seed.close();
  const reopened = await SqliteStore.open(path); t.after(() => reopened.close());
  assert.equal((await reopened.info()).storeId, id);
  const receipt = await reopened.append(id, eventInput(input('large')));
  assert.equal(receipt.seq, 9007199254740993n);
  const page = await reopened.read(id, { afterSeq: 0n, limit: 1 }, principal.readSources);
  assert.equal(page.records[0]?.seq, receipt.seq);
  await reopened.close();
  const full = new DatabaseSync(path);
  full.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='events'").run(maxSeq);
  full.close();
  const limited = await SqliteStore.open(path); t.after(() => limited.close());
  await assert.rejects(limited.append(id, eventInput(input('cannot-fit'))), { code: 'storage_unavailable' });
  assert.equal((await limited.info()).latestSeq, receipt.seq);
});

test('bounded worker queue rejects excess work and close drains accepted commands', async (t) => {
  const { store, id } = await fixture(t);
  const requests = Array.from({ length: 33 }, (_, index) => store.append(id, eventInput(input(String(index)))));
  const resultsPromise = Promise.allSettled(requests);
  await store.close();
  const results = await resultsPromise;
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 32);
  const rejected = results[32];
  assert.ok(rejected?.status === 'rejected'); assert.equal(rejected.reason.code, 'busy');
  await assert.rejects(store.info(), { code: 'storage_unavailable' });
});

test('call records recover in-progress as unknown and refuse unsupported schema versions', async (t) => {
  const { store, id, path } = await fixture(t);
  const call = { callerId: 'caller', callId: 'intent', capabilityId: 'mock.write', schemaVersion: '1', params: { text: 'fixture' } };
  const created = await store.createCall(id, call);
  assert.equal(created.created, true);
  assert.equal((await store.createCall(id, call)).created, false);
  assert.equal(await store.getCall(id, 'other', 'intent'), undefined);
  await store.close();
  const reopened = await SqliteStore.open(path); t.after(() => reopened.close());
  assert.equal((await reopened.getCall(id, 'caller', 'intent'))?.status, 'unknown');
  await reopened.finishCall(id, 'caller', 'intent', { status: 'succeeded', result: null });
  assert.equal((await reopened.finishCall(id, 'caller', 'intent', { status: 'unknown', reason: { code: 'late_timeout', message: 'fixture' } })).status, 'succeeded');
  await reopened.close();
  const future = new DatabaseSync(path); future.exec("UPDATE metadata SET value='2' WHERE key='schema_version'"); future.close();
  await assert.rejects(SqliteStore.open(path), { code: 'storage_unavailable' });
});

test('unexpected worker exit rejects queued work and makes failure visible to the host', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let failures = 0;
  const store = await SqliteStore.open(join(dir, 'gateway.db'), () => { failures += 1; });
  t.after(() => store.close());
  // Terminate the real thread to exercise the failure boundary without adding a production fault API.
  const worker: unknown = Reflect.get(store, 'worker');
  assert.ok(worker instanceof Worker);
  const pending = Promise.allSettled([store.info(), store.info()]);
  await worker.terminate();
  await pending;
  assert.equal(failures, 1);
  await assert.rejects(store.info(), { code: 'storage_unavailable' });
});

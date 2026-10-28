import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Capabilities, type CapabilityDefinition, type InvokeResult } from '../../src/core/capabilities.js';
import { Events } from '../../src/core/events.js';
import { GatewayError } from '../../src/core/errors.js';
import type { CallRecord, GatewayStore } from '../../src/core/store.js';
import type { JsonValue, Principal } from '../../src/core/types.js';
import { SqliteStore } from '../../src/storage/store.js';

const principal: Principal = { id: 'caller', permissions: ['capabilities:invoke', 'capabilities:list', 'calls:read', 'events:read'], readSources: [{ exact: 'imbrex://allowed' }], writeSources: [], invokeCapabilities: ['mock.echo', 'mock.write'] };
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const definition = (handler: CapabilityDefinition['handler'], sideEffectful = true): CapabilityDefinition => ({ localName: sideEffectful ? 'write' : 'echo', description: 'fixture', schemaVersion: '1', isSideEffectful: sideEffectful, inputSchema: schema, handler });
function call(result: InvokeResult): CallRecord { assert.equal(result.kind, 'call'); if (result.kind !== 'call') throw new Error('Expected call'); return result.call; }
async function fixture(t: TestContext, timeout = 5000) {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-calls-'));
  const store = await SqliteStore.open(join(dir, 'gateway.db'));
  const events = new Events(store);
  const capabilities = new Capabilities(store, events, true, timeout);
  const controller = new AbortController();
  const owner = { instanceId: 'mock', signal: controller.signal, available: () => true };
  t.after(async () => { capabilities.stop(); controller.abort(); await capabilities.drain(); events.stop(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { capabilities, store, events, id: (await store.info()).storeId, owner, controller };
}

test('concurrent identical intents dispatch once; old results survive unregister and parameter order', async (t) => {
  const { capabilities, id, owner } = await fixture(t);
  const execution = Promise.withResolvers<JsonValue>();
  let sends = 0;
  const unregister = capabilities.register(owner, { ...definition(async () => { sends += 1; return { status: 'succeeded', result: await execution.promise }; }), inputSchema: { type: 'object' } });
  const requests = Array.from({ length: 5 }, () => capabilities.invoke(principal, id, 'mock.write', { a: 1, b: 2 }, 'intent'));
  await setImmediate();
  execution.resolve({ native_id: 'fixture' });
  const results = await Promise.all(requests);
  assert.equal(sends, 1);
  assert.ok(results.some((result) => call(result).status === 'succeeded'));
  unregister();
  const replay = call(await capabilities.invoke(principal, id, 'mock.write', { b: 2, a: 1 }, 'intent'));
  assert.equal(replay.status, 'succeeded'); assert.equal(sends, 1);
  await assert.rejects(capabilities.invoke(principal, id, 'mock.write', { a: 2, b: 2 }, 'intent'), { code: 'call_conflict' });
  assert.equal((await capabilities.getCall(principal, id, 'intent')).status, 'succeeded');
  await assert.rejects(capabilities.getCall({ ...principal, id: 'other' }, id, 'intent'), { code: 'call_not_found' });
});

test('timeout remains unknown without retry, and a correlated late result can become final', async (t) => {
  const { capabilities, id, owner } = await fixture(t, 10);
  const execution = Promise.withResolvers<JsonValue>();
  let sends = 0;
  capabilities.register(owner, definition(async () => { sends += 1; return { status: 'succeeded', result: await execution.promise }; }));
  const timedOut = call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'intent'));
  assert.equal(timedOut.status, 'unknown');
  assert.equal(call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'intent')).status, 'unknown');
  assert.equal(sends, 1);
  execution.resolve('confirmed');
  // Flush the handler continuation and its ordered worker write before reading.
  await setImmediate();
  assert.equal((await capabilities.getCall(principal, id, 'intent')).status, 'succeeded');
});

test('failed, throwing and invalid-result providers cannot be re-executed by repeating a call ID', async (t) => {
  const { capabilities, id, owner } = await fixture(t);
  for (const [index, handler] of [
    () => ({ status: 'failed' as const, reason: { code: 'refused', message: 'fixture' } }),
    () => { throw new Error('secret fixture message'); },
    () => ({ invalid: true }),
  ].entries()) {
    let sends = 0;
    const remove = capabilities.register(owner, definition(() => { sends += 1; return handler(); }));
    const key = String(index);
    const first = call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, key));
    assert.equal(first.status, index === 0 ? 'failed' : 'unknown');
    const second = call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, key));
    assert.deepEqual(first, second); assert.equal(sends, 1);
    assert.ok(!JSON.stringify(first).includes('secret fixture message'));
    remove();
  }
});

test('authorization, registration, input and availability are enforced before dispatch', async (t) => {
  const { capabilities, id, owner, events, store } = await fixture(t);
  let runs = 0;
  const readOnly = definition(() => { runs += 1; return 'result'; }, false);
  capabilities.register(owner, readOnly);
  assert.throws(() => capabilities.register(owner, readOnly));
  assert.equal(capabilities.list(principal).length, 1);
  await assert.rejects(capabilities.invoke({ ...principal, invokeCapabilities: [] }, id, 'mock.echo', { text: 'fixture' }), { code: 'forbidden' });
  await assert.rejects(capabilities.invoke(principal, id, 'mock.echo', { text: 7 }), { code: 'invalid_params' });
  await assert.rejects(capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' }, 'unused'), { code: 'invalid_request' });
  assert.equal((await capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' })).kind, 'result');
  assert.equal(runs, 1);
  const disabled = new Capabilities(store, events, false);
  disabled.register(owner, definition(() => ({ status: 'succeeded', result: null })));
  await assert.rejects(disabled.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'blocked'), { code: 'writes_disabled' });
  const offline = new Capabilities(store, events, true);
  offline.register({ ...owner, available: () => false }, definition(() => ({ status: 'succeeded', result: null })));
  assert.equal(offline.list(principal).length, 0);
  await assert.rejects(offline.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'offline'), { code: 'provider_unavailable' });
});

test('handler event lookup retains actual caller scope rather than provider privileges', async (t) => {
  const { capabilities, id, owner, store } = await fixture(t);
  capabilities.register(owner, definition(async (_params, invocation) => {
    await invocation.readEvent({ source: 'imbrex://secret', id: 'input' });
    return { status: 'succeeded', result: null };
  }));
  const result = call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'scope'));
  assert.equal(result.status, 'unknown');
  assert.equal((await store.getCall(id, principal.id, 'scope'))?.status, 'unknown');
});

test('metadata source checks use actual caller permissions without requiring an event', async (t) => {
  const { capabilities, id, owner } = await fixture(t);
  let reads = 0;
  capabilities.register(owner, {
    ...definition((_params, invocation) => {
      invocation.requireReadSource('imbrex://allowed');
      reads += 1;
      return { metadata: true };
    }, false),
  });
  const result = await capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' });
  assert.equal(result.kind, 'result');
  assert.equal(reads, 1);
  await assert.rejects(capabilities.invoke({ ...principal, readSources: [{ exact: 'imbrex://other' }] }, id, 'mock.echo', { text: 'fixture' }), { code: 'forbidden' });
  await assert.rejects(capabilities.invoke({ ...principal, permissions: principal.permissions.filter((value) => value !== 'events:read') }, id, 'mock.echo', { text: 'fixture' }), { code: 'forbidden' });
  assert.equal(reads, 1, 'denied metadata requests must not reach the provider read');
});

test('one unavailable capability stays visible to administration but cannot be discovered or dispatched', async (t) => {
  const { capabilities, id, owner } = await fixture(t);
  let available = false, calls = 0;
  capabilities.register(owner, { ...definition(() => { calls += 1; return null; }, false), available: () => available });
  assert.deepEqual(capabilities.list(principal), []);
  assert.equal(capabilities.inspect({ ...principal, permissions: [...principal.permissions, 'admin:inspect'] })[0]!.available, false);
  await assert.rejects(capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' }), { code: 'provider_unavailable' });
  assert.equal(calls, 0);
  available = true;
  assert.equal(capabilities.list(principal).length, 1);
  assert.equal((await capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' })).kind, 'result');
  assert.equal(calls, 1);
});

test('read-only provider errors retain known codes without exposing provider messages', async (t) => {
  const { capabilities, id, owner } = await fixture(t);
  const remove = capabilities.register(owner, definition(() => { throw new GatewayError('forbidden', 'private fixture message'); }, false));
  await assert.rejects(capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' }), { code: 'forbidden', message: 'forbidden' });
  remove();
  capabilities.register(owner, definition(() => { throw new Error('private fixture message'); }, false));
  await assert.rejects(capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' }), { code: 'provider_unavailable', message: 'provider_unavailable' });
});

test('failed call persistence never dispatches and failed result persistence never claims success', async (t) => {
  const { store, events, id, owner } = await fixture(t);
  let sends = 0;
  // Override the concrete persistence boundary to reproduce I/O failures after/before a side effect.
  for (const method of ['createCall', 'finishCall'] as const) {
    const failing = Object.create(store) as GatewayStore;
    failing[method] = async () => { throw new GatewayError('storage_unavailable'); };
    const service = new Capabilities(failing, events, true);
    service.register(owner, definition(() => { sends += 1; return { status: 'succeeded', result: null }; }));
    await assert.rejects(service.invoke(principal, id, 'mock.write', { text: 'fixture' }, method), { code: 'storage_unavailable' });
    assert.equal(sends, method === 'createCall' ? 0 : 1);
  }
  assert.equal((await store.getCall(id, principal.id, 'finishCall'))?.status, 'in_progress');
});

test('timed-out handlers retain the concurrency slot until the underlying operation settles', async (t) => {
  const { capabilities, id, owner } = await fixture(t, 5);
  const execution = Promise.withResolvers<JsonValue>();
  let sends = 0;
  capabilities.register(owner, definition(async () => { sends += 1; return { status: 'succeeded', result: await execution.promise }; }));
  for (let i = 0; i < 8; i += 1) {
    assert.equal(call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, String(i))).status, 'unknown');
  }
  await assert.rejects(capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'overflow'), { code: 'busy' });
  assert.equal(sends, 8);
  execution.resolve('completed');
  await setImmediate();
  assert.equal(call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'after')).status, 'succeeded');
});

test('queue saturation after dispatch is storage_unavailable rather than an admission rejection', async (t) => {
  const { capabilities, store, id, owner } = await fixture(t);
  let sends = 0;
  let queued = Promise.resolve();
  capabilities.register(owner, definition(() => {
    sends += 1;
    queued = Promise.allSettled(Array.from({ length: 32 }, () => store.info())).then(() => {});
    return { status: 'succeeded', result: null };
  }));
  await assert.rejects(capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'saturated'), { code: 'storage_unavailable', status: 503 });
  await queued;
  assert.equal(call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'saturated')).status, 'in_progress');
  assert.equal(sends, 1);
});

test('read-only and side-effectful results have the same JSON depth limit', async (t) => {
  const { capabilities, id, owner } = await fixture(t);
  let result: JsonValue = null;
  for (let depth = 0; depth < 32; depth += 1) result = [result];
  capabilities.register(owner, definition(() => result, false));
  capabilities.register(owner, definition(() => ({ status: 'succeeded', result })));
  const read = await capabilities.invoke(principal, id, 'mock.echo', { text: 'fixture' });
  assert.equal(read.kind, 'result');
  const write = call(await capabilities.invoke(principal, id, 'mock.write', { text: 'fixture' }, 'depth'));
  assert.equal(write.status, 'succeeded'); assert.deepEqual(write.result, result);
});

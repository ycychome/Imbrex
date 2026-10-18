import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules, type PluginModule } from '../../src/host/modules.js';
import { object } from '../../src/core/validation.js';
import type { PluginApi } from '../../src/host/plugin-api.js';

const demoToken = 'fixture-demo-token';
const operatorToken = 'fixture-operator-token';
async function configFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-host-'));
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map((close) => close()));
    await rm(dir, { recursive: true, force: true });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/demo.json', import.meta.url), 'utf8')));
  raw.data_dir = join(dir, 'data'); object(raw.http).port = 0;
  assert.ok(Array.isArray(raw.principals));
  raw.principals.push({ id: 'http-writer', token_env: 'TEST_WRITER_TOKEN', permissions: ['events:read', 'events:write', 'calls:read'], read_sources: [{ prefix: 'imbrex://fixture/' }], write_sources: [{ exact: 'imbrex://fixture/client' }], invoke_capabilities: [] });
  const filename = join(dir, 'config.json');
  const config = parseConfig(raw, filename, { IMBREX_DEMO_AGENT_TOKEN: demoToken, IMBREX_OPERATOR_TOKEN: operatorToken, TEST_WRITER_TOKEN: 'fixture-writer-token' });
  return { dir, config, filename, cleanup };
}
async function fixture(t: TestContext, extra?: PluginModule, required = true) {
  const state = await configFixture(t);
  const modules = await loadModules(state.config, state.filename);
  if (extra) {
    state.config.plugins.push({ id: 'extra', module: 'fixture-module', principalId: 'mock-provider', enabled: true, required, config: {} });
    modules.set('extra', extra);
  }
  const logs: string[] = [];
  const app = await Host.open(state.config, modules, { report: (code) => { logs.push(code); }, lifecycleTimeoutMs: 100 });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  state.cleanup.push(close);
  return { ...state, app, logs, close, modules };
}
async function request(app: Host, path: string, data?: unknown, token = demoToken) {
  const response = await fetch('http://127.0.0.1:' + app.port + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, value: object(await response.json()) };
}

test('the demo publishes and transforms events, exposes tools, and keeps independent consumer positions', async (t) => {
  const { app, config, close, modules, cleanup } = await fixture(t);
  const info = await request(app, '/v1/info');
  assert.equal(info.status, 200); assert.equal(info.value.latest_seq, '4');
  const id = String(info.value.store_id);
  const page = await request(app, '/v1/events?store_id=' + id + '&after_seq=0');
  assert.equal(page.status, 200);
  assert.ok(Array.isArray(page.value.records)); assert.equal(page.value.records.length, 4);
  const derived = page.value.records.map((value: unknown) => object(value)).filter((record) => object(record.event).source === 'imbrex://fixture/derived');
  assert.equal(derived.length, 2); assert.deepEqual(derived[0]!.parents, [{ source: 'imbrex://fixture/messages', id: 'message-001' }]);
  const observer = object(JSON.parse(await readFile(join(config.dataDir, 'plugins/observer/position.json'), 'utf8')));
  assert.equal(observer.last_seq, '4');
  const result = await request(app, '/v1/capabilities/mock.echo/invoke', { store_id: id, params: { text: 'hello' } });
  assert.equal(result.status, 200); assert.deepEqual(result.value.result, { text: 'hello' });
  await app.stopPlugin('observer');
  assert.equal(app.plugins().find((item) => item.id === 'transform')?.state, 'active');
  await app.startPlugin('observer');
  await close();
  await assert.rejects(fetch('http://127.0.0.1:' + app.port + '/v1/info'));
  const restarted = await Host.open(config, modules);
  cleanup.push(() => restarted.close());
  assert.equal((await restarted.info()).storeId, id);
  assert.equal((await restarted.info()).latestSeq, 4n);
});

test('HTTP rejects forged callers, invalid query/body shapes, compressed and oversized requests', async (t) => {
  const { app } = await fixture(t);
  const id = (await app.info()).storeId;
  assert.equal((await request(app, '/v1/info', undefined, 'wrong')).status, 401);
  assert.equal((await request(app, '/v1/plugins')).status, 403);
  assert.equal((await request(app, '/v1/plugins', undefined, operatorToken)).status, 200);
  const event = { specversion: '1.0', source: 'imbrex://fixture/client', id: 'http-001', type: 'fixture.client.created', datacontenttype: 'application/json', data: { text: 'fixture' } };
  const created = await request(app, '/v1/events', { store_id: id, event }, 'fixture-writer-token');
  assert.equal(created.status, 201);
  const duplicate = await request(app, '/v1/events', { store_id: id, event: { ...event, data: 'changed' } }, 'fixture-writer-token');
  assert.equal(duplicate.status, 200); assert.equal(duplicate.value.seq, created.value.seq);
  const lookup = await request(app, '/v1/events/lookup?' + new URLSearchParams({ store_id: id, source: event.source, id: event.id }));
  assert.equal(lookup.status, 200); assert.deepEqual(object(object(lookup.value.record).event).data, event.data);
  assert.equal((await request(app, '/v1/events', { store_id: id, event })).status, 403);
  assert.equal((await request(app, '/v1/events?store_id=' + id + '&after_seq=0&after_seq=1')).status, 400);
  assert.equal((await request(app, '/v1/events/lookup?store_id=' + id + '&source=imbrex%3A%2F%2Ffixture%2Fclient&id=%ED%A0%80')).status, 400);
  assert.equal((await request(app, '/v1/events?store_id=wrong&after_seq=0')).status, 409);
  assert.equal((await request(app, '/v1/events?store_id=' + id + '&after_seq=99')).status, 409);
  assert.equal((await request(app, '/v1/capabilities/mock.echo/invoke', { store_id: id, caller_id: 'operator', params: { text: 'fixture' } })).status, 400);
  for (const [body, headers, expected] of [
    ['x'.repeat(262145), {}, 413],
    ['{}', { 'content-encoding': 'gzip' }, 400],
    ['{', {}, 400],
  ] as const) {
    const response = await fetch('http://127.0.0.1:' + app.port + '/v1/events', { method: 'POST', headers: { authorization: 'Bearer ' + demoToken, 'content-type': 'application/json', ...headers }, body });
    assert.equal(response.status, expected);
    assert.ok(object(await response.json()).request_id);
  }
  assert.equal((await request(app, '/v1/info')).status, 200);
});

test('HTTP bounds unfinished bodies and survives their disconnects and chunked oversize input', async (t) => {
  const { app } = await fixture(t);
  const held: ReturnType<typeof httpRequest>[] = [];
  t.after(() => { for (const req of held) req.destroy(); });
  for (let i = 0; i < 32; i += 1) {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: app.port, path: '/v1/events', method: 'POST', headers: {
        authorization: 'Bearer ' + demoToken, 'content-type': 'application/json', 'content-length': '100', expect: '100-continue',
      } });
      held.push(req);
      req.once('continue', () => { req.write('{'); resolve(); });
      req.on('error', reject);
      req.flushHeaders();
    });
  }
  assert.equal((await request(app, '/v1/info')).status, 429);
  await Promise.all(held.map((req) => new Promise<void>((resolve) => { req.once('close', () => resolve()); req.destroy(); })));
  const oversized = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: app.port, path: '/v1/events', method: 'POST', headers: { authorization: 'Bearer ' + demoToken, 'content-type': 'application/json' } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.write('x'.repeat(262145)); req.end();
  });
  assert.equal(oversized, 413);
  assert.equal((await request(app, '/v1/info')).status, 200);
});

test('optional initialization failure is sanitized while required failure releases the host', async (t) => {
  const plugin: PluginModule = { name: 'broken', apply: () => { throw new Error('private-secret-fixture'); } };
  const { app, config, filename } = await fixture(t, plugin, false);
  const status = await request(app, '/v1/plugins', undefined, operatorToken);
  assert.ok(!JSON.stringify(status).includes('private-secret-fixture'));
  assert.equal(app.plugins().find((item) => item.id === 'extra')?.state, 'failed');
  const required = structuredClone({ ...config, authenticate: undefined });
  const next = { ...config, dataDir: join(config.dataDir, 'required'), plugins: required.plugins.map((item) => ({ ...item, required: true })) };
  const modules = await loadModules({ ...config, plugins: config.plugins.filter((item) => item.id !== 'extra') }, filename);
  modules.set('extra', plugin);
  await assert.rejects(Host.open(next, modules), { code: 'provider_unavailable' });
  let applied = false;
  modules.set('extra', { name: 'invalid-config', Config: { '~standard': { version: 1, vendor: 'fixture', validate: () => ({ issues: [{ message: 'Rejected fixture configuration' }] }) } }, apply: () => { applied = true; } });
  await assert.rejects(Host.open(next, modules), { code: 'provider_unavailable' });
  assert.equal(applied, false);
});

test('plugin bindings inherit child scope, reject stale APIs, and clean registrations on restart', async (t) => {
  let lastApi: PluginApi | undefined;
  let cleanups = 0;
  const { app } = await fixture(t, { name: 'lifecycle', apply: (ctx) => {
    lastApi = ctx.imbrex.forPlugin(ctx.extend());
    return () => { cleanups += 1; };
  } });
  const old = lastApi!;
  await app.stopPlugin('extra');
  assert.equal(cleanups, 1);
  assert.throws(() => old.events.append({}), { code: 'provider_unavailable' });
  await app.startPlugin('extra');
  assert.notEqual(lastApi, old);
  await app.stopPlugin('mock');
  const unavailable = await request(app, '/v1/capabilities/mock.echo/invoke', { store_id: old.storeId, params: { text: 'fixture' } });
  assert.equal(unavailable.status, 404);
  await app.startPlugin('mock');
  assert.equal((await request(app, '/v1/capabilities/mock.echo/invoke', { store_id: old.storeId, params: { text: 'fixture' } })).status, 200);
});

test('throwing cleanup is reported as stop_failed and prevents an unsafe restart', async (t) => {
  const { app, close } = await fixture(t, { name: 'bad-cleanup', apply: () => () => { throw new Error('private-cleanup-fixture'); } });
  await assert.rejects(app.stopPlugin('extra'), { message: 'stop_failed' });
  await assert.rejects(app.startPlugin('extra'), { code: 'invalid_request' });
  assert.ok(!JSON.stringify(app.plugins()).includes('private-cleanup-fixture'));
  await assert.rejects(close());
});

test('a compiled example plugin is loaded through configuration without changing core code', async (t) => {
  const { config, filename, cleanup } = await configFixture(t);
  config.plugins.push({ id: 'custom', module: fileURLToPath(new URL('../../examples/plugins/uppercase.js', import.meta.url)), principalId: 'mock-provider', required: true, enabled: true, config: {} });
  config.principals.find((item) => item.id === 'demo-agent')!.invokeCapabilities.push('custom.uppercase');
  const app = await Host.open(config, await loadModules(config, filename));
  cleanup.push(() => app.close());
  const response = await request(app, '/v1/capabilities/custom.uppercase/invoke', { store_id: (await app.info()).storeId, params: { text: 'hello' } });
  assert.equal(response.status, 200); assert.deepEqual(response.value.result, { text: 'HELLO' });
});

test('a lost HTTP response does not cancel or duplicate a persisted side-effectful call', async (t) => {
  const { config, filename, cleanup } = await configFixture(t);
  config.externalWritesEnabled = true;
  config.principals.find((item) => item.id === 'demo-agent')!.invokeCapabilities.push('extra.write');
  config.plugins.push({ id: 'extra', module: 'fixture-module', principalId: 'mock-provider', required: true, enabled: true, config: {} });
  const modules = await loadModules({ ...config, plugins: config.plugins.filter((item) => item.id !== 'extra') }, filename);
  const begun = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  modules.set('extra', { name: 'write-fixture', apply: (ctx) => {
    ctx.imbrex.forPlugin(ctx).capabilities.register({ localName: 'write', description: 'fixture', schemaVersion: '1', isSideEffectful: true, inputSchema: { type: 'object' }, handler: async () => {
      calls += 1; begun.resolve(); await release.promise; return { status: 'succeeded', result: { id: 'fixture-result' } };
    } });
  } });
  const app = await Host.open(config, modules); cleanup.push(() => app.close());
  const storeId = (await app.info()).storeId;
  const input = { store_id: storeId, call_id: 'http-intent', params: { text: 'fixture' } };
  const controller = new AbortController();
  const lost = fetch('http://127.0.0.1:' + app.port + '/v1/capabilities/extra.write/invoke', { method: 'POST', headers: { authorization: 'Bearer ' + demoToken, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
  const lostResponse = assert.rejects(lost);
  await begun.promise; controller.abort(); await lostResponse;
  const repeated = await request(app, '/v1/capabilities/extra.write/invoke', input);
  assert.equal(repeated.status, 202); assert.equal(object(repeated.value.call).status, 'in_progress');
  assert.equal((await request(app, '/v1/capabilities/extra.write/invoke', { ...input, params: { text: 'changed' } })).status, 409);
  const query = '/v1/calls/http-intent?store_id=' + storeId;
  assert.equal((await request(app, query, undefined, 'fixture-writer-token')).status, 404);
  release.resolve(); await setImmediate();
  const result = await request(app, query);
  assert.equal(result.status, 200); assert.equal(object(result.value.call).status, 'succeeded');
  assert.deepEqual(object(result.value.call).result, { id: 'fixture-result' });
  assert.equal(calls, 1);
});

test('a failed database worker shuts down the HTTP host and notifies its supervisor', async (t) => {
  const { config, filename, cleanup } = await configFixture(t);
  const fatal = Promise.withResolvers<void>();
  const app = await Host.open(config, await loadModules(config, filename), { onFatal: () => fatal.resolve() });
  cleanup.push(() => app.close().catch(() => {}));
  const store: object = Reflect.get(app, 'store') as object;
  const worker: unknown = Reflect.get(store, 'worker');
  assert.ok(worker instanceof Worker);
  await worker.terminate();
  await fatal.promise;
  await assert.rejects(fetch('http://127.0.0.1:' + app.port + '/v1/info'));
  await assert.rejects(app.close());
});

test('Cordis dependency unload invalidates bindings and reactivation creates fresh scoped resources', async (t) => {
  const { config, filename, cleanup } = await configFixture(t);
  const modules = await loadModules(config, filename);
  for (const id of ['provider', 'dependent']) config.plugins.push({ id, module: 'fixture-module', principalId: 'mock-provider', required: true, enabled: true, config: {} });
  config.principals.find((item) => item.id === 'demo-agent')!.invokeCapabilities.push('dependent.echo');
  const bindings: PluginApi[] = [];
  modules.set('provider', { name: 'provider', apply: (ctx) => { ctx.provide('fixtureService', {}); } });
  modules.set('dependent', { name: 'dependent', inject: ['fixtureService'], apply: (ctx) => {
    const api = ctx.imbrex.forPlugin(ctx); bindings.push(api);
    api.capabilities.register({ localName: 'echo', description: 'fixture', schemaVersion: '1', isSideEffectful: false, inputSchema: { type: 'object' }, handler: () => 'fixture' });
  } });
  const app = await Host.open(config, modules); cleanup.push(() => app.close());
  const id = (await app.info()).storeId;
  assert.equal(bindings.length, 1);
  await app.stopPlugin('provider');
  assert.equal(app.plugins().find((item) => item.id === 'dependent')?.state, 'waiting');
  assert.equal(bindings[0]!.signal.aborted, true);
  assert.throws(() => bindings[0]!.events.read({ afterSeq: 0n }), { code: 'provider_unavailable' });
  await app.startPlugin('provider');
  assert.equal((await request(app, '/v1/capabilities/dependent.echo/invoke', { store_id: id, params: {} })).status, 200);
  assert.equal(bindings.length, 2);
});

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import type { PluginApi } from '../../src/host/plugin-api.js';
import { object } from '../../src/core/validation.js';
import { AdminRegistry } from '../../src/host/admin-registry.js';
import type { Principal } from '../../src/core/types.js';

const token = 'fixture-admin-token';

async function fixture(t: TestContext, adminConfig: (directory: string) => Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-admin-'));
  let app: Host | undefined;
  t.after(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const raw = {
    config_version: 2,
    data_dir: join(directory, 'data'),
    external_writes_enabled: false,
    principals: [{
      id: 'admin',
      token_env: 'IMBREX_ADMIN_TEST_TOKEN',
      permissions: ['admin:inspect'],
      read_sources: [],
      write_sources: [],
      invoke_capabilities: [],
    }],
    plugins: [
      {
        id: 'http',
        module: 'builtin:server-http',
        principal_id: 'admin',
        required: true,
        enabled: true,
        config: { host: '127.0.0.1', port: 0 },
      },
      {
        id: 'admin',
        module: 'builtin:admin',
        principal_id: 'admin',
        required: true,
        enabled: true,
        config: adminConfig(directory),
      },
    ],
  };
  const filename = join(directory, 'imbrex.json');
  const config = parseConfig(raw, filename, { IMBREX_ADMIN_TEST_TOKEN: token });
  const modules = await loadModules(config, filename);
  app = await Host.open(config, modules);
  return app;
}

async function managementFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-admin-'));
  let app: Host | undefined;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/demo.json', import.meta.url), 'utf8')));
  raw.data_dir = join(directory, 'data'); raw.external_writes_enabled = true;
  assert.ok(Array.isArray(raw.principals));
  raw.principals.push({ id: 'admin', token_env: 'ADMIN_TOKEN', permissions: ['admin:inspect'], read_sources: [], write_sources: [], invoke_capabilities: [] });
  raw.principals.push({ id: 'operate', token_env: 'OPERATE_TOKEN', permissions: ['admin:operate'], read_sources: [], write_sources: [], invoke_capabilities: [] });
  const config = parseConfig(raw, join(directory, 'config.json'), { IMBREX_DEMO_AGENT_TOKEN: 'fixture-agent-secret', IMBREX_OPERATOR_TOKEN: 'fixture-operator-secret', ADMIN_TOKEN: 'fixture-admin-secret', OPERATE_TOKEN: 'fixture-operate-secret' });
  config.plugins.find((plugin) => plugin.id === 'http')!.config.port = 0;
  config.plugins.push({ id: 'admin', module: 'builtin:admin', principalId: 'protocol', required: true, enabled: false, config: {} });
  const modules = await loadModules(config, join(directory, 'config.json'));
  const request = async (path: string, token = 'fixture-admin-secret') => {
    const response = await fetch('http://127.0.0.1:' + app!.port + path, { headers: { authorization: 'Bearer ' + token } });
    return { status: response.status, body: object(await response.json()), cache: response.headers.get('cache-control') };
  };
  return { config, modules, request, open: async () => { app = await Host.open(config, modules); return app; } };
}

test('default package resolution serves the built admin UI and info', async (t) => {
  const app = await fixture(t, () => ({}));
  const base = 'http://127.0.0.1:' + app.port;
  const page = await fetch(base + '/admin');
  assert.equal(page.status, 200, 'run npm run web:build before this test');
  const html = await page.text();
  assert.match(html, /<div id="app"><\/div>/);
  const asset = /(?:src|href)="(\/admin\/assets\/[^"]+)"/.exec(html)?.[1];
  assert.ok(asset, 'built index must reference an admin asset');
  const response = await fetch(base + asset);
  assert.equal(response.status, 200);
  const etag = response.headers.get('etag');
  assert.ok(etag, 'static assets must be revalidatable');
  const revalidated = await fetch(base + asset, { headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304);
  await revalidated.text();
  const info = await fetch(base + '/api/admin/info', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(info.status, 200);
  const body = object(await info.json());
  assert.equal(typeof body.store_id, 'string');
  assert.equal(typeof body.latest_seq, 'string');
  assert.equal(typeof body.version, 'string');
  assert.ok(Array.isArray(body.plugins));
  const admin = body.plugins.map((plugin) => object(plugin)).find((plugin) => plugin.id === 'admin');
  assert.equal(admin?.enabled, true);
  assert.equal(admin?.client_entry, '/admin/plugins/admin/entry.js');
});

test('missing explicit assets_dir returns 404 without blocking the admin API', async (t) => {
  const app = await fixture(t, (directory) => ({ assets_dir: join(directory, 'missing') }));
  const base = 'http://127.0.0.1:' + app.port;
  const page = await fetch(base + '/admin');
  assert.equal(page.status, 404);
  const info = await fetch(base + '/api/admin/info', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(info.status, 200);
});

test('non-directory assets_dir degrades to 404 without blocking the admin API', async (t) => {
  const app = await fixture(t, (directory) => {
    const file = join(directory, 'not-a-directory');
    writeFileSync(file, 'fixture');
    return { assets_dir: file };
  });
  const base = 'http://127.0.0.1:' + app.port;
  const page = await fetch(base + '/admin');
  assert.equal(page.status, 404);
  const info = await fetch(base + '/api/admin/info', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(info.status, 200);
});

test('a queued panel read cannot dispatch after its instance unregisters', async () => {
  const registry = new AdminRegistry(), controller = new AbortController();
  const principal: Principal = { id: 'fixture', permissions: ['admin:inspect'], readSources: [], writeSources: [], invokeCapabilities: [] };
  let reads = 0;
  const unregister = registry.register('fixture', 'agent-chat', controller.signal, { title: 'Fixture', icon: 'fixture', read: () => { reads += 1; return { status: { tone: 'ok', label: 'ok' }, metrics: [], data: {} }; } });
  const reading = registry.read(principal, 'fixture');
  controller.abort(); unregister();
  assert.equal((await reading).error?.code, 'admin_panel_read_failed');
  assert.equal(reads, 0);
});

test('management reads authenticate separately and audit persisted calls across principals without widening REST grants', async (t) => {
  const f = await managementFixture(t);
  let api!: PluginApi;
  f.config.principals.find((principal) => principal.id === 'mock-provider')!.permissions.push('capabilities:invoke', 'calls:read');
  f.config.principals.find((principal) => principal.id === 'mock-provider')!.invokeCapabilities.push('audit.write');
  f.config.principals.find((principal) => principal.id === 'demo-agent')!.invokeCapabilities.push('audit.write');
  f.config.plugins.push({ id: 'audit', module: 'fixture', principalId: 'mock-provider', required: true, enabled: true, config: {} });
  f.modules.set('audit', { apply: (ctx) => {
    api = ctx.imbrex.forPlugin(ctx);
    api.capabilities.register({ localName: 'write', description: 'fixture', schemaVersion: '1', isSideEffectful: true, inputSchema: { type: 'object' },
      handler: () => ({ status: 'unknown', reason: { code: 'fixture_unknown', message: 'No receipt.' } }),
    });
  } });
  const app = await f.open(); await app.startPlugin('admin');
  const storeId = (await app.info()).storeId;
  await api.capabilities.invoke('audit.write', {}, { callId: 'same-id' });
  const called = await fetch('http://127.0.0.1:' + app.port + '/v1/capabilities/audit.write/invoke', { method: 'POST',
    headers: { authorization: 'Bearer fixture-agent-secret', 'content-type': 'application/json' }, body: JSON.stringify({ store_id: storeId, call_id: 'same-id', params: {} }),
  });
  assert.equal(called.status, 200); await called.text();
  for (const path of ['/api/admin/info', '/api/admin/panels', '/api/admin/configuration', '/api/admin/events?store_id=' + storeId + '&after_seq=0', '/api/admin/capabilities', '/api/admin/calls?store_id=' + storeId]) {
    assert.equal((await f.request(path, 'wrong')).status, 401);
    assert.equal((await f.request(path, 'fixture-agent-secret')).status, 403);
    assert.equal((await f.request(path, 'fixture-operate-secret')).status, 403);
    assert.equal((await f.request(path)).cache, 'no-store');
  }
  const first = await f.request('/api/admin/calls?store_id=' + storeId + '&limit=1');
  assert.ok(Array.isArray(first.body.calls)); assert.equal(first.body.calls.length, 1);
  assert.equal(object(first.body.calls[0]).status, 'unknown');
  const next = object(first.body.next);
  const second = await f.request('/api/admin/calls?' + new URLSearchParams({ store_id: storeId, after_caller_id: String(next.caller_id), after_call_id: String(next.call_id), limit: '1' }));
  assert.ok(Array.isArray(second.body.calls)); assert.equal(second.body.calls.length, 1); assert.equal(second.body.next, null);
  assert.notEqual(object(first.body.calls[0]).caller_id, object(second.body.calls[0]).caller_id);
  assert.equal((await f.request('/api/admin/calls?store_id=wrong')).status, 409);
  for (const query of ['&limit=101', '&limit=0', '&limit=01', '&status=bad', '&after_call_id=same-id', '&limit=1&limit=2']) assert.equal((await f.request('/api/admin/calls?store_id=' + storeId + query)).status, 400);
  assert.equal((await f.request('/v1/calls/same-id?store_id=' + storeId)).status, 403);
  const config = await f.request('/api/admin/configuration');
  assert.ok(!JSON.stringify(config).includes('fixture-admin-secret')); assert.ok(!JSON.stringify(config).includes('fixture-agent-secret'));
  assert.ok(JSON.stringify(config).includes('ADMIN_TOKEN'));
  const events = await f.request('/api/admin/events?store_id=' + storeId + '&after_seq=0');
  assert.ok(Array.isArray(events.body.records)); assert.equal(events.body.records.length, 4);
});

test('instance panel registration outlives Admin, failures are isolated, and unloading removes stale readers', async (t) => {
  const f = await managementFixture(t);
  const starts = new Map<string, number>();
  for (const id of ['one', 'two', 'broken']) {
    f.config.plugins.push({ id, module: 'fixture', principalId: 'mock-provider', required: true, enabled: true, config: {} });
    f.modules.set(id, { name: 'shared', apply: (ctx) => {
      starts.set(id, (starts.get(id) ?? 0) + 1);
      const api = ctx.imbrex.forPlugin(ctx);
      api.registerAdminPanel({ title: 'Shared module', icon: 'fixture', read: () => {
        if (id === 'broken') throw new Error('fixture-private-secret');
        return { status: { tone: 'ok', label: 'ok' }, metrics: [{ label: 'owner', value: api.instanceId }], data: { owner: api.instanceId, starts: starts.get(id)! } };
      } });
    } });
  }
  const app = await f.open(); await app.startPlugin('admin');
  const list = await f.request('/api/admin/panels'); assert.ok(Array.isArray(list.body.panels));
  assert.deepEqual(list.body.panels.map((panel) => object(panel).instance_id), ['one', 'two', 'broken']);
  assert.deepEqual(list.body.panels.map((panel) => object(panel).module), ['shared', 'shared', 'shared']);
  const before = await f.request('/api/admin/panels/one'); assert.equal(object(object(before.body.data).data).owner, 'one'); assert.equal(object(object(before.body.data).status).label, 'ok');
  assert.equal(before.body.module, 'shared');
  const bad = await f.request('/api/admin/panels/broken'); assert.equal(object(bad.body.error).code, 'admin_panel_read_failed');
  assert.ok(!JSON.stringify(bad).includes('fixture-private-secret'));
  await app.stopPlugin('admin'); await app.startPlugin('admin');
  assert.equal((await f.request('/api/admin/panels/one')).body.generation, before.body.generation);
  assert.equal(starts.get('one'), 1);
  await app.stopPlugin('one'); assert.equal((await f.request('/api/admin/panels/one')).status, 404);
  assert.equal((await f.request('/api/admin/panels/two')).status, 200);
  await app.startPlugin('one'); assert.notEqual((await f.request('/api/admin/panels/one')).body.generation, before.body.generation);
});

test('registered operations enforce schema, identity, permission and instance exclusivity and survive Admin unload', async (t) => {
  const f = await managementFixture(t);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let executions = 0;
  f.config.plugins.push({ id: 'controlled', module: 'fixture', principalId: 'mock-provider', required: true, enabled: true, config: {} });
  f.modules.set('controlled', { apply: (ctx) => { ctx.imbrex.forPlugin(ctx).registerAdminPanel({ title: 'Fixture', icon: 'fixture', read: () => ({ status: { tone: 'ok', label: 'ok' }, metrics: [], data: { executions } }),
    actions: [{ id: 'hold', title: 'Hold fixture operation', inputSchema: { type: 'object', properties: { reason: { type: 'string', minLength: 1 } }, required: ['reason'], additionalProperties: false },
      execute: async () => { executions += 1; entered.resolve(); await release.promise; return { status: 'succeeded' }; },
    }],
  }); } });
  const app = await f.open(); await app.startPlugin('admin');
  const descriptor = (await f.request('/api/admin/panels/controlled')).body;
  const body = { store_id: descriptor.store_id, generation: descriptor.generation, params: { reason: 'fixture' } };
  const invoke = async (value: unknown, token = 'fixture-operate-secret', origin?: string) => {
    const response = await fetch('http://127.0.0.1:' + app.port + '/api/admin/panels/controlled/actions/hold', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(value) });
    return { status: response.status, value: object(await response.json()) };
  };
  assert.equal((await invoke(body, 'fixture-admin-secret')).status, 403);
  assert.equal((await invoke(body, 'fixture-agent-secret')).status, 403);
  assert.equal((await invoke(body, 'fixture-operate-secret', 'https://foreign.example')).status, 403);
  assert.equal((await invoke({ ...body, generation: 'stale' })).status, 409);
  assert.equal((await invoke({ ...body, store_id: 'other' })).status, 409);
  assert.equal((await invoke({ ...body, params: {} })).status, 400);
  assert.equal(executions, 0);
  const running = invoke(body).catch(() => undefined);
  try {
    await entered.promise;
    assert.equal((await invoke(body)).status, 429);
    const stopping = app.stopPlugin('admin');
    release.resolve(); await stopping; await running;
    assert.equal(executions, 1);
    await app.startPlugin('admin');
    assert.equal((await f.request('/api/admin/panels/controlled')).body.generation, descriptor.generation);
  } finally { release.resolve(); await running; }
});

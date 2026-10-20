import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import { migrateConfig } from '../../src/host/migrate-config.js';
import { object } from '../../src/core/validation.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-protocols-'));
  let app: Host | undefined;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/demo.json', import.meta.url), 'utf8')));
  raw.data_dir = join(directory, 'data'); raw.external_writes_enabled = true;
  const config = parseConfig(raw, join(directory, 'config.json'), { IMBREX_DEMO_AGENT_TOKEN: 'fixture-agent', IMBREX_OPERATOR_TOKEN: 'fixture-admin' });
  config.plugins.find((plugin) => plugin.id === 'http')!.config.port = 0;
  const admin = config.principals.find((principal) => principal.id === 'operator')!;
  admin.permissions.push('admin:inspect');
  config.plugins.push({ id: 'admin', module: 'builtin:admin', principalId: admin.id, required: true, enabled: false, config: {} });
  const modules = await loadModules(config, join(directory, 'config.json'));
  return { directory, config, modules, open: async () => { app = await Host.open(config, modules); return app; } };
}

test('protocol and static routes are scoped, Admin restarts preserve business, and assets cannot escape their root', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'index.html'), 'fixture asset');
  await writeFile(join(f.directory, 'asset.js'), 'fixture script');
  await symlink('/etc/hostname', join(f.directory, 'outside.txt'));
  f.config.plugins.find((plugin) => plugin.id === 'admin')!.config.assets_dir = f.directory;
  const app = await f.open();
  const url = () => 'http://127.0.0.1:' + app.port;
  const get = async (path: string, token = 'fixture-admin', origin?: string) => {
    const response = await fetch(url() + path, { headers: { authorization: 'Bearer ' + token, ...(origin ? { origin } : {}) } });
    const body = await response.text(); return { status: response.status, body };
  };
  assert.equal((await get('/api/admin/info')).status, 404);
  await app.startPlugin('admin');
  assert.equal((await get('/api/admin/info', 'fixture-agent')).status, 403);
  assert.equal((await get('/api/admin/info', 'wrong')).status, 401);
  assert.equal((await get('/api/admin/info', 'fixture-admin', 'https://foreign.example')).status, 403);
  assert.equal((await get('/api/admin/info')).status, 200);
  assert.equal((await get('/admin/nested/route')).body, 'fixture asset');
  assert.equal((await get('/admin/asset.js')).body, 'fixture script');
  assert.equal((await get('/admin/outside.txt')).status, 404);
  const traversal = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(url() + '/admin', { path: '/admin/%2e%2e/etc/hostname' }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    request.once('error', reject); request.end();
  });
  assert.equal(traversal, 404);
  const before = (await app.info()).storeId;
  await app.stopPlugin('admin');
  assert.equal((await get('/admin')).status, 404);
  assert.equal((await get('/api/admin/info')).status, 404);
  assert.equal((await get('/v1/info')).status, 200);
  assert.equal(app.plugins().find((plugin) => plugin.id === 'transform')?.state, 'active');
  await app.startPlugin('admin');
  assert.equal((await get('/api/admin/info')).status, 200);
  assert.equal((await app.info()).storeId, before);
  await app.stopPlugin('rest');
  assert.equal((await get('/v1/info')).status, 404);
  assert.equal((await get('/v1/mcp')).status, 405);
  await app.startPlugin('rest');
  assert.equal((await get('/v1/info')).status, 200);
  await app.stopPlugin('http');
  assert.equal(app.plugins().find((plugin) => plugin.id === 'rest')?.state, 'waiting');
  await app.startPlugin('http');
  assert.equal((await get('/v1/info')).status, 200);
  assert.equal((await get('/api/admin/info')).status, 200);
});

test('unloading REST removes admission but lets an already dispatched external call finish durably', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.config.principals.find((principal) => principal.id === 'demo-agent')!.invokeCapabilities.push('writer.send');
  f.config.plugins.push({ id: 'writer', module: 'fixture', principalId: 'mock-provider', required: true, enabled: true, config: {} });
  let sends = 0;
  f.modules.set('writer', { apply: (ctx) => { ctx.imbrex.forPlugin(ctx).capabilities.register({
    localName: 'send', description: 'fixture write', schemaVersion: '1', isSideEffectful: true, inputSchema: { type: 'object' },
    handler: async () => { sends += 1; entered.resolve(); await release.promise; return { status: 'succeeded', result: 'fixture receipt' }; },
  }); } });
  const app = await f.open();
  const url = 'http://127.0.0.1:' + app.port;
  const storeId = (await app.info()).storeId;
  const request = fetch(url + '/v1/capabilities/writer.send/invoke', { method: 'POST', headers: { authorization: 'Bearer fixture-agent', 'content-type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, call_id: 'unload-intent', params: {} }),
  }).then(async (response) => { await response.text(); }, () => {});
  await entered.promise;
  const stopping = app.stopPlugin('rest');
  const rejected = await fetch(url + '/v1/info', { headers: { authorization: 'Bearer fixture-agent' } });
  assert.equal(rejected.status, 404); await rejected.text();
  release.resolve(); await stopping; await request;
  await app.startPlugin('rest');
  const result = await fetch(url + '/v1/calls/unload-intent?store_id=' + storeId, { headers: { authorization: 'Bearer fixture-agent' } });
  assert.equal(result.status, 200); assert.equal(object(object(await result.json()).call).status, 'succeeded');
  assert.equal(sends, 1);
});

test('configuration migration preserves data and instance bindings without granting management permissions', () => {
  const old = { config_version: 1, data_dir: '../state', http: { host: '127.0.0.1', port: 8080 }, external_writes_enabled: false,
    principals: [{ id: 'protocol', permissions: [], read_sources: [], write_sources: [], invoke_capabilities: [] }],
    plugins: [
      { id: 'agent', module: 'builtin:acp-consumer', principal_id: 'protocol', required: true, enabled: true, config: { input_id: 'original' } },
      { id: 'observer', module: 'builtin:observer', principal_id: 'protocol', required: false, enabled: true, config: {} },
      { id: 'custom', module: './plugin.mjs', principal_id: 'protocol', required: false, enabled: true, config: {} },
    ],
  };
  const next = migrateConfig(old, '/tmp/fixture/config/v1.json');
  assert.equal(next.data_dir, '/tmp/fixture/state');
  const config = parseConfig(next, '/tmp/elsewhere/v2.json');
  assert.deepEqual(config.plugins.find((plugin) => plugin.id === 'agent'), { id: 'agent', module: 'builtin:agent-chat', principalId: 'protocol', required: true, enabled: true, config: { input_id: 'original' } });
  assert.equal(config.plugins.find((plugin) => plugin.id === 'custom')?.module, '/tmp/fixture/config/plugin.mjs');
  assert.ok(!config.plugins.some((plugin) => plugin.id === 'observer'));
  assert.ok(config.principals.every((principal) => principal.permissions.length === 0));
  assert.equal(old.config_version, 1);
});

test('REST and MCP reject business requests until all required plugins initialize, including failed startup', async (t) => {
  for (const succeeds of [true, false]) await t.test(String(succeeds), async (t) => {
    const f = await fixture(t);
    const reached = Promise.withResolvers<{ origin: string; storeId: string }>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let writes = 0;
    f.config.principals.find((principal) => principal.id === 'demo-agent')!.invokeCapabilities.push('provider.write');
    for (const id of ['provider', 'gate']) f.config.plugins.push({ id, module: 'fixture', principalId: 'mock-provider', required: true, enabled: true, config: {} });
    f.modules.set('provider', { apply: (ctx) => { ctx.imbrex.forPlugin(ctx).capabilities.register({
      localName: 'write', description: 'fixture', schemaVersion: '1', isSideEffectful: true, inputSchema: { type: 'object' },
      handler: () => { writes += 1; return { status: 'succeeded', result: null }; },
    }); } });
    f.modules.set('gate', { inject: ['http'], apply: async (ctx) => {
      reached.resolve({ origin: ctx.http.origin, storeId: ctx.imbrex.forPlugin(ctx).storeId });
      await release.promise;
      if (!succeeds) throw new Error('fixture failed initialization');
    } });
    const opened = f.open().then((app) => ({ app, error: null }), (error: unknown) => ({ app: null, error }));
    const { origin, storeId } = await reached.promise;
    const headers = { authorization: 'Bearer fixture-agent', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const [path, body] of [
      ['/v1/info', undefined],
      ['/v1/capabilities/provider.write/invoke', { store_id: storeId, call_id: 'startup-intent', params: {} }],
      ['/v1/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'imbrex_invoke', arguments: { store_id: storeId, capability_id: 'provider.write', call_id: 'startup-intent', params: {} } } }],
    ] as const) {
      const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 503); assert.equal(object(object(await response.json()).error).code, 'provider_unavailable');
    }
    assert.equal(writes, 0); release.resolve();
    const result = await opened;
    if (succeeds) {
      assert.ok(result.app);
      const info = await fetch(origin + '/v1/info', { headers }); assert.equal(info.status, 200); await info.text();
      const call = await fetch(origin + '/v1/calls/startup-intent?store_id=' + storeId, { headers });
      assert.equal(call.status, 404); await call.text();
    } else { assert.equal(result.app, null); assert.ok(result.error); }
    assert.equal(writes, 0);
  });
});

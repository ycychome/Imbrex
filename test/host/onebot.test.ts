import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import { object } from '../../src/core/validation.js';
import { mapMessage, parseOneBotConfig } from '../../src/plugins/onebot-v11/protocol.js';
import { startSimulator } from '../../examples/onebot/simulator.js';
import { numericFixture, stringFixture } from '../../examples/onebot/fixtures.js';

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i += 1) { if (await check()) return; await delay(20); }
  assert.fail('Condition did not become true');
}
async function fixture(t: TestContext, stringIds = false, available = true, admin = false) {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-onebot-'));
  const envKey = 'IMBREX_ONEBOT_FIXTURE_TOKEN';
  const previous = process.env[envKey];
  process.env[envKey] = 'fixture-onebot';
  t.after(() => { if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous; });
  const sim = await startSimulator(0, 'fixture-onebot');
  if (stringIds) { sim.loginId = '123456'; sim.appName = 'standard-string-fixture'; }
  if (!available) sim.loginId = 222222;
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/onebot/imbrex.json', import.meta.url), 'utf8')));
  raw.data_dir = dir; raw.external_writes_enabled = true; object(((raw.plugins as unknown[]).map((value) => object(value)).find((plugin) => plugin.module === 'builtin:server-http')!).config).port = 0;
  assert.ok(Array.isArray(raw.plugins)); object(raw.plugins.map((value) => object(value)).find((plugin) => plugin.id === 'qq-main')!.config).ws_url = 'ws://127.0.0.1:' + sim.port + '/';
  object(raw.plugins.map((value) => object(value)).find((plugin) => plugin.id === 'qq-main')!.config).access_token_env = envKey;
  assert.ok(Array.isArray(raw.principals));
  raw.principals.push({ id: 'other', token_env: 'OTHER_TOKEN', permissions: ['events:read', 'capabilities:invoke', 'calls:read'], read_sources: [{ prefix: 'imbrex://other/' }], write_sources: [], invoke_capabilities: ['qq-main.reply'] });
  if (admin) {
    raw.principals.push({ id: 'admin', token_env: 'ADMIN_TOKEN', permissions: ['admin:inspect', 'admin:operate'], read_sources: [], write_sources: [], invoke_capabilities: [] });
    raw.plugins.push({ id: 'admin', module: 'builtin:admin', principal_id: 'protocol', required: true, enabled: true, config: {} });
  }
  const filename = join(dir, 'config.json');
  const config = parseConfig(raw, filename, { IMBREX_QQ_AGENT_TOKEN: 'fixture-agent', IMBREX_OPERATOR_TOKEN: 'fixture-operator', OTHER_TOKEN: 'fixture-other', ADMIN_TOKEN: 'fixture-admin' });
  const modules = await loadModules(config, filename);
  const app = await Host.open(config, modules);
  t.after(async () => { await app.close(); await sim.close(); await rm(dir, { recursive: true, force: true }); });
  const ready = () => app.plugins().find((plugin) => plugin.id === 'qq-main')?.available === true;
  if (available) await until(ready);
  const request = async (path: string, data?: unknown, token = 'fixture-agent') => {
    const response = await fetch('http://127.0.0.1:' + app.port + path, {
      method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, value: object(await response.json()) };
  };
  const storeId = (await app.info()).storeId;
  const adminRequest = async (path: string, data?: unknown) => {
    const response = await fetch('http://127.0.0.1:' + app.port + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer fixture-admin', 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: object(await response.json()) };
  };
  const act = async (action: string, params: unknown) => {
    const list = object((await adminRequest('/api/admin/panels')).body);
    const summary = (list.panels as unknown[]).map((value) => object(value)).find((value) => value.instance_id === 'qq-main')!;
    return await adminRequest('/api/admin/panels/qq-main/actions/' + action, { store_id: storeId, generation: summary.generation, params });
  };
  const panel = async () => object(object((await adminRequest('/api/admin/panels/qq-main')).body.data).data);
  const invoke = async (callId: string, kind = 'group', id = '-42', token?: string, namespace = 'main') => {
    return request('/v1/capabilities/qq-main.reply/invoke', { store_id: storeId, call_id: callId, params: {
      input_event_ref: { source: 'imbrex://qq/123456/' + namespace + '/' + kind + '/' + (kind === 'group' ? '987654' : '654321'), id: 'message:' + id }, text: '[CQ:at,qq=all] is literal',
    } }, token);
  };
  return { app, sim, config, ready, invoke, request, storeId, adminRequest, act, panel };
}

test('two independent wire fixtures map events and produce exact standard Actions without CQ injection', async (t) => {
  for (const stringIds of [false, true]) await t.test(String(stringIds), async (t) => {
    const { app, sim, invoke, request, storeId } = await fixture(t, stringIds);
    sim.broadcast(stringIds ? stringFixture : numericFixture);
    await until(async () => (await app.info()).latestSeq === 1n);
    const page = await request('/v1/events?store_id=' + storeId + '&after_seq=0');
    assert.ok(Array.isArray(page.value.records));
    const data = object(object(object(page.value.records[0]).event).data);
    assert.equal(data.text, stringIds ? 'A[B]&C' : '请回复这条测试消息');
    const result = await invoke('first', stringIds ? 'private' : 'group', stringIds ? '73' : '-42');
    assert.equal(object(result.value.call).status, 'succeeded');
    assert.deepEqual(object(object(result.value.call).result).native_message_id, '1001');
    assert.deepEqual(sim.actions.map(({ action, params }) => ({ action, params })), [{
      action: stringIds ? 'send_private_msg' : 'send_group_msg', params: {
        [stringIds ? 'user_id' : 'group_id']: stringIds ? 654321 : 987654,
        message: [{ type: 'reply', data: { id: stringIds ? '73' : '-42' } }, { type: 'text', data: { text: '[CQ:at,qq=all] is literal' } }],
      },
    }]);
    await invoke('first', stringIds ? 'private' : 'group', stringIds ? '73' : '-42');
    sim.broadcast(stringIds ? stringFixture : numericFixture);
    await delay(40); assert.equal((await app.info()).latestSeq, 1n); assert.equal(sim.actions.length, 1);
  });
});

test('reply enforces actual caller reads, namespace and inbound direction before sending', async (t) => {
  const { app, sim, invoke, config } = await fixture(t);
  sim.broadcast(numericFixture);
  sim.broadcast({ ...numericFixture, message_id: 99, user_id: 123456 });
  sim.broadcast({ ...numericFixture, message_id: 100, group_id: 111111 });
  await until(async () => (await app.info()).latestSeq === 2n);
  assert.equal(object((await invoke('denied', 'group', '-42', 'fixture-other')).value.call).status, 'failed');
  assert.equal(object((await invoke('old', 'group', '-42', undefined, 'old')).value.call).status, 'failed');
  assert.equal(object((await invoke('self', 'group', '99')).value.call).status, 'failed');
  assert.equal(sim.actions.length, 0);
  await app.stopPlugin('qq-main');
  config.plugins.find((plugin) => plugin.id === 'qq-main')!.config.identity_namespace = 'other';
  await assert.rejects(app.startPlugin('qq-main'), { code: 'provider_unavailable' });
  assert.equal(sim.actions.length, 0);
});

test('unknown responses and disconnects are persisted without repeating an Action, explicit rejection is failed', async (t) => {
  const { app, sim, invoke, ready } = await fixture(t);
  sim.broadcast(numericFixture); await until(async () => (await app.info()).latestSeq === 1n);
  for (const mode of ['async', 'malformed', 'reject', 'disconnect'] as const) {
    sim.mode = mode;
    const result = await invoke(mode);
    assert.equal(object(result.value.call).status, mode === 'reject' ? 'failed' : 'unknown');
    const count = sim.actions.length;
    const repeated = await invoke(mode);
    assert.deepEqual(repeated.value.call, result.value.call); assert.equal(sim.actions.length, count);
    if (mode === 'disconnect') await until(ready);
  }
  assert.equal(new Set(sim.actions.map((action) => action.echo)).size, 4);
  sim.broadcast(numericFixture); await delay(40); assert.equal((await app.info()).latestSeq, 1n);
});

test('account mismatch, oversized input and implementation changes remain unavailable and shutdown releases sockets', async (t) => {
  const { app, sim, ready, config } = await fixture(t, false, false);
  await until(() => app.plugins().find((plugin) => plugin.id === 'qq-main')?.last_error?.code === 'onebot_account_mismatch');
  sim.broadcast(numericFixture); assert.equal((await app.info()).latestSeq, 0n);
  sim.loginId = 123456; await until(ready);
  for (const client of sim.server.clients) client.send('x'.repeat(65537));
  await until(() => !ready()); await until(ready);
  sim.appName = 'another-implementation';
  for (const client of sim.server.clients) client.terminate();
  await until(() => app.plugins().find((plugin) => plugin.id === 'qq-main')?.last_error?.code === 'onebot_implementation_changed');
  await app.stopPlugin('qq-main');
  await until(() => sim.server.clients.size === 0);
  assert.equal((await app.info()).latestSeq, 0n);
  sim.appName = 'standard-numeric-fixture';
  await app.startPlugin('qq-main'); await until(ready);
  const saved = object(JSON.parse(await readFile(join(config.dataDir, 'plugins/qq-main/onebot-binding.json'), 'utf8')));
  assert.equal(saved.app_name, 'standard-numeric-fixture');
});

test('invalid native IDs and unsupported segments cannot enter storage; demo builtins still reject configuration', async (t) => {
  const { config } = await fixture(t);
  const parsed = parseOneBotConfig(config.plugins.find((plugin) => plugin.id === 'qq-main')!.config);
  for (const event of [
    { ...numericFixture, message_id: 9007199254740992 }, { ...numericFixture, self_id: 222222 },
    { ...numericFixture, message: '[CQ:image,file=example]' }, { ...numericFixture, message: '[CQ:reply,id=01]' },
    { ...numericFixture, message: [{ type: 'image', data: { file: 'example' } }] },
  ]) assert.throws(() => mapMessage(event, parsed));
  assert.throws(() => parseOneBotConfig({ ...config.plugins.find((plugin) => plugin.id === 'qq-main')!.config, compatibility_profile: 'imaginary' }));
  config.plugins.find((plugin) => plugin.id === 'qq-main')!.module = 'builtin:mock';
  await assert.rejects(loadModules(config, '/tmp/fixture-config.json'), { code: 'invalid_request' });
});

test('burst ingress is bounded and the connection recovers without automatically sending', async (t) => {
  const { app, sim, ready } = await fixture(t);
  for (let i = 0; i < 200; i += 1) sim.broadcast({ ...numericFixture, message_id: i });
  await until(() => app.plugins().find((plugin) => plugin.id === 'qq-main')?.last_error?.code === 'onebot_ingress_overflow');
  assert.ok((await app.info()).latestSeq < 200n);
  await until(ready);
  assert.equal(sim.actions.length, 0);
});

test('missing tokens fail initialization and an unacknowledged send times out as unknown', async (t) => {
  const { app, sim, invoke } = await fixture(t);
  sim.broadcast(numericFixture); await until(async () => (await app.info()).latestSeq === 1n);
  sim.mode = 'silent';
  const result = await invoke('timeout');
  assert.equal(object(result.value.call).status, 'unknown');
  assert.equal(object(object(result.value.call).reason).code, 'onebot_request_timeout');
  await invoke('timeout'); assert.equal(sim.actions.length, 1);
  await app.stopPlugin('qq-main');
  delete process.env.IMBREX_ONEBOT_FIXTURE_TOKEN;
  await assert.rejects(app.startPlugin('qq-main'), { code: 'provider_unavailable' });
});


test('runtime allowlists hot-apply, record intercepts and reset to the host config', async (t) => {
  const { app, sim, act, panel, config } = await fixture(t, false, true, true);
  sim.broadcast({ ...numericFixture, message_id: 501, group_id: 111222, message: [{ type: 'text', data: { text: 'outside' } }] });
  await until(async () => ((object(await panel()).intercepts ?? []) as unknown[]).length === 1);
  const before = await panel();
  const first = object((object(before).intercepts as unknown[])[0]!);
  assert.equal(first.conversation, '111222');
  assert.equal(first.kind, 'group');
  assert.equal((await app.info()).latestSeq, 0n);

  const allowed = await act('allow-conversation', { kind: 'group', id: '111222' });
  assert.equal(allowed.status, 200);
  const after = await panel();
  assert.equal(object(after.scope).source, 'runtime');
  assert.ok((object(after.scope).group_ids as unknown[]).includes('111222'));
  sim.broadcast({ ...numericFixture, message_id: 502, group_id: 111222, message: [{ type: 'text', data: { text: 'inside' } }] });
  await until(async () => (await app.info()).latestSeq === 1n);
  const stored = object(JSON.parse(await readFile(join(config.dataDir, 'plugins/qq-main/config.json'), 'utf8')));
  assert.ok((object(stored.runtime_filters).group_ids as unknown[]).includes('111222'));

  const reset = await act('reset-runtime-config', {});
  assert.equal(reset.status, 200);
  const restored = await panel();
  assert.equal(object(restored.scope).source, 'host');
  assert.equal((object(restored.scope).group_ids as unknown[]).includes('111222'), false);

  const saved = await act('save-managed-process', { enabled: false });
  assert.equal(saved.status, 200);
  const managed = object(JSON.parse(await readFile(join(config.dataDir, 'plugins/qq-main/config.json'), 'utf8')));
  assert.equal(object(managed.managed_process).enabled, false);
  assert.equal((await act('save-managed-process', { enabled: true })).status, 400);
});

test('a corrupt private config falls back to the host allowlists without failing the plugin', async (t) => {
  const { app, config, panel } = await fixture(t, false, true, true);
  await app.stopPlugin('qq-main');
  await writeFile(join(config.dataDir, 'plugins/qq-main/config.json'), 'not json', { mode: 0o600 });
  await app.startPlugin('qq-main');
  await until(() => app.plugins().find((plugin) => plugin.id === 'qq-main')?.available === true);
  const data = await panel();
  assert.equal(object(data.runtime_config).error, 'runtime_config_invalid');
  assert.equal(object(data.scope).source, 'host');
});

test('adding a conversation at the runtime allowlist limit preserves readable saved configuration', async (t) => {
  const { app, act, panel, config } = await fixture(t, false, true, true);
  const groups = Array.from({ length: 1024 }, (_, index) => String(100000 + index));
  assert.equal((await act('save-runtime-filters', { group_ids: groups, private_user_ids: [] })).status, 200);
  const path = join(config.dataDir, 'plugins/qq-main/config.json'), before = await readFile(path, 'utf8');
  assert.equal((await act('allow-conversation', { kind: 'group', id: '999999' })).status, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  await app.stopPlugin('qq-main'); await app.startPlugin('qq-main');
  await until(() => app.plugins().find((plugin) => plugin.id === 'qq-main')?.available === true);
  const data = await panel();
  assert.deepEqual(object(data.scope).group_ids, groups);
  assert.equal(object(data.runtime_config).error, null);
});

test('private configuration rejects FIFO and redirected reads while keeping the host usable', async (t) => {
  const { app, panel, config } = await fixture(t, false, true, true);
  const path = join(config.dataDir, 'plugins/qq-main/config.json');
  const external = join(config.dataDir, 'external.json');
  await writeFile(external, JSON.stringify({ version: 1, runtime_filters: { group_ids: [], private_user_ids: [] } }));
  for (const kind of ['fifo', 'link', 'oversize'] as const) {
    await app.stopPlugin('qq-main'); await rm(path, { force: true });
    if (kind === 'fifo') execFileSync('mkfifo', [path]);
    else if (kind === 'link') await symlink(external, path);
    else await writeFile(path, 'x'.repeat(65537));
    const starting = app.startPlugin('qq-main');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([starting.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1000); })]);
      if (!completed && kind === 'fifo') { const writer = await open(path, constants.O_RDWR | constants.O_NONBLOCK); await writer.close(); }
      assert.equal(completed, true, 'invalid private config must not wait for FIFO writers');
    } finally { clearTimeout(timer); }
    await until(() => app.plugins().find((plugin) => plugin.id === 'qq-main')?.available === true);
    const data = await panel();
    assert.equal(object(data.runtime_config).error, 'runtime_config_invalid');
    assert.equal(object(data.scope).source, 'host');
  }
});

test('runtime saves leave a preexisting FIFO temporary path untouched and do not block unload', async (t) => {
  const { app, act, panel, config } = await fixture(t, false, true, true);
  const path = join(config.dataDir, 'plugins/qq-main/config.json.tmp');
  execFileSync('mkfifo', [path]);
  const result = await act('save-runtime-filters', { group_ids: [], private_user_ids: [] });
  assert.equal(result.status, 200); assert.equal(object(result.body.result).status, 'succeeded');
  assert.deepEqual(object((await panel()).scope).group_ids, []);
  await app.stopPlugin('qq-main');
  assert.equal(app.plugins().find((plugin) => plugin.id === 'qq-main')?.state, 'stopped');
});

test('post-rename sync failure suspends ingress and later writes until persisted config is reread', async (t) => {
  const { app, sim, act, panel, config, ready } = await fixture(t, false, true, true);
  const directory = join(config.dataDir, 'plugins/qq-main');
  const originalOpen = fsPromises.open;
  let injected = false;
  fsPromises.open = (async (...args: Parameters<typeof open>) => {
    const file = await originalOpen(...args);
    if (!injected && args[0] === directory && args[1] === 'r') {
      injected = true; file.sync = async () => { throw new Error('fixture directory sync failure'); };
    }
    return file;
  }) as typeof open;
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof act>>;
  try { result = await act('save-runtime-filters', { group_ids: [], private_user_ids: [] }); }
  finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(result.status, 200);
  assert.equal(object(result.body.result).status, 'failed');
  assert.equal(object(result.body.result).inspect_required, true);
  const path = join(directory, 'config.json'), evidence = await readFile(path, 'utf8');
  assert.deepEqual(object(object(JSON.parse(evidence)).runtime_filters).group_ids, []);
  assert.equal(ready(), false);
  assert.equal(object((await panel()).runtime_config).error, 'runtime_config_write_failed');
  assert.equal((await act('save-managed-process', { enabled: false })).status, 503);
  assert.equal(await readFile(path, 'utf8'), evidence);
  sim.broadcast(numericFixture); await delay(50); assert.equal((await app.info()).latestSeq, 0n);
  await app.stopPlugin('qq-main'); await app.startPlugin('qq-main'); await until(ready);
  assert.deepEqual(object((await panel()).scope).group_ids, []);
  assert.equal(object((await panel()).runtime_config).error, null);
});

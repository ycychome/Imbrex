import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import type { PluginApi } from '../../src/host/plugin-api.js';
import { object } from '../../src/core/validation.js';
import { parseConsumerConfig } from '../../src/plugins/agent-chat/config.js';
import { mapMessage, parseOneBotConfig } from '../../src/plugins/onebot-v11/protocol.js';
import { numericFixture, stringFixture } from '../../examples/onebot/fixtures.js';
import { startSimulator } from '../../examples/onebot/simulator.js';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Condition did not become true');
}
async function fixture(t: TestContext, mode = 'normal', enabled = true, turnTimeout = 5000, management = false, managed = false) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-acp-'));
  const fake = join(directory, 'fake'); await mkdir(fake);
  const stateFile = join(directory, 'gateway/plugins/agent/consumer-state.json');
  const values: Record<string, string> = { IMBREX_FAKE_AGENT_DIR: fake, IMBREX_FAKE_STATE_FILE: stateFile, IMBREX_QQ_AGENT_TOKEN: 'fixture-acp-agent-token', IMBREX_OPERATOR_TOKEN: 'fixture-acp-operator-token' };
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  let app: Host | undefined;
  const sim = await startSimulator(0);
  t.after(async () => {
    try { await app?.close(); }
    finally {
      await sim.close();
      for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(directory, { recursive: true, force: true });
    }
  });
  const controlFile = join(fake, 'control.json');
  let control: Record<string, unknown> = { mode };
  const setControl = async (value: Record<string, unknown>) => {
    control = { ...control, ...value };
    await writeFile(controlFile + '.new', JSON.stringify(control)); await rename(controlFile + '.new', controlFile);
  };
  await setControl({});
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/onebot/imbrex.json', import.meta.url), 'utf8')));
  raw.data_dir = join(directory, 'gateway'); raw.external_writes_enabled = true; object(((raw.plugins as unknown[]).map((value) => object(value)).find((plugin) => plugin.module === 'builtin:server-http')!).config).port = 0;
  assert.ok(Array.isArray(raw.plugins)); object(raw.plugins.map((value) => object(value)).find((plugin) => plugin.id === 'qq-main')!.config).ws_url = 'ws://127.0.0.1:' + sim.port + '/';
  assert.ok(Array.isArray(raw.principals));
  raw.principals.push({ id: 'qq-consumer', permissions: ['events:read'], read_sources: [{ prefix: 'imbrex://qq/123456/main/' }], write_sources: [], invoke_capabilities: [] });
  raw.principals.push({ id: 'test-writer', permissions: ['events:read', 'events:write'], read_sources: [{ prefix: 'imbrex://' }], write_sources: [{ prefix: 'imbrex://' }], invoke_capabilities: [] });
  raw.plugins.push({ id: 'agent', module: 'builtin:agent-chat', principal_id: 'qq-consumer', required: true, enabled, config: {
    input_id: 'qq-inbound', source_prefix: 'imbrex://qq/123456/main/', max_event_age_seconds: 300, turn_timeout_ms: turnTimeout,
    agent: { command: process.execPath, args: [fileURLToPath(new URL('../fixtures/acp-agent.js', import.meta.url))], cwd: fake,
      env_vars: ['IMBREX_FAKE_AGENT_DIR', 'IMBREX_FAKE_STATE_FILE', 'IMBREX_QQ_AGENT_TOKEN'] },
  } });
  if (management) {
    raw.principals.push({ id: 'administrator', token_env: 'IMBREX_OPERATOR_TOKEN', permissions: ['admin:inspect', 'admin:operate'], read_sources: [], write_sources: [], invoke_capabilities: [] });
    const operator = raw.principals.map((item) => object(item)).find((item) => item.id === 'operator')!; delete operator.token_env;
    raw.plugins.push({ id: 'admin', module: 'builtin:admin', principal_id: 'protocol', required: true, enabled: true, config: {} });
  }
  if (managed) {
    object(raw.plugins.map((item) => object(item)).find((item) => item.id === 'agent')!.config).managed_pi = { provider: 'fixture', model: 'fixture-a', context_window: 64000, system_prompt: 'Initial fixture prompt.',
      api: 'openai-completions', base_url: 'http://127.0.0.1:1/v1', api_key_env: 'IMBREX_QQ_AGENT_TOKEN', pi_command: process.execPath, mcp_principal_id: 'qq-agent' };
  }
  const filename = join(directory, 'imbrex.json');
  const config = parseConfig(raw, filename, process.env);
  const modules = await loadModules(config, filename);
  let writer!: PluginApi;
  config.plugins.push({ id: 'writer', module: 'test-writer', principalId: 'test-writer', required: true, enabled: true, config: {} });
  modules.set('writer', { name: 'test-writer', apply: (ctx) => { writer = ctx.imbrex.forPlugin(ctx); } });
  app = await Host.open(config, modules);
  const host = () => app!;
  const status = () => host().plugins().find((plugin) => plugin.id === 'agent')!;
  await until(() => host().plugins().find((plugin) => plugin.id === 'qq-main')?.available === true);
  if (enabled) await until(() => status().available);
  await setControl({ mcp_url: 'http://127.0.0.1:' + app.port + '/v1/mcp' });
  const state = async () => object(JSON.parse(await readFile(stateFile, 'utf8')));
  const logs = async (event?: string): Promise<Record<string, unknown>[]> => {
    try {
      const entries = (await readFile(join(fake, 'agent.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => object(JSON.parse(line)));
      return event === undefined ? entries : entries.filter((entry) => entry.event === event);
    } catch { return []; }
  };
  const onebot = parseOneBotConfig(config.plugins.find((plugin) => plugin.id === 'qq-main')!.config);
  const input = (id: number, kind: 'group' | 'private' = 'group', override: Record<string, unknown> = {}) => {
    return mapMessage({ ...(kind === 'group' ? numericFixture : stringFixture), time: Math.floor(Date.now() / 1000), message_id: id, ...override }, onebot)!;
  };
  const append = (id: number, kind: 'group' | 'private' = 'group', override: Record<string, unknown> = {}) => writer.events.append(input(id, kind, override));
  const restart = async () => {
    await app!.close(); app = await Host.open(config, modules);
    await setControl({ mcp_url: 'http://127.0.0.1:' + app.port + '/v1/mcp' });
  };
  const panel = async () => {
    const response = await fetch('http://127.0.0.1:' + host().port + '/api/admin/panels/agent', { headers: { authorization: 'Bearer ' + values.IMBREX_OPERATOR_TOKEN } });
    assert.equal(response.status, 200); return object(await response.json());
  };
  const action = async (id: string, params: unknown, overrides: Record<string, unknown> = {}, token = values.IMBREX_OPERATOR_TOKEN!) => {
    const current = await panel();
    const response = await fetch('http://127.0.0.1:' + host().port + '/api/admin/panels/agent/actions/' + id, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: current.store_id, generation: current.generation, params, ...overrides }),
    });
    return { status: response.status, body: object(await response.json()) };
  };
  return { directory, fake, sim, panel, action, host, config, modules, raw, filename, values, status, state, stateFile, logs, setControl, input, append, writer: () => writer, restart };
}

test('consumer starts at now, filters inputs, saves before prompting and keeps platform sessions separate', async (t) => {
  const f = await fixture(t, 'normal', false);
  await f.append(1);
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.enabled = true;
  await f.host().startPlugin('agent'); await until(() => f.status().available);
  assert.equal((await f.state()).last_seq, '1'); assert.equal((await f.logs('prompt')).length, 0);
  await f.append(2, 'group', { user_id: 123456 });
  await f.append(3, 'group', { time: Math.floor(Date.now() / 1000) - 3600 });
  const derived = f.input(4); derived.parents = [{ source: derived.event.source, id: 'message:1' }]; await f.writer().events.append(derived);
  const diagnostic = f.input(5); diagnostic.event.type = 'fixture.diagnostic'; await f.writer().events.append(diagnostic);
  const different = f.input(6); different.event.source = different.event.source.replace('/main/', '/other/'); await f.writer().events.append(different);
  await f.append(7); await f.append(8, 'private'); await f.append(9);
  await until(async () => (await f.state()).last_seq === '9');
  const prompts = await f.logs('prompt');
  assert.deepEqual(prompts.map((entry) => entry.id), ['message:7', 'message:8', 'message:9']);
  assert.ok(prompts.every((entry) => entry.disk_confirmed === true));
  assert.equal(prompts[0]!.session_id, prompts[2]!.session_id); assert.notEqual(prompts[0]!.session_id, prompts[1]!.session_id);
  assert.equal((await f.state()).in_flight, null);
  assert.equal((await f.logs('boot'))[0]?.operator_token_present, false);
  await f.restart(); await until(() => f.status().available);
  await f.append(10); await until(async () => (await f.state()).last_seq === '10');
  assert.equal((await f.logs('request')).filter((entry) => entry.method === 'session/load').length, 1);
  assert.equal((await f.logs('prompt')).at(-1)?.session_id, prompts[0]!.session_id);
});

test('consumer filter accepts the selected group or private user without mixing the two lists', async (t) => {
  const f = await fixture(t, 'normal', false);
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.config.filter = { group_ids: ['987654'], private_user_ids: ['654321'] };
  await f.host().startPlugin('agent'); await until(() => f.status().available);
  await f.append(101, 'group', { user_id: 222222 });
  await f.append(102, 'private');
  const otherGroup = f.input(103);
  otherGroup.event.source = 'imbrex://qq/123456/main/group/654321';
  object(otherGroup.event.data).conversation_id = '654321';
  await f.writer().events.append(otherGroup);
  const otherPrivate = f.input(104, 'private');
  otherPrivate.event.source = 'imbrex://qq/123456/main/private/987654';
  object(otherPrivate.event.data).conversation_id = '987654';
  object(otherPrivate.event.data).sender_id = '987654';
  await f.writer().events.append(otherPrivate);
  await until(async () => (await f.state()).last_seq === '4');
  assert.deepEqual((await f.logs('prompt')).map((entry) => entry.id), ['message:101', 'message:102']);
  assert.deepEqual(Object.keys(object((await f.state()).sessions)).sort(), [
    'imbrex://qq/123456/main/group/987654', 'imbrex://qq/123456/main/private/654321',
  ]);
  assert.equal((await f.logs('request')).filter((entry) => entry.method === 'session/new').length, 2);
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.enabled = true;
  await f.restart(); await until(() => f.status().available);
  await f.append(105, 'private');
  await until(async () => (await f.state()).last_seq === '5');
  assert.deepEqual((await f.logs('prompt')).map((entry) => entry.id), ['message:101', 'message:102', 'message:105']);
});

test('empty consumer filter advances past group and private events without creating sessions', async (t) => {
  const f = await fixture(t, 'normal', false);
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.config.filter = { group_ids: [], private_user_ids: [] };
  await f.host().startPlugin('agent'); await until(() => f.status().available);
  await f.append(111); await f.append(112, 'private');
  await until(async () => (await f.state()).last_seq === '2');
  assert.deepEqual((await f.state()).sessions, {});
  assert.equal((await f.state()).in_flight, null);
  assert.deepEqual(await f.logs('prompt'), []);
  assert.equal((await f.logs('request')).filter((entry) => entry.method === 'session/new').length, 0);
});

test('consumer filter rejects incomplete or invalid lists instead of silently broadening input', async () => {
  const config = { input_id: 'qq-inbound', source_prefix: 'imbrex://qq/123456/main/', max_event_age_seconds: 300,
    agent: { command: process.execPath, args: [], cwd: tmpdir() } };
  for (const filter of [null, {}, { group_ids: [] }, { group_ids: [], private_user_ids: '654321' },
    { group_ids: [987654], private_user_ids: [] }, { group_ids: [], private_user_ids: ['0654321'] }]) {
    assert.throws(() => parseConsumerConfig({ ...config, filter }));
  }
});

test('filter membership changes pause old state while list order and duplicates preserve the binding', async (t) => {
  const f = await fixture(t, 'normal', false);
  const config = f.config.plugins.find((plugin) => plugin.id === 'agent')!.config;
  config.filter = { group_ids: ['987654', '111111'], private_user_ids: ['654321', '222222'] };
  await f.host().startPlugin('agent'); await until(() => f.status().available);
  await f.append(121); await until(async () => (await f.state()).last_seq === '1');
  config.filter = { group_ids: ['111111', '987654', '987654'], private_user_ids: ['222222', '654321'] };
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.enabled = true;
  await f.restart(); await until(() => f.status().available);
  await f.host().stopPlugin('agent');
  const saved = await f.state();
  const boots = (await f.logs('boot')).length;
  for (const filter of [{ group_ids: ['987654'], private_user_ids: ['222222', '654321'] }, undefined]) {
    if (filter === undefined) delete config.filter; else config.filter = filter;
    await f.host().startPlugin('agent');
    assert.equal(f.status().last_error?.code, 'consumer_binding_changed');
    assert.deepEqual(await f.state(), saved);
    await f.host().stopPlugin('agent');
  }
  const unfiltered = structuredClone(saved); delete object(unfiltered.selection).filter;
  await writeFile(f.stateFile, JSON.stringify(unfiltered));
  config.filter = { group_ids: ['987654'], private_user_ids: ['654321'] };
  await f.host().startPlugin('agent');
  assert.equal(f.status().last_error?.code, 'consumer_binding_changed');
  assert.deepEqual(await f.state(), unfiltered);
  assert.equal((await f.logs('boot')).length, boots);
});

test('uncertain ACP turns keep in_flight and a restart never replays the prompt', async (t) => {
  for (const mode of ['other-stop', 'error', 'oversize', 'exit', 'hold']) await t.test(mode, async (t) => {
    const f = await fixture(t, mode, true, mode === 'hold' ? 1000 : 5000);
    await f.append(11);
    await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
    const saved = await f.state(); assert.equal(saved.last_seq, '0'); assert.equal(object(saved.in_flight).id, 'message:11');
    const before = (await f.logs('prompt')).length;
    await f.append(12); await f.setControl({ mode: 'normal' });
    await f.restart();
    assert.equal(f.status().last_error?.code, 'consumer_in_flight_unconfirmed');
    await delay(40);
    assert.equal((await f.logs('prompt')).length, before); assert.equal((await f.state()).last_seq, '0');
  });
});

test('permission requests are denied without granting filesystem access or losing a completed turn', async (t) => {
  const f = await fixture(t, 'permission');
  await f.append(21); await until(async () => (await f.state()).last_seq === '1');
  assert.deepEqual((await f.logs('permission'))[0]?.outcome, { outcome: 'cancelled' });
  assert.equal((await f.logs('filesystem'))[0]?.code, -32601);
  assert.equal((await f.state()).in_flight, null);
});

test('large valid tool updates forwarded by an Agent do not interrupt a completed turn', async (t) => {
  const f = await fixture(t, 'large-update');
  await f.append(22); await until(async () => (await f.state()).last_seq === '1');
  assert.equal((await f.state()).in_flight, null); assert.equal(f.status().available, true);
});

test('malformed Agent notifications and messages never enter the SDK raw logging paths', async (t) => {
  for (const mode of ['invalid-update', 'invalid-message', 'unknown-response']) await t.test(mode, async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
    const f = await fixture(t, mode);
    await f.append(24);
    if (mode === 'invalid-update') await until(async () => (await f.state()).last_seq === '1');
    else {
      await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
      assert.equal(object((await f.state()).in_flight).id, 'message:24');
    }
    assert.deepEqual(logged, []);
  });
});

test('inputs arriving during a later plugin initialization wait until MCP is listening', async (t) => {
  const f = await fixture(t, 'reply', false);
  f.config.plugins.find((plugin) => plugin.module === 'builtin:server-http')!.config.port = f.host().port;
  await f.host().close();
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.enabled = true;
  f.modules.set('writer', { name: 'slow-writer', apply: async (ctx) => {
    const api = ctx.imbrex.forPlugin(ctx);
    await until(async () => { try { return (await f.state()).agent_info !== null; } catch { return false; } });
    await api.events.append(f.input(25));
    await delay(200);
    assert.equal((await f.logs('prompt')).length, 0);
  } });
  await f.restart();
  await until(async () => (await f.state()).last_seq === '1');
  assert.equal((await f.logs('prompt')).length, 1);
  assert.equal(f.sim.actions.length, 1);
  assert.equal((await f.logs('call'))[0]?.status, 'succeeded');
});

test('session creation failure pauses before in_flight and can continue once the Agent is configured', async (t) => {
  const f = await fixture(t, 'new-fail');
  await f.append(23);
  await until(() => f.status().last_error?.code === 'consumer_session_start_failed');
  assert.equal((await f.state()).in_flight, null); assert.equal((await f.state()).last_seq, '0');
  assert.equal((await f.logs('prompt')).length, 0);
  await f.setControl({ mode: 'normal' }); await f.restart();
  await until(async () => (await f.state()).last_seq === '1');
  assert.equal((await f.logs('prompt')).length, 1);
});

test('a process tree that ignores termination is reaped when the consumer stops', async (t) => {
  const f = await fixture(t, 'tree');
  await f.append(31);
  await until(async () => (await f.logs('descendant')).length === 1);
  await until(async () => { try { await access(join(f.fake, 'descendant.ready')); return true; } catch { return false; } });
  const agentPid = (await f.logs('boot'))[0]!.pid as number;
  const descendantPid = (await f.logs('descendant'))[0]!.pid as number;
  await f.host().stopPlugin('agent');
  assert.throws(() => process.kill(agentPid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  assert.equal(object((await f.state()).in_flight).id, 'message:31');
  assert.equal(f.status().state, 'stopped');
});

test('an Agent that exits immediately after spawning a detached child leaves no orphan', async (t) => {
  const f = await fixture(t, 'orphan');
  await f.append(32);
  await until(async () => (await f.logs('descendant')).length === 1);
  const descendantPid = (await f.logs('descendant'))[0]!.pid as number;
  t.after(() => { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already reaped. */ } });
  await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  await f.host().stopPlugin('agent');
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  assert.equal(object((await f.state()).in_flight).id, 'message:32');
  assert.equal(f.status().state, 'stopped');
});

test('state corruption and changed bindings pause without starting another Agent', async (t) => {
  const f = await fixture(t);
  await f.append(41); await until(async () => (await f.state()).last_seq === '1');
  await f.host().stopPlugin('agent');
  const saved = await f.state();
  const boots = (await f.logs('boot')).length;
  for (const [next, code] of [
    ['{', 'consumer_state_invalid'],
    [JSON.stringify({ ...saved, store_id: 'another-store' }), 'consumer_store_mismatch'],
    [JSON.stringify({ ...saved, last_seq: '99' }), 'consumer_position_ahead'],
    [JSON.stringify({ ...saved, input_id: 'changed' }), 'consumer_binding_changed'],
  ]) {
    await writeFile(f.stateFile, next!);
    await f.host().startPlugin('agent');
    assert.equal(f.status().last_error?.code, code);
    await f.host().stopPlugin('agent');
  }
  await writeFile(f.stateFile, JSON.stringify(saved));
  const scope = f.writer().events.readScope(); scope.sources.splice(0);
  assert.equal(f.writer().events.readScope().sources.length, 1);
  f.config.principals.find((item) => item.id === 'qq-consumer')!.readSources = [{ exact: 'imbrex://qq/123456/main/group/987654' }];
  await f.host().startPlugin('agent');
  assert.equal(f.status().last_error?.code, 'consumer_binding_changed');
  assert.equal((await f.logs('boot')).length, boots);
});

test('restore capability and restore results must succeed before a saved session is prompted', async (t) => {
  for (const mode of ['no-load', 'load-fail']) await t.test(mode, async (t) => {
    const f = await fixture(t);
    await f.append(42); await until(async () => (await f.state()).last_seq === '1');
    await f.setControl({ mode }); await f.restart();
    if (mode === 'load-fail') { await until(() => f.status().available); await f.append(43); }
    await until(() => f.status().last_error?.code === (mode === 'no-load' ? 'consumer_session_restore_unsupported' : 'consumer_session_restore_failed'));
    assert.equal((await f.logs('prompt')).length, 1);
    assert.equal((await f.state()).last_seq, '1');
  });
});

test('persistence failure prevents a new prompt and a failed completion checkpoint retains in_flight', async (t) => {
  const f = await fixture(t);
  await f.append(51); await until(async () => (await f.state()).last_seq === '1');
  await mkdir(f.stateFile + '.tmp');
  await f.append(52);
  await until(() => f.status().last_error?.code === 'consumer_state_write_failed');
  assert.equal((await f.logs('prompt')).length, 1); assert.equal((await f.state()).last_seq, '1');
  assert.equal((await f.state()).in_flight, null);
  await f.host().stopPlugin('agent'); await rm(f.stateFile + '.tmp', { recursive: true });
  await f.setControl({ mode: 'block-checkpoint' });
  await f.host().startPlugin('agent');
  await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  assert.equal((await f.logs('prompt')).length, 2);
  assert.equal(object((await f.state()).in_flight).id, 'message:52');
  await f.host().stopPlugin('agent'); await rm(f.stateFile + '.tmp', { recursive: true });
  await f.setControl({ mode: 'normal' }); await f.host().startPlugin('agent');
  assert.equal(f.status().last_error?.code, 'consumer_in_flight_unconfirmed');
  assert.equal((await f.logs('prompt')).length, 2);
});

test('OneBot ingress automatically drives ACP and MCP reply while unknown and interrupted turns never resend', async (t) => {
  for (const mode of ['reply', 'reply-unknown', 'reply-crash']) await t.test(mode, async (t) => {
    const f = await fixture(t, mode === 'reply-unknown' ? 'reply' : mode);
    if (mode === 'reply-unknown') f.sim.mode = 'async';
    f.sim.broadcast({ ...numericFixture, message_id: 61, time: Math.floor(Date.now() / 1000) });
    await until(async () => (await f.logs('call')).length === 1);
    if (mode === 'reply-crash') await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
    else await until(async () => (await f.state()).last_seq === '1');
    assert.equal(f.sim.actions.length, 1);
    assert.deepEqual(f.sim.actions.map(({ action, params }) => ({ action, params })), [{ action: 'send_group_msg', params: {
      group_id: 987654, message: [{ type: 'reply', data: { id: '61' } }, { type: 'text', data: { text: 'ACP fixture reply' } }],
    } }]);
    const storeId = (await f.host().info()).storeId;
    const response = await fetch('http://127.0.0.1:' + f.host().port + '/v1/calls/acp-fixture:1?store_id=' + storeId, { headers: { authorization: 'Bearer ' + f.values.IMBREX_QQ_AGENT_TOKEN } });
    assert.equal(object(object(await response.json()).call).status, mode === 'reply-unknown' ? 'unknown' : 'succeeded');
    await f.restart();
    if (mode === 'reply-crash') assert.equal(f.status().last_error?.code, 'consumer_in_flight_unconfirmed');
    else await until(() => f.status().available);
    f.sim.broadcast({ ...numericFixture, message_id: 61, time: Math.floor(Date.now() / 1000) });
    await delay(50); assert.equal(f.sim.actions.length, 1); assert.equal((await f.logs('prompt')).length, 1);
  });
});

test('session collisions and the session bound cannot reuse another conversation or grow without limit', async (t) => {
  await t.test('collision', async (t) => {
    const f = await fixture(t, 'collision');
    await f.append(71); await until(async () => (await f.state()).last_seq === '1');
    await f.append(72, 'private');
    await until(() => f.status().last_error?.code === 'consumer_session_collision');
    assert.equal((await f.logs('prompt')).length, 1); assert.equal((await f.state()).last_seq, '1');
  });
  await t.test('bound', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 33; i += 1) {
      const input = f.input(100 + i);
      const id = String(990000 + i);
      input.event.source = 'imbrex://qq/123456/main/group/' + id;
      object(input.event.data).conversation_id = id;
      await f.writer().events.append(input);
    }
    await until(() => f.status().last_error?.code === 'consumer_session_limit');
    assert.equal((await f.logs('prompt')).length, 32);
    assert.equal((await f.state()).last_seq, '32');
    assert.equal(Object.keys(object((await f.state()).sessions)).length, 32);
  });
});

test('killing the public host releases its lock, reaps the Agent tree, and restart keeps the unresolved input paused', async (t) => {
  const f = await fixture(t, 'tree', true, 20000);
  await f.host().close();
  await writeFile(f.filename, JSON.stringify(f.raw));
  const launchers: { child: ChildProcess; ended: Promise<void> }[] = [];
  const startCli = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/cli/start.js', import.meta.url)), '--config', f.filename], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = Promise.withResolvers<Record<string, unknown>>();
    const ended = new Promise<void>((resolve) => child.once('exit', () => { ready.reject(new Error('CLI exited before ready')); resolve(); }));
    launchers.push({ child, ended });
    child.once('error', (error) => ready.reject(error));
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384); });
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => { const value = object(JSON.parse(line)); if (value.event === 'ready') ready.resolve(value); });
    child.once('exit', () => lines.close());
    const value = await ready.promise;
    assert.equal(typeof value.pid, 'number'); assert.equal(typeof value.port, 'number');
    const plugins = async () => {
      const response = await fetch('http://127.0.0.1:' + value.port + '/v1/plugins', { headers: { authorization: 'Bearer ' + f.values.IMBREX_OPERATOR_TOKEN } });
      const body = object(await response.json()); assert.ok(Array.isArray(body.plugins));
      return body.plugins.map((entry) => object(entry));
    };
    return { child, value, ended, plugins, stderr: () => stderr };
  };
  t.after(async () => {
    for (const { child, ended } of launchers) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([ended, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await ended;
    }
  });
  const first = await startCli();
  await until(async () => (await first.plugins()).every((plugin) => plugin.available === true));
  f.sim.broadcast({ ...numericFixture, message_id: 81, time: Math.floor(Date.now() / 1000) });
  await until(async () => { try { await access(join(f.fake, 'descendant.ready')); return true; } catch { return false; } });
  const boot = (await f.logs('boot')).at(-1)!;
  const agentPid = boot.pid as number, supervisorPid = boot.parent as number;
  const supervisorStat = await readFile('/proc/' + supervisorPid + '/stat', 'utf8');
  const reaperPid = Number(supervisorStat.slice(supervisorStat.lastIndexOf(')') + 2).split(' ')[1]);
  const descendantPid = (await f.logs('descendant')).at(-1)!.pid as number;
  const links = async (pid: number) => {
    const results = await Promise.allSettled((await readdir('/proc/' + pid + '/fd')).map((fd) => readlink('/proc/' + pid + '/fd/' + fd)));
    return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  };
  const lock = join(f.config.dataDir, '.lock');
  assert.ok((await links(first.value.pid as number)).includes(lock));
  for (const pid of [agentPid, supervisorPid, reaperPid, descendantPid]) assert.ok(!(await links(pid)).includes(lock));
  process.kill(first.value.pid as number, 'SIGKILL'); await first.ended;
  const second = await startCli();
  await until(async () => (await second.plugins()).some((plugin) => plugin.id === 'agent' && object(plugin.last_error).code === 'consumer_in_flight_unconfirmed'));
  await until(() => [agentPid, supervisorPid, reaperPid, descendantPid].every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }));
  assert.equal(object((await f.state()).in_flight).id, 'message:81');
  assert.equal((await f.state()).last_seq, '0'); assert.equal((await f.logs('prompt')).length, 1);
  assert.ok(!first.stderr().includes('fixture-private-agent-error'));
  second.child.kill('SIGTERM'); await second.ended;
});

test('offline recovery preserves an unknown call and resumes with only a new input and session', async (t) => {
  const f = await fixture(t, 'reply-crash');
  f.sim.mode = 'async';
  f.sim.broadcast({ ...numericFixture, message_id: 82, time: Math.floor(Date.now() / 1000) });
  await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  assert.equal((await f.logs('call'))[0]?.status, 'unknown');
  const saved = await f.state();
  const oldSession = (await f.logs('prompt'))[0]!.session_id;
  await f.host().close();
  const recovery = spawn(process.execPath, [fileURLToPath(new URL('../../src/cli/recover.js', import.meta.url)),
    '--data-dir', f.config.dataDir, '--instance', 'agent', '--store-id', String(saved.store_id),
    '--seq', String(object(saved.in_flight).seq), '--action', 'abandoned', '--new-session', '--reason', 'fixture: preserve unknown and abandon input',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  recovery.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  recovery.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { recovery.once('error', reject); recovery.once('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(object(JSON.parse(stdout)).last_seq, '1');
  assert.equal((await f.state()).in_flight, null);
  await f.setControl({ mode: 'reply' }); f.sim.mode = 'ok';
  await f.restart(); await until(() => f.status().available);
  const response = await fetch('http://127.0.0.1:' + f.host().port + '/v1/calls/acp-fixture:1?store_id=' + saved.store_id,
    { headers: { authorization: 'Bearer ' + f.values.IMBREX_QQ_AGENT_TOKEN } });
  assert.equal(object(object(await response.json()).call).status, 'unknown');
  f.sim.broadcast({ ...numericFixture, message_id: 82, time: Math.floor(Date.now() / 1000) });
  await delay(50);
  assert.equal(f.sim.actions.length, 1); assert.equal((await f.logs('prompt')).length, 1);
  f.sim.broadcast({ ...numericFixture, message_id: 83, time: Math.floor(Date.now() / 1000) });
  await until(async () => (await f.logs('call')).length === 2);
  const accepted = await f.writer().events.lookup({ source: f.input(83).event.source, id: 'message:83' });
  await until(async () => (await f.state()).last_seq === accepted.seq.toString());
  assert.ok(accepted.seq > BigInt(String(saved.last_seq)));
  assert.equal(f.sim.actions.length, 2); assert.equal((await f.logs('prompt')).length, 2);
  assert.notEqual((await f.logs('prompt'))[1]!.session_id, oldSession);
  assert.equal((await f.logs('call'))[1]?.status, 'succeeded');
});

test('HTTP listening alone never permits delivery and unloading MCP stops the dependent Consumer', async (t) => {
  const f = await fixture(t);
  await f.append(131); await until(async () => (await f.state()).last_seq === '1');
  await f.host().close();
  const original = f.modules.get('mcp')!;
  let checked = false;
  f.modules.set('mcp', { ...original, apply: async (ctx, config) => {
    // server-http is already listening, but the MCP route/service does not exist yet.
    const response = await fetch(ctx.http.origin + '/v1/mcp', { headers: { authorization: 'Bearer ' + f.values.IMBREX_QQ_AGENT_TOKEN } });
    assert.equal(response.status, 404); await response.text();
    await delay(50);
    assert.equal((await f.logs('prompt')).length, 1);
    checked = true;
    return original.apply(ctx, config);
  } });
  await f.restart(); await until(() => f.status().available);
  assert.equal(checked, true);
  await f.host().stopPlugin('mcp');
  assert.equal(f.status().state, 'waiting');
  await f.append(132); await delay(50);
  assert.equal((await f.logs('prompt')).length, 1);
  f.modules.set('mcp', original);
  await f.host().startPlugin('mcp'); await until(() => f.status().available);
  await until(async () => (await f.state()).last_seq === '2');
  assert.equal((await f.logs('prompt')).length, 2);
});

test('Admin observes OneBot and distinguishes idle, active input and unresolved input without exposing Agent credentials', async (t) => {
  const f = await fixture(t, 'normal', true, 1500);
  f.config.principals.find((principal) => principal.id === 'operator')!.permissions.push('admin:inspect');
  const admin = { id: 'admin', module: 'builtin:admin', principalId: 'qq-consumer', required: true, enabled: true, config: {} };
  const loaded = await loadModules({ ...f.config, plugins: [admin] }, f.filename);
  f.config.plugins.push(admin); f.modules.set('admin', loaded.get('admin'));
  await f.restart(); await until(() => f.status().available);
  const read = async (instance: string) => {
    const response = await fetch('http://127.0.0.1:' + f.host().port + '/api/admin/panels/' + instance, { headers: { authorization: 'Bearer ' + f.values.IMBREX_OPERATOR_TOKEN } });
    assert.equal(response.status, 200); return object(object(await response.json()).data);
  };
  assert.equal((await read('agent')).status, 'idle');
  const onebot = await read('qq-main'); assert.equal(onebot.account_verified, true);
  assert.equal(object(onebot.connection_metrics).heartbeat_rtt_ms, null);
  await f.append(141); await until(async () => (await f.state()).last_seq === '1');
  const completed = await read('agent'); assert.equal(completed.status, 'idle'); assert.equal(completed.in_flight, null);
  assert.equal(f.sim.actions.length, 0);
  await f.setControl({ mode: 'hold' }); await f.append(142);
  await until(async () => (await f.logs('prompt')).length === 2);
  const processing = await read('agent'); assert.equal(processing.status, 'processing');
  assert.equal(object(processing.in_flight).id, 'message:142'); assert.equal(typeof processing.elapsed_ms, 'number');
  await f.host().stopPlugin('admin'); await f.host().startPlugin('admin');
  assert.equal((await f.logs('prompt')).length, 2);
  await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  const suspended = await read('agent'); assert.equal(suspended.status, 'suspended_in_flight'); assert.equal(suspended.last_seq, '1');
  assert.ok(!JSON.stringify(suspended).includes(f.values.IMBREX_QQ_AGENT_TOKEN!));
  const evidence = await readFile(f.stateFile, 'utf8');
  delete process.env.IMBREX_FAKE_AGENT_DIR;
  await f.restart();
  const missingEnvironment = await read('agent');
  assert.equal(missingEnvironment.last_error, 'consumer_agent_env_missing');
  assert.equal(missingEnvironment.state_status, 'loaded');
  assert.equal(missingEnvironment.status, 'suspended_in_flight');
  assert.deepEqual(missingEnvironment.in_flight, suspended.in_flight);
  assert.equal(await readFile(f.stateFile, 'utf8'), evidence);
  process.env.IMBREX_FAKE_AGENT_DIR = f.values.IMBREX_FAKE_AGENT_DIR;
  f.config.plugins.find((plugin) => plugin.id === 'agent')!.config.filter = { group_ids: [], private_user_ids: [] };
  await f.restart();
  const changedBinding = await read('agent');
  assert.equal(changedBinding.last_error, 'consumer_binding_changed');
  assert.deepEqual(changedBinding.in_flight, suspended.in_flight);
  assert.deepEqual(changedBinding.sessions, suspended.sessions);
  assert.equal((await f.logs('prompt')).length, 2);
  await f.host().close(); await writeFile(f.stateFile, 'invalid fixture state');
  await f.restart();
  const unreadable = await read('agent');
  assert.equal(unreadable.state_status, 'unavailable');
  assert.equal(Object.hasOwn(unreadable, 'in_flight'), false);
  assert.equal(Object.hasOwn(unreadable, 'sessions'), false);
});

test('management applies a saved filter after the current checkpoint, including prefetched records, without replaying skipped history', async (t) => {
  const f = await fixture(t, 'normal', true, 5000, true);
  await f.append(201); await until(async () => (await f.state()).last_seq === '1');
  const state = await f.state();
  const sessionId = object(state.sessions)['imbrex://qq/123456/main/group/987654'];
  await f.host().stopPlugin('agent');
  await f.setControl({ mode: 'wait-release', release: false });
  await f.append(202); await f.append(203); await f.append(204, 'private');
  await f.host().startPlugin('agent');
  await until(async () => (await f.logs('prompt')).length === 2);
  const revision = object(object((await f.panel()).data).management).revision;
  const saved = await f.action('save-filter', { revision, filter: { group_ids: [], private_user_ids: ['654321'] } });
  assert.equal(saved.status, 200); assert.equal(object(saved.body.result).application_status, 'pending');
  const pending = object((await f.state()).management);
  assert.equal(object(pending.filter).applied, null); assert.equal(object((await f.state()).in_flight).id, 'message:202');
  assert.equal((await f.action('save-filter', { revision, filter: { group_ids: [], private_user_ids: [] } })).status, 409);
  await f.setControl({ release: true });
  await until(async () => (await f.state()).last_seq === '4');
  assert.deepEqual((await f.logs('prompt')).map((entry) => entry.id), ['message:201', 'message:202', 'message:204']);
  assert.equal(object((await f.state()).sessions)['imbrex://qq/123456/main/group/987654'], sessionId);
  await f.restart(); await until(() => f.status().available);
  assert.deepEqual(object((await f.state()).selection).filter, { group_ids: [], private_user_ids: ['654321'] });
  await f.append(205); await until(async () => (await f.state()).last_seq === '5');
  assert.equal((await f.logs('prompt')).length, 3);
  const current = object(object((await f.panel()).data).management).revision;
  await f.action('save-filter', { revision: current, filter: { group_ids: ['987654'], private_user_ids: ['654321'] } });
  await f.append(206); await until(async () => (await f.state()).last_seq === '6');
  assert.deepEqual((await f.logs('prompt')).map((entry) => entry.id), ['message:201', 'message:202', 'message:204', 'message:206']);
});

test('online recovery verifies the exact unresolved event, backs up first, and preserves unknown calls without restarting the Host', async (t) => {
  const f = await fixture(t, 'reply-crash', true, 5000, true);
  f.sim.mode = 'async';
  await f.append(211); await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  const before = await f.state(), pending = object(before.in_flight);
  const port = f.host().port, source = String(pending.source);
  const oldPanel = await f.panel();
  const params = { source, id: pending.id, seq: pending.seq, disposition: 'processed', reason: 'fixture independent platform verification' };
  assert.equal((await f.action('recover-input', { ...params, id: 'message:999' })).status, 409);
  assert.equal((await f.action('recover-input', params, { store_id: 'wrong' })).status, 409);
  assert.equal((await f.action('recover-input', params, { generation: 'old' })).status, 409);
  assert.equal((await f.action('recover-input', params, {}, f.values.IMBREX_QQ_AGENT_TOKEN)).status, 403);
  await f.setControl({ mode: 'normal' });
  const result = await f.action('recover-input', params);
  assert.equal(result.status, 200); assert.equal(object(result.body.result).status, 'succeeded');
  const backup = object(JSON.parse(await readFile(join(f.config.dataDir, 'plugins/agent/recovery', String(object(result.body.result).operation_id) + '.json'), 'utf8')));
  assert.deepEqual(backup.before, before); assert.equal(backup.action, 'processed'); assert.equal(backup.reason, params.reason);
  assert.equal((await f.state()).in_flight, null); assert.equal((await f.state()).last_seq, pending.seq);
  assert.equal(f.host().port, port); assert.equal((await f.panel()).generation, oldPanel.generation);
  const query = await fetch('http://127.0.0.1:' + port + '/api/admin/calls?store_id=' + before.store_id, { headers: { authorization: 'Bearer ' + f.values.IMBREX_OPERATOR_TOKEN } });
  const calls = object(await query.json()).calls; assert.ok(Array.isArray(calls)); assert.equal(object(calls[0]).status, 'unknown');
  assert.equal((await f.action('recover-input', params)).status, 409);
  await f.append(212); await until(async () => (await f.state()).last_seq === '2');
  assert.equal(f.sim.actions.length, 1); assert.deepEqual((await f.logs('prompt')).map((entry) => entry.id), ['message:211', 'message:212']);
});

test('failed backup preserves unresolved input and reset-session only unlinks the selected inactive conversation', async (t) => {
  const f = await fixture(t, 'normal', true, 5000, true);
  await f.append(221); await f.append(222, 'private'); await until(async () => (await f.state()).last_seq === '2');
  const saved = await f.state(), groupSource = 'imbrex://qq/123456/main/group/987654', privateSource = 'imbrex://qq/123456/main/private/654321';
  const group = object(saved.sessions)[groupSource], privateSession = object(saved.sessions)[privateSource];
  const boots = (await f.logs('boot')).length;
  await f.setControl({ mode: 'wait-release', release: false }); await f.append(223); await until(async () => (await f.logs('prompt')).length === 3);
  assert.equal((await f.action('reset-session', { source: groupSource, session_id: group, reason: 'fixture' })).status, 409);
  const reset = await f.action('reset-session', { source: privateSource, session_id: privateSession, reason: 'fixture reset only private association' });
  assert.equal(object(reset.body.result).status, 'succeeded');
  assert.equal(object((await f.state()).sessions)[groupSource], group); assert.equal(object((await f.state()).sessions)[privateSource], undefined);
  assert.equal(object((await f.state()).in_flight).id, 'message:223'); assert.equal((await f.logs('boot')).length, boots);
  assert.equal((await f.action('reset-session', { source: privateSource, session_id: privateSession, reason: 'fixture duplicate' })).status, 409);
  await f.setControl({ release: true }); await until(async () => (await f.state()).last_seq === '3');
  await f.setControl({ mode: 'error' }); await f.append(224); await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  const unresolved = await f.state();
  const auditDir = join(f.config.dataDir, 'plugins/agent/recovery');
  await rename(auditDir, auditDir + '-saved'); await writeFile(auditDir, 'fixture blocks backup directory');
  const flight = object(unresolved.in_flight);
  const failed = await f.action('recover-input', { source: flight.source, id: flight.id, seq: flight.seq, disposition: 'abandoned', reason: 'fixture failure' });
  assert.equal(object(failed.body.result).status, 'failed'); assert.deepEqual(await f.state(), unresolved);
  assert.equal(f.status().available, false);
  await rm(auditDir); await rename(auditDir + '-saved', auditDir);
});

test('managed configuration saves without changing the active round, then restarts only the Agent and applies settings to restored sessions', async (t) => {
  const f = await fixture(t, 'normal', true, 5000, true, true);
  await f.append(231); await until(async () => (await f.state()).last_seq === '1');
  const before = await f.state(), first = (await f.logs('configured-prompt'))[0]!;
  const port = f.host().port, sockets = [...f.sim.server.clients];
  assert.equal(first.model, 'fixture/fixture-a');
  assert.ok(String(first.home).startsWith(join(f.config.dataDir, 'plugins/agent/agent')));
  await f.setControl({ mode: 'wait-release', release: false }); await f.append(232); await until(async () => (await f.logs('prompt')).length === 2);
  const revision = object(object((await f.panel()).data).management).revision;
  const nextPrompt = 'Updated fixture prompt.' + ' '.repeat(32768 - 23);
  const saved = await f.action('save-agent-config', { revision, settings: { model: 'fixture-b', context_window: 500000, system_prompt: nextPrompt } });
  assert.equal(object(saved.body.result).application_status, 'pending_restart');
  assert.equal(object(object(object((await f.panel()).data).management).pi).saved !== undefined, true);
  const nextRevision = object(saved.body.result).revision;
  assert.equal((await f.action('restart-agent', { revision: nextRevision, reason: 'fixture blocked while active' })).status, 409);
  assert.equal((await f.logs('configured-prompt'))[1]?.model, 'fixture/fixture-a');
  await f.setControl({ release: true, mode: 'normal' }); await until(async () => (await f.state()).last_seq === '2');
  const restarted = await f.action('restart-agent', { revision: nextRevision, reason: 'fixture apply' });
  assert.equal(object(restarted.body.result).status, 'succeeded');
  const appliedView = object(object(object((await f.panel()).data).management).pi);
  assert.equal(object(appliedView.applied).system_prompt, nextPrompt);
  assert.equal(f.host().port, port); assert.deepEqual([...f.sim.server.clients], sockets);
  assert.deepEqual((await f.state()).sessions, before.sessions);
  await f.append(233); await until(async () => (await f.state()).last_seq === '3');
  const actual = (await f.logs('configured-prompt')).at(-1)!;
  assert.equal(actual.model, 'fixture/fixture-b'); assert.equal(actual.prompt, nextPrompt);
  assert.equal(actual.session_id, first.session_id);
  assert.equal(object(object(object((await f.state()).management).pi).applied).context_window, 500000);
  await f.restart(); await until(() => f.status().available);
  await f.append(234); await until(async () => (await f.state()).last_seq === '4');
  assert.equal((await f.logs('configured-prompt')).at(-1)?.model, 'fixture/fixture-b');
});

test('failed managed restart keeps session evidence and a pending application marker until explicit correction', async (t) => {
  const f = await fixture(t, 'normal', true, 5000, true, true);
  await f.append(241); await until(async () => (await f.state()).last_seq === '1');
  const before = await f.state();
  const revision = object(object((await f.panel()).data).management).revision;
  const saved = await f.action('save-agent-config', { revision, settings: { model: 'fixture-b', context_window: 100000, system_prompt: 'Fixture pending prompt.' } });
  await f.setControl({ mode: 'load-fail' });
  const failed = await f.action('restart-agent', { revision: object(saved.body.result).revision, reason: 'fixture expected load failure' });
  assert.equal(object(failed.body.result).status, 'failed');
  assert.deepEqual((await f.state()).sessions, before.sessions); assert.equal((await f.state()).last_seq, '1');
  assert.equal(object(object((await f.state()).management).pi).applying, true);
  await f.restart(); assert.equal(f.status().available, false);
  await until(() => f.status().last_error?.code === 'consumer_config_apply_unconfirmed');
  const sessions = object(before.sessions), source = Object.keys(sessions)[0]!;
  const reset = await f.action('reset-session', { source, session_id: sessions[source], reason: 'fixture explicit reset after unsupported restoration' });
  assert.equal(object(reset.body.result).status, 'succeeded');
  await f.setControl({ mode: 'normal' });
  const applied = await f.action('restart-agent', { revision: object(saved.body.result).revision, reason: 'fixture retry after reset' });
  assert.equal(object(applied.body.result).status, 'succeeded');
  await f.append(242); await until(async () => (await f.state()).last_seq === '2');
  assert.equal((await f.logs('prompt')).length, 2);
});

test('saved configuration stays pending during unresolved input and failed persistence never claims application', async (t) => {
  const f = await fixture(t, 'error', true, 5000, true);
  await f.append(251); await until(() => f.status().last_error?.code === 'consumer_in_flight_unconfirmed');
  const unresolved = await f.state(), before = await f.panel();
  const saved = await f.action('save-filter', { revision: object(object(before.data).management).revision, filter: { group_ids: [], private_user_ids: [] } });
  assert.equal(object(saved.body.result).status, 'succeeded');
  const pending = await f.state();
  assert.deepEqual(pending.in_flight, unresolved.in_flight); assert.equal(pending.last_seq, '0');
  assert.equal(object(object(pending.management).filter).applied, null);
  await f.append(252); await delay(40); assert.equal((await f.logs('prompt')).length, 1);
  await mkdir(f.stateFile + '.tmp');
  const failed = await f.action('save-filter', { revision: object(pending.management).revision, filter: { group_ids: ['987654'], private_user_ids: [] } });
  assert.equal(object(failed.body.result).status, 'failed'); assert.equal(object(failed.body.result).resumed, false);
  assert.deepEqual(await f.state(), pending); assert.equal((await f.logs('prompt')).length, 1);
  await rm(f.stateFile + '.tmp', { recursive: true });
});

test('a partial managed file update remains explicitly unresolved across process restart', async (t) => {
  const f = await fixture(t, 'normal', true, 5000, true, true);
  await f.append(261); await until(async () => (await f.state()).last_seq === '1');
  const before = await f.state(), view = object((await f.panel()).data);
  const saved = await f.action('save-agent-config', { revision: object(view.management).revision, settings: { model: 'fixture-b', context_window: 100000, system_prompt: 'Pending fixture.' } });
  const promptPath = join(f.config.dataDir, 'plugins/agent/agent/config/SYSTEM.md');
  await rename(promptPath, promptPath + '.saved'); await mkdir(promptPath);
  const failed = await f.action('restart-agent', { revision: object(saved.body.result).revision, reason: 'fixture interrupted file application' });
  assert.equal(object(failed.body.result).status, 'failed'); assert.equal(object(object(failed.body.result).reason).code, 'consumer_managed_config_failed');
  assert.equal(object(object((await f.state()).management).pi).applying, true);
  assert.deepEqual((await f.state()).sessions, before.sessions); assert.equal((await f.state()).last_seq, '1');
  await f.restart(); await until(() => f.status().last_error?.code === 'consumer_config_apply_unconfirmed');
  assert.equal((await f.logs('prompt')).length, 1);
  await rm(promptPath, { recursive: true }); await rename(promptPath + '.saved', promptPath);
  const applied = await f.action('restart-agent', { revision: object(saved.body.result).revision, reason: 'fixture explicit corrected retry' });
  assert.equal(object(applied.body.result).status, 'succeeded');
  assert.equal(object(object((await f.state()).management).pi).applying, false);
});

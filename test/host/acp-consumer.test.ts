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
import { mapMessage, parseOneBotConfig } from '../../src/plugins/onebot-v11/protocol.js';
import { numericFixture, stringFixture } from '../../examples/onebot/fixtures.js';
import { startSimulator } from '../../examples/onebot/simulator.js';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Condition did not become true');
}
async function fixture(t: TestContext, mode = 'normal', enabled = true, turnTimeout = 5000) {
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
  raw.data_dir = join(directory, 'gateway'); raw.external_writes_enabled = true; object(raw.http).port = 0;
  assert.ok(Array.isArray(raw.plugins)); object(object(raw.plugins[0]).config).ws_url = 'ws://127.0.0.1:' + sim.port + '/';
  assert.ok(Array.isArray(raw.principals));
  raw.principals.push({ id: 'qq-consumer', permissions: ['events:read'], read_sources: [{ prefix: 'imbrex://qq/123456/main/' }], write_sources: [], invoke_capabilities: [] });
  raw.principals.push({ id: 'test-writer', permissions: ['events:read', 'events:write'], read_sources: [{ prefix: 'imbrex://' }], write_sources: [{ prefix: 'imbrex://' }], invoke_capabilities: [] });
  raw.plugins.push({ id: 'agent', module: 'builtin:acp-consumer', principal_id: 'qq-consumer', required: true, enabled, config: {
    input_id: 'qq-inbound', source_prefix: 'imbrex://qq/123456/main/', max_event_age_seconds: 300, turn_timeout_ms: turnTimeout,
    agent: { command: process.execPath, args: [fileURLToPath(new URL('../fixtures/acp-agent.js', import.meta.url))], cwd: fake,
      env_vars: ['IMBREX_FAKE_AGENT_DIR', 'IMBREX_FAKE_STATE_FILE', 'IMBREX_QQ_AGENT_TOKEN'] },
  } });
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
  const onebot = parseOneBotConfig(config.plugins[0]!.config);
  const input = (id: number, kind: 'group' | 'private' = 'group', override: Record<string, unknown> = {}) => {
    return mapMessage({ ...(kind === 'group' ? numericFixture : stringFixture), time: Math.floor(Date.now() / 1000), message_id: id, ...override }, onebot)!;
  };
  const append = (id: number, kind: 'group' | 'private' = 'group', override: Record<string, unknown> = {}) => writer.events.append(input(id, kind, override));
  const restart = async () => {
    await app!.close(); app = await Host.open(config, modules);
    await setControl({ mcp_url: 'http://127.0.0.1:' + app.port + '/v1/mcp' });
  };
  return { directory, fake, sim, host, config, modules, raw, filename, values, status, state, stateFile, logs, setControl, input, append, writer: () => writer, restart };
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
  f.config.http.port = f.host().port;
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

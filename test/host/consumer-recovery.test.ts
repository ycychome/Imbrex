import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { object } from '../../src/core/validation.js';
import { Database } from '../../src/storage/database.js';
import { parseConsumerConfig } from '../../src/plugins/acp-consumer/config.js';
import { bindingFor, type ConsumerState } from '../../src/plugins/acp-consumer/state.js';
import { mapMessage, parseOneBotConfig } from '../../src/plugins/onebot-v11/protocol.js';
import { numericFixture } from '../../examples/onebot/fixtures.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const group = 'imbrex://qq/123456/main/group/987654';
const privateSource = 'imbrex://qq/123456/main/private/222222';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginDir = join(directory, 'plugins/agent'); await mkdir(pluginDir, { recursive: true });
  const path = join(pluginDir, 'consumer-state.json');
  const dbPath = join(directory, 'gateway.db');
  const db = new Database(dbPath);
  const storeId = db.storeId;
  const example = object(JSON.parse(await readFile(new URL('../../../examples/onebot/imbrex.json', import.meta.url), 'utf8')));
  assert.ok(Array.isArray(example.plugins));
  const onebot = parseOneBotConfig(object(example.plugins[0]).config);
  for (const id of [101, 102, 103]) {
    const event = mapMessage({ ...numericFixture, message_id: id, time: Math.floor(Date.now() / 1000) }, onebot)!;
    if (id === 102) event.event.source = 'imbrex://fixture/unselected';
    db.append(storeId, event);
  }
  db.createCall(storeId, { callerId: 'qq-agent', callId: 'existing-call', capabilityId: 'qq-main.reply', schemaVersion: '1', params: {} });
  db.close();
  const binding = bindingFor(parseConsumerConfig({ input_id: 'qq-inbound', source_prefix: 'imbrex://qq/123456/main/',
    max_event_age_seconds: 300, agent: { command: process.execPath, args: [], cwd: directory } }),
  { principalId: 'qq-consumer', sources: [{ prefix: 'imbrex://qq/123456/main/' }] });
  const state: ConsumerState = { ...binding, version: 1, store_id: storeId, last_seq: '1',
    agent_info: { name: 'fixture-acp', version: '1' }, sessions: { [group]: 'group-session', [privateSource]: 'private-session' },
    in_flight: { source: group, id: 'message:103', seq: '3', conversation: group, session_id: 'group-session' } };
  const save = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await save(state);
  const run = async (overrides: Record<string, string> = {}, newSession = false) => {
    const options = { 'data-dir': directory, instance: 'agent', 'store-id': storeId, seq: '3', action: 'processed', reason: 'fixture operator checked original call', ...overrides };
    const args = Object.entries(options).flatMap(([key, value]) => ['--' + key, value]);
    if (newSession) args.push('--new-session');
    const child = spawn('npm', ['--silent', 'run', 'consumer:recover', '--', ...args], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  };
  const read = async () => object(JSON.parse(await readFile(path, 'utf8')));
  const calls = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT * FROM calls ORDER BY caller_id,call_id').all(); } finally { db.close(); }
  };
  return { directory, pluginDir, path, state, run, read, save, calls };
}

test('the documented npm entry keeps the reason private while backing up and resolving only the pending input', async (t) => {
  const f = await fixture(t);
  const beforeCalls = f.calls();
  assert.equal(beforeCalls[0]!.status, 'in_progress');
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const output = object(JSON.parse(result.stdout));
  assert.equal(output.last_seq, '3');
  const saved = await f.read();
  assert.equal(saved.last_seq, '3'); assert.equal(saved.in_flight, null);
  assert.deepEqual(saved.sessions, f.state.sessions);
  assert.deepEqual(f.calls(), beforeCalls);
  assert.equal(typeof output.backup, 'string');
  const backupPath = join(f.directory, output.backup as string);
  const backup = object(JSON.parse(await readFile(backupPath, 'utf8')));
  assert.deepEqual(backup.before, f.state);
  assert.equal(backup.reason, 'fixture operator checked original call');
  assert.equal(backup.action, 'processed');
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.pluginDir, 'recovery'))).mode & 0o777, 0o700);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes(backup.reason as string));
  assert.ok(!result.stderr.includes(backup.reason as string));
  assert.equal((await f.run()).code, 1);
});

test('offline recovery preserves the consumer filter binding', async (t) => {
  const f = await fixture(t);
  f.state.selection.filter = { group_ids: ['987654'], private_user_ids: ['222222'] };
  await f.save(f.state);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const saved = await f.read();
  assert.equal(saved.last_seq, '3'); assert.equal(saved.in_flight, null);
  assert.deepEqual(saved.selection, f.state.selection);
  const output = object(JSON.parse(result.stdout));
  const backup = object(JSON.parse(await readFile(join(f.directory, output.backup as string), 'utf8')));
  assert.deepEqual(object(backup.before).selection, f.state.selection);
});

test('abandonment with a new session removes only the pending conversation mapping', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ action: 'abandoned' }, true);
  assert.equal(result.code, 0, result.stderr);
  const saved = await f.read();
  assert.equal(saved.last_seq, '3'); assert.equal(saved.in_flight, null);
  assert.deepEqual(saved.sessions, { [privateSource]: 'private-session' });
  assert.deepEqual(saved.agent_info, f.state.agent_info);
});

test('wrong store, position, event association and ambiguous arguments refuse changes', async (t) => {
  const f = await fixture(t);
  const invalid: Record<string, string>[] = [{ 'store-id': 'another-store' }, { seq: '2' }, { seq: '03' }, { reason: '   ' }, { instance: '../agent' }];
  for (const options of invalid) {
    assert.equal((await f.run(options)).code, 1);
    assert.deepEqual(await f.read(), f.state);
  }
  const changed = structuredClone(f.state); changed.in_flight!.id = 'message:101';
  await f.save(changed);
  const result = await f.run();
  assert.equal(result.code, 1); assert.ok(result.stderr.includes('recovery_event_mismatch'));
  assert.deepEqual(await f.read(), changed);
  await assert.rejects(readdir(join(f.pluginDir, 'recovery')), { code: 'ENOENT' });
});

test('session reset refuses pending input and preserves the exact saved position', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run({ action: 'reset-sessions', seq: '1' })).code, 1);
  const saved = { ...f.state, in_flight: null }; await f.save(saved);
  assert.equal((await f.run({ action: 'reset-sessions', seq: '2' })).code, 1);
  assert.deepEqual(await f.read(), saved);
  const result = await f.run({ action: 'reset-sessions', seq: '1' });
  assert.equal(result.code, 0, result.stderr);
  const reset = await f.read();
  assert.equal(reset.last_seq, '1'); assert.equal(reset.in_flight, null);
  assert.deepEqual(reset.sessions, {}); assert.equal(reset.agent_info, null);
});

test('a held instance lock refuses recovery before changing the state or writing a backup', async (t) => {
  const f = await fixture(t);
  const lock = spawn('flock', ['--no-fork', join(f.directory, '.lock'), process.execPath, '-e', 'process.stdout.write("locked"); process.stdin.resume();'], { stdio: 'pipe' });
  const closed = new Promise<void>((resolve) => lock.once('close', () => resolve()));
  lock.stderr.resume();
  t.after(async () => { lock.kill('SIGTERM'); await closed; });
  await new Promise<void>((resolve, reject) => { lock.stdout.once('data', () => resolve()); lock.once('error', reject); lock.once('exit', () => reject(new Error('lock exited'))); });
  assert.equal((await f.run()).code, 75);
  assert.deepEqual(await f.read(), f.state);
  await assert.rejects(readdir(join(f.pluginDir, 'recovery')), { code: 'ENOENT' });
});

test('backup failure and redirected state paths cannot modify the checkpoint', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.pluginDir, 'recovery'), 'not a directory');
  assert.equal((await f.run()).code, 1);
  assert.deepEqual(await f.read(), f.state);
  await rm(join(f.pluginDir, 'recovery'));
  const alternate = join(f.directory, 'alternate.json');
  await writeFile(alternate, JSON.stringify(f.state));
  await rm(f.path); await symlink(alternate, f.path);
  assert.equal((await f.run()).code, 1);
  assert.deepEqual(object(JSON.parse(await readFile(alternate, 'utf8'))), f.state);
  await assert.rejects(readdir(join(f.pluginDir, 'recovery')), { code: 'ENOENT' });
});

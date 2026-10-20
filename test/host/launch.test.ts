import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { object } from '../../src/core/validation.js';

const entry = fileURLToPath(new URL('../../src/cli/start.js', import.meta.url));
const environment = { ...process.env, IMBREX_DEMO_AGENT_TOKEN: 'fixture-launch-agent', IMBREX_OPERATOR_TOKEN: 'fixture-launch-operator' };
function launched(filename: string) {
  const child = spawn(process.execPath, [entry, '--config', filename], { env: environment, stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  return { child, exit, errors: () => stderr };
}
function ready(child: ChildProcessWithoutNullStreams): Promise<{ pid: number; port: number; storeId: string }> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('Startup timed out')); }, 5000);
    const exited = () => { cleanup(); reject(new Error('Exited before ready')); };
    const data = (chunk: Buffer) => {
      buffered += chunk.toString();
      for (;;) {
        const boundary = buffered.indexOf('\n');
        if (boundary < 0) break;
        const line = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 1);
        try {
          const value = object(JSON.parse(line));
          if (value.event !== 'ready') continue;
          assert.equal(typeof value.pid, 'number'); assert.equal(typeof value.port, 'number'); assert.equal(typeof value.store_id, 'string');
          cleanup(); resolve({ pid: value.pid as number, port: value.port as number, storeId: value.store_id as string }); return;
        } catch (error) { cleanup(); reject(error); return; }
      }
    };
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', data); child.off('exit', exited); };
    child.stdout.on('data', data); child.once('exit', exited);
  });
}

test('the public entry holds the data lock in the actual host and releases it after a crash', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-lock-'));
  const config = object(JSON.parse(await readFile(new URL('../../../examples/demo.json', import.meta.url), 'utf8')));
  config.data_dir = join(dir, 'data'); object(((config.plugins as unknown[]).map((value) => object(value)).find((plugin) => plugin.module === 'builtin:server-http')!).config).port = 0;
  const filename = join(dir, 'config.json'); await writeFile(filename, JSON.stringify(config));
  const processes: ReturnType<typeof launched>[] = [];
  const hosts: number[] = [];
  t.after(async () => {
    for (const pid of hosts) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    for (const item of processes) if (item.child.exitCode === null) item.child.kill('SIGTERM');
    await Promise.allSettled(processes.map((item) => item.exit));
    await rm(dir, { recursive: true, force: true });
  });
  const first = launched(filename); processes.push(first);
  const running = await ready(first.child); hosts.push(running.pid);
  assert.notEqual(running.pid, first.child.pid);
  const second = launched(filename); processes.push(second);
  assert.equal(await second.exit, 75);
  process.kill(running.pid, 'SIGKILL');
  assert.equal(await first.exit, 1);
  const third = launched(filename); processes.push(third);
  const resumed = await ready(third.child); hosts.push(resumed.pid);
  assert.equal(resumed.storeId, running.storeId);
  const response = await fetch('http://127.0.0.1:' + resumed.port + '/v1/info', { headers: { authorization: 'Bearer fixture-launch-agent' } });
  assert.equal(object(await response.json()).latest_seq, '4');
  third.child.kill('SIGTERM');
  assert.equal(await third.exit, 0);
  assert.ok(!third.errors().includes(environment.IMBREX_DEMO_AGENT_TOKEN));
});

test('invalid configuration or unknown builtin modules fail before opening the database', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/demo.json', import.meta.url), 'utf8')));
  const dataDir = join(dir, 'data'); raw.data_dir = dataDir;
  assert.ok(Array.isArray(raw.plugins)); object(raw.plugins[0]).module = 'builtin:unknown';
  const filename = join(dir, 'config.json'); await writeFile(filename, JSON.stringify(raw));
  const child = launched(filename);
  assert.equal(await child.exit, 1);
  await assert.rejects(access(join(dataDir, 'gateway.db')));
  assert.ok(child.errors().includes('startup_failed'));
  assert.ok(!child.errors().includes(environment.IMBREX_OPERATOR_TOKEN));
});

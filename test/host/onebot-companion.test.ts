import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Companion } from '../../src/plugins/onebot-v11/companion.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await delay(100);
  }
  assert.fail('Condition did not become true');
}

test('companion spawns through tini, probes the port, keeps login URLs and redacts authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-companion-'));
  const port = await freePort();
  const script = join(directory, 'server.mjs');
  await writeFile(script, `
    import { createServer } from 'node:net';
    const server = createServer((socket) => socket.end());
    server.listen(Number(process.argv[2]), '127.0.0.1', () => {
      console.log('listening');
      console.log('Authorization: Bearer supersecret');
      console.log('login https://example.test/qr?token=visible');
    });
    setInterval(() => {}, 1000);
  `);
  const companion = new Companion({ enabled: true, command: process.execPath, args: [script, String(port)], cwd: directory, env_vars: [] }, `ws://127.0.0.1:${port}/`);
  try {
    await companion.start();
    await until(() => companion.status().state === 'running');
    const logs = companion.status().logs.join('\n');
    assert.match(logs, /Authorization: Bearer \*\*\*/);
    assert.match(logs, /login https:\/\/example\.test\/qr\?token=visible/);
    await companion.stop();
    assert.equal(companion.status().state, 'stopped');
  } finally {
    await companion.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an occupied port is reported as an external process instead of being spawned twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-companion-'));
  const port = await freePort();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const companion = new Companion({ enabled: true, command: process.execPath, args: [], cwd: directory }, `ws://127.0.0.1:${port}/`);
  try {
    await companion.start();
    assert.equal(companion.status().state, 'external');
  } finally {
    await companion.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('companion cleanup removes descendants after stop or an unexpected parent exit', async (t) => {
  for (const mode of ['stop', 'exit'] as const) await t.test(mode, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'imbrex-companion-tree-'));
    const pidFile = join(directory, 'descendant.pid');
    const child = join(directory, 'child.mjs'), parent = join(directory, 'parent.mjs');
    await writeFile(child, `import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      writeFileSync(process.argv[2], String(process.pid));
      setInterval(() => {}, 1000);`);
    await writeFile(parent, `import { spawn } from 'node:child_process';
      import { existsSync } from 'node:fs';
      spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' });
      const timer = setInterval(() => {
        if (process.argv[4] === 'exit' && existsSync(process.argv[3])) { clearInterval(timer); process.exit(7); }
      }, 10);`);
    const companion = new Companion({ enabled: true, command: process.execPath, args: [parent, child, pidFile, mode], cwd: directory }, `ws://127.0.0.1:${await freePort()}/`);
    let pid: number | undefined;
    const alive = () => { if (pid === undefined) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
    t.after(async () => { await companion.stop(); if (alive()) process.kill(pid!, 'SIGKILL'); await rm(directory, { recursive: true, force: true }); });
    await companion.start();
    for (let i = 0; i < 100 && pid === undefined; i += 1) {
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await delay(10); }
    }
    assert.ok(pid);
    if (mode === 'stop') await companion.stop();
    else await until(() => companion.status().state === 'exited');
    assert.equal(alive(), false, 'cleanup must finish before stopped/exited is reported');
  });
});

test('stop cancels a companion start still checking the external port', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-companion-race-'));
  const script = join(directory, 'server.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);');
  const companion = new Companion({ enabled: true, command: process.execPath, args: [script], cwd: directory }, `ws://127.0.0.1:${await freePort()}/`);
  t.after(async () => { await companion.stop(); await rm(directory, { recursive: true, force: true }); });
  const starting = companion.start();
  await companion.stop(); await starting;
  assert.equal(companion.status().state, 'stopped'); assert.equal(companion.status().pid, undefined);
});

test('companion logs redact short explicitly named secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-companion-secret-'));
  const key = 'IMBREX_COMPANION_TEST_PASSWORD', previous = process.env[key];
  process.env[key] = '12345';
  const script = join(directory, 'log.mjs');
  await writeFile(script, 'console.log("password=" + process.env.IMBREX_COMPANION_TEST_PASSWORD); setInterval(() => {}, 1000);');
  const companion = new Companion({ enabled: true, command: process.execPath, args: [script], cwd: directory, env_vars: [key] }, `ws://127.0.0.1:${await freePort()}/`);
  t.after(async () => { await companion.stop(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; await rm(directory, { recursive: true, force: true }); });
  await companion.start(); await until(() => companion.status().logs.some((line) => line.startsWith('password=')));
  assert.ok(companion.status().logs.every((line) => !line.includes('12345')));
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

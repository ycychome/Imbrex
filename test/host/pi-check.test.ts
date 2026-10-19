import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { object } from '../../src/core/validation.js';

test('interrupting the pi check reaps its child and removes temporary configuration', async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) await t.test(signal, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'imbrex-pi-signal-'));
    const executable = join(dir, 'pi.mjs');
    await copyFile(new URL('../fixtures/pi-check.js', import.meta.url), executable); await chmod(executable, 0o700);
    const pidFile = join(dir, 'child.json');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../examples/agent/check-pi.js', import.meta.url)), 'http://127.0.0.1:1/v1/mcp', executable], {
      env: { ...process.env, IMBREX_QQ_AGENT_TOKEN: 'fixture-pi-token', PI_CHECK_FIXTURE_PATH: pidFile }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    t.after(async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} await rm(dir, { recursive: true, force: true }); });
    let running: Record<string, unknown> | undefined;
    for (let i = 0; i < 100; i += 1) {
      try { running = object(JSON.parse(await readFile(pidFile, 'utf8'))); break; } catch { await delay(20); }
    }
    assert.ok(running); assert.equal(typeof running.pid, 'number'); assert.equal(typeof running.directory, 'string');
    process.kill(signal === 'SIGINT' ? -child.pid! : child.pid!, signal);
    const [code] = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.throws(() => process.kill(running!.pid as number, 0), { code: 'ESRCH' });
    await assert.rejects(access(running.directory as string), { code: 'ENOENT' });
    assert.ok(output.includes('pi_check_interrupted')); assert.ok(!output.includes('fixture-pi-token'));
  });
});

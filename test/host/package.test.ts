import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { object } from '../../src/core/validation.js';

const entry = fileURLToPath(new URL('../../src/cli/package.js', import.meta.url));
async function run(command: string, args: string[], cwd?: string) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  return { code, stdout, stderr };
}

test('a packaged backend installs independently and serves supplied assets and authenticated APIs from one launcher', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = join(directory, 'external-build'), output = join(directory, 'bundle');
  await mkdir(assets); await mkdir(join(assets, 'assets'));
  await writeFile(join(assets, 'index.html'), 'external static fixture');
  await writeFile(join(assets, 'assets/content.txt'), 'external asset bytes');
  const packaged = await run(process.execPath, [entry, '--out-dir', output, '--assets-dir', assets]);
  assert.equal(packaged.code, 0, packaged.stderr);
  const manifest = object(JSON.parse(await readFile(join(output, 'bundle.json'), 'utf8')));
  assert.equal(object(manifest.assets).files, 2);
  assert.ok(Number(object(manifest.assets).gzip_bytes) > 0);
  await assert.rejects(access(join(output, '.private')));
  await assert.rejects(access(join(output, 'dist/test')));
  await assert.rejects(access(join(output, 'node_modules')));
  const installed = await run('npm', ['ci', '--omit=dev', '--offline', '--no-audit', '--no-fund'], output);
  assert.equal(installed.code, 0, installed.stderr);
  await writeFile(join(output, 'config.json'), JSON.stringify({ config_version: 2, data_dir: './data', external_writes_enabled: false,
    principals: [
      { id: 'protocol', permissions: [], read_sources: [], write_sources: [], invoke_capabilities: [] },
      { id: 'admin', token_env: 'IMBREX_PACKAGE_TEST_TOKEN', permissions: ['admin:inspect'], read_sources: [], write_sources: [], invoke_capabilities: [] },
    ], plugins: [
      { id: 'http', module: 'builtin:server-http', principal_id: 'protocol', required: true, enabled: true, config: { host: '127.0.0.1', port: 0 } },
      ...['api-rest', 'adapter-mcp'].map((module) => ({ id: module, module: 'builtin:' + module, principal_id: 'protocol', required: true, enabled: true, config: {} })),
      { id: 'admin', module: 'builtin:admin', principal_id: 'protocol', required: true, enabled: true, config: { assets_dir: join(output, 'admin') } },
    ],
  }));
  const child = spawn(process.execPath, ['dist/src/cli/start.js', '--config', 'config.json'], { cwd: output, env: { ...process.env, IMBREX_PACKAGE_TEST_TOKEN: 'fixture-package-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise<number | null>((done) => child.once('exit', done));
  const ready = Promise.withResolvers<Record<string, unknown>>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => { const value = object(JSON.parse(line)); if (value.event === 'ready') ready.resolve(value); });
  child.once('error', ready.reject); child.once('exit', () => ready.reject(new Error('Launcher exited before readiness')));
  child.stderr.resume();
  try {
    const value = await ready.promise;
    const origin = 'http://127.0.0.1:' + value.port;
    assert.equal(await (await fetch(origin + '/admin')).text(), 'external static fixture');
    assert.equal(await (await fetch(origin + '/admin/conversation/source')).text(), 'external static fixture');
    assert.equal(await (await fetch(origin + '/admin/assets/content.txt')).text(), 'external asset bytes');
    assert.equal((await fetch(origin + '/api/admin/info')).status, 401);
    const info = await fetch(origin + '/api/admin/info', { headers: { authorization: 'Bearer fixture-package-token' } });
    assert.equal(info.status, 200); assert.equal(object(await info.json()).store_id, value.store_id);
    assert.equal((await fetch(origin + '/v1/info', { headers: { authorization: 'Bearer fixture-package-token' } })).status, 200);
  } finally {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { assert.equal(await ended, 0); } finally { clearTimeout(force); lines.close(); }
  }
  const data = join(output, 'data'), state = join(data, 'plugins/legacy-agent/consumer-state.json');
  await mkdir(join(data, 'plugins/legacy-agent'), { recursive: true });
  const evidence = JSON.stringify({ fixture: 'migration must not touch Consumer responsibility', last_seq: '0', in_flight: { seq: '1', id: 'fixture', source: 'imbrex://qq/123456/main/group/987654' } });
  await writeFile(state, evidence);
  const database = await readFile(join(data, 'gateway.db'));
  await writeFile(join(output, 'legacy.json'), JSON.stringify({ config_version: 1, data_dir: './data', http: { host: '127.0.0.1', port: 0 }, external_writes_enabled: false,
    principals: [{ id: 'consumer', permissions: ['events:read'], read_sources: [{ prefix: 'imbrex://qq/123456/main/' }], write_sources: [], invoke_capabilities: [] }],
    plugins: [{ id: 'legacy-agent', module: 'builtin:acp-consumer', principal_id: 'consumer', required: true, enabled: false, config: { input_id: 'old-input', filter: { group_ids: ['987654'], private_user_ids: [] } } }],
  }));
  const migrated = await run('npm', ['--silent', 'run', 'config:migrate', '--', 'legacy.json', 'upgraded.json'], output);
  assert.equal(migrated.code, 0, migrated.stderr);
  const config = object(JSON.parse(await readFile(join(output, 'upgraded.json'), 'utf8')));
  assert.equal(config.data_dir, data); assert.ok(Array.isArray(config.plugins));
  const consumer = config.plugins.map((plugin) => object(plugin)).find((plugin) => plugin.id === 'legacy-agent')!;
  assert.equal(consumer.module, 'builtin:agent-chat'); assert.equal(consumer.principal_id, 'consumer');
  assert.deepEqual(object(consumer.config).filter, { group_ids: ['987654'], private_user_ids: [] });
  assert.equal(await readFile(state, 'utf8'), evidence);
  assert.deepEqual(await readFile(join(data, 'gateway.db')), database);
  const before = await readFile(join(output, 'upgraded.json'), 'utf8');
  assert.notEqual((await run('npm', ['--silent', 'run', 'config:migrate', '--', 'legacy.json', 'upgraded.json'], output)).code, 0);
  assert.equal(await readFile(join(output, 'upgraded.json'), 'utf8'), before);
});

test('packaging refuses existing outputs and removes only its own incomplete artifact on unsafe assets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-package-refuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'existing'), assets = join(directory, 'assets');
  await mkdir(output); await writeFile(join(output, 'keep'), 'existing user bytes');
  assert.notEqual((await run(process.execPath, [entry, '--out-dir', output])).code, 0);
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'existing user bytes');
  await mkdir(assets); await writeFile(join(assets, 'index.html'), 'fixture');
  const alias = join(directory, 'asset-alias'); await symlink(assets, alias);
  for (const path of [join(assets, '..bundle'), join(alias, 'bundle')]) {
    assert.notEqual((await run(process.execPath, [entry, '--out-dir', path, '--assets-dir', assets])).code, 0);
    await assert.rejects(access(path));
  }
  await symlink(join(output, 'keep'), join(assets, 'leak'));
  const refused = join(directory, 'refused');
  assert.notEqual((await run(process.execPath, [entry, '--out-dir', refused, '--assets-dir', assets])).code, 0);
  await assert.rejects(access(refused));
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'existing user bytes');
});

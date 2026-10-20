import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import { object } from '../../src/core/validation.js';

const token = 'fixture-admin-token';

async function fixture(t: TestContext, adminConfig: (directory: string) => Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-admin-'));
  let app: Host | undefined;
  t.after(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const raw = {
    config_version: 2,
    data_dir: join(directory, 'data'),
    external_writes_enabled: false,
    principals: [{
      id: 'admin',
      token_env: 'IMBREX_ADMIN_TEST_TOKEN',
      permissions: ['admin:inspect'],
      read_sources: [],
      write_sources: [],
      invoke_capabilities: [],
    }],
    plugins: [
      {
        id: 'http',
        module: 'builtin:server-http',
        principal_id: 'admin',
        required: true,
        enabled: true,
        config: { host: '127.0.0.1', port: 0 },
      },
      {
        id: 'admin',
        module: 'builtin:admin',
        principal_id: 'admin',
        required: true,
        enabled: true,
        config: adminConfig(directory),
      },
    ],
  };
  const filename = join(directory, 'imbrex.json');
  const config = parseConfig(raw, filename, { IMBREX_ADMIN_TEST_TOKEN: token });
  const modules = await loadModules(config, filename);
  app = await Host.open(config, modules);
  return app;
}

test('default package resolution serves the built admin UI and info', async (t) => {
  const app = await fixture(t, () => ({}));
  const base = 'http://127.0.0.1:' + app.port;
  const page = await fetch(base + '/admin');
  assert.equal(page.status, 200, 'run npm run web:build before this test');
  const html = await page.text();
  assert.match(html, /<div id="app"><\/div>/);
  const asset = /(?:src|href)="(\/admin\/assets\/[^"]+)"/.exec(html)?.[1];
  assert.ok(asset, 'built index must reference an admin asset');
  const response = await fetch(base + asset);
  assert.equal(response.status, 200);
  const etag = response.headers.get('etag');
  assert.ok(etag, 'static assets must be revalidatable');
  const revalidated = await fetch(base + asset, { headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304);
  await revalidated.text();
  const info = await fetch(base + '/api/admin/info', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(info.status, 200);
  const body = object(await info.json());
  assert.equal(typeof body.store_id, 'string');
  assert.equal(typeof body.latest_seq, 'string');
  assert.equal(typeof body.version, 'string');
});

test('missing explicit assets_dir returns 404 without blocking the admin API', async (t) => {
  const app = await fixture(t, (directory) => ({ assets_dir: join(directory, 'missing') }));
  const base = 'http://127.0.0.1:' + app.port;
  const page = await fetch(base + '/admin');
  assert.equal(page.status, 404);
  const info = await fetch(base + '/api/admin/info', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(info.status, 200);
});

test('non-directory assets_dir degrades to 404 without blocking the admin API', async (t) => {
  const app = await fixture(t, (directory) => {
    const file = join(directory, 'not-a-directory');
    writeFileSync(file, 'fixture');
    return { assets_dir: file };
  });
  const base = 'http://127.0.0.1:' + app.port;
  const page = await fetch(base + '/admin');
  assert.equal(page.status, 404);
  const info = await fetch(base + '/api/admin/info', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(info.status, 200);
});

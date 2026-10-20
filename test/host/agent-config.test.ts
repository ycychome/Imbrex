import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectPiConfiguration } from '../../src/plugins/agent-chat/inspect-config.js';
import { object } from '../../src/core/validation.js';

test('explicit pi configuration is bounded and reports saved values separately from applied facts without copying credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-pi-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model' }));
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { fixture: { apiKey: 'fixture-model-secret', models: [{ id: 'fixture-model', contextWindow: 500000 }] } } }));
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: {
    imbrex: { url: 'http://127.0.0.1:8080/v1/mcp', headers: { Authorization: 'Bearer $' + '{IMBREX_TEST_TOKEN}' } },
    literal: { url: 'http://127.0.0.1:8080/v1/mcp?token=fixture-url-secret', headers: { Authorization: 'Bearer fixture-header-secret' } },
  } }));
  await writeFile(join(directory, 'SYSTEM.md'), 'Fixture system instruction.');
  const view = object(await inspectPiConfiguration(directory));
  assert.equal(view.status, 'configured_unverified'); assert.equal(view.applied, null); assert.equal(view.observed, null);
  const saved = object(view.saved); assert.equal(saved.context_window, 500000); assert.equal(saved.system_prompt, 'Fixture system instruction.');
  assert.ok(Array.isArray(saved.mcp)); assert.equal(object(saved.mcp[0]).credential_reference, 'IMBREX_TEST_TOKEN');
  assert.equal(object(saved.mcp[1]).url, null);
  for (const secret of ['fixture-model-secret', 'fixture-url-secret', 'fixture-header-secret']) assert.ok(!JSON.stringify(view).includes(secret));
  await writeFile(join(directory, 'models.json'), 'x'.repeat(65537));
  assert.equal(object(await inspectPiConfiguration(directory)).status, 'unavailable');
  assert.equal(object(await inspectPiConfiguration(undefined)).status, 'unmanaged');
});

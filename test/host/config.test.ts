import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../../src/host/config.js';
import { requireCapability, requireSource } from '../../src/core/access.js';

const principal = { id: 'fixture', token_env: 'TEST_TOKEN', permissions: ['events:read', 'capabilities:invoke'], read_sources: [{ prefix: 'imbrex://Fixture/' }], write_sources: [], invoke_capabilities: ['mock.echo'] };
const config = { config_version: 2, data_dir: './data', external_writes_enabled: false, principals: [principal], plugins: [] };
const environment = { TEST_TOKEN: 'fixture-token-not-a-real-credential' };

test('configuration rejects ambiguous identities and missing/duplicate credentials without exposing secrets', () => {
  const valid = parseConfig(config, '/tmp/imbrex-fixture/config.json', environment);
  assert.equal(valid.dataDir, '/tmp/imbrex-fixture/data');
  const authenticated = valid.authenticate('Bearer ' + environment.TEST_TOKEN);
  assert.equal(authenticated.id, 'fixture');
  assert.throws(() => valid.authenticate('Bearer wrong'), { code: 'unauthorized' });
  assert.throws(() => parseConfig(config, 'config.json', {}), { code: 'invalid_request' });
  for (const patch of [{ config_version: 1 }, { extra: true }, { principals: [principal, principal] }, { principals: [principal, { ...principal, id: 'second' }] },
    { plugins: [{ id: 'mock', module: 'builtin:mock', principal_id: 'unknown', enabled: true, required: true, config: {} }] }]) {
    assert.throws(() => parseConfig({ ...config, ...patch }, 'config.json', environment), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(environment.TEST_TOKEN));
      return true;
    });
  }
});

test('authorization uses literal case-sensitive source scopes and exact capability grants', () => {
  const identity = parseConfig(config, 'config.json', environment).authenticate('Bearer ' + environment.TEST_TOKEN);
  requireSource(identity, 'imbrex://Fixture/messages');
  requireCapability(identity, 'mock.echo');
  for (const source of ['imbrex://fixture/messages', 'imbrex://FixtureOther/messages']) assert.throws(() => requireSource(identity, source), { code: 'forbidden' });
  assert.throws(() => requireSource(identity, 'imbrex://Fixture/messages', true), { code: 'forbidden' });
  assert.throws(() => requireCapability(identity, 'other.echo'), { code: 'forbidden' });
});

test('server-http listener configuration is validated while parsing', () => {
  const plugin = (value: unknown) => ({ id: 'http', module: 'builtin:server-http', principal_id: 'fixture', enabled: true, required: true, config: value });
  for (const value of [{ host: '127.0.0.1', port: 70000 }, { host: '127.0.0.1', port: '8080' }, { host: '127.0.0.1' }]) {
    assert.throws(() => parseConfig({ ...config, plugins: [plugin(value)] }, 'config.json', environment), { code: 'invalid_request' });
  }
  assert.doesNotThrow(() => parseConfig({ ...config, plugins: [plugin({ host: '127.0.0.1', port: 0 })] }, 'config.json', environment));
});

test('configuration structure can be validated without resolving token environment variables', () => {
  const validated = parseConfig(config, '/tmp/imbrex-fixture/config.json', {}, { resolveCredentials: false });
  assert.equal(validated.principals[0]!.id, 'fixture');
  assert.throws(() => validated.authenticate('Bearer ' + environment.TEST_TOKEN), { code: 'unauthorized' });
});

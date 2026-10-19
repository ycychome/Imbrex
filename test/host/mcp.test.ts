import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import type { PluginModule } from '../../src/host/modules.js';
import { object } from '../../src/core/validation.js';
import { SqliteStore } from '../../src/storage/store.js';

const agentToken = 'fixture-mcp-agent';
const otherToken = 'fixture-mcp-other';
const headers = { authorization: 'Bearer ' + agentToken, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
const rpc = (name: string, args: Record<string, unknown> = {}, id = 7) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const payload = (value: unknown) => object(object(value).structuredContent);
const errorCode = (value: unknown) => object(payload(value).error).code;

async function fixture(t: TestContext, largeSeq = false) {
  const dir = await mkdtemp(join(tmpdir(), 'imbrex-mcp-'));
  const clients: Client[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const control = { writes: 0, hold: false, outcome: 'succeeded' as 'succeeded' | 'unknown' };
  let app: Host | undefined;
  t.after(async () => {
    release.resolve();
    for (const client of clients) await client.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });
  if (largeSeq) {
    const path = join(dir, 'gateway.db');
    const store = await SqliteStore.open(path); await store.close();
    const seed = new DatabaseSync(path);
    seed.prepare("INSERT INTO sqlite_sequence (name,seq) VALUES ('events',?)").run(9007199254740992n);
    seed.close();
  }
  const config = parseConfig({
    config_version: 1, data_dir: dir, http: { host: '127.0.0.1', port: 0 }, external_writes_enabled: true,
    principals: [
      { id: 'provider', permissions: ['events:read', 'events:write'], read_sources: [{ prefix: 'imbrex://' }], write_sources: [{ prefix: 'imbrex://' }], invoke_capabilities: [] },
      { id: 'agent', token_env: 'AGENT_TOKEN', permissions: ['events:read', 'capabilities:list', 'capabilities:invoke', 'calls:read'], read_sources: [{ prefix: 'imbrex://visible/' }], write_sources: [], invoke_capabilities: ['provider.echo', 'provider.write'] },
      { id: 'other', token_env: 'OTHER_TOKEN', permissions: ['capabilities:list', 'capabilities:invoke', 'calls:read'], read_sources: [], write_sources: [], invoke_capabilities: [] },
    ],
    plugins: [{ id: 'provider', module: 'fixture', principal_id: 'provider', enabled: true, required: true, config: {} }],
  }, join(dir, 'config.json'), { AGENT_TOKEN: agentToken, OTHER_TOKEN: otherToken });
  const provider: PluginModule = { name: 'mcp-fixture', apply: async (ctx) => {
    const api = ctx.imbrex.forPlugin(ctx);
    for (const source of ['imbrex://visible/messages', 'imbrex://private/messages']) await api.events.append({ event: {
      specversion: '1.0', datacontenttype: 'application/json', source, id: '消息-😀', type: 'fixture.message', data: { text: 'fixture', exact_id: '9007199254740993' },
    } });
    api.capabilities.register({ localName: 'echo', description: 'Array-valued fixture', schemaVersion: 'array-1', isSideEffectful: false, inputSchema: { type: 'array', items: { type: 'string' } }, handler: (params) => params });
    api.capabilities.register({ localName: 'write', description: 'Write fixture', schemaVersion: '1', isSideEffectful: true, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, handler: async () => {
      control.writes += 1; entered.resolve();
      if (control.hold) await release.promise;
      return control.outcome === 'succeeded' ? { status: 'succeeded', result: { id: 'fixture' } } : { status: 'unknown', reason: { code: 'fixture_unknown', message: 'No confirmed receipt.' } };
    } });
  } };
  app = await Host.open(config, new Map([['provider', provider]]));
  const url = new URL('http://127.0.0.1:' + app.port + '/v1/mcp');
  const connect = async (token = agentToken) => {
    const client = new Client({ name: 'imbrex-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => object(await client.callTool({ name, arguments: args }));
  return { app, config, url, connect, call, control, entered, release, storeId: (await app.info()).storeId };
}

test('official SDK discovers scoped tools and schemas, and preserves decimal positions and event references', async (t) => {
  const { connect, call, storeId, app } = await fixture(t, true);
  const client = await connect();
  assert.equal((await client.listTools()).tools.length, 6);
  assert.equal(payload(await call(client, 'imbrex_info')).latest_seq, '9007199254740994');
  const page = payload(await call(client, 'imbrex_read_events', { store_id: storeId, after_seq: '9007199254740992' }));
  assert.equal(page.next_after_seq, '9007199254740994');
  assert.ok(Array.isArray(page.records)); assert.equal(page.records.length, 1);
  assert.equal(object(page.records[0]).seq, '9007199254740993');
  const lookup = payload(await call(client, 'imbrex_lookup_event', { store_id: storeId, source: 'imbrex://visible/messages', id: '消息-😀' }));
  assert.deepEqual(lookup.record, page.records[0]);
  const found = payload(await call(client, 'imbrex_list_capabilities'));
  assert.ok(Array.isArray(found.capabilities)); assert.equal(found.capabilities.length, 2);
  assert.deepEqual(object(found.capabilities[0]).input_schema, { type: 'array', items: { type: 'string' } });
  assert.equal(object(found.capabilities[0]).schema_version, 'array-1');
  assert.deepEqual(payload(await call(client, 'imbrex_invoke', { store_id: storeId, capability_id: 'provider.echo', params: ['fixture'] })).result, ['fixture']);
  assert.equal(errorCode(await call(client, 'imbrex_lookup_event', { store_id: storeId, source: 'imbrex://private/messages', id: '消息-😀' })), 'forbidden');
  assert.equal(errorCode(await call(client, 'imbrex_read_events', { store_id: storeId, after_seq: 9007199254740992 })), 'invalid_params');
  assert.equal(errorCode(await call(client, 'imbrex_read_events', { store_id: storeId, after_seq: '01' })), 'invalid_position');
  assert.equal(errorCode(await call(client, 'imbrex_read_events', { store_id: 'other-store', after_seq: '0' })), 'store_mismatch');
  assert.equal(errorCode(await call(client, 'imbrex_invoke', { store_id: storeId, capability_id: 'provider.write', params: { text: 'fixture' }, caller_id: 'provider' })), 'invalid_params');
  const other = await connect(otherToken);
  assert.ok(!(await other.listTools()).tools.some((tool) => tool.name === 'imbrex_read_events'));
  assert.deepEqual(payload(await call(other, 'imbrex_list_capabilities')).capabilities, []);
  assert.equal(errorCode(await call(other, 'imbrex_read_events', { store_id: storeId, after_seq: '0' })), 'forbidden');
  assert.equal(errorCode(await call(other, 'imbrex_invoke', { store_id: storeId, capability_id: 'provider.echo', params: [] })), 'forbidden');
  await app.stopPlugin('provider');
  assert.deepEqual(payload(await call(client, 'imbrex_list_capabilities')).capabilities, []);
});

test('MCP enforces authentication, Origin, SDK negotiation, request bounds and stateless transport rules', async (t) => {
  const { url, connect, call } = await fixture(t);
  const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
  const send = (value: unknown, overrides: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(value) });
  const initialized = await send(initialize, { origin: url.origin });
  assert.equal(initialized.status, 200); assert.equal(initialized.headers.get('mcp-session-id'), null);
  assert.equal(object(object(await initialized.json()).result).protocolVersion, '2025-11-25');
  for (const [value, overrides, status] of [
    [rpc('imbrex_info'), { authorization: 'Bearer wrong' }, 401],
    [rpc('imbrex_info'), { origin: 'https://foreign.example' }, 403],
    [rpc('imbrex_info'), { origin: 'null' }, 403],
    [rpc('imbrex_info'), { 'mcp-session-id': 'stolen' }, 400],
    [rpc('imbrex_info'), { 'last-event-id': 'previous' }, 400],
    [rpc('imbrex_info'), { 'mcp-protocol-version': 'unsupported' }, 400],
    [rpc('imbrex_info'), { accept: 'application/json' }, 406],
    [rpc('imbrex_info'), { 'content-encoding': 'gzip' }, 400],
    [[rpc('imbrex_info')], {}, 400],
    [rpc('imbrex_info', { oversized: 'x'.repeat(262145) }), {}, 413],
  ] as const) {
    const response = await send(value, overrides); await response.text();
    assert.equal(response.status, status);
  }
  const invalidInit = await send({ ...initialize, params: { protocolVersion: 42 } });
  assert.ok(object(await invalidInit.json()).error);
  const method = await fetch(url, { headers }); await method.text(); assert.equal(method.status, 405);
  const client = await connect();
  assert.equal(payload(await call(client, 'imbrex_info')).latest_seq, '2');
});

test('a lost MCP response keeps one write and the original principal can query its uncertain result', async (t) => {
  const { url, connect, call, storeId, control, entered, release, app } = await fixture(t);
  const client = await connect();
  const args = { store_id: storeId, capability_id: 'provider.write', call_id: 'stable.intent:1', params: { text: 'fixture' } };
  assert.equal(errorCode(await call(client, 'imbrex_invoke', { store_id: storeId, capability_id: 'provider.write', params: { text: 'fixture' } })), 'invalid_request');
  control.hold = true; control.outcome = 'unknown';
  const controller = new AbortController();
  const lost = fetch(url, { method: 'POST', headers, body: JSON.stringify(rpc('imbrex_invoke', args)), signal: controller.signal });
  const rejected = assert.rejects(lost);
  await entered.promise; controller.abort(); await rejected;
  const repeated = await call(client, 'imbrex_invoke', args);
  assert.equal(repeated.isError, true); assert.equal(object(payload(repeated).call).status, 'in_progress');
  assert.equal(errorCode(await call(client, 'imbrex_invoke', { ...args, params: { text: 'changed' } })), 'call_conflict');
  const query = { store_id: storeId, call_id: args.call_id };
  assert.equal(errorCode(await call(await connect(otherToken), 'imbrex_get_call', query)), 'call_not_found');
  release.resolve();
  let recorded: Record<string, unknown> | undefined;
  for (let i = 0; i < 100; i += 1) {
    recorded = object(payload(await call(client, 'imbrex_get_call', query)).call);
    if (recorded.status === 'unknown') break;
    await delay(10);
  }
  assert.equal(recorded?.status, 'unknown');
  const again = await call(client, 'imbrex_invoke', args);
  assert.equal(again.isError, true); assert.deepEqual(payload(again).call, recorded); assert.equal(control.writes, 1);
  await app.stopPlugin('provider');
  assert.deepEqual(payload(await call(client, 'imbrex_get_call', query)).call, recorded);
});

test('SDK field filtering cannot turn an invalid raw request into an accepted write', async (t) => {
  const { url, connect, call, storeId, control } = await fixture(t);
  const client = await connect();
  const args = { store_id: storeId, capability_id: 'provider.write', call_id: 'invalid-original', params: { text: 'fixture' } };
  const prototypeKey = rpc('imbrex_invoke', args);
  Object.defineProperty(prototypeKey.params.arguments, '__proto__', { value: {}, enumerable: true });
  const rejected = await fetch(url, { method: 'POST', headers, body: JSON.stringify(prototypeKey) });
  const result = object(object(await rejected.json()).result);
  assert.equal(result.isError, true); assert.equal(errorCode(result), 'invalid_params');
  const unknownParameter = rpc('imbrex_invoke', { ...args, call_id: 'forged-envelope' });
  Object.assign(unknownParameter.params, { caller_id: 'provider' });
  const envelope = await fetch(url, { method: 'POST', headers, body: JSON.stringify(unknownParameter) });
  assert.equal(envelope.status, 400); assert.equal(object(object(await envelope.json()).error).code, 'invalid_request');
  assert.equal(control.writes, 0);
  assert.equal(errorCode(await call(client, 'imbrex_get_call', { store_id: storeId, call_id: args.call_id })), 'call_not_found');
});

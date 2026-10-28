import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import type { PluginApi } from '../../src/host/plugin-api.js';
import { object } from '../../src/core/validation.js';
import { parseMemoryConfig } from '../../src/plugins/memory/config.js';

const sourceA = 'imbrex://qq/123456/main/group/987654';
const sourceB = 'imbrex://qq/123456/main/group/987655';
const agentToken = 'fixture-memory-agent-token';
const otherToken = 'fixture-memory-other-token';
const serviceToken = 'fixture-memory-service-token';
const adminToken = 'fixture-memory-admin-token';

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail('Timed out waiting for memory fixture state');
}

async function fixture(t: TestContext, extraInstance = false) {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-memory-'));
  const envKeys = ['IMBREX_DEMO_AGENT_TOKEN', 'IMBREX_OPERATOR_TOKEN', 'MEMORY_AGENT_TOKEN', 'MEMORY_OTHER_TOKEN', 'MEMORY_SERVICE_TOKEN', 'MEMORY_ADMIN_TOKEN', 'MEMORY_ABSENT_TOKEN'];
  const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.IMBREX_DEMO_AGENT_TOKEN = 'fixture-demo-token';
  process.env.IMBREX_OPERATOR_TOKEN = 'fixture-operator-token';
  process.env.MEMORY_AGENT_TOKEN = agentToken;
  process.env.MEMORY_OTHER_TOKEN = otherToken;
  process.env.MEMORY_SERVICE_TOKEN = serviceToken;
  process.env.MEMORY_ADMIN_TOKEN = adminToken;
  delete process.env.MEMORY_ABSENT_TOKEN;
  let app: Host | undefined;
  const requests: Record<string, unknown>[] = [];
  const contractErrors: string[] = [];
  const resolverRequests: Record<string, unknown>[] = [];
  let resolverWait: Promise<void> = Promise.resolve();
  let releaseResolver = () => {};
  const operations = new Map<string, Record<string, unknown>>();
  const imageOperationIds = new Set<string>();
  const missingOperationQueries: string[] = [];
  let ready = true;
  let forcedOperationState: 'queued' | 'succeeded' = 'succeeded';
  let forcedImageState: 'queued' | 'succeeded' | 'failed' | 'unknown' = 'succeeded';
  let loseOperationResponses = 0;
  let rejectIngests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : {};
    const result: Record<string, unknown> = {};
    if (request.url === '/health') Object.assign(result, { ready, ledger_id: 'a'.repeat(64) });
    else if (request.url === '/v1/operations') {
      requests.push(body);
      const id = String(body.request_id);
      const payload = object(body.payload);
      const scopes = body.scopes;
      const records = payload.records;
      const validEnvelope = typeof body.store_id === 'string' && body.store_id.length > 0 && body.instance_id === 'memory' &&
        typeof body.caller_id === 'string' && body.caller_id.length > 0 && Array.isArray(scopes) && scopes.length >= 1 && scopes.length <= 8 && /^[a-f0-9]{64}$/.test(id);
      const validIngest = body.kind !== 'ingest' || (payload.schema_version === 1 && Object.keys(payload).every((key) => ['schema_version', 'records'].includes(key)) &&
        Array.isArray(records) && records.length >= 1 && records.length <= 16 && Array.isArray(scopes) && scopes.length === 1 && records.every((raw) => {
          const record = object(raw);
          return record.source === scopes[0] && ['id', 'seq', 'accepted_at', 'account_id', 'identity_namespace', 'conversation_type', 'conversation_id', 'sender_id', 'text', 'type'].every((key) => typeof record[key] === 'string');
        }));
      const validAgentWrite = body.kind !== 'remember' || (body.caller_id === 'memory-agent' && typeof payload.category === 'string' && typeof payload.content === 'string' && Array.isArray(payload.evidence_refs));
      const validImages = body.kind !== 'images' || (Object.keys(payload).every((key) => ['input_event_ref', 'images'].includes(key)) &&
        Array.isArray(payload.images) && payload.images.every((raw) => { const image = object(raw); return typeof image.segment_index === 'number' && typeof image.file === 'string' && (image.url === undefined || typeof image.url === 'string'); }) &&
        object(payload.input_event_ref).source === (Array.isArray(scopes) ? scopes[0] : undefined));
      if (!validEnvelope || !validIngest || !validAgentWrite || !validImages) {
        contractErrors.push(`${String(body.kind)}: malformed request`);
        response.writeHead(422, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'invalid_params', message: 'contract mismatch' } })); return;
      }
      if (body.kind === 'ingest' && rejectIngests > 0) {
        rejectIngests -= 1;
        response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'busy', message: 'retry later' } })); return;
      }
      const operation = operations.get(id) ?? { operation_id: id, state: 'queued', accepted: true, applied: false };
      operations.set(id, operation);
      if (body.kind === 'images') imageOperationIds.add(id);
      if (loseOperationResponses > 0) { loseOperationResponses -= 1; response.destroy(); return; }
      Object.assign(result, operation);
    } else if (request.url === '/v1/query') {
      requests.push(body);
      const scopes = body.scopes;
      const kind = body.kind;
      const params = object(body.params);
      if (typeof body.store_id !== 'string' || body.instance_id !== 'memory' || typeof body.caller_id !== 'string' ||
          !Array.isArray(scopes) || scopes.length < 1 || scopes.length > 8 ||
          (kind === 'operation' && (typeof params.operation_id !== 'string' || !/^[a-f0-9]{64}$/.test(params.operation_id)))) {
        contractErrors.push(`${String(kind)}: malformed query`);
        response.writeHead(422, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'invalid_params', message: 'contract mismatch' } })); return;
      }
      if (kind === 'operation') {
        const id = String(params.operation_id);
        if (!operations.has(id)) {
          missingOperationQueries.push(id);
          response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } })); return;
        }
        const operation = operations.get(id)!;
        const state = imageOperationIds.has(id) ? forcedImageState : forcedOperationState;
        Object.assign(result, { ...operation, state, accepted: true, applied: state === 'succeeded' });
      } else if (kind === 'context') Object.assign(result, { context: '记忆😀', memories: [] });
      else if (kind === 'status') Object.assign(result, { accepted_seq: '2', indexed_seq: '2', pending: [] });
      else Object.assign(result, { memories: [], query: params.query ?? null });
    } else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => {
    try { await app?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(directory, { recursive: true, force: true });
    }
  });
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/demo.json', import.meta.url), 'utf8')));
  raw.data_dir = join(directory, 'data'); raw.external_writes_enabled = true;
  assert.ok(Array.isArray(raw.plugins));
  const http = raw.plugins.map((item) => object(item)).find((item) => item.module === 'builtin:server-http')!;
  object(http.config).port = 0;
  assert.ok(Array.isArray(raw.principals));
  raw.principals.push(
    { id: 'memory-admin', token_env: 'MEMORY_ADMIN_TOKEN', permissions: ['admin:inspect'], read_sources: [], write_sources: [], invoke_capabilities: [] },
    { id: 'memory-reader', permissions: ['events:read', 'capabilities:invoke'], read_sources: [{ prefix: 'imbrex://qq/123456/main/' }], write_sources: [], invoke_capabilities: ['image-resolver.get_message'] },
    { id: 'memory-agent', token_env: 'MEMORY_AGENT_TOKEN', permissions: ['events:read', 'capabilities:list', 'capabilities:invoke', 'calls:read'], read_sources: [{ prefix: 'imbrex://qq/123456/main/' }], write_sources: [], invoke_capabilities: ['memory.search', 'memory.context', 'memory.get', 'memory.status', 'memory.operation', 'memory.remember', 'memory.update', 'memory.forget', 'memory.rebuild'] },
    { id: 'memory-other', token_env: 'MEMORY_OTHER_TOKEN', permissions: ['events:read', 'capabilities:list', 'capabilities:invoke'], read_sources: [{ exact: sourceB }], write_sources: [], invoke_capabilities: ['memory.search'] },
    { id: 'memory-writer', permissions: ['events:write'], read_sources: [], write_sources: [{ prefix: 'imbrex://qq/123456/main/' }], invoke_capabilities: [] },
  );
  raw.plugins.push(
    { id: 'admin', module: 'builtin:admin', principal_id: 'protocol', required: true, enabled: false, config: {} },
    { id: 'memory', module: 'builtin:memory', principal_id: 'memory-reader', required: true, enabled: true, config: { service_url: `http://127.0.0.1:${address.port}`, service_token_env: 'MEMORY_SERVICE_TOKEN', sources: [sourceA, sourceB], message_readers: { 'imbrex://qq/123456/main/': 'image-resolver.get_message' }, request_timeout_ms: 1000, poll_ms: 100, batch_wait_ms: 100 } },
    { id: 'memory-writer', module: 'builtin:fixture', principal_id: 'memory-writer', required: true, enabled: true, config: {} },
    { id: 'image-resolver', module: 'builtin:fixture', principal_id: 'memory-reader', required: true, enabled: true, config: {} },
  );
  if (extraInstance) raw.plugins.push({ id: 'memory-other-instance', module: 'builtin:memory', principal_id: 'memory-reader', required: true, enabled: true,
    config: { service_url: `http://127.0.0.1:${address.port}`, service_token_env: 'MEMORY_ABSENT_TOKEN', sources: [sourceB] } });
  const filename = join(directory, 'imbrex.json');
  const config = parseConfig(raw, filename, process.env);
  const modules = await loadModules(config, filename);
  let writer!: PluginApi;
  modules.set('memory-writer', { name: 'memory-test-writer', apply: (ctx) => { writer = ctx.imbrex.forPlugin(ctx); } });
  modules.set('image-resolver', { name: 'memory-image-resolver', inject: ['imbrex'], apply: (ctx) => {
    const api = ctx.imbrex.forPlugin(ctx);
    ctx.effect(() => api.capabilities.register({ localName: 'get_message', description: 'Test scoped message reader', schemaVersion: '1', isSideEffectful: false,
      inputSchema: { type: 'object', properties: {
        input_event_ref: { type: 'object', properties: { source: { type: 'string' }, id: { type: 'string' } }, required: ['source', 'id'], additionalProperties: false },
        message_id: { type: 'string' }, target: { type: 'object', properties: { type: { enum: ['group', 'private'] }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false },
      }, required: ['input_event_ref', 'target', 'message_id'], additionalProperties: false },
      handler: async (params, invocation) => {
        const value = object(params); resolverRequests.push(value); await resolverWait;
        const ref = object(value.input_event_ref);
        const record = await invocation.readEvent({ source: String(ref.source), id: String(ref.id) });
        const body = object(record.event.data);
        assert.deepEqual(value.target, { type: body.conversation_type, id: body.conversation_id });
        assert.equal(value.message_id, body.native_message_id);
        return { native_message_id: body.native_message_id, conversation_type: body.conversation_type, conversation_id: body.conversation_id, sender_id: body.sender_id,
          segments: (body.message_segments as unknown[]).map((raw) => {
            const segment = object(raw); return segment.type === 'image' ? { type: 'image', data: { ...object(segment.data), url: 'https://resolved.example/image' } } : segment;
          }) };
      } }));
  } });
  app = await Host.open(config, modules);
  const storeId = (await app.info()).storeId;
  const append = async (id: string, source: string, sender: string, withImage = false) => await writer.events.append({ event: {
    specversion: '1.0', type: 'qq.message.group', source, id: `message:${id}`, datacontenttype: 'application/json', time: new Date().toISOString(),
    data: { account_id: '123456', identity_namespace: 'main', conversation_type: 'group', conversation_id: source === sourceA ? '987654' : '987655',
      sender_id: sender, native_message_id: id, direction: 'inbound', text: `text ${id}`, message_segments: [{ type: 'text', data: { text: `text ${id}` } }, ...(withImage ? [{ type: 'image', data: { file: `file-${id}`, url: 'https://untrusted.example/original' } }] : [])] },
  }, parents: [] });
  const url = `http://127.0.0.1:${app.port}`;
  const invoke = async (token: string, capability: string, params: Record<string, unknown>, callId?: string) => {
    const response = await fetch(`${url}/v1/capabilities/${capability}/invoke`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, params, ...(callId ? { call_id: callId } : {}) }) });
    return { status: response.status, body: object(await response.json()) };
  };
  return { app, directory, requests, operations, contractErrors, append, invoke, storeId, url,
    setHealthReady(value: boolean) { ready = value; }, setOperationState(value: 'queued' | 'succeeded') { forcedOperationState = value; },
    setImageOperationState(value: 'queued' | 'succeeded' | 'failed' | 'unknown') { forcedImageState = value; },
    missingOperationQueries,
    forgetOperation(id: string) { operations.delete(id); },
    loseNextOperationResponses(count: number) { loseOperationResponses = count; }, rejectNextIngests(count: number) { rejectIngests = count; },
    resolverRequests, blockResolver() { resolverWait = new Promise<void>((resolve) => { releaseResolver = resolve; }); }, releaseResolver() { releaseResolver(); resolverWait = Promise.resolve(); } };
}

test('legacy image resolver configuration is rejected before its incompatible protocol can be invoked', () => {
  const base = { service_url: 'http://127.0.0.1:8090', service_token_env: 'MEMORY_SERVICE_TOKEN', sources: [sourceA] };
  assert.throws(() => parseMemoryConfig({ ...base, image_resolvers: { 'imbrex://qq/123456/main/': 'qq.resolve_image' } }));
  assert.throws(() => parseMemoryConfig({ ...base, message_readers: { 'imbrex://qq/123456/main/group/': 'qq.get_message' } }));
});

test('memory admin snapshots are isolated, local, redacted and scoped to plugin lifetimes', async (t) => {
  const f = await fixture(t, true);
  const request = async (path: string, token = adminToken) => {
    const response = await fetch(f.url + path, { headers: { authorization: 'Bearer ' + token } });
    return { status: response.status, body: object(await response.json()) };
  };
  // Memory registers before Admin exists; enabling the UI must not restart indexing.
  await f.app.startPlugin('admin');
  const read = () => request('/api/admin/panels/memory');
  const data = (body: Record<string, unknown>) => object(object(body.data).data);
  await until(async () => data((await read()).body).service_ready === true);
  const event = await f.append('290', sourceA, '333333', true);
  await until(async () => data((await read()).body).indexed_seq === event.seq.toString() && data((await read()).body).pending === 0);
  const before = await read();
  assert.equal(f.app.plugins().find((plugin) => plugin.id === 'memory')?.client_entry, '/admin/plugins/memory/entry.js');
  assert.equal(object(object(before.body.data).status).tone, 'ok');
  const snapshot = data(before.body);
  assert.equal(snapshot.state_status, 'loaded');
  assert.equal(snapshot.indexed_seq, event.seq.toString());
  assert.equal(object(object(snapshot.configuration).credential).name, 'MEMORY_SERVICE_TOKEN');
  for (const secret of [serviceToken, agentToken, 'http://127.0.0.1', 'memory-state.json']) assert.ok(!JSON.stringify(before.body).includes(secret));
  assert.equal((await request('/api/admin/panels/memory', agentToken)).status, 403);
  assert.equal((await request('/api/admin/panels/memory', 'wrong-token')).status, 401);
  const count = f.requests.length;
  await read(); await read();
  assert.equal(f.requests.length, count, 'panel reads must not query or write the Memory service');
  const unavailable = await request('/api/admin/panels/memory-other-instance');
  assert.equal(object(object(unavailable.body.data).status).tone, 'error');
  assert.equal(data(unavailable.body).last_error, 'memory_token_missing');
  assert.equal(data(unavailable.body).state_status, 'unavailable');
  assert.deepEqual(object(data(unavailable.body).configuration).sources, [sourceB]);
  const assets = await fetch(f.url + '/admin/plugins/memory/entry.js');
  assert.equal(assets.status, 200);
  await assets.arrayBuffer();
  f.setHealthReady(false);
  await until(async () => object(object((await read()).body.data).status).tone === 'error');
  assert.equal(data((await read()).body).indexed_seq, event.seq.toString(), 'outages retain known local progress');
  f.setHealthReady(true);
  await until(async () => data((await read()).body).service_ready === true);
  await f.app.stopPlugin('admin'); await f.app.startPlugin('admin');
  assert.equal((await read()).body.generation, before.body.generation);
  await f.app.stopPlugin('memory');
  assert.equal((await read()).status, 404);
  assert.equal((await request('/api/admin/panels/memory-other-instance')).status, 200);
  await f.app.startPlugin('memory');
  const restarted = await read();
  assert.notEqual(restarted.body.generation, before.body.generation);
  assert.equal(data(restarted.body).indexed_seq, event.seq.toString());
  await f.app.stopPlugin('memory');
  await writeFile(join(f.directory, 'data/plugins/memory/memory-state.json'), '{broken fixture');
  await f.app.startPlugin('memory');
  const broken = await read();
  assert.equal(object(object(broken.body.data).status).tone, 'error');
  assert.equal(data(broken.body).state_status, 'unavailable');
  const metrics = object(broken.body.data).metrics;
  assert.ok(Array.isArray(metrics));
  assert.equal(object(metrics[2]).value, '未提供', 'corrupt state must not masquerade as index position zero');
});

test('memory verifies the actual caller event scope, binds writes and indexes stable QQ batches', async (t) => {
  const f = await fixture(t);
  const first = await f.append('201', sourceA, '333333');
  const second = await f.append('202', sourceB, '444444');
  await until(() => f.requests.filter((request) => request.kind === 'ingest').length >= 2);
  const ingests = f.requests.filter((request) => request.kind === 'ingest');
  assert.deepEqual(ingests.map((request) => object(request).scopes), [[sourceA], [sourceB]]);
  assert.ok(ingests.every((request) => object(request).caller_id === 'memory-reader'));
  const refA = first.eventRef;
  const search = await f.invoke(agentToken, 'memory.search', { scope_refs: [refA], query: 'tea' });
  assert.equal(search.status, 200);
  const query = f.requests.find((request) => object(request).kind === 'search')!;
  assert.equal(object(query).caller_id, 'memory-agent');
  assert.deepEqual(object(query).scopes, [sourceA]);
  const context = await f.invoke(agentToken, 'memory.context', { input_event_ref: refA, max_bytes: 3 });
  assert.equal(context.status, 200);
  assert.equal(object(context.body.result).context, '记');
  const contextQuery = f.requests.find((request) => object(request).kind === 'context')!;
  assert.equal(object(object(contextQuery).params).query, 'text 201');
  const crossScope = await f.invoke(otherToken, 'memory.search', { scope_refs: [refA], query: 'tea' });
  assert.notEqual(crossScope.status, 200);

  const remembered = await f.invoke(agentToken, 'memory.remember', {
    scope_refs: [refA], category: 'preference', content: 'Likes tea', subjects: ['333333'],
  }, 'memory.write.intent.1');
  assert.equal(remembered.status, 200);
  const call = object(remembered.body.call);
  assert.equal(call.status, 'succeeded');
  const operationId = String(object(call.result).operation_id);
  assert.match(operationId, /^[a-f0-9]{64}$/);
  assert.deepEqual(call.result, { operation_id: operationId, state: 'queued', accepted: true, applied: false });
  const writeRequests = f.requests.filter((request) => object(request).kind === 'remember');
  assert.equal(writeRequests.length, 1);
  assert.equal(object(writeRequests[0]).caller_id, 'memory-agent');
  assert.deepEqual(object(writeRequests[0]).scopes, [sourceA]);
  assert.equal(Object.hasOwn(object(object(writeRequests[0]).payload), 'scope_refs'), false);
  assert.deepEqual(object(writeRequests[0]).payload && object(object(writeRequests[0]).payload).evidence_refs, [refA]);
  const duplicate = await f.invoke(agentToken, 'memory.remember', {
    scope_refs: [refA], category: 'preference', content: 'Likes tea', subjects: ['333333'],
  }, 'memory.write.intent.1');
  assert.equal(duplicate.status, 200);
  assert.equal(f.requests.filter((request) => object(request).kind === 'remember').length, 1);

  const operation = await f.invoke(agentToken, 'memory.operation', { scope_refs: [refA], operation_id: operationId });
  assert.equal(operation.status, 200);
  assert.equal(object(operation.body.result).state, 'succeeded');
  const refB = second.eventRef;
  const rebuild = await f.invoke(agentToken, 'memory.rebuild', { scope_refs: [refA, refB], reason: 'restore index' }, 'memory.rebuild.1');
  assert.equal(rebuild.status, 200);
  const rebuildId = String(object(object(rebuild.body.call).result).operation_id);
  const rebuilt = await f.invoke(agentToken, 'memory.operation', { scope_refs: [refA, refB], operation_id: rebuildId });
  assert.equal(rebuilt.status, 200);
  await until(async () => {
    const state = object(JSON.parse(await readFile(join(f.directory, 'data/plugins/memory/memory-state.json'), 'utf8')));
    return state.generation === 1 && BigInt(String(state.accepted_seq)) >= second.seq && BigInt(String(state.indexed_seq)) >= second.seq;
  });
  const allIngests = f.requests.filter((request) => object(request).kind === 'ingest').map((request) => String(object(request).request_id));
  assert.equal(allIngests.length, 4);
  assert.notEqual(allIngests[0], allIngests[2]);
  await f.app.stopPlugin('memory');
  assert.equal((await f.invoke(agentToken, 'memory.search', { scope_refs: [refA], query: 'tea' })).status, 404);
  await f.app.startPlugin('memory');
  await until(async () => (await f.invoke(agentToken, 'memory.search', { scope_refs: [refA], query: 'tea' })).status === 200);
  const persisted = object(JSON.parse(await readFile(join(f.directory, 'data/plugins/memory/memory-state.json'), 'utf8')));
  assert.equal(persisted.store_id, f.storeId);
  assert.ok(BigInt(String(persisted.accepted_seq)) >= second.seq);
});

test('memory serializes rebuild state with concurrent ingest checkpoints', async (t) => {
  const f = await fixture(t);
  const ref = (await f.append('race-1', sourceA, '333333')).eventRef;
  await until(() => f.requests.some((request) => object(request).kind === 'ingest'));
  const append = f.append('race-2', sourceB, '444444');
  const rebuild = f.invoke(agentToken, 'memory.rebuild', { scope_refs: [ref], reason: 'concurrent checkpoint test' }, 'memory.rebuild.race');
  const [next, accepted] = await Promise.all([append, rebuild]);
  assert.equal(accepted.status, 200);
  const operationId = String(object(object(accepted.body.call).result).operation_id);
  assert.equal((await f.invoke(agentToken, 'memory.operation', { scope_refs: [ref], operation_id: operationId })).status, 200);
  await until(async () => {
    const state = object(JSON.parse(await readFile(join(f.directory, 'data/plugins/memory/memory-state.json'), 'utf8')));
    return BigInt(String(state.accepted_seq)) >= next.seq && Array.isArray(state.pending);
  });
  const persisted = object(JSON.parse(await readFile(join(f.directory, 'data/plugins/memory/memory-state.json'), 'utf8')));
  assert.equal(persisted.store_id, f.storeId);
  assert.equal(persisted.instance_id, 'memory');
  assert.ok(Array.isArray(persisted.pending));
});

test('memory backfill bounds batches, resumes queued and uncertain operations, and fences invalid state', async (t) => {
  const f = await fixture(t);
  await f.app.stopPlugin('memory');
  f.setHealthReady(false);
  await unlink(join(f.directory, 'data/plugins/memory/memory-state.json'));
  const historical = [];
  for (let i = 0; i < 51; i += 1) historical.push(await f.append(`backfill-${i}`, i % 2 ? sourceB : sourceA, i % 2 ? '444444' : '333333'));
  const fixedSeq = historical.at(-1)!.seq;
  await f.app.startPlugin('memory');
  const live = await f.append('after-boundary', sourceA, '333333');
  f.setOperationState('queued');
  f.rejectNextIngests(1);
  f.setHealthReady(true);
  const statePath = join(f.directory, 'data/plugins/memory/memory-state.json');
  await until(async () => {
    const state = object(JSON.parse(await readFile(statePath, 'utf8')));
    return BigInt(String(state.fixed_latest_seq)) === fixedSeq && BigInt(String(state.accepted_seq)) >= live.seq && Array.isArray(state.pending) && state.pending.length > 0;
  }).catch(async () => { assert.fail(JSON.stringify({ fixedSeq: fixedSeq.toString(), liveSeq: live.seq.toString(), state: JSON.parse(await readFile(statePath, 'utf8')), requests: f.requests.map((request) => ({ kind: object(request).kind, id: object(request).request_id })), contractErrors: f.contractErrors })); });
  const ingests = f.requests.filter((request) => object(request).kind === 'ingest');
  assert.ok(ingests.length >= 5, 'one 429 retry plus multiple bounded batches should be observable');
  assert.equal(f.contractErrors.length, 0, f.contractErrors.join(', '));
  const uniqueIngests = [...new Map(ingests.map((request) => [String(object(request).request_id), request])).values()];
  const records = uniqueIngests.flatMap((request) => object(object(request).payload).records as unknown[]).map((raw) => object(raw));
  assert.equal(records.length, 52);
  assert.ok(records.every((record) => BigInt(String(record.seq)) <= live.seq));
  assert.ok(ingests.every((request) => {
    const body = object(request); const payload = object(body.payload); const batch = payload.records;
    return payload.schema_version === 1 && Array.isArray(batch) && batch.length <= 16 && Array.isArray(body.scopes) && body.scopes.length === 1 && typeof body.caller_id === 'string';
  }));
  const perRequestIds = ingests.map((request) => String(object(request).request_id));
  assert.ok(perRequestIds.some((id) => perRequestIds.filter((candidate) => candidate === id).length > 1), '429 retry must reuse the original idempotency key');
  const firstPending = object(JSON.parse(await readFile(statePath, 'utf8'))).pending as Record<string, unknown>[];
  const pendingIds = firstPending.map((task) => String(task.request_id));
  assert.equal(new Set(pendingIds).size, pendingIds.length);
  const status = await f.invoke(agentToken, 'memory.status', { scope_refs: [historical[0]!.eventRef] });
  assert.equal(status.status, 200);
  assert.equal(object(status.body.result).paused, false, '429 must back off without pausing indexing');
  assert.equal(object(status.body.result).pending, pendingIds.length);

  await f.app.stopPlugin('memory');
  const missingOnRestart = pendingIds[0]!;
  const originalPayload = JSON.stringify(firstPending.find((task) => task.request_id === missingOnRestart)!.payload);
  f.forgetOperation(missingOnRestart);
  await f.app.startPlugin('memory');
  await until(() => f.requests.some((request) => object(request).kind === 'operation' && pendingIds.includes(String(object(object(request).params).operation_id))));
  const afterRestartIngests = f.requests.filter((request) => object(request).kind === 'ingest').map((request) => String(object(request).request_id));
  assert.ok(pendingIds.every((id) => afterRestartIngests.includes(id)), 'queued tasks must retain their original request identities after restart');
  await until(() => f.missingOperationQueries.includes(missingOnRestart) && f.requests.filter((request) => object(request).kind === 'ingest' && object(request).request_id === missingOnRestart).length >= 2);
  const replayed = f.requests.find((request) => object(request).kind === 'ingest' && object(request).request_id === missingOnRestart)!;
  assert.equal(JSON.stringify(object(replayed).payload), originalPayload, '404 recovery must replay the persisted payload byte-for-byte under the same id');
  f.setOperationState('succeeded');
  await until(async () => { const state = object(JSON.parse(await readFile(statePath, 'utf8'))); return Array.isArray(state.pending) && state.pending.length === 0; });

  f.loseNextOperationResponses(2);
  const uncertain = await f.append('lost-acceptance', sourceB, '444444');
  await until(() => {
    const state = f.requests.filter((request) => object(request).kind === 'ingest');
    return state.some((request) => object(object(request).payload).records instanceof Array &&
      (object(object(request).payload).records as unknown[]).some((raw) => object(raw).seq === uncertain.seq.toString()) &&
      state.filter((candidate) => object(candidate).request_id === object(request).request_id).length >= 2);
  });
  await f.app.stopPlugin('memory');
  const uncertainTask = object(JSON.parse(await readFile(statePath, 'utf8'))).pending as Record<string, unknown>[];
  const uncertainId = String(uncertainTask.at(-1)!.request_id);
  f.setOperationState('succeeded');
  await f.app.startPlugin('memory');
  await until(async () => {
    const state = object(JSON.parse(await readFile(statePath, 'utf8')));
    return BigInt(String(state.accepted_seq)) >= uncertain.seq && Array.isArray(state.pending) && state.pending.length === 0;
  }).catch(async () => { assert.fail(JSON.stringify({ uncertain: uncertain.seq.toString(), state: JSON.parse(await readFile(statePath, 'utf8')), requests: f.requests.map((request) => ({ kind: object(request).kind, id: object(request).request_id, params: object(request).params })), contractErrors: f.contractErrors })); });
  assert.ok(f.requests.some((request) => object(request).kind === 'operation' && object(object(request).params).operation_id === uncertainId),
    'recovery must query the original uncertain operation id');
  assert.equal(f.contractErrors.length, 0, f.contractErrors.join(', '));

  await f.app.stopPlugin('memory');
  const saved = object(JSON.parse(await readFile(statePath, 'utf8')));
  const originalService = saved.service_url;
  saved.service_url = 'http://127.0.0.1:1';
  await writeFile(statePath, JSON.stringify(saved));
  await f.app.startPlugin('memory');
  assert.equal(f.app.plugins().find((plugin) => plugin.id === 'memory')?.available, false, 'changed endpoint binding must pause the plugin');
  await f.app.stopPlugin('memory');
  saved.service_url = originalService;
  saved.accepted_seq = (live.seq + 100n).toString();
  await writeFile(statePath, JSON.stringify(saved));
  await f.app.startPlugin('memory');
  assert.equal(f.app.plugins().find((plugin) => plugin.id === 'memory')?.available, false, 'cursor ahead of the event store must pause the plugin');
});

test('slow image resolution runs independently from text ingestion and persists authorized materials', async (t) => {
  const f = await fixture(t);
  f.blockResolver();
  const imageEvent = await f.append('slow-image', sourceA, '333333', true);
  await until(() => f.resolverRequests.length === 1);
  const textRequest = f.requests.find((request) => object(request).kind === 'ingest' &&
    (object(object(request).payload).records as unknown[]).some((raw) => object(raw).seq === imageEvent.seq.toString()));
  assert.ok(textRequest, 'text ingest should be accepted before waiting for image resolution');
  assert.equal(JSON.stringify(object(textRequest).payload).includes('untrusted.example'), false, 'event supplied image URLs must not reach the service');

  const later = await f.append('later-text', sourceB, '444444');
  await until(() => f.requests.some((request) => object(request).kind === 'ingest' &&
    (object(object(request).payload).records as unknown[]).some((raw) => object(raw).seq === later.seq.toString())));
  assert.equal(f.requests.some((request) => object(request).kind === 'images'), false, 'image operations wait for the resolver');
  const statePath = join(f.directory, 'data/plugins/memory/memory-state.json');
  const state = object(JSON.parse(await readFile(statePath, 'utf8')));
  assert.ok(Array.isArray(state.materials));
  const material = object(state.materials[0]);
  assert.equal(object(material.event_ref).id, imageEvent.eventRef.id);
  assert.equal(material.payload, undefined, 'the unresolved ref is durable before capability invocation completes');

  f.setImageOperationState('queued');
  f.releaseResolver();
  await until(() => f.requests.some((request) => object(request).kind === 'images'));
  const imageWrite = object(f.requests.find((request) => object(request).kind === 'images')!);
  assert.ok(f.missingOperationQueries.includes(String(imageWrite.request_id)), 'a real HTTP 404 for an unseen operation must lead to the original images POST');
  assert.equal(imageWrite.caller_id, 'memory-reader');
  assert.deepEqual(imageWrite.scopes, [sourceA]);
  const payload = object(imageWrite.payload);
  assert.deepEqual(payload.input_event_ref, imageEvent.eventRef);
  assert.deepEqual(payload.images, [{ segment_index: 1, file: 'file-slow-image', url: 'https://resolved.example/image' }]);
  assert.equal(f.contractErrors.length, 0, f.contractErrors.join(', '));
  // Already-persisted material payloads must survive the reader protocol change and restart unchanged.
  await f.app.stopPlugin('memory');
  const pending = object(JSON.parse(await readFile(statePath, 'utf8')));
  assert.ok(Array.isArray(pending.materials));
  assert.deepEqual(object(pending.materials[0]).payload, payload);
  const lookups = f.resolverRequests.length;
  const operationQueries = () => f.requests.filter((request) => request.kind === 'operation' && object(request.params).operation_id === imageWrite.request_id).length;
  const queriesBefore = operationQueries();
  await f.app.startPlugin('memory');
  await until(() => operationQueries() > queriesBefore);
  assert.equal(f.resolverRequests.length, lookups, 'accepted material must not be re-resolved under a new protocol');
  assert.equal(f.requests.filter((request) => request.kind === 'images').length, 1, 'restart must query the original accepted operation');
  f.setImageOperationState('succeeded');
  await until(async () => { const current = object(JSON.parse(await readFile(statePath, 'utf8'))); return Array.isArray(current.materials) && current.materials.length === 0; });
  assert.ok(f.requests.some((request) => object(request).kind === 'operation' && object(object(request).params).operation_id === imageWrite.request_id),
    'material task remains until its operation reports succeeded');
});

test('failed image operations are retained for status and never resubmitted', async (t) => {
  const f = await fixture(t);
  f.setImageOperationState('failed');
  await f.append('failed-image', sourceA, '333333', true);
  await until(async () => {
    const state = object(JSON.parse(await readFile(join(f.directory, 'data/plugins/memory/memory-state.json'), 'utf8')));
    return Array.isArray(state.materials) && state.materials.length > 0 && object(state.materials[0]).terminal === 'failed';
  });
  const writes = f.requests.filter((request) => object(request).kind === 'images');
  assert.equal(writes.length, 1);
  const status = await f.invoke(agentToken, 'memory.status', { scope_refs: [{ source: sourceA, id: 'message:failed-image' }] });
  assert.equal(status.status, 200);
  assert.equal((object(object(status.body).result).image_failures as unknown[]).length, 1);
  await f.app.startPlugin('admin');
  const response = await fetch(f.url + '/api/admin/panels/memory', { headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal(response.status, 200);
  const view = object(object(await response.json()).data);
  assert.equal(object(view.status).tone, 'warning');
  assert.equal(object(view.data).image_failure_count, 1);
  await delay(300);
  assert.equal(f.requests.filter((request) => object(request).kind === 'images').length, 1, 'terminal failure must not trigger periodic writes');
});

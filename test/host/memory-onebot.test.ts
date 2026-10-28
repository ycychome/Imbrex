import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { Host } from '../../src/host/host.js';
import { parseConfig } from '../../src/host/config.js';
import { loadModules } from '../../src/host/modules.js';
import { object } from '../../src/core/validation.js';

const groupSource = 'imbrex://qq/123456/main/group/987654';
const privateSource = 'imbrex://qq/123456/main/private/654321';
const serviceToken = 'fixture-memory-service-token';

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for OneBot and Memory fixture');
}

test('Memory reads OneBot images through scoped get_message and drops untrusted material while retaining text', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-memory-onebot-'));
  const envKeys = ['IMBREX_QQ_AGENT_TOKEN', 'IMBREX_OPERATOR_TOKEN', 'MEMORY_SERVICE_TOKEN', 'UNTRUSTED_READER_TOKEN'];
  const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.IMBREX_QQ_AGENT_TOKEN = 'fixture-qq-agent-token';
  process.env.IMBREX_OPERATOR_TOKEN = 'fixture-operator-token';
  process.env.MEMORY_SERVICE_TOKEN = serviceToken;

  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => ws.once('listening', resolve));
  const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
  const remoteMessages = new Map<number, unknown>();
  ws.on('connection', (socket) => socket.on('message', (wire) => {
    const request = object(JSON.parse(wire.toString()));
    const params = object(request.params);
    const respond = (data: unknown) => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: request.echo }));
    if (request.action === 'get_login_info') { respond({ user_id: 123456, nickname: 'fixture-bot' }); return; }
    if (request.action === 'get_version_info') { respond({ app_name: 'fixture-onebot', protocol_version: 'v11' }); return; }
    actions.push({ action: String(request.action), params });
    if (request.action === 'get_msg') { respond(remoteMessages.get(Number(params.message_id))); return; }
    respond(null);
  }));

  const operationBodies: Record<string, unknown>[] = [];
  const queryBodies: Record<string, unknown>[] = [];
  const materialBodies: Record<string, unknown>[] = [];
  const acceptedOperations = new Set<string>();
  const service = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : {};
    const result: Record<string, unknown> = {};
    if (request.url === '/health') Object.assign(result, { ready: true, ledger_id: 'a'.repeat(64) });
    else if (request.url === '/v1/operations') {
      operationBodies.push(body);
      acceptedOperations.add(String(body.request_id));
      if (body.kind === 'images') materialBodies.push(body);
      Object.assign(result, { operation_id: body.request_id, state: 'succeeded', accepted: true, applied: true, result: {} });
    } else if (request.url === '/v1/query') {
      queryBodies.push(body);
      const params = object(body.params);
      if (body.kind === 'operation' && !acceptedOperations.has(String(params.operation_id))) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
        return;
      }
      Object.assign(result, { operation_id: params.operation_id, state: 'succeeded', accepted: true, applied: true });
    } else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const serviceAddress = service.address();
  assert.ok(serviceAddress && typeof serviceAddress === 'object');

  let app: Host | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      service.closeAllConnections();
      await new Promise<void>((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
      for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(directory, { recursive: true, force: true });
    }
  });

  const raw = object(JSON.parse(await readFile(new URL('../../../examples/onebot/imbrex.json', import.meta.url), 'utf8')));
  raw.data_dir = join(directory, 'data');
  assert.ok(Array.isArray(raw.plugins));
  const plugins = raw.plugins.map((value) => object(value));
  object(plugins.find((value) => value.id === 'http')!.config).port = 0;
  const qq = object(plugins.find((value) => value.id === 'qq-main')!.config);
  qq.ws_url = 'ws://127.0.0.1:' + (ws.address() as { port: number }).port + '/';
  qq.allow_private_ids = ['654321'];
  qq.allow_group_ids = ['987654'];

  assert.ok(Array.isArray(raw.principals));
  raw.principals.push(
    { id: 'memory-reader', permissions: ['events:read', 'capabilities:invoke'], read_sources: [{ exact: groupSource }, { exact: privateSource }], write_sources: [], invoke_capabilities: ['qq-main.get_message'] },
    { id: 'untrusted-reader', token_env: 'UNTRUSTED_READER_TOKEN', permissions: ['events:read', 'capabilities:invoke'], read_sources: [{ exact: privateSource }], write_sources: [], invoke_capabilities: ['qq-main.get_message'] },
  );
  process.env.UNTRUSTED_READER_TOKEN = 'fixture-untrusted-reader-token';
  raw.plugins.push({ id: 'memory', module: 'builtin:memory', principal_id: 'memory-reader', required: true, enabled: true,
    config: { service_url: `http://127.0.0.1:${serviceAddress.port}`, service_token_env: 'MEMORY_SERVICE_TOKEN', sources: [groupSource, privateSource],
      message_readers: { 'imbrex://qq/123456/main/': 'qq-main.get_message' }, request_timeout_ms: 1000, poll_ms: 100, batch_wait_ms: 0 } });

  const filename = join(directory, 'config.json');
  const config = parseConfig(raw, filename, process.env);
  app = await Host.open(config, await loadModules(config, filename));
  const storeId = (await app.info()).storeId;
  const broadcast = (event: unknown) => { for (const socket of ws.clients) socket.send(JSON.stringify(event)); };
  const ready = () => app!.plugins().find((plugin) => plugin.id === 'qq-main')?.available === true;
  await until(ready);

  const send = async (token: string, capability: string, params: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${app!.port}/v1/capabilities/${capability}/invoke`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, params }),
    });
    return { status: response.status, body: object(await response.json()) };
  };
  const event = (type: 'group' | 'private', id: number, peer: number, file: string, url: string) => ({
    time: 1780000000, self_id: 123456, post_type: 'message', message_type: type, sub_type: type === 'group' ? 'normal' : 'friend',
    message_id: id, ...(type === 'group' ? { group_id: 987654, user_id: peer } : { user_id: peer }),
    message: [{ type: 'text', data: { text: `body-${id}` } }, { type: 'image', data: { file, url } }],
    sender: { user_id: peer },
  });
  const remote = (type: 'group' | 'private', id: number, peer: number, segments: unknown[], overrides: Record<string, unknown> = {}) => ({
    message_id: id, message_type: type, ...(type === 'group' ? { group_id: 987654 } : { user_id: peer, target_id: 123456 }),
    sender: { user_id: peer }, time: 1780000000, message: segments, ...overrides,
  });
  const materialCount = () => materialBodies.length;
  const emit = async (fixture: ReturnType<typeof event>, response: unknown) => {
    const id = Number(fixture.message_id);
    remoteMessages.set(id, response);
    const before = materialCount();
    broadcast(fixture);
    await until(() => materialCount() > before || actions.some((item) => item.action === 'get_msg' && Number(item.params.message_id) === id));
    await until(() => actions.some((item) => item.action === 'get_msg' && Number(item.params.message_id) === id));
    try { await until(() => materialCount() > before); }
    catch { assert.fail(JSON.stringify({ id, actions, operations: operationBodies, queries: queryBodies })); }
  };

  // Both event classes are generated by the real OneBot event mapper. The sender has no nickname/card field.
  const group = event('group', -42, 654321, 'group-image', 'https://images.example/group.png');
  const privateMessage = event('private', 73, 654321, 'private-image', 'https://images.example/private.png');
  await emit(group, remote('group', -42, 654321, group.message, { group_id: 987654 }));
  await emit(privateMessage, remote('private', 73, 654321, privateMessage.message));
  const multiple = { ...event('group', 74, 654321, 'first-image', 'https://images.example/first.png'),
    message: [{ type: 'text', data: { text: 'body-74' } }, { type: 'image', data: { file: 'first-image', url: 'https://images.example/first.png' } },
      { type: 'image', data: { file: 'second-image', url: 'https://images.example/second.png' } }] };
  await emit(multiple, remote('group', 74, 654321, multiple.message, { group_id: 987654 }));
  const goodImages = materialBodies.map((body) => object(body.payload).images as unknown[]);
  assert.equal(materialBodies.length, 3);
  assert.deepEqual(object((goodImages[0] as unknown[])[0]).url, 'https://images.example/group.png');
  assert.deepEqual(object((goodImages[1] as unknown[])[0]).url, 'https://images.example/private.png');
  assert.deepEqual((goodImages[2] as unknown[]).map((value) => object(value).url), ['https://images.example/first.png', 'https://images.example/second.png']);

  const getActions = actions.filter((item) => item.action === 'get_msg');
  assert.deepEqual(getActions.slice(0, 3).map((item) => item.params), [{ message_id: -42 }, { message_id: 73 }, { message_id: 74 }]);
  assert.ok(queryBodies.some((body) => body.kind === 'operation'));
  assert.ok(operationBodies.some((body) => body.kind === 'ingest'));
  for (const body of operationBodies.filter((item) => item.kind === 'ingest')) {
    const record = object((object(body.payload).records as unknown[])[0]);
    assert.equal(record.sender_nickname, undefined);
    assert.equal(record.sender_card, undefined);
  }

  // The configured Memory principal can read only the explicitly granted source; an unrelated caller cannot borrow its grant.
  const noCapability = await send('fixture-qq-agent-token', 'qq-main.get_message', {
    target: { type: 'group', id: '987654' }, message_id: '-42', input_event_ref: { source: groupSource, id: 'message:-42' },
  });
  assert.equal(noCapability.status, 403);
  const beforeDenied = actions.filter((item) => item.action === 'get_msg').length;
  const crossScope = await send('fixture-untrusted-reader-token', 'qq-main.get_message', {
    target: { type: 'group', id: '987654' }, message_id: '-42', input_event_ref: { source: groupSource, id: 'message:-42' },
  });
  assert.equal(crossScope.status, 403);
  assert.equal(actions.filter((item) => item.action === 'get_msg').length, beforeDenied);

  // Returned identity/target/segment metadata must match the event before a URL reaches the Memory service.
  const badResponses: Array<{ id: number; type: 'group' | 'private'; peer: number; segments: unknown[]; override?: Record<string, unknown> }> = [
    { id: 81, type: 'group', peer: 654321, segments: [{ type: 'image', data: { file: 'bad-81', url: 'https://images.example/81.png' } }], override: { sender: { user_id: 999999 } } },
    { id: 82, type: 'group', peer: 654321, segments: [{ type: 'image', data: { file: 'bad-82', url: 'https://images.example/82.png' } }], override: { message_id: 999 } },
    { id: 83, type: 'group', peer: 654321, segments: [{ type: 'image', data: { file: 'bad-83', url: 'https://images.example/83.png' } }], override: { group_id: 111111 } },
    { id: 84, type: 'group', peer: 654321, segments: [{ type: 'image', data: { file: 'different-file', url: 'https://images.example/84.png' } }] },
    { id: 85, type: 'group', peer: 654321, segments: [{ type: 'text', data: { text: 'no image here' } }] },
    { id: 86, type: 'private', peer: 654321, segments: [{ type: 'image', data: { file: 'bad-86', url: 'https://images.example/86.png' } }], override: { target_id: 999999 } },
  ];
  for (const bad of badResponses) {
    const input = event(bad.type, bad.id, bad.peer, `bad-${bad.id}`, `https://images.example/${bad.id}.png`);
    const before = materialCount();
    remoteMessages.set(bad.id, remote(bad.type, bad.id, bad.peer, bad.segments, bad.override));
    broadcast(input);
    await until(() => actions.some((item) => item.action === 'get_msg' && Number(item.params.message_id) === bad.id));
    await until(() => operationBodies.some((body) => body.kind === 'ingest' && JSON.stringify(body).includes(`body-${bad.id}`)));
    await until(() => materialCount() > before);
    const materialImages = object(materialBodies.at(-1)!.payload).images as unknown[];
    const material = object(materialImages[0]);
    assert.equal(material.url, undefined, `bad get_message response ${bad.id} must not send a material URL`);
  }

  // Even structurally matched segments must not forward credentialed or non-HTTP URLs.
  for (const [id, url] of [[91, 'https://user:pass@images.example/a.png'], [92, 'file:///tmp/local.png']] as const) {
    const input = event('group', id, 654321, `bad-${id}`, url);
    const segments = [{ type: 'image', data: { file: `bad-${id}`, url } }];
    const before = materialCount();
    remoteMessages.set(id, remote('group', id, 654321, segments));
    broadcast(input);
    await until(() => actions.some((item) => item.action === 'get_msg' && Number(item.params.message_id) === id));
    await until(() => materialCount() > before);
    const materialImages = object(materialBodies.at(-1)!.payload).images as unknown[];
    const material = object(materialImages[0]);
    assert.equal(material.url, undefined, `unsafe URL ${id} must not reach Memory service`);
    assert.ok(operationBodies.some((body) => body.kind === 'ingest' && JSON.stringify(body).includes(`body-${id}`)), 'text ingest must continue when image lookup or URL validation fails');
  }
});

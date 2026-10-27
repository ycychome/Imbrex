import assert from 'node:assert/strict';
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
import { numericFixture } from '../../examples/onebot/fixtures.js';

const names = ['reply', 'get_login_info', 'get_connection_status', 'list_groups', 'get_group_info', 'list_group_members', 'get_group_member_info', 'list_friends', 'get_user_info', 'get_message', 'get_reply_context', 'get_forward_message', 'get_group_history', 'get_private_history', 'send_message', 'revoke_message', 'set_member_mute', 'kick_member', 'set_member_card', 'set_group_name', 'handle_friend_request', 'handle_group_request'];
const sourceA = 'imbrex://qq/123456/main/group/987654';
const sourceB = 'imbrex://qq/123456/main/group/111111';
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 150; i += 1) { if (await check()) return; await delay(20); } assert.fail('condition did not become true'); }

async function fixture(t: TestContext, appName: string | null = 'fixture') {
  const directory = await mkdtemp(join(tmpdir(), 'imbrex-qq-cap-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const state = { actions: [] as { action: string; params: Record<string, unknown> }[], sends: 0, memberCount: 1200, botRole: 'admin', targetRole: 'member', mode: 'ok',
    appName, messages: new Map<number, unknown>(), forwards: new Map<string, unknown>(), history: [] as unknown[] };
  server.on('connection', (socket) => socket.on('message', (wire) => {
    const request = object(JSON.parse(wire.toString())), params = object(request.params);
    const respond = (data: unknown, status = 'ok', retcode = 0) => socket.send(JSON.stringify({ status, retcode, data, echo: request.echo }));
    if (request.action === 'get_login_info') { respond({ user_id: 123456, nickname: 'fixture-bot' }); return; }
    if (request.action === 'get_version_info') { respond({ ...(state.appName === null ? {} : { app_name: state.appName }), protocol_version: 'v11' }); return; }
    state.actions.push({ action: String(request.action), params });
    if (request.action === 'get_group_list') { respond([{ group_id: 111111, group_name: 'secret-group' }, { group_id: 987654, group_name: 'visible' }]); return; }
    if (request.action === 'get_friend_list') { respond([{ user_id: 654321, nickname: 'friend', remark: '' }, { user_id: 111111, nickname: 'hidden' }]); return; }
    if (request.action === 'get_group_info') { respond({ group_id: params.group_id, group_name: 'fixture', member_count: state.memberCount, max_member_count: 2000 }); return; }
    if (request.action === 'get_group_member_list') { respond(Array.from({ length: state.memberCount }, (_, i) => ({ group_id: params.group_id, user_id: i + 1000000, nickname: 'n'.repeat(80), card: '', role: 'member' }))); return; }
    if (request.action === 'get_group_member_info') { respond({ group_id: params.group_id, user_id: params.user_id, nickname: 'member', card: '', role: params.user_id === 123456 ? state.botRole : state.targetRole, join_time: 1 }); return; }
    if (request.action === 'get_stranger_info') { respond({ user_id: params.user_id, nickname: 'friend', sex: 'unknown', age: 20 }); return; }
    if (request.action === 'get_msg') { respond(state.messages.get(Number(params.message_id))); return; }
    if (request.action === 'get_forward_msg') { respond({ messages: state.forwards.get(String(params.id)) ?? [] }); return; }
    if (request.action === 'get_group_msg_history' || request.action === 'get_friend_msg_history') { respond({ messages: state.history }); return; }
    if (state.mode === 'disconnect') { socket.terminate(); return; }
    if (state.mode === 'hold') return;
    if (state.mode === 'async') { respond(null, 'async', 1); return; }
    if (state.mode === 'reject') { respond(null, 'failed', 1403); return; }
    if (String(request.action).startsWith('send_')) {
      state.sends += 1;
      const id = 1000 + state.sends, group = request.action === 'send_group_msg';
      state.messages.set(id, { message_id: id, message_type: group ? 'group' : 'private', ...(group ? { group_id: params.group_id } : { user_id: 123456, target_id: params.user_id }), sender: { user_id: 123456 }, time: 1, message: params.message });
      respond({ message_id: id }); return;
    }
    respond(null);
  }));
  const raw = object(JSON.parse(await readFile(new URL('../../../examples/onebot/imbrex.json', import.meta.url), 'utf8')));
  raw.data_dir = directory; raw.external_writes_enabled = true;
  const plugins = (raw.plugins as unknown[]).map((item) => object(item));
  object(plugins.find((item) => item.id === 'http')!.config).port = 0;
  const qq = object(plugins.find((item) => item.id === 'qq-main')!.config);
  qq.ws_url = 'ws://127.0.0.1:' + (server.address() as { port: number }).port + '/';
  qq.allow_group_ids = ['987654', '111111'];
  const identities = (raw.principals as unknown[]).map((item) => object(item));
  const agent = identities.find((item) => item.id === 'qq-agent')!;
  agent.read_sources = [{ exact: sourceA }, { exact: 'imbrex://qq/123456/main/private/654321' }];
  agent.invoke_capabilities = names.map((name) => 'qq-main.' + name);
  (raw.principals as unknown[]).push({ id: 'other', token_env: 'OTHER_TOKEN', permissions: agent.permissions, read_sources: [{ exact: sourceB }], write_sources: [], invoke_capabilities: agent.invoke_capabilities });
  const filename = join(directory, 'config.json');
  const config = parseConfig(raw, filename, { IMBREX_QQ_AGENT_TOKEN: 'fixture-agent', IMBREX_OPERATOR_TOKEN: 'fixture-operator', OTHER_TOKEN: 'fixture-other' });
  const app = await Host.open(config, await loadModules(config, filename));
  t.after(async () => { await app.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const ready = () => app.plugins().find((item) => item.id === 'qq-main')?.available === true;
  await until(ready);
  const storeId = (await app.info()).storeId;
  const invoke = async (name: string, params: unknown, callId?: string, token = 'fixture-agent') => {
    const response = await fetch('http://127.0.0.1:' + app.port + '/v1/capabilities/qq-main.' + name + '/invoke', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ store_id: storeId, params, ...(callId === undefined ? {} : { call_id: callId }) }) });
    return { status: response.status, body: object(await response.json()) };
  };
  const broadcast = (event: unknown) => { for (const socket of server.clients) socket.send(JSON.stringify(event)); };
  return { app, state, server, config, invoke, broadcast, ready };
}

test('QQ directory and large member queries filter exact source grants before live pagination', async (t) => {
  const f = await fixture(t);
  const groups = await f.invoke('list_groups', {});
  assert.equal(groups.status, 200);
  assert.deepEqual(object(groups.body.result).items, [{ group_id: '987654', group_name: 'visible' }]);
  assert.equal(object(groups.body.result).total, 1);
  const first = object((await f.invoke('list_group_members', { group_id: '987654', limit: 50 })).body.result);
  assert.equal((first.items as unknown[]).length, 50); assert.equal(first.total, 1200); assert.equal(first.next_offset, 50);
  const second = object((await f.invoke('list_group_members', { group_id: '987654', offset: 50, limit: 50 })).body.result);
  assert.notDeepEqual(first.items, second.items); assert.equal(second.next_offset, 100);
  const count = f.state.actions.length;
  assert.equal((await f.invoke('get_group_info', { group_id: '111111' })).status, 403);
  assert.equal(f.state.actions.length, count, 'denied target must not reach OneBot');
});

test('send and revoke bind confirmed message proofs to the original source and preserve unknown call IDs', async (t) => {
  const f = await fixture(t);
  const send = (type: string, id: string) => ({ target: { type, id }, segments: [{ type: 'text', data: { text: 'fixture' } }] });
  const sentB = object((await f.invoke('send_message', send('group', '111111'), 'send-b', 'fixture-other')).body.call);
  assert.equal(sentB.status, 'succeeded');
  const idB = object(sentB.result).native_message_id;
  assert.equal(object((await f.invoke('revoke_message', { target: { type: 'group', id: '987654' }, message_id: idB }, 'cross-revoke')).body.call).status, 'failed');
  assert.ok(!f.state.actions.some((item) => item.action === 'delete_msg'));
  const sentA = object((await f.invoke('send_message', send('group', '987654'), 'send-a')).body.call);
  const idA = object(sentA.result).native_message_id;
  assert.equal(object((await f.invoke('revoke_message', { target: { type: 'group', id: '987654' }, message_id: idA }, 'revoke-a')).body.call).status, 'succeeded');
  f.state.mode = 'async';
  const unknown = object((await f.invoke('send_message', send('group', '987654'), 'uncertain')).body.call);
  assert.equal(unknown.status, 'unknown');
  const count = f.state.actions.length;
  assert.deepEqual((await f.invoke('send_message', send('group', '987654'), 'uncertain')).body.call, unknown);
  assert.equal(f.state.actions.length, count);
  f.state.mode = 'ok'; await f.app.stopPlugin('qq-main'); await f.app.startPlugin('qq-main'); await until(f.ready);
  assert.equal(object((await f.invoke('revoke_message', { target: { type: 'group', id: '987654' }, message_id: idA }, 'after-restart')).body.call).status, 'failed');
});

test('SnowLuma revocation is unavailable in discovery and rejected before dispatch while other QQ capabilities remain usable', async (t) => {
  for (const appName of ['SnowLuma', null]) await t.test(appName ?? 'unidentified implementation', async (t) => {
    const f = await fixture(t, appName);
    const response = await fetch('http://127.0.0.1:' + f.app.port + '/v1/capabilities', { headers: { authorization: 'Bearer fixture-agent' } });
    const capabilities = object(await response.json()).capabilities as unknown[];
    assert.equal(capabilities.length, 21); assert.ok(!capabilities.some((item) => object(item).id === 'qq-main.revoke_message'));
    assert.equal((await f.invoke('revoke_message', { target: { type: 'group', id: '987654' }, message_id: '100' }, 'unsupported-revoke')).status, 503);
    assert.equal(f.state.actions.length, 0);
    const status = object((await f.invoke('get_connection_status', {})).body.result);
    assert.deepEqual(object(status.capability_limits).revoke_message, { available: false, reason: 'onebot_revoke_unsafe_message_identity' });
    assert.equal(object((await f.invoke('send_message', { target: { type: 'group', id: '987654' }, segments: [{ type: 'text', data: { text: 'fixture' } }] }, 'safe-send')).body.call).status, 'succeeded');
  });
});

test('a reconnect without implementation metadata cannot inherit an earlier revocation grant', async (t) => {
  const f = await fixture(t);
  const target = { type: 'group', id: '987654' };
  const sent = object((await f.invoke('send_message', { target, segments: [{ type: 'text', data: { text: 'fixture' } }] }, 'before-reconnect')).body.call);
  assert.equal(sent.status, 'succeeded');
  f.state.appName = null;
  for (const socket of f.server.clients) socket.terminate();
  await until(() => !f.ready()); await until(f.ready);
  const response = await fetch('http://127.0.0.1:' + f.app.port + '/v1/capabilities', { headers: { authorization: 'Bearer fixture-agent' } });
  const capabilities = object(await response.json()).capabilities as unknown[];
  assert.ok(!capabilities.some((item) => object(item).id === 'qq-main.revoke_message'));
  const status = object((await f.invoke('get_connection_status', {})).body.result);
  assert.equal(object(status.binding).app_name, 'fixture');
  assert.deepEqual(object(status.capability_limits).revoke_message, { available: false, reason: 'onebot_revoke_unsafe_message_identity' });
  assert.equal((await f.invoke('revoke_message', { target, message_id: object(sent.result).native_message_id }, 'after-reconnect')).status, 503);
  assert.ok(!f.state.actions.some((item) => item.action === 'delete_msg'));
});

test('trusted message, forward and media references retain their account/source binding', async (t) => {
  const f = await fixture(t);
  f.broadcast({ ...numericFixture, message: [{ type: 'at', data: { qq: '654321' } }, { type: 'image', data: { file: 'fixture.jpg', url: 'https://example.invalid/image' } }, { type: 'forward', data: { id: 'forward-a' } }] });
  await until(async () => (await f.app.info()).latestSeq === 1n);
  const ref = { source: sourceA, id: 'message:-42' };
  f.state.forwards.set('forward-a', Array.from({ length: 51 }, () => ({ sender: { user_id: 654321, nickname: 'fixture' }, time: 1, message: [{ type: 'text', data: { text: 'node' } }] })));
  const forwarded = object((await f.invoke('get_forward_message', { input_event_ref: ref, segment_index: 2 })).body.result);
  assert.equal((forwarded.nodes as unknown[]).length, 50); assert.equal(forwarded.truncated, true); assert.equal(forwarded.has_more, false);
  const count = f.state.actions.length;
  assert.equal((await f.invoke('get_forward_message', { input_event_ref: { ...ref, source: sourceB }, segment_index: 2 })).status, 403);
  assert.equal(f.state.actions.length, count);
  assert.equal(object((await f.invoke('send_message', { target: { type: 'group', id: '987654' }, segments: [{ type: 'image', data: { input_event_ref: ref, segment_index: 1 } }] }, 'image-send')).body.call).status, 'succeeded');
  const sent = f.state.actions.findLast((item) => item.action === 'send_group_msg')!;
  assert.deepEqual(sent.params.message, [{ type: 'image', data: { file: 'https://example.invalid/image' } }]);
  const bad = await f.invoke('send_message', { target: { type: 'group', id: '987654' }, segments: [{ type: 'image', data: { url: 'file:///private-fixture' } }] }, 'bad-image');
  assert.equal(object(bad.body.call).status, 'failed');
  f.state.messages.set(100, { message_id: 100, message_type: 'group', group_id: 111111, sender: { user_id: 654321 }, time: 1, message: 'secret-message' });
  const cross = await f.invoke('get_message', { target: { type: 'group', id: '987654' }, message_id: '100' });
  assert.equal(cross.status, 403); assert.ok(!JSON.stringify(cross.body).includes('secret-message'));
  f.broadcast({ ...numericFixture, message_id: 51, message: [{ type: 'image', data: { url: 'https://fixture-user:fixture-pass@example.invalid/image' } }] });
  await until(async () => (await f.app.info()).latestSeq === 2n);
  const before = f.state.actions.length;
  const credentialed = await f.invoke('send_message', { target: { type: 'group', id: '987654' }, segments: [{ type: 'image', data: { input_event_ref: { source: sourceA, id: 'message:51' }, segment_index: 0 } }] }, 'credentialed-image');
  assert.equal(object(credentialed.body.call).status, 'failed'); assert.equal(f.state.actions.length, before);
  for (const data of [{}, { url: 'https://example.invalid/image', input_event_ref: ref, segment_index: 1 }]) {
    assert.equal((await f.invoke('send_message', { target: { type: 'group', id: '987654' }, segments: [{ type: 'image', data }] }, 'invalid-image-shape')).status, 400);
  }
  assert.equal(f.state.actions.length, before);
});

test('native message ID reassignment cannot override sender/source proof or explicit private target metadata', async (t) => {
  const f = await fixture(t);
  const group = { type: 'group', id: '987654' }, peer = { type: 'private', id: '654321' };
  const sent = object((await f.invoke('send_message', { target: group, segments: [{ type: 'text', data: { text: 'fixture' } }] }, 'collision-send')).body.call);
  const id = String(object(sent.result).native_message_id);
  f.state.messages.set(Number(id), { message_id: Number(id), message_type: 'group', group_id: 111111, sender: { user_id: 222222 }, time: 1, message: 'foreign-message' });
  const rejected = object((await f.invoke('revoke_message', { target: group, message_id: id }, 'collision-revoke')).body.call);
  assert.equal(rejected.status, 'failed'); assert.ok(!f.state.actions.some((item) => item.action === 'delete_msg'));
  f.state.messages.set(Number(id), { message_id: Number(id), message_type: 'group', group_id: 987654, sender: { user_id: 222222 }, time: 1, message: 'other-sender' });
  assert.equal(object((await f.invoke('revoke_message', { target: group, message_id: id }, 'sender-revoke')).body.call).status, 'failed');
  const privateSend = object((await f.invoke('send_message', { target: peer, segments: [{ type: 'text', data: { text: 'fixture' } }] }, 'private-send')).body.call);
  const privateId = String(object(privateSend.result).native_message_id);
  f.state.messages.set(Number(privateId), { message_id: Number(privateId), message_type: 'private', user_id: 123456, target_id: 222222, sender: { user_id: 123456 }, time: 1, message: 'private-secret' });
  const cross = await f.invoke('get_message', { target: peer, message_id: privateId });
  assert.equal(cross.status, 403); assert.ok(!JSON.stringify(cross.body).includes('private-secret'));
  assert.equal(object((await f.invoke('revoke_message', { target: peer, message_id: privateId }, 'private-revoke')).body.call).status, 'failed');
  f.broadcast({ ...numericFixture, message_id: Number(id), group_id: 111111, user_id: 222222 });
  await until(async () => (await f.app.info()).latestSeq === 1n);
  f.state.messages.set(Number(id), { message_id: Number(id), message_type: 'group', group_id: 987654, sender: { user_id: 123456 }, time: 1, message: 'restored' });
  assert.equal(object((await f.invoke('revoke_message', { target: group, message_id: id }, 'observed-collision')).body.call).status, 'failed');
});

test('outgoing private facts use the verified peer rather than the sender account', async (t) => {
  const f = await fixture(t);
  f.broadcast({ ...numericFixture, message_type: 'private', sub_type: 'friend', user_id: 123456, target_id: 654321, message: [{ type: 'text', data: { text: 'outbound fixture' } }] });
  await until(async () => (await f.app.info()).latestSeq === 1n);
  const response = await fetch('http://127.0.0.1:' + f.app.port + '/v1/events?store_id=' + (await f.app.info()).storeId + '&after_seq=0', { headers: { authorization: 'Bearer fixture-agent' } });
  const page = object(await response.json()), record = object((page.records as unknown[])[0]), event = object(record.event);
  assert.equal(event.source, 'imbrex://qq/123456/main/private/654321');
  assert.equal(object(event.data).direction, 'outbound');
  assert.equal(object((await f.invoke('reply', { input_event_ref: { source: event.source, id: event.id }, text: 'must not reply' }, 'outbound-reply')).body.call).status, 'failed');
  assert.equal(f.state.actions.length, 0);
});

test('request facts deduplicate under exact conversation grants, require explicit approval and never enlarge chat scope', async (t) => {
  const f = await fixture(t);
  const event = { self_id: 123456, post_type: 'request', request_type: 'group', sub_type: 'add', group_id: 987654, user_id: 654321, flag: 'fixture-flag', comment: 'fixture-request', time: 1 };
  f.broadcast(event); await until(async () => (await f.app.info()).latestSeq === 1n);
  f.broadcast(event); await delay(30); assert.equal((await f.app.info()).latestSeq, 1n);
  const response = await fetch('http://127.0.0.1:' + f.app.port + '/v1/events?store_id=' + (await f.app.info()).storeId + '&after_seq=0', { headers: { authorization: 'Bearer fixture-agent' } });
  const page = object(await response.json()), record = object((page.records as unknown[])[0]), fact = object(record.event);
  assert.equal(fact.source, sourceA); assert.equal(fact.type, 'qq.request.group');
  const ref = { source: fact.source, id: fact.id };
  assert.equal((await f.invoke('handle_group_request', { input_event_ref: ref }, 'missing-approve')).status, 400);
  const handled = await f.invoke('handle_group_request', { input_event_ref: ref, approve: false, reason: 'fixture rejection' }, 'explicit-reject');
  assert.equal(object(handled.body.call).status, 'succeeded');
  assert.deepEqual(f.state.actions.find((item) => item.action === 'set_group_add_request')!.params, { flag: 'fixture-flag', approve: false, sub_type: 'add', reason: 'fixture rejection' });
  const before = f.state.actions.length;
  assert.equal(object((await f.invoke('handle_group_request', { input_event_ref: { ...ref, source: sourceB }, approve: true }, 'wrong-request')).body.call).status, 'failed');
  assert.equal(f.state.actions.length, before);
  f.broadcast({ ...event, request_type: 'friend', user_id: 222222 }); await delay(30); assert.equal((await f.app.info()).latestSeq, 1n);
  assert.deepEqual(f.config.plugins.find((item) => item.id === 'qq-main')!.config.allow_group_ids, ['987654', '111111']);
});

test('forward depth and byte budgets mark incomplete trees without promising nonexistent pages', async (t) => {
  const f = await fixture(t);
  f.broadcast({ ...numericFixture, message: [{ type: 'forward', data: { id: 'depth-1' } }] });
  await until(async () => (await f.app.info()).latestSeq === 1n);
  const params = { input_event_ref: { source: sourceA, id: 'message:-42' }, segment_index: 0 };
  for (let i = 1; i <= 4; i += 1) f.state.forwards.set('depth-' + i, [{ sender: { user_id: 654321 }, time: 1, message: [{ type: 'forward', data: { id: 'depth-' + (i + 1) } }] }]);
  const depth = object((await f.invoke('get_forward_message', params)).body.result);
  assert.equal(depth.truncated, true); assert.equal(depth.truncation_reason, 'depth_limit'); assert.equal(depth.has_more, false);
  assert.equal(f.state.actions.filter((item) => item.action === 'get_forward_msg').length, 3);
  f.state.forwards.set('depth-1', Array.from({ length: 5 }, () => ({ sender: { user_id: 654321 }, time: 1, message: [{ type: 'text', data: { text: 'x'.repeat(20000) } }] })));
  const bytes = object((await f.invoke('get_forward_message', params)).body.result);
  assert.equal(bytes.truncated, true); assert.equal(bytes.truncation_reason, 'byte_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(bytes)) <= 65536);
});

test('oversized upstream messages close only the connection and keep dispatched write outcomes unknown without resending', async (t) => {
  const f = await fixture(t);
  f.state.mode = 'hold';
  const params = { target: { type: 'group', id: '987654' }, segments: [{ type: 'text', data: { text: 'fixture' } }] };
  const sending = f.invoke('send_message', params, 'oversized-write');
  await until(() => f.state.actions.some((item) => item.action === 'send_group_msg'));
  f.state.memberCount = 6000;
  assert.equal((await f.invoke('list_group_members', { group_id: '987654' })).status, 503);
  const unknown = object((await sending).body.call);
  assert.equal(unknown.status, 'unknown');
  f.state.memberCount = 1200; f.state.mode = 'ok'; await until(f.ready);
  assert.deepEqual((await f.invoke('send_message', params, 'oversized-write')).body.call, unknown);
  assert.equal(f.state.actions.filter((item) => item.action === 'send_group_msg').length, 1);
  assert.equal((await f.invoke('get_group_info', { group_id: '987654' })).status, 200);
});

test('group writes verify platform roles, exact action parameters and project input budgets before dispatch', async (t) => {
  const f = await fixture(t);
  f.state.botRole = 'member';
  const denied = await f.invoke('kick_member', { group_id: '987654', user_id: '654321' }, 'not-admin');
  assert.equal(object(denied.body.call).status, 'failed'); assert.ok(!f.state.actions.some((item) => item.action === 'set_group_kick'));
  f.state.botRole = 'admin'; f.state.targetRole = 'owner';
  assert.equal(object((await f.invoke('set_member_mute', { group_id: '987654', user_id: '654321', duration_seconds: 10 }, 'owner-mute')).body.call).status, 'failed');
  f.state.targetRole = 'member';
  for (const [name, params, action, expected] of [
    ['set_member_mute', { group_id: '987654', user_id: '654321', duration_seconds: 0 }, 'set_group_ban', { group_id: 987654, user_id: 654321, duration: 0 }],
    ['kick_member', { group_id: '987654', user_id: '654321' }, 'set_group_kick', { group_id: 987654, user_id: 654321, reject_add_request: false }],
    ['set_member_card', { group_id: '987654', user_id: '654321', card: '' }, 'set_group_card', { group_id: 987654, user_id: 654321, card: '' }],
    ['set_group_name', { group_id: '987654', name: 'fixture name' }, 'set_group_name', { group_id: 987654, group_name: 'fixture name' }],
  ] as const) {
    assert.equal(object((await f.invoke(name, params, name)).body.call).status, 'succeeded');
    assert.deepEqual(f.state.actions.findLast((item) => item.action === action)!.params, expected);
  }
  const count = f.state.actions.filter((item) => item.action === 'set_group_card').length;
  assert.equal(object((await f.invoke('set_member_card', { group_id: '987654', user_id: '654321', card: '汉'.repeat(21) }, 'card-bytes')).body.call).status, 'failed');
  assert.equal(f.state.actions.filter((item) => item.action === 'set_group_card').length, count);
});

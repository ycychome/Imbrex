import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { object } from '../../src/core/validation.js';
import { consumerLimits } from '../../src/plugins/agent-chat/config.js';

const directory = process.env.IMBREX_FAKE_AGENT_DIR!;
const stateFile = process.env.IMBREX_FAKE_STATE_FILE!;
const logFile = join(directory, 'agent.jsonl');
const sessionFile = join(directory, 'sessions.json');
const loaded = new Set<string>();
let known: string[] = [];
try { known = JSON.parse(readFileSync(sessionFile, 'utf8')) as string[]; } catch {}
const control = () => { try { return object(JSON.parse(readFileSync(join(directory, 'control.json'), 'utf8'))); } catch { return {}; } };
const log = (event: string, value: Record<string, unknown> = {}) => appendFileSync(logFile, JSON.stringify({ event, ...value }) + '\n');
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id: unknown, value: unknown) => send({ jsonrpc: '2.0', id, result: value });
const failure = (id: unknown) => send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'fixture failure' } });
const pending = new Map<string, (message: Record<string, unknown>) => void>();
let descendant: ChildProcess | undefined;
let rpcId = 0;
const selectedModels = new Map<string, string>();

log('boot', { pid: process.pid, parent: process.ppid, operator_token_present: process.env.IMBREX_OPERATOR_TOKEN !== undefined });
const keepAlive = setInterval(() => {}, 1000);
const exit = () => { if (control().mode !== 'tree') { clearInterval(keepAlive); process.exit(0); } };
process.on('SIGTERM', exit); process.on('SIGINT', exit);

async function clientRequest(method: string, params: unknown) {
  const id = 'fixture-client-' + ++rpcId;
  const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
  send({ jsonrpc: '2.0', id, method, params });
  return response;
}
async function invokeReply(url: string, input: Record<string, unknown>) {
  const headers = { authorization: 'Bearer ' + process.env.IMBREX_QQ_AGENT_TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  const initialize = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acp-fixture', version: '1' } } }) });
  await initialize.json();
  const notification = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await notification.text();
  const callId = 'acp-fixture:' + String(input.seq);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'imbrex_invoke', arguments: {
    store_id: input.store_id, capability_id: 'qq-main.reply', call_id: callId,
    params: { input_event_ref: input.input_event_ref, text: 'ACP fixture reply' },
  } } }) });
  const value = object(await response.json());
  const data = object(object(value.result).structuredContent);
  log('call', { call_id: callId, status: object(data.call).status });
}
async function handle(line: string) {
  const message = object(JSON.parse(line));
  if (message.method === undefined && typeof message.id === 'string' && pending.has(message.id)) {
    pending.get(message.id)!(message); pending.delete(message.id); return;
  }
  if (message.id === undefined) return;
  const params = object(message.params ?? {});
  const mode = control().mode;
  log('request', { method: message.method, session_id: params.sessionId });
  if (message.method === 'initialize') {
    result(message.id, { protocolVersion: 1, agentInfo: { name: 'fixture-acp', version: '1' }, agentCapabilities: { loadSession: mode !== 'no-load' } });
  } else if (message.method === 'session/new') {
    if (mode === 'new-fail') { failure(message.id); return; }
    const sessionId = mode === 'collision' ? 'shared-session' : randomUUID();
    loaded.add(sessionId); known.push(sessionId); writeFileSync(sessionFile, JSON.stringify(known));
    result(message.id, { sessionId });
  } else if (message.method === 'session/load') {
    if (mode === 'load-fail' || typeof params.sessionId !== 'string' || !known.includes(params.sessionId)) { failure(message.id); return; }
    loaded.add(params.sessionId); result(message.id, {});
  } else if (message.method === 'session/set_config_option') {
    if (mode === 'model-fail') { failure(message.id); return; }
    if (typeof params.sessionId !== 'string' || !loaded.has(params.sessionId) || params.configId !== 'model' || typeof params.value !== 'string') { failure(message.id); return; }
    selectedModels.set(params.sessionId, params.value);
    result(message.id, { configOptions: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: mode === 'model-mismatch' ? 'fixture/wrong' : params.value, options: [{ value: params.value, name: params.value }] }] });
  } else if (message.method === 'session/prompt') {
    if (typeof params.sessionId !== 'string' || !loaded.has(params.sessionId) || !Array.isArray(params.prompt)) { failure(message.id); return; }
    const block = object(params.prompt.at(-1));
    if (typeof block.text !== 'string') throw new Error('Invalid fixture prompt');
    const input = object(JSON.parse(block.text));
    const ref = object(input.input_event_ref);
    const saved = object(JSON.parse(readFileSync(stateFile, 'utf8')));
    const flight = object(saved.in_flight);
    log('prompt', { session_id: params.sessionId, source: ref.source, id: ref.id, seq: input.seq,
      disk_confirmed: flight.source === ref.source && flight.id === ref.id && flight.seq === input.seq && flight.session_id === params.sessionId });
    if ((mode === 'tree' || mode === 'orphan') && !descendant) {
      descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.on("SIGINT",()=>{}); require("node:fs").writeFileSync(process.env.IMBREX_FAKE_AGENT_DIR+"/descendant.ready","ready"); setInterval(()=>{},1000);'], { stdio: 'ignore', detached: true });
      descendant.on('exit', () => log('descendant_exit'));
      log('descendant', { pid: descendant.pid });
      if (mode === 'orphan') process.exit(2);
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture update' } } } });
    if (process.env.PI_CODING_AGENT_DIR) {
      const settings = object(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8')));
      log('configured-prompt', { session_id: params.sessionId, model: selectedModels.get(params.sessionId) ?? settings.defaultModel, home: process.env.HOME, cwd: process.cwd(), prompt: readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'SYSTEM.md'), 'utf8') });
    }
    if (mode === 'hold' || mode === 'tree') return;
    if (mode === 'wait-release') {
      while (control().release !== true) await delay(10);
    }
    if (mode === 'oversize') { process.stdout.write('x'.repeat(consumerLimits.frameBytes + 1) + '\n'); return; }
    if (mode === 'large-update') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'large-context', status: 'completed', rawOutput: { content: 'x'.repeat(1024 * 1024) } },
    } });
    if (mode === 'invalid-update') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'tool_call', title: 'fixture-private-notification' },
    } });
    if (mode === 'invalid-message') send({ jsonrpc: '2.0', private_data: 'fixture-private-invalid-message' });
    if (mode === 'unknown-response') send({ jsonrpc: '2.0', id: 'fixture-private-response-id', result: {} });
    if (mode === 'error') { failure(message.id); return; }
    if (mode === 'permission') {
      const allowed = await clientRequest('session/request_permission', { sessionId: params.sessionId,
        toolCall: { toolCallId: 'fixture-tool', title: 'Imbrex MCP approved tool', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
      log('permission', { outcome: object(allowed.result).outcome });
      const filesystem = await clientRequest('fs/read_text_file', { sessionId: params.sessionId, path: '/fixture-must-not-be-read' });
      log('filesystem', { code: object(filesystem.error).code });
    }
    if (mode === 'reply' || mode === 'reply-crash') {
      const url = control().mcp_url;
      if (typeof url !== 'string') throw new Error('Missing fixture MCP URL');
      await invokeReply(url, input);
    }
    if (mode === 'reply-crash' || mode === 'exit') { process.stderr.write('fixture-private-agent-error\n'); process.exit(2); }
    if (mode === 'block-checkpoint') mkdirSync(stateFile + '.tmp');
    result(message.id, { stopReason: mode === 'other-stop' ? 'cancelled' : 'end_turn' });
  } else failure(message.id);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  handle(line).catch(() => { process.exit(2); });
});

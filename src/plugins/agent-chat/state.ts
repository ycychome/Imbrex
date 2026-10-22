import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EventRef, SourceRule } from '../../core/types.js';
import { eventRef, fields, json, namespacePattern, object, position, string, uri } from '../../core/validation.js';
import type { ReadScope } from '../../host/plugin-api.js';
import { ConsumerError, consumerLimits, parseConsumerConfig, parseFilter, parsePiSettings, type ConsumerConfig, type ConsumerFilter, type ManagedPi, type PiSettings } from './config.js';
import { nativeId } from '../onebot-v11/protocol.js';

export interface Binding {
  input_id: string;
  selection: { source_prefix: string; event_types: string[]; max_event_age_seconds: number; filter?: ConsumerFilter };
  reader: { principal_id: string; sources: SourceRule[] };
  agent: { command: string; args: string[]; cwd: string; env_vars: string[] };
}
export interface InFlight extends EventRef { seq: string; conversation: string; session_id: string }
export interface ManagedState {
  revision: string; base_filter: ConsumerFilter | null; filter: { saved: ConsumerFilter | null; applied: ConsumerFilter | null };
  pi?: { base: ManagedPi; saved: PiSettings; applied: PiSettings | null; applying?: boolean };
}
export interface ConsumerState extends Binding {
  version: 1; store_id: string; last_seq: string;
  agent_info: { name: string; version: string } | null;
  sessions: Record<string, string>; in_flight: InFlight | null;
  management?: ManagedState;
}
export function managementFor(state: ConsumerState): ManagedState {
  return state.management ?? { revision: 'initial', base_filter: state.selection.filter ?? null, filter: { saved: state.selection.filter ?? null, applied: state.selection.filter ?? null } };
}
export function bindingFor(config: ConsumerConfig, scope: ReadScope): Binding {
  const sources = structuredClone(scope.sources).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return {
    input_id: config.inputId,
    selection: { source_prefix: config.sourcePrefix, event_types: ['qq.message.group', 'qq.message.private'], max_event_age_seconds: config.maxAgeSeconds,
      ...(config.filter === undefined ? {} : { filter: config.filter }) },
    reader: { principal_id: scope.principalId, sources },
    agent: { command: config.agent.command, args: config.agent.args, cwd: config.agent.cwd, env_vars: config.agent.envVars },
  };
}
async function readState(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > consumerLimits.stateBytes) throw new ConsumerError('consumer_state_invalid');
      const buffer = Buffer.alloc(consumerLimits.stateBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
        length += bytesRead;
      }
      throw new ConsumerError('consumer_state_invalid');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new ConsumerError('consumer_state_invalid');
  }
}
export async function loadState(path: string, binding: Binding, storeId: string, latest: bigint): Promise<ConsumerState | undefined> {
  const raw = await readState(path);
  return raw === undefined ? undefined : validateState(raw, binding, storeId, latest);
}

// Read persisted facts against their own binding; this never authorizes resuming them.
export async function inspectState(path: string, storeId: string, latest: bigint): Promise<ConsumerState | undefined> {
  const raw = await readState(path);
  if (raw === undefined) return;
  const value = object(raw), selection = object(value.selection), reader = object(value.reader);
  const config = parseConsumerConfig({ input_id: value.input_id, source_prefix: selection.source_prefix,
    max_event_age_seconds: selection.max_event_age_seconds, agent: value.agent,
    ...(value.management !== undefined ? (object(value.management).base_filter === null ? {} : { filter: object(value.management).base_filter }) :
      selection.filter === undefined ? {} : { filter: selection.filter }) });
  fields(reader, ['principal_id', 'sources'], ['principal_id', 'sources']);
  const principalId = string(reader.principal_id, 64);
  if (!namespacePattern.test(principalId) || !Array.isArray(reader.sources)) throw new ConsumerError('consumer_state_invalid');
  const sources: SourceRule[] = reader.sources.map((input) => {
    const rule = object(input);
    if (Object.keys(rule).length !== 1) throw new ConsumerError('consumer_state_invalid');
    if (Object.hasOwn(rule, 'exact')) return { exact: uri(rule.exact) };
    if (Object.hasOwn(rule, 'prefix')) return { prefix: string(rule.prefix, 1024) };
    throw new ConsumerError('consumer_state_invalid');
  });
  return validateState(raw, bindingFor(config, { principalId, sources }), storeId, latest);
}
function validateState(raw: unknown, binding: Binding, storeId: string, latest: bigint): ConsumerState {
  try {
    const value = object(json(raw, consumerLimits.stateBytes));
    const keys = ['version', 'input_id', 'store_id', 'selection', 'reader', 'agent', 'agent_info', 'last_seq', 'sessions', 'in_flight'];
    fields(value, [...keys, 'management'], keys);
    if (value.version !== 1) throw new ConsumerError('consumer_state_invalid');
    if (value.store_id !== storeId) throw new ConsumerError('consumer_store_mismatch');
    let management: ManagedState | undefined;
    let expected = binding;
    if (value.management !== undefined) {
      const saved = object(value.management);
      fields(saved, ['revision', 'base_filter', 'filter', 'pi'], ['revision', 'base_filter', 'filter']);
      const filter = object(saved.filter); fields(filter, ['saved', 'applied'], ['saved', 'applied']);
      management = { revision: string(saved.revision, 64), base_filter: saved.base_filter === null ? null : parseFilter(saved.base_filter),
        filter: { saved: filter.saved === null ? null : parseFilter(filter.saved), applied: filter.applied === null ? null : parseFilter(filter.applied) } };
      if (!isDeepStrictEqual(management.base_filter, binding.selection.filter ?? null)) throw new ConsumerError('consumer_binding_changed');
      const selection = { ...binding.selection };
      if (management.filter.applied === null) delete selection.filter; else selection.filter = management.filter.applied;
      expected = { ...binding, selection };
      if (saved.pi !== undefined) {
        const pi = object(saved.pi); fields(pi, ['base', 'saved', 'applied', 'applying'], ['base', 'saved', 'applied']);
        if (pi.applying !== undefined && typeof pi.applying !== 'boolean') throw new ConsumerError('consumer_state_invalid');
        const base = parseConsumerConfig({ input_id: binding.input_id, source_prefix: binding.selection.source_prefix, max_event_age_seconds: binding.selection.max_event_age_seconds, agent: binding.agent, managed_pi: pi.base }).managedPi!;
        management.pi = { base, saved: parsePiSettings(pi.saved), applied: pi.applied === null ? null : parsePiSettings(pi.applied), ...(pi.applying === undefined ? {} : { applying: pi.applying as boolean }) };
      }
    }
    for (const key of ['input_id', 'selection', 'reader', 'agent'] as const) {
      if (!isDeepStrictEqual(value[key], expected[key])) throw new ConsumerError('consumer_binding_changed');
    }
    const lastSeq = position(value.last_seq);
    if (lastSeq > latest) throw new ConsumerError('consumer_position_ahead');
    const sessions: Record<string, string> = {};
    const saved = object(value.sessions);
    if (Object.keys(saved).length > consumerLimits.sessions) throw new ConsumerError('consumer_state_invalid');
    for (const [source, id] of Object.entries(saved)) {
      eventRef({ source, id: 'state' });
      if (!source.startsWith(binding.selection.source_prefix)) throw new ConsumerError('consumer_state_invalid');
      const parts = source.slice(binding.selection.source_prefix.length).split('/');
      if (parts.length !== 2 || !['group', 'private'].includes(parts[0]!) || nativeId(parts[1]) !== parts[1]) throw new ConsumerError('consumer_state_invalid');
      sessions[source] = string(id, 256);
    }
    if (new Set(Object.values(sessions)).size !== Object.keys(sessions).length) throw new ConsumerError('consumer_state_invalid');
    let agentInfo: ConsumerState['agent_info'] = null;
    if (value.agent_info !== null) {
      const info = object(value.agent_info);
      fields(info, ['name', 'version'], ['name', 'version']);
      agentInfo = { name: string(info.name, 256), version: string(info.version, 256, 'invalid_request', true) };
    }
    let inFlight: InFlight | null = null;
    if (value.in_flight !== null) {
      const current = object(value.in_flight);
      fields(current, ['source', 'id', 'seq', 'conversation', 'session_id'], ['source', 'id', 'seq', 'conversation', 'session_id']);
      const ref = eventRef({ source: current.source, id: current.id });
      const seq = position(current.seq);
      if (seq <= lastSeq || seq > latest || current.conversation !== ref.source || sessions[ref.source] !== current.session_id) throw new ConsumerError('consumer_state_invalid');
      inFlight = { ...ref, seq: seq.toString(), conversation: ref.source, session_id: string(current.session_id, 256) };
    }
    return { ...expected, version: 1, store_id: storeId, last_seq: lastSeq.toString(), sessions, agent_info: agentInfo, in_flight: inFlight, ...(management ? { management } : {}) };
  } catch (error) {
    throw error instanceof ConsumerError ? error : new ConsumerError('consumer_state_invalid');
  }
}

export async function saveState(path: string, state: ConsumerState): Promise<void> {
  const temporary = path + '.tmp';
  try {
    const content = JSON.stringify(json(state, consumerLimits.stateBytes)) + '\n';
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new ConsumerError('consumer_state_write_failed');
  }
}

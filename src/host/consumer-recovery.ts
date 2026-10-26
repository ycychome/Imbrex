import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SourceRule } from '../core/types.js';
import { fields, json, namespacePattern, object, position, string, uri } from '../core/validation.js';
import { inspectRecoveryStore } from '../storage/recovery.js';
import { consumerLimits, parseConsumerConfig } from '../plugins/agent-chat/config.js';
import { bindingFor, loadState, type Binding } from '../plugins/agent-chat/state.js';

export const recoveryUsage = 'npm --silent run consumer:recover -- --data-dir <directory> --instance <id> --store-id <expected> --seq <expected> --action <processed|abandoned|reset-sessions> --reason <text> [--new-session]';
export interface RecoveryOptions {
  dataDir: string; instance: string; storeId: string; seq: bigint;
  action: 'processed' | 'abandoned' | 'reset-sessions'; reason: string; newSession: boolean;
}
export class RecoveryError extends Error {
  constructor(readonly code: string, readonly backup?: string) { super(code); }
}
export function parseRecoveryArgs(args: string[]): RecoveryOptions {
  try {
    const { values, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: {
      'data-dir': { type: 'string' }, instance: { type: 'string' }, 'store-id': { type: 'string' }, seq: { type: 'string' },
      action: { type: 'string' }, reason: { type: 'string' }, 'new-session': { type: 'boolean', default: false },
    } });
    const names = tokens.filter((token) => token.kind === 'option').map((token) => token.name);
    if (names.length !== new Set(names).size) throw new RecoveryError('recovery_invalid_arguments');
    const instance = string(values.instance, 64);
    const action = values.action;
    const reason = string(values.reason, 2048).trim();
    if (!namespacePattern.test(instance) || !reason || (action !== 'processed' && action !== 'abandoned' && action !== 'reset-sessions') ||
        (action === 'reset-sessions' && values['new-session'])) throw new RecoveryError('recovery_invalid_arguments');
    return { dataDir: resolve(string(values['data-dir'], 4096)), instance, storeId: string(values['store-id'], 1024),
      seq: position(values.seq), action, reason, newSession: values['new-session'] ?? false };
  } catch { throw new RecoveryError('recovery_invalid_arguments'); }
}

async function savedBinding(path: string): Promise<Binding> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > consumerLimits.stateBytes) throw new RecoveryError('recovery_state_invalid');
    const value = object(json(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile())), consumerLimits.stateBytes));
    const selection = object(value.selection);
    const management = value.management === undefined ? undefined : object(value.management);
    const baseFilter = management ? management.base_filter : selection.filter;
    const config = parseConsumerConfig({ input_id: value.input_id, source_prefix: selection.source_prefix,
      max_event_age_seconds: selection.max_event_age_seconds, agent: value.agent,
      ...(baseFilter === undefined || baseFilter === null ? {} : { filter: baseFilter }) });
    const reader = object(value.reader);
    fields(reader, ['principal_id', 'sources'], ['principal_id', 'sources']);
    const principalId = string(reader.principal_id, 64);
    if (!namespacePattern.test(principalId) || !Array.isArray(reader.sources)) throw new RecoveryError('recovery_state_invalid');
    const sources: SourceRule[] = reader.sources.map((input) => {
      const rule = object(input);
      if (Object.keys(rule).length !== 1) throw new RecoveryError('recovery_state_invalid');
      if (Object.hasOwn(rule, 'exact')) return { exact: uri(rule.exact) };
      if (Object.hasOwn(rule, 'prefix')) return { prefix: string(rule.prefix, 1024) };
      throw new RecoveryError('recovery_state_invalid');
    });
    return bindingFor(config, { principalId, sources });
  } finally { await file.close(); }
}

async function atomicWrite(path: string, content: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(content) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// Internal offline operation: the public CLI holds dataDir/.lock throughout.
export async function recoverConsumer(options: RecoveryOptions) {
  const database = join(options.dataDir, 'gateway.db');
  const plugins = join(options.dataDir, 'plugins');
  const directory = join(plugins, options.instance);
  const path = join(directory, 'consumer-state.json');
  let binding: Binding;
  try {
    if (!(await lstat(database)).isFile() || !(await lstat(plugins)).isDirectory() || !(await lstat(directory)).isDirectory()) throw new RecoveryError('recovery_path_invalid');
    binding = await savedBinding(path);
  } catch { throw new RecoveryError('recovery_state_invalid'); }
  let info: ReturnType<typeof inspectRecoveryStore>;
  try { info = inspectRecoveryStore(database); } catch { throw new RecoveryError('recovery_store_unavailable'); }
  if (info.storeId !== options.storeId) throw new RecoveryError('recovery_store_mismatch');
  let state: Awaited<ReturnType<typeof loadState>>;
  try { state = await loadState(path, binding, info.storeId, info.latestSeq); } catch { throw new RecoveryError('recovery_state_invalid'); }
  if (!state) throw new RecoveryError('recovery_state_invalid');
  const next = structuredClone(state);
  if (options.action === 'reset-sessions') {
    if (state.in_flight || position(state.last_seq) !== options.seq) throw new RecoveryError('recovery_position_mismatch');
    next.sessions = {}; next.agent_info = null;
  } else {
    const pending = state.in_flight;
    if (!pending || position(pending.seq) !== options.seq) throw new RecoveryError('recovery_position_mismatch');
    let current: ReturnType<typeof inspectRecoveryStore>;
    try { current = inspectRecoveryStore(database, pending); } catch { throw new RecoveryError('recovery_store_unavailable'); }
    if (current.storeId !== options.storeId || current.eventSeq !== options.seq) throw new RecoveryError('recovery_event_mismatch');
    next.last_seq = pending.seq; next.in_flight = null;
    if (options.newSession) delete next.sessions[pending.conversation];
    if (!Object.keys(next.sessions).length) next.agent_info = null;
  }
  const auditDirectory = join(directory, 'recovery');
  const operationId = randomUUID();
  const backup = join('plugins', options.instance, 'recovery', operationId + '.json');
  try {
    await mkdir(auditDirectory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new RecoveryError('recovery_backup_write_failed');
  }
  try {
    const auditInfo = await lstat(auditDirectory);
    if (!auditInfo.isDirectory() || (auditInfo.mode & 0o077) !== 0) throw new RecoveryError('recovery_backup_write_failed');
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    await atomicWrite(join(options.dataDir, backup), { version: 1, operation_id: operationId, prepared_at: new Date().toISOString(),
      operator_uid: process.getuid!(), instance: options.instance, action: options.action, new_session: options.newSession,
      expected_seq: options.seq.toString(), reason: options.reason, before: state });
  } catch { throw new RecoveryError('recovery_backup_write_failed'); }
  try { await atomicWrite(path, next); } catch { throw new RecoveryError('recovery_state_write_uncertain', backup); }
  return { event: 'consumer_recovered', instance: options.instance, store_id: options.storeId, action: options.action,
    last_seq: next.last_seq, operation_id: operationId, backup };
}

export function reportRecoveryFailure(error: unknown): void {
  process.stderr.write(JSON.stringify({ event: 'consumer_recovery_failed',
    code: error instanceof RecoveryError ? error.code : 'recovery_failed',
    ...(error instanceof RecoveryError && error.backup ? { backup: error.backup } : {}),
  }) + '\n');
}

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { fail } from '../../core/errors.js';
import { fields, json, limits, namespacePattern, object, string } from '../../core/validation.js';
import { nativeId } from '../onebot-v11/protocol.js';

export const consumerLimits = { sessions: 32, frameBytes: 32 * 1024 * 1024, stateBytes: 256 * 1024, setupTimeoutMs: 5000, pollMs: 1000 } as const;
export interface AgentConfig { command: string; args: string[]; cwd: string; envVars: string[] }
export interface ConsumerFilter { group_ids: string[]; private_user_ids: string[] }
export interface MemoryContextConfig { capability: string; timeoutMs: number; maxBytes: number }
export interface ConsumerConfig {
  inputId: string; sourcePrefix: string; accountId: string; identityNamespace: string;
  maxAgeSeconds: number; turnTimeoutMs: number; agent: AgentConfig; filter?: ConsumerFilter; memoryContext?: MemoryContextConfig;
}
export class ConsumerError extends Error {
  constructor(readonly code: string) { super(code); }
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail('invalid_request', 'Invalid consumer configuration');
  return value;
}
function argument(value: unknown, allowEmpty = false): string {
  const result = string(value, 4096, 'invalid_request', allowEmpty);
  if (result.includes(String.fromCharCode(0))) fail('invalid_request');
  return result;
}
export function parseConsumerConfig(input: unknown): ConsumerConfig {
  const value = object(json(input, limits.valueBytes, 'invalid_request'));
  const required = ['input_id', 'source_prefix', 'max_event_age_seconds', 'agent'];
  fields(value, [...required, 'turn_timeout_ms', 'filter', 'memory_context'], required);
  const inputId = string(value.input_id, 64);
  if (!namespacePattern.test(inputId)) fail('invalid_request');
  const sourcePrefix = string(value.source_prefix, 1024);
  const parts = sourcePrefix.split('/');
  if (parts.length !== 6 || parts[0] !== 'imbrex:' || parts[1] !== '' || parts[2] !== 'qq' || parts[5] !== '') fail('invalid_request', 'Expected a QQ account/namespace prefix');
  const accountId = nativeId(parts[3]);
  const identityNamespace = parts[4]!;
  if (!namespacePattern.test(identityNamespace)) fail('invalid_request');
  let filter: ConsumerFilter | undefined;
  if (value.filter !== undefined) {
    const selection = object(value.filter);
    fields(selection, ['group_ids', 'private_user_ids'], ['group_ids', 'private_user_ids']);
    const ids = (input: unknown): string[] => {
      if (!Array.isArray(input)) fail('invalid_request');
      return [...new Set(input.map((id) => nativeId(string(id, 20))))].sort();
    };
    filter = { group_ids: ids(selection.group_ids), private_user_ids: ids(selection.private_user_ids) };
  }
  let memoryContext: MemoryContextConfig | undefined;
  if (value.memory_context !== undefined) {
    const memory = object(value.memory_context);
    fields(memory, ['capability', 'timeout_ms', 'max_bytes'], ['capability']);
    memoryContext = {
      capability: string(memory.capability, 256),
      timeoutMs: integer(memory.timeout_ms ?? 2000, 1, 2000),
      maxBytes: integer(memory.max_bytes ?? 8192, 1, 8192),
    };
    if (!/^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}$/.test(memoryContext.capability)) fail('invalid_request');
  }
  const agent = object(value.agent);
  fields(agent, ['command', 'args', 'cwd', 'env_vars'], ['command', 'args', 'cwd']);
  if (!Array.isArray(agent.args) || agent.args.length > 64) fail('invalid_request');
  const cwd = argument(agent.cwd);
  if (!isAbsolute(cwd)) fail('invalid_request', 'Agent cwd must be absolute');
  const envVars = agent.env_vars ?? [];
  if (!Array.isArray(envVars) || envVars.length > 32) fail('invalid_request');
  const names = envVars.map((item) => string(item, 128));
  if (names.some((item) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) || new Set(names).size !== names.length) fail('invalid_request');
  return {
    inputId, sourcePrefix, accountId, identityNamespace,
    maxAgeSeconds: integer(value.max_event_age_seconds, 1, 86400),
    turnTimeoutMs: integer(value.turn_timeout_ms ?? 120000, 10, 600000),
    ...(filter === undefined ? {} : { filter }),
    ...(memoryContext === undefined ? {} : { memoryContext }),
    agent: { command: argument(agent.command), args: agent.args.map((item) => argument(item, true)), cwd, envVars: names.sort() },
  };
}

export async function prepareAgent(config: AgentConfig): Promise<{ config: AgentConfig; env: Record<string, string> }> {
  const env = Object.create(null) as Record<string, string>;
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', ...config.envVars]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
    else if (config.envVars.includes(key)) throw new ConsumerError('consumer_agent_env_missing');
  }
  const cwd = await realpath(config.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new ConsumerError('consumer_agent_cwd_invalid');
  const candidates = isAbsolute(config.command) ? [config.command] : config.command.includes('/') ? [resolve(cwd, config.command)] :
    (env.PATH ?? '').split(delimiter).filter(Boolean).map((path) => resolve(cwd, path, config.command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const command = await realpath(candidate);
      if (!(await stat(command)).isFile()) continue;
      return { config: { ...config, command, cwd }, env };
    } catch { /* Try the next PATH entry without exposing environment values. */ }
  }
  throw new ConsumerError('consumer_agent_executable_missing');
}

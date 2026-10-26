import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../../core/errors.js';
import { fields, json, object, string } from '../../core/validation.js';
import { nativeId } from './protocol.js';

export const RUNTIME_CONFIG = 'config.json';
const MAX_BYTES = 64 * 1024;

export interface RuntimeFilters {
  group_ids: string[];
  private_user_ids: string[];
}

export interface ManagedProcessConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env_vars?: string[];
}

export interface RuntimeConfig {
  version: 1;
  runtime_filters?: RuntimeFilters;
  managed_process?: ManagedProcessConfig;
}
export class RuntimeConfigWriteError extends Error {
  constructor() { super('runtime_config_write_failed'); }
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1024) fail('invalid_request');
  try {
    const result = value.map((entry) => nativeId(string(entry, 20)));
    if (new Set(result).size !== result.length) fail('invalid_request');
    return result;
  } catch {
    return fail('invalid_request', 'Invalid native ID in runtime filters');
  }
}

export function parseRuntimeFilters(value: unknown): RuntimeFilters {
  const item = object(value);
  fields(item, ['group_ids', 'private_user_ids'], ['group_ids', 'private_user_ids']);
  return { group_ids: ids(item.group_ids), private_user_ids: ids(item.private_user_ids) };
}

export function parseManagedProcess(value: unknown): ManagedProcessConfig {
  const item = object(value);
  fields(item, ['enabled', 'command', 'args', 'cwd', 'env_vars'], ['enabled']);
  if (typeof item.enabled !== 'boolean') fail('invalid_request');
  const result: ManagedProcessConfig = { enabled: item.enabled };
  if (item.command !== undefined) result.command = string(item.command, 4096);
  if (item.cwd !== undefined) result.cwd = string(item.cwd, 4096);
  if (item.args !== undefined) {
    if (!Array.isArray(item.args) || item.args.length > 64) fail('invalid_request');
    result.args = item.args.map((entry) => string(entry, 4096, 'invalid_request', true));
  }
  if (item.env_vars !== undefined) {
    if (!Array.isArray(item.env_vars) || item.env_vars.length > 64) fail('invalid_request');
    result.env_vars = item.env_vars.map((entry) => string(entry, 256));
  }
  return result;
}

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  const value = object(json(raw, MAX_BYTES));
  fields(value, ['version', 'runtime_filters', 'managed_process'], ['version']);
  if (value.version !== 1) fail('invalid_request', 'Unsupported runtime config version');
  return {
    version: 1,
    ...(value.runtime_filters === undefined ? {} : { runtime_filters: parseRuntimeFilters(value.runtime_filters) }),
    ...(value.managed_process === undefined ? {} : { managed_process: parseManagedProcess(value.managed_process) }),
  };
}

/** A corrupt private config falls back to the host config instead of blocking the plugin. */
export async function readRuntimeConfig(dataDir: string): Promise<{ config?: RuntimeConfig; error?: string }> {
  try {
    const file = await open(join(dataDir, RUNTIME_CONFIG), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid runtime config file');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) return { config: parseRuntimeConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))) };
        length += bytesRead;
      }
      throw new Error('Runtime config too large');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    return { error: 'runtime_config_invalid' };
  }
}

export async function writeRuntimeConfig(dataDir: string, config: RuntimeConfig): Promise<void> {
  config = parseRuntimeConfig(config);
  const target = join(dataDir, RUNTIME_CONFIG);
  const temporary = target + '.' + randomUUID() + '.tmp';
  let created = false;
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(JSON.stringify(config) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const directory = await open(dataDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { throw new RuntimeConfigWriteError(); }
  finally {
    if (created) await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Persist only the fields the console can edit; unknown fields are not invented. */
export function mergeRuntime(current: RuntimeConfig | undefined, patch: { filters?: RuntimeFilters; managed?: ManagedProcessConfig }): RuntimeConfig {
  const next: RuntimeConfig = { version: 1 };
  const filtersValue = patch.filters === undefined ? current?.runtime_filters : patch.filters;
  if (filtersValue !== undefined) next.runtime_filters = filtersValue;
  const managedValue = patch.managed === undefined ? current?.managed_process : patch.managed;
  if (managedValue !== undefined) next.managed_process = managedValue;
  return next;
}

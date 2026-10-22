import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { fields, json, object, string, namespacePattern, capabilityPattern, limits, uri } from '../core/validation.js';
import { permissions, type JsonObject, type Principal, type SourceRule } from '../core/types.js';
import { parseServerHttpConfig } from '../plugins/server-http/config.js';
import { serverHttpModule } from './modules.js';

export interface PluginConfig {
  id: string; module: string; principalId: string; required: boolean; enabled: boolean; config: JsonObject;
}
export interface HostConfig {
  dataDir: string;
  externalWritesEnabled: boolean;
  principals: Principal[];
  credentialReferences: Record<string, string>;
  plugins: PluginConfig[];
  authenticate: (authorization: string | undefined) => Principal;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_request', 'Invalid configuration');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail('invalid_request', 'Invalid configuration');
  return value;
}
function id(value: unknown): string {
  const text = string(value, 64);
  if (!namespacePattern.test(text)) fail('invalid_request', 'Invalid configuration ID');
  return text;
}
function sourceRules(value: unknown): SourceRule[] {
  return list(value).map((entry) => {
    const rule = object(entry);
    if (Object.keys(rule).length !== 1) fail('invalid_request');
    if (Object.hasOwn(rule, 'exact')) return { exact: uri(rule.exact, 'invalid_request') };
    if (Object.hasOwn(rule, 'prefix')) return { prefix: string(rule.prefix, 1024) };
    return fail('invalid_request');
  });
}

export interface ParseConfigOptions {
  resolveCredentials?: boolean;
}

export function parseConfig(
  input: unknown,
  filename: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: ParseConfigOptions = {},
): HostConfig {
  const config = object(json(input, limits.httpBytes, 'invalid_request'));
  const keys = ['config_version', 'data_dir', 'external_writes_enabled', 'principals', 'plugins'];
  fields(config, keys, keys);
  if (config.config_version !== 2) fail('invalid_request', 'Unsupported config_version');
  const resolveCredentials = options.resolveCredentials !== false;
  const credentials: { digest: Buffer; principal: Principal }[] = [];
  const credentialReferences: Record<string, string> = Object.create(null) as Record<string, string>;
  const principals = list(config.principals).map((entry): Principal => {
    const item = object(entry);
    fields(item, ['id', 'token_env', 'permissions', 'read_sources', 'write_sources', 'invoke_capabilities'],
      ['id', 'permissions', 'read_sources', 'write_sources', 'invoke_capabilities']);
    const allowed = list(item.permissions);
    if (allowed.some((permission) => !permissions.some((known) => known === permission)) || new Set(allowed).size !== allowed.length) fail('invalid_request');
    const capabilities = list(item.invoke_capabilities).map((value) => {
      const text = string(value, 129);
      if (!capabilityPattern.test(text)) fail('invalid_request');
      return text;
    });
    const principal: Principal = {
      id: id(item.id), permissions: allowed as Principal['permissions'],
      readSources: sourceRules(item.read_sources), writeSources: sourceRules(item.write_sources), invokeCapabilities: capabilities,
    };
    if (item.token_env !== undefined) {
      const name = string(item.token_env, 256);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('invalid_request');
      if (resolveCredentials) {
        const token = environment[name];
        if (!token || !/^[\x21-\x7e]+$/.test(token)) fail('invalid_request', 'Missing or invalid token environment variable');
        const digest = createHash('sha256').update(token).digest();
        if (credentials.some((entry) => timingSafeEqual(entry.digest, digest))) fail('invalid_request', 'Duplicate credentials');
        credentials.push({ digest, principal });
      }
      credentialReferences[principal.id] = name;
    }
    return principal;
  });
  if (new Set(principals.map((principal) => principal.id)).size !== principals.length) fail('invalid_request', 'Duplicate principal');
  const plugins = list(config.plugins).map((entry): PluginConfig => {
    const item = object(entry);
    fields(item, ['id', 'module', 'principal_id', 'required', 'enabled', 'config'], ['id', 'module', 'principal_id', 'required', 'enabled', 'config']);
    const principalId = id(item.principal_id);
    if (!principals.some((principal) => principal.id === principalId)) fail('invalid_request', 'Unknown plugin principal');
    const module = string(item.module, 1024);
    const pluginConfig = object(item.config) as JsonObject;
    if (module === serverHttpModule) parseServerHttpConfig(pluginConfig);
    return {
      id: id(item.id), module, principalId,
      required: boolean(item.required), enabled: boolean(item.enabled), config: pluginConfig,
    };
  });
  if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length) fail('invalid_request', 'Duplicate plugin instance');
  return {
    dataDir: resolve(dirname(resolve(filename)), string(config.data_dir, 4096)),
    externalWritesEnabled: boolean(config.external_writes_enabled), principals, credentialReferences, plugins,
    authenticate: (authorization) => {
      const match = /^Bearer ([\x21-\x7e]+)$/i.exec(authorization ?? '');
      if (!match?.[1]) fail('unauthorized');
      const digest = createHash('sha256').update(match[1]).digest();
      const credential = credentials.find((entry) => timingSafeEqual(entry.digest, digest));
      if (!credential) fail('unauthorized');
      return credential.principal;
    },
  };
}

export async function loadConfig(filename: string): Promise<HostConfig> {
  let input: unknown;
  try { input = JSON.parse(await readFile(filename, 'utf8')); } catch { fail('invalid_request', 'Cannot read JSON configuration'); }
  return parseConfig(input, filename);
}

import { dirname, isAbsolute, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { fields, json, limits, object, string } from '../core/validation.js';
import type { JsonObject } from '../core/types.js';

export function migrateConfig(input: unknown, filename: string): JsonObject {
  const config = object(json(input, limits.httpBytes, 'invalid_request'));
  const keys = ['config_version', 'data_dir', 'http', 'external_writes_enabled', 'principals', 'plugins'];
  fields(config, keys, keys);
  if (config.config_version !== 1 || !Array.isArray(config.plugins) || !Array.isArray(config.principals)) fail('invalid_request', 'Expected a version 1 configuration');
  const directory = dirname(resolve(filename));
  const principals = config.principals.map((value) => object(value));
  const plugins = config.plugins.map((value) => object(value)).filter((plugin) => plugin.module !== 'builtin:observer');
  const unique = (base: string, ids: unknown[]) => {
    let id = base;
    for (let suffix = 2; ids.includes(id); suffix += 1) id = base + '-' + suffix;
    return id;
  };
  const principalId = unique('protocol', principals.map((principal) => principal.id));
  principals.push({ id: principalId, permissions: [], read_sources: [], write_sources: [], invoke_capabilities: [] });
  for (const plugin of plugins) {
    if (plugin.module === 'builtin:acp-consumer') plugin.module = 'builtin:agent-chat';
    const module = string(plugin.module, 1024);
    if (/^\.\.?\//.test(module) && !isAbsolute(module)) plugin.module = resolve(directory, module);
  }
  const protocols = ['server-http', 'api-rest', 'adapter-mcp'].map((module) => ({
    id: unique(module, plugins.map((plugin) => plugin.id)), module: 'builtin:' + module, principal_id: principalId,
    enabled: true, required: true, config: module === 'server-http' ? config.http : {},
  }));
  return json({ config_version: 2, data_dir: resolve(directory, string(config.data_dir, 4096)),
    external_writes_enabled: config.external_writes_enabled, principals, plugins: [...protocols, ...plugins],
  }, limits.httpBytes, 'invalid_request') as JsonObject;
}

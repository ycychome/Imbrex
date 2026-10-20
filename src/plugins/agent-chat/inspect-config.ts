import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { json, object, string } from '../../core/validation.js';
import type { JsonValue } from '../../core/types.js';

async function textFile(path: string): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error('Configuration unavailable');
      return new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile());
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const value = await textFile(path);
  return value === null ? {} : object(json(JSON.parse(value), 65536));
}

// Only inspect an explicitly passed Agent directory, never the user global HOME.
export async function inspectPiConfiguration(directory: string | undefined): Promise<JsonValue> {
  if (!directory || !isAbsolute(directory)) return { status: 'unmanaged', saved: null, applied: null, observed: null };
  try {
    const settings = await jsonFile(join(directory, 'settings.json'));
    const models = await jsonFile(join(directory, 'models.json'));
    const mcp = await jsonFile(join(directory, 'mcp.json'));
    const prompt = await textFile(join(directory, 'SYSTEM.md'));
    const provider = settings.defaultProvider === undefined ? null : string(settings.defaultProvider, 256);
    const model = settings.defaultModel === undefined ? null : string(settings.defaultModel, 256);
    let contextWindow: number | null = null;
    if (provider && model && models.providers) {
      const entry = object(object(models.providers)[provider] ?? {});
      const match = Array.isArray(entry.models) ? entry.models.map((value) => object(value)).find((value) => value.id === model) : undefined;
      const override = entry.modelOverrides ? object(object(entry.modelOverrides)[model] ?? {}) : {};
      const value = override.contextWindow ?? match?.contextWindow;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) contextWindow = value;
    }
    const servers = Object.entries(object(mcp.mcpServers ?? {})).slice(0, 32).map(([name, input]) => {
      const server = object(input);
      let endpoint: string | null = null;
      try {
        const url = new URL(String(server.url));
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) endpoint = url.href;
      } catch { /* Omit unverified endpoints and credentials. */ }
      const authorization = object(server.headers ?? {}).Authorization;
      const reference = typeof authorization === 'string' ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(authorization)?.[1] : undefined;
      return { name: string(name, 256), url: endpoint, credential_reference: reference ?? null, credential_configured: reference ? Boolean(process.env[reference]) : authorization !== undefined };
    });
    return json({ status: 'configured_unverified', saved: { provider, model, context_window: contextWindow, system_prompt: prompt, mcp: servers }, applied: null, observed: null }, 65536);
  } catch { return { status: 'unavailable', error: 'agent_configuration_unavailable', saved: null, applied: null, observed: null }; }
}

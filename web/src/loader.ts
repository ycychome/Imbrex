import type { AdminInfo } from './client-api';
import { fetchInfo } from './api';
import { ctx } from './context';

const loadedModules = new Set<string>();

export interface LoadResult {
  info: AdminInfo;
  failures: string[];
}

export async function loadPluginClients(): Promise<LoadResult> {
  const info = await fetchInfo();
  const failures: string[] = [];
  const entries = new Map<string, string>();
  for (const plugin of info.plugins) {
    if (plugin.enabled && plugin.client_entry) entries.set(plugin.module_name, plugin.client_entry);
  }
  for (const [module, entry] of entries) {
    if (loadedModules.has(module)) continue;
    try {
      const imported: unknown = await import(/* @vite-ignore */ entry);
      const plugin = imported && typeof imported === 'object' && 'default' in imported
        ? (imported as { default: unknown }).default
        : imported;
      if (!plugin) throw new Error('empty client module');
      ctx.plugin(plugin as Parameters<typeof ctx.plugin>[0]);
      loadedModules.add(module);
    } catch (error) {
      failures.push(`${module}: ${error instanceof Error ? error.message : 'client load failed'}`);
    }
  }
  return { info, failures };
}

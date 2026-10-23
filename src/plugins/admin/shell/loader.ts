import type { AdminInfo } from '../types';
import { fetchInfo } from './api';
import { ctx } from './context';

const loadedModules = new Set<string>();

function sameOrigin(target: string): boolean {
  try {
    return new URL(target, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

export interface LoadResult {
  info: AdminInfo;
  failures: string[];
}

export async function loadPluginClients(): Promise<LoadResult> {
  const info = await fetchInfo();
  const failures: string[] = [];
  const entries = new Map<string, string>();
  for (const plugin of info.plugins) {
    // A view may only load from an enabled, running instance whose entry is
    // same-origin; a failed or stopped plugin contributes nothing.
    if (!plugin.enabled || plugin.state !== 'active' || !plugin.client_entry) continue;
    if (!sameOrigin(plugin.client_entry)) continue;
    entries.set(plugin.module_name, plugin.client_entry);
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

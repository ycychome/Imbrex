import type { AdminInfo } from '../types';
import { fetchInfo } from './api';
import { ctx } from './context';

interface LoadedClient {
  entry: string;
  dispose: () => Promise<void>;
}

// Keyed by entry URL: two external instances share the module name "external",
// but each distinct entry must load (and unload) exactly once.
const loaded = new Map<string, LoadedClient>();

function sameOrigin(target: string): boolean {
  try {
    return new URL(target, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function desiredEntries(info: AdminInfo): Map<string, string> {
  const entries = new Map<string, string>();
  for (const plugin of info.plugins) {
    // A view may only load from an enabled, running instance whose entry is
    // same-origin; a failed or stopped plugin contributes nothing.
    if (!plugin.enabled || plugin.state !== 'active' || !plugin.client_entry) continue;
    if (!sameOrigin(plugin.client_entry)) continue;
    entries.set(plugin.client_entry, plugin.module_name);
  }
  return entries;
}

/** The set of loadable client entries; a change means views must be reconciled. */
export function viewSignature(info: AdminInfo | null): string {
  return info ? [...desiredEntries(info).keys()].sort().join('|') : '';
}

export interface LoadResult {
  info: AdminInfo;
  failures: string[];
}

/**
 * Make the registered views match the current plugin set: unload entries that
 * are gone (plugin stopped, disabled or re-pointed) and load new ones. Called
 * on login and whenever the health poll observes a different entry set.
 */
export async function reconcilePluginClients(info: AdminInfo): Promise<LoadResult> {
  const wanted = desiredEntries(info);
  const failures: string[] = [];
  for (const [entry, record] of [...loaded]) {
    if (wanted.has(entry) && record.entry === entry) continue;
    loaded.delete(entry);
    try {
      await record.dispose();
    } catch (error) {
      failures.push(`${entry}: ${error instanceof Error ? error.message : 'client unload failed'}`);
    }
  }
  for (const [entry, module] of wanted) {
    if (loaded.has(entry)) continue;
    try {
      const imported: unknown = await import(/* @vite-ignore */ entry);
      const plugin = imported && typeof imported === 'object' && 'default' in imported
        ? (imported as { default: unknown }).default
        : imported;
      if (!plugin) throw new Error('empty client module');
      const fiber = ctx.plugin(plugin as Parameters<typeof ctx.plugin>[0]);
      loaded.set(entry, { entry, dispose: () => fiber.dispose() });
    } catch (error) {
      failures.push(`${module}: ${error instanceof Error ? error.message : 'client load failed'}`);
    }
  }
  return { info, failures };
}

export async function loadPluginClients(): Promise<LoadResult> {
  return await reconcilePluginClients(await fetchInfo());
}

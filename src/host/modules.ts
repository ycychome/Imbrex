import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, Plugin } from 'cordis';
import { fail } from '../core/errors.js';
import { object } from '../core/validation.js';
import type { JsonObject } from '../core/types.js';
import type { HostConfig } from './config.js';

export interface PluginModule {
  name?: string;
  inject?: string[];
  Config?: Plugin.Object<JsonObject>['Config'];
  apply(ctx: Context, config: JsonObject): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
const builtins: Record<string, URL> = {
  fixture: new URL('../plugins/fixture.js', import.meta.url),
  transform: new URL('../plugins/transform.js', import.meta.url),
  observer: new URL('../plugins/observer.js', import.meta.url),
  mock: new URL('../plugins/mock.js', import.meta.url),
};

export async function loadModules(config: HostConfig, filename: string): Promise<Map<string, PluginModule | undefined>> {
  const modules = new Map<string, PluginModule | undefined>();
  for (const plugin of config.plugins) {
    try {
      let specifier = plugin.module;
      if (specifier.startsWith('builtin:')) {
        const url = builtins[specifier.slice(8)];
        if (!url) fail('invalid_request', 'Unknown builtin plugin');
        specifier = url.href;
        if (Object.keys(plugin.config).length) fail('invalid_request', 'Builtin plugin configuration must be empty');
      } else if (isAbsolute(specifier) || /^\.\.?\//.test(specifier)) {
        specifier = pathToFileURL(resolve(dirname(resolve(filename)), specifier)).href;
      } else if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._/-]+)?$/i.test(specifier)) {
        fail('invalid_request', 'Invalid plugin module specifier');
      }
      const imported: unknown = await import(specifier);
      const module = object(imported && typeof imported === 'object' ? { ...imported } : imported);
      const candidate = module.default ?? module;
      const value = typeof candidate === 'function'
        ? { apply: candidate, name: candidate.name, inject: Reflect.get(candidate, 'inject'), Config: Reflect.get(candidate, 'Config') }
        : object(candidate);
      if (typeof value.apply !== 'function' || (value.inject !== undefined && (!Array.isArray(value.inject) || value.inject.some((item) => typeof item !== 'string')))) fail('invalid_request', 'Invalid plugin module');
      modules.set(plugin.id, value as unknown as PluginModule);
    } catch {
      if (plugin.module.startsWith('builtin:') || plugin.required) fail('invalid_request', 'Cannot load configured plugin');
      modules.set(plugin.id, undefined);
    }
  }
  return modules;
}

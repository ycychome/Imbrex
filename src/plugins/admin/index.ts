import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { Context } from 'cordis';
import type {} from '../../host/protocol.js';
import type {} from '../server-http/server.js';
import { requirePermission } from '../../core/access.js';
import { fail } from '../../core/errors.js';
import { fields, string } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';

function bundledAssetsDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('@imbrex/admin-web/package.json')), 'dist');
  } catch {
    return undefined;
  }
}

export const name = 'admin';
export const inject = ['http', 'protocol'];
export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  fields(input, ['assets_dir'], []);
  const service = ctx.protocol.forPlugin(ctx);
  const http = ctx.http.scope(ctx);
  http.register('GET', '/api/admin/info', async ({ request, origin, query, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    requirePermission(principal, 'admin:inspect');
    if (request.headers.origin !== undefined && request.headers.origin !== origin) fail('forbidden');
    if (query.size) fail('invalid_request');
    const info = await service.store.info();
    send(200, { store_id: info.storeId, latest_seq: info.latestSeq.toString(), version: '0.1.0-dev' });
  });
  const configured = input.assets_dir;
  const root = configured === undefined ? bundledAssetsDir() : string(configured, 4096);
  if (root !== undefined) {
    if (!isAbsolute(root)) fail('invalid_request', 'assets_dir must be absolute');
    let available = false;
    try { available = (await stat(root)).isDirectory(); } catch { available = false; }
    if (available) {
      try {
        await http.static('/admin', root);
      } catch (cause) {
        // Missing assets must not block the admin API or the host.
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    }
  }
}

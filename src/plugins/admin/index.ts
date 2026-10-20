import { isAbsolute } from 'node:path';
import type { Context } from 'cordis';
import type {} from '../../host/protocol.js';
import type {} from '../server-http/server.js';
import { requirePermission } from '../../core/access.js';
import { fail } from '../../core/errors.js';
import { fields, string } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';

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
  if (input.assets_dir !== undefined) {
    const root = string(input.assets_dir, 4096);
    if (!isAbsolute(root)) fail('invalid_request', 'assets_dir must be absolute');
    await http.static('/admin', root);
  }
}

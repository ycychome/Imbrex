import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { Context } from 'cordis';
import type {} from '../../host/protocol.js';
import type {} from '../server-http/server.js';
import { requirePermission } from '../../core/access.js';
import { fail } from '../../core/errors.js';
import { fields, object, string } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';
import type { CallQuery } from '../../core/store.js';
import type { HttpRequest } from '../server-http/server.js';
import { readQuery, wireCall, wireCapability, wirePage } from '../api-rest/dto.js';

function bundledAssetsDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('@imbrex/ui-contract/package.json')), 'dist');
  } catch {
    return undefined;
  }
}

export const name = 'admin';
export const client = 'entry.js';
export const inject = ['http', 'protocol'];
export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  fields(input, ['assets_dir'], []);
  const service = ctx.protocol.forPlugin(ctx);
  const http = ctx.http.scope(ctx);
  const admin = service.admin ?? fail('forbidden');
  const inspect = ({ request, origin, response }: HttpRequest) => {
    const principal = service.authenticate(request.headers.authorization);
    requirePermission(principal, 'admin:inspect');
    if (request.headers.origin !== undefined && request.headers.origin !== origin) fail('forbidden');
    response.setHeader('cache-control', 'no-store');
    return principal;
  };
  const empty = ({ queryText }: HttpRequest) => { if (queryText) fail('invalid_request'); };
  http.register('GET', '/api/admin/info', async (request) => {
    inspect(request); empty(request);
    const info = await service.store.info();
    request.send(200, { store_id: info.storeId, latest_seq: info.latestSeq.toString(), version: '0.1.0-dev', plugins: service.plugins() });
  });
  http.register('GET', '/api/admin/panels', async (request) => {
    const principal = inspect(request); empty(request);
    request.send(200, { store_id: (await service.store.info()).storeId, panels: admin.registry.list(principal) });
  });
  http.register('GET', '/api/admin/panels/:instance', async (request) => {
    const principal = inspect(request); empty(request);
    request.send(200, { store_id: (await service.store.info()).storeId, ...await admin.registry.read(principal, request.params.instance!) });
  });
  http.register('GET', '/api/admin/events', async (request) => {
    const principal = inspect(request);
    const query = readQuery(request.query);
    request.send(200, wirePage(await service.events.inspect(principal, query.storeId, query.options)));
  });
  http.register('GET', '/api/admin/capabilities', async (request) => {
    const principal = inspect(request); empty(request);
    request.send(200, { store_id: (await service.store.info()).storeId, capabilities: service.capabilities.inspect(principal).map((item) => ({ ...wireCapability(item), available: item.available })) });
  });
  http.register('GET', '/api/admin/calls', async (request) => {
    const principal = inspect(request);
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of request.query) { if (Object.hasOwn(values, key)) fail('invalid_request'); values[key] = value; }
    fields(values, ['store_id', 'limit', 'caller_id', 'status', 'after_caller_id', 'after_call_id'], ['store_id']);
    if (values.limit !== undefined && !/^[1-9][0-9]*$/.test(values.limit)) fail('invalid_request');
    if ((values.after_caller_id === undefined) !== (values.after_call_id === undefined)) fail('invalid_request');
    const query: CallQuery = { limit: values.limit === undefined ? 50 : Number(values.limit),
      ...(values.caller_id === undefined ? {} : { callerId: values.caller_id }),
      ...(values.status === undefined ? {} : { status: values.status as CallQuery['status'] }),
      ...(values.after_caller_id === undefined ? {} : { after: { callerId: values.after_caller_id, callId: values.after_call_id! } }),
    };
    const storeId = string(values.store_id, 256);
    const page = await service.capabilities.audit(principal, storeId, query);
    request.send(200, { store_id: storeId, calls: page.calls.map((call) => ({ caller_id: call.callerId, ...wireCall(call) })),
      next: page.next ? { caller_id: page.next.callerId, call_id: page.next.callId } : null,
    });
  });
  http.register('GET', '/api/admin/configuration', (request) => {
    const principal = inspect(request); empty(request);
    request.send(200, admin.configuration(principal));
  });
  http.register('POST', '/api/admin/panels/:instance/actions/:action', async (request) => {
    const principal = service.authenticate(request.request.headers.authorization);
    requirePermission(principal, 'admin:operate');
    if (request.request.headers.origin !== undefined && request.request.headers.origin !== request.origin) fail('forbidden');
    request.response.setHeader('cache-control', 'no-store'); empty(request);
    const body = object(await request.readBody());
    fields(body, ['store_id', 'generation', 'params'], ['store_id', 'generation', 'params']);
    const storeId = string(body.store_id, 256);
    if ((await service.store.info()).storeId !== storeId) fail('store_mismatch');
    request.ensureActive();
    const result = await admin.operate(principal, request.params.instance!, string(body.generation, 256), request.params.action!, body.params);
    request.send(200, { store_id: storeId, instance_id: request.params.instance, result });
  });
  const configured = input.assets_dir;
  const root = configured === undefined ? bundledAssetsDir() : string(configured, 4096);
  if (root !== undefined) {
    if (!isAbsolute(root)) fail('invalid_request', 'assets_dir must be absolute');
    try { await http.static('/admin', root); }
    catch { /* Missing or unreadable assets must not block the admin API or the host. */ }
  }
}

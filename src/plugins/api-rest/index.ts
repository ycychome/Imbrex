import type { Context } from 'cordis';
import type {} from '../../host/protocol.js';
import type {} from '../server-http/server.js';
import { requirePermission } from '../../core/access.js';
import { fail } from '../../core/errors.js';
import { capabilityPattern, fields } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';
import { appendBody, invokeBody, lookupQuery, readQuery, storeQuery, wireAppend, wireCall, wireCapability, wireInvocation, wirePage, wireRecord } from './dto.js';

export const name = 'api-rest';
export const inject = ['http', 'protocol'];
export function apply(ctx: Context, input: JsonObject): void {
  fields(input, [], []);
  const service = ctx.protocol.forPlugin(ctx);
  const { store, events, capabilities, plugins } = service;
  const http = ctx.http.scope(ctx);
  http.register('GET', '/v1/info', async ({ request, query: params, send }) => {
    service.authenticate(request.headers.authorization);
    if (params.size) fail('invalid_request');
    const info = await store.info();
    send(200, { store_id: info.storeId, version: '0.1.0-dev', latest_seq: info.latestSeq.toString(), features: { capabilities: true, call_records: true, sse: false } });
  });
  http.register('POST', '/v1/events', async ({ request, query: params, readBody, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    if (params.size) fail('invalid_request');
    const value = appendBody(await readBody());
    const result = await events.append(principal, value.storeId, value.input);
    send(result.status === 'created' ? 201 : 200, wireAppend(result));
  });
  http.register('GET', '/v1/events', async ({ request, query: params, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    const value = readQuery(params);
    send(200, wirePage(await events.read(principal, value.storeId, value.options)));
  });
  http.register('GET', '/v1/events/lookup', async ({ request, query: params, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    const value = lookupQuery(params);
    send(200, { store_id: value.storeId, record: wireRecord(await events.lookup(principal, value.storeId, value.ref)) });
  });
  http.register('GET', '/v1/capabilities', async ({ request, query: params, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    if (params.size) fail('invalid_request');
    const descriptions = capabilities.list(principal);
    send(200, { store_id: (await store.info()).storeId, capabilities: descriptions.map(wireCapability) });
  });
  http.register('POST', '/v1/capabilities/:capability/invoke', async ({ request, query: params, params: routeParams, readBody, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    if (params.size) fail('invalid_request');
    const id = routeParams.capability!;
    if (!capabilityPattern.test(id)) fail('invalid_request');
    const value = invokeBody(await readBody());
    const result = await capabilities.invoke(principal, value.storeId, id, value.params, value.callId);
    send(result.kind === 'call' && result.call.status === 'in_progress' ? 202 : 200, wireInvocation(result));
  });
  http.register('GET', '/v1/calls/:callId', async ({ request, query: params, params: routeParams, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    const callId = routeParams.callId!;
    const storeId = storeQuery(params);
    send(200, { store_id: storeId, kind: 'call', call: wireCall(await capabilities.getCall(principal, storeId, callId)) });
  });
  http.register('GET', '/v1/plugins', async ({ request, query: params, send }) => {
    const principal = service.authenticate(request.headers.authorization);
    if (params.size) fail('invalid_request');
    requirePermission(principal, 'runtime:inspect');
    send(200, { store_id: (await store.info()).storeId, plugins: plugins() });
  });
}

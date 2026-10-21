import type { Context } from 'cordis';
import type {} from '../../host/protocol.js';
import type { HttpRequest } from '../server-http/server.js';
import { requirePermission } from '../../core/access.js';
import { GatewayError, fail } from '../../core/errors.js';
import { capabilityPattern, fields } from '../../core/validation.js';
import type { JsonObject, Principal } from '../../core/types.js';
import { appendBody, invokeBody, lookupQuery, readQuery, storeQuery, wireAppend, wireCall, wireCapability, wireInvocation, wirePage, wireRecord } from './dto.js';

type AuthorizedRequest = HttpRequest & { principal: Principal };

export const name = 'api-rest';
export const client = 'entry.js';
export const inject = ['http', 'protocol'];
export function apply(ctx: Context, input: JsonObject): void {
  fields(input, [], []);
  const service = ctx.protocol.forPlugin(ctx);
  const { store, events, capabilities, plugins } = service;
  const scope = ctx.http.scope(ctx);
  // Every route authenticates through here, so a handler cannot run unauthenticated.
  const route = (
    method: string,
    pattern: string,
    handler: (request: AuthorizedRequest) => void | Promise<void>,
    options: { emptyQuery?: boolean } = {},
  ): void => {
    scope.register(method, pattern, async (request) => {
      const principal = service.authenticate(request.request.headers.authorization);
      if (options.emptyQuery && request.queryText) fail('invalid_request');
      await handler({ ...request, principal });
    });
  };
  route('GET', '/v1/info', async ({ send }) => {
    const info = await store.info();
    send(200, { store_id: info.storeId, version: '0.1.0-dev', latest_seq: info.latestSeq.toString(), features: { capabilities: true, call_records: true, sse: false } });
  }, { emptyQuery: true });
  route('POST', '/v1/events', async ({ principal, readBody, send }) => {
    const value = appendBody(await readBody());
    const result = await events.append(principal, value.storeId, value.input);
    send(result.status === 'created' ? 201 : 200, wireAppend(result));
  }, { emptyQuery: true });
  route('GET', '/v1/events', async ({ principal, query, send }) => {
    const value = readQuery(query);
    send(200, wirePage(await events.read(principal, value.storeId, value.options)));
  });
  route('GET', '/v1/events/lookup', async ({ principal, query, send }) => {
    const value = lookupQuery(query);
    send(200, { store_id: value.storeId, record: wireRecord(await events.lookup(principal, value.storeId, value.ref)) });
  });
  route('GET', '/v1/capabilities', async ({ principal, send }) => {
    const descriptions = capabilities.list(principal);
    send(200, { store_id: (await store.info()).storeId, capabilities: descriptions.map(wireCapability) });
  }, { emptyQuery: true });
  route('POST', '/v1/capabilities/:capability/invoke', async ({ principal, params: routeParams, readBody, send }) => {
    const id = routeParams.capability!;
    if (!capabilityPattern.test(id)) fail('invalid_request');
    const value = invokeBody(await readBody());
    const result = await capabilities.invoke(principal, value.storeId, id, value.params, value.callId);
    send(result.kind === 'call' && result.call.status === 'in_progress' ? 202 : 200, wireInvocation(result));
  }, { emptyQuery: true });
  route('GET', '/v1/calls/:callId', async ({ principal, query, params: routeParams, send }) => {
    const callId = routeParams.callId!;
    const storeId = storeQuery(query);
    send(200, { store_id: storeId, kind: 'call', call: wireCall(await capabilities.getCall(principal, storeId, callId)) });
  });
  route('GET', '/v1/plugins', async ({ principal, send }) => {
    requirePermission(principal, 'runtime:inspect');
    send(200, { store_id: (await store.info()).storeId, plugins: plugins() });
  }, { emptyQuery: true });
  // Unmatched /v1 paths still authenticate first so callers cannot enumerate routes.
  scope.register('*', '/v1/*rest', async ({ request }) => {
    try { service.authenticate(request.headers.authorization); }
    catch (error) {
      // Before readiness there is no protocol route yet; keep the historical 404 for
      // unknown paths instead of reporting the host readiness state.
      if (!(error instanceof GatewayError) || error.code !== 'provider_unavailable') throw error;
    }
    fail('not_found');
  });
}

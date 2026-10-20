import type { Context } from 'cordis';
import type {} from '../../host/protocol.js';
import type {} from '../server-http/server.js';
import { fail } from '../../core/errors.js';
import { fields } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';
import { serveMcp } from './server.js';

const MCP_PATH = '/v1/mcp';
declare module 'cordis' { interface Context { mcp: { path: string } } }

export const name = 'adapter-mcp';
export const inject = ['http', 'protocol'];
export function apply(ctx: Context, input: JsonObject): void {
  fields(input, [], []);
  const service = ctx.protocol.forPlugin(ctx);
  ctx.http.scope(ctx).register('*', MCP_PATH, async ({ request, response, requestId, origin, queryText, readBody }) => {
    const principal = service.authenticate(request.headers.authorization);
    if (queryText) fail('invalid_request');
    await serveMcp(request, response, { ...service, principal, requestId, origin, report: (code) => service.report(code, requestId) }, readBody);
  });
  ctx.provide('mcp', { path: MCP_PATH });
}

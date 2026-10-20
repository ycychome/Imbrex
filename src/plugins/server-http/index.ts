import type { Context } from 'cordis';
import type { JsonObject } from '../../core/types.js';
import { parseServerHttpConfig } from './config.js';
import { HttpServer } from './server.js';
import type {} from '../../host/protocol.js';

export const name = 'server-http';
export const inject = ['imbrex', 'protocol'];
export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  const { host, port } = parseServerHttpConfig(input);
  const api = ctx.imbrex.forPlugin(ctx);
  const http = new HttpServer(host, (code) => api.setAvailable(false, { code }), (code, requestId) => ctx.protocol.reportRequest(ctx, code, requestId));
  ctx.effect(() => () => http.close());
  api.signal.addEventListener('abort', () => http.stop(), { once: true });
  await http.listen(port);
  ctx.provide('http', http);
}

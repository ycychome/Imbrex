import type { Context } from 'cordis';
import { fields, object, string } from '../../core/validation.js';
import { fail } from '../../core/errors.js';
import type { JsonObject } from '../../core/types.js';
import { HttpServer } from './server.js';

export const name = 'server-http';
export const inject = ['imbrex'];
export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  const config = object(input);
  fields(config, ['host', 'port'], ['host', 'port']);
  const host = string(config.host, 253);
  const port = config.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_request');
  const api = ctx.imbrex.forPlugin(ctx);
  const http = new HttpServer(host, (code) => api.setAvailable(false, { code }));
  ctx.effect(() => () => http.close());
  api.signal.addEventListener('abort', () => http.stop(), { once: true });
  await http.listen(port);
  ctx.provide('http', http);
}

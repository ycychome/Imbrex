import { fail } from '../../core/errors.js';
import { fields, object, string } from '../../core/validation.js';
import type { JsonObject } from '../../core/types.js';

export interface ServerHttpConfig {
  host: string;
  port: number;
}

export function parseServerHttpConfig(input: JsonObject): ServerHttpConfig {
  const config = object(input);
  fields(config, ['host', 'port'], ['host', 'port']);
  const host = string(config.host, 253);
  const port = config.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_request');
  return { host, port };
}

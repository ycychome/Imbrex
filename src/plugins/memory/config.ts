import { fail } from '../../core/errors.js';
import { fields, object, string } from '../../core/validation.js';

export interface MemoryConfig {
  serviceUrl: string;
  serviceTokenEnv: string;
  sources: string[];
  messageReaders: Record<string, string>;
  requestTimeoutMs: number;
  pollMs: number;
  batchWaitMs: number;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) fail('invalid_request', 'Invalid memory configuration');
  return result;
}

export function parseMemoryConfig(input: unknown): MemoryConfig {
  const value = object(input);
  fields(value, ['service_url', 'service_token_env', 'sources', 'message_readers', 'request_timeout_ms', 'poll_ms', 'batch_wait_ms'],
    ['service_url', 'service_token_env', 'sources']);
  const serviceUrl = string(value.service_url, 2048);
  let url: URL;
  try { url = new URL(serviceUrl); } catch { return fail('invalid_request', 'Invalid memory service URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('invalid_request', 'Invalid memory service URL');
  const serviceTokenEnv = string(value.service_token_env, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(serviceTokenEnv)) fail('invalid_request', 'Invalid memory token environment name');
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 32) fail('invalid_request', 'Invalid memory sources');
  const sources = [...new Set(value.sources.map((item) => string(item, 1024)))];
  if (sources.length !== value.sources.length || sources.some((source) => !/^imbrex:\/\/qq\/[1-9][0-9]*\/[a-z][a-z0-9_-]{0,63}\/(?:group|private)\/[1-9][0-9]*$/.test(source))) {
    fail('invalid_request', 'Memory sources must be distinct complete QQ conversation sources');
  }
  const readerValue = value.message_readers === undefined ? {} : object(value.message_readers);
  const messageReaders: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [prefix, capability] of Object.entries(readerValue)) {
    if (!/^imbrex:\/\/qq\/[1-9][0-9]*\/[a-z][a-z0-9_-]{0,63}\/(?:(?:group|private)\/[1-9][0-9]*)?$/.test(prefix)) fail('invalid_request', 'Invalid message reader scope');
    const id = string(capability, 129);
    if (!/^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_]{0,63}$/.test(id)) fail('invalid_request', 'Invalid message reader capability');
    messageReaders[prefix] = id;
  }
  return {
    serviceUrl: url.origin + url.pathname.replace(/\/$/, ''), serviceTokenEnv, sources, messageReaders,
    requestTimeoutMs: integer(value.request_timeout_ms, 5000, 100, 30000),
    pollMs: integer(value.poll_ms, 1000, 100, 60000),
    batchWaitMs: integer(value.batch_wait_ms, 5000, 0, 5000),
  };
}

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { requirePermission } from '../../core/access.js';
import { fail, GatewayError, publicError } from '../../core/errors.js';
import { capabilityPattern, limits } from '../../core/validation.js';
import type { Capabilities } from '../../core/capabilities.js';
import type { Events } from '../../core/events.js';
import type { GatewayStore } from '../../core/store.js';
import type { HostConfig } from '../../host/config.js';
import { appendBody, invokeBody, lookupQuery, readQuery, storeQuery, wireAppend, wireCall, wireInvocation, wirePage, wireRecord } from './dto.js';

function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) fail('invalid_request', 'Expected UTF-8 application/json');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail('invalid_request', 'Compressed requests are unsupported');
  if (Number(request.headers['content-length']) > limits.httpBytes) fail('payload_too_large');
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = () => { cleanup(); reject(new Error('Request interrupted')); };
    const aborted = () => error();
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.httpBytes) {
        cleanup(); request.pause();
        reject(new GatewayError('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new GatewayError('invalid_request', 'Invalid JSON')); }
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
}

export async function startHttp(config: HostConfig, store: GatewayStore, events: Events, capabilities: Capabilities, plugins: () => unknown[], report: (code: string, requestId: string) => void) {
  let closing = false;
  let active = 0;
  const pending = new Set<Promise<void>>();
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID();
    request.on('error', () => {});
    response.on('error', () => request.destroy());
    const send = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId });
      response.end(JSON.stringify(value));
    };
    let counted = false;
    try {
      if (closing) fail('provider_unavailable');
      if (active >= limits.queue) fail('busy');
      active += 1; counted = true;
      const principal = config.authenticate(request.headers.authorization);
      const target = request.url ?? '/';
      try { decodeURIComponent(target); } catch { fail('invalid_request', 'Invalid UTF-8 request target'); }
      if (!target.startsWith('/') || target.includes('#')) fail('invalid_request');
      // A call ID may be "." or "..". WHATWG URL would silently normalize these path segments.
      const boundary = target.indexOf('?');
      const path = boundary < 0 ? target : target.slice(0, boundary);
      const search = boundary < 0 ? '' : target.slice(boundary + 1);
      const params = new URLSearchParams(search);
      if (request.method === 'GET' && path === '/v1/info') {
        if (search) fail('invalid_request');
        const info = await store.info();
        send(200, { store_id: info.storeId, version: '0.1.0-dev', latest_seq: info.latestSeq.toString(), features: { capabilities: true, call_records: true, sse: false } });
      } else if (request.method === 'POST' && path === '/v1/events') {
        if (search) fail('invalid_request');
        const value = appendBody(await body(request));
        const result = await events.append(principal, value.storeId, value.input);
        send(result.status === 'created' ? 201 : 200, wireAppend(result));
      } else if (request.method === 'GET' && path === '/v1/events') {
        const value = readQuery(params);
        send(200, wirePage(await events.read(principal, value.storeId, value.options)));
      } else if (request.method === 'GET' && path === '/v1/events/lookup') {
        const value = lookupQuery(params);
        send(200, { store_id: value.storeId, record: wireRecord(await events.lookup(principal, value.storeId, value.ref)) });
      } else if (request.method === 'GET' && path === '/v1/capabilities') {
        if (search) fail('invalid_request');
        const descriptions = capabilities.list(principal);
        send(200, { store_id: (await store.info()).storeId, capabilities: descriptions.map((item) => ({
          id: item.id, plugin_instance_id: item.pluginInstanceId, description: item.description, schema_version: item.schemaVersion,
          is_side_effectful: item.isSideEffectful, input_schema: item.inputSchema,
        })) });
      } else if (request.method === 'POST' && /^\/v1\/capabilities\/[^/]+\/invoke$/.test(path)) {
        if (search) fail('invalid_request');
        let id: string;
        try { id = decodeURIComponent(path.split('/')[3]!); } catch { fail('invalid_request'); }
        if (!capabilityPattern.test(id)) fail('invalid_request');
        const value = invokeBody(await body(request));
        const result = await capabilities.invoke(principal, value.storeId, id, value.params, value.callId);
        send(result.kind === 'call' && result.call.status === 'in_progress' ? 202 : 200, wireInvocation(result));
      } else if (request.method === 'GET' && /^\/v1\/calls\/[^/]+$/.test(path)) {
        let callId: string;
        try { callId = decodeURIComponent(path.split('/')[3]!); } catch { fail('invalid_request'); }
        const storeId = storeQuery(params);
        send(200, { store_id: storeId, kind: 'call', call: wireCall(await capabilities.getCall(principal, storeId, callId)) });
      } else if (request.method === 'GET' && path === '/v1/plugins') {
        if (search) fail('invalid_request');
        requirePermission(principal, 'runtime:inspect');
        send(200, { store_id: (await store.info()).storeId, plugins: plugins() });
      } else { fail('not_found'); }
    } catch (cause) {
      const error = publicError(cause);
      report(error.code, requestId);
      response.setHeader('connection', 'close');
      send(error.status, { error: { code: error.code, message: error.message }, request_id: requestId });
    } finally { if (counted) active -= 1; }
  };
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 15_000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const task = serve(request, response);
    pending.add(task);
    task.then(() => pending.delete(task), () => { pending.delete(task); response.destroy(); });
  });
  server.on('error', () => report('http_server_error', ''));
  const listening = once(server, 'listening');
  server.listen(config.http.port, config.http.host);
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  let shutdown: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => shutdown ??= (async () => {
      closing = true;
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await Promise.allSettled([...pending]);
      await closed;
    })(),
  };
}

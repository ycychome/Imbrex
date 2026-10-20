import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Context } from 'cordis';
import { fail, GatewayError, publicError, type ErrorCode } from '../../core/errors.js';
import { limits } from '../../core/validation.js';
import type {} from '../../host/plugin-api.js';

export interface HttpRequest {
  request: IncomingMessage; response: ServerResponse; requestId: string; origin: string;
  params: Record<string, string>; query: URLSearchParams; queryText: string;
  readBody(): Promise<unknown>;
  send(status: number, value: unknown): void;
  ensureActive(): void;
}
export type HttpHandler = (request: HttpRequest) => void | Promise<void>;
interface Route {
  method: string; pattern: string; parts: string[]; wildcard: boolean; handler: HttpHandler; active: boolean;
  pending: Set<Promise<void>>; requests: Set<IncomingMessage>;
}
export interface HttpScope {
  register(method: string, pattern: string, handler: HttpHandler): () => void;
  static(prefix: string, rootDir: string): Promise<() => void>;
}
declare module 'cordis' { interface Context { http: HttpServer } }

function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) fail('invalid_request', 'Expected UTF-8 application/json');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail('invalid_request', 'Compressed requests are unsupported');
  if (Number(request.headers['content-length']) > limits.httpBytes) fail('payload_too_large');
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', error); };
    const error = () => { cleanup(); reject(new GatewayError('invalid_request', 'Request interrupted')); };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.httpBytes) { cleanup(); request.pause(); reject(new GatewayError('payload_too_large')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new GatewayError('invalid_request', 'Invalid JSON')); }
    };
    if (request.destroyed) { error(); return; }
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', error);
  });
}

export class HttpServer {
  private routes = new Set<Route>();
  private pending = new Set<Promise<void>>();
  private stopped = false;
  private shutdown?: Promise<void>;
  private closed: Promise<void> = Promise.resolve();
  private server = createServer({ requestTimeout: 15_000, headersTimeout: 15_000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const task = this.serve(request, response);
    this.pending.add(task);
    task.then(() => this.pending.delete(task), () => { this.pending.delete(task); response.destroy(); });
  });
  constructor(private host: string, private report: (code: string) => void, private reportRequest: (code: ErrorCode, requestId: string) => void) {
    this.server.on('error', () => this.report('http_server_error'));
  }
  async listen(port: number): Promise<void> {
    const listening = once(this.server, 'listening');
    this.server.listen(port, this.host);
    await listening;
  }
  get port(): number { const address = this.server.address(); return address && typeof address !== 'string' ? address.port : 0; }
  get origin(): string { return new URL('http://' + (this.host.includes(':') ? '[' + this.host + ']' : this.host) + ':' + this.port).origin; }
  scope(ctx: Context): HttpScope {
    const signal = ctx.imbrex.forPlugin(ctx).signal;
    const owned: Route[] = [];
    const remove = (route: Route) => { route.active = false; this.routes.delete(route); };
    const stop = () => { for (const route of owned) remove(route); };
    signal.addEventListener('abort', stop, { once: true });
    ctx.effect(() => async () => {
      stop(); signal.removeEventListener('abort', stop);
      await Promise.allSettled(owned.flatMap((route) => [...route.pending]));
    });
    const register = (method: string, pattern: string, handler: HttpHandler) => {
      if (signal.aborted || this.stopped) fail('provider_unavailable');
      if (!pattern.startsWith('/') || !/^(GET|POST|HEAD|PUT|DELETE|\*)$/.test(method)) fail('invalid_request');
      if ([...this.routes].some((route) => route.pattern === pattern && (route.method === method || method === '*' || route.method === '*'))) fail('invalid_request', 'Duplicate HTTP route');
      const parts = pattern.split('/');
      const route: Route = { method, pattern, parts, wildcard: parts.some((part) => part.startsWith('*')), handler, active: true, pending: new Set(), requests: new Set() };
      this.routes.add(route); owned.push(route);
      return () => remove(route);
    };
    return { register, static: async (prefix, rootDir) => {
      const root = await realpath(rootDir);
      if (!(await stat(root)).isDirectory() || !/^\/[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.endsWith('/')) fail('invalid_request');
      const serve: HttpHandler = async ({ request, response, params }) => {
        const path = params.asset ?? '';
        if (path.includes('\0') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) fail('not_found');
        let candidate = resolve(root, path || 'index.html');
        try { candidate = await realpath(candidate); }
        catch {
          if (extname(path)) fail('not_found');
          candidate = await realpath(resolve(root, 'index.html')).catch(() => fail('not_found'));
        }
        const rel = relative(root, candidate);
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) fail('not_found');
        const info = await stat(candidate);
        if (!info.isFile()) fail('not_found');
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
        const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
        const cache = { etag, 'cache-control': 'no-cache' };
        if (request.headers['if-none-match']?.split(',').some((tag) => tag.trim() === etag)) {
          response.writeHead(304, cache);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': types[extname(candidate)] ?? 'application/octet-stream', 'content-length': info.size, 'x-content-type-options': 'nosniff', 'last-modified': info.mtime.toUTCString(), ...cache });
        if (request.method === 'HEAD') response.end();
        else await pipeline(createReadStream(candidate), response);
      };
      const dispose = ['GET', 'HEAD'].flatMap((method) => [register(method, prefix, serve), register(method, prefix + '/*asset', serve)]);
      return () => { for (const remove of dispose) remove(); };
    } };
  }
  private match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split('/');
    const find = (wildcard: boolean) => {
      for (const route of this.routes) {
        if (route.wildcard !== wildcard || (route.method !== '*' && route.method !== method)) continue;
        const params: Record<string, string> = Object.create(null) as Record<string, string>;
        let matches = true;
        for (let i = 0; i < route.parts.length; i += 1) {
          const part = route.parts[i]!;
          if (part.startsWith('*')) { params[part.slice(1)] = decodeURIComponent(parts.slice(i).join('/')); break; }
          if (parts[i] === undefined) { matches = false; break; }
          if (part.startsWith(':')) {
            if (parts[i] === '') { matches = false; break; }
            params[part.slice(1)] = decodeURIComponent(parts[i]!);
          } else if (part !== parts[i]) { matches = false; break; }
          if (i === route.parts.length - 1 && parts.length !== route.parts.length) matches = false;
        }
        if (matches) return { route, params };
      }
      return undefined;
    };
    // Literal and :param routes win over trailing * routes regardless of registration order.
    return find(false) ?? find(true);
  }
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    request.on('error', () => {}); response.on('error', () => request.destroy());
    const send = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId });
      response.end(JSON.stringify(value));
    };
    let route: Route | undefined;
    let work: Promise<void> | undefined;
    try {
      if (this.stopped) fail('provider_unavailable');
      if (this.pending.size >= limits.queue) fail('busy');
      const target = request.url ?? '/';
      try { decodeURIComponent(target); } catch { fail('invalid_request', 'Invalid UTF-8 request target'); }
      if (!target.startsWith('/') || target.includes('#')) fail('invalid_request');
      // Preserve opaque call IDs such as '.' and '..'; never normalize the HTTP path.
      const boundary = target.indexOf('?');
      const path = boundary < 0 ? target : target.slice(0, boundary);
      const queryText = boundary < 0 ? '' : target.slice(boundary + 1);
      const matched = this.match(request.method ?? '', path) ?? fail('not_found');
      route = matched.route; route.requests.add(request);
      const active = route;
      const ensureActive = () => { if (!active.active || this.stopped) fail('provider_unavailable'); };
      work = Promise.resolve().then(() => route!.handler({ request, response, requestId, origin: this.origin, params: matched.params,
        query: new URLSearchParams(queryText), queryText, send, ensureActive,
        readBody: async () => { const value = await readBody(request); ensureActive(); return value; },
      }));
      route.pending.add(work);
      await work;
    } catch (cause) {
      const error = publicError(cause);
      try { this.reportRequest(error.code, requestId); } catch { /* Reporting does not change the response or listener availability. */ }
      if (response.headersSent) { response.destroy(); return; }
      response.setHeader('connection', 'close');
      send(error.status, { error: { code: error.code, message: error.message }, request_id: requestId });
    } finally { if (work) route?.pending.delete(work); route?.requests.delete(request); }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closed = new Promise<void>((done) => { this.server.close(() => done()); });
    this.server.closeIdleConnections();
  }
  close(): Promise<void> { return this.shutdown ??= (async () => {
    this.stop();
    await Promise.allSettled([...this.pending]);
    this.server.closeIdleConnections();
    await this.closed;
  })(); }
}

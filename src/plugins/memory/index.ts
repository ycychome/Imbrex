import { createHash } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from 'cordis';
import { fail, publicError } from '../../core/errors.js';
import { fields, json, limits, object, string } from '../../core/validation.js';
import type { EventRecord, EventRef, JsonObject, JsonValue } from '../../core/types.js';
import type { PluginApi, ReadScope } from '../../host/plugin-api.js';
import { parseMemoryConfig, type MemoryConfig } from './config.js';

export const name = 'memory';
export const inject = ['imbrex'];

type ReadKind = 'search' | 'context' | 'get' | 'status' | 'operation';
type WriteKind = 'ingest' | 'images' | 'remember' | 'update' | 'forget' | 'rebuild';
type ToolWriteKind = Exclude<WriteKind, 'ingest' | 'images'>;
type WriteOutcome = { status: 'succeeded'; result: JsonObject } | { status: 'failed'; reason: JsonObject } | { status: 'unknown'; reason: JsonObject };
interface ScopeRef { source: string; id: string }
interface Identity { account_id: string; identity_namespace: string; conversation_type: 'group' | 'private'; conversation_id: string; sender_id: string }
interface Selection { reader: ReadScope; sources: string[] }
interface Task { request_id: string; kind: 'ingest' | 'rebuild'; scopes: string[]; source: string; from_seq: string; to_seq: string; payload: JsonObject; terminal?: 'failed' | 'unknown'; terminal_reason?: string }
interface MaterialTask { request_id: string; parent_request_id: string; source: string; event_ref: ScopeRef; generation: number; images: JsonObject[]; payload?: JsonObject; terminal?: 'failed' | 'unknown'; terminal_reason?: string }
interface MemoryState {
  version: 2; store_id: string; instance_id: string; service_url: string; service_ledger_id: string | null; selection: Selection; fixed_latest_seq: string; generation: number;
  accepted_seq: string; indexed_seq: string; pending: Task[]; materials: MaterialTask[];
}
const MEMORY_CATEGORIES = ['profile', 'preference', 'style', 'relationship', 'meme', 'episode', 'fact', 'knowledge', 'commitment', 'procedure'] as const;
class MemoryError extends Error { constructor(readonly code: string) { super(code); } }

const safeInt = (value: unknown, min: number, max: number, code = 'invalid_params'): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new MemoryError(code);
  return value;
};
function parseRef(value: unknown): ScopeRef {
  const ref = object(value, 'invalid_params'); fields(ref, ['source', 'id'], ['source', 'id'], 'invalid_params');
  return { source: string(ref.source, 1024, 'invalid_params'), id: string(ref.id, 256, 'invalid_params') };
}
function isAllowedSource(source: string, config: MemoryConfig, scope: ReadScope): boolean {
  return config.sources.includes(source) && scope.sources.some((rule) => 'exact' in rule ? rule.exact === source : source.startsWith(rule.prefix));
}
function sourceIdentity(source: string): Omit<Identity, 'sender_id'> | undefined {
  const match = /^imbrex:\/\/qq\/([1-9][0-9]*)\/([a-z][a-z0-9_-]{0,63})\/(group|private)\/([1-9][0-9]*)$/.exec(source);
  return match ? { account_id: match[1]!, identity_namespace: match[2]!, conversation_type: match[3] as Identity['conversation_type'], conversation_id: match[4]! } : undefined;
}
function validateInbound(record: EventRecord, config: MemoryConfig): Identity {
  if (record.parents.length || !config.sources.includes(record.event.source)) throw new MemoryError('forbidden');
  const source = sourceIdentity(record.event.source);
  const data = object(record.event.data, 'forbidden');
  if (!source || !['qq.message.group', 'qq.message.private'].includes(record.event.type) || record.event.type !== `qq.message.${source.conversation_type}` ||
      data.direction !== 'inbound' || data.account_id !== source.account_id || data.identity_namespace !== source.identity_namespace ||
      data.conversation_type !== source.conversation_type || data.conversation_id !== source.conversation_id ||
      typeof data.sender_id !== 'string' || !/^[1-9][0-9]*$/.test(data.sender_id) || data.sender_id === source.account_id ||
      (source.conversation_type === 'private' && data.sender_id !== source.conversation_id) || typeof data.native_message_id !== 'string' ||
      record.event.id !== `message:${data.native_message_id}` || typeof data.text !== 'string') throw new MemoryError('forbidden');
  return { ...source, sender_id: data.sender_id };
}
async function checkedRef(ref: ScopeRef, config: MemoryConfig, allowed: ReadScope, lookup: (ref: EventRef) => Promise<EventRecord>): Promise<{ record: EventRecord; identity: Identity }> {
  if (!isAllowedSource(ref.source, config, allowed)) fail('forbidden');
  let record: EventRecord;
  try { record = await lookup(ref); } catch { fail('forbidden'); }
  try { return { record, identity: validateInbound(record, config) }; }
  catch { fail('forbidden'); }
}
function refs(value: unknown, config: MemoryConfig, scope: ReadScope): ScopeRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail('invalid_params');
  const result = value.map(parseRef);
  if (result.some((ref) => !isAllowedSource(ref.source, config, scope))) fail('forbidden');
  return result;
}
function parseState(value: unknown): MemoryState {
  const state = object(value);
  fields(state, ['version', 'store_id', 'instance_id', 'service_url', 'service_ledger_id', 'selection', 'fixed_latest_seq', 'generation', 'accepted_seq', 'indexed_seq', 'pending', 'materials'],
    ['version', 'store_id', 'instance_id', 'service_url', 'service_ledger_id', 'selection', 'fixed_latest_seq', 'generation', 'accepted_seq', 'indexed_seq', 'pending', 'materials']);
  if (state.version !== 2 || typeof state.store_id !== 'string' || typeof state.instance_id !== 'string' || typeof state.service_url !== 'string' ||
      (state.service_ledger_id !== null && (typeof state.service_ledger_id !== 'string' || !/^[a-f0-9]{64}$/.test(state.service_ledger_id))) ||
      !Array.isArray(state.pending) || !Array.isArray(state.materials) || !Number.isSafeInteger(state.generation) || (state.generation as number) < 0) throw new MemoryError('memory_state_invalid');
  const sequence = (input: unknown): string => {
    if (typeof input !== 'string' || !/^(0|[1-9][0-9]*)$/.test(input)) throw new MemoryError('memory_state_invalid');
    return input;
  };
  return { version: 2, store_id: state.store_id, instance_id: state.instance_id, service_url: state.service_url, service_ledger_id: state.service_ledger_id as string | null, selection: state.selection as unknown as Selection,
    fixed_latest_seq: sequence(state.fixed_latest_seq), generation: state.generation as number, accepted_seq: sequence(state.accepted_seq), indexed_seq: sequence(state.indexed_seq),
    pending: state.pending.map((item) => {
      const task = object(item); fields(task, ['request_id', 'kind', 'scopes', 'source', 'from_seq', 'to_seq', 'payload', 'terminal', 'terminal_reason'], ['request_id', 'kind', 'scopes', 'source', 'from_seq', 'to_seq', 'payload']);
      if (!['ingest', 'rebuild'].includes(String(task.kind)) || !Array.isArray(task.scopes) || task.scopes.some((scope) => typeof scope !== 'string')) throw new MemoryError('memory_state_invalid');
      if (task.terminal !== undefined && !['failed', 'unknown'].includes(String(task.terminal))) throw new MemoryError('memory_state_invalid');
      return { request_id: string(task.request_id, 128), kind: task.kind as Task['kind'], scopes: task.scopes as string[], source: string(task.source, 1024), from_seq: sequence(task.from_seq), to_seq: sequence(task.to_seq), payload: object(task.payload) as JsonObject,
        ...(task.terminal === undefined ? {} : { terminal: task.terminal as Task['terminal'] }), ...(task.terminal_reason === undefined ? {} : { terminal_reason: string(task.terminal_reason, 128) }) };
    }), materials: state.materials.map((item) => {
      const task = object(item); fields(task, ['request_id', 'parent_request_id', 'source', 'event_ref', 'generation', 'images', 'payload', 'terminal', 'terminal_reason'], ['request_id', 'parent_request_id', 'source', 'event_ref', 'generation', 'images']);
      if (!Number.isSafeInteger(task.generation) || (task.generation as number) < 0 || !Array.isArray(task.images)) throw new MemoryError('memory_state_invalid');
      const requestId = string(task.request_id, 64), parentRequestId = string(task.parent_request_id, 64);
      if (!/^[a-f0-9]{64}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(parentRequestId)) throw new MemoryError('memory_state_invalid');
      return { request_id: requestId, parent_request_id: parentRequestId, source: string(task.source, 1024),
        event_ref: parseRef(task.event_ref), generation: task.generation as number, images: task.images.map((image) => object(image) as JsonObject),
        ...(task.payload === undefined ? {} : { payload: object(task.payload) as JsonObject }),
        ...(task.terminal === undefined ? {} : { terminal: task.terminal as MaterialTask['terminal'] }),
        ...(task.terminal_reason === undefined ? {} : { terminal_reason: string(task.terminal_reason, 128) }) };
    }) };
}
function selectionFor(config: MemoryConfig, scope: ReadScope): Selection {
  if (config.sources.some((source) => !scope.sources.some((rule) => 'exact' in rule ? rule.exact === source : source.startsWith(rule.prefix)))) throw new MemoryError('memory_scope_mismatch');
  return { reader: scope, sources: [...config.sources] };
}
async function saveState(path: string, state: MemoryState): Promise<void> {
  const temporary = path + '.tmp';
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(join(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safeReason(error: unknown): string { return error instanceof MemoryError ? error.code : publicError(error).code; }

class MemoryPlugin {
  private stopped = false;
  private paused = false;
  private busy = false;
  private requested = false;
  private materialsRequested = false;
  private materialsBusy = false;
  private serviceReady = false;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe: () => void = () => {};
  private worker: Promise<void> = Promise.resolve();
  private materialsWorker: Promise<void> = Promise.resolve();
  private healthWorker: Promise<void> = Promise.resolve();
  private stateQueue: Promise<void> = Promise.resolve();
  constructor(private api: PluginApi, private config: MemoryConfig, private token: string, private path: string,
    private state: MemoryState, private scope: ReadScope) { this.paused = state.pending.some((task) => task.kind === 'rebuild'); }

  private url(path: string): string { return this.config.serviceUrl + path; }
  private async request(path: string, body?: JsonObject): Promise<JsonObject> {
    const response = await fetch(this.url(path), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([this.api.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 64 * 1024) throw new MemoryError('memory_response_too_large');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MemoryError('memory_invalid_response'); }
    const result = object(parsed);
    if (!response.ok) {
      const error = object(result.error ?? {});
      const code = typeof error.code === 'string' ? error.code : 'memory_service_error';
      if (response.status === 403) throw new MemoryError('forbidden');
      if (response.status === 404) throw new MemoryError(code === 'not_found' ? 'not_found' : 'memory_service_error');
      if (response.status === 409) throw new MemoryError('invalid_params');
      if (response.status === 429) throw new MemoryError('busy');
      if (response.status >= 500) throw new MemoryError('memory_service_unavailable');
      throw new MemoryError(code === 'invalid_params' ? code : 'memory_service_error');
    }
    return json(result) as JsonObject;
  }
  private scopes(sourceList: string[]): string[] { return [...new Set(sourceList)]; }
  operationId(kind: ToolWriteKind, callerId: string, callId: string | undefined): string {
    return digest({ store: this.state.store_id, instance: this.api.instanceId, caller: callerId, kind, call_id: callId });
  }
  async query(kind: ReadKind, params: JsonObject, callerId: string, sources: string[]): Promise<JsonObject> {
    const result = await this.request('/v1/query', { store_id: this.state.store_id, instance_id: this.api.instanceId, caller_id: callerId,
      scopes: this.scopes(sources), kind, params });
    if (kind === 'operation' && typeof params.operation_id === 'string') await this.completeRebuildIf(params.operation_id, result);
    return result;
  }
  localStatus(): JsonObject {
    return { fixed_latest_seq: this.state.fixed_latest_seq, accepted_seq: this.state.accepted_seq, indexed_seq: this.state.indexed_seq,
      pending: this.state.pending.length + this.state.materials.length, images_pending: this.state.materials.length,
      operation_failures: this.state.pending.filter((task) => task.terminal).map((task) => ({ operation_id: task.request_id, state: task.terminal!, reason: task.terminal_reason ?? task.terminal! })),
      image_failures: this.state.materials.filter((task) => task.terminal).map((task) => ({ operation_id: task.request_id, state: task.terminal!, reason: task.terminal_reason ?? task.terminal! })), paused: this.paused };
  }
  async write(kind: WriteKind, payload: JsonObject, callerId: string, sourceList: string[], requestId?: string): Promise<WriteOutcome> {
    const actualId = kind === 'ingest' || kind === 'images' ? requestId! : this.operationId(kind, callerId, requestId);
    const requestBody: JsonObject = { request_id: actualId, store_id: this.state.store_id, instance_id: this.api.instanceId,
      caller_id: callerId, scopes: this.scopes(sourceList), kind, payload };
    let result: JsonObject;
    try {
      result = await this.request('/v1/operations', requestBody);
    } catch (error) {
      if (error instanceof MemoryError && ['busy', 'forbidden', 'invalid_params'].includes(error.code)) throw error;
      try { result = await this.request('/v1/operations', requestBody); }
      catch { return { status: 'unknown', reason: { code: 'memory_operation_unconfirmed', message: 'Operation response was not confirmed.' } }; }
    }
    const operationId = typeof result.operation_id === 'string' ? result.operation_id : actualId;
    if (operationId !== actualId || result.accepted !== true || typeof result.applied !== 'boolean' || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(result.state))) {
      return { status: 'unknown', reason: { code: 'memory_operation_unconfirmed', message: 'Operation acceptance was not confirmed.' } };
    }
    return { status: 'succeeded', result: { operation_id: operationId, state: result.state as JsonValue, accepted: true, applied: result.applied } };
  }
  async prepareRebuild(operationId: string, reason: string, scopes: string[]): Promise<void> {
    await this.updateState((state) => {
      if (state.pending.some((task) => task.kind === 'rebuild' && task.request_id !== operationId)) throw new MemoryError('busy');
      const task: Task = { request_id: operationId, kind: 'rebuild', scopes, source: scopes[0]!, from_seq: '0', to_seq: '0', payload: { reason } };
      return { ...state, pending: [...state.pending.filter((entry) => entry.kind !== 'rebuild'), task] };
    });
    this.paused = true;
  }
  async cancelRebuild(operationId: string): Promise<void> {
    await this.updateState((state) => ({ ...state, pending: state.pending.filter((task) => task.request_id !== operationId) }));
    this.paused = false;
    this.wake();
  }
  async completeRebuildIf(operationId: string, operation: JsonObject): Promise<void> {
    if (operation.state !== 'succeeded') return;
    const completed = await this.updateState((state) => state.pending.some((task) => task.kind === 'rebuild' && task.request_id === operationId)
      ? { ...state, generation: state.generation + 1, accepted_seq: '0', indexed_seq: '0', pending: [], materials: [] } : state);
    if (!completed) return;
    this.paused = false;
    this.wake();
  }
  private imageMetadata(record: EventRecord): JsonObject[] {
    const data = object(record.event.data);
    const segments = Array.isArray(data.message_segments) ? data.message_segments : [];
    const images: JsonObject[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment || typeof segment !== 'object' || Array.isArray(segment) || (segment as Record<string, unknown>).type !== 'image') continue;
      const value = segment as Record<string, unknown>;
      const details = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data as Record<string, unknown> : {};
      images.push({ segment_index: index, file: typeof details.file === 'string' ? details.file : '' });
    }
    return images;
  }
  private ingestionRecord(record: EventRecord): { record: JsonObject; images: JsonObject[] } {
    const identity = validateInbound(record, this.config);
    const data = object(record.event.data);
    const images = this.imageMetadata(record);
    const segments = Array.isArray(data.message_segments) ? data.message_segments : undefined;
    const safeSegments = segments?.map((segment, index) => {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment) || (segment as Record<string, unknown>).type !== 'image') return json(segment);
      const image = images.find((candidate) => candidate.segment_index === index);
      return { type: 'image', data: { file: image?.file ?? '' } } as JsonValue;
    });
    const result: JsonObject = { source: record.event.source, id: record.event.id, seq: record.seq.toString(), accepted_at: record.acceptedAt,
      ...(record.event.time === undefined ? {} : { time: record.event.time }), type: record.event.type, ...identity,
      text: string(data.text, limits.valueBytes, 'invalid_event', true) };
    for (const key of ['sender_nickname', 'sender_card'] as const) if (typeof data[key] === 'string') result[key] = data[key];
    if (safeSegments) result.message_segments = safeSegments;
    if (images.length) result.images = images;
    return { record: result, images };
  }
  private createMaterialTask(source: string, eventId: string, images: JsonObject[], parentRequestId: string, generation: number): MaterialTask {
    const eventRef = { source, id: eventId };
    return { request_id: digest({ scope: source, event_ref: eventRef, generation, kind: 'images' }), parent_request_id: parentRequestId,
      source, event_ref: eventRef, generation, images };
  }
  private async resolverInvoke(task: MaterialTask, segmentIndex: number): Promise<JsonObject | undefined> {
    const resolver = Object.entries(this.config.imageResolvers).find(([key]) => task.source.startsWith(key))?.[1];
    if (!resolver || this.stopped || this.api.signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new MemoryError('provider_stopped'));
      this.api.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MemoryError('image_resolver_timeout')), this.config.requestTimeoutMs); });
    try {
      const result = await Promise.race([this.api.capabilities.invoke(resolver, { input_event_ref: task.event_ref, segment_index: segmentIndex }), timedOut, aborted]);
      if (result.kind !== 'result' || !result.result || typeof result.result !== 'object' || Array.isArray(result.result)) return;
      const value = result.result as Record<string, JsonValue>;
      const original = task.images.find((image) => image.segment_index === segmentIndex);
      if (typeof value.url === 'string' && typeof value.file === 'string' && value.file === original?.file) return { url: value.url, file: value.file };
    } catch { /* Image lookup failure keeps text and file metadata available. */ }
    finally { clearTimeout(timer); if (onAbort) this.api.signal.removeEventListener('abort', onAbort); }
    return;
  }
  private async resolveMaterial(task: MaterialTask): Promise<JsonObject> {
    const images: JsonValue[] = [];
    for (const raw of task.images) {
      const image = object(raw) as JsonObject;
      const index = safeInt(image.segment_index, 0, 4096, 'memory_state_invalid');
      const resolved = await this.resolverInvoke(task, index);
      images.push({ segment_index: index, file: resolved?.file ?? image.file ?? '', ...(resolved?.url === undefined ? {} : { url: resolved.url }) });
    }
    return { input_event_ref: { source: task.event_ref.source, id: task.event_ref.id }, images };
  }
  private async updateState(change: (current: MemoryState) => MemoryState): Promise<boolean> {
    let changed = false;
    const operation = this.stateQueue.then(async () => {
      const next = change(this.state);
      if (next === this.state) return;
      await saveState(this.path, next);
      this.state = next;
      changed = true;
    });
    this.stateQueue = operation.catch(() => {});
    await operation;
    return changed;
  }
  private async submitBatch(records: EventRecord[]): Promise<Task | undefined> {
    if (!records.length) return;
    const source = records[0]!.event.source;
    const from = records[0]!.seq.toString(), to = records.at(-1)!.seq.toString();
    let task = this.state.pending.find((entry) => entry.source === source && entry.from_seq === from && entry.to_seq === to);
    const materialTasks: MaterialTask[] = [];
    if (!task) {
      const items: JsonValue[] = [];
      for (const record of records) {
        const ingested = this.ingestionRecord(record);
        items.push(ingested.record);
        if (ingested.images.length) materialTasks.push(this.createMaterialTask(source, record.event.id, ingested.images, '', this.state.generation));
      }
      const payload: JsonObject = { schema_version: 1, records: items };
      const requestId = digest({ store_id: this.state.store_id, instance_id: this.api.instanceId, scope: source, generation: this.state.generation, from, to, schema_version: 1, content_digest: digest(payload) });
      task = { request_id: requestId, kind: 'ingest', scopes: [source], source, from_seq: from, to_seq: to, payload };
    }
    for (const material of materialTasks) material.parent_request_id = task.request_id;
    const payload = task.payload;
    const requestId = task.request_id;
    await this.updateState((state) => {
      const pending = state.pending.some((entry) => entry.request_id === requestId) ? state.pending : [...state.pending, task!];
      const known = new Set(state.materials.map((entry) => entry.request_id));
      const materials = materialTasks.filter((entry) => !known.has(entry.request_id));
      return pending === state.pending && !materials.length ? state : { ...state, pending, materials: [...state.materials, ...materials] };
    });
    const outcome = await this.write('ingest', payload, this.scope.principalId, [source], requestId);
    if (outcome.status !== 'succeeded') throw new MemoryError(outcome.status === 'unknown' ? 'memory_operation_unconfirmed' : 'busy');
    return task;
  }
  private async indexPage(): Promise<void> {
    const page = await this.api.events.read({ afterSeq: BigInt(this.state.accepted_seq), limit: 50 });
    const fixed = BigInt(this.state.fixed_latest_seq);
    const backfill = BigInt(this.state.accepted_seq) < fixed;
    const selected = page.records.filter((record) => {
      if (backfill && record.seq > fixed) return false;
      if (!this.config.sources.includes(record.event.source) || record.parents.length) return false;
      try { return object(record.event.data).direction === 'inbound' && ['qq.message.group', 'qq.message.private'].includes(record.event.type); }
      catch { return false; }
    });
    const grouped = new Map<string, EventRecord[]>();
    for (const record of selected) {
      validateInbound(record, this.config);
      const list = grouped.get(record.event.source) ?? []; list.push(record); grouped.set(record.event.source, list);
    }
    for (const group of grouped.values()) {
      for (let offset = 0; offset < group.length; offset += 16) {
        if (this.stopped || this.paused) return;
        await this.submitBatch(group.slice(offset, offset + 16));
      }
    }
    const next = backfill && page.nextAfterSeq > fixed ? fixed : page.nextAfterSeq;
    await this.updateState((state) => ({ ...state, accepted_seq: next.toString() }));
    await this.pollTasks();
  }
  private async pollTasks(): Promise<void> {
    const observed = this.state.pending.filter((task) => task.kind === 'ingest' && !task.terminal);
    const observedIds = new Set(observed.map((task) => task.request_id));
    const keep: Task[] = [];
    for (const task of observed) {
      let response: JsonObject | undefined;
      try { response = await this.query('operation', { operation_id: task.request_id }, this.scope.principalId, task.scopes); }
      catch (error) { if (!(error instanceof MemoryError && error.code === 'not_found')) throw error; }
      if (!response) {
        const replay = await this.write('ingest', task.payload, this.scope.principalId, task.scopes, task.request_id);
        if (replay.status === 'unknown') throw new MemoryError('memory_operation_unconfirmed');
        keep.push(task);
        continue;
      }
      const state = response.state;
      if (response.accepted !== true || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(state))) throw new MemoryError('memory_operation_unconfirmed');
      if (state === 'succeeded') { /* Completed below once every accepted operation is confirmed. */ }
      else if (state === 'failed' || state === 'unknown') {
        await this.updateState((current) => ({ ...current, pending: current.pending.map((entry) => entry.request_id === task.request_id
          ? { ...entry, terminal: state, terminal_reason: state } : entry) }));
        keep.push({ ...task, terminal: state, terminal_reason: state });
      }
      else keep.push(task);
    }
    const keepIds = new Set(keep.map((task) => task.request_id));
    await this.updateState((state) => {
      const pending = state.pending.filter((task) => task.kind === 'rebuild' || !observedIds.has(task.request_id) || keepIds.has(task.request_id));
      const canAdvance = pending.length === 0 && keep.length === 0;
      const indexed = canAdvance && BigInt(state.accepted_seq) > BigInt(state.indexed_seq) ? state.accepted_seq : state.indexed_seq;
      return { ...state, indexed_seq: indexed, pending };
    });
    this.wakeMaterials();
  }
  private async materialStep(task: MaterialTask): Promise<void> {
    if (task.terminal) return;
    if (this.state.pending.some((pending) => pending.request_id === task.parent_request_id)) return;
    if (!task.payload) {
      const record = await this.api.events.lookup(task.event_ref);
      validateInbound(record, this.config);
      const payload = await this.resolveMaterial(task);
      const persisted = await this.updateState((state) => state.materials.some((entry) => entry.request_id === task.request_id && entry.generation === task.generation)
        ? { ...state, materials: state.materials.map((entry) => entry.request_id === task.request_id ? { ...entry, payload } : entry) } : state);
      if (!persisted) return;
      task = { ...task, payload };
    }
    if (!this.state.materials.some((entry) => entry.request_id === task.request_id && entry.generation === task.generation)) return;
    let status: JsonObject | undefined;
    try { status = await this.query('operation', { operation_id: task.request_id }, this.scope.principalId, [task.source]); }
    catch (error) { if (!(error instanceof MemoryError && error.code === 'not_found')) throw error; }
    if (status?.accepted === true && status.state === 'succeeded') {
      await this.updateState((state) => ({ ...state, materials: state.materials.filter((entry) => entry.request_id !== task.request_id) }));
      return;
    }
    if (status?.accepted === true && ['queued', 'running'].includes(String(status.state))) return;
    if (status?.accepted === true && ['failed', 'unknown'].includes(String(status.state))) {
      await this.updateState((state) => ({ ...state, materials: state.materials.map((entry) => entry.request_id === task.request_id
        ? { ...entry, terminal: status!.state as 'failed' | 'unknown', terminal_reason: typeof status!.error === 'object' && status!.error !== null ? safeReason(new MemoryError(String((status!.error as Record<string, unknown>).code ?? status!.state))) : String(status!.state) } : entry) }));
      return;
    }
    if (!this.state.materials.some((entry) => entry.request_id === task.request_id && entry.generation === task.generation)) return;
    const outcome = await this.write('images', task.payload!, this.scope.principalId, [task.source], task.request_id);
    if (outcome.status === 'failed') throw new MemoryError(String(outcome.reason.code ?? 'memory_operation_failed'));
    if (outcome.status === 'unknown') return;
    const state = outcome.result.state;
    if (state === 'failed' || state === 'unknown') await this.updateState((current) => ({ ...current, materials: current.materials.map((entry) => entry.request_id === task.request_id
      ? { ...entry, terminal: state, terminal_reason: String(state) } : entry) }));
  }
  private wakeMaterials(): void {
    if (this.stopped || !this.serviceReady) return;
    this.materialsRequested = true;
    if (this.materialsBusy) return;
    this.materialsBusy = true;
    this.materialsWorker = this.drainMaterials().catch((error: unknown) => {
      if (!this.stopped && !this.api.signal.aborted) process.stderr.write(JSON.stringify({ event: 'memory_image_task_deferred', plugin_instance_id: this.api.instanceId, code: safeReason(error) }) + '\n');
    }).finally(() => {
      this.materialsBusy = false;
      if (this.materialsRequested && !this.stopped) this.wakeMaterials();
    });
  }
  private async drainMaterials(): Promise<void> {
    while (this.materialsRequested && !this.stopped && !this.api.signal.aborted) {
      this.materialsRequested = false;
      for (const task of [...this.state.materials]) {
        if (this.stopped || this.api.signal.aborted) return;
        try { await this.materialStep(task); }
        catch (error) {
          if (!(error instanceof MemoryError && error.code === 'busy')) process.stderr.write(JSON.stringify({ event: 'memory_image_task_deferred', plugin_instance_id: this.api.instanceId, code: safeReason(error) }) + '\n');
        }
      }
    }
  }
  private wake(): void {
    if (this.stopped || this.paused || !this.serviceReady) return;
    this.requested = true;
    if (this.busy) return;
    this.busy = true;
    this.worker = this.drain().catch((error: unknown) => { if (!this.stopped && !this.api.signal.aborted) return this.pause(error); }).finally(() => {
      this.busy = false;
      if (this.requested && !this.stopped && !this.paused) this.wake();
    });
  }
  private async drain(): Promise<void> {
    for (let pages = 0; this.requested && !this.stopped && !this.paused && pages < 16; pages += 1) {
      this.requested = false;
      try { await this.pollTasks(); }
      catch (error) {
        if (error instanceof MemoryError && error.code === 'busy') {
          await delay(this.config.pollMs, undefined, { signal: this.api.signal }).catch(() => {});
          this.requested = true;
          continue;
        }
        throw error;
      }
      if (this.state.pending.length >= 100) return;
      const page = await this.api.events.read({ afterSeq: BigInt(this.state.accepted_seq), limit: 50 });
      if (!page.records.length) {
        const fixed = BigInt(this.state.fixed_latest_seq);
        const next = BigInt(this.state.accepted_seq) < fixed && page.nextAfterSeq > fixed ? fixed : page.nextAfterSeq;
        if (next > BigInt(this.state.accepted_seq)) await this.updateState((state) => ({ ...state, accepted_seq: next > BigInt(state.accepted_seq) ? next.toString() : state.accepted_seq }));
        if (page.caughtUp) return;
        continue;
      }
      // Process the fixed-size page with deterministic request identities and one service scope per batch.
      if (BigInt(this.state.accepted_seq) >= BigInt(this.state.fixed_latest_seq) && this.config.batchWaitMs) {
        await delay(this.config.batchWaitMs, undefined, { signal: this.api.signal }).catch(() => {});
      }
      try { await this.indexPage(); }
      catch (error) {
        if (error instanceof MemoryError && error.code === 'busy') {
          await delay(this.config.pollMs, undefined, { signal: this.api.signal }).catch(() => {});
          this.requested = true;
          continue;
        }
        throw error;
      }
      if (page.caughtUp) return;
    }
  }
  private async pause(error: unknown): Promise<void> {
    this.paused = true;
    this.api.setAvailable(true);
    process.stderr.write(JSON.stringify({ event: 'memory_index_paused', plugin_instance_id: this.api.instanceId, code: safeReason(error) }) + '\n');
  }
  private async health(): Promise<void> {
    while (!this.stopped && !this.api.signal.aborted) {
      try {
        const health = await this.request('/health');
        if (health.ready !== true) {
          this.serviceReady = false;
          this.api.setAvailable(false, { code: 'memory_service_unavailable' });
        } else if (typeof health.ledger_id !== 'string' || !/^[a-f0-9]{64}$/.test(health.ledger_id)) {
          this.serviceReady = false;
          this.paused = true;
          this.api.setAvailable(false, { code: 'memory_service_unavailable' });
        } else if (this.state.service_ledger_id !== null && this.state.service_ledger_id !== health.ledger_id) {
          this.serviceReady = false;
          this.paused = true;
          this.api.setAvailable(false, { code: 'memory_binding_changed' });
        } else {
          if (this.state.service_ledger_id === null) await this.updateState((state) => ({ ...state, service_ledger_id: health.ledger_id as string }));
          if (!this.serviceReady) { this.serviceReady = true; this.api.setAvailable(true); this.wake(); this.wakeMaterials(); }
        }
      } catch {
        this.serviceReady = false; this.api.setAvailable(false, { code: 'memory_service_unavailable' });
      }
      await delay(this.config.pollMs, undefined, { signal: this.api.signal }).catch(() => {});
    }
  }
  start(): void {
    this.unsubscribe = this.api.events.onAvailable(() => this.wake());
    this.timer = setInterval(() => { if (this.serviceReady) { this.wake(); this.wakeMaterials(); } }, this.config.pollMs);
    this.healthWorker = (async () => {
      try { await this.api.whenReady(); }
      catch { if (!this.stopped && !this.api.signal.aborted) this.api.setAvailable(false, { code: 'memory_host_unavailable' }); return; }
      if (!this.stopped && !this.api.signal.aborted) await this.health();
    })().catch(() => { this.api.setAvailable(false, { code: 'memory_service_unavailable' }); });
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.unsubscribe(); this.unsubscribe = () => {}; }
  async close(): Promise<void> { this.stop(); await this.worker; await this.materialsWorker; await this.healthWorker; }
}

const refSchema = { type: 'object', properties: { source: { type: 'string', minLength: 1, maxLength: 1024 }, id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['source', 'id'], additionalProperties: false };
const commonRead = { scope_refs: { type: 'array', minItems: 1, maxItems: 8, items: refSchema } };
const schemas: Record<ReadKind | ToolWriteKind, JsonObject> = {
  search: { type: 'object', properties: { ...commonRead, query: { type: 'string', minLength: 1, maxLength: 8192 }, categories: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', enum: [...MEMORY_CATEGORIES] } }, subjects: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } }, after: { type: 'string', minLength: 20, maxLength: 40 }, before: { type: 'string', minLength: 20, maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['scope_refs', 'query'], additionalProperties: false },
  context: { type: 'object', properties: { input_event_ref: refSchema, timeout_ms: { type: 'integer', minimum: 1, maximum: 2000 }, max_bytes: { type: 'integer', minimum: 1, maximum: 8192 } }, required: ['input_event_ref'], additionalProperties: false },
  get: { type: 'object', properties: { ...commonRead, memory_id: { type: 'string', minLength: 1, maxLength: 256 }, version_before: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, version_limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['scope_refs', 'memory_id'], additionalProperties: false },
  status: { type: 'object', properties: { ...commonRead }, required: ['scope_refs'], additionalProperties: false },
  operation: { type: 'object', properties: { ...commonRead, operation_id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['scope_refs', 'operation_id'], additionalProperties: false },
  remember: { type: 'object', properties: { ...commonRead, category: { type: 'string', enum: [...MEMORY_CATEGORIES] }, content: { type: 'string', minLength: 1, maxLength: 4096 }, subjects: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } }, evidence_refs: { type: 'array', maxItems: 8, items: refSchema } }, required: ['scope_refs', 'category', 'content'], additionalProperties: false },
  update: { type: 'object', properties: { ...commonRead, memory_id: { type: 'string', minLength: 1, maxLength: 256 }, expected_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, reason: { type: 'string', minLength: 1, maxLength: 2048 }, content: { type: 'string', minLength: 1, maxLength: 4096 }, category: { type: 'string', enum: [...MEMORY_CATEGORIES] }, subjects: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } } }, required: ['scope_refs', 'memory_id', 'expected_revision', 'reason'], additionalProperties: false },
  forget: { type: 'object', properties: { ...commonRead, memory_id: { type: 'string', minLength: 1, maxLength: 256 }, expected_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, reason: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['scope_refs', 'memory_id', 'expected_revision', 'reason'], additionalProperties: false },
  rebuild: { type: 'object', properties: { ...commonRead, reason: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['scope_refs', 'reason'], additionalProperties: false },
};
const descriptions: Record<ReadKind | ToolWriteKind, string> = {
  search: 'Search memories within caller-authorized QQ conversations.', context: 'Get bounded memory context for a verified inbound QQ event.',
  get: 'Get a memory visible in caller-authorized QQ conversations.', status: 'Read memory indexing status for authorized QQ conversations.',
  operation: 'Read a memory operation within authorized QQ conversations.', remember: 'Create a memory authored by the actual invoking caller.',
  update: 'Update a memory with an expected revision and reason.', forget: 'Forget a memory with an expected revision and reason.',
  rebuild: 'Rebuild memory indexing for authorized QQ conversations.',
};

function objectParams(value: unknown): JsonObject { return object(value, 'invalid_params') as JsonObject; }
function stripRefs(params: JsonObject): JsonObject { const { scope_refs: _refs, ...payload } = params; return payload; }

export async function apply(ctx: Context, input: JsonObject): Promise<void> {
  const config = parseMemoryConfig(input);
  const api = ctx.imbrex.forPlugin(ctx);
  const token = process.env[config.serviceTokenEnv];
  if (!token || !/^[\x21-\x7e]+$/.test(token)) { api.setAvailable(false, { code: 'memory_token_missing' }); return; }
  const readScope = api.events.readScope();
  const selection = selectionFor(config, readScope);
  const statePath = join(api.dataDir, 'memory-state.json');
  const info = await api.events.info();
  let state: MemoryState;
  try {
    const loaded = parseState(JSON.parse(await readFile(statePath, 'utf8')));
    if (loaded.store_id !== info.storeId || loaded.instance_id !== api.instanceId || loaded.service_url !== config.serviceUrl || JSON.stringify(loaded.selection) !== JSON.stringify(selection)) throw new MemoryError('memory_binding_changed');
    if (BigInt(loaded.fixed_latest_seq) > info.latestSeq || BigInt(loaded.accepted_seq) > info.latestSeq || BigInt(loaded.indexed_seq) > BigInt(loaded.accepted_seq)) throw new MemoryError('memory_cursor_invalid');
    state = loaded;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { api.setAvailable(false, { code: safeReason(error) }); return; }
    state = { version: 2, store_id: info.storeId, instance_id: api.instanceId, service_url: config.serviceUrl, service_ledger_id: null, selection, fixed_latest_seq: info.latestSeq.toString(), generation: 0, accepted_seq: '0', indexed_seq: '0', pending: [], materials: [] };
    await saveState(statePath, state);
  }
  const instance = new MemoryPlugin(api, config, token, statePath, state, readScope);
  for (const kind of ['search', 'context', 'get', 'status', 'operation'] as const) {
    ctx.effect(() => api.capabilities.register<JsonObject, JsonValue>({ localName: kind, description: descriptions[kind], schemaVersion: '1', isSideEffectful: false, inputSchema: schemas[kind],
      handler: async (raw, invocation) => {
        const params = objectParams(raw);
        let sourceList: string[];
        let serviceParams: JsonObject;
        if (kind === 'context') {
          const ref = parseRef(params.input_event_ref);
          const checked = await checkedRef(ref, config, readScope, invocation.readEvent);
          sourceList = [ref.source];
          void checked.identity;
          const data = object(checked.record.event.data);
          serviceParams = { ...params, query: typeof data.text === 'string' ? data.text : '' };
        } else {
          const scopeRefs = refs(params.scope_refs, config, readScope);
          const verified = await Promise.all(scopeRefs.map((ref) => checkedRef(ref, config, readScope, invocation.readEvent)));
          sourceList = [...new Set(verified.map((item) => item.record.event.source))];
          if (kind === 'get' || kind === 'operation' || kind === 'status') {
            if (sourceList.length > 8) throw new MemoryError('invalid_params');
          }
          serviceParams = kind === 'status' ? {} : stripRefs(params);
        }
        if (kind === 'search') for (const key of ['after', 'before'] as const) {
          const value = params[key];
          if (value !== undefined && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new MemoryError('invalid_params');
        }
        let result: JsonObject;
        try { result = await instance.query(kind, serviceParams, invocation.callerId, sourceList); }
        catch (error) { if (kind === 'operation' && error instanceof MemoryError && error.code === 'not_found') throw new MemoryError('memory_service_unavailable'); throw error; }
        if (kind === 'status') Object.assign(result, instance.localStatus());
        if (kind === 'search' || kind === 'get' || kind === 'context') {
          const verifyMemory = async (value: unknown, expectedMemory = false): Promise<void> => {
            if (Array.isArray(value)) { for (const item of value) await verifyMemory(item, expectedMemory); return; }
            if (value === null || typeof value !== 'object') return;
            const item = value as Record<string, unknown>;
            if (expectedMemory && typeof item.source !== 'string') throw new MemoryError('memory_service_error');
            if (item.source !== undefined && (typeof item.source !== 'string' || !sourceList.includes(item.source))) throw new MemoryError('forbidden');
            for (const key of ['evidence_refs', 'evidenceRefs'] as const) {
              if (item[key] !== undefined) {
                if (!Array.isArray(item[key]) || item[key].length > 64) throw new MemoryError('memory_service_error');
                for (const rawRef of item[key]) {
                  const ref = parseRef(rawRef);
                  if (!sourceList.includes(ref.source)) throw new MemoryError('forbidden');
                  await checkedRef(ref, config, readScope, invocation.readEvent);
                }
              }
            }
            for (const key of ['memories', 'memory', 'versions'] as const) if (item[key] !== undefined) await verifyMemory(item[key], true);
          };
          await verifyMemory(result);
        }
        if (kind === 'context' && typeof result.context === 'string') {
          const maxBytes = safeInt(params.max_bytes ?? 8192, 1, 8192);
          const bytes = new TextEncoder().encode(result.context);
          if (bytes.byteLength > maxBytes) {
            let end = maxBytes;
            while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
            result.context = new TextDecoder().decode(bytes.slice(0, end));
          }
        }
        return json(result, 64 * 1024, 'internal_error');
      } }));
  }
  for (const kind of ['remember', 'update', 'forget', 'rebuild'] as const) {
    ctx.effect(() => api.capabilities.register<JsonObject, JsonValue>({ localName: kind, description: descriptions[kind], schemaVersion: '1', isSideEffectful: true, inputSchema: schemas[kind],
      handler: async (raw, invocation) => {
        let accepted = false;
        let rebuildPrepared = false;
        let rebuildId: string | undefined;
        try {
          const params = objectParams(raw);
          const scopeRefs = refs(params.scope_refs, config, readScope);
          const verified = await Promise.all(scopeRefs.map((ref) => checkedRef(ref, config, readScope, invocation.readEvent)));
          const sourceList = [...new Set(verified.map((item) => item.record.event.source))];
          if (sourceList.length < 1 || sourceList.length > 8) throw new MemoryError('invalid_params');
          const evidence = params.evidence_refs;
          if (evidence !== undefined) {
            if (!Array.isArray(evidence) || evidence.length > 8) throw new MemoryError('invalid_params');
            for (const ref of evidence) {
              const checked = await checkedRef(parseRef(ref), config, readScope, invocation.readEvent);
              if (!sourceList.includes(checked.record.event.source)) throw new MemoryError('forbidden');
            }
          }
          const payload = stripRefs(params);
          if (kind === 'remember' && payload.evidence_refs === undefined) payload.evidence_refs = scopeRefs.map((ref) => ({ source: ref.source, id: ref.id }));
          if (kind === 'rebuild') {
            rebuildId = instance.operationId(kind, invocation.callerId, invocation.callId);
            await instance.prepareRebuild(rebuildId, String(params.reason), sourceList);
            rebuildPrepared = true;
          }
          const outcome = await instance.write(kind, payload, invocation.callerId, sourceList, invocation.callId);
          if (outcome.status === 'failed') {
            if (rebuildPrepared && rebuildId) await instance.cancelRebuild(rebuildId);
            rebuildPrepared = false;
            return { status: 'failed', reason: { code: String(outcome.reason.code ?? 'memory_operation_failed'), message: String(outcome.reason.message ?? 'Memory operation failed.') } };
          }
          if (outcome.status === 'unknown') return { status: 'unknown', reason: { code: String(outcome.reason.code ?? 'memory_operation_unconfirmed'), message: String(outcome.reason.message ?? 'Memory operation was not confirmed.') } };
          accepted = true;
          if (kind === 'rebuild') {
            const operationId = String(outcome.result.operation_id);
            await instance.completeRebuildIf(operationId, outcome.result);
          }
          return { status: 'succeeded', result: outcome.result };
        } catch (error) {
          if (rebuildPrepared && rebuildId && !accepted) {
            try { await instance.cancelRebuild(rebuildId); } catch { /* The durable rebuild intent remains paused for explicit recovery. */ }
          }
          const code = safeReason(error);
          return accepted
            ? { status: 'unknown', reason: { code: 'memory_local_checkpoint_unconfirmed', message: 'Service acceptance was confirmed, but local recovery state was not saved.' } }
            : { status: 'failed', reason: { code, message: 'Memory operation was rejected before acceptance.' } };
        }
      } }));
  }
  api.setAvailable(false, { code: 'memory_service_unavailable' });
  const abort = () => instance.stop();
  api.signal.addEventListener('abort', abort, { once: true });
  ctx.effect(() => async () => { abort(); api.signal.removeEventListener('abort', abort); await instance.close(); });
  instance.start();
}

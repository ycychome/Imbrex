import { isDeepStrictEqual } from 'node:util';
import { requireCapability, requirePermission } from './access.js';
import { fail, GatewayError } from './errors.js';
import { compileSchema } from './schema.js';
import type { Events } from './events.js';
import type { CallOutcome, CallRecord, GatewayStore } from './store.js';
import type { EventRef, JsonValue, Principal } from './types.js';
import { callIdPattern, fields, json, limits, namespacePattern, object, string } from './validation.js';

export interface Provider { instanceId: string; signal: AbortSignal; available: () => boolean }
export interface Invocation {
  callerId: string; callId?: string; storeId: string; signal: AbortSignal;
  readEvent: (ref: EventRef) => ReturnType<Events['lookup']>;
}
export interface CapabilityDefinition<P = JsonValue, R = JsonValue> {
  localName: string; description: string; schemaVersion: string; isSideEffectful: boolean; inputSchema: unknown;
  handler: (params: P, invocation: Invocation) => R | CallOutcome | Promise<R | CallOutcome>;
}
export interface CapabilityDescription {
  id: string; pluginInstanceId: string; description: string; schemaVersion: string; isSideEffectful: boolean; inputSchema: JsonValue;
}
interface Registration {
  owner: Provider; description: CapabilityDescription; validate: (value: unknown) => boolean;
  handler: (params: JsonValue, invocation: Invocation) => unknown; registered: boolean;
}
export type InvokeResult = { kind: 'result'; storeId: string; capabilityId: string; result: JsonValue } | { kind: 'call'; storeId: string; call: CallRecord };

export class Capabilities {
  private registrations = new Map<string, Registration>();
  private active = 0;
  private stopped = false;
  private responses = new Set<Promise<InvokeResult>>();
  private controllers = new Set<AbortController>();

  constructor(private store: GatewayStore, private events: Events, private writesEnabled: boolean, private timeoutMs: number = limits.callTimeoutMs) {}

  register<P, R>(owner: Provider, definition: CapabilityDefinition<P, R>): () => void {
    if (this.stopped) fail('provider_unavailable');
    if (!namespacePattern.test(owner.instanceId) || !/^[a-z][a-z0-9_]{0,63}$/.test(definition.localName)) fail('invalid_request');
    if (typeof definition.isSideEffectful !== 'boolean' || typeof definition.handler !== 'function') fail('invalid_request');
    const id = owner.instanceId + '.' + definition.localName;
    if (this.registrations.has(id)) fail('invalid_request', 'Capability already registered');
    if (this.registrations.size >= limits.capabilities) fail('payload_too_large');
    const { schema, validate } = compileSchema(definition.inputSchema);
    const handler = definition.handler;
    const registration: Registration = {
      owner, validate, registered: true, handler: (params, invocation) => handler(params as P, invocation),
      description: {
        id, pluginInstanceId: owner.instanceId, description: string(definition.description, 4096),
        schemaVersion: string(definition.schemaVersion, 128), isSideEffectful: definition.isSideEffectful, inputSchema: schema,
      },
    };
    this.registrations.set(id, registration);
    return () => { registration.registered = false; if (this.registrations.get(id) === registration) this.registrations.delete(id); };
  }
  list(principal: Principal): CapabilityDescription[] {
    requirePermission(principal, 'capabilities:list');
    return [...this.registrations.values()].filter((entry) => principal.invokeCapabilities.includes(entry.description.id) && this.available(entry))
      .map((entry) => structuredClone(entry.description));
  }
  private available(entry: Registration): boolean {
    return !this.stopped && entry.registered && !entry.owner.signal.aborted && entry.owner.available();
  }
  async getCall(principal: Principal, storeId: string, callId: string): Promise<CallRecord> {
    requirePermission(principal, 'calls:read');
    if (!callIdPattern.test(callId)) fail('invalid_request');
    return await this.store.getCall(storeId, principal.id, callId) ?? fail('call_not_found');
  }
  invoke(principal: Principal, storeId: string, id: string, input: unknown, callId?: string): Promise<InvokeResult> {
    const response = this.execute(principal, storeId, id, input, callId);
    this.responses.add(response);
    response.then(() => this.responses.delete(response), () => this.responses.delete(response));
    return response;
  }
  private sameIntent(call: CallRecord, capabilityId: string, params: JsonValue): void {
    // JSON serialization already normalizes -0; object property order is irrelevant.
    if (call.capabilityId !== capabilityId || !isDeepStrictEqual(call.params, params)) fail('call_conflict');
  }
  private outcome(value: unknown): CallOutcome {
    const result = object(value, 'invalid_params');
    if (result.status === 'succeeded') {
      fields(result, ['status', 'result'], ['status', 'result'], 'invalid_params');
      return { status: 'succeeded', result: json(result.result) };
    }
    if (result.status !== 'failed' && result.status !== 'unknown') fail('invalid_params');
    fields(result, ['status', 'reason'], ['status', 'reason'], 'invalid_params');
    const reason = object(result.reason, 'invalid_params');
    fields(reason, ['code', 'message'], ['code', 'message'], 'invalid_params');
    return { status: result.status, reason: { code: string(reason.code, 128), message: string(reason.message, 4096) } };
  }
  private async finish(storeId: string, callerId: string, callId: string, outcome: CallOutcome): Promise<CallRecord> {
    try { return await this.store.finishCall(storeId, callerId, callId, outcome); }
    catch { return fail('storage_unavailable'); }
  }
  private async execute(principal: Principal, storeId: string, id: string, input: unknown, callId?: string): Promise<InvokeResult> {
    if (this.stopped) fail('provider_unavailable');
    requireCapability(principal, id);
    const params = json(input);
    if (callId !== undefined && !callIdPattern.test(callId)) fail('invalid_request');
    if (callId !== undefined) {
      const previous = await this.store.getCall(storeId, principal.id, callId);
      if (previous) { this.sameIntent(previous, id, params); return { kind: 'call', storeId, call: previous }; }
    } else if ((await this.store.info()).storeId !== storeId) fail('store_mismatch');
    const entry = this.registrations.get(id) ?? fail('capability_not_found');
    if (!this.available(entry)) fail('provider_unavailable');
    const sideEffectful = entry.description.isSideEffectful;
    if (sideEffectful && callId === undefined) fail('invalid_request');
    if (!sideEffectful && callId !== undefined) fail('invalid_request');
    if (sideEffectful && !this.writesEnabled) fail('writes_disabled');
    if (!entry.validate(params)) fail('invalid_params');
    if (this.active >= limits.handlers) fail('busy');
    this.active += 1;
    let dispatched = false;
    try {
      if (sideEffectful) {
        const created = await this.store.createCall(storeId, { callerId: principal.id, callId: callId!, capabilityId: id, schemaVersion: entry.description.schemaVersion, params });
        if (!created.created) { this.sameIntent(created.call, id, params); return { kind: 'call', storeId, call: created.call }; }
        if (!this.available(entry)) {
          const call = await this.finish(storeId, principal.id, callId!, { status: 'failed', reason: { code: 'provider_stopped', message: 'Provider stopped before dispatch.' } });
          return { kind: 'call', storeId, call };
        }
      } else if (!this.available(entry)) fail('provider_unavailable');

      const controller = new AbortController();
      this.controllers.add(controller);
      const signal = AbortSignal.any([controller.signal, entry.owner.signal]);
      const invocation: Invocation = { callerId: principal.id, callId, storeId, signal, readEvent: (ref) => this.events.lookup(principal, storeId, ref) };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: () => void = () => {};
      const interrupted = new Promise<InvokeResult>((resolve, reject) => {
        abortListener = () => {
          if (!sideEffectful) { reject(new GatewayError('provider_unavailable')); return; }
          this.finish(storeId, principal.id, callId!, { status: 'unknown', reason: { code: 'provider_interrupted', message: 'Provider outcome is not confirmed.' } })
            .then((call) => resolve({ kind: 'call', storeId, call }), reject);
        };
        signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => controller.abort(), this.timeoutMs);
      });
      dispatched = true;
      const execution = Promise.resolve().then(() => {
        if (!this.available(entry) || signal.aborted) {
          if (!sideEffectful) fail('provider_unavailable');
          return { status: 'failed', reason: { code: 'provider_stopped', message: 'Provider stopped before dispatch.' } };
        }
        return entry.handler(structuredClone(params), invocation);
      });
      // Timed-out handlers still occupy capacity until they actually settle.
      execution.then(() => { this.active -= 1; }, () => { this.active -= 1; });
      const completed = execution.then(async (value): Promise<InvokeResult> => {
        if (!sideEffectful) {
          try { return { kind: 'result', storeId, capabilityId: id, result: json(value) }; }
          catch { return fail('internal_error', 'Invalid provider result'); }
        }
        let outcome: CallOutcome;
        try { outcome = this.outcome(value); }
        catch { outcome = { status: 'unknown', reason: { code: 'invalid_provider_result', message: 'Provider returned an invalid result.' } }; }
        return { kind: 'call', storeId, call: await this.finish(storeId, principal.id, callId!, outcome) };
      }, async (): Promise<InvokeResult> => {
        if (!sideEffectful) fail('provider_unavailable');
        const call = await this.finish(storeId, principal.id, callId!, { status: 'unknown', reason: { code: 'provider_error', message: 'Provider outcome is not confirmed.' } });
        return { kind: 'call', storeId, call };
      });
      try { return await Promise.race([completed, interrupted]); }
      finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abortListener);
        this.controllers.delete(controller);
      }
    } finally { if (!dispatched) this.active -= 1; }
  }
  stop(): void { this.stopped = true; for (const controller of this.controllers) controller.abort(); }
  async drain(): Promise<void> { await Promise.allSettled([...this.responses]); }
}

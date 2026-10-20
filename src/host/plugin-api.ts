import type { AdminPanel } from './admin-registry.js';
import type { Context } from 'cordis';
import type { CapabilityDefinition, InvokeResult } from '../core/capabilities.js';
import type { AppendResult, EventPage, EventRecord, EventRef, JsonValue, ReadOptions, SourceRule } from '../core/types.js';
import type { CallRecord } from '../core/store.js';

export interface ReadScope { principalId: string; sources: SourceRule[] }
export interface PluginApi {
  readonly storeId: string;
  readonly instanceId: string;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  whenReady(): Promise<void>;
  registerAdminPanel(panel: AdminPanel): () => void;
  events: {
    info(): Promise<{ storeId: string; latestSeq: bigint }>;
    readScope(): ReadScope;
    append(input: unknown): Promise<AppendResult>;
    read(options: Omit<ReadOptions, 'limit'> & { limit?: number }): Promise<EventPage>;
    lookup(ref: EventRef): Promise<EventRecord>;
    onAvailable(callback: () => void | Promise<void>): () => void;
  };
  capabilities: {
    register<P = JsonValue, R = JsonValue>(definition: CapabilityDefinition<P, R>): () => void;
    invoke(id: string, params: unknown, options?: { callId?: string }): Promise<InvokeResult>;
    getCall(callId: string): Promise<CallRecord>;
  };
  setAvailable(available: boolean, reason?: unknown): void;
}

export interface ImbrexService { forPlugin(ctx: Context): PluginApi }
declare module 'cordis' { interface Context { imbrex: ImbrexService } }

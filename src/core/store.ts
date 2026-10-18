import type { AppendResult, EventInput, EventPage, EventRecord, EventRef, JsonValue, ReadOptions, SourceRule } from './types.js';

export interface Reason { code: string; message: string }
export type CallStatus = 'in_progress' | 'succeeded' | 'failed' | 'unknown';
export interface CallRecord {
  callerId: string; callId: string; capabilityId: string; schemaVersion: string;
  params: JsonValue; status: CallStatus; result?: JsonValue; reason?: Reason; createdAt: string; updatedAt: string;
}
export type NewCall = Pick<CallRecord, 'callerId' | 'callId' | 'capabilityId' | 'schemaVersion' | 'params'>;
export type CallOutcome = { status: 'succeeded'; result: JsonValue } | { status: 'failed' | 'unknown'; reason: Reason };
export interface StoreInfo {
  storeId: string; latestSeq: bigint; schemaVersion: number; sqliteVersion: string; sqliteSourceId: string;
  pragmas: { journalMode: string; synchronous: number; foreignKeys: number; busyTimeout: number };
}
export interface GatewayStore {
  info(): Promise<StoreInfo>;
  append(storeId: string, input: EventInput): Promise<AppendResult>;
  read(storeId: string, options: ReadOptions, sources: SourceRule[]): Promise<EventPage>;
  lookup(storeId: string, ref: EventRef): Promise<EventRecord | undefined>;
  getCall(storeId: string, callerId: string, callId: string): Promise<CallRecord | undefined>;
  createCall(storeId: string, call: NewCall): Promise<{ created: boolean; call: CallRecord }>;
  finishCall(storeId: string, callerId: string, callId: string, outcome: CallOutcome): Promise<CallRecord>;
}

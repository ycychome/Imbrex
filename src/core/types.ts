export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface EventRef { source: string; id: string }
export interface CloudEvent extends EventRef {
  specversion: '1.0';
  type: string;
  datacontenttype: 'application/json';
  data: JsonValue;
  time?: string;
  subject?: string;
  dataschema?: string;
}
export interface EventInput { event: CloudEvent; parents: EventRef[] }
export interface EventRecord extends EventInput { seq: bigint; acceptedAt: string }
export interface AppendResult {
  status: 'created' | 'duplicate_identity';
  storeId: string;
  seq: bigint;
  acceptedAt: string;
  eventRef: EventRef;
}
export interface ReadOptions { afterSeq: bigint; limit: number; sourcePrefix?: string; type?: string }
export interface EventPage { storeId: string; records: EventRecord[]; throughSeq: bigint; nextAfterSeq: bigint; caughtUp: boolean }

export type SourceRule = { exact: string } | { prefix: string };
export const permissions = ['events:read', 'events:write', 'capabilities:list', 'capabilities:invoke', 'calls:read', 'runtime:inspect', 'admin:inspect', 'admin:operate'] as const;
export type Permission = typeof permissions[number];
export interface Principal {
  id: string;
  permissions: Permission[];
  readSources: SourceRule[];
  writeSources: SourceRule[];
  invokeCapabilities: string[];
}

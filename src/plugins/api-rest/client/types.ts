export type CallStatus = 'in_progress' | 'succeeded' | 'failed' | 'unknown';
export type StatusFilter = 'all' | CallStatus;

export interface WireCall {
  call_id: string;
  capability_id: string;
  schema_version: string;
  params: unknown;
  status: CallStatus;
  result?: unknown;
  reason?: unknown;
  created_at: string;
  updated_at: string;
}

export interface AdminCall extends WireCall { caller_id: string }

export interface CallCursor { caller_id: string; call_id: string }
export interface CallPage { calls: AdminCall[]; next: CallCursor | null }

export interface AdminCapability {
  id: string;
  plugin_instance_id: string;
  description: string;
  schema_version: string;
  is_side_effectful: boolean;
  input_schema: unknown;
  available: boolean;
}

export interface CapabilityPage { capabilities: AdminCapability[] }

export interface SourceRule { exact?: string; prefix?: string }

export interface AdminPrincipal {
  id: string;
  permissions: string[];
  read_sources: SourceRule[];
  write_sources: SourceRule[];
  invoke_capabilities: string[];
  credential: { name: string; configured: boolean } | null;
}

export interface AdminConfiguration {
  config_version: number;
  external_writes_enabled: boolean;
  mcp_url: string | null;
  principals: AdminPrincipal[];
  plugins: Array<{ instance_id: string; enabled: boolean }>;
}

export interface DiagnosticCapability {
  id: string;
  available: boolean;
  invoke_authorized: boolean;
  events_read_permitted: boolean;
  external_write_enabled: boolean;
}

export interface CapabilityDiagnostics {
  principal: {
    id: string;
    permissions: string[];
    read_sources: SourceRule[];
    invoke_capabilities: string[];
  };
  external_writes_enabled: boolean;
  capabilities: DiagnosticCapability[];
}

export interface InvocationEnvelope {
  store_id: string;
  kind: 'call' | 'result';
  capability_id?: string;
  result?: unknown;
  call?: WireCall;
}

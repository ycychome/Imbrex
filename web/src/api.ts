import { computed, ref } from 'vue';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const STORAGE_KEY = 'imbrex.admin.token';

function storedToken(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export const token = ref(storedToken());
export const authenticated = computed(() => token.value.length > 0);
export const sessionMessage = ref('');

export function setToken(value: string): void {
  token.value = value;
  sessionMessage.value = '';
  try {
    sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // The session still works in memory when storage is unavailable.
  }
}

export function clearToken(): void {
  token.value = '';
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; the in-memory token is already cleared.
  }
}

export function expireSession(message = 'Token 无效或已失效，请重新输入。'): void {
  clearToken();
  sessionMessage.value = message;
}

export interface PluginStatus {
  id: string;
  module_name: string;
  state: string;
  required: boolean;
  available: boolean;
  last_error?: { code: string; message?: string };
}

export interface AdminInfo {
  store_id: string;
  latest_seq: string;
  version: string;
  plugins: PluginStatus[];
}

export interface PanelSummary {
  instance_id: string;
  module: string;
  generation: string;
  title: string;
  icon: string;
}

export type PanelTone = 'ok' | 'warning' | 'error' | 'idle' | 'unknown';
export interface PanelStatus { tone: PanelTone; label: string }
export interface PanelMetric { label: string; value: string; hint?: string }
export interface PanelView { status: PanelStatus; metrics: PanelMetric[]; data: JsonObject }

export interface PanelDetail {
  store_id: string;
  instance_id: string;
  module: string;
  generation: string;
  data?: PanelView;
  error?: { code: string; message: string };
}

export interface EventRecord {
  seq: string;
  accepted_at: string;
  event: {
    source: string;
    id: string;
    type: string;
    data: Json;
    [key: string]: unknown;
  };
  parents: { source: string; id: string }[];
}

export interface EventPage {
  store_id: string;
  records: EventRecord[];
  through_seq: string;
  next_after_seq: string;
  caught_up: boolean;
}

export type CallStatus = 'in_progress' | 'succeeded' | 'failed' | 'unknown';

export interface AdminCall {
  caller_id: string;
  call_id: string;
  capability_id: string;
  schema_version: string;
  params: Json;
  status: CallStatus;
  result?: Json;
  reason?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}

export interface CallCursor {
  caller_id: string;
  call_id: string;
}

export interface CallPage {
  store_id: string;
  calls: AdminCall[];
  next: CallCursor | null;
}

export interface AdminCapability {
  id: string;
  plugin_instance_id: string;
  description: string;
  schema_version: string;
  is_side_effectful: boolean;
  input_schema: Json;
  available: boolean;
}

export interface CapabilityPage {
  store_id: string;
  capabilities: AdminCapability[];
}

export interface CredentialReference {
  name: string;
  configured: boolean;
}

export interface ConfigPrincipal {
  id: string;
  permissions: string[];
  read_sources: Array<{ exact?: string; prefix?: string }>;
  write_sources: Array<{ exact?: string; prefix?: string }>;
  invoke_capabilities: string[];
  credential: CredentialReference | null;
}

export interface ConfigPlugin {
  instance_id: string;
  module: string;
  principal_id: string;
  enabled: boolean;
  required: boolean;
  configuration: JsonObject;
}

export interface Configuration {
  config_version: number;
  external_writes_enabled: boolean;
  mcp_url: string | null;
  principals: ConfigPrincipal[];
  plugins: ConfigPlugin[];
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'AdminApiError';
  }
}

export function describeError(error: unknown): string {
  if (!(error instanceof AdminApiError)) return '请求失败。';
  switch (error.status) {
    case 0: return '无法连接网关，请确认服务正在运行。';
    case 401: return 'Token 无效或已失效，请重新连接。';
    case 403: return '当前凭据没有 admin:inspect 权限，或 Origin 与网关监听地址不一致。';
    case 404: return 'Admin 入口或目标资源未启用。';
    case 409: return 'store_id 与当前网关不匹配。';
    case 429: return '实例正在读取，请稍后重试。';
    case 503: return '网关尚未完成初始化，请稍后重试。';
    default: return `请求失败（${error.code}）。`;
  }
}

export function errorRequestId(error: unknown): string | undefined {
  return error instanceof AdminApiError ? error.requestId : undefined;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
  request_id?: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  token?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isObject(value) || !isObject(value.error)) return false;
  return typeof value.error.code === 'string';
}

function isAdminInfo(value: unknown): value is AdminInfo {
  return isObject(value)
    && typeof value.store_id === 'string'
    && typeof value.latest_seq === 'string'
    && typeof value.version === 'string'
    && Array.isArray(value.plugins);
}

async function send(path: string, options: RequestOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const bearer = options.token ?? token.value;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new AdminApiError(0, 'network_error');
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = isErrorEnvelope(body) ? body : undefined;
    // A rejected stored token cannot authorize another request; return to the
    // login gate instead of leaving every view in a permanent 401 state.
    if (response.status === 401 && options.token === undefined) expireSession();
    throw new AdminApiError(response.status, envelope?.error.code ?? 'request_failed', envelope?.request_id);
  }
  return body;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export async function login(token: string, signal?: AbortSignal): Promise<AdminInfo> {
  const body = await send('/api/admin/info', { token, signal });
  if (!isAdminInfo(body)) throw new AdminApiError(200, 'invalid_response');
  return body;
}

export async function fetchInfo(signal?: AbortSignal): Promise<AdminInfo> {
  const body = await send('/api/admin/info', { signal });
  if (!isAdminInfo(body)) throw new AdminApiError(200, 'invalid_response');
  return body;
}

export async function fetchPanels(signal?: AbortSignal): Promise<{ store_id: string; panels: PanelSummary[] }> {
  const body = await send('/api/admin/panels', { signal });
  if (!isObject(body) || !Array.isArray(body.panels)) throw new AdminApiError(200, 'invalid_response');
  return body as unknown as { store_id: string; panels: PanelSummary[] };
}

export async function fetchPanel(instanceId: string, signal?: AbortSignal): Promise<PanelDetail> {
  const body = await send('/api/admin/panels/' + encodeURIComponent(instanceId), { signal });
  if (!isObject(body) || typeof body.instance_id !== 'string') throw new AdminApiError(200, 'invalid_response');
  return body as unknown as PanelDetail;
}

export async function fetchEvents(
  options: { storeId: string; afterSeq: string; limit?: number; sourcePrefix?: string; type?: string },
  signal?: AbortSignal,
): Promise<EventPage> {
  const body = await send('/api/admin/events?' + query({
    store_id: options.storeId,
    after_seq: options.afterSeq,
    limit: options.limit,
    source_prefix: options.sourcePrefix,
    type: options.type,
  }), { signal });
  if (!isObject(body) || !Array.isArray(body.records)) throw new AdminApiError(200, 'invalid_response');
  return body as unknown as EventPage;
}

export async function fetchCalls(
  options: {
    storeId: string;
    limit?: number;
    callerId?: string;
    status?: CallStatus;
    after?: CallCursor;
  },
  signal?: AbortSignal,
): Promise<CallPage> {
  const body = await send('/api/admin/calls?' + query({
    store_id: options.storeId,
    limit: options.limit,
    caller_id: options.callerId,
    status: options.status,
    after_caller_id: options.after?.caller_id,
    after_call_id: options.after?.call_id,
  }), { signal });
  if (!isObject(body) || !Array.isArray(body.calls)) throw new AdminApiError(200, 'invalid_response');
  return body as unknown as CallPage;
}

export async function fetchCapabilities(signal?: AbortSignal): Promise<CapabilityPage> {
  const body = await send('/api/admin/capabilities', { signal });
  if (!isObject(body) || !Array.isArray(body.capabilities)) throw new AdminApiError(200, 'invalid_response');
  return body as unknown as CapabilityPage;
}

export async function fetchConfiguration(signal?: AbortSignal): Promise<Configuration> {
  const body = await send('/api/admin/configuration', { signal });
  if (!isObject(body) || !Array.isArray(body.principals) || !Array.isArray(body.plugins)) {
    throw new AdminApiError(200, 'invalid_response');
  }
  return body as unknown as Configuration;
}

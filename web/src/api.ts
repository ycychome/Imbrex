import { computed, ref } from 'vue';
import type { AdminInfo } from './client-api';

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

interface Envelope {
  error?: { code?: unknown };
  request_id?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is Envelope {
  return isObject(value) && isObject(value.error);
}

function isAdminInfo(value: unknown): value is AdminInfo {
  return isObject(value)
    && typeof value.store_id === 'string'
    && typeof value.latest_seq === 'string'
    && typeof value.version === 'string'
    && Array.isArray(value.plugins);
}

async function send(path: string, init: RequestInit, tokenOverride?: string): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const bearer = tokenOverride ?? token.value;
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new AdminApiError(0, 'network_error');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = isEnvelope(body) ? body : undefined;
    if (response.status === 401 && tokenOverride === undefined) expireSession();
    const code = envelope && typeof envelope.error?.code === 'string' ? envelope.error.code : 'request_failed';
    throw new AdminApiError(response.status, code, envelope?.request_id);
  }
  return body;
}

export async function login(value: string): Promise<AdminInfo> {
  const body = await send('/api/admin/info', {}, value);
  if (!isAdminInfo(body)) throw new AdminApiError(200, 'invalid_response');
  return body;
}

export async function fetchInfo(init: RequestInit = {}): Promise<AdminInfo> {
  const body = await send('/api/admin/info', init);
  if (!isAdminInfo(body)) throw new AdminApiError(200, 'invalid_response');
  return body;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return await send(path, init) as T;
}

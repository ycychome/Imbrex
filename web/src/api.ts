export interface AdminInfo {
  store_id: string;
  latest_seq: string;
  version: string;
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

interface ErrorEnvelope {
  error: { code: string; message: string };
  request_id?: string;
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string';
}

function isAdminInfo(value: unknown): value is AdminInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info.store_id === 'string'
    && typeof info.latest_seq === 'string'
    && typeof info.version === 'string';
}

export async function fetchAdminInfo(token: string, signal?: AbortSignal): Promise<AdminInfo> {
  const response = await fetch('/api/admin/info', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = isErrorEnvelope(body) ? body : undefined;
    throw new AdminApiError(
      response.status,
      envelope?.error.code ?? 'request_failed',
      envelope?.request_id,
    );
  }
  if (!isAdminInfo(body)) throw new AdminApiError(response.status, 'invalid_response');
  return body;
}

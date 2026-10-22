export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'unknown';

const panelTones: Record<string, Tone> = {
  ok: 'ok',
  warning: 'warn',
  error: 'bad',
  idle: 'idle',
  unknown: 'unknown',
};

/** Panel status tones are a wire contract; map them onto the console palette. */
export function toneOf(value: unknown): Tone {
  return typeof value === 'string' ? (panelTones[value] ?? 'unknown') : 'unknown';
}

export interface FailureInfo {
  status?: number;
  code?: string;
  requestId?: string;
}

/** Errors arrive from the shared client; read them defensively. */
export function failureOf(error: unknown): FailureInfo {
  if (typeof error !== 'object' || error === null) return {};
  const record = error as Record<string, unknown>;
  return {
    status: typeof record.status === 'number' ? record.status : undefined,
    code: typeof record.code === 'string' ? record.code : undefined,
    requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
  };
}

export function describeFailure(error: unknown): string {
  const { status, code } = failureOf(error);
  switch (status) {
    case 0: return '无法连接网关，请确认服务正在运行。';
    case 401: return 'Token 无效或已失效，请重新连接。';
    case 403: return '当前凭据没有 admin:inspect 权限，或 Origin 与网关监听地址不一致。';
    case 404: return 'Admin 入口或目标资源未启用。';
    case 409: return 'store_id 与当前网关不匹配。';
    case 429: return '实例正在读取，请稍后重试。';
    case 503: return '网关尚未完成初始化，请稍后重试。';
    default: return code ? `请求失败（${code}）。` : '请求失败。';
  }
}

export function requestIdOf(error: unknown): string | undefined {
  return failureOf(error).requestId;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

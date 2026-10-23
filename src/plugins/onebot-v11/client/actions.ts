import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelSummary } from '@imbrex/ui-contract/ui';

export interface Outcome {
  ok: boolean;
  status: number;
  code: string;
  message: string;
  result: Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function act(client: ViewClient, summary: PanelSummary, storeId: string, action: string, params: unknown): Promise<Outcome> {
  const path = '/api/admin/panels/' + encodeURIComponent(summary.instance_id) + '/actions/' + encodeURIComponent(action);
  try {
    const body = await client.request<{ result?: unknown }>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, generation: summary.generation, params }),
    });
    return { ok: true, status: 200, code: '', message: '', result: record(body.result) ?? {} };
  } catch (error) {
    const info = record(error);
    const status = typeof info?.status === 'number' ? info.status : 0;
    const code = text(info?.code, 'request_failed');
    return { ok: false, status, code, message: failureMessage(status, code), result: {} };
  }
}

export function failureMessage(status: number, code: string): string {
  if (status === 0) return '无法连接管理 API；操作结果未知，请重新读取面板。';
  if (status === 401) return '登录已失效，请重新输入 Token。';
  if (status === 403) return '当前凭据没有 admin:operate 权限。';
  if (status === 404) return '动作或实例已不存在。';
  if (status === 409) return '页面状态已改变，正在重新读取面板。';
  if (status === 429) return '该实例正在执行另一个动作，请稍候。';
  if (status === 503) return '实例尚未就绪或正在停止，未执行动作。';
  if (status === 400) return code === 'invalid_params' ? '参数未通过服务端校验。' : '请求参数无效。';
  return '管理 API 返回错误：' + code;
}

export function resultFailed(result: Record<string, unknown>): string | null {
  const status = text(result.status);
  if (status === 'succeeded' || status === '') return null;
  const reason = record(result.reason);
  return '执行未完成：' + text(reason?.code, 'unknown');
}

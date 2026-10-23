import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelSummary } from '@imbrex/ui-contract/ui';

export interface ConsumerFilter {
  group_ids: string[];
  private_user_ids: string[];
}

export interface PiSettings {
  model: string;
  context_window: number;
  system_prompt: string;
  max_tokens?: number;
}

export interface PiManagement {
  saved: PiSettings;
  applied: PiSettings | null;
  applying: boolean;
}

export interface Management {
  revision: string;
  timeout_ms: number;
  filter: { saved: ConsumerFilter | null; applied: ConsumerFilter | null };
  filter_status: string;
  pi?: PiManagement;
  pi_status: string;
  observed_models: Record<string, string>;
  observed_usage: Record<string, { used: number; size: number }>;
}

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

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function filterOf(value: unknown): ConsumerFilter | null {
  const item = record(value);
  if (!item || !Array.isArray(item.group_ids) || !Array.isArray(item.private_user_ids)) return null;
  const ids = (input: unknown[]): string[] | null => {
    const values = input.filter((entry): entry is string => typeof entry === 'string');
    return values.length === input.length ? values : null;
  };
  const groups = ids(item.group_ids), privates = ids(item.private_user_ids);
  return groups && privates ? { group_ids: groups, private_user_ids: privates } : null;
}

function settingsOf(value: unknown): PiSettings | null {
  const item = record(value);
  if (!item || typeof item.model !== 'string' || typeof item.context_window !== 'number' || typeof item.system_prompt !== 'string') return null;
  return {
    model: item.model, context_window: item.context_window, system_prompt: item.system_prompt,
    ...(typeof item.max_tokens === 'number' ? { max_tokens: item.max_tokens } : {}),
  };
}

/**
 * The panel data is authoritative and may be partial (state unavailable, no
 * management block, unmanaged pi). Anything unexpected yields null so the
 * control surface degrades to a readable note instead of guessing.
 */
export function managementOf(data: Record<string, unknown>): Management | null {
  const value = record(data.management);
  if (!value || typeof value.revision !== 'string') return null;
  const filter = record(value.filter);
  const saved = filter ? filterOf(filter.saved) : null;
  const applied = filter ? filterOf(filter.applied) : null;
  const pi = record(value.pi);
  const piSaved = pi ? settingsOf(pi.saved) : null;
  return {
    revision: value.revision,
    timeout_ms: typeof value.timeout_ms === 'number' ? value.timeout_ms : 120000,
    filter: { saved, applied },
    filter_status: text(value.filter_status, 'unknown'),
    ...(piSaved ? { pi: { saved: piSaved, applied: pi?.applied ? settingsOf(pi.applied) : null, applying: pi?.applying === true } } : {}),
    pi_status: text(value.pi_status, 'unmanaged'),
    observed_models: Object.fromEntries(Object.entries(record(value.observed_models) ?? {}).flatMap(([key, model]) => typeof model === 'string' ? [[key, model]] : [])),
    observed_usage: Object.fromEntries(Object.entries(record(value.observed_usage) ?? {}).flatMap(([key, usage]) => {
      const item = record(usage);
      return item && typeof item.used === 'number' && typeof item.size === 'number' ? [[key, { used: item.used, size: item.size }]] : [];
    })),
  };
}

export function actionOf(summary: PanelSummary, id: string): boolean {
  return (summary.actions ?? []).some((action) => action.id === id);
}

export async function operate(client: ViewClient, summary: PanelSummary, storeId: string, action: string, params: unknown): Promise<Outcome> {
  const path = '/api/admin/panels/' + encodeURIComponent(summary.instance_id) + '/actions/' + encodeURIComponent(action);
  try {
    const body = await client.request<{ result?: unknown }>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, generation: summary.generation, params }),
    });
    return { ok: true, status: 200, code: '', message: '', result: record(body.result) ?? {} };
  } catch (error) {
    const status = typeof record(error)?.status === 'number' ? record(error)!.status as number : 0;
    const code = text(record(error)?.code, 'request_failed');
    return { ok: false, status, code, message: failureMessage(status, code), result: {} };
  }
}

function failureMessage(status: number, code: string): string {
  if (status === 0) return '无法连接管理 API；操作结果未知，请重新读取面板后再决定。';
  if (status === 401) return '登录已失效，请重新输入 Token。';
  if (status === 403) return '当前凭据没有 admin:operate 权限。';
  if (status === 404) return '动作或实例已不存在。';
  if (status === 409) return '页面状态已改变（配置版本、代次或未决输入已更新）；已重新读取，请核对后再试。';
  if (status === 429) return '该实例正在执行另一个动作，请稍候。';
  if (status === 503) return '实例尚未就绪或正在停止，未执行动作。';
  if (status === 400) return code === 'invalid_params' ? '参数未通过服务端校验。' : '请求参数无效。';
  return '管理 API 返回错误：' + code;
}

/** An accepted action can still fail on its own side; never read that as success. */
export function resultMessage(outcome: Outcome): string {
  const status = text(outcome.result.status);
  if (status === 'succeeded') return '动作已完成。';
  const reason = record(outcome.result.reason);
  const code = reason ? text(reason.code, 'unknown') : 'unknown';
  const operation = outcome.result.operation_id;
  const parts = ['执行未完成：' + code];
  if (typeof operation === 'string') parts.push('备份 operation_id ' + operation);
  if (outcome.result.inspect_required === true) parts.push('需要人工核验现场；备份不是最终成功收据');
  return parts.join('；');
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Native IDs are canonical positive decimals; empty input means no IDs. */
export function parseIds(value: string): string[] | null {
  const parts = value.split(/[\s,，、;；]+/u).filter(Boolean);
  if (parts.length > 1000) return null;
  for (const part of parts) {
    if (!/^[1-9][0-9]{0,19}$/.test(part)) return null;
    if (BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  }
  return [...new Set(parts)].sort();
}

export function idsText(value: ConsumerFilter | null, key: 'group_ids' | 'private_user_ids'): string {
  return value ? value[key].join('\n') : '';
}

export function formatIds(value: string[]): string {
  return value.length ? value.join('、') : '空（该类不放行）';
}

import { computed, reactive } from 'vue';
import type { AdminInfo } from '../types';
import { expireSession, fetchInfo, request } from './api';
import { describeFailure, failureOf, formatRelative, isAbort, isBusy, now, toneOf, type PanelDetail, type PanelSummary, type Tone } from '@imbrex/ui-contract/ui';

export interface PanelHealth {
  instanceId: string;
  module: string;
  title: string;
  icon: string;
  tone: Tone;
  label: string;
  detail?: string;
}

const POLL_MS = 5000;
const STALE_MS = 15000;

const state = reactive({
  info: null as AdminInfo | null,
  panels: [] as PanelHealth[],
  updatedAt: 0,
  loading: false,
  paused: false,
  error: null as unknown,
});

let timer: number | undefined;
let inFlight = false;
let running = false;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function panelView(data: unknown): { tone: Tone; label: string } | null {
  const status = record(record(data)?.status);
  if (!status || typeof status.label !== 'string') return null;
  return { tone: toneOf(status.tone), label: status.label };
}

async function readPanel(summary: PanelSummary): Promise<PanelDetail> {
  const path = '/api/admin/panels/' + encodeURIComponent(summary.instance_id);
  try {
    return await request<PanelDetail>(path);
  } catch (error) {
    // A page view may hold the instance read lock at the same time.
    if (!isBusy(error)) throw error;
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    return await request<PanelDetail>(path);
  }
}

async function loadPanels(): Promise<PanelHealth[]> {
  const list = await request<{ panels: PanelSummary[] }>('/api/admin/panels');
  return await Promise.all(list.panels.map(async (summary): Promise<PanelHealth> => {
    const base = { instanceId: summary.instance_id, module: summary.module, title: summary.title, icon: summary.icon };
    try {
      const detail = await readPanel(summary);
      if (detail.error) return { ...base, tone: 'warn', label: '读取失败', detail: detail.error.message ?? detail.error.code };
      const view = panelView(detail.data);
      return view ? { ...base, ...view } : { ...base, tone: 'unknown', label: '无状态' };
    } catch (error) {
      if (isAbort(error)) throw error;
      if (isBusy(error)) {
        // Still contended after one retry: keep the last known projection
        // instead of claiming the panel failed.
        return state.panels.find((panel) => panel.instanceId === summary.instance_id)
          ?? { ...base, tone: 'unknown', label: '读取中' };
      }
      return { ...base, tone: 'warn', label: '读取失败', detail: describeFailure(error) };
    }
  }));
}

async function tick(): Promise<void> {
  if (inFlight || !running || state.paused) return;
  inFlight = true;
  state.loading = true;
  try {
    const info = await fetchInfo();
    const panels = await loadPanels();
    state.info = info;
    state.panels = panels;
    state.error = null;
    state.updatedAt = Date.now();
  } catch (error) {
    if (isAbort(error)) return;
    state.error = error;
    const status = failureOf(error).status;
    if (status === 401) {
      stopHealth();
      expireSession();
    } else if (status === 403) {
      stopHealth();
      expireSession('管理凭据缺少 admin:inspect 权限，或 Origin 与网关监听地址不一致。');
    } else if (status === 404) {
      stopHealth();
    }
  } finally {
    inFlight = false;
    state.loading = false;
  }
}

export function startHealth(): void {
  if (running) return;
  running = true;
  state.paused = false;
  void tick();
  timer = window.setInterval(() => { void tick(); }, POLL_MS);
}

export function stopHealth(): void {
  running = false;
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

export function togglePolling(): void {
  state.paused = !state.paused;
  if (!state.paused) void tick();
}

export function refreshHealth(): void {
  void tick();
}

export { state as health };

/** Gateway rollup: required plugins down first, then any reported error. */
export const gatewayHealth = computed<{ tone: Tone; label: string }>(() => {
  const plugins = (state.info?.plugins ?? []).filter((plugin) => plugin.enabled);
  const down = plugins.filter((plugin) => plugin.required && !plugin.available);
  if (down.length) return { tone: 'bad', label: `网关 ${down.length} 个必需插件异常` };
  const failed = plugins.filter((plugin) => plugin.last_error);
  if (failed.length) return { tone: 'warn', label: `网关 ${failed.length} 个插件报错` };
  if (!state.info) return { tone: 'unknown', label: '网关状态未知' };
  return { tone: 'ok', label: '网关正常' };
});

export const updatedText = computed(() => (state.updatedAt ? formatRelative(state.updatedAt, now.value) : '尚未更新'));

export const stale = computed(() => {
  if (!state.updatedAt) return false;
  return now.value - state.updatedAt > STALE_MS;
});

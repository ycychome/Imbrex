import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ViewClient } from '../contract.js';
import { isAbort, toneOf, type Tone } from './errors';

export interface PanelMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface PanelView {
  status: { tone: Tone; label: string };
  metrics: PanelMetric[];
  data: Record<string, unknown>;
}

export interface PanelSummary {
  instance_id: string;
  module: string;
  generation: string;
  title: string;
  icon: string;
}

export interface PanelDetail {
  instance_id: string;
  module: string;
  generation: string;
  data?: unknown;
  error?: { code: string; message?: string };
}

export interface PanelEntry {
  summary: PanelSummary;
  detail: PanelDetail | null;
  failure: unknown;
  view: PanelView | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function asPanelView(value: unknown): PanelView | null {
  const root = record(value);
  const status = record(root?.status);
  if (!root || !status || typeof status.tone !== 'string' || typeof status.label !== 'string') return null;
  if (!Array.isArray(root.metrics)) return null;
  const metrics = root.metrics.flatMap((entry): PanelMetric[] => {
    const metric = record(entry);
    if (!metric || typeof metric.label !== 'string' || typeof metric.value !== 'string') return [];
    return [{ label: metric.label, value: metric.value, ...(typeof metric.hint === 'string' ? { hint: metric.hint } : {}) }];
  });
  const data = record(root.data);
  if (!data) return null;
  return { status: { tone: toneOf(status.tone), label: status.label }, metrics, data };
}

/**
 * Shared panel polling for every plugin client: the fetch is generic, the
 * rendering belongs to the plugin that owns the data.
 */
export function usePanels(client: ViewClient, module: string, intervalMs = 5000) {
  const entries = shallowRef<PanelEntry[]>([]);
  const error = ref<unknown>(null);
  const updatedAt = ref(0);
  const loading = ref(false);
  const paused = ref(false);

  const controller = new AbortController();
  let timer: number | undefined;
  let busy = false;
  let disposed = false;

  async function load(): Promise<void> {
    if (busy || disposed || paused.value) return;
    busy = true;
    loading.value = true;
    try {
      const list = await client.request<{ panels: PanelSummary[] }>('/api/admin/panels', { signal: controller.signal });
      const next = await Promise.all(list.panels.filter((summary) => summary.module === module).map(async (summary): Promise<PanelEntry> => {
        try {
          const detail = await client.request<PanelDetail>('/api/admin/panels/' + encodeURIComponent(summary.instance_id), { signal: controller.signal });
          return { summary, detail, failure: null, view: detail.error ? null : asPanelView(detail.data) };
        } catch (failure) {
          if (isAbort(failure)) throw failure;
          return { summary, detail: null, failure, view: null };
        }
      }));
      entries.value = next;
      error.value = null;
      updatedAt.value = Date.now();
    } catch (cause) {
      if (!isAbort(cause)) error.value = cause;
    } finally {
      busy = false;
      loading.value = false;
    }
  }

  function stop(): void {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  function start(): void {
    stop();
    if (disposed) return;
    void load();
    timer = window.setInterval(() => { void load(); }, intervalMs);
  }

  function toggle(): void {
    paused.value = !paused.value;
    if (paused.value) stop();
    else start();
  }

  onMounted(start);
  onUnmounted(() => {
    disposed = true;
    stop();
    controller.abort();
  });

  return { entries, error, updatedAt, loading, paused, load, toggle, start, stop };
}

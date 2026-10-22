<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { AdminClient } from '../../../../web/src/client-api.js';

type PanelTone = 'ok' | 'warning' | 'error' | 'idle' | 'unknown';
interface PanelMetric { label: string; value: string; hint?: string }
interface PanelView { status: { tone: PanelTone; label: string }; metrics: PanelMetric[]; data: Record<string, unknown> }
interface PanelSummary { instance_id: string; module: string; generation: string; title: string; icon: string }
interface PanelDetail { instance_id: string; module: string; generation: string; data?: unknown; error?: { code: string; message: string } }
interface PanelEntry {
  summary: PanelSummary;
  detail: PanelDetail | null;
  failure: unknown;
  view: PanelView | null;
}

const props = defineProps<{ client: AdminClient }>();
const MODULE = 'onebot-v11';

function statusOf(value: unknown): number | undefined {
  return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number' ? value.status : undefined;
}
function errorText(value: unknown): string {
  switch (statusOf(value)) {
    case 0: return '无法连接网关，请确认服务正在运行。';
    case 401: return 'Token 无效或已失效，请重新连接。';
    case 403: return '当前凭据没有 admin:inspect 权限，或 Origin 与网关监听地址不一致。';
    case 404: return 'Admin 入口或目标资源未启用。';
    case 409: return 'store_id 与当前网关不匹配。';
    case 429: return '实例正在读取，请稍后重试。';
    case 503: return '网关尚未完成初始化，请稍后重试。';
    default: return '请求失败。';
  }
}
function requestId(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string' ? value.requestId : undefined;
}

const controller = new AbortController();
const entries = shallowRef<PanelEntry[]>([]);
const error = ref<unknown>(null);
const lastUpdated = ref<Date | null>(null);
const loaded = ref(false);
const enabled = ref(true);
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asPanelView(value: unknown): PanelView | null {
  const root = record(value);
  const status = record(root?.status);
  if (!root || !status || typeof status.tone !== 'string' || typeof status.label !== 'string') return null;
  if (!Array.isArray(root.metrics)) return null;
  const metrics = root.metrics.flatMap((entry) => {
    const metric = record(entry);
    if (!metric || typeof metric.label !== 'string' || typeof metric.value !== 'string') return [];
    return [{ label: metric.label, value: metric.value, ...(typeof metric.hint === 'string' ? { hint: metric.hint } : {}) }];
  });
  const data = record(root.data);
  if (!data) return null;
  return { status: { tone: status.tone as PanelTone, label: status.label }, metrics, data };
}

function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return pretty(value);
}

function isComplex(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function dataEntries(view: PanelView): Array<[string, unknown]> {
  return Object.entries(view.data);
}

function keyLabel(key: string): string {
  return key.replaceAll('_', ' ');
}

function toneClass(tone: string): string {
  switch (tone) {
    case 'ok':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300';
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
  }
}

function stop(): void {
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
}

async function load(): Promise<void> {
  if (busy.value || disposed) return;
  busy.value = true;
  try {
    const list = await props.client.request<{ panels: PanelSummary[] }>('/api/admin/panels', { signal: controller.signal });
    const nextEntries = await Promise.all(list.panels.filter((summary) => summary.module === MODULE).map(async (summary): Promise<PanelEntry> => {
      try {
        const detail = await props.client.request<PanelDetail>('/api/admin/panels/' + encodeURIComponent(summary.instance_id), { signal: controller.signal });
        return { summary, detail, failure: null, view: asPanelView(detail.data) };
      } catch (failure) {
        return { summary, detail: null, failure, view: null };
      }
    }));
    entries.value = nextEntries;
    loaded.value = true;
    error.value = null;
    lastUpdated.value = new Date();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    error.value = cause;
    if (statusOf(cause) === 401 || statusOf(cause) === 403) enabled.value = false;
  } finally {
    busy.value = false;
  }
}

watch(enabled, (value) => {
  stop();
  if (value) timer = setInterval(() => { void load(); }, 5000);
}, { immediate: true });
onMounted(() => { void load(); });
onUnmounted(() => { disposed = true; stop(); controller.abort(); });
</script>

<template>
  <main class="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">OneBot</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          最近更新 {{ lastUpdated?.toLocaleTimeString('zh-CN') ?? '—' }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          @click="enabled = !enabled"
        >
          {{ enabled ? '暂停轮询' : '开启轮询' }}
        </button>
        <button
          type="button"
          :disabled="busy"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          @click="load"
        >
          {{ busy ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <p
      v-if="error"
      role="alert"
      class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
    >
      {{ errorText(error) }}
      <span v-if="requestId(error)" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ requestId(error) }}</span>
    </p>

    <p v-if="loaded && !entries.length && !busy" class="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      该插件尚未登记可读面板。
    </p>

    <article
      v-for="entry in entries"
      :key="entry.summary.instance_id"
      class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold">{{ entry.summary.title }}</h3>
          <span class="rounded-full border border-slate-200 px-2 py-0.5 font-mono text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {{ entry.summary.module }}
          </span>
          <span class="font-mono text-xs text-slate-500 dark:text-slate-400">{{ entry.summary.instance_id }}</span>
        </div>
        <span class="font-mono text-[11px] text-slate-400 dark:text-slate-500" :title="entry.summary.generation">
          generation {{ entry.summary.generation.slice(0, 8) }}
        </span>
      </div>

      <div class="p-4">
        <p
          v-if="entry.failure"
          role="alert"
          class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
        >
          读取失败：{{ errorText(entry.failure) }}
          <span v-if="requestId(entry.failure)" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ requestId(entry.failure) }}</span>
        </p>

        <p
          v-else-if="entry.detail?.error"
          role="alert"
          class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
        >
          读取失败：{{ entry.detail.error.code }} — {{ entry.detail.error.message }}
        </p>

        <template v-else-if="entry.view">
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <span class="inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium" :class="toneClass(entry.view.status.tone)">
              {{ entry.view.status.label }}
            </span>
            <span class="font-mono text-xs text-slate-400 dark:text-slate-500">{{ entry.view.status.tone }}</span>
          </div>

          <dl v-if="entry.view.metrics.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div v-for="metric in entry.view.metrics" :key="metric.label">
              <dt class="text-xs text-slate-500 dark:text-slate-400">{{ metric.label }}</dt>
              <dd class="mt-1 break-all font-mono text-sm">{{ metric.value }}</dd>
              <p v-if="metric.hint" class="mt-1 text-xs text-slate-400 dark:text-slate-500">{{ metric.hint }}</p>
            </div>
          </dl>

          <div v-if="dataEntries(entry.view).length" class="mt-5">
            <p class="text-xs font-medium text-slate-500 dark:text-slate-400">详情</p>
            <dl class="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 text-xs dark:divide-slate-800 dark:border-slate-700">
              <div v-for="pair in dataEntries(entry.view)" :key="pair[0]" class="grid gap-2 px-3 py-2 sm:grid-cols-[12rem_1fr]">
                <dt class="font-mono text-slate-500 dark:text-slate-400">{{ keyLabel(pair[0]) }}</dt>
                <dd class="min-w-0 break-all">
                  <span v-if="!isComplex(pair[1])" class="font-mono">{{ valueText(pair[1]) }}</span>
                  <details v-else>
                    <summary class="cursor-pointer font-mono text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">查看</summary>
                    <pre class="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(pair[1]) }}</pre>
                  </details>
                </dd>
              </div>
            </dl>
          </div>
        </template>

        <template v-else-if="entry.detail && entry.detail.data !== undefined">
          <p class="mb-2 text-xs text-slate-500 dark:text-slate-400">该面板未使用声明式格式，显示原始数据。</p>
          <pre class="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(entry.detail.data) }}</pre>
        </template>

        <p v-else class="text-sm text-slate-500 dark:text-slate-400">面板暂无可读数据。</p>
      </div>
    </article>
  </main>
</template>

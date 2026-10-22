<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { AdminClient } from '../../../../web/src/client-api.js';

interface EventRecord {
  seq: string;
  accepted_at: string;
  event: { source: string; id: string; type: string; data: unknown; [key: string]: unknown };
  parents: { source: string; id: string }[];
}
interface EventPage { records: EventRecord[]; next_after_seq: string; caught_up: boolean }

const props = defineProps<{ client: AdminClient }>();

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
function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}
function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

const controller = new AbortController();
const storeId = ref('');
const records = shallowRef<EventRecord[]>([]);
const nextAfterSeq = ref('0');
const caughtUp = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref<unknown>(null);
const sourcePrefix = ref('');
const type = ref('');
const appliedSource = ref('');
const appliedType = ref('');

const hasMore = computed(() => !caughtUp.value);

async function loadPage(reset: boolean): Promise<void> {
  if (loading.value || !storeId.value) return;
  loading.value = true;
  try {
    const page = await props.client.request<EventPage>('/api/admin/events?' + query({
      store_id: storeId.value,
      after_seq: reset ? '0' : nextAfterSeq.value,
      limit: 50,
      source_prefix: appliedSource.value || undefined,
      type: appliedType.value || undefined,
    }), { signal: controller.signal });
    records.value = reset ? page.records : [...records.value, ...page.records];
    nextAfterSeq.value = page.next_after_seq;
    caughtUp.value = page.caught_up;
    loaded.value = true;
    error.value = null;
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause;
  } finally {
    loading.value = false;
  }
}

async function apply(): Promise<void> {
  appliedSource.value = sourcePrefix.value.trim();
  appliedType.value = type.value.trim();
  records.value = [];
  caughtUp.value = false;
  await loadPage(true);
}

async function refresh(): Promise<void> {
  records.value = [];
  caughtUp.value = false;
  await loadPage(true);
}

onMounted(async () => {
  try {
    const info = await props.client.request<{ store_id: string }>('/api/admin/info', { signal: controller.signal });
    storeId.value = info.store_id;
    await loadPage(true);
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause;
  }
});

onUnmounted(() => controller.abort());
</script>

<template>
  <main class="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">事件浏览</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          store <span class="font-mono text-xs">{{ storeId || '加载中…' }}</span>
        </p>
      </div>
      <button
        type="button"
        :disabled="loading"
        class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        @click="refresh"
      >
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <p
      v-if="error"
      role="alert"
      class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
    >
      {{ errorText(error) }}
      <span v-if="requestId(error)" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ requestId(error) }}</span>
    </p>

    <form
      class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
      @submit.prevent="apply"
    >
      <label class="flex min-w-52 flex-1 flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        来源前缀
        <input
          v-model="sourcePrefix"
          type="text"
          placeholder="例如 qq.message"
          class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-400 dark:focus:ring-slate-700"
        />
      </label>
      <label class="flex min-w-52 flex-1 flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        事件类型
        <input
          v-model="type"
          type="text"
          placeholder="例如 qq.message.group"
          class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-400 dark:focus:ring-slate-700"
        />
      </label>
      <button
        type="submit"
        :disabled="loading"
        class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        应用筛选
      </button>
    </form>

    <section class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[52rem] text-left text-sm">
          <thead class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th class="px-4 py-2 font-medium">Seq</th>
              <th class="px-4 py-2 font-medium">接纳时间</th>
              <th class="px-4 py-2 font-medium">来源</th>
              <th class="px-4 py-2 font-medium">类型</th>
              <th class="px-4 py-2 font-medium">数据</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <tr v-for="record in records" :key="record.seq">
              <td class="px-4 py-3 font-mono text-xs tabular-nums">{{ record.seq }}</td>
              <td class="whitespace-nowrap px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{{ formatTime(record.accepted_at) }}</td>
              <td class="px-4 py-3">
                <p class="break-all font-mono text-xs">{{ record.event.source }}</p>
                <p class="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">{{ record.event.id }}</p>
              </td>
              <td class="px-4 py-3 font-mono text-xs">{{ record.event.type }}</td>
              <td class="px-4 py-3">
                <details>
                  <summary class="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">查看数据</summary>
                  <pre class="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(record.event.data) }}</pre>
                  <template v-if="record.parents.length">
                    <p class="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">父事件</p>
                    <pre class="mt-1 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(record.parents) }}</pre>
                  </template>
                </details>
              </td>
            </tr>
            <tr v-if="!records.length && !loading && loaded">
              <td colspan="5" class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                {{ caughtUp ? '没有符合条件的事件。' : '暂无事件。' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
        <p class="text-xs text-slate-500 dark:text-slate-400">
          已加载 {{ records.length }} 条
          <span v-if="caughtUp" class="ml-2">已到最新</span>
        </p>
        <button
          v-if="hasMore"
          type="button"
          :disabled="loading"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          @click="loadPage(false)"
        >
          {{ loading ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </section>
  </main>
</template>

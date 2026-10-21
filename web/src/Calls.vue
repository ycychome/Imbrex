<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import {
  fetchCalls,
  fetchCapabilities,
  fetchInfo,
  type AdminCall,
  type AdminCapability,
  type CallCursor,
  type CallStatus,
  describeError,
  errorRequestId,
} from './api';

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
const capabilities = shallowRef<AdminCapability[]>([]);
const calls = shallowRef<AdminCall[]>([]);
const next = ref<CallCursor | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref<unknown>(null);
const caller = ref('');
const status = ref('all');
const appliedCaller = ref('');
const appliedStatus = ref('all');

const hasMore = computed(() => next.value !== null);

function statusClass(value: CallStatus): string {
  switch (value) {
    case 'succeeded':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300';
    case 'failed':
      return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300';
    case 'unknown':
      return 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300';
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
  }
}

async function load(reset: boolean): Promise<void> {
  if (!storeId.value || loading.value) return;
  loading.value = true;
  try {
    const page = await fetchCalls({
      storeId: storeId.value,
      limit: 50,
      callerId: appliedCaller.value || undefined,
      status: appliedStatus.value === 'all' ? undefined : appliedStatus.value as CallStatus,
      after: reset ? undefined : next.value ?? undefined,
    }, controller.signal);
    calls.value = reset ? page.calls : [...calls.value, ...page.calls];
    next.value = page.next;
    loaded.value = true;
    error.value = null;
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause;
  } finally {
    loading.value = false;
  }
}

async function apply(): Promise<void> {
  appliedCaller.value = caller.value.trim();
  appliedStatus.value = status.value;
  calls.value = [];
  next.value = null;
  await load(true);
}

async function refresh(): Promise<void> {
  calls.value = [];
  next.value = null;
  await load(true);
}

onMounted(async () => {
  try {
    const [info, capabilityPage] = await Promise.all([
      fetchInfo(controller.signal),
      fetchCapabilities(controller.signal),
    ]);
    storeId.value = info.store_id;
    capabilities.value = capabilityPage.capabilities;
    await load(true);
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
        <h2 class="text-lg font-semibold">能力与调用</h2>
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
      {{ describeError(error) }}
      <span v-if="errorRequestId(error)" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ errorRequestId(error) }}</span>
    </p>

    <section class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div class="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 class="text-sm font-semibold">已登记能力</h3>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">包含仍登记但当前不可用的实例。</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[52rem] text-left text-sm">
          <thead class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th class="px-4 py-2 font-medium">能力</th>
              <th class="px-4 py-2 font-medium">实例</th>
              <th class="px-4 py-2 font-medium">说明</th>
              <th class="px-4 py-2 font-medium">副作用</th>
              <th class="px-4 py-2 font-medium">可用</th>
              <th class="px-4 py-2 font-medium">输入 Schema</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <tr v-for="capability in capabilities" :key="capability.id">
              <td class="px-4 py-3 font-mono text-xs">{{ capability.id }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ capability.plugin_instance_id }}</td>
              <td class="px-4 py-3 text-xs">{{ capability.description }}</td>
              <td class="px-4 py-3 text-xs">{{ capability.is_side_effectful ? '是' : '否' }}</td>
              <td class="px-4 py-3 text-xs">
                <span
                  class="inline-flex rounded-full border px-2 py-0.5 text-xs font-medium"
                  :class="capability.available
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'"
                >
                  {{ capability.available ? '可用' : '不可用' }}
                </span>
              </td>
              <td class="px-4 py-3">
                <details>
                  <summary class="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">查看</summary>
                  <pre class="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(capability.input_schema) }}</pre>
                </details>
              </td>
            </tr>
            <tr v-if="!capabilities.length">
              <td colspan="6" class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">暂无已登记能力。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <form
      class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
      @submit.prevent="apply"
    >
      <label class="flex min-w-52 flex-1 flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        调用主体
        <input
          v-model="caller"
          type="text"
          placeholder="例如 demo-agent"
          class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-400 dark:focus:ring-slate-700"
        />
      </label>
      <label class="flex min-w-40 flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        状态
        <select
          v-model="status"
          class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-400 dark:focus:ring-slate-700"
        >
          <option value="all">全部</option>
          <option value="in_progress">in_progress</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="unknown">unknown</option>
        </select>
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
      <div class="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 class="text-sm font-semibold">调用审计</h3>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">按调用主体与 call_id 的字典序分页；各页是新的查询视图，状态可能变化。</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[56rem] text-left text-sm">
          <thead class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th class="px-4 py-2 font-medium">调用主体</th>
              <th class="px-4 py-2 font-medium">调用</th>
              <th class="px-4 py-2 font-medium">状态</th>
              <th class="px-4 py-2 font-medium">更新时间</th>
              <th class="px-4 py-2 font-medium">参数 / 结果</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <tr v-for="call in calls" :key="call.caller_id + '/' + call.call_id">
              <td class="px-4 py-3 font-mono text-xs">{{ call.caller_id }}</td>
              <td class="px-4 py-3">
                <p class="font-mono text-xs">{{ call.call_id }}</p>
                <p class="mt-1 break-all font-mono text-xs text-slate-500 dark:text-slate-400">{{ call.capability_id }}</p>
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded-full border px-2 py-0.5 text-xs font-medium" :class="statusClass(call.status)">{{ call.status }}</span>
              </td>
              <td class="whitespace-nowrap px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{{ formatTime(call.updated_at) }}</td>
              <td class="px-4 py-3">
                <details>
                  <summary class="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">查看</summary>
                  <p class="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">参数</p>
                  <pre class="mt-1 max-h-48 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(call.params) }}</pre>
                  <template v-if="call.result !== undefined">
                    <p class="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">结果</p>
                    <pre class="mt-1 max-h-48 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(call.result) }}</pre>
                  </template>
                  <template v-if="call.reason">
                    <p class="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">原因</p>
                    <pre class="mt-1 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(call.reason) }}</pre>
                  </template>
                </details>
              </td>
            </tr>
            <tr v-if="!calls.length && !loading && loaded">
              <td colspan="5" class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">没有符合条件的调用。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
        <p class="text-xs text-slate-500 dark:text-slate-400">已加载 {{ calls.length }} 条</p>
        <button
          v-if="hasMore"
          type="button"
          :disabled="loading"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          @click="load(false)"
        >
          {{ loading ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </section>
  </main>
</template>

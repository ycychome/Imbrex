<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { AdminApiError, describeError, errorRequestId, fetchInfo, type AdminInfo } from './api';

const controller = new AbortController();
const info = ref<AdminInfo | null>(null);
const error = ref<unknown>(null);
const lastUpdated = ref<Date | null>(null);
const copied = ref(false);
const enabled = ref(true);
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;

function stop(): void {
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
}

async function load(): Promise<void> {
  if (busy.value || disposed) return;
  busy.value = true;
  try {
    info.value = await fetchInfo(controller.signal);
    error.value = null;
    lastUpdated.value = new Date();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    error.value = cause;
    if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) enabled.value = false;
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

const plugins = computed(() => info.value?.plugins ?? []);
const available = computed(() => plugins.value.filter((plugin) => plugin.available).length);
const failed = computed(() => plugins.value.filter((plugin) => plugin.last_error).length);
const lastUpdatedText = computed(() => lastUpdated.value?.toLocaleTimeString('zh-CN') ?? '—');

function stateClass(state: string, isAvailable: boolean): string {
  if (isAvailable) return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300';
  if (state === 'failed') return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300';
  if (state === 'waiting' || state === 'loading' || state === 'stopping') {
    return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
  }
  return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
}

async function copyStoreId(): Promise<void> {
  if (!info.value) return;
  try {
    await navigator.clipboard.writeText(info.value.store_id);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    // Clipboard access is optional; the value remains visible for manual copying.
  }
}
</script>

<template>
  <main class="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">网关状态</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">最近更新 {{ lastUpdatedText }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
          :class="error ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'"
        >
          <span class="h-1.5 w-1.5 rounded-full" :class="error ? 'bg-amber-500' : 'bg-emerald-500'"></span>
          {{ error ? '刷新失败' : '已连接' }}
        </span>
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
      {{ describeError(error) }}
      <span v-if="errorRequestId(error)" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ errorRequestId(error) }}</span>
    </p>

    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Store ID</p>
        <p class="mt-2 break-all font-mono text-sm">{{ info?.store_id ?? '—' }}</p>
        <button
          type="button"
          class="mt-3 text-xs font-medium text-slate-500 transition hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-100"
          :disabled="!info"
          @click="copyStoreId"
        >
          {{ copied ? '已复制' : '复制' }}
        </button>
      </article>
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Latest Seq</p>
        <p class="mt-2 font-mono text-3xl font-semibold tabular-nums">{{ info?.latest_seq ?? '—' }}</p>
        <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">最新已接纳事件的序号</p>
      </article>
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">可用插件</p>
        <p class="mt-2 font-mono text-3xl font-semibold tabular-nums">{{ available }}<span class="text-base text-slate-400"> / {{ plugins.length }}</span></p>
        <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">最近错误 {{ failed }}</p>
      </article>
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Version</p>
        <p class="mt-2 font-mono text-sm">{{ info?.version ?? '—' }}</p>
        <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">产品版本，与 config_version 独立</p>
      </article>
    </section>

    <section class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div class="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 class="text-sm font-semibold">插件</h3>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">状态来自宿主运行时投影，不代表持久化健康检查。</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[40rem] text-left text-sm">
          <thead class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th class="px-4 py-2 font-medium">实例</th>
              <th class="px-4 py-2 font-medium">模块</th>
              <th class="px-4 py-2 font-medium">状态</th>
              <th class="px-4 py-2 font-medium">可用</th>
              <th class="px-4 py-2 font-medium">必需</th>
              <th class="px-4 py-2 font-medium">最近错误</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <tr v-for="plugin in plugins" :key="plugin.id">
              <td class="px-4 py-3 font-mono text-xs">{{ plugin.id }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ plugin.module_name }}</td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded-full border px-2 py-0.5 text-xs font-medium" :class="stateClass(plugin.state, plugin.available)">
                  {{ plugin.state }}
                </span>
              </td>
              <td class="px-4 py-3 text-xs">{{ plugin.available ? '是' : '否' }}</td>
              <td class="px-4 py-3 text-xs">{{ plugin.required ? '是' : '否' }}</td>
              <td class="px-4 py-3 font-mono text-xs text-rose-600 dark:text-rose-300">
                {{ plugin.last_error?.code ?? '—' }}
                <span v-if="plugin.last_error?.message" class="mt-1 block text-slate-500 dark:text-slate-400">{{ plugin.last_error.message }}</span>
              </td>
            </tr>
            <tr v-if="!plugins.length">
              <td colspan="6" class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">暂无插件状态。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>

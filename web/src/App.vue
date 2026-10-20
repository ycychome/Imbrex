<script setup lang="ts">
import { computed, ref } from 'vue';
import { AdminApiError, fetchAdminInfo, type AdminInfo } from './api';

const token = ref('');
const info = ref<AdminInfo | null>(null);
const error = ref<AdminApiError | null>(null);
const loading = ref(false);
const lastUpdated = ref<Date | null>(null);
const copied = ref(false);

const errorText = computed(() => {
  if (!error.value) return '';
  switch (error.value.status) {
    case 0:
      return '无法连接网关，请确认服务正在运行。';
    case 401:
      return 'Token 无效或已失效，请重新输入。';
    case 403:
      return '当前凭据没有 admin:inspect 权限，或 Origin 与网关监听地址不一致。';
    case 404:
      return 'Admin 入口未启用，或管理 UI 尚未构建。';
    case 503:
      return '网关尚未完成初始化，请稍后重试。';
    default:
      return `请求失败（${error.value.code}）。`;
  }
});

async function load(): Promise<void> {
  const value = token.value.trim();
  if (!value || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    info.value = await fetchAdminInfo(value);
    lastUpdated.value = new Date();
  } catch (cause) {
    const failure = cause instanceof AdminApiError
      ? cause
      : new AdminApiError(0, 'network_error');
    error.value = failure;
    if (failure.status === 401) {
      info.value = null;
      token.value = '';
    }
  } finally {
    loading.value = false;
  }
}

function disconnect(): void {
  token.value = '';
  info.value = null;
  error.value = null;
  lastUpdated.value = null;
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
  <main
    v-if="!info"
    class="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
  >
    <form
      class="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      @submit.prevent="load"
    >
      <div class="mb-6">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Imbrex</p>
        <h1 class="mt-2 text-2xl font-semibold tracking-tight">Admin Console</h1>
        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">使用 admin:inspect 凭据连接网关。</p>
      </div>

      <label class="block text-sm font-medium" for="admin-token">Admin Token</label>
      <input
        id="admin-token"
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        class="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:focus:border-slate-400 dark:focus:ring-slate-700"
      />

      <p
        v-if="error"
        role="alert"
        class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
      >
        {{ errorText }}
        <span v-if="error.requestId" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ error.requestId }}</span>
      </p>

      <button
        type="submit"
        :disabled="loading || !token.trim()"
        class="mt-5 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {{ loading ? '连接中…' : '连接网关' }}
      </button>

      <p class="mt-4 text-center text-xs text-slate-400 dark:text-slate-500">Token 仅保存在当前页面内存。</p>
    </form>
  </main>

  <div v-else-if="info" class="flex min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-6 dark:border-slate-800 dark:bg-slate-900 sm:flex">
      <div class="flex items-center gap-2 px-2">
        <span class="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-900">I</span>
        <span class="text-sm font-semibold tracking-tight">Imbrex</span>
      </div>
      <nav class="mt-8">
        <a href="#overview" class="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium dark:bg-slate-800">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
          概览
        </a>
      </nav>
      <p class="mt-auto px-2 text-xs text-slate-400 dark:text-slate-500">admin:inspect</p>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-6">
        <div class="flex items-center gap-2">
          <span class="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-900 sm:hidden">I</span>
          <h1 class="text-base font-semibold">概览</h1>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
            已连接
          </span>
          <button type="button" :disabled="loading" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800" @click="load">
            {{ loading ? '刷新中…' : '刷新' }}
          </button>
          <button type="button" class="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950" @click="disconnect">
            断开
          </button>
        </div>
      </header>

      <main id="overview" class="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-6 sm:px-6">
        <section class="grid gap-4 sm:grid-cols-3">
          <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Store ID</p>
            <p class="mt-2 break-all font-mono text-sm">{{ info.store_id }}</p>
            <button type="button" class="mt-3 text-xs font-medium text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100" @click="copyStoreId">
              {{ copied ? '已复制' : '复制' }}
            </button>
          </article>
          <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Latest Seq</p>
            <p class="mt-2 font-mono text-3xl font-semibold tabular-nums">{{ info.latest_seq }}</p>
          </article>
          <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Version</p>
            <p class="mt-2 font-mono text-sm">{{ info.version }}</p>
          </article>
        </section>

        <p v-if="error" role="alert" class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {{ errorText }}
          <span v-if="error.requestId" class="mt-1 block font-mono text-xs opacity-75">request_id: {{ error.requestId }}</span>
        </p>

        <section class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="text-sm font-semibold">连接状态</h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                管理 API <code class="font-mono text-xs">/api/admin/info</code>
              </p>
            </div>
            <p class="text-xs text-slate-400 dark:text-slate-500">
              最后更新 {{ lastUpdated?.toLocaleTimeString('zh-CN') ?? '—' }}
            </p>
          </div>
        </section>

        <details class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <summary class="cursor-pointer px-4 py-3 text-sm font-medium">原始响应（诊断）</summary>
          <pre class="overflow-x-auto border-t border-slate-200 px-4 py-3 font-mono text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">{{ JSON.stringify(info, null, 2) }}</pre>
        </details>
      </main>
    </div>
  </div>
</template>

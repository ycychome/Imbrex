<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { authenticated, clearToken, describeError, login, sessionMessage, setToken } from './api';
import { client, ctx } from './context';
import { loadPluginClients } from './loader';

const input = ref('');
const error = ref('');
const loading = ref(false);
const loadingViews = ref(false);
const loadError = ref('');
const failures = ref<string[]>([]);

const views = computed(() => ctx.views.list());
const active = computed(() => ctx.views.active());
const title = computed(() => active.value?.title ?? '管理控制台');
const loginError = computed(() => error.value || sessionMessage.value);

async function loadViews(): Promise<void> {
  loadingViews.value = true;
  loadError.value = '';
  try {
    const result = await loadPluginClients();
    failures.value = result.failures;
  } catch (cause) {
    loadError.value = describeError(cause);
  } finally {
    loadingViews.value = false;
  }
}

async function submit(): Promise<void> {
  const value = input.value.trim();
  if (!value || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await login(value);
    setToken(value);
    input.value = '';
    await loadViews();
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    loading.value = false;
  }
}

function disconnect(): void {
  clearToken();
  window.location.reload();
}

onMounted(() => {
  if (authenticated.value) void loadViews();
});
</script>

<template>
  <main
    v-if="!authenticated"
    class="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
  >
    <form
      class="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      @submit.prevent="submit"
    >
      <div class="mb-6">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Imbrex</p>
        <h1 class="mt-2 text-2xl font-semibold tracking-tight">Admin Console</h1>
        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">使用 admin:inspect 凭据连接网关。</p>
      </div>

      <label class="block text-sm font-medium" for="admin-token">Admin Token</label>
      <input
        id="admin-token"
        v-model="input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        autofocus
        class="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:focus:border-slate-400 dark:focus:ring-slate-700"
      />

      <p
        v-if="loginError"
        role="alert"
        class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
      >
        {{ loginError }}
      </p>

      <button
        type="submit"
        :disabled="loading || !input.trim()"
        class="mt-5 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {{ loading ? '连接中…' : '连接网关' }}
      </button>

      <p class="mt-4 text-center text-xs text-slate-400 dark:text-slate-500">Token 保存在本标签页的 sessionStorage，关闭标签页即清除。</p>
    </form>
  </main>

  <div v-else class="flex min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-6 dark:border-slate-800 dark:bg-slate-900 sm:flex">
      <div class="flex items-center gap-2 px-2">
        <span class="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-900">I</span>
        <span class="text-sm font-semibold tracking-tight">Imbrex</span>
      </div>
      <nav class="mt-8 space-y-1">
        <button
          v-for="view in views"
          :key="view.id"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
          :class="active?.id === view.id ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white' : ''"
          @click="ctx.views.select(view.id)"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-current opacity-40"></span>
          {{ view.title }}
        </button>
        <p v-if="!views.length && loadingViews" class="px-2 py-2 text-xs text-slate-400 dark:text-slate-500">加载插件视图…</p>
      </nav>
      <p class="mt-auto px-2 text-xs text-slate-400 dark:text-slate-500">admin:inspect</p>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-6">
        <div class="flex items-center gap-2">
          <span class="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-900 sm:hidden">I</span>
          <h1 class="text-base font-semibold">{{ title }}</h1>
        </div>
        <button
          type="button"
          class="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950"
          @click="disconnect"
        >
          断开
        </button>
      </header>

      <nav class="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 sm:hidden">
        <button
          v-for="view in views"
          :key="view.id"
          type="button"
          class="whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300"
          :class="active?.id === view.id ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white' : ''"
          @click="ctx.views.select(view.id)"
        >
          {{ view.title }}
        </button>
      </nav>

      <p
        v-if="loadError"
        role="alert"
        class="mx-4 mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200 sm:mx-6"
      >
        {{ loadError }}
      </p>
      <p
        v-if="failures.length"
        role="alert"
        class="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200 sm:mx-6"
      >
        部分插件视图加载失败：
        <span v-for="failure in failures" :key="failure" class="mt-1 block font-mono text-xs">{{ failure }}</span>
      </p>

      <div class="flex-1">
        <RouterView v-if="active" v-slot="{ Component }">
          <component :is="Component" :client="client" />
        </RouterView>
        <div v-else class="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
          {{ loadingViews ? '加载插件视图…' : '没有已启用的插件视图。' }}
        </div>
      </div>
    </div>
  </div>
</template>

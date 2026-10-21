<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { describeError, errorRequestId, fetchConfiguration, type Configuration, type ConfigPlugin, type Json } from '../api';

function jsonRecord(value: Json | undefined): Record<string, Json> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function jsonPath(value: Json | undefined, ...keys: string[]): Json | undefined {
  let current = value;
  for (const key of keys) {
    const record = jsonRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}
function jsonText(value: Json | undefined, fallback = '未提供'): string {
  if (value === undefined) return fallback;
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
function jsonArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}
function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

const controller = new AbortController();
const config = shallowRef<Configuration | null>(null);
const error = ref<unknown>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    config.value = await fetchConfiguration(controller.signal);
    error.value = null;
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause;
  } finally {
    loading.value = false;
  }
}

function moduleLabel(module: string): string {
  if (module === 'builtin:onebot-v11') return 'OneBot v11';
  if (module === 'builtin:agent-chat') return 'Agent Chat';
  return module === 'external' ? '外部模块' : module;
}

function sourcesText(sources: Array<{ exact?: string; prefix?: string }>): string {
  if (!sources.length) return '—';
  return sources.map((source) => source.exact !== undefined ? source.exact : `prefix:${source.prefix ?? ''}`).join(', ');
}

function listText(value: Json | undefined): string {
  const items = jsonArray(value).map((item) => jsonText(item));
  return items.length ? items.join(', ') : '—';
}

function credentialText(plugin: ConfigPlugin): string {
  const credential = jsonPath(plugin.configuration, 'credential');
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return '—';
  const name = jsonText(jsonPath(credential, 'name'));
  const configured = jsonPath(credential, 'configured') === true;
  return `${name}（${configured ? '已配置' : '未配置'}）`;
}

onMounted(() => { void load(); });
onUnmounted(() => controller.abort());
</script>

<template>
  <main class="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">配置查看</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">只读视图；秘密仅显示引用名称与是否已加载。</p>
      </div>
      <button
        type="button"
        :disabled="loading"
        class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        @click="load"
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

    <section v-if="config" class="grid gap-4 sm:grid-cols-3">
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Config Version</p>
        <p class="mt-2 font-mono text-3xl font-semibold">{{ config.config_version }}</p>
      </article>
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">External Writes</p>
        <p class="mt-2 text-sm font-medium">{{ config.external_writes_enabled ? '已启用' : '未启用' }}</p>
        <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">影响外部来源的写入授权判断</p>
      </article>
      <article class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">MCP URL</p>
        <p class="mt-2 break-all font-mono text-sm">{{ config.mcp_url ?? '未提供' }}</p>
        <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">不承诺协议插件当前可用</p>
      </article>
    </section>

    <section v-if="config" class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div class="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 class="text-sm font-semibold">主体</h3>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[56rem] text-left text-sm">
          <thead class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <tr>
              <th class="px-4 py-2 font-medium">ID</th>
              <th class="px-4 py-2 font-medium">权限</th>
              <th class="px-4 py-2 font-medium">读取来源</th>
              <th class="px-4 py-2 font-medium">写入来源</th>
              <th class="px-4 py-2 font-medium">可调用能力</th>
              <th class="px-4 py-2 font-medium">凭据引用</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <tr v-for="principal in config.principals" :key="principal.id">
              <td class="px-4 py-3 font-mono text-xs">{{ principal.id }}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <span v-for="permission in principal.permissions" :key="permission" class="rounded-full border border-slate-200 px-2 py-0.5 font-mono text-[11px] dark:border-slate-700">{{ permission }}</span>
                  <span v-if="!principal.permissions.length" class="text-xs text-slate-400">—</span>
                </div>
              </td>
              <td class="px-4 py-3 font-mono text-xs">{{ sourcesText(principal.read_sources) }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ sourcesText(principal.write_sources) }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ principal.invoke_capabilities.join(', ') || '—' }}</td>
              <td class="px-4 py-3 font-mono text-xs">
                <template v-if="principal.credential">
                  {{ principal.credential.name }}
                  <span :class="principal.credential.configured ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'">
                    （{{ principal.credential.configured ? '已配置' : '未配置' }}）
                  </span>
                </template>
                <template v-else>—</template>
              </td>
            </tr>
            <tr v-if="!config.principals.length">
              <td colspan="6" class="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">暂无主体。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="config" class="space-y-4">
      <h3 class="text-sm font-semibold">插件配置</h3>
      <article v-for="plugin in config.plugins" :key="plugin.instance_id" class="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="text-sm font-semibold">{{ plugin.instance_id }}</h4>
            <span class="rounded-full border border-slate-200 px-2 py-0.5 font-mono text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">{{ moduleLabel(plugin.module) }}</span>
            <span class="font-mono text-xs text-slate-500 dark:text-slate-400">principal {{ plugin.principal_id }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="rounded-full border border-slate-200 px-2 py-0.5 dark:border-slate-700">{{ plugin.enabled ? '已启用' : '未启用' }}</span>
            <span class="rounded-full border border-slate-200 px-2 py-0.5 dark:border-slate-700">{{ plugin.required ? '必需' : '可选' }}</span>
          </div>
        </div>

        <div class="p-4">
          <template v-if="plugin.module === 'builtin:onebot-v11'">
            <dl class="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt class="text-slate-500 dark:text-slate-400">账号</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'account_id')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">身份命名空间</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'identity_namespace')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">传输</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'transport')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">兼容配置</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'compatibility_profile')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">群白名单</dt>
                <dd class="mt-1 font-mono">{{ listText(jsonPath(plugin.configuration, 'allow_group_ids')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">私聊白名单</dt>
                <dd class="mt-1 font-mono">{{ listText(jsonPath(plugin.configuration, 'allow_private_ids')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">访问凭据</dt>
                <dd class="mt-1 font-mono">{{ credentialText(plugin) }}</dd>
              </div>
            </dl>
          </template>

          <template v-else-if="plugin.module === 'builtin:agent-chat'">
            <dl class="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt class="text-slate-500 dark:text-slate-400">输入实例</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'input_id')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">来源前缀</dt>
                <dd class="mt-1 break-all font-mono">{{ jsonText(jsonPath(plugin.configuration, 'source_prefix')) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">最大事件年龄</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'max_event_age_seconds')) }} s</dd>
              </div>
              <div>
                <dt class="text-slate-500 dark:text-slate-400">轮次超时</dt>
                <dd class="mt-1 font-mono">{{ jsonText(jsonPath(plugin.configuration, 'turn_timeout_ms')) }} ms</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-slate-500 dark:text-slate-400">触发过滤</dt>
                <dd class="mt-1 break-all font-mono">{{ jsonText(jsonPath(plugin.configuration, 'filter'), '未配置') }}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-slate-500 dark:text-slate-400">Agent 配置</dt>
                <dd class="mt-1 text-slate-600 dark:text-slate-300">{{ jsonText(jsonPath(plugin.configuration, 'agent_configuration')) }}</dd>
              </div>
            </dl>
          </template>

          <details v-else>
            <summary class="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">配置详情</summary>
            <pre class="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{{ pretty(plugin.configuration) }}</pre>
          </details>
        </div>
      </article>
    </section>
  </main>
</template>

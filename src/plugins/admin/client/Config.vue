<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { AdminClient } from '../../../../ui-contract/src/client-api.js';
import Chip from '../../../../ui-contract/src/ui/Chip.vue';
import EmptyState from '../../../../ui-contract/src/ui/EmptyState.vue';
import ErrorNotice from '../../../../ui-contract/src/ui/ErrorNotice.vue';
import KeyValueList from '../../../../ui-contract/src/ui/KeyValueList.vue';
import PageHeader from '../../../../ui-contract/src/ui/PageHeader.vue';
import Section from '../../../../ui-contract/src/ui/Section.vue';
import Stat from '../../../../ui-contract/src/ui/Stat.vue';
import { isAbort } from '../../../../ui-contract/src/ui/errors.js';
import type { KeyValueEntry } from '../../../../ui-contract/src/ui/types.js';

interface ConfigPrincipal {
  id: string;
  permissions: string[];
  read_sources: Array<{ exact?: string; prefix?: string }>;
  write_sources: Array<{ exact?: string; prefix?: string }>;
  invoke_capabilities: string[];
  credential: { name: string; configured: boolean } | null;
}
interface ConfigPlugin {
  instance_id: string;
  module: string;
  principal_id: string;
  enabled: boolean;
  required: boolean;
  configuration: Record<string, unknown>;
}
interface Configuration {
  config_version: number;
  external_writes_enabled: boolean;
  mcp_url: string | null;
  principals: ConfigPrincipal[];
  plugins: ConfigPlugin[];
}

const props = defineProps<{ client: AdminClient }>();

const controller = new AbortController();
const config = shallowRef<Configuration | null>(null);
const error = ref<unknown>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    config.value = await props.client.request<Configuration>('/api/admin/configuration', { signal: controller.signal });
    error.value = null;
  } catch (cause) {
    if (!isAbort(cause)) error.value = cause;
  } finally {
    loading.value = false;
  }
}

function moduleLabel(module: string): string {
  if (module === 'external') return '外部模块';
  return module.startsWith('builtin:') ? module.slice('builtin:'.length) : module;
}

function sourcesText(sources: Array<{ exact?: string; prefix?: string }>): string {
  if (!sources.length) return '—';
  return sources.map((source) => (source.exact !== undefined ? source.exact : `prefix:${source.prefix ?? ''}`)).join('、');
}

function configurationEntries(plugin: ConfigPlugin): KeyValueEntry[] {
  return Object.entries(plugin.configuration).map(([key, value]) => ({ label: key, labelMono: true, value }));
}

onMounted(() => { void load(); });
onUnmounted(() => controller.abort());
</script>

<template>
  <main class="page">
    <PageHeader title="配置查看" description="只读视图；秘密只显示引用名称与是否已配置。">
      <template #actions>
        <button type="button" class="btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </template>
    </PageHeader>

    <ErrorNotice v-if="error" :error="error" retry @retry="load" />

    <section v-if="config" class="panel overflow-hidden">
      <div class="grid grid-cols-1 gap-px bg-[var(--line)] sm:grid-cols-3">
        <Stat class="bg-[var(--surface)]" label="配置版本" :value="String(config.config_version)" mono hint="配置文件版本号" />
        <Stat
          class="bg-[var(--surface)]"
          label="外部写入"
          :value="config.external_writes_enabled ? '已启用' : '未启用'"
          hint="影响外部来源的写入授权判断"
        />
        <Stat class="bg-[var(--surface)]" label="MCP 地址" :value="config.mcp_url ?? '未提供'" mono small hint="不承诺协议插件当前可用" />
      </div>
    </section>

    <Section v-if="config" title="主体" description="权限、来源范围与凭据引用；Token 与密钥不会出现在此处。">
      <div class="panel overflow-hidden">
        <div class="overflow-x-auto">
          <table class="table min-w-[56rem]">
            <colgroup>
              <col class="w-[11rem]" />
              <col class="w-[16rem]" />
              <col />
              <col />
              <col class="w-[9rem]" />
              <col class="w-[12rem]" />
            </colgroup>
            <thead>
              <tr>
                <th>主体</th>
                <th>权限</th>
                <th>读取来源</th>
                <th>写入来源</th>
                <th>可调用能力</th>
                <th>凭据引用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="principal in config.principals" :key="principal.id">
                <td class="whitespace-nowrap font-mono text-xs">{{ principal.id }}</td>
                <td class="font-mono text-[11px] leading-relaxed text-[var(--muted)]">
                  {{ principal.permissions.join(' · ') || '—' }}
                </td>
                <td class="max-w-[16rem] break-words font-mono text-[11px] text-[var(--muted)]">{{ sourcesText(principal.read_sources) }}</td>
                <td class="max-w-[16rem] break-words font-mono text-[11px] text-[var(--muted)]">{{ sourcesText(principal.write_sources) }}</td>
                <td class="font-mono text-[11px] text-[var(--muted)]">{{ principal.invoke_capabilities.join('、') || '—' }}</td>
                <td class="font-mono text-xs">
                  <template v-if="principal.credential">
                    {{ principal.credential.name }}
                    <Chip
                      class="ml-1"
                      :tone="principal.credential.configured ? 'ok' : 'bad'"
                      :label="principal.credential.configured ? '已配置' : '未配置'"
                    />
                  </template>
                  <span v-else class="text-[var(--faint)]">—</span>
                </td>
              </tr>
              <tr v-if="!config.principals.length">
                <td colspan="6">
                  <EmptyState title="暂无主体" description="配置文件中还没有声明任何主体。" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Section>

    <Section v-if="config" title="插件配置" description="按实例展示保存的配置；值来自配置文件，不代表运行中的生效状态。">
      <div class="flex flex-col gap-4">
        <article v-for="plugin in config.plugins" :key="plugin.instance_id" class="panel overflow-hidden">
          <header class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--line)] px-4 py-3">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h3 class="text-sm font-semibold">{{ plugin.instance_id }}</h3>
              <span class="font-mono text-[11px] text-[var(--faint)]">{{ moduleLabel(plugin.module) }}</span>
              <span class="font-mono text-[11px] text-[var(--faint)]">主体 {{ plugin.principal_id }}</span>
            </div>
            <div class="flex items-center gap-2">
              <Chip :tone="plugin.enabled ? 'ok' : 'idle'" :label="plugin.enabled ? '已启用' : '未启用'" />
              <Chip :tone="plugin.required ? 'warn' : 'unknown'" :label="plugin.required ? '必需' : '可选'" />
            </div>
          </header>
          <div class="p-4">
            <KeyValueList v-if="configurationEntries(plugin).length" :entries="configurationEntries(plugin)" />
            <p v-else class="text-[13px] text-[var(--muted)]">该插件没有可展示配置。</p>
          </div>
        </article>
        <p v-if="!config.plugins.length" class="text-[13px] text-[var(--muted)]">没有已装配的插件。</p>
      </div>
    </Section>

    <p v-if="!config && !error" class="text-[13px] text-[var(--muted)]">正在读取配置…</p>
  </main>
</template>

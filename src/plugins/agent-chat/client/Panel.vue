<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, EmptyState, ErrorNotice, PageHeader, RelativeTime, useNarrow, usePanels } from '@imbrex/ui-contract/ui';
import { managementOf, record, text } from './control/operate';
import RuntimeTab from './control/RuntimeTab.vue';
import FilterForm from './control/FilterForm.vue';
import TimeoutForm from './control/TimeoutForm.vue';
import AgentForm from './control/AgentForm.vue';
import SessionInspector from './control/SessionInspector.vue';

const props = defineProps<{ client: ViewClient }>();
const { entries, error, updatedAt, loading, paused, load, toggle } = usePanels(props.client, 'agent-chat');
const narrow = useNarrow();

function hashParams(): URLSearchParams {
  const index = location.hash.indexOf('?');
  return new URLSearchParams(index < 0 ? '' : location.hash.slice(index + 1));
}

const initial = hashParams();
const selectedId = ref(initial.get('instance') ?? '');
const tab = ref<'runtime' | 'config'>(initial.get('tab') === 'config' ? 'config' : 'runtime');
const selectedSource = ref('');
const sheetOpen = ref(false);

watch(entries, (list) => {
  if (!list.length) { selectedId.value = ''; return; }
  if (!list.some((item) => item.summary.instance_id === selectedId.value)) selectedId.value = list[0]!.summary.instance_id;
}, { immediate: true });

watch([selectedId, tab], () => {
  const base = location.hash.split('?')[0] || '#/agent';
  const params = new URLSearchParams();
  if (selectedId.value) params.set('instance', selectedId.value);
  if (tab.value === 'config') params.set('tab', 'config');
  const query = params.toString();
  history.replaceState(null, '', base + (query ? '?' + query : ''));
});

const entry = computed(() => entries.value.find((item) => item.summary.instance_id === selectedId.value) ?? entries.value[0] ?? null);
const data = computed<Record<string, unknown>>(() => (entry.value?.view?.data ?? {}) as Record<string, unknown>);
const storeId = computed(() => text(data.value.store_id));
const management = computed(() => managementOf(data.value));
const sessions = computed(() => Object.keys(record(data.value.sessions) ?? {}));

watch(sessions, (list) => {
  if (selectedSource.value && !list.includes(selectedSource.value)) selectedSource.value = '';
});

const piLabels: Record<string, string> = {
  unmanaged: '未托管', pending_restart: '待重启', applying: '应用中', failed: '应用失败',
  stopped_or_error: '已停止', awaiting_session: '待会话确认', applied: '已应用',
};
const piTones: Record<string, 'ok' | 'warn' | 'bad' | 'idle' | 'unknown'> = {
  applied: 'ok', pending_restart: 'warn', applying: 'warn', awaiting_session: 'warn',
  failed: 'bad', stopped_or_error: 'bad', unmanaged: 'idle',
};
const piStatus = computed(() => management.value?.pi_status ?? 'unmanaged');

function selectSource(source: string): void {
  selectedSource.value = source;
  if (narrow.value) sheetOpen.value = true;
}

function closeSheet(): void {
  sheetOpen.value = false;
}

function onInstance(event: Event): void {
  selectedId.value = (event.target as HTMLSelectElement).value;
}
</script>

<template>
  <main class="page">
    <PageHeader title="Agent" description="消费轮次、会话与托管配置；运行与配置分开展示。">
      <template #actions>
        <span class="hidden text-[11px] text-[var(--faint)] sm:inline">
          {{ paused ? '已暂停刷新' : '更新于' }}
          <RelativeTime v-if="!paused && updatedAt" :value="updatedAt" />
        </span>
        <button type="button" class="btn" @click="toggle">{{ paused ? '恢复刷新' : '暂停刷新' }}</button>
        <button type="button" class="btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </template>
    </PageHeader>

    <ErrorNotice v-if="error" :error="error" retry @retry="load" />

    <div v-if="entries.length > 1" class="flex items-center gap-2">
      <label class="label" for="agent-instance">实例</label>
      <select id="agent-instance" class="input max-w-72" :value="selectedId" @change="onInstance">
        <option v-for="item in entries" :key="item.summary.instance_id" :value="item.summary.instance_id">
          {{ item.summary.title }} · {{ item.summary.instance_id }}
        </option>
      </select>
    </div>

    <EmptyState
      v-if="!entries.length && !loading && !error"
      title="该插件尚未登记可读面板"
      description="Agent 运行时注册面板后，这里会显示运行台与配置。"
    />

    <template v-if="entry">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 class="text-sm font-semibold">{{ entry.summary.title }}</h2>
          <span class="font-mono text-[11px] text-[var(--faint)]">{{ entry.summary.instance_id }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Chip :tone="entry.view?.status.tone ?? 'unknown'" :label="entry.view?.status.label ?? '读取失败'" />
          <Chip :tone="piTones[piStatus] ?? 'unknown'" :label="'托管 · ' + (piLabels[piStatus] ?? piStatus)" />
        </div>
      </div>

      <div class="tabs" role="tablist" aria-label="Agent 视图">
        <button type="button" role="tab" class="tab" :class="{ 'is-active': tab === 'runtime' }" :aria-selected="tab === 'runtime'" @click="tab = 'runtime'">运行台</button>
        <button type="button" role="tab" class="tab" :class="{ 'is-active': tab === 'config' }" :aria-selected="tab === 'config'" @click="tab = 'config'">配置中心</button>
      </div>

      <div v-if="entry.view" class="grid items-start gap-4" :class="tab === 'runtime' ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''">
        <div class="flex min-w-0 flex-col gap-4">
          <RuntimeTab
            v-if="tab === 'runtime'"
            :client="client"
            :entry="entry"
            :selected="selectedSource"
            @reload="load"
            @select="selectSource"
          />
          <div v-else class="flex flex-col gap-4">
            <FilterForm :client="client" :summary="entry.summary" :store-id="storeId" :data="data" @reload="load" />
            <TimeoutForm :client="client" :summary="entry.summary" :store-id="storeId" :data="data" @reload="load" />
            <AgentForm :client="client" :summary="entry.summary" :store-id="storeId" :data="data" @reload="load" />
          </div>
        </div>

        <aside v-if="tab === 'runtime'" class="panel hidden self-start p-4 lg:sticky lg:top-[calc(var(--band)+16px)] lg:block">
          <SessionInspector
            v-if="selectedSource"
            :client="client"
            :summary="entry.summary"
            :store-id="storeId"
            :data="data"
            :source="selectedSource"
            @reload="load"
            @close="selectedSource = ''"
          />
          <p v-else class="text-[12px] leading-relaxed text-[var(--muted)]">
            选择一条会话，查看 ACP 会话、观察模型与 usage，并在这里重置会话。
          </p>
        </aside>
      </div>

      <div v-else class="panel p-4">
        <p class="text-[12px] text-[var(--muted)]">面板读取失败，无法展示运行台或配置。</p>
      </div>
    </template>

    <Teleport to="body">
      <template v-if="narrow && sheetOpen && selectedSource && entry">
        <button type="button" class="sheet-scrim" aria-label="关闭详情" @click="closeSheet" />
        <aside class="sheet" role="dialog" aria-modal="true">
          <SessionInspector
            :client="client"
            :summary="entry.summary"
            :store-id="storeId"
            :data="data"
            :source="selectedSource"
            @reload="load"
            @close="closeSheet"
          />
        </aside>
      </template>
    </Teleport>
  </main>
</template>

<style scoped>
.tabs {
  display: inline-flex;
  width: fit-content;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
}

.tab {
  height: 28px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.tab.is-active {
  background: var(--accent);
  color: var(--accent-ink);
}

.sheet-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  border: 0;
  background: rgb(18 17 16 / 48%);
  cursor: pointer;
}

.sheet {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 51;
  max-height: 85dvh;
  overflow-y: auto;
  padding: 16px;
  border-top: 1px solid var(--line);
  border-radius: 12px 12px 0 0;
  background: var(--surface);
  box-shadow: 0 -12px 40px rgb(0 0 0 / 28%);
}
</style>

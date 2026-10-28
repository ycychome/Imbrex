<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, EmptyState, ErrorNotice, JsonBlock, KeyValueList, PageHeader, RelativeTime, useNarrow, usePanels, type KeyValueEntry } from '@imbrex/ui-contract/ui';
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

// The shell normalizes the route after the first render; re-read the plugin's
// own query once mounted so instance/tab deep links survive that navigation.
function readHash(): void {
  if (location.hash.split('?')[0] !== '#/agent') return;
  const params = hashParams();
  tab.value = params.get('tab') === 'config' ? 'config' : 'runtime';
  selectedId.value = params.get('instance') ?? entries.value[0]?.summary.instance_id ?? '';
}

onMounted(() => {
  readHash();
  window.addEventListener('hashchange', readHash);
});
onUnmounted(() => window.removeEventListener('hashchange', readHash));

watch(entries, (list) => {
  if (!list.length) { selectedId.value = ''; return; }
  if (!list.some((item) => item.summary.instance_id === selectedId.value)) selectedId.value = list[0]!.summary.instance_id;
}, { immediate: true });

watch([selectedId, tab], () => {
  const base = location.hash.split('?')[0] || '#/agent';
  if (base !== '#/agent') return;
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
const identity = computed(() => JSON.stringify([entry.value?.summary.instance_id, entry.value?.summary.generation, storeId.value]));
const sessionKey = computed(() => JSON.stringify([identity.value, selectedSource.value, record(data.value.sessions)?.[selectedSource.value]]));
const sheet = ref<HTMLDialogElement | null>(null);
const identityNotice = ref('');

watch(identity, (_value, previous) => {
  closeSheet(); selectedSource.value = '';
  if (previous && entry.value) identityNotice.value = '实例、代次或存储已改变；旧编辑与确认已清除，请核对当前面板后再操作。';
});
watch([narrow, tab, selectedSource], () => {
  if (!narrow.value || tab.value !== 'runtime' || !selectedSource.value) closeSheet();
}, { flush: 'sync' });
watch([narrow, sheetOpen, selectedSource, entry], () => {
  if (narrow.value && sheetOpen.value && selectedSource.value && entry.value) {
    if (sheet.value && !sheet.value.open) sheet.value.showModal();
  } else sheet.value?.close();
}, { flush: 'post' });
onBeforeUnmount(() => sheet.value?.close());

const configuration = computed(() => record(data.value.configuration));
const configurationEntries = computed<KeyValueEntry[]>(() => Object.entries(configuration.value ?? {}).map(([key, value]) => ({
  label: ({ filter: '消费过滤', source_prefix: '来源前缀', max_event_age_seconds: '最大事件年龄（秒）', turn_timeout_ms: '单轮超时（毫秒）', reader: '读取授权', agent_environment: '环境变量', pi: 'Agent 配置' } as Record<string, string>)[key] ?? key,
  value,
})));

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
  sheet.value?.close();
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

      <ErrorNotice v-if="entry.failure" :error="entry.failure" retry @retry="load" />
      <ErrorNotice v-else-if="entry.detail?.error" :error="entry.detail.error" title="面板读取失败" :detail="entry.detail.error.message ?? entry.detail.error.code" />
      <ErrorNotice v-if="data.last_error" :error="data.last_error" title="运行时错误" :detail="text(data.last_error)" />
      <p v-if="identityNotice" role="status" class="text-[12px] text-[var(--warn)]">{{ identityNotice }}</p>

      <div v-if="entry.view" class="grid items-start gap-4" :class="tab === 'runtime' ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''">
        <div class="flex min-w-0 flex-col gap-4">
          <RuntimeTab
            v-if="tab === 'runtime'"
            :key="identity"
            :client="client"
            :entry="entry"
            :selected="selectedSource"
            @reload="load"
            @select="selectSource"
          />
          <div v-else :key="identity" class="flex flex-col gap-4">
            <FilterForm :client="client" :summary="entry.summary" :store-id="storeId" :data="data" @reload="load" />
            <TimeoutForm :client="client" :summary="entry.summary" :store-id="storeId" :data="data" @reload="load" />
            <AgentForm :client="client" :summary="entry.summary" :store-id="storeId" :data="data" @reload="load" />
          </div>
        </div>

        <aside v-if="tab === 'runtime'" class="panel hidden self-start p-4 lg:sticky lg:top-[calc(var(--band)+16px)] lg:block">
          <SessionInspector
            v-if="selectedSource"
            :key="sessionKey"
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
      <details v-if="configuration" class="panel p-4">
        <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">配置与授权事实</summary>
        <KeyValueList class="mt-2" :entries="configurationEntries" />
      </details>
      <details v-if="entry.detail" class="panel p-4">
        <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">原始面板数据</summary>
        <JsonBlock class="mt-2" :value="entry.view?.data ?? entry.detail.data" :max-height="320" />
      </details>
    </template>

    <Teleport to="body">
      <template v-if="narrow && tab === 'runtime' && sheetOpen && selectedSource && entry">
        <dialog ref="sheet" class="sheet" aria-label="会话详情" @cancel.prevent="closeSheet" @close="closeSheet" @click="($event.target === sheet) && closeSheet()">
          <SessionInspector
            :key="sessionKey"
            :client="client"
            :summary="entry.summary"
            :store-id="storeId"
            :data="data"
            :source="selectedSource"
            @reload="load"
            @close="closeSheet"
          />
        </dialog>
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

.sheet::backdrop {
  background: rgb(18 17 16 / 48%);
}

.sheet {
  position: fixed;
  top: auto;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 51;
  width: 100%;
  max-width: none;
  margin: 0;
  color: var(--text);
  border: 0;
  max-height: 85dvh;
  overflow-y: auto;
  padding: 16px;
  border-top: 1px solid var(--line);
  border-radius: 12px 12px 0 0;
  background: var(--surface);
  box-shadow: 0 -12px 40px rgb(0 0 0 / 28%);
}
</style>

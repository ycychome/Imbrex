<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, EmptyState, ErrorNotice, JsonBlock, KeyValueList, PageHeader, RelativeTime, formatDateTime, formatReading, usePanels, type KeyValueEntry } from '@imbrex/ui-contract/ui';
import { act, number, record, resultFailed, strings, text } from './actions';
import ScopeEditor from './ScopeEditor.vue';
import InterceptList from './InterceptList.vue';
import ProcessDrawer from './ProcessDrawer.vue';
import LogDrawer from './LogDrawer.vue';

const props = defineProps<{ client: ViewClient }>();
const { entries, error, updatedAt, loading, paused, load, toggle } = usePanels(props.client, 'onebot-v11');

function instanceFromHash(): string {
  const match = /[?&]instance=([a-z0-9_-]+)/.exec(location.hash);
  return match?.[1] ?? '';
}

const selectedId = ref(instanceFromHash());
watch(entries, (list) => {
  if (!list.length) { selectedId.value = ''; return; }
  if (!list.some((item) => item.summary.instance_id === selectedId.value)) selectedId.value = list[0]!.summary.instance_id;
}, { immediate: true });
watch(selectedId, (id) => {
  const base = location.hash.split('?')[0] || '#/onebot';
  history.replaceState(null, '', id ? `${base}?instance=${id}` : base);
});

const entry = computed(() => entries.value.find((item) => item.summary.instance_id === selectedId.value) ?? entries.value[0] ?? null);
const data = computed(() => record(entry.value?.view?.data) ?? {});
const storeId = computed(() => text(data.value.store_id));
const binding = computed(() => record(data.value.binding) ?? {});
const connection = computed(() => record(data.value.connection_metrics));
const runtimeError = computed(() => text(record(data.value.runtime_config)?.error));

const scope = computed(() => {
  const value = record(data.value.scope);
  return { group_ids: strings(value?.group_ids), private_user_ids: strings(value?.private_user_ids), source: text(value?.source, 'host') };
});

const managed = computed(() => {
  const value = record(data.value.managed_process);
  const saved = record(value?.saved) ?? {};
  const active = record(value?.active) ?? {};
  return {
    saved: {
      enabled: saved.enabled === true,
      command: text(saved.command),
      args: strings(saved.args),
      cwd: text(saved.cwd),
      env_vars: strings(saved.env_vars),
    },
    active: {
      state: text(active.state, 'disabled'),
      pid: number(active.pid) ?? undefined,
      exit_code: number(active.exit_code),
      error: text(active.error),
    },
    logs: strings(active.logs),
  };
});

const intercepts = computed(() => Array.isArray(data.value.intercepts) ? data.value.intercepts.flatMap((value) => {
  const item = record(value);
  if (!item) return [];
  const kind = text(item.kind);
  if (kind !== 'group' && kind !== 'private') return [];
  return [{ time: text(item.time), kind, conversation: text(item.conversation) }];
}) : []);

const rtt = computed(() => {
  const value = number(connection.value?.heartbeat_rtt_ms);
  return value === null ? '未提供' : formatReading(value, '毫秒');
});

const processLabels: Record<string, string> = {
  disabled: '未启用', external: '外部进程', starting: '启动中', running: '运行中',
  unready: '未监听', exited: '已退出', stopped: '已停止',
};

const infoEntries = computed<KeyValueEntry[]>(() => [
  { label: '账号', value: text(data.value.account_id, '—'), mono: true },
  { label: '命名空间', value: text(data.value.identity_namespace, '—'), mono: true },
  { label: '实现', value: text(binding.value.app_name, '未提供'), mono: true },
  { label: '协议版本', value: text(binding.value.protocol_version, '未提供'), mono: true },
  { label: '账号核验', value: data.value.account_verified === true ? '已核验' : '未核验' },
  { label: '本次启动', value: formatDateTime(text(data.value.started_at)), mono: true },
  { label: '最近错误', value: text(data.value.last_error, '无'), mono: true },
  { label: '接收帧', value: display(connection.value?.received_frames), mono: true },
  { label: '已发请求', value: display(connection.value?.sent_requests), mono: true },
  { label: '采集来源', value: scope.value.source === 'runtime' ? '插件配置' : '宿主配置' },
]);

function display(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '未提供';
}

const busy = ref(false);
const notice = ref('');
const failure = ref('');
const settingsOpen = ref(false);
const logsOpen = ref(false);

async function run(action: string, params: unknown, success: string): Promise<void> {
  const current = entry.value;
  if (!current || busy.value) return;
  busy.value = true;
  notice.value = '';
  failure.value = '';
  const outcome = await act(props.client, current.summary, storeId.value, action, params);
  busy.value = false;
  if (!outcome.ok) {
    failure.value = outcome.message;
    if (outcome.status === 409) void load();
    return;
  }
  const failed = resultFailed(outcome.result);
  if (failed) { failure.value = failed; return; }
  notice.value = success;
  void load();
}

function saveScope(next: { group_ids: string[]; private_user_ids: string[] }): void {
  void run('save-runtime-filters', next, '白名单已保存并即时生效。');
}

function resetScope(): void {
  void run('reset-runtime-config', {}, '已恢复宿主配置中的白名单。');
}

function allow(kind: 'group' | 'private', id: string): void {
  void run('allow-conversation', { kind, id }, '已加入白名单并即时生效。');
}

function saveManaged(value: { enabled: boolean; command?: string; args: string[]; cwd?: string; env_vars: string[] }): void {
  void run('save-managed-process', value, '伴生进程设置已保存；启动或重启后生效。');
}

function selectInstance(value: string): void {
  selectedId.value = value;
}
</script>

<template>
  <main class="page">
    <PageHeader title="OneBot" description="连接、采集范围与伴生进程；名单外的消息会被拦截并记录。">
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
      <label class="label" for="onebot-instance">实例</label>
      <select id="onebot-instance" class="input max-w-72" :value="selectedId" @change="selectInstance((($event.target as HTMLSelectElement).value))">
        <option v-for="item in entries" :key="item.summary.instance_id" :value="item.summary.instance_id">
          {{ item.summary.title }} · {{ item.summary.instance_id }}
        </option>
      </select>
    </div>

    <EmptyState
      v-if="!entries.length && !loading && !error"
      title="该插件尚未登记可读面板"
      description="插件运行时注册面板后，这里会显示连接与采集范围。"
    />

    <template v-if="entry">
      <section class="panel overflow-hidden">
        <header class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 class="text-sm font-semibold">{{ entry.summary.title }}</h2>
            <span class="font-mono text-[11px] text-[var(--faint)]">{{ entry.summary.instance_id }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Chip :tone="entry.view?.status.tone ?? 'unknown'" :label="entry.view?.status.label ?? '读取失败'" />
            <Chip :tone="managed.saved.enabled ? 'idle' : 'unknown'" :label="'伴生进程 · ' + (processLabels[managed.active.state] ?? managed.active.state)" />
          </div>
        </header>

        <div class="grid gap-4 p-4 lg:grid-cols-3">
          <div>
            <p class="label">心跳 RTT</p>
            <p class="mt-0.5 font-mono text-lg font-semibold">{{ rtt }}</p>
          </div>
          <div>
            <p class="label">已接纳 / 重复 / 排队</p>
            <p class="mt-0.5 font-mono text-lg font-semibold tabular-nums">
              {{ text(data.accepted_events, '0') }} / {{ text(data.duplicate_events, '0') }} / {{ text(data.queued_events, '0') }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 lg:justify-end">
            <button type="button" class="btn btn-sm" :disabled="busy" @click="run('reconnect', {}, '已请求重新连接。')">刷新连接</button>
            <button type="button" class="btn btn-sm" :disabled="busy" @click="settingsOpen = true">进程设置</button>
            <button type="button" class="btn btn-sm" :disabled="!managed.logs.length" @click="logsOpen = true">运行日志</button>
          </div>
        </div>

        <div v-if="managed.saved.enabled" class="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-4 py-3">
          <span class="text-[11px] text-[var(--muted)]">伴生进程</span>
          <button type="button" class="btn btn-sm" :disabled="busy || managed.active.state === 'running' || managed.active.state === 'external'" @click="run('start-managed-process', {}, '已请求启动伴生进程。')">启动</button>
          <button type="button" class="btn btn-sm" :disabled="busy || !['running', 'starting', 'unready'].includes(managed.active.state)" @click="run('stop-managed-process', {}, '已请求停止伴生进程。')">停止</button>
          <button type="button" class="btn btn-sm" :disabled="busy || managed.active.state === 'external'" @click="run('restart-managed-process', {}, '已请求重启伴生进程。')">重启</button>
          <span v-if="managed.active.state === 'external'" class="text-[11px] text-[var(--muted)]">端口已有进程，当前为 attach 模式，不托管。</span>
          <span v-else-if="managed.active.state === 'exited' && managed.active.error" class="break-all font-mono text-[11px] text-[var(--bad)]">{{ managed.active.error }}</span>
        </div>

        <div class="border-t border-[var(--line)] p-4">
          <KeyValueList :entries="infoEntries" />
        </div>
      </section>

      <p v-if="runtimeError" class="notice-warn">
        插件私有配置无法读取（{{ runtimeError }}），已回退到宿主配置；保存一次即可覆盖损坏文件。
      </p>

      <ScopeEditor :scope="scope" :busy="busy" @save="saveScope" @reset="resetScope" />
      <InterceptList :items="intercepts" :busy="busy" @allow="allow" />

      <p v-if="notice" class="notice-warn">{{ notice }}</p>
      <p v-if="failure" class="notice-bad">{{ failure }}</p>

      <details class="panel p-4">
        <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">原始面板数据</summary>
        <div class="mt-2">
          <JsonBlock :value="entry.view?.data" :max-height="360" />
        </div>
      </details>
    </template>

    <ProcessDrawer
      v-if="settingsOpen && entry"
      :saved="managed.saved"
      :active="managed.active"
      :busy="busy"
      @close="settingsOpen = false"
      @save="saveManaged"
      @start="run('start-managed-process', {}, '已请求启动伴生进程。')"
      @stop="run('stop-managed-process', {}, '已请求停止伴生进程。')"
      @restart="run('restart-managed-process', {}, '已请求重启伴生进程。')"
    />
    <LogDrawer v-if="logsOpen && entry" :logs="managed.logs" @close="logsOpen = false" />
  </main>
</template>

<style scoped>
.notice-warn,
.notice-bad {
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  font-size: 12px;
  line-height: 1.5;
}

.notice-warn {
  border: 1px solid color-mix(in oklab, var(--warn) 35%, var(--line));
  background: color-mix(in oklab, var(--warn) 8%, var(--surface));
  color: var(--warn);
}

.notice-bad {
  border: 1px solid color-mix(in oklab, var(--bad) 35%, var(--line));
  background: color-mix(in oklab, var(--bad) 8%, var(--surface));
  color: var(--bad);
}
</style>

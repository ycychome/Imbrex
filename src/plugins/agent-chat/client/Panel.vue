<script setup lang="ts">
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, CopyButton, EmptyState, ErrorNotice, JsonBlock, KeyValueList, PageHeader, PanelFrame, RelativeTime, formatDuration, formatFull, usePanels, type KeyValueEntry, type PanelEntry } from '@imbrex/ui-contract/ui';
import Control from './control/Control.vue';

const props = defineProps<{ client: ViewClient }>();

const { entries, error, updatedAt, loading, paused, load, toggle } = usePanels(props.client, 'agent-chat');

const track = [
  { value: 'starting', label: '启动' },
  { value: 'idle', label: '空闲' },
  { value: 'session', label: '会话' },
  { value: 'prompt', label: '本轮' },
  { value: 'checkpoint', label: '检查点' },
];

const phaseLabels: Record<string, string> = {
  starting: '启动中',
  idle: '空闲等待',
  session: '会话就绪',
  prompt: '等待模型',
  checkpoint: '写入检查点',
  error: '错误',
  stopping: '停止中',
  stopped: '已停止',
};

const stateLabels: Record<string, string> = {
  loaded: '已加载',
  missing: '不存在',
  unavailable: '不可用',
};

const piLabels: Record<string, string> = {
  unmanaged: '未托管',
  configured_unverified: '已配置未验证',
  unavailable: '不可用',
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dataOf(entry: PanelEntry): Record<string, unknown> {
  return entry.view?.data ?? {};
}

function textOf(value: unknown, fallback = '—'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null || value === undefined ? fallback : JSON.stringify(value);
}

function errorOf(entry: PanelEntry): string | null {
  const value = dataOf(entry).last_error;
  return typeof value === 'string' && value.length ? value : null;
}

function statusLabel(entry: PanelEntry): string {
  if (!entry.view) return '读取失败';
  return errorOf(entry) ? '错误' : entry.view.status.label;
}

function phaseOf(entry: PanelEntry): string {
  return textOf(dataOf(entry).phase, '未知');
}

function phaseText(entry: PanelEntry): string {
  const phase = phaseOf(entry);
  return phaseLabels[phase] ?? phase;
}

function stateKnown(entry: PanelEntry): boolean {
  return dataOf(entry).state_status !== 'unavailable';
}

function inFlight(entry: PanelEntry): Record<string, unknown> | null {
  return record(dataOf(entry).in_flight);
}

function facts(entry: PanelEntry): KeyValueEntry[] {
  const data = dataOf(entry);
  const known = stateKnown(entry);
  const sessions = record(data.sessions);
  const flight = inFlight(entry);
  return [
    { label: '检查点序号', value: known ? textOf(data.last_seq) : '未知', mono: true },
    {
      label: '本轮耗时',
      value: typeof data.elapsed_ms === 'number' ? formatDuration(data.elapsed_ms) : '未开始',
    },
    { label: '当前输入', value: known ? textOf(flight?.id) : '未知', mono: true },
    { label: '会话数', value: known && sessions ? String(Object.keys(sessions).length) : '未知' },
  ];
}

function sourcesText(value: unknown): string {
  if (!Array.isArray(value) || !value.length) return '—';
  return value.flatMap((item): string[] => {
    if (typeof item === 'string') return [item];
    const source = record(item);
    if (!source) return [];
    if (typeof source.exact === 'string') return [source.exact];
    if (typeof source.prefix === 'string') return [`prefix:${source.prefix}`];
    return [];
  }).join('、') || '—';
}

function environmentText(value: unknown): string {
  if (!Array.isArray(value) || !value.length) return '—';
  return value.flatMap((entry): string[] => {
    const item = record(entry);
    if (!item || typeof item.name !== 'string') return [];
    return [`${item.name}${item.configured === true ? ' 已配置' : ' 未配置'}`];
  }).join('、') || '—';
}

function configurationEntries(entry: PanelEntry): KeyValueEntry[] {
  const configuration = record(dataOf(entry).configuration);
  if (!configuration) return [];
  const list: KeyValueEntry[] = [
    { label: '消费过滤', value: configuration.filter ?? '未配置' },
    { label: '来源前缀', value: textOf(configuration.source_prefix), mono: true },
    {
      label: '最大事件年龄',
      value: typeof configuration.max_event_age_seconds === 'number' ? `${configuration.max_event_age_seconds} 秒` : '—',
    },
    {
      label: '单轮超时',
      value: typeof configuration.turn_timeout_ms === 'number' ? formatDuration(configuration.turn_timeout_ms) : '—',
    },
    { label: '读取授权', value: sourcesText(configuration.reader), mono: true },
    { label: '环境变量', value: environmentText(configuration.agent_environment) },
  ];
  const pi = record(configuration.pi);
  if (pi) {
    list.push({ label: '托管状态', value: piLabels[textOf(pi.status)] ?? textOf(pi.status) });
    const saved = record(pi.saved);
    if (saved) {
      list.push({ label: '已保存模型', value: `${textOf(saved.provider)} / ${textOf(saved.model)}` });
      list.push({
        label: '声明上下文窗口',
        value: typeof saved.context_window === 'number' ? saved.context_window.toLocaleString('zh-CN') : '未声明',
        hint: '本地声明，不代表远端容量',
      });
      list.push({ label: '系统提示词', value: typeof saved.system_prompt === 'string' && saved.system_prompt.length ? '已保存' : '未保存' });
    } else {
      list.push({ label: '已保存配置', value: '不存在' });
    }
  }
  return list;
}
</script>

<template>
  <main class="page">
    <PageHeader title="Agent" description="消费轮次、ACP 会话与托管配置；未取得的信息显示为未知。">
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

    <EmptyState
      v-if="!entries.length && !loading && !error"
      title="该插件尚未登记可读面板"
      description="Agent 运行时注册面板后，这里会显示轮次与配置。"
    />

    <PanelFrame
      v-for="entry in entries"
      :key="entry.summary.instance_id"
      :title="entry.summary.title"
      :instance-id="entry.summary.instance_id"
      :module="entry.summary.module"
      :generation="entry.summary.generation"
      :tone="errorOf(entry) ? 'bad' : entry.view?.status.tone ?? 'unknown'"
      :label="statusLabel(entry)"
    >
      <ErrorNotice v-if="entry.failure" :error="entry.failure" retry @retry="load" />
      <ErrorNotice
        v-else-if="entry.detail?.error"
        :error="entry.detail.error"
        title="面板读取失败"
        :detail="`${entry.detail.error.code}${entry.detail.error.message ? ` — ${entry.detail.error.message}` : ''}`"
      />

      <template v-else-if="entry.view">
        <div
          v-if="errorOf(entry)"
          class="mb-4 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium text-[var(--bad)]">运行时错误</p>
            <CopyButton :value="errorOf(entry) ?? ''" label="复制错误码" />
          </div>
          <p class="mt-1 font-mono text-[12px] leading-relaxed">{{ errorOf(entry) }}</p>
          <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--faint)]">
            读取于 <RelativeTime :value="updatedAt" />；来自面板投影，不代表持久化错误。
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            <template v-for="(step, index) in track" :key="step.value">
              <span v-if="index" class="text-[var(--faint)]">›</span>
              <span :class="phaseOf(entry) === step.value ? 'font-medium text-[var(--accent)]' : 'text-[var(--muted)]'">
                {{ step.label }}
              </span>
            </template>
          </div>
          <Chip v-if="phaseText(entry) !== statusLabel(entry)" :label="phaseText(entry)" />
          <span class="text-[11px] text-[var(--faint)]">状态文件 {{ stateLabels[textOf(dataOf(entry).state_status)] ?? textOf(dataOf(entry).state_status) }}</span>
        </div>

        <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--line)] pt-4 sm:grid-cols-4">
          <div v-for="fact in facts(entry)" :key="fact.label" class="min-w-0">
            <dt class="label">{{ fact.label }}</dt>
            <dd class="mt-0.5 font-mono text-base font-semibold tabular-nums" :class="fact.value === '未知' || fact.value === '未开始' ? 'text-[var(--faint)]' : ''">
              {{ fact.value }}
            </dd>
          </div>
        </dl>

        <p class="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
          模型阶段 {{ textOf(dataOf(entry).model_stage, '未知') }}；未取得模型或工具阶段时不从进程推断。
        </p>

        <Control :client="client" :entry="entry" @reload="load" />

        <details class="mt-4 border-t border-[var(--line)] pt-3">
          <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">配置</summary>
          <div class="mt-2">
            <KeyValueList :entries="configurationEntries(entry)" />
          </div>
        </details>

        <details class="mt-3">
          <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">原始面板数据</summary>
          <div class="mt-2">
            <JsonBlock :value="entry.view.data" :max-height="320" />
          </div>
        </details>
      </template>

      <template v-else-if="entry.detail">
        <p class="mb-2 text-xs text-[var(--muted)]">该面板未使用声明式格式，显示原始数据。</p>
        <JsonBlock :value="entry.detail.data" :max-height="320" />
      </template>

      <p v-else class="text-[13px] text-[var(--muted)]">面板暂无可读数据。</p>
    </PanelFrame>
  </main>
</template>

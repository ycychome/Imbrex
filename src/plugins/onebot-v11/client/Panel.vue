<script setup lang="ts">
import type { AdminClient } from '../../../../ui-contract/src/client-api.js';
import EmptyState from '../../../../ui-contract/src/ui/EmptyState.vue';
import ErrorNotice from '../../../../ui-contract/src/ui/ErrorNotice.vue';
import JsonBlock from '../../../../ui-contract/src/ui/JsonBlock.vue';
import KeyValueList from '../../../../ui-contract/src/ui/KeyValueList.vue';
import PageHeader from '../../../../ui-contract/src/ui/PageHeader.vue';
import PanelFrame from '../../../../ui-contract/src/ui/PanelFrame.vue';
import RelativeTime from '../../../../ui-contract/src/ui/RelativeTime.vue';
import { formatDateTime, formatFull, formatReading } from '../../../../ui-contract/src/ui/format.js';
import { usePanels, type PanelEntry } from '../../../../ui-contract/src/ui/panels.js';
import type { KeyValueEntry } from '../../../../ui-contract/src/ui/types.js';

const props = defineProps<{ client: AdminClient }>();

const { entries, error, updatedAt, loading, paused, load, toggle } = usePanels(props.client, 'onebot-v11');

function dataOf(entry: PanelEntry): Record<string, unknown> {
  return entry.view?.data ?? {};
}

function metricOf(entry: PanelEntry, label: string): string {
  return entry.view?.metrics.find((metric) => metric.label === label)?.value ?? '—';
}

function textOf(value: unknown, fallback = '—'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null || value === undefined ? fallback : JSON.stringify(value);
}

function yesNo(value: unknown): string {
  return value === true ? '是' : value === false ? '否' : '未知';
}

function heartbeat(entry: PanelEntry): string {
  const metrics = dataOf(entry).connection_metrics;
  if (typeof metrics !== 'object' || metrics === null) return '未提供';
  const rtt = (metrics as Record<string, unknown>).heartbeat_rtt_ms;
  return typeof rtt === 'number' ? formatReading(rtt, '毫秒') : '未提供';
}

function detailEntries(entry: PanelEntry): KeyValueEntry[] {
  const data = dataOf(entry);
  const lastError = data.last_error;
  return [
    { label: '当前连接', value: yesNo(data.connected) },
    { label: '账号已核验', value: yesNo(data.account_verified) },
    { label: '身份命名空间', value: textOf(data.identity_namespace), mono: true },
    { label: '本次启动', value: formatFull(textOf(data.started_at, '')), mono: true },
    {
      label: '最近错误',
      value: lastError === null || lastError === undefined ? '无' : textOf(lastError),
      mono: true,
    },
  ];
}

const counters = ['已接纳事件', '重复事件', '排队事件', '接收帧', '已发请求'];
</script>

<template>
  <main class="page">
    <PageHeader title="OneBot" description="当前连接、账号核验与收发指标；未测得的读数显示为未提供。">
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
      description="插件运行时注册面板后，这里会显示连接与收发指标。"
    />

    <PanelFrame
      v-for="entry in entries"
      :key="entry.summary.instance_id"
      :title="entry.summary.title"
      :instance-id="entry.summary.instance_id"
      :module="entry.summary.module"
      :generation="entry.summary.generation"
      :tone="entry.view?.status.tone ?? 'unknown'"
      :label="entry.view?.status.label ?? '读取失败'"
    >
      <ErrorNotice v-if="entry.failure" :error="entry.failure" retry @retry="load" />
      <ErrorNotice
        v-else-if="entry.detail?.error"
        :error="entry.detail.error"
        title="面板读取失败"
        :detail="`${entry.detail.error.code}${entry.detail.error.message ? ` — ${entry.detail.error.message}` : ''}`"
      />

      <template v-else-if="entry.view">
        <div class="grid gap-4 sm:grid-cols-3">
          <div class="min-w-0">
            <p class="label">账号</p>
            <p class="mt-0.5 font-mono text-lg font-semibold leading-tight">{{ textOf(dataOf(entry).account_id) }}</p>
          </div>
          <div class="min-w-0">
            <p class="label">心跳 RTT</p>
            <p class="mt-0.5 font-mono text-lg font-semibold leading-tight">{{ heartbeat(entry) }}</p>
            <p class="mt-0.5 text-[11px] text-[var(--faint)]">未测得时为未提供，不用 0 伪装正常</p>
          </div>
          <div class="min-w-0">
            <p class="label">本次启动</p>
            <p class="mt-0.5 text-lg font-semibold leading-tight">
              <RelativeTime :value="textOf(dataOf(entry).started_at, '')" />
            </p>
            <p class="mt-0.5 font-mono text-[11px] text-[var(--faint)]">{{ formatDateTime(textOf(dataOf(entry).started_at, '')) }}</p>
          </div>
        </div>

        <div class="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--line)] pt-4 sm:grid-cols-5">
          <div v-for="label in counters" :key="label" class="min-w-0">
            <p class="label">{{ label }}</p>
            <p class="mt-0.5 font-mono text-base font-semibold tabular-nums">{{ metricOf(entry, label) }}</p>
          </div>
        </div>

        <div class="mt-5 border-t border-[var(--line)] pt-2">
          <KeyValueList :entries="detailEntries(entry)" />
        </div>

        <details class="mt-3">
          <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">原始面板数据</summary>
          <div class="mt-2">
            <JsonBlock :value="entry.view.data" :max-height="280" />
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

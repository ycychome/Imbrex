<script setup lang="ts">
import type { ViewClient } from '@imbrex/ui-contract';
import { EmptyState, ErrorNotice, JsonBlock, KeyValueList, PageHeader, PanelFrame, RelativeTime, Stat, usePanels, type KeyValueEntry, type PanelEntry } from '@imbrex/ui-contract/ui';

const props = defineProps<{ client: ViewClient }>();
const { entries, error, updatedAt, loading, paused, load, toggle } = usePanels(props.client, 'memory');

function details(entry: PanelEntry): KeyValueEntry[] {
  const data = entry.view?.data ?? {};
  const raw = data.configuration;
  const config = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return [
    { label: '状态数据', value: data.state_status === 'loaded' ? '已加载' : '未提供' },
    { label: '服务就绪', value: data.service_ready },
    { label: '索引已暂停', value: data.paused },
    { label: '最近原因', value: data.last_error ?? '无', mono: true },
    { label: '索引代次', value: data.index_generation, mono: true },
    { label: '文本处理中', value: data.processing },
    { label: '图片处理中', value: data.images_processing },
    { label: '授权索引会话', value: config.sources },
    { label: '服务凭据引用', value: config.credential },
    { label: '请求超时（毫秒）', value: config.request_timeout_ms },
    { label: '轮询间隔（毫秒）', value: config.poll_ms },
    { label: '批处理等待（毫秒）', value: config.batch_wait_ms },
  ];
}
</script>

<template>
  <main class="page">
    <PageHeader title="长期记忆" description="查看索引位置、任务与图片处理状态。刷新读取本地运行快照，不调用模型。">
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
    <EmptyState v-if="!entries.length && !loading && !error" title="尚无已登记的记忆面板" description="启用 Memory 实例后，这里显示各实例的索引与任务状态。" />

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
      <ErrorNotice v-else-if="entry.detail?.error" :error="entry.detail.error" title="面板读取失败" />
      <template v-else-if="entry.view">
        <div class="grid gap-px overflow-hidden rounded border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
          <div v-for="metric in entry.view.metrics" :key="metric.label" class="bg-[var(--surface)]">
            <Stat :label="metric.label" :value="metric.value" :hint="metric.hint" mono />
          </div>
        </div>
        <div class="mt-4"><KeyValueList :entries="details(entry)" /></div>
        <details v-if="entry.view.data.operation_failure_count || entry.view.data.image_failure_count" class="mt-4">
          <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">失败任务（文本与图片各展示最多 8 项）</summary>
          <div class="mt-2">
            <JsonBlock :value="{ operations: entry.view.data.operation_failures, images: entry.view.data.image_failures }" />
          </div>
        </details>
      </template>
    </PanelFrame>
  </main>
</template>

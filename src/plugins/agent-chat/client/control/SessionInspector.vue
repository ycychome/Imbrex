<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelSummary } from '@imbrex/ui-contract/ui';
import { Chip, CopyButton } from '@imbrex/ui-contract/ui';
import { byteLength, managementOf, operate, record, resultMessage, text } from './operate';

const props = defineProps<{ client: ViewClient; summary: PanelSummary; storeId: string; data: Record<string, unknown>; source: string }>();
const emit = defineEmits<{ reload: []; close: [] }>();

const management = computed(() => managementOf(props.data));
const sessions = computed(() => record(props.data.sessions) ?? {});
const session = computed(() => text(sessions.value[props.source]));
const inFlight = computed(() => record(props.data.in_flight));
const active = computed(() => inFlight.value?.source === props.source);
const model = computed(() => text(record(management.value?.observed_models)?.[props.source], '未提供'));
const usage = computed(() => {
  const value = record(management.value?.observed_usage)?.[props.source];
  const item = record(value);
  return item && typeof item.used === 'number' && typeof item.size === 'number' ? { used: item.used, size: item.size } : null;
});

const reason = ref('');
const busy = ref(false);
const notice = ref('');
const failure = ref('');

async function reset(): Promise<void> {
  if (!session.value || busy.value) return;
  const value = reason.value.trim();
  if (!value || byteLength(value) > 2048) { failure.value = '原因必填，最多 2048 字节。'; return; }
  busy.value = true; failure.value = ''; notice.value = '';
  const outcome = await operate(props.client, props.summary, props.storeId, 'reset-session', {
    source: props.source, session_id: session.value, reason: value,
  });
  busy.value = false;
  if (!outcome.ok) { failure.value = outcome.message; if (outcome.status === 409) emit('reload'); return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  reason.value = '';
  notice.value = '已解除该会话映射；Agent 历史与其他会话保留。';
  emit('reload');
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="label">会话详情</p>
        <p class="mt-0.5 break-all font-mono text-[11px]">{{ source }}</p>
      </div>
      <div class="flex items-center gap-1">
        <Chip :tone="active ? 'warn' : 'idle'" :label="active ? '本轮进行中' : '空闲'" />
        <button type="button" class="btn btn-sm btn-icon btn-quiet" aria-label="关闭详情" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="rounded-[var(--radius)] border border-[var(--line)] px-3 py-2">
      <div class="flex items-center justify-between gap-2">
        <span class="label">ACP 会话</span>
        <div class="flex items-center gap-1">
          <span class="max-w-52 truncate font-mono text-[11px]" :title="session">{{ session || '—' }}</span>
          <CopyButton v-if="session" :value="session" label="复制" />
        </div>
      </div>
      <div class="mt-2 flex items-center justify-between gap-2">
        <span class="label">观察模型</span>
        <span class="max-w-52 truncate font-mono text-[11px]" :title="model">{{ model }}</span>
      </div>
      <div class="mt-2 flex items-center justify-between gap-2">
        <span class="label">上下文 usage</span>
        <span class="font-mono text-[11px]">{{ usage ? `${usage.used.toLocaleString('zh-CN')} / ${usage.size.toLocaleString('zh-CN')}` : '未提供' }}</span>
      </div>
    </div>

    <div class="rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_30%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_5%,var(--surface))] px-3 py-2">
      <p class="text-[11px] font-medium">重置该会话</p>
      <p class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        解除平台会话与 ACP 会话的映射，下一条消息会新建会话；不删除 Agent 历史。活跃或有未决项的会话会被服务端拒绝。
      </p>
      <input v-model="reason" class="input mt-2 font-mono text-[12px]" placeholder="原因（必填，写入私有恢复记录）" aria-label="重置原因" :disabled="busy || active" />
      <button type="button" class="btn btn-sm btn-danger mt-2" :disabled="busy || active || !session" @click="reset">
        {{ busy ? '重置中…' : '确认重置会话' }}
      </button>
      <p v-if="active" class="mt-1 text-[11px] text-[var(--warn)]">该会话本轮仍在处理中，结束后才能重置。</p>
    </div>

    <p v-if="notice" class="rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--warn)_35%,var(--line))] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed">{{ notice }}</p>
    <p v-if="failure" class="rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">{{ failure }}</p>
  </div>
</template>

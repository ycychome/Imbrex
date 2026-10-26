<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelSummary } from '@imbrex/ui-contract/ui';
import { managementOf, operate, resultMessage } from './operate';

const props = defineProps<{ client: ViewClient; summary: PanelSummary; storeId: string; data: Record<string, unknown> }>();
const emit = defineEmits<{ reload: [] }>();

const management = computed(() => managementOf(props.data));
const value = ref('120000');
const busy = ref(false);
const notice = ref('');
const failure = ref('');
const conflict = ref(false);
let noticeTimer: number | undefined;
onUnmounted(() => window.clearTimeout(noticeTimer));

function sync(): void {
  value.value = String(management.value?.timeout_ms ?? 120000);
  conflict.value = false;
}

sync();
watch(() => management.value?.timeout_ms, (next, previous) => {
  if (Number(value.value) !== (previous ?? 120000) && Number(value.value) !== next) conflict.value = true;
  else sync();
});

const valid = computed(() => /^[1-9][0-9]*$/.test(value.value) && Number(value.value) >= 10 && Number(value.value) <= 600000);
const dirty = computed(() => Number(value.value) !== (management.value?.timeout_ms ?? 120000));

function flash(text: string): void {
  notice.value = text;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { if (notice.value === text) notice.value = ''; }, 12000);
}

async function save(): Promise<void> {
  if (!management.value || !valid.value || busy.value) return;
  busy.value = true; notice.value = ''; failure.value = '';
  const outcome = await operate(props.client, props.summary, props.storeId, 'save-runtime-settings', {
    revision: management.value.revision,
    turn_timeout_ms: Number(value.value),
  });
  busy.value = false;
  if (!outcome.ok) { failure.value = outcome.message; if (outcome.status === 409) emit('reload'); return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  conflict.value = false;
  flash('已保存并即时生效；只影响之后开始的轮次。');
  emit('reload');
}
</script>

<template>
  <section class="panel p-4">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <h5 class="text-xs font-semibold">单轮超时</h5>
        <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
          提交 prompt 后的等待上限；保存后立即生效，不需要重启 Agent。当前进行中的轮次仍使用旧值。
        </p>
      </div>
    </div>

    <div class="mt-3 flex flex-wrap items-end gap-3">
      <label class="flex min-w-0 flex-col gap-1">
        <span class="label">毫秒（10–600000）</span>
        <input v-model="value" inputmode="numeric" class="input w-40 font-mono text-[12px]" :disabled="busy" />
      </label>
      <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !valid || !dirty" @click="save">
        {{ busy ? '保存中…' : conflict ? '确认覆盖保存' : '保存超时' }}
      </button>
      <span v-if="!valid" class="text-[11px] text-[var(--bad)]">超时必须是 10–600000 的整数。</span>
      <span v-else-if="dirty" class="text-[11px] text-[var(--warn)]">有未保存的修改</span>
    </div>

    <p v-if="conflict" role="alert" class="mt-2 text-[11px] text-[var(--warn)]">
      已保存超时被其他操作修改，编辑已保留；确认覆盖保存将替换最新值。
      <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="sync">采用已保存值</button>
    </p>

    <p v-if="notice" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--warn)_35%,var(--line))] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed">{{ notice }}</p>
    <p v-if="failure" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">{{ failure }}</p>
  </section>
</template>

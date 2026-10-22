<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelSummary } from '@imbrex/ui-contract/ui';
import { Chip } from '@imbrex/ui-contract/ui';
import { formatIds, idsText, managementOf, operate, parseIds, resultMessage, type Management } from './operate';

const props = defineProps<{ client: ViewClient; summary: PanelSummary; storeId: string; data: Record<string, unknown> }>();
const emit = defineEmits<{ reload: [] }>();

const management = computed<Management | null>(() => managementOf(props.data));
const groups = ref('');
const privates = ref('');
const busy = ref(false);
const notice = ref('');
const failure = ref('');

function sync(): void {
  const filter = management.value?.filter.saved ?? null;
  groups.value = idsText(filter, 'group_ids');
  privates.value = idsText(filter, 'private_user_ids');
}

sync();
watch(() => management.value?.revision, sync);

const parsedGroups = computed(() => parseIds(groups.value));
const parsedPrivates = computed(() => parseIds(privates.value));
const invalid = computed(() => parsedGroups.value === null || parsedPrivates.value === null);

const dirty = computed(() => {
  const saved = management.value?.filter.saved ?? null;
  if (invalid.value) return true;
  const current = JSON.stringify({ groups: parsedGroups.value, privates: parsedPrivates.value });
  return current !== JSON.stringify({ groups: saved?.group_ids ?? [], privates: saved?.private_user_ids ?? [] });
});

const applied = computed(() => management.value?.filter.applied ?? null);
const savedFilter = computed(() => management.value?.filter.saved ?? null);
const pending = computed(() => management.value?.filter_status === 'pending');
const canSave = computed(() => Boolean(management.value) && !busy.value && dirty.value && !invalid.value);

const statusTone = computed(() => (pending.value ? 'warn' : applied.value ? 'ok' : 'idle'));
const statusLabel = computed(() => (pending.value ? '待应用' : applied.value ? '已应用' : '未配置（全部放行）'));

function flash(value: string): void {
  notice.value = value;
  window.setTimeout(() => { if (notice.value === value) notice.value = ''; }, 12000);
}

async function save(): Promise<void> {
  if (!management.value || parsedGroups.value === null || parsedPrivates.value === null || busy.value) return;
  busy.value = true;
  notice.value = '';
  failure.value = '';
  const outcome = await operate(props.client, props.summary, props.storeId, 'save-filter', {
    revision: management.value.revision,
    filter: { group_ids: parsedGroups.value, private_user_ids: parsedPrivates.value },
  });
  busy.value = false;
  if (!outcome.ok) { failure.value = outcome.message; return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  flash(pending.value
    ? '已保存；已有一个待应用版本，当前轮结束并保存检查点后生效。'
    : '已保存；当前轮继续使用旧规则，检查点保存后生效。异常未决时只保存、不应用。');
  emit('reload');
}
</script>

<template>
  <section class="mt-5 border-t border-[var(--line)] pt-4">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <h5 class="text-xs font-semibold">触发过滤</h5>
        <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
          只决定 Consumer 是否触发；不扩大 OneBot 采集范围或 Principal 授权。
        </p>
      </div>
      <Chip :tone="statusTone" :label="statusLabel" />
    </div>

    <dl class="mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
      <div class="min-w-0">
        <dt class="label">已应用群名单</dt>
        <dd class="mono mt-0.5 break-all text-[11px]">{{ applied ? formatIds(applied.group_ids) : '未配置（全部放行）' }}</dd>
      </div>
      <div class="min-w-0">
        <dt class="label">已应用私聊名单</dt>
        <dd class="mono mt-0.5 break-all text-[11px]">{{ applied ? formatIds(applied.private_user_ids) : '未配置（全部放行）' }}</dd>
      </div>
    </dl>

    <p v-if="pending && savedFilter" class="mt-2 text-[11px] leading-relaxed text-[var(--warn)]">
      待应用：群 {{ formatIds(savedFilter.group_ids) }}；私聊 {{ formatIds(savedFilter.private_user_ids) }}
    </p>

    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <label class="flex min-w-0 flex-col gap-1">
        <span class="label">群 ID（每行一个）</span>
        <textarea v-model="groups" class="input h-auto py-2 font-mono text-[12px]" rows="3" :disabled="busy" spellcheck="false" />
      </label>
      <label class="flex min-w-0 flex-col gap-1">
        <span class="label">私聊用户 ID（每行一个）</span>
        <textarea v-model="privates" class="input h-auto py-2 font-mono text-[12px]" rows="3" :disabled="busy" spellcheck="false" />
      </label>
    </div>
    <p class="mt-1 text-[11px] leading-relaxed text-[var(--faint)]">
      规范正十进制 ID，最多 1000 个；留空表示该类型全部不放行。不能在线恢复为“无限制”。
    </p>

    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <button type="button" class="btn btn-sm btn-primary" :disabled="!canSave" @click="save">
        {{ busy ? '保存中…' : '保存过滤' }}
      </button>
      <span v-if="invalid" class="text-[11px] text-[var(--bad)]">ID 必须是规范正整数，每行一个。</span>
      <span v-else-if="dirty" class="text-[11px] text-[var(--muted)]">有未保存的修改</span>
    </div>

    <p v-if="notice" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--warn)_35%,var(--line))] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed">
      {{ notice }}
    </p>
    <p v-if="failure" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">
      {{ failure }}
    </p>
  </section>
</template>

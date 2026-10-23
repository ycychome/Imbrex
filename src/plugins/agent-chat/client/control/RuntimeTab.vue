<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelEntry } from '@imbrex/ui-contract/ui';
import { Chip } from '@imbrex/ui-contract/ui';
import { actionOf, byteLength, operate, record, resultMessage, text } from './operate';

const props = defineProps<{ client: ViewClient; entry: PanelEntry; selected: string }>();
const emit = defineEmits<{ reload: []; select: [source: string] }>();

const summary = computed(() => props.entry.summary);
const data = computed(() => props.entry.view?.data ?? {});
const storeId = computed(() => text(data.value.store_id));
const status = computed(() => text(data.value.status, 'unknown'));
const suspended = computed(() => status.value === 'suspended_in_flight');
const inFlight = computed(() => record(data.value.in_flight));
const sessions = computed(() => Object.entries(record(data.value.sessions) ?? {}).flatMap(([source, session]) => typeof session === 'string' ? [{ source, session }] : []));
const stateKnown = computed(() => data.value.state_status !== 'unavailable');

const disposition = ref<'' | 'processed' | 'abandoned'>('');
const reason = ref('');
const busy = ref(false);
const notice = ref('');
const failure = ref('');

function flash(value: string): void {
  notice.value = value;
  window.setTimeout(() => { if (notice.value === value) notice.value = ''; }, 12000);
}

function begin(value: 'processed' | 'abandoned'): void {
  disposition.value = value;
  reason.value = '';
  notice.value = '';
  failure.value = '';
}

async function recover(): Promise<void> {
  const pending = inFlight.value;
  if (!pending || !disposition.value || busy.value) return;
  const value = reason.value.trim();
  if (!value || byteLength(value) > 2048) { failure.value = '原因必填，最多 2048 字节。'; return; }
  busy.value = true; failure.value = ''; notice.value = '';
  const outcome = await operate(props.client, summary.value, storeId.value, 'recover-input', {
    seq: text(pending.seq), source: text(pending.source), id: text(pending.id), disposition: disposition.value, reason: value,
  });
  busy.value = false;
  if (!outcome.ok) { failure.value = outcome.message; if (outcome.status === 409) emit('reload'); return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  disposition.value = '';
  flash('已处置 seq ' + text(outcome.result.resolved_seq, '?') + '（' + text(outcome.result.disposition) + '）；'
    + (outcome.result.resumed === true ? '消费已恢复。' : '消费未自动恢复，请核对面板状态。')
    + ' 原 calls 未被改写。');
  emit('reload');
}

function short(value: string): string {
  return value.length > 22 ? value.slice(0, 10) + '…' + value.slice(-8) : value;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <section class="panel p-4">
      <div class="grid gap-4 sm:grid-cols-4">
        <div>
          <p class="label">状态</p>
          <p class="mt-0.5 text-sm font-semibold">{{ text(data.status, '未知') }}</p>
        </div>
        <div>
          <p class="label">检查点序号</p>
          <p class="mt-0.5 font-mono text-sm font-semibold tabular-nums">{{ stateKnown ? text(data.last_seq, '—') : '未知' }}</p>
        </div>
        <div>
          <p class="label">本轮耗时</p>
          <p class="mt-0.5 font-mono text-sm font-semibold tabular-nums">{{ typeof data.elapsed_ms === 'number' ? `${data.elapsed_ms} ms` : '未开始' }}</p>
        </div>
        <div>
          <p class="label">会话数</p>
          <p class="mt-0.5 font-mono text-sm font-semibold tabular-nums">{{ stateKnown ? sessions.length : '未知' }}</p>
        </div>
      </div>
    </section>

    <section class="panel p-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h5 class="text-xs font-semibold">未决输入</h5>
          <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">只在异常暂停时可用；服务端会核对 seq/source/id。</p>
        </div>
        <Chip :tone="!stateKnown ? 'unknown' : inFlight ? (suspended ? 'bad' : 'warn') : 'idle'" :label="!stateKnown ? '未知' : inFlight ? (suspended ? '未决暂停' : '处理中') : '无未决'" />
      </div>

      <p v-if="!stateKnown" class="mt-3 text-[12px] text-[var(--muted)]">状态不可验证，未决输入未知；不要据此认为没有未决项。</p>
      <div v-else-if="inFlight" class="mt-3 rounded-[var(--radius)] border border-[var(--line-strong)] px-3 py-2">
        <p class="font-mono text-[11px]">{{ text(inFlight.id) }} · seq {{ text(inFlight.seq) }}</p>
        <p class="mt-0.5 break-all font-mono text-[11px] text-[var(--muted)]">{{ text(inFlight.source) }}</p>
        <p v-if="inFlight.session_id" class="mt-0.5 font-mono text-[11px] text-[var(--faint)]">ACP 会话 {{ text(inFlight.session_id) }}</p>
        <div v-if="suspended" class="mt-2 flex flex-wrap gap-2">
          <button type="button" class="btn btn-sm" :disabled="busy" @click="begin('processed')">确认处理</button>
          <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="begin('abandoned')">放弃输入</button>
        </div>
        <p v-else class="mt-1 text-[11px] text-[var(--muted)]">该输入正在处理中；未暂停时不能处置。</p>
      </div>
      <p v-else class="mt-3 text-[12px] text-[var(--muted)]">当前没有未决输入。</p>

      <div v-if="disposition" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_35%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_6%,var(--surface))] px-3 py-2">
        <p class="text-[11px] font-medium">{{ disposition === 'processed' ? '确认该输入已处理完成' : '放弃该输入的自动处理责任' }}</p>
        <p class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
          {{ disposition === 'processed' ? '推进检查点并清除未决标记；不会修改 calls 的结果含义。' : '结束该输入的自动处理责任；不撤销已经发出的动作，unknown 保持原值。' }}
        </p>
        <input v-model="reason" class="input mt-2 font-mono text-[12px]" placeholder="原因（写入私有恢复记录，必填）" aria-label="处置原因" :disabled="busy" />
        <div class="mt-2 flex flex-wrap gap-2">
          <button type="button" class="btn btn-sm" :class="disposition === 'abandoned' ? 'btn-danger' : 'btn-primary'" :disabled="busy" @click="recover">{{ busy ? '处置中…' : '确认' }}</button>
          <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="disposition = ''">取消</button>
        </div>
      </div>
    </section>

    <section class="panel overflow-hidden">
      <div class="border-b border-[var(--line)] px-4 py-3">
        <h5 class="text-xs font-semibold">活动会话</h5>
        <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">选中一行查看模型与 usage，并在右侧检查器里重置会话。</p>
      </div>
      <p v-if="!stateKnown" class="px-4 py-4 text-[12px] text-[var(--muted)]">状态不可验证，会话映射未知。</p>
      <p v-else-if="!sessions.length" class="px-4 py-4 text-[12px] text-[var(--muted)]">暂无已建立的会话映射。</p>
      <ul v-else class="divide-y divide-[var(--line)]">
        <li v-for="item in sessions" :key="item.source">
          <button
            type="button"
            class="row-link flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-left"
            :aria-current="selected === item.source ? 'true' : undefined"
            @click="emit('select', item.source)"
          >
            <span class="min-w-0">
              <span class="block break-all font-mono text-[11px]">{{ item.source }}</span>
              <span class="mt-0.5 block font-mono text-[11px] text-[var(--faint)]">ACP {{ short(item.session) }}</span>
            </span>
            <Chip :tone="inFlight?.source === item.source ? 'warn' : 'idle'" :label="inFlight?.source === item.source ? '本轮进行中' : '空闲'" />
          </button>
        </li>
      </ul>
    </section>

    <p v-if="notice" class="rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--warn)_35%,var(--line))] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed">{{ notice }}</p>
    <p v-if="failure" class="rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">{{ failure }}</p>
  </div>
</template>

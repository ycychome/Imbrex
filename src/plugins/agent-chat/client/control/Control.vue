<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelEntry } from '@imbrex/ui-contract/ui';
import { Chip } from '@imbrex/ui-contract/ui';
import { actionOf, byteLength, managementOf, operate, record, resultMessage, text } from './operate';
import FilterForm from './FilterForm.vue';
import AgentForm from './AgentForm.vue';

const props = defineProps<{ client: ViewClient; entry: PanelEntry }>();
const emit = defineEmits<{ reload: [] }>();

const summary = computed(() => props.entry.summary);
const data = computed(() => props.entry.view?.data ?? {});
const storeId = computed(() => text(data.value.store_id));
const management = computed(() => managementOf(data.value));
const status = computed(() => text(data.value.status, 'unknown'));
const inFlight = computed(() => record(data.value.in_flight));
const sessions = computed(() => Object.entries(record(data.value.sessions) ?? {}).flatMap(([source, session]) => typeof session === 'string' ? [{ source, session }] : []));
const stopped = computed(() => status.value === 'stopped_or_error');
const suspended = computed(() => status.value === 'suspended_in_flight');
const stateKnown = computed(() => data.value.state_status !== 'unavailable');

const hasRecover = computed(() => actionOf(summary.value, 'recover-input'));
const hasReset = computed(() => actionOf(summary.value, 'reset-session'));
const hasFilter = computed(() => actionOf(summary.value, 'save-filter'));
const hasAgent = computed(() => actionOf(summary.value, 'save-agent-config'));

const disposition = ref<'' | 'processed' | 'abandoned'>('');
const reason = ref('');
const busy = ref(false);
const notice = ref('');
const failure = ref('');

const resetSource = ref('');
const resetSession = ref('');
const resetReason = ref('');
const resetting = ref(false);

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
  if (!outcome.ok) { failure.value = outcome.message; return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  disposition.value = '';
  flash('已处置 seq ' + text(outcome.result.resolved_seq, '?') + '（' + text(outcome.result.disposition) + '）；'
    + (outcome.result.resumed === true ? '消费已恢复。' : '消费未自动恢复，请核对面板状态。')
    + ' 原 calls 未被改写。');
  emit('reload');
}

function beginReset(source: string, session: string): void {
  resetSource.value = source;
  resetSession.value = session;
  resetReason.value = '';
  notice.value = '';
  failure.value = '';
}

async function reset(): Promise<void> {
  if (!resetSource.value || resetting.value) return;
  const value = resetReason.value.trim();
  if (!value || byteLength(value) > 2048) { failure.value = '原因必填，最多 2048 字节。'; return; }
  resetting.value = true; failure.value = ''; notice.value = '';
  const outcome = await operate(props.client, summary.value, storeId.value, 'reset-session', {
    source: resetSource.value, session_id: resetSession.value, reason: value,
  });
  resetting.value = false;
  if (!outcome.ok) { failure.value = outcome.message; return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  resetSource.value = '';
  flash('已解除该会话映射；Agent 历史与其他会话保留。');
  emit('reload');
}

function short(value: string): string {
  return value.length > 22 ? value.slice(0, 10) + '…' + value.slice(-8) : value;
}
</script>

<template>
  <div class="mt-5 border-t border-[var(--line)] pt-4">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h4 class="text-xs font-semibold tracking-wide text-[var(--muted)]">控制</h4>
      <span class="font-mono text-[10px] uppercase tracking-wide text-[var(--faint)]">admin:operate</span>
    </div>
    <p v-if="stopped" class="mt-2 rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
      该实例未运行：动作会返回 503，直到实例就绪。已保存的配置仍可读取，但不代表已应用。
    </p>

    <section v-if="hasRecover" class="mt-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h5 class="text-xs font-semibold">未决输入</h5>
          <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
            只在异常暂停时可用；处置对象是当前这一条输入，服务端会核对 seq/source/id。
          </p>
        </div>
        <Chip :tone="!stateKnown ? 'unknown' : inFlight ? (suspended ? 'bad' : 'warn') : 'idle'" :label="!stateKnown ? '未知' : inFlight ? (suspended ? '未决暂停' : '处理中') : '无未决'" />
      </div>

      <p v-if="!stateKnown" class="mt-2 text-[12px] text-[var(--muted)]">状态不可验证，未决输入未知；不要据此认为没有未决项。</p>
      <div v-else-if="inFlight" class="mt-2 rounded-[var(--radius)] border border-[var(--line-strong)] px-3 py-2">
        <p class="font-mono text-[11px] leading-relaxed">
          {{ text(inFlight.id) }} · seq {{ text(inFlight.seq) }}
        </p>
        <p class="mt-0.5 break-all font-mono text-[11px] text-[var(--muted)]">{{ text(inFlight.source) }}</p>
        <p v-if="inFlight.session_id" class="mt-0.5 font-mono text-[11px] text-[var(--faint)]">ACP 会话 {{ text(inFlight.session_id) }}</p>

        <div v-if="suspended" class="mt-2 flex flex-wrap gap-2">
          <button type="button" class="btn btn-sm" :disabled="busy" @click="begin('processed')">确认已处理</button>
          <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="begin('abandoned')">放弃输入</button>
        </div>
        <p v-else class="mt-1 text-[11px] text-[var(--muted)]">该输入正在处理中；未暂停时不能处置。</p>
      </div>
      <p v-else class="mt-2 text-[12px] text-[var(--muted)]">当前没有未决输入。</p>

      <div v-if="disposition" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_35%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_6%,var(--surface))] px-3 py-2">
        <p class="text-[11px] font-medium">
          {{ disposition === 'processed' ? '确认该输入已处理完成' : '放弃该输入的自动处理责任' }}
        </p>
        <p class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
          {{ disposition === 'processed'
            ? '推进检查点并清除未决标记；不会修改 calls 的结果含义。'
            : '结束该输入的自动处理责任；不撤销已经发出的动作，unknown 保持原值。' }}
        </p>
        <input v-model="reason" class="input mt-2 font-mono text-[12px]" placeholder="原因（写入私有恢复记录，必填）" aria-label="处置原因" :disabled="busy" />
        <div class="mt-2 flex flex-wrap gap-2">
          <button type="button" class="btn btn-sm" :class="disposition === 'abandoned' ? 'btn-danger' : 'btn-primary'" :disabled="busy" @click="recover">
            {{ busy ? '处置中…' : '确认' }}
          </button>
          <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="disposition = ''">取消</button>
        </div>
      </div>
    </section>

    <section v-if="hasReset" class="mt-5 border-t border-[var(--line)] pt-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h5 class="text-xs font-semibold">会话</h5>
          <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
            解除平台会话与 ACP 会话的映射；不删除 Agent 历史，也不停止其他会话。
          </p>
        </div>
        <span class="text-[11px] text-[var(--faint)]">{{ stateKnown ? sessions.length + ' 个映射' : '未知' }}</span>
      </div>

      <p v-if="!stateKnown" class="mt-2 text-[12px] text-[var(--muted)]">状态不可验证，会话映射与当前轮次未知。</p>
      <p v-else-if="!sessions.length" class="mt-2 text-[12px] text-[var(--muted)]">暂无已建立的会话映射。</p>
      <ul v-else class="mt-2 divide-y divide-[var(--line)] border-y border-[var(--line)]">
        <li v-for="item in sessions" :key="item.source" class="py-2">
          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div class="min-w-0">
              <p class="break-all font-mono text-[11px]">{{ item.source }}</p>
              <p class="mt-0.5 font-mono text-[11px] text-[var(--faint)]">ACP {{ short(item.session) }}</p>
            </div>
            <div class="flex items-center gap-2">
              <Chip :tone="inFlight?.source === item.source ? 'warn' : 'idle'" :label="inFlight?.source === item.source ? '本轮进行中' : '空闲'" />
              <button type="button" class="btn btn-sm" :disabled="inFlight?.source === item.source || resetting" @click="beginReset(item.source, item.session)">重置</button>
            </div>
          </div>
          <div v-if="resetSource === item.source" class="mt-2">
            <input v-model="resetReason" class="input font-mono text-[12px]" placeholder="原因（必填，写入私有恢复记录）" aria-label="重置原因" :disabled="resetting" />
            <div class="mt-2 flex flex-wrap gap-2">
              <button type="button" class="btn btn-sm btn-danger" :disabled="resetting" @click="reset">{{ resetting ? '重置中…' : '确认重置' }}</button>
              <button type="button" class="btn btn-sm btn-quiet" :disabled="resetting" @click="resetSource = ''">取消</button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <FilterForm v-if="hasFilter && management" :client="client" :summary="summary" :store-id="storeId" :data="data" @reload="emit('reload')" />
    <AgentForm v-if="hasAgent && management" :client="client" :summary="summary" :store-id="storeId" :data="data" @reload="emit('reload')" />
    <p v-if="(hasFilter || hasAgent) && !management" class="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
      消费状态不可验证，配置与动作暂不可用；不要据此认为“没有未决项”或“没有过滤”。
    </p>

    <p v-if="notice" class="mt-3 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--warn)_35%,var(--line))] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed">
      {{ notice }}
    </p>
    <p v-if="failure" class="mt-3 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">
      {{ failure }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, CopyButton, JsonBlock, KeyValueList, Section, failureOf, formatFull, isAbort, type KeyValueEntry, type Tone } from '@imbrex/ui-contract/ui';
import type { AdminCapability, CallStatus, InvocationEnvelope, WireCall } from './types';

const props = defineProps<{
  client: ViewClient;
  storeId: string;
  capabilities: AdminCapability[];
  selected: AdminCapability | null;
}>();
const emit = defineEmits<{ select: [id: string]; invoked: [] }>();

const paramsText = ref('{}');
const callId = ref('');
const error = ref('');
const busy = ref(false);
const confirming = ref(false);
const result = shallowRef<InvocationEnvelope | null>(null);
const lastSubmit = ref<{ params: string; callId: string } | null>(null);

const statusLabels: Record<CallStatus, string> = {
  in_progress: '进行中',
  succeeded: '成功',
  failed: '失败',
  unknown: '未知',
};

const call = computed<WireCall | null>(() => (result.value?.kind === 'call' ? result.value.call ?? null : null));
const statusTone = computed<Tone>(() => {
  switch (call.value?.status) {
    case 'succeeded': return 'ok';
    case 'failed': return 'bad';
    case 'in_progress': return 'warn';
    case 'unknown': return 'unknown';
    default: return 'idle';
  }
});

const entries = computed<KeyValueEntry[]>(() => {
  const value = call.value;
  if (!value) return [];
  return [
    { label: '调用 ID', value: value.call_id, mono: true },
    { label: '能力', value: value.capability_id, mono: true },
    { label: '参数版本', value: value.schema_version, mono: true },
    { label: '创建时间', value: formatFull(value.created_at), mono: true },
    { label: '更新时间', value: formatFull(value.updated_at), mono: true },
  ];
});

function newCallId(): string {
  const suffix = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return 'manual-' + suffix;
}

function choose(event: Event): void {
  emit('select', (event.target as HTMLSelectElement).value);
}

watch(() => props.selected?.id, () => {
  const capability = props.selected;
  result.value = null;
  error.value = '';
  confirming.value = false;
  lastSubmit.value = null;
  paramsText.value = '{}';
  callId.value = capability?.is_side_effectful ? newCallId() : '';
}, { immediate: true });

function messageFor(cause: unknown): string {
  const info = failureOf(cause);
  if (info.status === 0) return '无法连接管理 API；调用结果未知。请重新读取调用审计，不要自动重复。';
  if (info.status === 401) return '登录已失效，请重新连接。';
  if (info.status === 403) return '当前凭据缺少 capabilities:invoke、具体能力或来源授权。';
  if (info.status === 404) return '能力或实例未登记，可能已停止或卸载。';
  if (info.status === 409) return 'store_id 与当前网关不匹配，或同一调用 ID 的参数不同。';
  if (info.status === 429) return '该实例正在执行另一个动作，请稍后重试。';
  if (info.status === 503) return '提供方尚未就绪或已停止，未执行调用。';
  if (info.status === 400) return '参数未通过服务端 Schema 校验。';
  return '调用失败：' + (info.code ?? 'request_failed');
}

async function run(): Promise<void> {
  const capability = props.selected;
  if (!capability || busy.value) return;
  let params: unknown;
  try {
    params = JSON.parse(paramsText.value) as unknown;
  } catch {
    error.value = '参数必须是合法 JSON。';
    return;
  }
  const body: Record<string, unknown> = { store_id: props.storeId, params };
  if (capability.is_side_effectful) {
    const id = callId.value.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      error.value = '外部写需要 1–128 位稳定调用 ID（字母、数字、. _ : -）。';
      return;
    }
    body.call_id = id;
  }
  busy.value = true;
  error.value = '';
  result.value = null;
  lastSubmit.value = capability.is_side_effectful ? { params: paramsText.value, callId: callId.value.trim() } : null;
  try {
    result.value = await props.client.request<InvocationEnvelope>(
      '/api/admin/capabilities/' + encodeURIComponent(capability.id) + '/invoke',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    emit('invoked');
  } catch (cause) {
    if (!isAbort(cause)) error.value = messageFor(cause);
  } finally {
    busy.value = false;
  }
}

function recheck(): void {
  if (!lastSubmit.value || busy.value) return;
  paramsText.value = lastSubmit.value.params;
  callId.value = lastSubmit.value.callId;
  void run();
}

function requestRun(): void {
  if (!props.selected || busy.value) return;
  if (props.selected.is_side_effectful) {
    confirming.value = true;
    return;
  }
  void run();
}

function confirmRun(): void {
  confirming.value = false;
  void run();
}
</script>

<template>
  <Section title="人工能力测试" description="使用当前管理员身份执行；外部写必须保留稳定 call_id，结果未知不会自动重试。">
    <div class="panel flex flex-col gap-4 p-4">
      <label class="flex flex-col gap-1">
        <span class="label">能力</span>
        <select class="input" :value="selected?.id ?? ''" @change="choose">
          <option value="" disabled>选择一项能力</option>
          <option v-for="capability in capabilities" :key="capability.id" :value="capability.id">
            {{ capability.id }} · {{ capability.is_side_effectful ? '外部写' : '只读' }}{{ capability.available ? '' : ' · 不可用' }}
          </option>
        </select>
      </label>

      <template v-if="selected">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-xs">{{ selected.id }}</span>
          <Chip :tone="selected.available ? 'ok' : 'idle'" :label="selected.available ? '提供方在线' : '不可用'" />
          <Chip :tone="selected.is_side_effectful ? 'warn' : 'idle'" :label="selected.is_side_effectful ? '外部写' : '只读'" />
        </div>
        <p class="text-[12px] leading-relaxed text-[var(--muted)]">{{ selected.description }}</p>

        <details class="rounded border border-[var(--line)] px-3 py-2">
          <summary class="cursor-pointer text-xs font-medium text-[var(--muted)]">输入 Schema</summary>
          <div class="mt-2">
            <JsonBlock :value="selected.input_schema" :max-height="220" />
          </div>
        </details>

        <label class="flex flex-col gap-1">
          <span class="label">参数 JSON</span>
          <textarea v-model="paramsText" class="input min-h-40 w-full resize-y font-mono text-xs" spellcheck="false" />
        </label>

        <div v-if="selected.is_side_effectful" class="flex flex-col gap-2">
          <label class="flex flex-col gap-1">
            <span class="label">稳定调用 ID</span>
            <div class="flex items-center gap-2">
              <input v-model="callId" class="input font-mono text-xs" spellcheck="false" />
              <CopyButton :value="callId" label="复制" />
              <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="callId = newCallId()">新 ID</button>
            </div>
          </label>
          <p class="text-[11px] leading-relaxed text-[var(--warn)]">
            结果未知或响应丢失时，保留原调用 ID 与参数复查；不要为新重试悄悄换 ID。新 ID 表示一次新的外部写入意图。
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-primary" :disabled="busy || !selected.available" @click="requestRun">
            {{ busy ? '执行中…' : selected.is_side_effectful ? '执行外部写' : '执行只读调用' }}
          </button>
          <button v-if="lastSubmit" type="button" class="btn" :disabled="busy" @click="recheck">
            用原参数复查
          </button>
        </div>

        <div v-if="confirming" class="notice-warn" role="alertdialog" aria-label="确认外部写">
          <p class="text-[12px] font-medium">确认执行外部写 {{ selected.id }}？</p>
          <p class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
            请核对参数中的目标、引用与影响范围；服务端会再次校验授权与 Schema。确认后使用上方稳定调用 ID。
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="confirmRun">确认执行</button>
            <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="confirming = false">取消</button>
          </div>
        </div>

        <p v-if="error" role="alert" class="notice-bad">{{ error }}</p>

        <template v-if="result">
          <template v-if="result.kind === 'call' && call">
            <div class="flex flex-wrap items-center gap-2">
              <Chip :tone="statusTone" :label="statusLabels[call.status]" />
              <span class="font-mono text-[11px] text-[var(--faint)]">{{ call.call_id }}</span>
            </div>
            <p v-if="call.status === 'unknown'" class="notice-warn">
              调用结果未知，可能已经执行，也可能尚未执行。请按平台事实核验；不要自动重发，也不要改写原调用状态。
            </p>
            <p v-else-if="call.status === 'in_progress'" class="notice-warn">
              调用仍在进行中。保留当前调用 ID，等待或重新读取结果，不要新建同语义调用。
            </p>
            <p v-else-if="call.status === 'failed'" class="notice-warn">
              失败只说明本次未完成；是否需要新调用由操作者按原因与平台证据决定。
            </p>
            <KeyValueList :entries="entries" stacked />
            <div>
              <p class="label mb-1">参数</p>
              <JsonBlock :value="call.params" :max-height="220" />
            </div>
            <div v-if="call.result !== undefined">
              <p class="label mb-1">结果</p>
              <JsonBlock :value="call.result" :max-height="220" />
            </div>
            <div v-if="call.reason">
              <p class="label mb-1">原因</p>
              <JsonBlock :value="call.reason" :max-height="160" />
            </div>
          </template>
          <template v-else-if="result.kind === 'result'">
            <p class="label">只读结果</p>
            <JsonBlock :value="result.result" :max-height="320" />
          </template>
          <p v-else class="notice-bad">响应缺少调用记录或结果。</p>
        </template>
      </template>
      <p v-else class="text-xs text-[var(--muted)]">从上方能力列表选择一项，或在“已登记能力”中点“测试”。</p>
    </div>
  </Section>
</template>

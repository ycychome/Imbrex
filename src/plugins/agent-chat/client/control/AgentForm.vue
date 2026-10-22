<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import type { PanelSummary } from '@imbrex/ui-contract/ui';
import { Chip } from '@imbrex/ui-contract/ui';
import { byteLength, managementOf, operate, record, resultMessage, text, type Management } from './operate';

const props = defineProps<{ client: ViewClient; summary: PanelSummary; storeId: string; data: Record<string, unknown> }>();
const emit = defineEmits<{ reload: [] }>();

const management = computed<Management | null>(() => managementOf(props.data));
const pi = computed(() => management.value?.pi ?? null);
const provider = computed(() => {
  const configuration = record(props.data.configuration);
  const disk = configuration ? record(configuration.pi) : null;
  const saved = disk ? record(disk.saved) : null;
  return saved ? text(saved.provider) : '';
});

const model = ref('');
const window_ = ref('128000');
const prompt = ref('');
const busy = ref(false);
const notice = ref('');
const failure = ref('');
const confirming = ref(false);
const reason = ref('');

function sync(): void {
  const saved = pi.value?.saved;
  model.value = saved?.model ?? '';
  window_.value = saved ? String(saved.context_window) : '128000';
  prompt.value = saved?.system_prompt ?? '';
}

sync();
watch(() => management.value?.revision, sync);

const promptBytes = computed(() => byteLength(prompt.value));
const modelBytes = computed(() => byteLength(model.value.trim()));
const windowValue = computed(() => (/^[1-9][0-9]*$/.test(window_.value) ? Number(window_.value) : Number.NaN));
const valid = computed(() => modelBytes.value > 0 && modelBytes.value <= 256 && Number.isInteger(windowValue.value)
  && windowValue.value >= 1024 && windowValue.value <= 2000000 && promptBytes.value <= 32768);

const saved = computed(() => pi.value?.saved ?? null);
const applied = computed(() => pi.value?.applied ?? null);
const dirty = computed(() => {
  const current = saved.value;
  if (!current) return true;
  return model.value.trim() !== current.model || windowValue.value !== current.context_window || prompt.value !== current.system_prompt;
});
const status = computed(() => management.value?.pi_status ?? 'unmanaged');
const statusLabels: Record<string, string> = {
  unmanaged: '未托管',
  pending_restart: '已保存，待重启生效',
  applying: '正在应用',
  failed: '应用失败',
  stopped_or_error: '已停止',
  awaiting_session: '等待新会话确认',
  applied: '已应用',
};
const statusTones: Record<string, 'ok' | 'warn' | 'bad' | 'idle' | 'unknown'> = {
  unmanaged: 'idle',
  pending_restart: 'warn',
  applying: 'warn',
  failed: 'bad',
  stopped_or_error: 'bad',
  awaiting_session: 'warn',
  applied: 'ok',
};
const statusLabel = computed(() => statusLabels[status.value] ?? status.value);
const statusTone = computed(() => statusTones[status.value] ?? 'unknown');

const inFlight = computed(() => record(props.data.in_flight));
const canRestart = computed(() => Boolean(pi.value) && !inFlight.value && !busy.value && status.value !== 'applying');
const restartHint = computed(() => {
  if (!pi.value) return '该实例未托管 pi；在线编辑需要部署配置 managed_pi。';
  if (inFlight.value) return '存在未决或进行中的输入，不能应用并重启。';
  if (status.value === 'applying') return '上一次应用尚未完成。';
  return '只重启 pi-acp/pi；宿主、HTTP、OneBot 与其他插件保持运行。';
});

const observedModels = computed(() => Object.entries(management.value?.observed_models ?? {}));
const observedUsage = computed(() => Object.entries(management.value?.observed_usage ?? {}));

function short(value: string): string {
  return value.length > 18 ? value.slice(0, 8) + '…' + value.slice(-6) : value;
}

function flash(value: string): void {
  notice.value = value;
  window.setTimeout(() => { if (notice.value === value) notice.value = ''; }, 12000);
}

async function save(): Promise<void> {
  if (!management.value || !valid.value || busy.value) return;
  busy.value = true; notice.value = ''; failure.value = '';
  const outcome = await operate(props.client, props.summary, props.storeId, 'save-agent-config', {
    revision: management.value.revision,
    settings: { model: model.value.trim(), context_window: windowValue.value, system_prompt: prompt.value },
  });
  busy.value = false;
  if (!outcome.ok) { failure.value = outcome.message; return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  flash('已保存为待重启生效；当前轮继续使用旧配置。');
  emit('reload');
}

function beginRestart(): void {
  confirming.value = true;
  reason.value = '';
  notice.value = '';
  failure.value = '';
}

async function restart(): Promise<void> {
  if (!management.value || busy.value) return;
  const value = reason.value.trim();
  if (!value || byteLength(value) > 2048) { failure.value = '原因必填，最多 2048 字节。'; return; }
  busy.value = true; failure.value = ''; notice.value = '';
  const outcome = await operate(props.client, props.summary, props.storeId, 'restart-agent', { revision: management.value.revision, reason: value });
  busy.value = false;
  confirming.value = false;
  if (!outcome.ok) { failure.value = outcome.message; return; }
  if (outcome.result.status !== 'succeeded') { failure.value = resultMessage(outcome); return; }
  const application = text(outcome.result.application_status);
  flash(application === 'applied'
    ? '已重启并确认新模型；后续轮次使用新配置。'
    : '已重启 Agent；模型尚未被实际会话确认（awaiting_session），下一轮会再次核验。');
  emit('reload');
}
</script>

<template>
  <section class="mt-5 border-t border-[var(--line)] pt-4">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <h5 class="text-xs font-semibold">托管 Agent</h5>
        <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
          只修改本实例的托管目录，不触碰用户全局 pi 配置。保存不等于生效。
        </p>
      </div>
      <Chip :tone="statusTone" :label="statusLabel" />
    </div>

    <div v-if="!pi" class="mt-2 rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[12px] text-[var(--muted)]">
      {{ restartHint }}
    </div>

    <template v-else>
      <dl class="mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
        <div class="min-w-0">
          <dt class="label">已保存</dt>
          <dd class="mono mt-0.5 break-all text-[11px]">
            {{ saved?.model ?? '—' }} · {{ saved?.context_window?.toLocaleString('zh-CN') ?? '—' }} · 提示词 {{ saved ? byteLength(saved.system_prompt) : 0 }} B
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="label">已应用</dt>
          <dd class="mono mt-0.5 break-all text-[11px]">
            {{ applied ? `${applied.model} · ${applied.context_window.toLocaleString('zh-CN')}` : '尚未应用' }}
          </dd>
        </div>
      </dl>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="flex min-w-0 flex-col gap-1">
          <span class="label">模型{{ provider ? `（${provider}）` : '' }}</span>
          <input v-model="model" class="input font-mono text-[12px]" :disabled="busy" spellcheck="false" />
        </label>
        <label class="flex min-w-0 flex-col gap-1">
          <span class="label">上下文窗口声明（1024–2000000）</span>
          <input v-model="window_" inputmode="numeric" class="input font-mono text-[12px]" :disabled="busy" />
        </label>
      </div>
      <label class="mt-3 flex flex-col gap-1">
        <span class="label">系统提示词 <span class="text-[var(--faint)]">{{ promptBytes }} / 32768 B</span></span>
        <textarea v-model="prompt" class="input h-auto py-2 font-mono text-[12px] leading-relaxed" rows="4" :disabled="busy" spellcheck="false" />
      </label>
      <p class="mt-1 text-[11px] text-[var(--faint)]">
        窗口与模型是本地声明，不代表远端容量；观察值来自实际 Agent，未取得时显示为未知。
      </p>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !valid || !dirty" @click="save">
          {{ busy ? '处理中…' : '保存配置' }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="!canRestart" @click="beginRestart">应用并重启 Agent</button>
        <span v-if="!valid" class="text-[11px] text-[var(--bad)]">模型、窗口或提示词不符合服务端校验。</span>
        <span v-else-if="dirty" class="text-[11px] text-[var(--warn)]">有未保存的修改</span>
        <span v-else class="text-[11px] text-[var(--faint)]">{{ restartHint }}</span>
      </div>

      <div v-if="confirming" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_35%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_6%,var(--surface))] px-3 py-2">
        <p class="text-[11px] leading-relaxed">
          将应用<b>已保存</b>的模型、窗口与提示词，只重启 pi-acp/pi 并恢复原会话；未保存的编辑不会生效。请填写原因。
        </p>
        <input v-model="reason" class="input mt-2 font-mono text-[12px]" placeholder="原因（写入私有恢复记录）" aria-label="重启原因" :disabled="busy" />
        <div class="mt-2 flex gap-2">
          <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="restart">{{ busy ? '重启中…' : '确认应用并重启' }}</button>
          <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="confirming = false">取消</button>
        </div>
      </div>

      <p v-if="notice" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--warn)_35%,var(--line))] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed">
        {{ notice }}
      </p>
      <p v-if="failure" class="mt-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--bad)_38%,var(--line))] bg-[color-mix(in_oklab,var(--bad)_8%,var(--surface))] px-3 py-2 text-[11px] leading-relaxed text-[var(--bad)]">
        {{ failure }}
      </p>

      <details v-if="observedModels.length || observedUsage.length" class="mt-3">
        <summary class="cursor-pointer text-[11px] font-medium text-[var(--muted)]">运行时观察（本进程）</summary>
        <ul class="mt-1 space-y-1 font-mono text-[11px] text-[var(--muted)]">
          <li v-for="[session, value] in observedModels" :key="'m' + session">
            模型 {{ value }} · 会话 {{ short(session) }}
          </li>
          <li v-for="[session, usage] in observedUsage" :key="'u' + session">
            usage {{ usage.used.toLocaleString('zh-CN') }} / {{ usage.size.toLocaleString('zh-CN') }} · 会话 {{ short(session) }}
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{
  saved: { enabled: boolean; command?: string; args?: string[]; cwd?: string; env_vars?: string[] };
  active: { state: string; pid?: number; exit_code?: number | null; error?: string };
  busy: boolean;
  notice: string;
  failure: string;
  needsRefresh: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [value: { enabled: boolean; command?: string; args: string[]; cwd?: string; env_vars: string[] }];
  start: [];
  stop: [];
  restart: [];
  refresh: [];
}>();

const enabled = ref(false);
const command = ref('');
const argsText = ref('');
const cwd = ref('');
const envText = ref('');
const localError = ref('');
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());

function sync(): void {
  enabled.value = props.saved.enabled;
  command.value = props.saved.command ?? '';
  argsText.value = (props.saved.args ?? []).join('\n');
  cwd.value = props.saved.cwd ?? '';
  envText.value = (props.saved.env_vars ?? []).join(', ');
}

sync();

const stateLabels: Record<string, string> = {
  disabled: '未启用',
  external: '外部进程',
  starting: '启动中',
  running: '运行中',
  unready: '未监听',
  exited: '已退出',
  stopped: '已停止',
};

function save(): void {
  if (props.busy) return;
  localError.value = '';
  if (enabled.value && !command.value.trim()) { localError.value = '启用托管时必须填写 command。'; return; }
  if (enabled.value && !cwd.value.trim()) { localError.value = '启用托管时必须填写 cwd。'; return; }
  emit('save', {
    enabled: enabled.value,
    ...(command.value.trim() ? { command: command.value.trim() } : {}),
    args: argsText.value === (props.saved.args ?? []).join('\n') ? [...(props.saved.args ?? [])] : argsText.value === '' ? [] : argsText.value.split('\n'),
    ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
    env_vars: envText.value.split(/[\s,]+/).filter(Boolean),
  });
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="drawer" aria-labelledby="process-title" @cancel.prevent="emit('close')" @close="emit('close')" @click="($event.target === dialog) && emit('close')">
      <header class="flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <div>
          <h2 id="process-title" class="text-sm font-semibold">伴生进程</h2>
          <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">在本地托管 OneBot 服务端（如 SnowLuma）。进程崩溃不会自动重启。</p>
        </div>
        <button type="button" class="btn btn-sm btn-icon btn-quiet" aria-label="关闭设置" @click="emit('close')">×</button>
      </header>

      <div class="flex-1 overflow-y-auto p-4">
        <div class="rounded-[var(--radius)] border border-[var(--line)] px-3 py-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] text-[var(--muted)]">当前状态</span>
            <span class="font-mono text-[12px]">{{ stateLabels[active.state] ?? active.state }}</span>
          </div>
          <p v-if="active.pid" class="mt-1 font-mono text-[11px] text-[var(--faint)]">pid {{ active.pid }}</p>
          <p v-if="active.exit_code !== undefined && active.exit_code !== null" class="mt-1 font-mono text-[11px] text-[var(--faint)]">exit {{ active.exit_code }}</p>
          <p v-if="active.error" class="mt-1 break-all font-mono text-[11px] text-[var(--bad)]">{{ active.error }}</p>
        </div>

        <label class="mt-4 flex items-center gap-2 text-[12px]">
          <input v-model="enabled" type="checkbox" :disabled="busy" />
          启用伴生进程托管
        </label>

        <label class="mt-3 flex flex-col gap-1">
          <span class="label">command</span>
          <input v-model="command" class="input font-mono text-[12px]" placeholder="例如 /usr/bin/snowluma" :disabled="busy" spellcheck="false" />
        </label>

        <label class="mt-3 flex flex-col gap-1">
          <span class="label">args（每行一个）</span>
          <textarea v-model="argsText" class="input h-auto py-2 font-mono text-[12px]" rows="3" :disabled="busy" spellcheck="false" />
        </label>

        <label class="mt-3 flex flex-col gap-1">
          <span class="label">cwd</span>
          <input v-model="cwd" class="input font-mono text-[12px]" placeholder="绝对路径" :disabled="busy" spellcheck="false" />
        </label>

        <details class="mt-3">
          <summary class="cursor-pointer text-[11px] font-medium text-[var(--muted)]">继承的环境变量（高级）</summary>
          <label class="mt-2 flex flex-col gap-1">
            <span class="label">变量名，逗号分隔</span>
            <input v-model="envText" class="input font-mono text-[12px]" placeholder="例如 SNOWLUMA_HOOK_ONLY_PID" :disabled="busy" spellcheck="false" />
          </label>
          <p class="mt-1 text-[11px] leading-relaxed text-[var(--faint)]">只传递宿主环境中的变量名，不在这里保存值。</p>
        </details>

        <p v-if="localError || failure" role="alert" class="mt-2 text-[11px] text-[var(--bad)]">{{ localError || failure }}</p>
        <p v-if="notice" role="status" class="mt-2 text-[11px] text-[var(--muted)]">{{ notice }}</p>
        <button v-if="needsRefresh" type="button" class="btn btn-sm mt-2" @click="emit('refresh')">刷新并核对面板</button>
      </div>

      <footer class="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-4 py-3">
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存设置' }}</button>
        <button type="button" class="btn btn-sm" :disabled="busy || !saved.enabled || active.state === 'running' || active.state === 'external'" @click="emit('start')">启动</button>
        <button type="button" class="btn btn-sm" :disabled="busy || !['running', 'starting', 'unready'].includes(active.state)" @click="emit('stop')">停止</button>
        <button type="button" class="btn btn-sm" :disabled="busy || !saved.enabled || active.state === 'external'" @click="emit('restart')">重启</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.drawer::backdrop {
  background: rgb(18 17 16 / 48%);
}

.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 51;
  margin: 0 0 0 auto;
  padding: 0;
  height: 100dvh;
  max-height: none;
  max-width: none;
  border: 0;
  color: var(--text);
  width: min(440px, 100vw);
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 12px 40px rgb(0 0 0 / 28%);
}

.drawer[open] {
  display: flex;
  flex-direction: column;
}
</style>

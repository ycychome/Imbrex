<script setup lang="ts">
import { CopyButton } from '@imbrex/ui-contract/ui';
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{ logs: string[] }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="log-drawer" aria-labelledby="log-title" @cancel.prevent="emit('close')" @close="emit('close')" @click="($event.target === dialog) && emit('close')">
      <header class="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <div class="min-w-0">
          <h2 id="log-title" class="text-sm font-semibold">伴生服务日志</h2>
          <p class="mt-0.5 text-[11px] text-[var(--muted)]">最近 {{ logs.length }} 行；登录链接与二维码内容保留，Authorization 和令牌值会脱敏。</p>
        </div>
        <div class="flex items-center gap-1">
          <CopyButton :value="logs.join('\n')" label="复制全部" />
          <button type="button" class="btn btn-sm btn-icon btn-quiet" aria-label="关闭日志" @click="emit('close')">×</button>
        </div>
      </header>
      <div class="flex-1 overflow-auto p-3">
        <pre v-if="logs.length" class="log-lines">{{ logs.join('\n') }}</pre>
        <p v-else class="px-2 py-8 text-center text-xs text-[var(--muted)]">暂无日志。启用伴生进程并启动后，这里会显示输出。</p>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.log-drawer::backdrop {
  background: rgb(18 17 16 / 48%);
}

.log-drawer {
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
  width: min(620px, 100vw);
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 12px 40px rgb(0 0 0 / 28%);
}

.log-drawer[open] {
  display: flex;
  flex-direction: column;
}

.log-lines {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text);
}
</style>

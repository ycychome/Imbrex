<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{ value: string; label?: string }>(), { label: '复制' });
const state = ref<'idle' | 'done' | 'failed'>('idle');
let timer: number | undefined;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value);
    state.value = 'done';
  } catch {
    state.value = 'failed';
  }
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { state.value = 'idle'; }, 1600);
}

onUnmounted(() => { window.clearTimeout(timer); });
</script>

<template>
  <button type="button" class="btn btn-sm btn-quiet" :title="value" @click="copy">
    <Icon :name="state === 'done' ? 'check' : 'copy'" :size="14" />
    <span aria-live="polite">{{ state === 'done' ? '已复制' : state === 'failed' ? '无法复制' : label }}</span>
  </button>
</template>

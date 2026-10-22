<script setup lang="ts">
import Icon from './Icon.vue';
import { describeFailure, requestIdOf } from './errors';

const props = defineProps<{ error: unknown; title?: string; detail?: string; retry?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div role="alert" class="notice">
    <Icon name="alert" :size="16" class="mt-0.5 text-[var(--bad)]" />
    <div class="min-w-0 flex-1">
      <p class="text-[13px] font-medium leading-snug">{{ props.title ?? describeFailure(props.error) }}</p>
      <p v-if="props.title" class="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">{{ props.detail ?? describeFailure(props.error) }}</p>
      <p v-if="requestIdOf(props.error)" class="mt-1 font-mono text-[11px] text-[var(--faint)]">
        request_id {{ requestIdOf(props.error) }}
      </p>
    </div>
    <button v-if="props.retry" type="button" class="btn btn-sm" @click="emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in oklab, var(--bad) 35%, var(--line));
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--bad) 8%, var(--surface));
}
</style>

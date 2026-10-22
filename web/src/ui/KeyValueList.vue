<script setup lang="ts">
import JsonBlock from './JsonBlock.vue';
import type { KeyValueEntry } from './types';

const props = defineProps<{ entries: KeyValueEntry[] }>();

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
</script>

<template>
  <dl class="kv">
    <div v-for="entry in props.entries" :key="entry.label" class="kv-row">
      <dt class="kv-key" :class="{ mono: entry.labelMono }">{{ entry.label }}</dt>
      <dd class="kv-value">
        <span v-if="isScalar(entry.value)" :class="{ mono: entry.mono }">{{ text(entry.value) }}</span>
        <JsonBlock v-else :value="entry.value" :max-height="220" />
        <span v-if="entry.hint" class="mt-0.5 block text-[11px] leading-relaxed text-[var(--faint)]">{{ entry.hint }}</span>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.kv {
  margin: 0;
}
.kv-row {
  display: grid;
  gap: 4px 24px;
  padding: 8px 0;
}
@media (min-width: 640px) {
  .kv-row {
    grid-template-columns: minmax(7rem, 11rem) 1fr;
  }
}
.kv-row + .kv-row {
  border-top: 1px solid var(--line);
}
.kv-key {
  font-size: 12px;
  color: var(--muted);
  padding-top: 2px;
}
.kv-value {
  margin: 0;
  min-width: 0;
  font-size: 13px;
  word-break: break-word;
}
</style>

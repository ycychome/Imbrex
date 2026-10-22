<script setup lang="ts">
withDefaults(defineProps<{ label: string; value: string; hint?: string; mono?: boolean; small?: boolean }>(), { small: false });
</script>

<template>
  <div class="flex min-w-0 flex-col gap-0.5 px-4 py-3">
    <span class="text-xs leading-tight text-[var(--muted)]">{{ label }}</span>
    <span class="stat-value" :class="{ 'font-mono': mono, 'is-small': small }">{{ value }}</span>
    <span v-if="hint" class="text-[11px] leading-snug text-[var(--faint)]">{{ hint }}</span>
  </div>
</template>

<style scoped>
.stat-value {
  font-size: 22px;
  line-height: 1.25;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.stat-value.is-small {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}
</style>

<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string }>(), {});
</script>

<template>
  <div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
    <span class="grid h-9 w-9 place-items-center rounded-full border border-[var(--line)] text-[var(--faint)]">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true">
        <path d="M2 2.5v11" />
        <path d="M5.5 4h8.5" />
        <path d="M5.5 8h6" />
        <path d="M5.5 12h4" />
      </svg>
    </span>
    <p class="text-[13px] font-medium">{{ title }}</p>
    <p v-if="description" class="max-w-sm text-xs leading-relaxed text-[var(--muted)]">{{ description }}</p>
    <slot />
  </div>
</template>

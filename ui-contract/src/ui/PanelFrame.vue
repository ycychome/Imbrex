<script setup lang="ts">
import Chip from './Chip.vue';
import type { Tone } from './errors';

defineProps<{
  title: string;
  instanceId: string;
  module: string;
  generation?: string;
  tone: Tone;
  label: string;
}>();
</script>

<template>
  <article class="panel overflow-hidden">
    <header class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--line)] px-4 py-3">
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 class="text-sm font-semibold">{{ title }}</h3>
        <span class="font-mono text-[11px] text-[var(--faint)]" :title="instanceId">{{ instanceId }}</span>
      </div>
      <div class="flex items-center gap-2">
        <Chip :tone="tone" :label="label" />
        <slot name="actions" />
      </div>
    </header>
    <div class="p-4">
      <slot />
    </div>
    <footer v-if="generation" class="border-t border-[var(--line)] px-4 py-2">
      <span class="font-mono text-[11px] text-[var(--faint)]" :title="generation">
        {{ module }} · generation {{ generation.slice(0, 8) }}
      </span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import type { Tone } from './errors';

withDefaults(defineProps<{ tone?: Tone; label: string; dot?: boolean; title?: string }>(), {
  tone: 'unknown',
  dot: true,
  title: undefined,
});
</script>

<template>
  <span class="chip" :data-tone="tone" :title="title">
    <span v-if="dot" class="dot" />
    {{ label }}
  </span>
</template>

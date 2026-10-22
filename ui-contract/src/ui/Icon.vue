<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });

// One 16px grid, 1.5px stroke, square terminals: drawn for this console, not a
// stock 24px rounded icon set.
const glyphs: Record<string, string[]> = {
  overview: ['M2 2h5v5H2z', 'M9 2h5v5H9z', 'M2 9h5v5H2z', 'M9 9h5v5H9z'],
  stream: ['M2 2.5v11', 'M5.5 4h8.5', 'M5.5 8h6', 'M5.5 12h4'],
  plug: ['M5.5 1.5V5', 'M10.5 1.5V5', 'M2.5 5h11v2.5a5.5 5.5 0 0 1-11 0z', 'M8 13v1.5'],
  chat: ['M2 3h12v7.5H7L4 13v-2.5H2z'],
  link: ['M6.2 9.8 9.8 6.2', 'M5.2 11.2 4 12.4a2 2 0 0 1-2.8-2.8L2.4 8.4', 'M10.8 4.8 12 3.6a2 2 0 0 1 2.8 2.8L13.6 7.6'],
  spark: ['M8 1.5v4', 'M8 10.5v4', 'M1.5 8h4', 'M10.5 8h4', 'M3.7 3.7l2 2', 'M10.3 10.3l2 2', 'M12.3 3.7l-2 2', 'M5.7 10.3l-2 2'],
  sliders: ['M2 4h12', 'M2 8h12', 'M2 12h12', 'M6 2.5v3', 'M10 6.5v3', 'M4 10.5v3'],
  sun: ['M8 5.25A2.75 2.75 0 1 1 7.99 5.25Z', 'M8 1v1.5', 'M8 13.5V15', 'M1 8h1.5', 'M13.5 8H15', 'M3.05 3.05l1.06 1.06', 'M11.89 11.89l1.06 1.06', 'M12.95 3.05l-1.06 1.06', 'M4.11 11.89l-1.06 1.06'],
  moon: ['M10.6 2.4A6 6 0 1 0 13.6 11.4 4.9 4.9 0 0 1 10.6 2.4Z'],
  logout: ['M6 2.5H2.5v11H6', 'M9.5 8H15', 'M12.5 5.5 15 8l-2.5 2.5'],
  copy: ['M5.5 5.5h8v8h-8z', 'M2.5 10.5v-8h8'],
  check: ['M2.5 8.5 6 12 13.5 4'],
  pause: ['M5.5 3v10', 'M10.5 3v10'],
  play: ['M4.5 2.5 13 8l-8.5 5.5z'],
  refresh: ['M13.5 8a5.5 5.5 0 1 1-1.7-4', 'M13.5 2v4h-4'],
  alert: ['M8 1.5 15 14H1z', 'M8 6v4', 'M8 11.8v.4'],
  chevron: ['M6 3.5 10.5 8 6 12.5'],
  search: ['M10.5 10.5 15 15', 'M6.75 11.5a4.75 4.75 0 1 1 0-9.5 4.75 4.75 0 0 1 0 9.5Z'],
  close: ['M3.5 3.5l9 9', 'M12.5 3.5l-9 9'],
  dot: ['M6 6h4v4H6z'],
};

const paths = computed(() => glyphs[props.name] ?? glyphs.dot ?? []);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="square"
    stroke-linejoin="miter"
    aria-hidden="true"
    focusable="false"
    class="shrink-0"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

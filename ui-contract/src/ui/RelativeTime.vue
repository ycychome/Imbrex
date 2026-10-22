<script setup lang="ts">
import { computed } from 'vue';
import { now } from './clock';
import { formatFull, formatRelative, parseTime } from './format';

const props = defineProps<{ value: string | number | Date | null | undefined; fallback?: string }>();
const text = computed(() => (parseTime(props.value) === null ? (props.fallback ?? '—') : formatRelative(props.value, now.value)));
const title = computed(() => formatFull(props.value));
const datetime = computed(() => (props.value instanceof Date ? props.value.toISOString() : typeof props.value === 'string' ? props.value : undefined));
</script>

<template>
  <time :datetime="datetime" :title="title">{{ text }}</time>
</template>

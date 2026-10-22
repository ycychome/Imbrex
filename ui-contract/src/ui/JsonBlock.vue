<script setup lang="ts">
import { computed } from 'vue';
import { prettyJson } from './format';

const props = withDefaults(defineProps<{ value: unknown; maxHeight?: number; label?: string }>(), { maxHeight: 320 });
const text = computed(() => prettyJson(props.value));
</script>

<template>
  <div class="min-w-0">
    <p v-if="label" class="mb-1 text-xs text-[var(--muted)]">{{ label }}</p>
    <pre class="json"><code>{{ text }}</code></pre>
  </div>
</template>

<style scoped>
.json {
  margin: 0;
  max-height: v-bind('props.maxHeight + "px"');
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--canvas);
  color: var(--text);
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
}
</style>

<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="description" class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ description }}</p>
    </div>
    <div class="flex items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-title {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 600;
  letter-spacing: -0.01em;
}
</style>

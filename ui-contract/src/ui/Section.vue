<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <section class="flex flex-col gap-3">
    <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div class="min-w-0">
        <h2 class="section-title">{{ title }}</h2>
        <p v-if="description" class="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">{{ description }}</p>
      </div>
      <div class="flex items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.section-title {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
  font-weight: 600;
}
</style>

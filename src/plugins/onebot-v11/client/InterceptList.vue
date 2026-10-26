<script setup lang="ts">
import { Chip, EmptyState, RelativeTime } from '@imbrex/ui-contract/ui';

defineProps<{
  items: { time: string; kind: string; conversation: string }[];
  busy: boolean;
}>();
const emit = defineEmits<{ allow: [kind: 'group' | 'private', id: string] }>();
</script>

<template>
  <section class="panel overflow-hidden">
    <div class="border-b border-[var(--line)] px-4 py-3">
      <h2 class="text-sm font-semibold">最近拦截</h2>
      <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
        最近 10 条因不在白名单而被丢弃的消息；点“加入白名单”立即保存并生效。
      </p>
    </div>
    <EmptyState
      v-if="!items.length"
      title="最近没有白名单拦截"
      description="名单外的群或私聊发消息后会出现在这里。"
    />
    <ul v-else class="divide-y divide-[var(--line)]">
      <li v-for="item in items" :key="item.time + item.kind + item.conversation" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <RelativeTime :value="item.time" class="w-20 shrink-0 text-[11px] text-[var(--faint)]" />
        <Chip :tone="item.kind === 'group' ? 'idle' : 'unknown'" :label="item.kind === 'group' ? '群聊' : '私聊'" />
        <span class="min-w-0 flex-1 font-mono text-xs">{{ item.conversation }}</span>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="emit('allow', item.kind === 'group' ? 'group' : 'private', item.conversation)">
          加入白名单
        </button>
      </li>
    </ul>
  </section>
</template>

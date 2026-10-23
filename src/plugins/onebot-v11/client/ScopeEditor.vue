<script setup lang="ts">
import { ref } from 'vue';
import { Chip } from '@imbrex/ui-contract/ui';

const props = defineProps<{
  scope: { group_ids: string[]; private_user_ids: string[]; source: string };
  busy: boolean;
}>();
const emit = defineEmits<{ save: [scope: { group_ids: string[]; private_user_ids: string[] }]; reset: [] }>();

const groupInput = ref('');
const privateInput = ref('');
const error = ref('');
const resetConfirm = ref(false);

function add(kind: 'group' | 'private'): void {
  const input = kind === 'group' ? groupInput : privateInput;
  const id = input.value.trim();
  error.value = '';
  if (!/^[1-9][0-9]{0,19}$/.test(id)) { error.value = 'ID 必须是规范正整数。'; return; }
  const list = kind === 'group' ? props.scope.group_ids : props.scope.private_user_ids;
  if (list.includes(id)) { error.value = '该 ID 已在名单中。'; return; }
  input.value = '';
  emit('save', {
    group_ids: kind === 'group' ? [...props.scope.group_ids, id] : [...props.scope.group_ids],
    private_user_ids: kind === 'private' ? [...props.scope.private_user_ids, id] : [...props.scope.private_user_ids],
  });
}

function remove(kind: 'group' | 'private', id: string): void {
  emit('save', {
    group_ids: kind === 'group' ? props.scope.group_ids.filter((item) => item !== id) : [...props.scope.group_ids],
    private_user_ids: kind === 'private' ? props.scope.private_user_ids.filter((item) => item !== id) : [...props.scope.private_user_ids],
  });
}

function reset(): void {
  resetConfirm.value = false;
  emit('reset');
}
</script>

<template>
  <section class="panel p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">采集白名单</h2>
        <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
          只有名单内的会话会被接纳为事件；保存在插件私有配置，增删即时生效，不需要重连。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Chip :tone="scope.source === 'runtime' ? 'warn' : 'idle'" :label="scope.source === 'runtime' ? '插件配置' : '宿主配置'" />
        <button v-if="scope.source === 'runtime' && !resetConfirm" type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="resetConfirm = true">恢复宿主配置</button>
        <template v-else-if="resetConfirm">
          <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="reset">确认恢复</button>
          <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="resetConfirm = false">取消</button>
        </template>
      </div>
    </div>

    <p v-if="error" class="mt-2 text-[11px] text-[var(--bad)]">{{ error }}</p>

    <div class="mt-4 grid gap-5 lg:grid-cols-2">
      <div class="min-w-0">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="label">群聊</h3>
          <span class="text-[11px] text-[var(--faint)]">{{ scope.group_ids.length }} 个</span>
        </div>
        <ul v-if="scope.group_ids.length" class="mt-2 flex flex-wrap gap-1.5">
          <li v-for="id in scope.group_ids" :key="id" class="whitelist-item">
            <span class="font-mono text-[11px]">{{ id }}</span>
            <button type="button" class="whitelist-remove" :disabled="busy" :aria-label="'移除群 ' + id" @click="remove('group', id)">×</button>
          </li>
        </ul>
        <p v-else class="mt-2 rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[11px] text-[var(--muted)]">
          空名单：不采集任何群消息。
        </p>
        <form class="mt-2 flex gap-2" @submit.prevent="add('group')">
          <input v-model="groupInput" class="input font-mono text-[12px]" inputmode="numeric" placeholder="群号，回车添加" :disabled="busy" />
          <button type="submit" class="btn btn-sm" :disabled="busy || !groupInput.trim()">添加</button>
        </form>
      </div>

      <div class="min-w-0">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="label">私聊</h3>
          <span class="text-[11px] text-[var(--faint)]">{{ scope.private_user_ids.length }} 个</span>
        </div>
        <ul v-if="scope.private_user_ids.length" class="mt-2 flex flex-wrap gap-1.5">
          <li v-for="id in scope.private_user_ids" :key="id" class="whitelist-item">
            <span class="font-mono text-[11px]">{{ id }}</span>
            <button type="button" class="whitelist-remove" :disabled="busy" :aria-label="'移除私聊 ' + id" @click="remove('private', id)">×</button>
          </li>
        </ul>
        <p v-else class="mt-2 rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[11px] text-[var(--muted)]">
          空名单：不采集任何私聊消息。
        </p>
        <form class="mt-2 flex gap-2" @submit.prevent="add('private')">
          <input v-model="privateInput" class="input font-mono text-[12px]" inputmode="numeric" placeholder="QQ 号，回车添加" :disabled="busy" />
          <button type="submit" class="btn btn-sm" :disabled="busy || !privateInput.trim()">添加</button>
        </form>
      </div>
    </div>

    <p class="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
      移除后，已接纳但尚未回复的消息也会失去回复许可；当前上限每类 1024 个。
    </p>
  </section>
</template>

<style scoped>
.whitelist-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
}

.whitelist-remove {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.whitelist-remove:hover {
  background: var(--surface-hi);
  color: var(--bad);
}
</style>

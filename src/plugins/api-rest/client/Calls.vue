<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, CopyButton, EmptyState, ErrorNotice, Icon, JsonBlock, KeyValueList, PageHeader, RelativeTime, Section, formatFull, isAbort, useNarrow, type KeyValueEntry, type Tone } from '@imbrex/ui-contract/ui';

type CallStatus = 'in_progress' | 'succeeded' | 'failed' | 'unknown';
type StatusFilter = 'all' | CallStatus;

interface AdminCall {
  caller_id: string;
  call_id: string;
  capability_id: string;
  schema_version: string;
  params: unknown;
  status: CallStatus;
  result?: unknown;
  reason?: unknown;
  created_at: string;
  updated_at: string;
}
interface CallCursor { caller_id: string; call_id: string }
interface CallPage { calls: AdminCall[]; next: CallCursor | null }
interface AdminCapability {
  id: string;
  plugin_instance_id: string;
  description: string;
  schema_version: string;
  is_side_effectful: boolean;
  input_schema: unknown;
  available: boolean;
}
interface CapabilityPage { capabilities: AdminCapability[] }

const props = defineProps<{ client: ViewClient }>();

const controller = new AbortController();
const capabilities = shallowRef<AdminCapability[]>([]);
const calls = shallowRef<AdminCall[]>([]);
const next = ref<CallCursor | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref<unknown>(null);

const caller = ref('');
const status = ref<StatusFilter>('all');
const appliedCaller = ref('');
const appliedStatus = ref<StatusFilter>('all');

const selected = ref<AdminCall | null>(null);
const sheetOpen = ref(false);
const narrow = useNarrow();
// The bottom sheet only exists on narrow viewports; a desktop selection must not
// leave the modal scrim covering the page.
watch(narrow, (value) => { if (!value) sheetOpen.value = false; });

const storeId = ref('');

const statusLabels: Record<CallStatus, string> = {
  in_progress: '进行中',
  succeeded: '成功',
  failed: '失败',
  unknown: '未知',
};

function statusTone(value: CallStatus): Tone {
  switch (value) {
    case 'succeeded': return 'ok';
    case 'failed': return 'bad';
    case 'in_progress': return 'warn';
    case 'unknown': return 'unknown';
    default: return 'idle';
  }
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

async function load(reset: boolean): Promise<void> {
  if (!storeId.value || loading.value) return;
  loading.value = true;
  const previous = selected.value;
  try {
    const page = await props.client.request<CallPage>('/api/admin/calls?' + query({
      store_id: storeId.value,
      limit: 50,
      caller_id: appliedCaller.value || undefined,
      status: appliedStatus.value === 'all' ? undefined : appliedStatus.value,
      after_caller_id: reset ? undefined : next.value?.caller_id,
      after_call_id: reset ? undefined : next.value?.call_id,
    }), { signal: controller.signal });
    const list = reset ? page.calls : [...calls.value, ...page.calls];
    calls.value = list;
    next.value = page.next;
    loaded.value = true;
    error.value = null;
    const keep = previous && list.find((call) => call.caller_id === previous.caller_id && call.call_id === previous.call_id);
    selected.value = keep ?? list[0] ?? null;
  } catch (cause) {
    if (!isAbort(cause)) error.value = cause;
  } finally {
    loading.value = false;
  }
}

async function loadCapabilities(): Promise<void> {
  try {
    const page = await props.client.request<CapabilityPage>('/api/admin/capabilities', { signal: controller.signal });
    capabilities.value = page.capabilities;
  } catch (cause) {
    if (!isAbort(cause)) error.value = cause;
  }
}

function apply(): void {
  appliedCaller.value = caller.value.trim();
  appliedStatus.value = status.value;
  void load(true);
}

function resetFilters(): void {
  caller.value = '';
  status.value = 'all';
  appliedCaller.value = '';
  appliedStatus.value = 'all';
  void load(true);
}

function refresh(): void {
  void loadCapabilities();
  void load(true);
}

function pick(call: AdminCall): void {
  selected.value = call;
  if (narrow.value) sheetOpen.value = true;
}

function closeSheet(): void {
  sheetOpen.value = false;
}

const entries = computed<KeyValueEntry[]>(() => {
  const call = selected.value;
  if (!call) return [];
  return [
    { label: '调用主体', value: call.caller_id, mono: true },
    { label: '调用 ID', value: call.call_id, mono: true },
    { label: '能力', value: call.capability_id, mono: true },
    { label: '参数版本', value: call.schema_version, mono: true },
    { label: '创建时间', value: formatFull(call.created_at), mono: true },
    { label: '更新时间', value: formatFull(call.updated_at), mono: true },
  ];
});

onMounted(async () => {
  try {
    const info = await props.client.request<{ store_id: string }>('/api/admin/info', { signal: controller.signal });
    storeId.value = info.store_id;
    await Promise.all([loadCapabilities(), load(true)]);
  } catch (cause) {
    if (!isAbort(cause)) error.value = cause;
  }
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeSheet();
}
window.addEventListener('keydown', onKeydown);
onUnmounted(() => {
  controller.abort();
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <main class="page">
    <PageHeader title="能力与调用" description="已登记能力、调用主体与审计结果；各页是新的查询视图，状态可能变化。">
      <template #actions>
        <button type="button" class="btn" :disabled="loading || !storeId" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <ErrorNotice v-if="error" :error="error" retry @retry="refresh" />

    <Section title="已登记能力" description="包含仍登记但当前不可用的实例。">
      <div class="panel overflow-hidden">
        <div class="overflow-x-auto">
          <table class="table min-w-[52rem]">
            <thead>
              <tr>
                <th>能力</th>
                <th>实例</th>
                <th>说明</th>
                <th>副作用</th>
                <th>可用</th>
                <th>输入 Schema</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="capability in capabilities" :key="capability.id">
                <td class="font-mono text-xs">{{ capability.id }}</td>
                <td class="font-mono text-xs text-[var(--muted)]">{{ capability.plugin_instance_id }}</td>
                <td class="max-w-xs text-xs leading-relaxed text-[var(--muted)]">{{ capability.description }}</td>
                <td class="text-xs text-[var(--muted)]">{{ capability.is_side_effectful ? '有' : '无' }}</td>
                <td>
                  <Chip :tone="capability.available ? 'ok' : 'idle'" :label="capability.available ? '可用' : '不可用'" />
                </td>
                <td>
                  <details class="group">
                    <summary class="cursor-pointer list-none text-xs font-medium text-[var(--accent)]">查看</summary>
                    <div class="mt-2 w-[min(34rem,70vw)]">
                      <JsonBlock :value="capability.input_schema" :max-height="200" />
                    </div>
                  </details>
                </td>
              </tr>
              <tr v-if="!capabilities.length">
                <td colspan="6">
                  <EmptyState title="暂无已登记能力" description="插件注册能力后会出现在这里。" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Section>

    <Section title="调用审计" description="按调用主体与 call_id 的字典序分页读取。">
      <form class="panel grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto]" @submit.prevent="apply">
        <label class="flex flex-col gap-1">
          <span class="label">调用主体</span>
          <input v-model="caller" type="text" class="input" placeholder="例如 qq-agent" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="label">状态</span>
          <select v-model="status" class="input">
            <option value="all">全部</option>
            <option value="in_progress">进行中</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
            <option value="unknown">未知</option>
          </select>
        </label>
        <div class="flex items-end gap-2">
          <button type="submit" class="btn btn-primary" :disabled="loading">应用筛选</button>
          <button v-if="appliedCaller || appliedStatus !== 'all'" type="button" class="btn btn-quiet" @click="resetFilters">重置</button>
        </div>
      </form>

      <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section class="panel overflow-hidden">
          <div v-if="calls.length" class="rows max-h-[calc(100vh-22rem)] overflow-y-auto">
            <button
              v-for="call in calls"
              :key="call.caller_id + '/' + call.call_id"
              type="button"
              class="row-link flex items-baseline gap-3 px-4 py-2.5"
              :aria-current="selected === call ? 'true' : undefined"
              @click="pick(call)"
            >
              <span class="w-24 shrink-0 truncate font-mono text-[11px] text-[var(--muted)]" :title="call.caller_id">{{ call.caller_id }}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="call.call_id">{{ call.call_id }}</span>
              <span class="hidden max-w-[40%] truncate font-mono text-[11px] text-[var(--muted)] sm:block" :title="call.capability_id">
                {{ call.capability_id }}
              </span>
              <Chip :tone="statusTone(call.status)" :label="statusLabels[call.status]" />
              <RelativeTime :value="call.updated_at" class="w-20 shrink-0 text-right text-[11px] text-[var(--faint)]" />
            </button>
          </div>
          <EmptyState v-else-if="loaded && !loading" title="没有符合条件的调用" description="调整调用主体或状态后重新应用筛选。" />
          <div v-else class="px-4 py-10 text-center text-xs text-[var(--muted)]">正在读取调用记录…</div>

          <footer class="rule flex items-center justify-between gap-3 px-4 py-3">
            <p class="meta">已加载 {{ calls.length }} 条</p>
            <button v-if="next" type="button" class="btn btn-sm" :disabled="loading" @click="load(false)">
              {{ loading ? '加载中…' : '加载更多' }}
            </button>
          </footer>
        </section>

        <Teleport to="body" :disabled="!narrow">
          <button v-if="narrow && sheetOpen" type="button" class="scrim" aria-label="关闭详情" @click="closeSheet" />
        </Teleport>

        <Teleport to="body" :disabled="!narrow">
        <aside class="inspector" :class="{ 'is-open': sheetOpen && narrow }">
          <template v-if="selected">
            <header class="border-b border-[var(--line)] px-4 pb-3 pt-2">
              <span class="sheet-handle" aria-hidden="true" />
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="label">调用详情</p>
                  <p class="truncate font-mono text-sm font-medium">{{ selected.call_id }}</p>
                </div>
              <div class="flex items-center gap-1">
                <CopyButton :value="selected.call_id" label="复制" />
                <button type="button" class="btn btn-sm btn-icon btn-quiet lg:hidden" aria-label="关闭详情" @click="closeSheet">
                  <Icon name="close" :size="14" />
                </button>
                </div>
              </div>
            </header>
            <div class="flex flex-col gap-4 p-4">
              <div class="flex items-center gap-2">
                <Chip :tone="statusTone(selected.status)" :label="statusLabels[selected.status]" />
                <span class="font-mono text-[11px] text-[var(--faint)]">{{ selected.capability_id }}</span>
              </div>
              <KeyValueList :entries="entries" stacked />
              <div>
                <p class="label mb-1">参数</p>
                <JsonBlock :value="selected.params" :max-height="220" />
              </div>
              <div v-if="selected.result !== undefined">
                <p class="label mb-1">结果</p>
                <JsonBlock :value="selected.result" :max-height="220" />
              </div>
              <div v-if="selected.reason">
                <p class="label mb-1">原因</p>
                <JsonBlock :value="selected.reason" :max-height="180" />
              </div>
            </div>
          </template>
          <div v-else class="px-4 py-10 text-center text-xs text-[var(--muted)]">选择一条调用查看参数与结果。</div>
        </aside>
        </Teleport>
      </div>
    </Section>
  </main>
</template>

<style scoped>
.inspector {
  display: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.sheet-handle {
  display: block;
  width: 36px;
  height: 4px;
  margin: 0 auto 10px;
  border-radius: 999px;
  background: var(--line-strong);
}

@media (min-width: 1024px) {
  .inspector {
    display: block;
    position: sticky;
    top: calc(var(--band) + 16px);
    max-height: calc(100vh - var(--band) - 32px);
    overflow-y: auto;
  }
}

@media (max-width: 1023px) {
  .inspector {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 40;
    max-height: 85dvh;
    overflow-y: auto;
    padding-bottom: calc(8px + env(safe-area-inset-bottom));
    border-radius: 12px 12px 0 0;
    border-bottom: 0;
    transform: translateY(100%);
    transition: transform 240ms var(--ease);
  }

  .inspector.is-open {
    display: block;
    transform: none;
  }
}

@media (min-width: 1024px) {
  .sheet-handle {
    display: none;
  }
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 30;
  border: 0;
  background: rgb(18 17 16 / 48%);
  cursor: pointer;
}
</style>

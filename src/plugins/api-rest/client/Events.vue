<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { CopyButton, EmptyState, ErrorNotice, Icon, JsonBlock, KeyValueList, PageHeader, RelativeTime, formatFull, isAbort, useNarrow, type KeyValueEntry } from '@imbrex/ui-contract/ui';

interface EventRecord {
  seq: string;
  accepted_at: string;
  event: { source: string; id: string; type: string; data: unknown; [key: string]: unknown };
  parents: { source: string; id: string }[];
}
interface EventPage {
  records: EventRecord[];
  next_after_seq: string;
  caught_up: boolean;
}

const props = defineProps<{ client: ViewClient }>();

const controller = new AbortController();
const records = shallowRef<EventRecord[]>([]);
const nextAfterSeq = ref('0');
const caughtUp = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref<unknown>(null);

const sourcePrefix = ref('');
const type = ref('');
const appliedSource = ref('');
const appliedType = ref('');

const selected = ref<EventRecord | null>(null);
const sheetOpen = ref(false);
const narrow = useNarrow();

const storeId = ref('');

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

async function loadPage(reset: boolean): Promise<void> {
  if (loading.value || !storeId.value) return;
  loading.value = true;
  const previous = selected.value;
  try {
    const page = await props.client.request<EventPage>('/api/admin/events?' + query({
      store_id: storeId.value,
      after_seq: reset ? '0' : nextAfterSeq.value,
      limit: 50,
      source_prefix: appliedSource.value || undefined,
      type: appliedType.value || undefined,
    }), { signal: controller.signal });
    const next = reset ? page.records : [...records.value, ...page.records];
    records.value = next;
    nextAfterSeq.value = page.next_after_seq;
    caughtUp.value = page.caught_up;
    loaded.value = true;
    error.value = null;
    const keep = previous && next.find((record) => record.seq === previous.seq);
    selected.value = keep ?? next[0] ?? null;
  } catch (cause) {
    if (!isAbort(cause)) error.value = cause;
  } finally {
    loading.value = false;
  }
}

function apply(): void {
  appliedSource.value = sourcePrefix.value.trim();
  appliedType.value = type.value.trim();
  void loadPage(true);
}

function refresh(): void {
  void loadPage(true);
}

function resetFilters(): void {
  sourcePrefix.value = '';
  type.value = '';
  appliedSource.value = '';
  appliedType.value = '';
  void loadPage(true);
}

function pick(record: EventRecord): void {
  selected.value = record;
  sheetOpen.value = true;
}

const entries = computed<KeyValueEntry[]>(() => {
  const record = selected.value;
  if (!record) return [];
  return [
    { label: '来源', value: record.event.source, mono: true },
    { label: '事件 ID', value: record.event.id, mono: true },
    { label: '类型', value: record.event.type, mono: true },
    { label: '接纳时间', value: formatFull(record.accepted_at), mono: true },
    { label: '父事件', value: record.parents.length ? record.parents.length : '无' },
  ];
});

function closeSheet(): void {
  sheetOpen.value = false;
}

onMounted(async () => {
  try {
    const info = await props.client.request<{ store_id: string }>('/api/admin/info', { signal: controller.signal });
    storeId.value = info.store_id;
    await loadPage(true);
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
    <PageHeader title="事件浏览" description="按序号读取本存储已接纳的事件；序号是位置，不是积压消息数。">
      <template #actions>
        <button type="button" class="btn" :disabled="loading || !storeId" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <ErrorNotice v-if="error" :error="error" retry @retry="refresh" />

    <form class="panel grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" @submit.prevent="apply">
      <label class="flex flex-col gap-1">
        <span class="label">来源前缀</span>
        <input v-model="sourcePrefix" type="text" class="input" placeholder="例如 imbrex://qq/123456/main/" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="label">事件类型</span>
        <input v-model="type" type="text" class="input" placeholder="例如 qq.message.group" />
      </label>
      <div class="flex items-end gap-2">
        <button type="submit" class="btn btn-primary" :disabled="loading">应用筛选</button>
        <button v-if="appliedSource || appliedType" type="button" class="btn btn-quiet" @click="resetFilters">重置</button>
      </div>
    </form>

    <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section class="panel overflow-hidden">
        <div v-if="records.length" class="rows max-h-[calc(100vh-16rem)] overflow-y-auto">
          <button
            v-for="(record, index) in records"
            :key="record.seq"
            type="button"
            class="row-link flex items-baseline gap-3 px-4 py-2.5"
            :class="{ 'row-latest': index === records.length - 1 }"
            :aria-current="selected?.seq === record.seq ? 'true' : undefined"
            @click="pick(record)"
          >
            <span class="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--faint)]">#{{ record.seq }}</span>
            <RelativeTime :value="record.accepted_at" class="w-20 shrink-0 text-xs text-[var(--muted)]" />
            <span v-if="index === records.length - 1" class="shrink-0 text-[10px] font-medium text-[var(--accent)]">最新</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="record.event.type">{{ record.event.type }}</span>
            <span class="hidden max-w-[45%] truncate text-[11px] text-[var(--muted)] sm:block" :title="record.event.source">
              {{ record.event.source }}
            </span>
            <Icon name="chevron" :size="12" class="self-center text-[var(--faint)] lg:hidden" />
          </button>
        </div>
        <EmptyState
          v-else-if="loaded && !loading"
          :title="caughtUp ? '没有符合条件的事件' : '暂无事件'"
          description="调整来源前缀或事件类型后重新应用筛选。"
        />
        <div v-else class="px-4 py-10 text-center text-xs text-[var(--muted)]">正在读取事件…</div>

        <footer class="rule flex items-center justify-between gap-3 px-4 py-3">
          <p class="meta">
            已加载 {{ records.length }} 条<span v-if="caughtUp" class="ml-2 text-[var(--faint)]">已到最新</span>
          </p>
          <button v-if="!caughtUp" type="button" class="btn btn-sm" :disabled="loading" @click="loadPage(false)">
            {{ loading ? '加载中…' : '加载更多' }}
          </button>
        </footer>
      </section>

      <Teleport to="body" :disabled="!narrow">
        <button v-if="sheetOpen" type="button" class="scrim" aria-label="关闭详情" @click="closeSheet" />
      </Teleport>

      <Teleport to="body" :disabled="!narrow">
      <aside class="inspector" :class="{ 'is-open': sheetOpen && narrow }">
        <template v-if="selected">
          <header class="border-b border-[var(--line)] px-4 pb-3 pt-2">
            <span class="sheet-handle" aria-hidden="true" />
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="label">事件详情</p>
                <p class="font-mono text-sm font-medium tabular-nums">#{{ selected.seq }}</p>
              </div>
            <div class="flex items-center gap-1">
              <CopyButton :value="selected.event.id" label="复制 ID" />
                <button type="button" class="btn btn-sm btn-icon btn-quiet lg:hidden" aria-label="关闭详情" @click="closeSheet">
                  <Icon name="close" :size="14" />
                </button>
              </div>
            </div>
          </header>
          <div class="flex flex-col gap-4 p-4">
            <KeyValueList :entries="entries" stacked />
            <div>
              <p class="label mb-1">数据</p>
              <JsonBlock :value="selected.event.data" :max-height="260" />
            </div>
            <div v-if="selected.parents.length">
              <p class="label mb-1">父事件</p>
              <JsonBlock :value="selected.parents" :max-height="140" />
            </div>
          </div>
        </template>
        <div v-else class="px-4 py-10 text-center text-xs text-[var(--muted)]">选择一条事件查看详情。</div>
      </aside>
      </Teleport>
    </div>
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

  .sheet-handle {
    display: block;
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

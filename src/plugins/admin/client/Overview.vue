<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { AdminClient, AdminPluginStatus } from '../../../../web/src/client-api.js';
import { health, refreshHealth } from '../../../../web/src/health.js';
import { now } from '../../../../web/src/ui/clock.js';
import Chip from '../../../../web/src/ui/Chip.vue';
import EmptyState from '../../../../web/src/ui/EmptyState.vue';
import ErrorNotice from '../../../../web/src/ui/ErrorNotice.vue';
import PageHeader from '../../../../web/src/ui/PageHeader.vue';
import RelativeTime from '../../../../web/src/ui/RelativeTime.vue';
import Section from '../../../../web/src/ui/Section.vue';
import { isAbort, type Tone } from '../../../../web/src/ui/errors.js';
import { formatRelative, shortId } from '../../../../web/src/ui/format.js';

interface EventRecord {
  seq: string;
  accepted_at: string;
  event: { source: string; id: string; type: string };
}

const props = defineProps<{ client: AdminClient }>();

const controller = new AbortController();
const recent = shallowRef<EventRecord[]>([]);
const recentError = ref<unknown>(null);
const loadingRecent = ref(false);

let inFlight = false;

async function loadRecent(): Promise<void> {
  const info = health.info;
  if (!info || inFlight) return;
  inFlight = true;
  loadingRecent.value = true;
  try {
    const latest = BigInt(info.latest_seq);
    const after = latest > 8n ? (latest - 8n).toString() : '0';
    const params = new URLSearchParams({ store_id: info.store_id, after_seq: after, limit: '8' });
    const page = await props.client.request<{ records: EventRecord[] }>(`/api/admin/events?${params.toString()}`, { signal: controller.signal });
    recent.value = page.records;
    recentError.value = null;
  } catch (cause) {
    if (!isAbort(cause)) recentError.value = cause;
  } finally {
    inFlight = false;
    loadingRecent.value = false;
  }
}

watch(() => health.updatedAt, () => { void loadRecent(); });
onMounted(() => { void loadRecent(); });
onUnmounted(() => controller.abort());

const plugins = computed<AdminPluginStatus[]>(() => {
  const rank = (plugin: AdminPluginStatus): number => (plugin.last_error ? 0 : plugin.available ? 2 : 1);
  return [...(health.info?.plugins ?? [])].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
});

const available = computed(() => plugins.value.filter((plugin) => plugin.available).length);
const newest = computed(() => recent.value[recent.value.length - 1] ?? null);
const newestAge = computed(() => (newest.value ? formatRelative(newest.value.accepted_at, now.value) : '暂无'));

const panelRollup = computed<{ tone: Tone; value: string; hint: string }>(() => {
  const panels = health.panels;
  const bad = panels.filter((panel) => panel.tone === 'bad');
  const warn = panels.filter((panel) => panel.tone === 'warn' || panel.tone === 'unknown');
  if (bad.length) {
    return { tone: 'bad', value: `${bad.length} 项异常`, hint: bad.map((panel) => `${panel.title} ${panel.label}`).join('、') };
  }
  if (warn.length) {
    return { tone: 'warn', value: `${warn.length} 项待确认`, hint: warn.map((panel) => `${panel.title} ${panel.label}`).join('、') };
  }
  if (!panels.length) return { tone: 'unknown', value: '未登记', hint: '插件尚未注册面板' };
  return { tone: 'ok', value: '全部正常', hint: panels.map((panel) => panel.title).join(' · ') };
});

const stateLabels: Record<string, string> = {
  waiting: '等待中',
  loading: '启动中',
  active: '运行中',
  failed: '失败',
  stopping: '停止中',
  stopped: '已停止',
};

function stateLabel(plugin: AdminPluginStatus): string {
  const base = stateLabels[plugin.state] ?? plugin.state;
  return plugin.last_error ? `${base} · 初始化失败` : base;
}

function stateTone(plugin: AdminPluginStatus): Tone {
  if (plugin.state === 'failed') return 'bad';
  if (plugin.last_error) return 'warn';
  if (plugin.available) return 'ok';
  if (plugin.state === 'waiting' || plugin.state === 'loading' || plugin.state === 'stopping') return 'warn';
  return 'idle';
}

function reload(): void {
  refreshHealth();
  void loadRecent();
}
</script>

<template>
  <main class="page">
    <PageHeader title="概览" description="本机网关当前是否正常，以及刚刚发生了什么。">
      <template #actions>
        <button type="button" class="btn" :disabled="health.loading" @click="reload">
          {{ health.loading ? '刷新中…' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <ErrorNotice v-if="health.error" :error="health.error" retry @retry="reload" />

    <section class="panel overflow-hidden">
      <div class="grid grid-cols-2 gap-px bg-[var(--line)] sm:grid-cols-[1.6fr_1fr_1fr]">
        <div class="col-span-2 min-w-0 bg-[var(--surface)] px-4 py-3 sm:col-span-1">
          <p class="text-xs leading-tight text-[var(--muted)]">最近事件</p>
          <p class="mt-1 text-[22px] font-semibold leading-tight tabular-nums">{{ newestAge }}</p>
          <p class="mt-0.5 truncate font-mono text-[12px]">{{ newest ? newest.event.type : '等待第一条事件' }}</p>
        </div>
        <div class="min-w-0 bg-[var(--surface)] px-4 py-3">
          <p class="text-xs leading-tight text-[var(--muted)]">可用插件</p>
          <p class="mt-1 text-[22px] font-semibold leading-tight tabular-nums" :class="available < plugins.length ? 'text-[var(--warn)]' : ''">
            {{ available }} / {{ plugins.length }}
          </p>
          <p class="mt-0.5 text-[11px] leading-snug" :class="available < plugins.length ? 'text-[var(--warn)]' : 'text-[var(--faint)]'">
            {{ plugins.length - available ? `${plugins.length - available} 个不可用` : '全部可用' }}
          </p>
        </div>
        <div class="min-w-0 bg-[var(--surface)] px-4 py-3">
          <p class="text-xs leading-tight text-[var(--muted)]">面板</p>
          <p
            class="mt-1 text-[22px] font-semibold leading-tight"
            :class="panelRollup.tone === 'bad' ? 'text-[var(--bad)]' : panelRollup.tone === 'warn' ? 'text-[var(--warn)]' : panelRollup.tone === 'ok' ? '' : 'text-[var(--faint)]'"
          >
            {{ panelRollup.value }}
          </p>
          <p class="mt-0.5 truncate text-[11px] leading-snug text-[var(--muted)]" :title="panelRollup.hint">{{ panelRollup.hint }}</p>
        </div>
      </div>
    </section>

    <Section title="最近事件" description="最新 8 条已接纳事件；完整查询见事件浏览。">
      <template #actions>
        <span class="meta">最新序号 <span class="mono text-[var(--text)]">#{{ health.info?.latest_seq ?? '—' }}</span></span>
      </template>
      <ErrorNotice v-if="recentError" :error="recentError" />
      <div v-else class="panel overflow-hidden">
        <div v-if="recent.length" class="rows">
          <div
            v-for="(record, index) in recent"
            :key="record.seq"
            class="row-in flex items-baseline gap-3 px-4 py-2.5"
            :class="{ 'row-latest': index === recent.length - 1 }"
            :style="{ '--i': index }"
          >
            <span class="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--faint)]">#{{ record.seq }}</span>
            <RelativeTime :value="record.accepted_at" class="w-20 shrink-0 text-xs text-[var(--muted)]" />
            <span v-if="index === recent.length - 1" class="shrink-0 text-[10px] font-medium text-[var(--accent)]">最新</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="record.event.type">{{ record.event.type }}</span>
            <span class="hidden min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--muted)] sm:block" :title="record.event.source">
              {{ record.event.source }}
            </span>
          </div>
        </div>
        <EmptyState v-else title="还没有事件" description="外部来源接纳第一条事件后，这里会出现它。" />
      </div>
    </Section>

    <Section title="插件" description="实例生命周期与最近错误；状态来自宿主运行时投影。">
      <div class="panel overflow-hidden">
        <div class="overflow-x-auto">
          <table class="table min-w-[46rem]">
            <thead>
              <tr>
                <th>实例</th>
                <th class="hidden sm:table-cell">模块</th>
                <th>状态</th>
                <th>必需</th>
                <th>最近错误</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plugin in plugins" :key="plugin.id">
                <td class="font-mono text-xs">{{ plugin.id }}</td>
                <td class="hidden font-mono text-xs text-[var(--muted)] sm:table-cell">{{ plugin.module_name }}</td>
                <td>
                  <Chip :tone="stateTone(plugin)" :label="stateLabel(plugin)" />
                </td>
                <td class="text-xs text-[var(--muted)]">{{ plugin.required ? '必需' : '可选' }}</td>
                <td class="text-xs">
                  <template v-if="plugin.last_error">
                    <span class="font-mono text-[var(--bad)]">{{ plugin.last_error.code }}</span>
                    <span v-if="plugin.last_error.message" class="mt-0.5 block leading-snug text-[var(--muted)]">{{ plugin.last_error.message }}</span>
                  </template>
                  <span v-else class="text-[var(--faint)]">—</span>
                </td>
              </tr>
              <tr v-if="!plugins.length">
                <td colspan="5">
                  <EmptyState title="没有插件状态" description="宿主尚未报告已装配的插件。" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-if="health.info" class="text-[11px] text-[var(--faint)]">
        store <span class="font-mono" :title="health.info.store_id">{{ shortId(health.info.store_id, 8) }}</span>
        <span v-if="loadingRecent" class="ml-2">正在读取最近事件…</span>
      </p>
    </Section>
  </main>
</template>

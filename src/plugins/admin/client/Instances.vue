<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, EmptyState, ErrorNotice, PageHeader, Section, failureOf, isAbort, shortId, type Tone } from '@imbrex/ui-contract/ui';
import type { AdminInfo, AdminPluginStatus } from '../types.js';
import { refreshHealth } from '../shell/health.js';

interface ConfiguredPlugin { instance_id: string; enabled: boolean }
interface Configuration { plugins: ConfiguredPlugin[] }
interface LifecycleResult {
  status?: unknown;
  state?: unknown;
  lifecycle_revision?: unknown;
  reason?: { code?: unknown };
  inspect_required?: unknown;
}

const props = defineProps<{ client: ViewClient }>();

const info = shallowRef<AdminInfo | null>(null);
const configured = shallowRef<Record<string, boolean>>({});
const error = ref<unknown>(null);
const loading = ref(false);
const busy = ref('');
const notice = ref('');
const failure = ref('');
const pending = ref<{ id: string; action: 'stop' | 'restart' } | null>(null);
const controller = new AbortController();

const stateLabels: Record<string, string> = {
  waiting: '等待中',
  loading: '启动中',
  active: '运行中',
  failed: '失败',
  stopping: '停止中',
  stopped: '已停止',
};

const plugins = computed<AdminPluginStatus[]>(() =>
  [...(info.value?.plugins ?? [])].sort((a, b) => a.id.localeCompare(b.id)));

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

function configuredLabel(plugin: AdminPluginStatus): string {
  const baseline = configured.value[plugin.id];
  if (baseline === undefined) return '未知';
  if (baseline) return '宿主启用';
  return plugin.enabled && plugin.state === 'active' ? '临时启动' : '未启用';
}

function configuredTone(plugin: AdminPluginStatus): Tone {
  const baseline = configured.value[plugin.id];
  if (baseline === undefined) return 'unknown';
  if (baseline) return 'ok';
  return plugin.enabled && plugin.state === 'active' ? 'warn' : 'idle';
}

function servingChannel(plugin: AdminPluginStatus): boolean {
  return plugin.module_name === 'admin' || plugin.module_name === 'server-http';
}

function canStart(plugin: AdminPluginStatus): boolean {
  return (plugin.state === 'stopped' || plugin.state === 'failed') && busy.value !== plugin.id;
}

function canStop(plugin: AdminPluginStatus): boolean {
  return plugin.state === 'active' && !servingChannel(plugin) && busy.value !== plugin.id;
}

function settling(plugin: AdminPluginStatus): boolean {
  return plugin.state === 'waiting' || plugin.state === 'loading' || plugin.state === 'stopping';
}

function messageFor(cause: unknown, action: 'start' | 'stop' | 'restart'): string {
  const status = failureOf(cause).status;
  const code = failureOf(cause).code ?? 'request_failed';
  if (status === 0) return `无法连接管理 API；${action} 的结果未知，请重新读取实例状态后核验，不要自动重复。`;
  if (status === 401) return '登录已失效，请重新连接。';
  if (status === 403) return '当前凭据没有 admin:operate 权限。';
  if (status === 404 && code === 'feature_unavailable') return '管理通道实例不能从自身页面停用或重启；请使用离线部署控制。';
  if (status === 404) return '目标实例不存在。';
  if (status === 409) return '实例版本或当前状态已改变；已重新读取，未重复执行。';
  if (status === 429) return '同一实例正在执行另一个动作，请稍后再试。';
  if (status === 503) return '宿主正在关闭、实例尚未就绪或清理失败；请重新读取实际状态。';
  if (status === 400) return '请求参数无效，未执行生命周期动作。';
  return `实例操作失败（${code}）。`;
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const [nextInfo, config] = await Promise.all([
      props.client.request<AdminInfo>('/api/admin/info', { signal: controller.signal }),
      props.client.request<Configuration>('/api/admin/configuration', { signal: controller.signal }),
    ]);
    info.value = nextInfo;
    configured.value = Object.fromEntries(config.plugins.map((plugin) => [plugin.instance_id, plugin.enabled]));
    error.value = null;
  } catch (cause) {
    if (!isAbort(cause)) error.value = cause;
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  void load();
  refreshHealth();
}

async function run(plugin: AdminPluginStatus, action: 'start' | 'stop' | 'restart'): Promise<void> {
  if (busy.value || !info.value) return;
  pending.value = null;
  busy.value = plugin.id;
  notice.value = '';
  failure.value = '';
  try {
    const body = await props.client.request<{ result?: LifecycleResult }>(
      `/api/admin/instances/${encodeURIComponent(plugin.id)}/actions/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ store_id: info.value.store_id, lifecycle_revision: plugin.lifecycle_revision }),
        signal: controller.signal,
      },
    );
    const result = body.result ?? {};
    if (result.status !== 'succeeded') {
      const actual = typeof result.state === 'string' ? (stateLabels[result.state] ?? result.state) : stateLabels[plugin.state] ?? plugin.state;
      const reason = result.reason && typeof result.reason.code === 'string' ? result.reason.code : 'lifecycle_failed';
      failure.value = `实例操作未完成：${reason}。当前状态：${actual}；请按面板与运行日志核验后再决定下一步。`;
    } else {
      notice.value = action === 'start'
        ? '实例已启动；平台登录、连接与业务状态仍需按面板核验。'
        : action === 'stop'
          ? '实例已停止；其插件视图应随宿主状态移除。'
          : '实例已重启；连接、会话与配置应用状态需重新核验。';
    }
  } catch (cause) {
    if (!isAbort(cause)) failure.value = messageFor(cause, action);
  } finally {
    busy.value = '';
    await load();
    refreshHealth();
  }
}

function ask(plugin: AdminPluginStatus, action: 'stop' | 'restart'): void {
  pending.value = { id: plugin.id, action };
  notice.value = '';
  failure.value = '';
}

function confirm(plugin: AdminPluginStatus): void {
  const action = pending.value?.id === plugin.id ? pending.value.action : null;
  if (action) void run(plugin, action);
}

onMounted(() => { void load(); });
onUnmounted(() => controller.abort());
</script>

<template>
  <main class="page">
    <PageHeader title="实例" description="宿主装配的插件实例、运行版本与在线启停；不修改 imbrex.json。">
      <template #actions>
        <button type="button" class="btn" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <ErrorNotice v-if="error" :error="error" retry @retry="refresh" />

    <p class="notice-warn">
      在线启停只改变本次宿主运行；宿主重启后仍按配置装配。临时启动的 disabled 实例不会改变宿主配置基准。
      管理或 HTTP 通道的停用与重启需使用离线部署控制。
    </p>

    <Section title="配置实例" description="lifecycle_revision 是本次运行的版本；操作前服务端会再次核对。">
      <div class="panel overflow-hidden">
        <div class="overflow-x-auto">
          <table class="table min-w-[58rem]">
            <thead>
              <tr>
                <th>实例</th>
                <th>模块</th>
                <th>运行状态</th>
                <th>配置来源</th>
                <th>必需</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plugin in plugins" :key="plugin.id">
                <td>
                  <div class="font-mono text-xs">{{ plugin.id }}</div>
                  <div class="mt-0.5 font-mono text-[10px] text-[var(--faint)]" :title="plugin.lifecycle_revision">
                    rev {{ shortId(plugin.lifecycle_revision, 6) }}
                  </div>
                </td>
                <td class="font-mono text-xs text-[var(--muted)]">{{ plugin.module_name }}</td>
                <td>
                  <Chip :tone="stateTone(plugin)" :label="stateLabel(plugin)" />
                  <span class="ml-2 text-[11px] text-[var(--muted)]">{{ plugin.available ? '对外可用' : '不可用' }}</span>
                  <div v-if="plugin.last_error" class="mt-1 max-w-[20rem] break-words font-mono text-[10px] text-[var(--bad)]">
                    {{ plugin.last_error.code }}<span v-if="plugin.last_error.message" class="text-[var(--muted)]"> · {{ plugin.last_error.message }}</span>
                  </div>
                </td>
                <td><Chip :tone="configuredTone(plugin)" :label="configuredLabel(plugin)" /></td>
                <td class="text-xs text-[var(--muted)]">{{ plugin.required ? '必需' : '可选' }}</td>
                <td>
                  <div v-if="pending?.id === plugin.id" class="flex flex-wrap items-center gap-2">
                    <span class="text-[11px] text-[var(--warn)]">{{ pending.action === 'stop' ? '确认停止？' : '确认重启？' }}</span>
                    <button type="button" class="btn btn-sm btn-danger" :disabled="busy === plugin.id" @click="confirm(plugin)">确认</button>
                    <button type="button" class="btn btn-sm btn-quiet" :disabled="busy === plugin.id" @click="pending = null">取消</button>
                  </div>
                  <div v-else-if="busy === plugin.id" class="text-[11px] text-[var(--muted)]">执行中…</div>
                  <div v-else-if="canStart(plugin)" class="flex items-center gap-2">
                    <button type="button" class="btn btn-sm btn-primary" @click="run(plugin, 'start')">启动</button>
                  </div>
                  <div v-else-if="canStop(plugin)" class="flex flex-wrap items-center gap-2">
                    <button type="button" class="btn btn-sm" @click="ask(plugin, 'stop')">停止</button>
                    <button type="button" class="btn btn-sm btn-quiet" @click="ask(plugin, 'restart')">重启</button>
                  </div>
                  <div v-else-if="plugin.state === 'active' && servingChannel(plugin)" class="text-[11px] text-[var(--muted)]" title="通过正在服务的管理端点停用自身会被服务端拒绝">
                    离线控制
                  </div>
                  <div v-else-if="settling(plugin)" class="text-[11px] text-[var(--muted)]">处理中…</div>
                  <span v-else class="text-[11px] text-[var(--faint)]">—</span>
                </td>
              </tr>
              <tr v-if="!plugins.length">
                <td colspan="6">
                  <EmptyState title="没有配置实例" description="宿主尚未报告已装配的插件。" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Section>

    <p v-if="notice" role="status" class="notice-warn">{{ notice }}</p>
    <p v-if="failure" role="alert" class="notice-bad">{{ failure }}</p>
  </main>
</template>

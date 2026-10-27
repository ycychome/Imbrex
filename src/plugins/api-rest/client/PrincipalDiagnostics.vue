<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, EmptyState, ErrorNotice, Section, isAbort } from '@imbrex/ui-contract/ui';
import type { AdminPrincipal, CapabilityDiagnostics, SourceRule } from './types';

const props = defineProps<{
  client: ViewClient;
  principals: AdminPrincipal[];
}>();

const selectedId = ref('');
const diagnostics = shallowRef<CapabilityDiagnostics | null>(null);
const error = ref<unknown>(null);
const loading = ref(false);
let sequence = 0;
let disposed = false;

function sourceText(rule: SourceRule): string {
  return rule.exact !== undefined ? rule.exact : `prefix:${rule.prefix ?? ''}`;
}

async function load(): Promise<void> {
  const principal = selectedId.value;
  if (!principal) {
    diagnostics.value = null;
    error.value = null;
    return;
  }
  const current = ++sequence;
  loading.value = true;
  try {
    const page = await props.client.request<{ diagnostics?: CapabilityDiagnostics }>(
      '/api/admin/capabilities?principal_id=' + encodeURIComponent(principal),
    );
    if (current !== sequence || disposed) return;
    diagnostics.value = page.diagnostics ?? null;
    error.value = page.diagnostics ? null : new Error('diagnostics unavailable');
  } catch (cause) {
    if (current !== sequence || disposed || isAbort(cause)) return;
    diagnostics.value = null;
    error.value = cause;
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(() => props.principals, (list) => {
  if (!list.some((principal) => principal.id === selectedId.value)) {
    const preferred = list.find((principal) => principal.permissions.some((permission) => permission === 'admin:inspect' || permission === 'admin:operate'))
      ?? list.find((principal) => principal.permissions.includes('capabilities:invoke'))
      ?? list[0];
    selectedId.value = preferred?.id ?? '';
  }
}, { immediate: true });

watch(selectedId, () => { void load(); }, { immediate: true });
onUnmounted(() => { disposed = true; sequence += 1; });
</script>

<template>
  <Section title="主体能力诊断" description="选择一个配置主体查看权限与能力交集；诊断不改变人工测试的执行身份。">
    <div class="panel flex flex-col gap-4 p-4">
      <EmptyState v-if="!principals.length" title="没有可诊断主体" description="管理配置中尚未声明 Principal。" />
      <template v-else>
        <div class="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label class="flex flex-col gap-1">
            <span class="label">诊断主体</span>
            <select v-model="selectedId" class="input">
              <option v-for="principal in principals" :key="principal.id" :value="principal.id">
                {{ principal.id }} · {{ principal.permissions.join(' · ') || '无权限' }}
              </option>
            </select>
          </label>
          <button type="button" class="btn" :disabled="loading || !selectedId" @click="load">
            {{ loading ? '读取中…' : '重新读取' }}
          </button>
        </div>

        <p class="text-[11px] leading-relaxed text-[var(--muted)]">
          诊断只读取配置与当前注册。人工测试始终使用当前登录管理员的 Principal，不会借用这里选择的主体。
        </p>

        <ErrorNotice v-if="error" :error="error" retry @retry="load" />

        <div v-if="diagnostics" class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-xs">{{ diagnostics.principal.id }}</span>
            <Chip
              :tone="diagnostics.external_writes_enabled ? 'ok' : 'idle'"
              :label="diagnostics.external_writes_enabled ? '外部写开关已启用' : '外部写开关关闭'"
            />
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <div>
              <p class="label">权限</p>
              <div class="mt-1 flex flex-wrap gap-1.5">
                <span v-for="permission in diagnostics.principal.permissions" :key="permission" class="chip-mono">{{ permission }}</span>
                <span v-if="!diagnostics.principal.permissions.length" class="text-xs text-[var(--faint)]">—</span>
              </div>
            </div>
            <div>
              <p class="label">读取来源</p>
              <div class="mt-1 flex flex-col gap-1">
                <span v-for="rule in diagnostics.principal.read_sources" :key="JSON.stringify(rule)" class="break-all font-mono text-[11px] text-[var(--muted)]">{{ sourceText(rule) }}</span>
                <span v-if="!diagnostics.principal.read_sources.length" class="text-xs text-[var(--faint)]">—</span>
              </div>
            </div>
            <div>
              <p class="label">可调用能力</p>
              <div class="mt-1 flex flex-wrap gap-1.5">
                <span v-for="id in diagnostics.principal.invoke_capabilities" :key="id" class="chip-mono">{{ id }}</span>
                <span v-if="!diagnostics.principal.invoke_capabilities.length" class="text-xs text-[var(--faint)]">—</span>
              </div>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="table min-w-[46rem]">
              <thead>
                <tr>
                  <th>能力</th>
                  <th>提供方在线</th>
                  <th>调用授权</th>
                  <th>events:read</th>
                  <th>外部写</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in diagnostics.capabilities" :key="item.id">
                  <td class="font-mono text-xs">{{ item.id }}</td>
                  <td><Chip :tone="item.available ? 'ok' : 'idle'" :label="item.available ? '在线' : '不可用'" /></td>
                  <td><Chip :tone="item.invoke_authorized ? 'ok' : 'idle'" :label="item.invoke_authorized ? '已授权' : '未授权'" /></td>
                  <td><Chip :tone="item.events_read_permitted ? 'ok' : 'idle'" :label="item.events_read_permitted ? '有' : '无'" /></td>
                  <td><Chip :tone="item.external_write_enabled ? 'ok' : 'idle'" :label="item.external_write_enabled ? '允许' : '关闭'" /></td>
                </tr>
                <tr v-if="!diagnostics.capabilities.length">
                  <td colspan="5"><EmptyState title="没有能力" description="该主体当前看不到任何已登记能力。" /></td>
                </tr>
              </tbody>
            </table>
          </div>

          <p class="text-[11px] leading-relaxed text-[var(--faint)]">
            events:read 只表示权限项存在，不证明具体目标被 read_sources 覆盖。平台角色与参数尚未校验，诊断不承诺一次具体调用一定成功。
          </p>
        </div>
        <p v-else-if="loading" class="text-xs text-[var(--muted)]">正在读取诊断…</p>
      </template>
    </div>
  </Section>
</template>

<style scoped>
.chip-mono {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.6;
  color: var(--muted);
}
</style>

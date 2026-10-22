<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { authenticated, clearToken, login, sessionMessage, setToken } from './api';
import { ctx } from './context';
import { loadPluginClients } from './loader';
import { gatewayHealth, health, stale, startHealth, stopHealth, togglePolling, updatedText } from './health';
import { theme, toggleTheme } from './theme';
import { Chip, Icon, describeFailure, shortId, type Tone } from '@imbrex/ui-contract/ui';

const input = ref('');
const error = ref('');
const loading = ref(false);
const loadingViews = ref(false);
const loadError = ref('');
const failures = ref<string[]>([]);
const confirmDisconnect = ref(false);
const healthOpen = ref(false);

const views = computed(() => ctx.views.list());
const active = computed(() => ctx.views.active());
const activeIndex = computed(() => Math.max(0, views.value.findIndex((view) => view.id === active.value?.id)));
const loginError = computed(() => error.value || sessionMessage.value);

// One rollup for narrow screens: the band cannot list every panel on a phone.
const rollup = computed<{ tone: Tone; label: string }>(() => {
  const tones = [gatewayHealth.value.tone, ...health.panels.map((panel) => panel.tone)];
  const bad = tones.filter((tone) => tone === 'bad').length;
  const warn = tones.filter((tone) => tone === 'warn' || tone === 'unknown').length;
  if (bad) return { tone: 'bad', label: `${bad} 项异常` };
  if (warn) return { tone: 'warn', label: `${warn} 项待确认` };
  if (!health.info) return { tone: 'unknown', label: '检测中' };
  return { tone: 'ok', label: '全部正常' };
});

async function loadViews(): Promise<void> {
  loadingViews.value = true;
  loadError.value = '';
  try {
    const result = await loadPluginClients();
    failures.value = result.failures;
    startHealth();
  } catch (cause) {
    loadError.value = describeFailure(cause);
  } finally {
    loadingViews.value = false;
  }
}

async function submit(): Promise<void> {
  const value = input.value.trim();
  if (!value || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await login(value);
    setToken(value);
    input.value = '';
    await loadViews();
  } catch (cause) {
    error.value = describeFailure(cause);
  } finally {
    loading.value = false;
  }
}

function disconnect(): void {
  clearToken();
  stopHealth();
  window.location.reload();
}

onMounted(() => {
  if (authenticated.value) void loadViews();
});
</script>

<template>
  <main v-if="!authenticated" class="login">
    <form class="login-card" @submit.prevent="submit">
      <div class="mb-7">
        <span class="mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square">
            <path d="M4 20V11a8 8 0 0 1 16 0v9" />
            <path d="M8 20v-9a4 4 0 0 1 8 0v9" />
          </svg>
        </span>
        <h1 class="login-title mt-5">Imbrex 管理控制台</h1>
        <p class="mt-1.5 text-[13px] leading-relaxed text-[var(--muted)]">使用 admin:inspect 凭据连接本机网关。</p>
      </div>

      <label class="label" for="admin-token">管理令牌</label>
      <input
        id="admin-token"
        v-model="input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        autofocus
        placeholder="Bearer token"
        class="input mt-2"
      />

      <p v-if="loginError" role="alert" class="login-error">{{ loginError }}</p>

      <button type="submit" :disabled="loading || !input.trim()" class="btn btn-primary mt-5 w-full">
        {{ loading ? '连接中…' : '连接网关' }}
      </button>

      <p class="mt-4 text-center text-[11px] leading-relaxed text-[var(--faint)]">
        令牌只保存在本标签页，关闭标签页即清除。
      </p>
    </form>
  </main>

  <div v-else class="shell">
    <aside class="rail">
      <span class="mark mark-sm" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
            <path d="M4 20V11a8 8 0 0 1 16 0v9" />
            <path d="M8 20v-9a4 4 0 0 1 8 0v9" />
          </svg>
      </span>

      <nav class="rail-nav" aria-label="视图">
        <span class="rail-marker" :style="{ transform: `translateY(${activeIndex * 44}px)` }" aria-hidden="true" />
        <button
          v-for="view in views"
          :key="view.id"
          type="button"
          class="rail-item"
          :class="{ 'is-active': active?.id === view.id }"
          :aria-current="active?.id === view.id ? 'page' : undefined"
          :title="view.title"
          @click="ctx.views.select(view.id)"
        >
          <Icon :name="view.icon ?? 'dot'" :size="18" />
          <span class="sr-only">{{ view.title }}</span>
        </button>
        <span v-if="!views.length" class="px-2 py-3 text-center text-[10px] leading-tight text-[var(--faint)]">
          {{ loadingViews ? '加载中' : '无视图' }}
        </span>
      </nav>
    </aside>

    <div class="workspace">
      <header class="band">
        <div class="flex min-w-0 items-center gap-3">
          <span class="mark mark-sm sm:hidden" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
            <path d="M4 20V11a8 8 0 0 1 16 0v9" />
            <path d="M8 20v-9a4 4 0 0 1 8 0v9" />
          </svg>
          </span>
          <span v-if="health.info" class="hidden shrink-0 font-mono text-[11px] text-[var(--faint)] sm:inline" :title="health.info.store_id">
            {{ shortId(health.info.store_id, 6) }} · {{ health.info.version }}
          </span>
          <div class="hidden min-w-0 items-center gap-2 sm:flex">
            <Chip :tone="gatewayHealth.tone" :label="gatewayHealth.label" />
            <Chip
              v-for="panel in health.panels"
              :key="panel.instanceId"
              :tone="panel.tone"
              :label="`${panel.title} · ${panel.label}`"
              :title="panel.detail"
            />
          </div>
          <button
            type="button"
            class="rounded-full sm:hidden"
            :aria-expanded="healthOpen"
            aria-haspopup="true"
            aria-label="展开健康详情"
            @click="healthOpen = !healthOpen"
          >
            <Chip :tone="rollup.tone" :label="rollup.label" />
          </button>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <span class="whitespace-nowrap text-[11px] text-[var(--faint)]">
            {{ health.paused ? '已暂停刷新' : stale ? '数据已过期' : `更新于 ${updatedText}` }}
          </span>
          <template v-if="confirmDisconnect">
            <button type="button" class="btn btn-sm btn-danger" @click="disconnect">断开</button>
            <button type="button" class="btn btn-sm btn-quiet" @click="confirmDisconnect = false">取消</button>
          </template>
          <template v-else>
            <button
              type="button"
              class="btn btn-sm btn-icon btn-quiet"
              :title="health.paused ? '恢复自动刷新' : '暂停自动刷新'"
              :aria-label="health.paused ? '恢复自动刷新' : '暂停自动刷新'"
              @click="togglePolling"
            >
              <Icon :name="health.paused ? 'play' : 'pause'" :size="14" />
            </button>
            <button type="button" class="btn btn-sm btn-icon btn-quiet" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
              <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="14" />
            </button>
            <button type="button" class="btn btn-sm btn-icon btn-quiet" title="断开连接" aria-label="断开连接" @click="confirmDisconnect = true">
              <Icon name="logout" :size="14" />
            </button>
          </template>
        </div>
        <div v-if="healthOpen" class="health-pop sm:hidden">
          <div class="health-row">
            <span class="dot" :data-tone="gatewayHealth.tone" />
            <span class="min-w-0 flex-1 truncate">{{ gatewayHealth.label }}</span>
          </div>
          <div v-for="panel in health.panels" :key="panel.instanceId" class="health-row">
            <span class="dot" :data-tone="panel.tone" />
            <span class="min-w-0 flex-1 truncate">{{ panel.title }}</span>
            <span class="text-[var(--muted)]">{{ panel.label }}</span>
          </div>
          <p v-if="!health.panels.length" class="px-3 py-2 text-[11px] text-[var(--muted)]">插件尚未登记面板。</p>
        </div>
      </header>

      <nav class="mobile-nav" aria-label="视图">
        <button
          v-for="view in views"
          :key="view.id"
          type="button"
          class="mobile-nav-item"
          :class="{ 'is-active': active?.id === view.id }"
          :aria-current="active?.id === view.id ? 'page' : undefined"
          @click="ctx.views.select(view.id)"
        >
          <Icon :name="view.icon ?? 'dot'" :size="14" />
          {{ view.title }}
        </button>
      </nav>

      <div class="view-host">
        <p v-if="loadError" role="alert" class="notice-bad mx-4 mt-4 sm:mx-6">{{ loadError }}</p>
        <p v-if="failures.length" role="alert" class="notice-warn mx-4 mt-4 sm:mx-6">
          部分插件视图加载失败
          <span v-for="failure in failures" :key="failure" class="mt-1 block font-mono text-[11px] leading-relaxed">{{ failure }}</span>
        </p>

        <RouterView v-if="active" />
        <div v-else class="px-6 py-16 text-center text-[13px] text-[var(--muted)]">
          {{ loadingViews ? '正在加载插件视图…' : '没有已启用的插件视图。' }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px 16px;
}

.login-card {
  width: 100%;
  max-width: 360px;
  padding: 32px 28px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}

.login-title {
  font-size: 21px;
  line-height: 1.3;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.login-error {
  margin: 12px 0 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in oklab, var(--bad) 35%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in oklab, var(--bad) 8%, var(--surface));
  color: var(--bad);
  font-size: 12px;
  line-height: 1.5;
}

.mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--accent);
  color: var(--accent-ink);
}

.mark-sm {
  width: 30px;
  height: 30px;
  border-radius: 6px;
}

.shell {
  display: grid;
  grid-template-columns: var(--rail) minmax(0, 1fr);
  min-height: 100vh;
}

.rail {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  height: 100vh;
  padding: 12px 0;
  border-right: 1px solid var(--line);
  background: var(--surface);
}

.rail-nav {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.rail-marker {
  position: absolute;
  top: 7px;
  left: 0;
  width: 2px;
  height: 30px;
  background: var(--accent);
  transition: transform 220ms var(--ease);
}

.rail-item {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--fast) var(--ease), background-color var(--fast) var(--ease);
}

.rail-item:hover {
  background: var(--surface-hi);
  color: var(--text);
}

.rail-item.is-active {
  background: var(--surface-hi);
  color: var(--accent);
}

.workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.band {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: var(--band);
  padding: 0 16px 0 20px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in oklab, var(--canvas) 88%, transparent);
  backdrop-filter: blur(8px);
}

.health-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 8px;
  left: 8px;
  z-index: 30;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: 0 12px 32px color-mix(in oklab, #000 28%, transparent);
}

.health-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  font-size: 12px;
}

.health-row + .health-row {
  border-top: 1px solid var(--line);
}

.mobile-nav {
  display: none;
}

.view-host {
  flex: 1;
  min-width: 0;
}

.notice-bad,
.notice-warn {
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  font-size: 12px;
  line-height: 1.5;
}

.notice-bad {
  border: 1px solid color-mix(in oklab, var(--bad) 35%, var(--line));
  background: color-mix(in oklab, var(--bad) 8%, var(--surface));
  color: var(--bad);
}

.notice-warn {
  border: 1px solid color-mix(in oklab, var(--warn) 35%, var(--line));
  background: color-mix(in oklab, var(--warn) 8%, var(--surface));
  color: var(--warn);
}

@media (max-width: 639px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .rail {
    display: none;
  }

  .band {
    height: 52px;
    padding: 0 12px;
  }

  .mobile-nav {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--canvas);
    scrollbar-width: none;
    mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
  }

  .mobile-nav::-webkit-scrollbar {
    display: none;
  }

  .mobile-nav-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    height: 30px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }

  .mobile-nav-item.is-active {
    border-color: var(--line-strong);
    background: var(--surface);
    color: var(--text);
  }
}
</style>

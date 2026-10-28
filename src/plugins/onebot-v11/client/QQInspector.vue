<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ViewClient } from '@imbrex/ui-contract';
import { Chip, CopyButton, EmptyState, ErrorNotice, JsonBlock, RelativeTime, failureOf, isAbort } from '@imbrex/ui-contract/ui';

interface PageResult<T> { items: T[]; total: number; has_more: boolean; next_offset: number | null }
interface Group { group_id: string; group_name: string | null }
interface GroupInfo { group_id: string; group_name: string | null; member_count: number | null; max_member_count: number | null }
interface Member { user_id: string; nickname: string | null; card: string | null; role: string | null }
interface Friend { user_id: string; nickname: string | null; remark: string | null }
interface EventRecord {
  seq: string;
  accepted_at: string;
  event: { source: string; id: string; type: string; data: unknown };
}
interface EventPage { records: EventRecord[]; next_after_seq: string; caught_up: boolean }

const props = defineProps<{
  client: ViewClient;
  instanceId: string;
  storeId: string;
}>();

const tab = ref<'groups' | 'friends' | 'requests'>('groups');
const groups = shallowRef<Group[]>([]);
const groupTotal = ref(0);
const groupNext = ref<number | null>(null);
const groupLoading = ref(false);
const groupError = ref<unknown>(null);
const selectedGroupId = ref('');
const groupInfo = shallowRef<GroupInfo | null>(null);
const groupInfoError = ref<unknown>(null);
const members = shallowRef<Member[]>([]);
const memberTotal = ref(0);
const memberNext = ref<number | null>(null);
const memberLoading = ref(false);
const memberError = ref<unknown>(null);
const friends = shallowRef<Friend[]>([]);
const friendTotal = ref(0);
const friendNext = ref<number | null>(null);
const friendLoading = ref(false);
const friendError = ref<unknown>(null);
const latestSeq = ref('0');
const requests = shallowRef<EventRecord[]>([]);
const requestStart = ref('0');
const requestWindowed = ref(false);
const requestLoaded = ref(false);
const requestLoading = ref(false);
const requestError = ref<unknown>(null);
const requestCaughtUp = ref(false);
const cursor = { friend: '0', group: '0' };
let caught = { friend: false, group: false };
let groupSequence = 0;
let requestSequence = 0;
let disposed = false;
const controller = new AbortController();

const memberCount = computed(() => (groupInfo.value?.member_count === null || groupInfo.value?.member_count === undefined ? '未知' : String(groupInfo.value.member_count)));

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function roleLabel(role: string | null): string {
  if (role === 'owner') return '群主';
  if (role === 'admin') return '管理员';
  if (role === 'member') return '成员';
  return '未知';
}

function errorText(cause: unknown): string {
  const info = failureOf(cause);
  if (info.status === 0) return '无法连接管理 API。';
  if (info.status === 403) return '管理员凭据缺少 capabilities:invoke、具体 QQ 只读能力或 read_sources；这是授权不足，不是 QQ 离线。';
  if (info.status === 404) return '能力或实例未登记，可能已停止或卸载。';
  if (info.status === 429) return '该实例正在执行另一个动作，请稍后重试。';
  if (info.status === 503) return '提供方尚未就绪或连接不可用。';
  if (info.status === 400) return '能力参数未通过服务端校验。';
  return '读取失败：' + (info.code ?? 'request_failed');
}

async function invoke<T>(localName: string, params: Record<string, unknown>): Promise<T> {
  const capability = props.instanceId + '.' + localName;
  const response = await props.client.request<{ kind: string; result?: unknown }>(
    '/api/admin/capabilities/' + encodeURIComponent(capability) + '/invoke',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: props.storeId, params }),
      signal: controller.signal,
    },
  );
  if (response.kind !== 'result') throw new Error('Unexpected capability result');
  return response.result as T;
}

async function loadInfo(): Promise<void> {
  try {
    const info = await props.client.request<{ latest_seq: string }>('/api/admin/info', { signal: controller.signal });
    latestSeq.value = info.latest_seq;
  } catch {
    // Requests can still be read from sequence zero when info is unavailable.
  }
}

async function loadGroups(append = false): Promise<void> {
  if (groupLoading.value) return;
  const offset = append ? groupNext.value ?? 0 : 0;
  groupLoading.value = true;
  try {
    const page = await invoke<PageResult<Group>>('list_groups', { limit: 50, offset });
    groups.value = append ? [...groups.value, ...page.items] : page.items;
    groupTotal.value = page.total;
    groupNext.value = page.has_more ? page.next_offset : null;
    groupError.value = null;
    if (!append && !selectedGroupId.value && page.items[0]) void selectGroup(page.items[0].group_id);
  } catch (cause) {
    if (!isAbort(cause)) groupError.value = cause;
  } finally {
    groupLoading.value = false;
  }
}

async function selectGroup(id: string): Promise<void> {
  if (selectedGroupId.value === id && (groupInfo.value || memberLoading.value)) return;
  selectedGroupId.value = id;
  groupInfo.value = null;
  groupInfoError.value = null;
  members.value = [];
  memberTotal.value = 0;
  memberNext.value = null;
  memberError.value = null;
  const sequence = ++groupSequence;
  memberLoading.value = true;
  try {
    const [info, page] = await Promise.all([
      invoke<GroupInfo>('get_group_info', { group_id: id }),
      invoke<PageResult<Member>>('list_group_members', { group_id: id, limit: 20, offset: 0 }),
    ]);
    if (disposed || sequence !== groupSequence) return;
    groupInfo.value = info;
    members.value = page.items;
    memberTotal.value = page.total;
    memberNext.value = page.has_more ? page.next_offset : null;
  } catch (cause) {
    if (disposed || sequence !== groupSequence || isAbort(cause)) return;
    groupInfoError.value = cause;
    memberError.value = cause;
  } finally {
    if (sequence === groupSequence) memberLoading.value = false;
  }
}

async function loadMoreMembers(): Promise<void> {
  if (!selectedGroupId.value || memberLoading.value || memberNext.value === null) return;
  const sequence = groupSequence;
  memberLoading.value = true;
  try {
    const page = await invoke<PageResult<Member>>('list_group_members', { group_id: selectedGroupId.value, limit: 20, offset: memberNext.value });
    if (disposed || sequence !== groupSequence) return;
    members.value = [...members.value, ...page.items];
    memberTotal.value = page.total;
    memberNext.value = page.has_more ? page.next_offset : null;
    memberError.value = null;
  } catch (cause) {
    if (!isAbort(cause)) memberError.value = cause;
  } finally {
    if (sequence === groupSequence) memberLoading.value = false;
  }
}

async function loadFriends(append = false): Promise<void> {
  if (friendLoading.value) return;
  const offset = append ? friendNext.value ?? 0 : 0;
  friendLoading.value = true;
  try {
    const page = await invoke<PageResult<Friend>>('list_friends', { limit: 50, offset });
    friends.value = append ? [...friends.value, ...page.items] : page.items;
    friendTotal.value = page.total;
    friendNext.value = page.has_more ? page.next_offset : null;
    friendError.value = null;
  } catch (cause) {
    if (!isAbort(cause)) friendError.value = cause;
  } finally {
    friendLoading.value = false;
  }
}

function requestDefaultStart(): string {
  try {
    const latest = BigInt(latestSeq.value);
    return latest > 1000n ? (latest - 1000n).toString() : '0';
  } catch {
    return '0';
  }
}

function resetRequestWindow(fromStart: 'recent' | 'zero'): void {
  const start = fromStart === 'recent' ? requestDefaultStart() : '0';
  requestStart.value = start;
  requestWindowed.value = start !== '0';
  cursor.friend = start;
  cursor.group = start;
  caught = { friend: false, group: false };
  requests.value = [];
  requestCaughtUp.value = false;
  requestLoaded.value = false;
  void loadRequests();
}

async function fetchRequests(kind: 'friend' | 'group'): Promise<{ records: EventRecord[]; next: string; caughtUp: boolean }> {
  const type = kind === 'friend' ? 'qq.request.friend' : 'qq.request.group';
  const params = new URLSearchParams({ store_id: props.storeId, after_seq: cursor[kind], limit: '100', type });
  const page = await props.client.request<EventPage>('/api/admin/events?' + params.toString(), { signal: controller.signal });
  return {
    records: page.records.filter((item) => item.event.type === type),
    next: page.next_after_seq,
    caughtUp: page.caught_up,
  };
}

async function loadRequests(): Promise<void> {
  if (requestLoading.value || !props.storeId) return;
  const sequence = ++requestSequence;
  requestLoading.value = true;
  requestError.value = null;
  try {
    const [friendPage, groupPage] = await Promise.all([
      caught.friend ? null : fetchRequests('friend'),
      caught.group ? null : fetchRequests('group'),
    ]);
    if (disposed || sequence !== requestSequence) return;
    const found = new Map<string, EventRecord>();
    for (const item of requests.value) found.set(item.event.source + '\u0000' + item.event.id, item);
    for (const item of friendPage?.records ?? []) found.set(item.event.source + '\u0000' + item.event.id, item);
    for (const item of groupPage?.records ?? []) found.set(item.event.source + '\u0000' + item.event.id, item);
    requests.value = [...found.values()].sort((a, b) => (BigInt(b.seq) > BigInt(a.seq) ? 1 : BigInt(b.seq) < BigInt(a.seq) ? -1 : 0));
    if (friendPage) { cursor.friend = friendPage.next; caught.friend = friendPage.caughtUp; }
    if (groupPage) { cursor.group = groupPage.next; caught.group = groupPage.caughtUp; }
    requestCaughtUp.value = caught.friend && caught.group;
    requestLoaded.value = true;
  } catch (cause) {
    if (!disposed && sequence === requestSequence && !isAbort(cause)) requestError.value = cause;
  } finally {
    if (sequence === requestSequence) requestLoading.value = false;
  }
}

function openRequests(): void {
  if (requestLoaded.value || requestLoading.value) return;
  void loadInfo().then(() => resetRequestWindow('recent'));
}

function recentRequests(): void {
  void loadInfo().then(() => resetRequestWindow('recent'));
}

function allRequests(): void {
  void loadInfo().then(() => resetRequestWindow('zero'));
}

function requestLabel(item: EventRecord): string {
  const data = record(item.event.data);
  if (data?.request_type === 'group') return '群申请';
  if (data?.request_type === 'friend') return '好友申请';
  return item.event.type;
}

function requestRef(item: EventRecord): string {
  return JSON.stringify({ source: item.event.source, id: item.event.id });
}

function refreshTab(): void {
  if (tab.value === 'groups') {
    void loadGroups();
    if (selectedGroupId.value) {
      groupInfo.value = null;
      groupInfoError.value = null;
      void selectGroup(selectedGroupId.value);
    }
  } else if (tab.value === 'friends') {
    void loadFriends();
  } else {
    if (requestWindowed.value) recentRequests(); else allRequests();
  }
}

onMounted(() => {
  void loadInfo();
  void loadGroups();
  void loadFriends();
});
onUnmounted(() => { disposed = true; controller.abort(); });
</script>

<template>
  <section class="panel overflow-hidden">
    <header class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">QQ 只读排查</h2>
        <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">
          使用当前管理员身份读取授权目录、成员与请求事实；这里不执行发送、撤回或群管。
          空列表可能是没有命中 read_sources，或管理员缺少 events:read；可在“能力与调用 → 主体能力诊断”确认。
        </p>
      </div>
      <button type="button" class="btn btn-sm" :disabled="groupLoading || friendLoading || requestLoading" @click="refreshTab">刷新</button>
    </header>

    <div class="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2">
      <button type="button" class="btn btn-sm" :class="tab === 'groups' ? 'btn-primary' : 'btn-quiet'" :aria-pressed="tab === 'groups'" @click="tab = 'groups'">群组</button>
      <button type="button" class="btn btn-sm" :class="tab === 'friends' ? 'btn-primary' : 'btn-quiet'" :aria-pressed="tab === 'friends'" @click="tab = 'friends'">好友</button>
      <button type="button" class="btn btn-sm" :class="tab === 'requests' ? 'btn-primary' : 'btn-quiet'" :aria-pressed="tab === 'requests'" @click="tab = 'requests'; openRequests()">请求</button>
    </div>

    <div v-if="tab === 'groups'" class="p-4">
      <ErrorNotice v-if="groupError" :error="groupError" title="群组目录读取失败" :detail="errorText(groupError)" retry @retry="loadGroups()" />
      <div class="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section class="rounded border border-[var(--line)]">
          <header class="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2">
            <span class="text-xs font-medium">可见群组</span>
            <span class="meta">{{ groupTotal }}</span>
          </header>
          <div v-if="groups.length" class="rows max-h-[22rem] overflow-y-auto">
            <button
              v-for="group in groups"
              :key="group.group_id"
              type="button"
              class="row-link flex items-baseline gap-2 px-3 py-2 text-left"
              :aria-current="selectedGroupId === group.group_id ? 'true' : undefined"
              @click="selectGroup(group.group_id)"
            >
              <span class="min-w-0 flex-1 truncate text-xs">{{ group.group_name || '未命名群组' }}</span>
              <span class="font-mono text-[10px] text-[var(--faint)]">{{ group.group_id }}</span>
            </button>
          </div>
          <EmptyState v-else-if="!groupLoading && !groupError" title="没有可见群组" description="当前管理员的主体没有命中群组来源授权，或缺少 events:read；请先核对能力诊断。" />
          <p v-else-if="groupLoading" class="px-3 py-6 text-center text-xs text-[var(--muted)]">正在读取群组…</p>
          <footer v-if="groupNext !== null" class="rule px-3 py-2">
            <button type="button" class="btn btn-sm" :disabled="groupLoading" @click="loadGroups(true)">加载更多</button>
          </footer>
        </section>

        <section class="min-w-0">
          <ErrorNotice v-if="groupInfoError" :error="groupInfoError" title="群组成员读取失败" :detail="errorText(groupInfoError)" />
          <template v-if="selectedGroupId">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-semibold">{{ groupInfo?.group_name || selectedGroupId }}</span>
              <span class="font-mono text-[11px] text-[var(--faint)]">{{ selectedGroupId }}</span>
              <Chip tone="idle" :label="`成员 ${memberCount}`" />
            </div>
            <div class="mt-3 overflow-x-auto rounded border border-[var(--line)]">
              <table class="table min-w-[30rem]">
                <thead><tr><th>成员</th><th>昵称</th><th>群名片</th><th>角色</th></tr></thead>
                <tbody>
                  <tr v-for="member in members" :key="member.user_id">
                    <td class="font-mono text-xs">{{ member.user_id }}</td>
                    <td class="text-xs">{{ member.nickname || '—' }}</td>
                    <td class="text-xs">{{ member.card || '—' }}</td>
                    <td class="text-xs text-[var(--muted)]">{{ roleLabel(member.role) }}</td>
                  </tr>
                  <tr v-if="!members.length && !memberLoading">
                    <td colspan="4"><EmptyState title="没有可见成员" description="群组为空，或成员来源未被授权。" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="mt-2 flex items-center justify-between gap-2">
              <p class="meta">已加载 {{ members.length }} / {{ memberTotal }}</p>
              <button v-if="memberNext !== null" type="button" class="btn btn-sm" :disabled="memberLoading" @click="loadMoreMembers">
                {{ memberLoading ? '加载中…' : '加载更多成员' }}
              </button>
              <span v-else-if="memberLoading" class="text-[11px] text-[var(--muted)]">正在读取成员…</span>
            </div>
          </template>
          <p v-else class="text-xs text-[var(--muted)]">选择一个群组查看授权成员。</p>
        </section>
      </div>
    </div>

    <div v-else-if="tab === 'friends'" class="p-4">
      <ErrorNotice v-if="friendError" :error="friendError" title="好友目录读取失败" :detail="errorText(friendError)" retry @retry="loadFriends()" />
      <div class="overflow-x-auto rounded border border-[var(--line)]">
        <table class="table min-w-[30rem]">
          <thead><tr><th>好友</th><th>昵称</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="friend in friends" :key="friend.user_id">
              <td class="font-mono text-xs">{{ friend.user_id }}</td>
              <td class="text-xs">{{ friend.nickname || '—' }}</td>
              <td class="text-xs">{{ friend.remark || '—' }}</td>
            </tr>
            <tr v-if="!friends.length && !friendLoading && !friendError">
              <td colspan="3"><EmptyState title="没有可见好友" description="当前管理员的主体没有命中好友来源授权，或缺少 events:read；请先核对能力诊断。" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-2 flex items-center justify-between gap-2">
        <p class="meta">已加载 {{ friends.length }} / {{ friendTotal }}</p>
        <button v-if="friendNext !== null" type="button" class="btn btn-sm" :disabled="friendLoading" @click="loadFriends(true)">
          {{ friendLoading ? '加载中…' : '加载更多好友' }}
        </button>
        <span v-else-if="friendLoading" class="text-[11px] text-[var(--muted)]">正在读取好友…</span>
      </div>
    </div>

    <div v-else class="p-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="meta">从序号 #{{ requestStart }} 起读取</span>
        <button type="button" class="btn btn-sm" :disabled="requestLoading" @click="recentRequests">最近 1000 序号</button>
        <button type="button" class="btn btn-sm" :disabled="requestLoading" @click="allRequests">从头读取</button>
        <button v-if="!requestCaughtUp" type="button" class="btn btn-sm" :disabled="requestLoading || !requestLoaded" @click="loadRequests">
          {{ requestLoading ? '加载中…' : '加载更多' }}
        </button>
        <span v-if="requestCaughtUp && requestLoaded" class="text-[11px] text-[var(--faint)]">已到最新</span>
      </div>
      <p class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        请求事实来自事件日志；序号是位置，不是积压条数。默认窗口只是读取范围，不表示此前没有请求。
        <span v-if="requestWindowed">当前从 #{{ requestStart }} 开始。</span>
      </p>
      <ErrorNotice v-if="requestError" :error="requestError" title="请求事实读取失败" :detail="errorText(requestError)" retry @retry="loadRequests" />
      <div v-if="requests.length" class="mt-3 flex flex-col gap-2">
        <article v-for="item in requests" :key="item.event.source + '/' + item.event.id" class="rounded border border-[var(--line)] p-3">
          <div class="flex flex-wrap items-center gap-2">
            <Chip tone="warn" :label="requestLabel(item)" />
            <span class="font-mono text-[11px] text-[var(--faint)]">#{{ item.seq }}</span>
            <RelativeTime :value="item.accepted_at" class="text-[11px] text-[var(--muted)]" />
            <CopyButton :value="requestRef(item)" label="复制事件引用" />
          </div>
          <p class="mt-2 break-all font-mono text-[11px] text-[var(--muted)]">{{ item.event.source }}</p>
          <p class="mt-1 text-xs">用户 {{ text(record(item.event.data)?.user_id, '未知') }}<span v-if="record(item.event.data)?.group_id" class="ml-2 text-[var(--muted)]">群 {{ text(record(item.event.data)?.group_id) }}</span></p>
          <p v-if="text(record(item.event.data)?.comment)" class="mt-1 break-words text-xs text-[var(--muted)]">留言：{{ text(record(item.event.data)?.comment) }}</p>
          <details class="mt-2">
            <summary class="cursor-pointer text-[11px] text-[var(--muted)]">请求原始数据</summary>
            <div class="mt-1"><JsonBlock :value="item.event.data" :max-height="180" /></div>
          </details>
        </article>
      </div>
      <EmptyState v-else-if="requestLoaded && !requestLoading && !requestError" title="当前范围没有请求" description="尝试扩大读取范围，或到事件浏览中查看完整请求事实。" />
      <p v-else-if="requestLoading" class="py-6 text-center text-xs text-[var(--muted)]">正在读取请求事实…</p>
    </div>
  </section>
</template>

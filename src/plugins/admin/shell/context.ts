import { Context } from 'cordis';
import { shallowRef } from 'vue';
import type { ViewClient, ViewDescriptor, Views } from '@imbrex/ui-contract';
import { request } from './api';
import { router } from './router';
import { hostView } from './host-view';

function hashId(): string {
  const match = /^#\/([a-z][a-z0-9_-]{0,63})(?:\?.*)?$/.exec(location.hash);
  return match?.[1] ?? '';
}

export const client: ViewClient = {
  request: <T>(path: string, init?: RequestInit) => request<T>(path, init),
};

class Registry implements Views {
  private entries = shallowRef<ViewDescriptor[]>([]);
  private activeId = shallowRef('');
  private requested = hashId();
  // Plugin query (instance/tab) belongs to the deep link, not to the route, and
  // must survive the first-view fallback that happens before the target view
  // registers.
  private requestedQuery = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : '';
  private userSelected = false;
  private syncing = false;

  constructor() {
    router.afterEach((to) => {
      const id = typeof to.name === 'string' ? to.name : '';
      if (!this.entries.value.some((entry) => entry.id === id)) return;
      this.activeId.value = id;
      if (!this.syncing) this.userSelected = true;
    });
  }

  private navigate(id: string, replace = false): void {
    this.syncing = true;
    const navigation = replace ? router.replace('/' + id) : router.push('/' + id);
    void navigation.finally(() => { this.syncing = false; });
  }

  register(view: ViewDescriptor): () => void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(view.id)) throw new Error('Invalid admin view id');
    if (this.entries.value.some((entry) => entry.id === view.id)) throw new Error(`Admin view already registered: ${view.id}`);
    const entry = view;
    this.entries.value = [...this.entries.value, entry].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    router.addRoute({ path: '/' + entry.id, name: entry.id, component: hostView(entry.mount, client), meta: { title: entry.title } });
    if (this.requested === entry.id) {
      this.userSelected = true;
      this.activeId.value = entry.id;
      this.navigate(entry.id + this.requestedQuery, true);
    } else if (!this.activeId.value) {
      const first = this.entries.value[0]!;
      this.activeId.value = first.id;
      this.navigate(first.id, true);
    } else if (!this.userSelected && this.entries.value[0]!.id !== this.activeId.value) {
      const first = this.entries.value[0]!;
      this.activeId.value = first.id;
      this.navigate(first.id, true);
    }
    return () => {
      router.removeRoute(entry.id);
      this.entries.value = this.entries.value.filter((value) => value !== entry);
      if (this.activeId.value === entry.id) {
        const first = this.entries.value[0];
        this.activeId.value = first?.id ?? '';
        if (first) this.navigate(first.id, true);
        else void router.replace('/');
      }
    };
  }

  list(): ViewDescriptor[] {
    return this.entries.value;
  }

  active(): ViewDescriptor | undefined {
    return this.entries.value.find((entry) => entry.id === this.activeId.value) ?? this.entries.value[0];
  }

  select(id: string): void {
    this.requested = id;
    if (!this.entries.value.some((entry) => entry.id === id)) return;
    this.userSelected = true;
    this.activeId.value = id;
    this.navigate(id);
  }
}

const views = new Registry();

export const ctx = new Context();
ctx.provide('views', views);
ctx.provide('client', client);

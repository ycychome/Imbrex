import { Context } from 'cordis';
import { shallowRef } from 'vue';
import type { AdminClient, AdminView, AdminViews } from './client-api';
import { request } from './api';

function hashId(): string {
  const match = /^#\/([a-z][a-z0-9_-]{0,63})$/.exec(location.hash);
  return match?.[1] ?? '';
}

class Views implements AdminViews {
  private entries = shallowRef<AdminView[]>([]);
  private activeId = shallowRef('');
  private requested = hashId();
  private userSelected = false;
  syncing = false;

  private apply(id: string): void {
    if (!this.entries.value.some((entry) => entry.id === id)) return;
    this.activeId.value = id;
    const hash = '#/' + id;
    if (location.hash !== hash) {
      this.syncing = true;
      location.hash = hash;
    }
  }

  register(view: AdminView): () => void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(view.id)) throw new Error('Invalid admin view id');
    if (this.entries.value.some((entry) => entry.id === view.id)) throw new Error(`Admin view already registered: ${view.id}`);
    const entry = view;
    this.entries.value = [...this.entries.value, entry].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    if (this.requested === entry.id) {
      this.userSelected = true;
      this.apply(entry.id);
    } else if (!this.activeId.value) {
      this.apply(this.entries.value[0]!.id);
    } else if (!this.userSelected && this.entries.value[0]!.id !== this.activeId.value) {
      this.apply(this.entries.value[0]!.id);
    }
    return () => {
      this.entries.value = this.entries.value.filter((value) => value !== entry);
      if (this.activeId.value === entry.id) {
        this.activeId.value = '';
        if (this.entries.value[0]) this.apply(this.entries.value[0].id);
      }
    };
  }

  list(): AdminView[] {
    return this.entries.value;
  }

  active(): AdminView | undefined {
    return this.entries.value.find((entry) => entry.id === this.activeId.value) ?? this.entries.value[0];
  }

  select(id: string): void {
    this.requested = id;
    if (!this.entries.value.some((entry) => entry.id === id)) return;
    this.userSelected = true;
    this.apply(id);
  }
}

const views = new Views();
window.addEventListener('hashchange', () => {
  if (views.syncing) { views.syncing = false; return; }
  const id = hashId();
  if (id) views.select(id);
});

export const client: AdminClient = {
  request: <T>(path: string, init?: RequestInit) => request<T>(path, init),
};

export const ctx = new Context();
ctx.provide('views', views);
ctx.provide('client', client);

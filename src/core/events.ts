import { requirePermission, requireSource } from './access.js';
import { fail } from './errors.js';
import type { GatewayStore } from './store.js';
import type { EventRef, Principal, ReadOptions } from './types.js';
import { eventInput, eventRef, readOptions } from './validation.js';

export class Events {
  private listeners = new Set<() => void | Promise<void>>();
  private stopped = false;
  constructor(private store: GatewayStore, private report: (code: string) => void = () => {}) {}

  async append(principal: Principal, storeId: string, value: unknown) {
    if (this.stopped) fail('storage_unavailable');
    const input = eventInput(value);
    requireSource(principal, input.event.source, true);
    for (const parent of input.parents) requireSource(principal, parent.source);
    const result = await this.store.append(storeId, input);
    if (result.status === 'created') {
      for (const listener of this.listeners) {
        Promise.resolve().then(() => { if (!this.stopped && this.listeners.has(listener)) return listener(); }).catch(() => {
          try { this.report('event_notification_failed'); } catch { /* Reporting cannot change a committed receipt. */ }
        });
      }
    }
    return result;
  }
  read(principal: Principal, storeId: string, options: ReadOptions) {
    if (this.stopped) fail('storage_unavailable');
    requirePermission(principal, 'events:read');
    return this.store.read(storeId, readOptions(options), principal.readSources);
  }
  inspect(principal: Principal, storeId: string, options: ReadOptions) {
    if (this.stopped) fail('storage_unavailable');
    requirePermission(principal, 'admin:inspect');
    return this.store.read(storeId, readOptions(options), [{ prefix: '' }]);
  }
  async lookup(principal: Principal, storeId: string, ref: EventRef) {
    if (this.stopped) fail('storage_unavailable');
    const checked = eventRef(ref);
    requireSource(principal, checked.source);
    return await this.store.lookup(storeId, checked) ?? fail('event_not_found');
  }
  onAvailable(listener: () => void | Promise<void>): () => void {
    if (this.stopped) fail('storage_unavailable');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  stop(): void { this.stopped = true; this.listeners.clear(); }
}

import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { requirePermission } from '../core/access.js';
import { json, string } from '../core/validation.js';
import type { JsonValue, Principal } from '../core/types.js';

export interface AdminPanel {
  title: string; icon: string;
  read(): JsonValue | Promise<JsonValue>;
}
interface Entry {
  instanceId: string; generation: string; signal: AbortSignal; panel: AdminPanel;
  reading?: Promise<JsonValue>;
}
export class AdminRegistry {
  private entries = new Map<string, Entry>();
  register(instanceId: string, signal: AbortSignal, panel: AdminPanel): () => void {
    if (signal.aborted) fail('provider_unavailable');
    if (this.entries.has(instanceId)) fail('invalid_request', 'Admin panel already registered');
    if (this.entries.size >= 128) fail('payload_too_large');
    const descriptor = { ...panel, title: string(panel.title, 256), icon: string(panel.icon, 64) };
    const entry: Entry = { instanceId, generation: randomUUID(), signal, panel: descriptor };
    this.entries.set(instanceId, entry);
    return () => { if (this.entries.get(instanceId) === entry) this.entries.delete(instanceId); };
  }
  list(principal: Principal) {
    requirePermission(principal, 'admin:inspect');
    return [...this.entries.values()].filter((entry) => !entry.signal.aborted).map((entry) => ({
      instance_id: entry.instanceId, generation: entry.generation, title: entry.panel.title, icon: entry.panel.icon,
    }));
  }
  private entry(instanceId: string): Entry {
    const entry = this.entries.get(instanceId) ?? fail('not_found');
    if (entry.signal.aborted) fail('provider_unavailable');
    return entry;
  }
  async read(principal: Principal, instanceId: string) {
    requirePermission(principal, 'admin:inspect');
    const entry = this.entry(instanceId);
    if (entry.reading) fail('busy');
    const reading = Promise.resolve().then(() => {
      if (entry.signal.aborted || this.entries.get(instanceId) !== entry) fail('provider_unavailable');
      return entry.panel.read();
    }).then((value) => json(value, 65536, 'invalid_request'));
    entry.reading = reading;
    reading.then(() => { entry.reading = undefined; }, () => { entry.reading = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Panel timeout')), 5000); })]);
      if (entry.signal.aborted || this.entries.get(instanceId) !== entry) fail('provider_unavailable');
      return { instance_id: instanceId, generation: entry.generation, data };
    } catch { return { instance_id: instanceId, generation: entry.generation, error: { code: 'admin_panel_read_failed', message: 'Panel data unavailable.' } }; }
    finally { clearTimeout(timer); }
  }
}

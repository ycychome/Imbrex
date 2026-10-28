import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { requirePermission } from '../core/access.js';
import { compileSchema } from '../core/schema.js';
import { fields, json, limits, namespacePattern, object, string } from '../core/validation.js';
import type { JsonValue, Principal } from '../core/types.js';

export const panelTones = ['ok', 'warning', 'error', 'idle', 'unknown'] as const;
export type PanelTone = typeof panelTones[number];
export interface PanelStatus { tone: PanelTone; label: string }
export interface PanelMetric { label: string; value: string; hint?: string }
export interface PanelView {
  status: PanelStatus;
  metrics: PanelMetric[];
  data: Record<string, JsonValue>;
}
export interface AdminAction {
  id: string; title: string; inputSchema: unknown; confirmText?: string;
  execute(input: JsonValue, principal: Principal): Promise<JsonValue>;
}
export interface AdminPanel {
  title: string; icon: string;
  read(): PanelView | Promise<PanelView>;
  actions?: AdminAction[];
}
interface Entry {
  instanceId: string; module: string; generation: string; signal: AbortSignal; panel: AdminPanel;
  actions: Map<string, { action: AdminAction; schema: JsonValue; validate: (input: unknown) => boolean }>;
  reading?: Promise<PanelView>; operating?: Promise<JsonValue>;
}

// Validate the declarative panel shape so a broken or legacy plugin cannot make
// the console depend on arbitrary module-specific payloads.
function panelView(value: JsonValue): PanelView {
  const item = object(value);
  fields(item, ['status', 'metrics', 'data'], ['status', 'metrics', 'data']);
  const status = object(item.status);
  fields(status, ['tone', 'label'], ['tone', 'label']);
  const tone = string(status.tone, 16);
  if (!panelTones.includes(tone as PanelTone)) fail('invalid_request');
  const label = string(status.label, 256);
  if (!Array.isArray(item.metrics) || item.metrics.length > 32) fail('invalid_request');
  const metrics = item.metrics.map((entry): PanelMetric => {
    const metric = object(entry);
    fields(metric, ['label', 'value', 'hint'], ['label', 'value']);
    return { label: string(metric.label, 128), value: string(metric.value, 512),
      ...(metric.hint === undefined ? {} : { hint: string(metric.hint, 512) }),
    };
  });
  const data = json(item.data, limits.httpBytes, 'invalid_request');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('invalid_request');
  return { status: { tone: tone as PanelTone, label }, metrics, data: data as Record<string, JsonValue> };
}

export class AdminRegistry {
  private entries = new Map<string, Entry>();
  register(instanceId: string, module: string, signal: AbortSignal, panel: AdminPanel): () => void {
    if (signal.aborted) fail('provider_unavailable');
    if (this.entries.has(instanceId)) fail('invalid_request', 'Admin panel already registered');
    if (this.entries.size >= 128) fail('payload_too_large');
    const descriptor = { ...panel, title: string(panel.title, 256), icon: string(panel.icon, 64) };
    const actions: Entry['actions'] = new Map();
    if ((panel.actions?.length ?? 0) > 16) fail('payload_too_large');
    for (const action of panel.actions ?? []) {
      if (!namespacePattern.test(action.id) || actions.has(action.id)) fail('invalid_request');
      const checked = { ...action, title: string(action.title, 256), ...(action.confirmText ? { confirmText: string(action.confirmText, 1024) } : {}) };
      const { schema, validate } = compileSchema(action.inputSchema);
      actions.set(action.id, { action: checked, schema, validate });
    }
    const entry: Entry = { instanceId, module, generation: randomUUID(), signal, panel: descriptor, actions };
    this.entries.set(instanceId, entry);
    return () => { if (this.entries.get(instanceId) === entry) this.entries.delete(instanceId); };
  }
  list(principal: Principal) {
    requirePermission(principal, 'admin:inspect');
    return [...this.entries.values()].filter((entry) => !entry.signal.aborted).map((entry) => ({
      instance_id: entry.instanceId, module: entry.module, generation: entry.generation, title: entry.panel.title, icon: entry.panel.icon,
      actions: [...entry.actions.values()].map(({ action, schema }) => ({ id: action.id, title: action.title, input_schema: schema, ...(action.confirmText ? { confirm_text: action.confirmText } : {}) })),
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
    }).then((value) => panelView(json(value, limits.httpBytes, 'invalid_request')));
    entry.reading = reading;
    reading.then(() => { entry.reading = undefined; }, () => { entry.reading = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Panel timeout')), 5000); })]);
      if (entry.signal.aborted || this.entries.get(instanceId) !== entry) fail('provider_unavailable');
      return { instance_id: instanceId, module: entry.module, generation: entry.generation, data };
    } catch { return { instance_id: instanceId, module: entry.module, generation: entry.generation, error: { code: 'admin_panel_read_failed', message: 'Panel data unavailable.' } }; }
    finally { clearTimeout(timer); }
  }
  async execute(principal: Principal, instanceId: string, generation: string, actionId: string, input: unknown): Promise<JsonValue> {
    requirePermission(principal, 'admin:operate');
    const entry = this.entry(instanceId);
    if (generation !== entry.generation) fail('admin_conflict');
    if (entry.operating) fail('busy');
    const action = entry.actions.get(actionId) ?? fail('not_found');
    const value = json(input);
    if (!action.validate(value)) fail('invalid_params');
    const work = Promise.resolve().then(() => {
      if (entry.signal.aborted || this.entries.get(instanceId) !== entry) fail('provider_unavailable');
      return action.action.execute(value, principal);
    }).then((value) => json(value, limits.httpBytes));
    entry.operating = work;
    try { return await work; } finally { entry.operating = undefined; }
  }
}

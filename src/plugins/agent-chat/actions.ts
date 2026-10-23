import type { AdminAction } from '../../host/admin-registry.js';
import type { JsonValue, Principal } from '../../core/types.js';

const text = { type: 'string', minLength: 1, maxLength: 256 };
const reason = { type: 'string', minLength: 1, maxLength: 2048 };
const revision = { type: 'string', minLength: 1, maxLength: 64 };
const ids = { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 20 } };
const filter = { type: 'object', properties: { group_ids: ids, private_user_ids: ids }, required: ['group_ids', 'private_user_ids'], additionalProperties: false };
const pi = { type: 'object', properties: { model: text, context_window: { type: 'integer', minimum: 1024, maximum: 2000000 }, system_prompt: { type: 'string', maxLength: 32768 } }, required: ['model', 'context_window', 'system_prompt'], additionalProperties: false };
export function consumerActions(managed: boolean, execute: (id: string, input: JsonValue, principal: Principal) => Promise<JsonValue>): AdminAction[] {
  const definitions: { id: string; title: string; properties: Record<string, unknown> }[] = [
    { id: 'save-filter', title: 'Save consumer filter', properties: { revision, filter } },
    { id: 'recover-input', title: 'Resolve current unconfirmed input', properties: { seq: { type: 'string', minLength: 1, maxLength: 19 }, source: { type: 'string', minLength: 1, maxLength: 1024 }, id: text, disposition: { enum: ['processed', 'abandoned'] }, reason } },
    { id: 'reset-session', title: 'Unlink one conversation session', properties: { source: { type: 'string', minLength: 1, maxLength: 1024 }, session_id: text, reason } },
    { id: 'save-runtime-settings', title: 'Save runtime settings', properties: { revision, turn_timeout_ms: { type: 'integer', minimum: 10, maximum: 600000 } } },
  ];
  if (managed) definitions.push(
    { id: 'save-agent-config', title: 'Save managed Agent configuration', properties: { revision, settings: pi } },
    { id: 'restart-agent', title: 'Apply configuration and restart Agent', properties: { revision, reason } },
  );
  return definitions.map(({ id, title, properties }) => ({ id, title, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, execute: (input, principal) => execute(id, input, principal) }));
}

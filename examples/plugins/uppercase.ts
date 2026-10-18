import type { Context } from 'cordis';
import type {} from '../../src/host/plugin-api.js';

export const name = 'uppercase';
export const inject = ['imbrex'];

export function apply(ctx: Context): void {
  const api = ctx.imbrex.forPlugin(ctx);
  ctx.effect(() => api.capabilities.register<{ text: string }, { text: string }>({
    localName: 'uppercase',
    description: 'Convert fixture text to uppercase without external side effects.',
    schemaVersion: '1',
    isSideEffectful: false,
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 2000 } }, required: ['text'], additionalProperties: false },
    handler: ({ text }) => ({ text: text.toUpperCase() }),
  }));
}

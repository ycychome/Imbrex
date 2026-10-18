import type { Context } from 'cordis';
import type {} from '../host/plugin-api.js';

export const name = 'fixture';
export const inject = ['imbrex'];
export async function apply(ctx: Context): Promise<void> {
  const api = ctx.imbrex.forPlugin(ctx);
  for (const id of ['message-001', 'message-002']) {
    if (api.signal.aborted) return;
    await api.events.append({ event: {
      specversion: '1.0', source: 'imbrex://fixture/messages', id, type: 'fixture.message.created',
      datacontenttype: 'application/json', data: { text: id },
    } });
  }
}

import type { Context } from 'cordis';
import type {} from '../host/plugin-api.js';
import { consume } from './read-loop.js';

export const name = 'transform';
export const inject = ['imbrex'];
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const api = ctx.imbrex.forPlugin(ctx);
  return consume(api, 'imbrex://fixture/messages', 'fixture.message.created', async ({ event }) => {
    if (event.source !== 'imbrex://fixture/messages') return;
    await api.events.append({ event: {
      specversion: '1.0', datacontenttype: 'application/json', source: 'imbrex://fixture/derived',
      id: 'derived-' + event.id, type: 'fixture.message.transformed', data: event.data,
    }, parents: [{ source: event.source, id: event.id }] });
  });
}

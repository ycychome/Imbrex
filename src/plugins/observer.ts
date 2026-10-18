import type { Context } from 'cordis';
import type {} from '../host/plugin-api.js';
import { consume } from './read-loop.js';

export const name = 'observer';
export const inject = ['imbrex'];
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const api = ctx.imbrex.forPlugin(ctx);
  return consume(api, 'imbrex://fixture/', undefined, async () => {});
}

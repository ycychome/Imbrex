import type { Context } from 'cordis';
import type {} from '../../../../web/src/client-api.js';
import Panel from './Panel.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'onebot', title: 'OneBot', order: 30, component: Panel }));
  },
};

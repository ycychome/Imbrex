import type { Context } from 'cordis';
import type {} from '../../../../ui-contract/src/client-api.js';
import Panel from './Panel.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'onebot', title: 'OneBot', icon: 'link', order: 30, component: Panel }));
  },
};

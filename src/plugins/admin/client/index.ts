import type { Context } from 'cordis';
import type {} from '../../../../web/src/client-api.js';
import Config from './Config.vue';
import Overview from './Overview.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'overview', title: '概览', icon: 'overview', order: 0, component: Overview }));
    ctx.effect(() => ctx.views.register({ id: 'config', title: '配置查看', icon: 'sliders', order: 50, component: Config }));
  },
};

import type { Context } from 'cordis';
import type {} from '@imbrex/ui-contract';
import { vueMount } from '@imbrex/ui-contract/vue';
import Panel from './Panel.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'onebot', title: 'OneBot', icon: 'link', order: 30, mount: vueMount(Panel) }));
  },
};

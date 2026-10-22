import type { Context } from 'cordis';
import type {} from '@imbrex/ui-contract';
import { vueMount } from '@imbrex/ui-contract/vue';
import Panel from './Panel.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'agent', title: 'Agent', icon: 'spark', order: 40, mount: vueMount(Panel) }));
  },
};

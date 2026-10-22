import type { Context } from 'cordis';
import type {} from '@imbrex/ui-contract';
import { vueMount } from '@imbrex/ui-contract/vue';
import Calls from './Calls.vue';
import Events from './Events.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'events', title: '事件浏览', icon: 'stream', order: 10, mount: vueMount(Events) }));
    ctx.effect(() => ctx.views.register({ id: 'calls', title: '能力与调用', icon: 'plug', order: 20, mount: vueMount(Calls) }));
  },
};

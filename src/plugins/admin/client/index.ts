import type { Context } from 'cordis';
import type {} from '@imbrex/ui-contract';
import { vueMount } from '@imbrex/ui-contract/vue';
import Config from './Config.vue';
import Instances from './Instances.vue';
import Overview from './Overview.vue';

export default {
  inject: ['views'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.views.register({ id: 'overview', title: '概览', icon: 'overview', order: 0, mount: vueMount(Overview) }));
    ctx.effect(() => ctx.views.register({ id: 'instances', title: '实例', icon: 'server', order: 5, mount: vueMount(Instances) }));
    ctx.effect(() => ctx.views.register({ id: 'config', title: '配置查看', icon: 'sliders', order: 50, mount: vueMount(Config) }));
  },
};

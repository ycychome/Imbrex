import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ViewClient, ViewMount } from '@imbrex/ui-contract';

/** 把框架无关的 ViewMount 包成 vue-router 能用的组件。 */
export function hostView(mount: ViewMount, client: ViewClient) {
  return defineComponent({
    name: 'PluginView',
    setup() {
      const el = ref<HTMLElement | null>(null);
      const controller = new AbortController();
      let teardown: (() => void) | undefined;
      onMounted(() => {
        const result = mount(el.value!, { client, signal: controller.signal });
        if (typeof result === 'function') teardown = result;
      });
      onBeforeUnmount(() => {
        controller.abort();
        teardown?.();
        teardown = undefined;
      });
      return () => h('div', { ref: el, class: 'view-in' });
    },
  });
}

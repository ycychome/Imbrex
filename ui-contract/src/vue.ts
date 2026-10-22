import { createApp, type Component } from 'vue';
import type { ViewContext, ViewMount } from './contract.js';

/**
 * 把 Vue 组件适配成 ViewMount。
 * 默认只注入 client；需要 signal 或其他 props 的插件自己传 extra。
 */
export function vueMount(
  component: Component,
  extra?: (ctx: ViewContext) => Record<string, unknown>,
): ViewMount {
  return (el, ctx) => {
    const app = createApp(component, { client: ctx.client, ...extra?.(ctx) });
    app.config.errorHandler = (error) => { console.error('[plugin-view]', error); };
    app.mount(el);
    return () => { app.unmount(); };
  };
}

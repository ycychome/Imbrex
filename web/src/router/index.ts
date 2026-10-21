import { createRouter, createWebHashHistory } from 'vue-router';
import Config from '../Config.vue';
import Calls from '../Calls.vue';
import Events from '../Events.vue';
import Overview from '../Overview.vue';
import Panels from '../Panels.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'overview', component: Overview, meta: { title: '概览' } },
    { path: '/events', name: 'events', component: Events, meta: { title: '事件浏览' } },
    { path: '/calls', name: 'calls', component: Calls, meta: { title: '能力与调用' } },
    { path: '/panels', name: 'panels', component: Panels, meta: { title: '运行面板' } },
    { path: '/config', name: 'config', component: Config, meta: { title: '配置查看' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

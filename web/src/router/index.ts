import { createRouter, createWebHashHistory } from 'vue-router';
import ConfigView from '../views/ConfigView.vue';
import CallsView from '../views/CallsView.vue';
import EventsView from '../views/EventsView.vue';
import OverviewView from '../views/OverviewView.vue';
import PanelsView from '../views/PanelsView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView, meta: { title: '概览' } },
    { path: '/events', name: 'events', component: EventsView, meta: { title: '事件浏览' } },
    { path: '/calls', name: 'calls', component: CallsView, meta: { title: '能力与调用' } },
    { path: '/panels', name: 'panels', component: PanelsView, meta: { title: '运行面板' } },
    { path: '/config', name: 'config', component: ConfigView, meta: { title: '配置查看' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

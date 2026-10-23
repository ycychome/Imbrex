import { defineComponent, h } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

const Missing = defineComponent({
  name: 'MissingView',
  setup: () => () => h(
    'div',
    { class: 'mx-auto w-full max-w-6xl px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400' },
    '视图未加载。',
  ),
});

// The shell starts with no business routes. Plugin clients add their own
// routes through ctx.views.register(); this catch-all only covers startup and
// unknown hashes.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/:pathMatch(.*)*', name: 'missing', component: Missing }],
});

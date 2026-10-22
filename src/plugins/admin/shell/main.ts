import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { initTheme } from './theme';
import '@imbrex/ui-contract/style.css';

initTheme();
createApp(App).use(router).mount('#app');

import { ref } from 'vue';

/** One shared second tick powers every relative time on screen. */
export const now = ref(Date.now());

window.setInterval(() => {
  now.value = Date.now();
}, 1000);

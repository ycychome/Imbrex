import { onUnmounted, ref } from 'vue';

/** Reactive media query; used to move overlays out of transformed ancestors. */
export function useNarrow(query = '(max-width: 1023px)') {
  const media = window.matchMedia(query);
  const matches = ref(media.matches);
  const update = (event: MediaQueryListEvent): void => { matches.value = event.matches; };
  media.addEventListener('change', update);
  onUnmounted(() => media.removeEventListener('change', update));
  return matches;
}

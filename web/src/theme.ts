import { ref } from 'vue';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'imbrex.admin.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
let explicit: Theme | null = storedTheme();

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function preferred(): Theme {
  return explicit ?? (media.matches ? 'dark' : 'light');
}

export const theme = ref<Theme>('light');

function apply(value: Theme): void {
  theme.value = value;
  document.documentElement.dataset.theme = value;
}

export function toggleTheme(): void {
  explicit = preferred() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, explicit);
  } catch {
    // Storage is optional; the session keeps the in-memory choice.
  }
  apply(explicit);
}

export function initTheme(): void {
  apply(preferred());
  media.addEventListener('change', () => {
    if (explicit === null) apply(preferred());
  });
}

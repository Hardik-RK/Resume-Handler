// Theme preference lives as the `dark` class on <html> (set before first paint by the boot script in index.html) and in
// localStorage. Every access is guarded: storage can be blocked.
const root = () => document.documentElement;
export const THEME_KEY = 'intake-theme';
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };

export type Theme = 'light' | 'dark';

export const readTheme = (): Theme => (root().classList.contains('dark') ? 'dark' : 'light');

/** Every theme write (the toggle, a system change) sets the <html> class, so one observer keeps any number of readers in step. */
export function watchTheme(onChange: (theme: Theme) => void): () => void {
  const sync = () => onChange(readTheme());
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root(), { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export function applyTheme(value: Theme): void {
  root().classList.toggle('dark', value !== 'light');
  store(THEME_KEY, value);
}

/** Until a theme is picked, the page follows the device: the boot script sets it before paint and this keeps it in step. */
export function followSystemTheme(): () => void {
  let stored: string | null = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* storage blocked */ }
  if (stored) return () => {};
  const query = matchMedia('(prefers-color-scheme: dark)');
  const listener = () => root().classList.toggle('dark', query.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

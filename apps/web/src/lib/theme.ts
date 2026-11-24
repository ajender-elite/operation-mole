import { useSyncExternalStore } from 'react';

/** Color scheme of the app. Dark is the default (eye comfort; see docs/frontend.md). */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'om-theme';
const listeners = new Set<() => void>();

function saved(): Theme | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The saved choice if there is one, otherwise dark. The system preference is not consulted. */
export function getTheme(): Theme {
  return saved() ?? 'dark';
}

/** Applies a theme (via `data-theme` on `<html>`), remembers it, and notifies {@link useTheme}. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (e.g. private mode): the choice lasts for this page only.
  }
  for (const notify of listeners) notify();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Current theme; re-renders on toggle. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}

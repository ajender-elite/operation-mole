import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { server } from './server.ts';

/** What a test pretends the window is. Defaults: a 1280x800 desktop with a mouse, light system. */
export type Viewport = {
  width?: number;
  height?: number;
  pointer?: 'fine' | 'coarse';
  dark?: boolean;
};

/** Whether one media query (a list of `(feature: value)` checks) holds for a viewport. */
function matchesQuery(query: string, viewport: Required<Viewport>): boolean {
  const checks = [...query.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/g)];
  if (checks.length === 0) return false;
  return checks.every(([, feature = '', value = '']) => {
    const px = Number.parseFloat(value);
    switch (feature) {
      case 'min-width':
        return viewport.width >= px;
      case 'max-width':
        return viewport.width <= px;
      case 'min-height':
        return viewport.height >= px;
      case 'max-height':
        return viewport.height <= px;
      case 'pointer':
        return value === viewport.pointer;
      case 'prefers-color-scheme':
        return value === (viewport.dark ? 'dark' : 'light');
      default:
        return false;
    }
  });
}

/** Pretends the window is this size and input, evaluating the media queries the app uses. */
export function stubViewport(viewport: Viewport = {}): void {
  const full: Required<Viewport> = {
    width: viewport.width ?? 1280,
    height: viewport.height ?? 800,
    pointer: viewport.pointer ?? 'fine',
    dark: viewport.dark ?? false,
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: full.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: full.height });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matchesQuery(query, full),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

/** Only the colour scheme; kept for tests that talk about system dark mode. */
export function stubMatchMedia(prefersDark = false): void {
  stubViewport({ dark: prefersDark });
}

/** jsdom doesn't lay out, so it has no scrollIntoView; views call it when focus moves. */
Element.prototype.scrollIntoView = function scrollIntoView() {
  // nothing to scroll in jsdom
};

beforeEach(() => {
  stubMatchMedia();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

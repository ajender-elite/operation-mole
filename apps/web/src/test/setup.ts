import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { server } from './server.ts';

/** jsdom has no matchMedia; default to a light-mode system preference. */
export function stubMatchMedia(prefersDark = false): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

/** jsdom doesn't lay out, so it has no scrollIntoView; views call it when focus moves. */
Element.prototype.scrollIntoView = function scrollIntoView() {
  // nothing to scroll in jsdom
};

beforeEach(() => {
  stubMatchMedia();
  localStorage.clear();
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

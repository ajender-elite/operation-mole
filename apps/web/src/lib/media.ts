import { useCallback, useSyncExternalStore } from 'react';

/**
 * Named screen and input queries (docs/frontend.md, "Responsive layout"). The same thresholds
 * are in index.css as the `coarse` and `short` variants, so CSS and JS agree.
 */
export const MEDIA = {
  /** A phone held upright (and any narrow window). */
  compact: '(max-width: 639px)',
  /** A phone in landscape: little height, so secondary chrome collapses. */
  short: '(max-height: 480px)',
  /** Touch is the primary pointer: larger targets, no hover-only affordances. */
  coarse: '(pointer: coarse)',
  /** Today's `lg` breakpoint: panels side by side. */
  wide: '(min-width: 1024px)',
} as const;

/** Whether a media query currently matches; re-renders when it changes (rotation, resize). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => {
        mql.removeEventListener('change', onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

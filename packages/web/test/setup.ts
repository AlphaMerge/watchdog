import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

/**
 * How long `waitFor` and `findBy*` wait before they fail (`U-86`). A page renders and settles in
 * milliseconds alone, but the full suite runs 90 files at once on a VM shared with other runs, and
 * testing-library's default second was missed there twice on 2026-10-17 by tests that pass alone
 * (`read-failure-region`'s Settings tab, `readings-held`'s window). Nothing here waits for
 * something not to happen, so a longer bound only changes how long a real failure takes to say so.
 */
export const ASYNC_UTIL_TIMEOUT_MS = 3_000;
configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });

afterEach(() => {
  cleanup();
});

// jsdom has no matchMedia, and the theme hook subscribes to it on mount.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

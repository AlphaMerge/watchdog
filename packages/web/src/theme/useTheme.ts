import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'ms-theme';

function current(): Theme {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

/**
 * Reads and writes the same `data-theme` attribute that `public/theme-*.js`, the first script
 * `index.html` loads, sets before first paint. React is not the source of truth here on purpose: by
 * the time a component could set it, the page has already painted, and a dark-theme user has
 * already seen a white flash.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(current);

  const toggle = useCallback(() => {
    setTheme((previous) => {
      const next: Theme = previous === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset['theme'] = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Private browsing, or storage disabled. The theme still applies for this page.
      }
      return next;
    });
  }, []);

  // Follow the operating system until the user expresses a preference of their own.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(KEY);
      } catch {
        stored = null;
      }
      if (stored !== null) return;
      const next: Theme = event.matches ? 'dark' : 'light';
      document.documentElement.dataset['theme'] = next;
      setTheme(next);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  return { theme, toggle };
}

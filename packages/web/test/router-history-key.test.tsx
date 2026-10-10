import { act, render } from '@testing-library/react';
import { useContext } from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  UNSAFE_NavigationContext,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { historyKeyOf } from '../src/tree/address-later';

/**
 * The router internal the tree's address writes depend on (`U-79`).
 *
 * `useAddressLater` (`U-75`) reads the history's current entry through
 * `UNSAFE_NavigationContext`'s navigator, so that a write waiting through a navigation is never
 * put over another page's entry. That is an internal of react-router 7. If an upgrade stops
 * exposing it, the hook falls back to writing on every key and never on leaving, and nothing on
 * the page shows it — so this holds the app's own router, and the one the tests use, to it.
 */

interface Seen {
  readonly fromNavigator: string | null;
  readonly drawn: string;
}

let go: NavigateFunction = () => undefined;
function Probe({ seen }: { seen: Seen[] }): null {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const { key } = useLocation();
  go = useNavigate();
  seen.push({ fromNavigator: historyKeyOf(navigator), drawn: key });
  return null;
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the router’s navigator says which history entry is current', () => {
  for (const [name, Router] of [
    ['BrowserRouter, which the app runs on (`main.tsx`)', BrowserRouter],
    ['MemoryRouter, which the tests run on', MemoryRouter],
  ] as const) {
    it(name, () => {
      const seen: Seen[] = [];
      render(
        <Router>
          <Probe seen={seen} />
        </Router>,
      );
      act(() => {
        void go('/tree?q=Disk');
      });
      act(() => {
        void go('/tree?q=Disk+C', { replace: true });
      });

      // Opened, pushed and replaced: each time the navigator's key is a string, and the one drawn.
      const last = seen.at(-1);
      expect(seen.length).toBeGreaterThanOrEqual(3);
      for (const one of seen) {
        expect(typeof one.fromNavigator).toBe('string');
        expect(one.fromNavigator).toBe(one.drawn);
      }
      // A replace is a new entry key, which is what tells the hook its own write from another's.
      expect(new Set(seen.map((one) => one.drawn)).size).toBeGreaterThanOrEqual(3);
      expect(last?.fromNavigator).toBe(last?.drawn);
    });
  }

  it('and a navigator that does not say is read as not saying', () => {
    expect(historyKeyOf({})).toBeNull();
    expect(historyKeyOf({ location: {} })).toBeNull();
    expect(historyKeyOf(null)).toBeNull();
    expect(historyKeyOf({ location: { key: 'abc' } })).toBe('abc');
  });
});

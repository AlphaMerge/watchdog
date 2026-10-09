import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import { TreeView } from '../src/routes/TreeView';
import { ADDRESS_PAUSE_MS } from '../src/tree/address-later';

// The tree opens a socket for live states, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * The tree's address, written a pause after the last key (`U-75`).
 *
 * `U-70` wrote it with `replace` on every key, and browsers limit how often a page may write
 * history, which a key held down could reach. The search and tag are now written once nothing
 * has been typed for `ADDRESS_PAUSE_MS`, and at once when the box is left; a write that waited
 * never lands on an entry the operator has gone to; and the page's own write, drawn after a later
 * key, is still not read back into the box (`U-70`'s `REPLACE` guard).
 *
 * Under fake timeouts, once the tree has opened; Testing Library's own waits use a timeout, so
 * from there the test waits in turns of the event loop (`turnUntil`). The router draws a
 * navigation in a transition, which `act` finishes before it returns; the lag a browser has
 * between a write and its drawing is made here by doing the one thing outside `act` and the next
 * inside it.
 */

const ROOT = { id: 1, kind: 'root', name: 'Root' } as const;

const summary = (id: number, kind: string, name: string) => ({
  id,
  parentId: kind === 'root' ? null : ROOT.id,
  kind,
  name,
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: kind !== 'sensor',
  path: kind === 'root' ? [] : [ROOT],
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** The tree starts at the root; any filtered listing answers one sensor, `Disk C`. */
function stubFetch(): void {
  vi.stubGlobal('fetch', (url: string) => {
    if (url === '/api/v1/objects/tops') {
      return Promise.resolve(json({ items: [summary(ROOT.id, 'root', 'Root')] }));
    }
    const filtered = /[?&](q|tag|invalidParams)=/u.test(url);
    return Promise.resolve(
      json({ items: filtered ? [summary(10, 'sensor', 'Disk C')] : [], nextCursor: null }),
    );
  });
}

/** Where the router is, and every entry it has drawn, by key: one more per write. */
let location = '';
let drawn: string[] = [];
let navigateFromOutside: NavigateFunction = () => undefined;
function Where(): null {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  if (drawn.at(-1) !== here.key) drawn.push(here.key);
  navigateFromOutside = useNavigate();
  return null;
}

function Chrome(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <nav>
      <button
        type="button"
        onClick={() => {
          void navigate(-1);
        }}
      >
        Back
      </button>
      <Link to="/start">Start</Link>
      <Link to="/tree">Tree</Link>
    </nav>
  );
}

/** The tree, or what replaces it without a navigation, as signing out does. */
function SignedIn(): React.JSX.Element {
  const [signedIn, setSignedIn] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSignedIn(false);
        }}
      >
        Sign out
      </button>
      {signedIn ? <TreeView /> : <p>Signed out</p>}
    </>
  );
}

const routes = (
  <>
    <Where />
    <Chrome />
    <Routes>
      <Route path="/start" element={<p>Start page</p>} />
      <Route path="/tree" element={<SignedIn />} />
      <Route path="/objects/:id" element={<p>Object page</p>} />
    </Routes>
  </>
);

/** Opens the tree at the last of `entries`, then fakes the timeouts. */
async function openAt(entries: string[]): Promise<void> {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      {routes}
    </MemoryRouter>,
  );
  await screen.findByRole('searchbox', { name: 'Search objects' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** Turns of the event loop, inside `act`, until `done`. */
async function turnUntil(done: () => boolean, what: string, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns && !done(); turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });
  }
  if (!done()) throw new Error(`${what} within ${String(turns)} turns`);
}
const shown = (text: string) => (): boolean => screen.queryByText(text) !== null;
const at = (where: string) => (): boolean => location === where;
const result = async (): Promise<HTMLElement> => {
  await turnUntil(
    () => screen.queryByRole('link', { name: 'Disk C' }) !== null,
    'the search was not answered',
  );
  return screen.getByRole('link', { name: 'Disk C' });
};

const searchBox = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search objects' });
const tagBox = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('searchbox', { name: 'Filter by tag' });

const type = (box: HTMLInputElement, value: string): void => {
  fireEvent.change(box, { target: { value } });
};
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const back = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
};

/** React's own flag for whether updates are expected inside `act`. */
const actFlag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
/** Runs `step` as a browser would: outside `act`, so what it sets off is drawn later. */
function outsideAct(step: () => void): void {
  const before = actFlag.IS_REACT_ACT_ENVIRONMENT;
  actFlag.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    step();
  } finally {
    actFlag.IS_REACT_ACT_ENVIRONMENT = before;
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubFetch();
  location = '';
  drawn = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the tree’s address, written after a pause (U-75)', () => {
  it('writes once, a pause after the last of many keys', async () => {
    await openAt(['/start', '/tree']);
    const opened = drawn.length;

    for (const typed of ['D', 'Di', 'Dis', 'Disk']) {
      type(searchBox(), typed);
      wait(ADDRESS_PAUSE_MS - 1);
      expect(searchBox().value).toBe(typed);
    }
    expect(location).toBe('/tree');
    expect(drawn.length).toBe(opened);

    wait(1);
    expect(location).toBe('/tree?q=Disk');
    expect(drawn.length).toBe(opened + 1);
    expect(searchBox().value).toBe('Disk');

    // Nothing more waits.
    wait(ADDRESS_PAUSE_MS * 10);
    expect(drawn.length).toBe(opened + 1);
  });

  it('writes at once when a box is left, and nothing more after the pause', async () => {
    await openAt(['/tree']);
    const opened = drawn.length;

    type(searchBox(), 'Disk');
    fireEvent.blur(searchBox());
    expect(location).toBe('/tree?q=Disk');
    type(tagBox(), 'core');
    fireEvent.blur(tagBox());
    expect(location).toBe('/tree?q=Disk&tag=core');
    expect(drawn.length).toBe(opened + 2);

    wait(ADDRESS_PAUSE_MS * 10);
    expect(drawn.length).toBe(opened + 2);
    // Left again with nothing typed: nothing written.
    fireEvent.blur(searchBox());
    expect(drawn.length).toBe(opened + 2);
  });

  it('has what was typed when a result is followed, and Back brings it with no entry added', async () => {
    await openAt(['/start', '/tree']);
    searchBox().focus();
    type(searchBox(), 'Disk');
    // Following a result leaves the box first, as a click or a Tab does: written then.
    const link = await result();
    expect(location).toBe('/tree');
    act(() => {
      link.focus();
    });
    expect(location).toBe('/tree?q=Disk');
    fireEvent.click(link);
    await turnUntil(shown('Object page'), 'the result was not followed');

    back();
    await turnUntil(at('/tree?q=Disk'), 'Back did not come to the tree');
    expect(searchBox().value).toBe('Disk');
    await result();

    // Typing replaced the entry it opened on: one more Back leaves the tree.
    back();
    await turnUntil(shown('Start page'), 'Back did not leave the tree');
    expect(location).toBe('/start');
  });

  it('never writes what waited over the page navigated to', async () => {
    await openAt(['/start', '/tree']);
    type(searchBox(), 'Disk');
    // Followed without the box being left (a script, or a key that does not move focus).
    fireEvent.click(await result());
    await turnUntil(shown('Object page'), 'the result was not followed');
    expect(location).toBe('/objects/10');

    wait(ADDRESS_PAUSE_MS * 10);
    expect(location).toBe('/objects/10');
    expect(screen.getByText('Object page')).toBeDefined();
  });

  it('never writes what waited over an entry gone to before it is drawn', async () => {
    await openAt(['/start', '/tree']);
    type(searchBox(), 'Disk');

    // Back, and the pause ending before the router has drawn it: the tree is still on the page
    // and its write is due, but the history is on `/start` now.
    outsideAct(() => {
      void navigateFromOutside(-1);
      vi.advanceTimersByTime(ADDRESS_PAUSE_MS);
    });
    await turnUntil(shown('Start page'), 'Back was not drawn');
    expect(location).toBe('/start');
  });

  it('drops what waited when a link moves the address while the tree is open', async () => {
    await openAt(['/tree?tag=core']);
    type(searchBox(), 'Disk');
    // The navigation bar's plain tree, followed without the box being left: the boxes follow the
    // address, and the search typed before it is not written over it afterwards.
    fireEvent.click(screen.getByRole('link', { name: 'Tree' }));
    await turnUntil(at('/tree'), 'the link was not followed');
    expect(searchBox().value).toBe('');
    expect(tagBox().value).toBe('');

    wait(ADDRESS_PAUSE_MS * 10);
    expect(location).toBe('/tree');
    expect(searchBox().value).toBe('');
  });

  it('writes what was typed when the tree goes without a navigation', async () => {
    await openAt(['/start', '/tree']);
    type(searchBox(), 'Disk');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByText('Signed out')).toBeDefined();
    expect(location).toBe('/tree?q=Disk');
  });

  it('does not read its own write back into the box when it is drawn after a later key', async () => {
    await openAt(['/tree']);
    type(searchBox(), 'Disk');

    // The write goes out, and before the router draws it the operator types again. Drawn after
    // that key, it is the page's own `replace`, and the box keeps what was typed.
    outsideAct(() => {
      vi.advanceTimersByTime(ADDRESS_PAUSE_MS);
    });
    expect(location).toBe('/tree');
    type(searchBox(), 'Disk C');
    await turnUntil(at('/tree?q=Disk'), 'the write was not drawn');
    expect(searchBox().value).toBe('Disk C');

    wait(ADDRESS_PAUSE_MS);
    expect(location).toBe('/tree?q=Disk+C');
    expect(searchBox().value).toBe('Disk C');
  });
});

describe('the browser’s history (U-75)', () => {
  it('is replaced once per pause, and never grows', async () => {
    window.history.replaceState(null, '', '/tree');
    const length = window.history.length;
    const replaced = vi.spyOn(window.history, 'replaceState');
    const pushed = vi.spyOn(window.history, 'pushState');
    try {
      render(<BrowserRouter>{routes}</BrowserRouter>);
      await screen.findByRole('searchbox', { name: 'Search objects' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const before = replaced.mock.calls.length;

      // A key held down: forty characters, thirty milliseconds apart.
      for (let typed = 1; typed <= 40; typed += 1) {
        type(searchBox(), 'x'.repeat(typed));
        wait(30);
      }
      expect(replaced.mock.calls.length).toBe(before);
      wait(ADDRESS_PAUSE_MS);
      expect(replaced.mock.calls.length).toBe(before + 1);
      expect(window.location.search).toBe(`?q=${'x'.repeat(40)}`);

      type(tagBox(), 'core');
      fireEvent.blur(tagBox());
      expect(replaced.mock.calls.length).toBe(before + 2);
      expect(window.location.search).toBe(`?q=${'x'.repeat(40)}&tag=core`);

      expect(pushed).not.toHaveBeenCalled();
      expect(window.history.length).toBe(length);
    } finally {
      replaced.mockRestore();
      pushed.mockRestore();
      window.history.replaceState(null, '', '/');
    }
  });
});

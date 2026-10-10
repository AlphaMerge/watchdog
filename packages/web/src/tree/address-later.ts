import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_NavigationContext, useLocation, useSearchParams } from 'react-router-dom';

/**
 * How long the address waits after the last change before it is written (`U-75`). Long enough
 * that a held key or a fast typist makes one write, not one per character; short enough that a
 * link copied a moment after typing has what was typed.
 */
export const ADDRESS_PAUSE_MS = 300;

/** What a page writes its search parameters with. */
export interface AddressWriter {
  /** Write these parameters once nothing has changed for `ADDRESS_PAUSE_MS`. */
  readonly later: (next: URLSearchParams) => void;
  /** Write these parameters now, and drop any write that was waiting. */
  readonly now: (next: URLSearchParams) => void;
  /** Write what is waiting, if anything is, now. */
  readonly flush: () => void;
}

/**
 * Writes a page's search parameters into its own history entry with `replace`, a pause after the
 * last change rather than on every one (`U-75`).
 *
 * **Why not on every key.** Browsers limit how often a page may write history: Safari and Firefox
 * throw past roughly 100–200 writes in 10 s. Typing does not reach that; a key held down on a long
 * query for a few seconds can, and then the write throws.
 *
 * **What waits must never land on another page's entry.** A `replace` goes to whatever entry is
 * current, and the router resolves `?…` against the page's own path, so a write that waited
 * through a navigation away (the browser's *Back*, a link) would put the page back over where the
 * operator went. So a write is sent only while the current entry is the one this page last showed
 * or last wrote, by the history's `key`, which every `replace` changes. The history is read
 * through the router's navigator, whose `location` is the history's current one whether it has
 * been drawn yet or not: by the time this page renders a navigation it has already happened, and
 * a write timed in the gap would otherwise go over it. A navigation this page did not make, once
 * drawn, drops what was waiting: the page has read the new address in.
 *
 * **Flushed on unmount, under the same rule.** A page taken away without a navigation (the session
 * ending) leaves what was typed in the address; a page taken away by a navigation writes nothing,
 * since its entry is no longer current and cannot be written. Mouse and Tab leave a box before
 * anything else on the page is pressed, so the caller flushes on blur, and what was typed is
 * written before a link is followed. **And on `pagehide`** (`U-79`): a reload or a closed tab
 * within the pause keeps the last keys, since the entry is still this page's when the page goes.
 * Only a *Back* pressed within the pause, from the keyboard, loses the last of it: by the time the
 * page hears of it the entry is another's, and nothing may be written there.
 *
 * A router whose navigator does not say where the history is (neither `BrowserRouter` nor
 * `MemoryRouter`) is written to as before, and never on unmount.
 */
export function useAddressLater(): AddressWriter {
  const [, setParams] = useSearchParams();
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const { key: shown } = useLocation();

  const write = useRef(setParams);
  const history = useRef(navigator);
  useEffect(() => {
    write.current = setParams;
    history.current = navigator;
  }, [setParams, navigator]);

  // The entry this page last showed or last wrote, and every entry it has written since it last
  // read the address in.
  const expected = useRef(shown);
  const ours = useRef(new Set<string>());
  const waiting = useRef<URLSearchParams | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const drop = useCallback((): void => {
    clearTimeout(timer.current);
    timer.current = undefined;
    waiting.current = null;
  }, []);

  /**
   * Writes `next` if the current entry is still this page's. A history that cannot say where it is
   * is written to, except on unmount, when the page has most likely been navigated away from.
   */
  const send = useCallback((next: URLSearchParams, atUnmount: boolean): void => {
    const current = historyKeyOf(history.current);
    if (current === null ? atUnmount : current !== expected.current) return;
    write.current(next, { replace: true });
    const written = historyKeyOf(history.current);
    if (written !== null) {
      ours.current.add(written);
      expected.current = written;
    }
  }, []);

  const flush = useCallback((): void => {
    const next = waiting.current;
    drop();
    if (next !== null) send(next, false);
  }, [drop, send]);

  const later = useCallback(
    (next: URLSearchParams): void => {
      clearTimeout(timer.current);
      waiting.current = next;
      timer.current = setTimeout(flush, ADDRESS_PAUSE_MS);
    },
    [flush],
  );

  const now = useCallback(
    (next: URLSearchParams): void => {
      drop();
      send(next, false);
    },
    [drop, send],
  );

  // Drawn: one of this page's own writes, or a navigation it did not make, which it has read in.
  useEffect(() => {
    if (ours.current.has(shown)) return;
    drop();
    ours.current.clear();
    expected.current = shown;
  }, [shown, drop]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);

  useEffect(
    () => () => {
      const next = waiting.current;
      drop();
      if (next !== null) send(next, true);
    },
    [drop, send],
  );

  return { later, now, flush };
}

/**
 * The key of the history's current entry, from the router's navigator: `BrowserRouter` and
 * `MemoryRouter` both hand it their history, which says where it is. `null` for one that does not.
 *
 * **An internal of react-router 7**, read through `UNSAFE_NavigationContext`. Exported for the test
 * that holds the app's own router to it (`U-79`): if an upgrade stops exposing it, the address is
 * written on every key again and never on leaving, with nothing on the page to show it.
 */
export function historyKeyOf(navigator: unknown): string | null {
  if (typeof navigator !== 'object' || navigator === null || !('location' in navigator)) {
    return null;
  }
  const { location } = navigator;
  if (typeof location !== 'object' || location === null || !('key' in location)) return null;
  return typeof location.key === 'string' ? location.key : null;
}

/**
 * A value as it stood `ms` after it last changed (`U-79`), and a way to settle it at once.
 *
 * The tree's search asks the core for what the boxes say; asked on every key, a held key was one
 * `GET /objects` per character. It asks after the same pause the address waits for, and at once
 * when the caller settles it (a box left, the address read in).
 */
export function useSettled<T>(value: T, ms: number): readonly [T, (to: T) => void] {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return [settled, setSettled];
}

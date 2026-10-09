import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long a refusal decided on the spot waits after its region is emptied (`U-54`).
 *
 * A refusal the core sends arrives a round trip after the attempt emptied its region, so the
 * region has been seen empty before it fills, and a second refusal in the same words is a change
 * and is said again (`U-48`, `U-52`). One the form decides itself — two passwords that differ, a
 * login left empty — is set in the same handler that empties it, and React 19 commits both as one:
 * the region never changes and nothing is said. Committing the empty one first is not enough
 * either, since a screen reader can read the tree after both changes and find it unchanged; a
 * repeated message needs the region emptied and then a moment before it fills again. 100 ms is
 * the delay live-announcer libraries settled on for that, and it is short of anything an operator
 * would see as a pause.
 */
export const SAY_AGAIN_MS = 100;

/**
 * A refusal for a region that is always in the tree and empty until there is one (`U-54`).
 *
 * `set` puts a value now — `null` empties — and drops one still waiting, so an edit that clears
 * the refusal is not followed by a refusal about what was there before it. `sayAgain` empties now
 * and fills after `SAY_AGAIN_MS`, for a refusal decided in the handler of the attempt it answers.
 */
export function useRefusal<T>(): readonly [T | null, (next: T | null) => void, (next: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(waiting.current);
    },
    [],
  );

  const set = useCallback((next: T | null) => {
    clearTimeout(waiting.current);
    waiting.current = undefined;
    setValue(next);
  }, []);

  const sayAgain = useCallback((next: T) => {
    clearTimeout(waiting.current);
    setValue(null);
    waiting.current = setTimeout(() => {
      waiting.current = undefined;
      setValue(next);
    }, SAY_AGAIN_MS);
  }, []);

  return [value, set, sayAgain] as const;
}

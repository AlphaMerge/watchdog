import { useEffect, useState } from 'react';

/**
 * A counter that steps on an interval (`G-04`).
 *
 * **Deliberately not a timestamp.** A value that changed on every render would restart every
 * request it feeds; the point of this is that all of them move together, once a minute, so a
 * canvas of twenty tiles is one wave of requests rather than twenty timers drifting apart.
 *
 * Its own module because two components need it — the signed-in board and `G-06`'s shared page —
 * and a file that exports both a component and a hook loses fast refresh.
 */
export function useClock(everyMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => {
      setTick((was) => was + 1);
    }, everyMs);
    return () => {
      clearInterval(handle);
    };
  }, [everyMs]);
  return tick;
}

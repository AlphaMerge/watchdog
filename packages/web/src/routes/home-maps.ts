import type { MapSummary } from '../api/types';

/**
 * Which maps reach the home screen (`G-09`, `CAPABILITIES.MD §2`).
 *
 * **Five stars, and only five.** `§2` says priority sorts objects and *five-star* maps surface in
 * Home; a threshold of "four or more" would be a different rule, kinder to somebody who never
 * gets round to starring anything and useless to everybody who stars things deliberately. The
 * point of the top of the scale is that reaching it is a decision.
 */
export const HOME_PRIORITY = 5;

/**
 * At most this many on the home screen.
 *
 * A home page that lists fifty maps is not a home page. The rest are not hidden — the count says
 * how many there are and the Maps page has all of them — because a silently truncated list is a
 * list somebody trusts to be complete.
 */
export const HOME_LIMIT = 8;

export interface HomeMaps {
  readonly shown: readonly MapSummary[];
  /** How many five-star maps did not fit. Zero when they all did. */
  readonly hidden: number;
}

/**
 * The five-star maps, in the order the core returned them.
 *
 * **Ordered by the core, not re-sorted here.** `GET /maps` already answers priority-first and
 * then by name, and a second ordering in the browser is a second thing that eventually disagrees
 * with the first — the same reason inheritance is resolved in one place.
 */
export function starredMaps(items: readonly MapSummary[], limit: number = HOME_LIMIT): HomeMaps {
  const starred = items.filter((map) => map.priority >= HOME_PRIORITY);
  return { shown: starred.slice(0, limit), hidden: Math.max(0, starred.length - limit) };
}

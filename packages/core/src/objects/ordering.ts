import type { ObjectId, SiblingMove } from './types.js';

export interface Reordering {
  /** The siblings in their new order. */
  next: ObjectId[];
  from: number;
  to: number;
}

/**
 * Where a manual move puts an object among its siblings (S-14).
 *
 * Pure, and separated from everything that touches a database, because the interesting bugs here
 * are all off-by-one: "move up" at the top, "move down" at the bottom, and a move that lands
 * where it started. All three are no-ops rather than errors — an operator holding the up arrow
 * on the first item is not making a mistake, and a reorder that reports failure for it would
 * turn a UI's optimistic update into a spurious error.
 */
export function reorderSiblings(
  ordered: readonly ObjectId[],
  id: ObjectId,
  move: SiblingMove,
): Reordering | null {
  const from = ordered.indexOf(id);
  if (from === -1) return null;

  const last = ordered.length - 1;
  const to =
    move === 'first'
      ? 0
      : move === 'last'
        ? last
        : move === 'up'
          ? Math.max(0, from - 1)
          : Math.min(last, from + 1);

  if (to === from) return null;

  const next = [...ordered];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return { next, from, to };
}

/**
 * The same move, made among only the siblings its caller can see (`A-46`).
 *
 * `seen` is those siblings, or null for a caller who sees them all. **Every other sibling keeps
 * its index**: the ones the caller can see are reordered among themselves and put back into the
 * places they held, so "up" passes the nearest visible sibling above and "last" lands on the last
 * visible place. A hole is neither moved nor counted, and a caller cannot tell by moving an object
 * whether anything sits between two of the siblings it sees.
 *
 * `from` and `to` are indices among all the siblings, as `reorderSiblings` gives them.
 */
export function reorderAmong(
  ordered: readonly ObjectId[],
  seen: ReadonlySet<ObjectId> | null,
  id: ObjectId,
  move: SiblingMove,
): Reordering | null {
  if (seen === null) return reorderSiblings(ordered, id, move);
  const change = reorderSiblings(
    ordered.filter((one) => seen.has(one)),
    id,
    move,
  );
  if (change === null) return null;

  const placed = change.next.values();
  const next = ordered.map((one) => (seen.has(one) ? (placed.next().value ?? one) : one));
  return { next, from: ordered.indexOf(id), to: next.indexOf(id) };
}

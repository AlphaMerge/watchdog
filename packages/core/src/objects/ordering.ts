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

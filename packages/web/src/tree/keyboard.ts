import type { TreeRowModel } from './model';

/**
 * What a key press means, decided without touching the DOM.
 *
 * Separate from the component because this is the part that is easy to get wrong and easy to
 * test: `ArrowLeft` on an expanded branch collapses it, and on a leaf it moves to the parent,
 * and getting those two the wrong way round makes a tree that traps you at the bottom of a
 * branch. Table-driven tests are cheap here and would be an ordeal against a rendered list.
 */
export type TreeCommand =
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'expand'; readonly row: TreeRowModel }
  | { readonly kind: 'collapse'; readonly row: TreeRowModel }
  | { readonly kind: 'activate'; readonly row: TreeRowModel }
  | { readonly kind: 'none' };

const NONE: TreeCommand = { kind: 'none' };

/**
 * The row that is the parent of `index`, in a *flattened* tree.
 *
 * The nearest earlier row one level shallower. There is always exactly one — a flattened tree
 * lists children immediately after their parent — and it is `-1` only at depth 0.
 */
export function parentOf(rows: readonly TreeRowModel[], index: number): number {
  const row = rows[index];
  if (row === undefined || row.depth === 0) return -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (candidate !== undefined && candidate.depth < row.depth) return i;
  }
  return -1;
}

/**
 * The ARIA authoring-practices tree pattern (`U-11`).
 *
 * **The roles were already there and the keys were not**, which is worse than neither: `role`
 * `tree` tells a screen-reader user that arrow keys walk the branches, and they walked nothing.
 * The rows were reachable by Tab — one stop per row, then one per expander and one per link,
 * which is ~15,000 stops at the 5,000-sensor target — so this is not only a broken promise but
 * the difference between a usable tree and an unusable one.
 *
 * Deliberately not implemented: type-ahead, `*` to expand every sibling, and multi-select.
 * They are optional in the pattern, and the tree here is a navigation aid rather than a picker.
 */
export function treeCommand(
  key: string,
  rows: readonly TreeRowModel[],
  active: number,
): TreeCommand {
  if (rows.length === 0) return NONE;
  const index = Math.min(Math.max(active, 0), rows.length - 1);
  const row = rows[index];
  if (row === undefined) return NONE;

  switch (key) {
    case 'ArrowDown':
      return index >= rows.length - 1 ? NONE : { kind: 'move', index: index + 1 };
    case 'ArrowUp':
      return index <= 0 ? NONE : { kind: 'move', index: index - 1 };
    case 'Home':
      return index === 0 ? NONE : { kind: 'move', index: 0 };
    case 'End':
      return index === rows.length - 1 ? NONE : { kind: 'move', index: rows.length - 1 };
    case 'ArrowRight': {
      if (!row.expandable) return NONE;
      if (!row.expanded) return { kind: 'expand', row };
      // Open already, so descend — but only into a row that really is a child. An expanded
      // branch that turned out to have nothing in it is followed by its own sibling, and
      // stepping onto that would look like the arrow key skipping a level.
      const next = rows[index + 1];
      return next !== undefined && next.depth > row.depth
        ? { kind: 'move', index: index + 1 }
        : NONE;
    }
    case 'ArrowLeft': {
      if (row.expandable && row.expanded) return { kind: 'collapse', row };
      const parent = parentOf(rows, index);
      return parent === -1 ? NONE : { kind: 'move', index: parent };
    }
    case 'Enter':
    case ' ':
      return { kind: 'activate', row };
    default:
      return NONE;
  }
}

/**
 * Where the active row should land after the rows change underneath it.
 *
 * Collapsing a branch removes rows, and an active index left pointing past the end would leave
 * the tree with no focusable row at all — `tabIndex` is roving, so "no active row" means "no way
 * back in with the keyboard". Following the object id keeps focus on the row the operator was
 * on; when that row has gone (it was inside the branch they just collapsed) the clamp puts them
 * somewhere real.
 */
export function keepActive(
  rows: readonly TreeRowModel[],
  previousId: number | undefined,
  active: number,
): number {
  if (rows.length === 0) return 0;
  if (previousId !== undefined) {
    const moved = rows.findIndex((row) => row.object.id === previousId);
    if (moved !== -1) return moved;
  }
  return Math.min(Math.max(active, 0), rows.length - 1);
}

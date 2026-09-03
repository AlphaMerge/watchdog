import { describe, expect, it } from 'vitest';
import type { ObjectSummary } from '../src/api/types';
import type { TreeRowModel } from '../src/tree/model';
import { keepActive, parentOf, treeCommand } from '../src/tree/keyboard';
import { shouldTakeFocus } from '../src/components/page-title-model';

function object(id: number): ObjectSummary {
  return {
    id,
    parentId: null,
    kind: 'group',
    name: `n${String(id)}`,
    tags: [],
    priority: 3,
    version: 1,
    hasChildren: false,
  };
}

function row(id: number, depth: number, over: Partial<TreeRowModel> = {}): TreeRowModel {
  return {
    object: object(id),
    depth,
    expanded: false,
    expandable: false,
    loading: false,
    ...over,
  };
}

/**
 * probe (0, open)
 *   group (1, open)
 *     sensor  (2)
 *     sensor  (3)
 *   group (1, shut)
 * probe (0, shut)
 */
const ROWS: readonly TreeRowModel[] = [
  row(10, 0, { expandable: true, expanded: true }),
  row(20, 1, { expandable: true, expanded: true }),
  row(30, 2),
  row(31, 2),
  row(21, 1, { expandable: true }),
  row(11, 0, { expandable: true }),
];

describe('walking the tree with the arrow keys', () => {
  it('moves down and up one row', () => {
    expect(treeCommand('ArrowDown', ROWS, 0)).toEqual({ kind: 'move', index: 1 });
    expect(treeCommand('ArrowUp', ROWS, 3)).toEqual({ kind: 'move', index: 2 });
  });

  it('stops at both ends rather than wrapping', () => {
    // Wrapping is not in the pattern, and a tree that jumped from the last row to the first
    // would move the viewport 5,000 rows on a key press meant to do nothing.
    expect(treeCommand('ArrowUp', ROWS, 0)).toEqual({ kind: 'none' });
    expect(treeCommand('ArrowDown', ROWS, ROWS.length - 1)).toEqual({ kind: 'none' });
  });

  it('jumps to the ends with Home and End', () => {
    expect(treeCommand('Home', ROWS, 4)).toEqual({ kind: 'move', index: 0 });
    expect(treeCommand('End', ROWS, 0)).toEqual({ kind: 'move', index: ROWS.length - 1 });
  });

  it('does nothing for a key it does not own', () => {
    // The default has to be `none` rather than a guess: `onKeyDown` only calls `preventDefault`
    // when something will happen, so an unhandled key stays the browser's.
    for (const key of ['a', 'Tab', 'PageDown', 'Escape', 'F5']) {
      expect(treeCommand(key, ROWS, 2)).toEqual({ kind: 'none' });
    }
  });
});

describe('ArrowRight', () => {
  it('opens a shut branch', () => {
    expect(treeCommand('ArrowRight', ROWS, 4)).toEqual({ kind: 'expand', row: ROWS[4] });
  });

  it('descends into a branch that is already open', () => {
    expect(treeCommand('ArrowRight', ROWS, 1)).toEqual({ kind: 'move', index: 2 });
  });

  it('does nothing on a leaf', () => {
    expect(treeCommand('ArrowRight', ROWS, 2)).toEqual({ kind: 'none' });
  });

  it('does not step onto a sibling when an open branch turned out to be empty', () => {
    // The row after an expanded-but-childless branch is its *sibling*, and moving onto it would
    // look like the arrow key skipping a level rather than doing nothing.
    const empty: TreeRowModel[] = [
      row(10, 0, { expandable: true, expanded: true }),
      row(11, 0, { expandable: true }),
    ];
    expect(treeCommand('ArrowRight', empty, 0)).toEqual({ kind: 'none' });
  });

  it('does nothing on the last row, open or not', () => {
    const last: TreeRowModel[] = [row(10, 0, { expandable: true, expanded: true })];
    expect(treeCommand('ArrowRight', last, 0)).toEqual({ kind: 'none' });
  });
});

describe('ArrowLeft', () => {
  it('shuts an open branch rather than leaving it', () => {
    expect(treeCommand('ArrowLeft', ROWS, 1)).toEqual({ kind: 'collapse', row: ROWS[1] });
  });

  it('climbs to the parent from a leaf', () => {
    expect(treeCommand('ArrowLeft', ROWS, 3)).toEqual({ kind: 'move', index: 1 });
  });

  it('climbs to the parent from a shut branch', () => {
    expect(treeCommand('ArrowLeft', ROWS, 4)).toEqual({ kind: 'move', index: 0 });
  });

  it('does nothing at the top level with nothing open', () => {
    expect(treeCommand('ArrowLeft', ROWS, 5)).toEqual({ kind: 'none' });
  });

  it('finds the parent past siblings that have children of their own', () => {
    // The parent is the nearest *shallower* row, not the previous one — walking back by a single
    // step would land inside the sibling branch above.
    expect(parentOf(ROWS, 4)).toBe(0);
    expect(parentOf(ROWS, 2)).toBe(1);
    expect(parentOf(ROWS, 0)).toBe(-1);
  });
});

describe('activating a row', () => {
  it('opens the object on Enter and on Space', () => {
    expect(treeCommand('Enter', ROWS, 2)).toEqual({ kind: 'activate', row: ROWS[2] });
    expect(treeCommand(' ', ROWS, 2)).toEqual({ kind: 'activate', row: ROWS[2] });
  });
});

describe('a tree with nothing in it', () => {
  it('answers every key with nothing rather than reading row -1', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']) {
      expect(treeCommand(key, [], 0)).toEqual({ kind: 'none' });
    }
  });

  it('clamps an index that is past the end instead of throwing', () => {
    expect(treeCommand('ArrowUp', ROWS, 99)).toEqual({ kind: 'move', index: ROWS.length - 2 });
  });
});

describe('keeping a tab stop when the rows change', () => {
  it('follows the row it was on when the list shifts', () => {
    // The tab stop belongs to an object, not to a position. Loading a branch above pushes every
    // row down, and an index left where it was would silently select something else.
    const shifted = [row(5, 0), ...ROWS];
    expect(keepActive(shifted, 30, 2)).toBe(3);
  });

  it('clamps into the list when the active row has gone', () => {
    // This is the one that matters: collapsing a branch takes rows away, and an index past the
    // end means no row carries `tabIndex={0}` — a tree with no way back in from the keyboard.
    const collapsed = [ROWS[0], ROWS[5]] as TreeRowModel[];
    expect(keepActive(collapsed, 31, 3)).toBe(1);
  });

  it('holds at zero for an empty tree', () => {
    expect(keepActive([], 30, 4)).toBe(0);
  });

  it('leaves a valid index alone', () => {
    expect(keepActive(ROWS, 30, 2)).toBe(2);
  });
});

describe('moving focus after a navigation', () => {
  it('leaves the first page of the session alone', () => {
    // Focus starts at the top of the document, which is where the skip link is. Stealing it on
    // load would step over the one control that exists to be first.
    expect(shouldTakeFocus(null, '/alarms')).toBe(false);
  });

  it('moves when the route changes', () => {
    expect(shouldTakeFocus('/alarms', '/objects/8')).toBe(true);
  });

  it('stays put when the same page re-renders', () => {
    // A tab switch, a filter, or a fetch finishing all re-render the heading. Focusing then
    // would pull a keyboard user out of whatever control they were using, repeatedly.
    expect(shouldTakeFocus('/objects/8', '/objects/8')).toBe(false);
  });
});

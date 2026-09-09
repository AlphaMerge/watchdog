import { describe, expect, it } from 'vitest';
import {
  CELL,
  COLUMNS,
  DEFAULT_RANGE_MINUTES,
  HISTORY_DEPTH,
  MAX_TILES,
  MIN_H,
  MIN_W,
  ROWS,
  addTile,
  canRedo,
  canUndo,
  canvasCommand,
  change,
  connect,
  connectorLine,
  disconnect,
  clampMoved,
  clampSized,
  describeBox,
  draft,
  firstFreeBox,
  fit,
  gestureBox,
  keepSelection,
  moveTile,
  nextTileId,
  overlaps,
  placeTile,
  readCanvas,
  record,
  redo,
  removeTile,
  resizeTile,
  sameCanvas,
  timeline,
  undo,
  unitsFromPixels,
  writeLayout,
  type Box,
  type Canvas,
  type Gesture,
  type KeyPress,
  type Tile,
} from '../src/maps/canvas';

/**
 * The designer's model (`G-03`), driven the way a designer drives it.
 *
 * Everything here is a pure function on purpose: a drag that commits fifty undo steps and an
 * arrow key that resizes when it should move are both trivial to assert at this level and an
 * ordeal against a rendered canvas with a synthetic pointer.
 */

function tile(id: string, box: Partial<Box> = {}): Tile {
  return {
    id,
    kind: 'status',
    objectId: 1,
    title: id,
    rangeMinutes: DEFAULT_RANGE_MINUTES,
    html: '',
    at: null,
    box: { x: 0, y: 0, w: 4, h: 3, ...box },
  };
}

function canvas(...tiles: Tile[]): Canvas {
  return { tiles, connectors: [], geo: null };
}

function press(key: string, held: Partial<KeyPress> = {}): KeyPress {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...held };
}

describe('the canvas geometry', () => {
  it('moves a tile back inside rather than shrinking it', () => {
    const box = clampMoved({ x: COLUMNS + 10, y: ROWS + 10, w: 4, h: 3 });
    expect(box).toEqual({ x: COLUMNS - 4, y: ROWS - 3, w: 4, h: 3 });
  });

  it('resizes a tile back inside rather than moving it', () => {
    const box = clampSized({ x: COLUMNS - 4, y: ROWS - 3, w: 99, h: 99 });
    expect(box).toEqual({ x: COLUMNS - 4, y: ROWS - 3, w: 4, h: 3 });
  });

  it('will not make a tile smaller than a control can be', () => {
    expect(clampSized({ x: 0, y: 0, w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: MIN_W, h: MIN_H });
  });

  it('narrows a too-wide tile before it decides where it goes', () => {
    // Position first would leave x at 0 and the right edge still hanging off the canvas, because
    // there is no x that holds a box wider than the grid.
    const box = fit({ x: 30, y: 0, w: COLUMNS + 20, h: 3 });
    expect(box.x + box.w).toBeLessThanOrEqual(COLUMNS);
    expect(box.y + box.h).toBeLessThanOrEqual(ROWS);
  });

  it('rounds a pointer distance to the nearest cell rather than truncating it', () => {
    // Truncation leaves the tile trailing half a cell behind the cursor for the whole drag.
    expect(unitsFromPixels(CELL - 1)).toBe(1);
    expect(unitsFromPixels(-CELL + 1)).toBe(-1);
    expect(unitsFromPixels(0)).toBe(0);
  });

  it('knows when two tiles share space, and when they only touch', () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 3, y: 3, w: 4, h: 4 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 })).toBe(false);
  });
});

describe('a pointer drag', () => {
  const origin: Box = { x: 5, y: 5, w: 6, h: 4 };
  const gesture = (mode: 'move' | 'resize'): Gesture => ({
    id: 'w1',
    mode,
    origin,
    from: { x: 100, y: 100 },
    before: canvas(tile('w1', origin)),
  });

  it('moves the tile with the pointer', () => {
    const box = gestureBox(gesture('move'), { x: 100 + CELL * 3, y: 100 + CELL * 2 });
    expect(box).toEqual({ x: 8, y: 7, w: 6, h: 4 });
  });

  it('resizes from the corner', () => {
    const box = gestureBox(gesture('resize'), { x: 100 + CELL * 2, y: 100 - CELL });
    expect(box).toEqual({ x: 5, y: 5, w: 8, h: 3 });
  });

  it('does not drift away from the cursor over a long drag', () => {
    // **The compounding-rounding bug, and it is invisible in a test that moves the pointer once.**
    // Adding a rounded delta to the last position rounds once per frame; computing from the
    // origin rounds once per drag. Thirteen small moves and one big one have to agree.
    const drag = gesture('move');
    let stepped: Box = drag.origin;
    for (let i = 1; i <= 13; i += 1) {
      stepped = gestureBox(drag, { x: 100 + 13 * i, y: 100 });
    }
    expect(stepped).toEqual(gestureBox(drag, { x: 100 + 13 * 13, y: 100 }));
  });

  it('stops at the edge instead of leaving the canvas', () => {
    const box = gestureBox(gesture('move'), { x: 100 + CELL * 500, y: 100 + CELL * 500 });
    expect(box).toEqual({ x: COLUMNS - 6, y: ROWS - 4, w: 6, h: 4 });
  });
});

describe('editing tiles', () => {
  it('moves and resizes by whole cells', () => {
    const start = canvas(tile('w1', { x: 2, y: 2 }));
    expect(moveTile(start, 'w1', 1, -1).tiles[0]?.box).toEqual({ x: 3, y: 1, w: 4, h: 3 });
    expect(resizeTile(start, 'w1', 2, 2).tiles[0]?.box).toEqual({ x: 2, y: 2, w: 6, h: 5 });
  });

  it('leaves the canvas alone when the id names nothing', () => {
    const start = canvas(tile('w1'));
    expect(moveTile(start, 'nope', 1, 1)).toBe(start);
    expect(removeTile(start, 'nope')).toBe(start);
  });

  it('puts a new tile in a gap rather than on top of the last one', () => {
    // A tile added exactly under the previous one looks like the button did nothing.
    const start = canvas(tile('w1', { x: 0, y: 0, w: 6, h: 4 }));
    const box = firstFreeBox(start, 6, 4);
    expect(overlaps(box, { x: 0, y: 0, w: 6, h: 4 })).toBe(false);
  });

  it('refuses the tile past the ceiling the core resolves', () => {
    // The core resolves the first 200 and reports the rest as a problem, so a 201st tile would
    // be work somebody saved and never saw drawn.
    const full = canvas(...Array.from({ length: MAX_TILES }, (_, i) => tile(`w${String(i)}`)));
    expect(addTile(full, tile('one-more')).tiles).toHaveLength(MAX_TILES);
  });

  it('refuses a second tile with an id already on the canvas', () => {
    const start = canvas(tile('w1'));
    expect(addTile(start, tile('w1', { x: 9 }))).toBe(start);
  });

  it('gives a new tile an id nothing else holds', () => {
    const start = canvas(tile('w1'), tile('w2'));
    expect(nextTileId(start)).toBe('w3');
    expect(nextTileId(canvas(tile('w1'), tile('w3')))).toBe('w4');
  });
});

describe('connectors', () => {
  const two = canvas(
    tile('w1', { x: 0, y: 0, w: 4, h: 4 }),
    tile('w2', { x: 10, y: 0, w: 4, h: 4 }),
  );

  it('joins two tiles', () => {
    const joined = connect(two, 'w1', 'w2');
    expect(joined.connectors).toHaveLength(1);
    expect(joined.connectors[0]?.from).toBe('w1');
  });

  it('refuses a loop, an unknown tile, and a line that already exists either way round', () => {
    expect(connect(two, 'w1', 'w1')).toBe(two);
    expect(connect(two, 'w1', 'nope')).toBe(two);
    const joined = connect(two, 'w1', 'w2');
    // A→B and B→A are one line on screen. Letting both exist means a canvas that looks unchanged
    // and a document that grows every time somebody clicks.
    expect(connect(joined, 'w2', 'w1')).toBe(joined);
  });

  it('takes the lines with the tile', () => {
    // A connector whose endpoint is not on the canvas has no geometry: leaving it behind saves a
    // document the core can only report as broken.
    const joined = connect(two, 'w1', 'w2');
    expect(removeTile(joined, 'w2').connectors).toHaveLength(0);
  });

  it('disconnects one line and leaves the rest', () => {
    const three = addTile(connect(two, 'w1', 'w2'), tile('w3', { x: 20, y: 0 }));
    const joined = connect(three, 'w2', 'w3');
    expect(joined.connectors).toHaveLength(2);
    const cut = disconnect(joined, joined.connectors[0]?.id ?? '');
    expect(cut.connectors).toHaveLength(1);
    expect(disconnect(cut, 'not-a-line')).toBe(cut);
  });

  it('counts a changed line as a changed canvas', () => {
    // Otherwise Save stays disabled after drawing one, and the work is lost on the next reload.
    expect(sameCanvas(two, connect(two, 'w1', 'w2'))).toBe(false);
  });

  it('draws from edge to edge, not centre to centre', () => {
    // A line under both tiles is invisible exactly where it matters, and reads as two boxes with
    // a gap rather than as a connection.
    const line = connectorLine({ x: 0, y: 0, w: 4, h: 4 }, { x: 10, y: 0, w: 4, h: 4 });
    expect(line.x1).toBe(4 * CELL); // the right edge of the first
    expect(line.x2).toBe(10 * CELL); // the left edge of the second
    expect(line.y1).toBe(2 * CELL);
    expect(line.y2).toBe(2 * CELL);
  });

  it('leaves through the top when the other tile is above', () => {
    const line = connectorLine({ x: 0, y: 10, w: 4, h: 4 }, { x: 0, y: 0, w: 4, h: 4 });
    expect(line.y1).toBe(10 * CELL);
    expect(line.x1).toBe(2 * CELL);
  });

  it('gives two tiles in the same place a line with no direction rather than a made-up one', () => {
    const line = connectorLine({ x: 3, y: 3, w: 4, h: 4 }, { x: 3, y: 3, w: 4, h: 4 });
    expect(line.x1).toBe(line.x2);
    expect(line.y1).toBe(line.y2);
  });

  it('round-trips through the document', () => {
    const joined = connect(two, 'w1', 'w2');
    expect(readCanvas(writeLayout(joined))).toEqual(joined);
  });

  it('drops a saved line whose tile has gone, rather than opening broken', () => {
    const read = readCanvas({
      widgets: [{ id: 'a', kind: 'status', objectId: 1 }],
      connectors: [
        { id: 'c1', from: 'a', to: 'gone' },
        { id: 'c2', from: 'a', to: 'a' },
      ],
    });
    expect(read.connectors).toHaveLength(0);
    expect(read.tiles).toHaveLength(1);
  });
});

describe('undo', () => {
  const start = canvas(tile('w1', { x: 1, y: 1 }));

  it('records one step for a whole drag, not one per frame', () => {
    // **The reason `draft` and `record` are separate.** A drag is fifty pointer moves; fifty undo
    // steps to get back where it began is a replay, not an undo.
    let line = timeline(start);
    const before = line.present;
    for (let x = 2; x <= 20; x += 1) {
      line = draft(line, placeTile(line.present, 'w1', { x, y: 1, w: 4, h: 3 }));
    }
    line = record(line, before);

    expect(line.past).toHaveLength(1);
    expect(undo(line).present).toBe(start);
  });

  it('records nothing for a drag that ended where it started', () => {
    // Otherwise Ctrl+Z appears to do nothing, and the operator concludes undo is broken.
    let line = timeline(start);
    const before = line.present;
    line = draft(line, placeTile(line.present, 'w1', { x: 8, y: 8, w: 4, h: 3 }));
    line = draft(line, placeTile(line.present, 'w1', { x: 1, y: 1, w: 4, h: 3 }));
    line = record(line, before);

    expect(line.past).toHaveLength(0);
    expect(canUndo(line)).toBe(false);
  });

  it('walks back and forward through several edits', () => {
    let line = timeline(start);
    line = change(line, moveTile(line.present, 'w1', 1, 0));
    line = change(line, moveTile(line.present, 'w1', 1, 0));
    expect(line.present.tiles[0]?.box.x).toBe(3);

    line = undo(undo(line));
    expect(line.present.tiles[0]?.box.x).toBe(1);
    expect(canRedo(line)).toBe(true);

    line = redo(line);
    expect(line.present.tiles[0]?.box.x).toBe(2);
  });

  it('throws the redos away as soon as something new happens', () => {
    let line = change(timeline(start), moveTile(start, 'w1', 1, 0));
    line = undo(line);
    expect(canRedo(line)).toBe(true);

    line = change(line, moveTile(line.present, 'w1', 0, 1));
    expect(canRedo(line)).toBe(false);
  });

  it('does nothing at either end of the history', () => {
    const empty = timeline(start);
    expect(undo(empty)).toBe(empty);
    expect(redo(empty)).toBe(empty);
  });

  it('forgets the oldest edits rather than growing all afternoon', () => {
    let line = timeline(start);
    for (let i = 0; i < HISTORY_DEPTH + 20; i += 1) {
      line = change(line, moveTile(line.present, 'w1', i % 2 === 0 ? 1 : -1, 0));
    }
    expect(line.past).toHaveLength(HISTORY_DEPTH);
  });

  it('is unmoved by an edit that changed nothing', () => {
    const line = change(timeline(start), moveTile(start, 'w1', 0, 0));
    expect(canUndo(line)).toBe(false);
  });

  it('drops a selection the undo took away', () => {
    // A toolbar acting on a tile that no longer exists silently does nothing, which is the
    // failure `keepActive` fixes for the tree.
    const added = addTile(start, tile('w9'));
    expect(keepSelection(added, 'w9')).toBe('w9');
    expect(keepSelection(start, 'w9')).toBe(null);
  });

  it('tells two canvases apart by what is on them, not by identity', () => {
    expect(sameCanvas(start, canvas(tile('w1', { x: 1, y: 1 })))).toBe(true);
    expect(sameCanvas(start, canvas(tile('w1', { x: 2, y: 1 })))).toBe(false);
    expect(sameCanvas(start, canvas())).toBe(false);
  });
});

describe('the keyboard', () => {
  const cases: { name: string; press: KeyPress; selected: boolean; expected: unknown }[] = [
    {
      name: 'left moves',
      press: press('ArrowLeft'),
      selected: true,
      expected: { kind: 'move', dx: -1, dy: 0 },
    },
    {
      name: 'down moves',
      press: press('ArrowDown'),
      selected: true,
      expected: { kind: 'move', dx: 0, dy: 1 },
    },
    {
      name: 'shift and right resizes',
      press: press('ArrowRight', { shiftKey: true }),
      selected: true,
      expected: { kind: 'resize', dw: 1, dh: 0 },
    },
    {
      name: 'shift and up resizes',
      press: press('ArrowUp', { shiftKey: true }),
      selected: true,
      expected: { kind: 'resize', dw: 0, dh: -1 },
    },
    {
      name: 'delete removes',
      press: press('Delete'),
      selected: true,
      expected: { kind: 'delete' },
    },
    {
      name: 'backspace removes too',
      press: press('Backspace'),
      selected: true,
      expected: { kind: 'delete' },
    },
    {
      name: 'escape abandons',
      press: press('Escape'),
      selected: true,
      expected: { kind: 'cancel' },
    },
    {
      name: 'ctrl and z undoes',
      press: press('z', { ctrlKey: true }),
      selected: true,
      expected: { kind: 'undo' },
    },
    {
      name: 'cmd and z undoes on a Mac',
      press: press('z', { metaKey: true }),
      selected: false,
      expected: { kind: 'undo' },
    },
    {
      name: 'cmd, shift and z redoes',
      press: press('z', { metaKey: true, shiftKey: true }),
      selected: false,
      expected: { kind: 'redo' },
    },
    {
      name: 'ctrl and y redoes',
      press: press('y', { ctrlKey: true }),
      selected: false,
      expected: { kind: 'redo' },
    },
    {
      name: 'ctrl and an arrow is not ours',
      press: press('ArrowLeft', { ctrlKey: true }),
      selected: true,
      expected: { kind: 'none' },
    },
    {
      name: 'alt and an arrow is not ours either',
      press: press('ArrowLeft', { altKey: true }),
      selected: true,
      expected: { kind: 'none' },
    },
    {
      name: 'an arrow with nothing selected does nothing',
      press: press('ArrowLeft'),
      selected: false,
      expected: { kind: 'none' },
    },
    {
      name: 'delete with nothing selected does nothing',
      press: press('Delete'),
      selected: false,
      expected: { kind: 'none' },
    },
    {
      name: 'a letter is just a letter',
      press: press('q'),
      selected: true,
      expected: { kind: 'none' },
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      expect(canvasCommand(entry.press, entry.selected)).toEqual(entry.expected);
    });
  }

  it('undoes whether or not a tile is selected', () => {
    // Undo is about the canvas, not about the tile, and requiring a selection would strand
    // somebody who had just deleted the thing they wanted back.
    expect(canvasCommand(press('z', { ctrlKey: true }), false)).toEqual({ kind: 'undo' });
  });

  it('reads a shifted Z as a redo rather than as a resize', () => {
    // The pair that gets swapped: Shift means "resize" for arrows and "the other direction" for
    // undo, and only the order these are tested in decides it.
    expect(canvasCommand(press('Z', { metaKey: true, shiftKey: true }), true)).toEqual({
      kind: 'redo',
    });
  });
});

describe('what gets announced', () => {
  it('counts columns and rows from one, the way a person does', () => {
    expect(describeBox({ x: 0, y: 0, w: 6, h: 4 })).toBe('column 1, row 1, 6 by 4');
  });
});

describe('the saved document', () => {
  it('round-trips a canvas', () => {
    const start = canvas(tile('w1', { x: 3, y: 2, w: 6, h: 5 }));
    expect(readCanvas(writeLayout(start))).toEqual(start);
  });

  it('opens rather than refusing when a tile cannot be read', () => {
    const layout = {
      widgets: [
        { id: 'good', kind: 'status', objectId: 7, title: 'Fine', box: { x: 1, y: 1, w: 4, h: 3 } },
        { id: 'bad-kind', kind: 'teapot', objectId: 7 },
        { id: 'bad-object', kind: 'status', objectId: 'seven' },
        'not an object',
      ],
    };
    const read = readCanvas(layout);
    expect(read.tiles).toHaveLength(1);
    expect(read.tiles[0]?.id).toBe('good');
  });

  it('gives the second tile claiming an id a different one', () => {
    // Two tiles with one id are two tiles React keys the same and the toolbar cannot tell apart.
    const read = readCanvas({
      widgets: [
        { id: 'same', kind: 'status', objectId: 1 },
        { id: 'same', kind: 'status', objectId: 2 },
      ],
    });
    expect(read.tiles).toHaveLength(2);
    expect(read.tiles[0]?.id).not.toBe(read.tiles[1]?.id);
  });

  it('pulls a tile written outside the canvas back onto it', () => {
    const read = readCanvas({
      widgets: [{ id: 'w1', kind: 'status', objectId: 1, box: { x: 999, y: 999, w: 4, h: 3 } }],
    });
    const box = read.tiles[0]?.box;
    expect(box).toEqual({ x: COLUMNS - 4, y: ROWS - 3, w: 4, h: 3 });
  });

  it('reads nothing out of a document that has no widgets', () => {
    expect(readCanvas(null).tiles).toHaveLength(0);
    expect(readCanvas({ widgets: 'no' }).tiles).toHaveLength(0);
  });

  it('stops at the ceiling the core stops at', () => {
    const widgets = Array.from({ length: MAX_TILES + 5 }, (_, i) => ({
      id: `w${String(i)}`,
      kind: 'status',
      objectId: 1,
    }));
    expect(readCanvas({ widgets }).tiles).toHaveLength(MAX_TILES);
  });
});

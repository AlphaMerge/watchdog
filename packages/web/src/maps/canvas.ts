/**
 * The designer's geometry, its undo stack and its keyboard — decided without a DOM (`G-03`).
 *
 * **Separate from the component for the same reason `treeCommand` is** (`U-11`): this is the half
 * that is easy to get wrong and awkward to test through a rendered canvas. "Shift and an arrow
 * resizes, an arrow alone moves" is a pair that gets swapped, and a drag that commits one undo
 * step per pixel is an undo button that does nothing — both are table-driven questions here and
 * an ordeal against a real pointer.
 *
 * **Grid units, not pixels.** `packages/core/src/maps/widgets.ts` stores `box` in units and says
 * `G-03` decides how big one is; `CELL` is that decision and it is the only pixel constant in the
 * model. Everything the core stores stays resolution-independent, which is what lets `G-06`'s
 * share link render the same map on a wall display and a laptop.
 */

/** The kinds the core resolves today. `G-08` adds to this list. */
export const WIDGET_KINDS = ['status', 'sensor-list', 'table', 'graph', 'html'] as const;

/** The kinds that draw an object. `html` draws what somebody typed and names nothing. */
export const OBJECT_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'status',
  'sensor-list',
  'table',
  'graph',
]);

/** Per widget, matching the core's ceiling. A tile is a tile; longer than this is a page. */
export const MAX_HTML = 4096;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const KIND_LABELS: Readonly<Record<WidgetKind, string>> = {
  status: 'Status',
  'sensor-list': 'Sensor list',
  table: 'Channel table',
  graph: 'Graph',
  html: 'Custom HTML',
};

/**
 * How far back a graph tile draws, in minutes (`G-04`).
 *
 * Per tile rather than one control for the canvas: the point of putting a week beside an hour is
 * the comparison. Each tile carries its range in its own label, so nobody has to remember which
 * period they are looking at — which is the failure a shared control on the sensor page avoids
 * by having one range for everything.
 */
export const RANGES: readonly { readonly minutes: number; readonly label: string }[] = [
  { minutes: 60, label: '1 hour' },
  { minutes: 6 * 60, label: '6 hours' },
  { minutes: 24 * 60, label: '24 hours' },
  { minutes: 7 * 24 * 60, label: '7 days' },
  { minutes: 30 * 24 * 60, label: '30 days' },
];

export const DEFAULT_RANGE_MINUTES = 60;

export function rangeLabel(minutes: number): string {
  return RANGES.find((range) => range.minutes === minutes)?.label ?? `${String(minutes)} minutes`;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Tile {
  readonly id: string;
  readonly kind: WidgetKind;
  /** `null` for the kinds that draw no object (`G-07`). */
  readonly objectId: number | null;
  readonly title: string;
  readonly box: Box;
  /** Only a `graph` reads this; every kind carries it so the document has one shape. */
  readonly rangeMinutes: number;
  /**
   * The markup a `html` tile renders (`G-07`).
   *
   * Never cleaned here or anywhere else: it is rendered inside `<iframe sandbox srcdoc>` with no
   * same-origin access, which is safe by construction. A sanitiser in front of that would be a
   * weaker second defence that invites somebody to lean on it (`ADR-002` Decision 2).
   */
  readonly html: string;
  /** Where on the ground this tile sits (`G-08`), or `null` for one placed by its box. */
  readonly at: { readonly lat: number; readonly lon: number } | null;
}

/**
 * A line between two tiles (`G-05`).
 *
 * **Endpoints are tile ids, not object ids.** A connector is a statement about the picture, and
 * the same sensor can appear on a canvas twice — a line to *the sensor* would be ambiguous about
 * which tile it meant.
 */
export interface Connector {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** A map's geographical block (`G-08`): where it opens, and the `ADR-004` Decision 4 opt-in. */
export interface MapGeo {
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
  readonly publicTiles: boolean;
}

export interface Canvas {
  readonly tiles: readonly Tile[];
  readonly connectors: readonly Connector[];
  /** `null` when this map is not geographical, which is every map until somebody says otherwise. */
  readonly geo: MapGeo | null;
}

export const EMPTY: Canvas = { tiles: [], connectors: [], geo: null };

/** How wide the canvas is, in grid units. Fixed, so a map made on a laptop fits a wall display. */
export const COLUMNS = 32;

/** And how tall. A canvas that scrolls forever is a canvas somebody loses a widget on. */
export const ROWS = 48;

/** One grid unit, in CSS pixels. */
export const CELL = 24;

/**
 * The smallest tile the designer will make.
 *
 * The core's floor is 1×1 — it only refuses the zero-sized tile that would be invisible and
 * unclickable. Two is this layer's floor because a 24px tile is smaller than its own resize
 * handle and exactly on `U-11`'s 24px target minimum: a control you cannot reliably hit is not
 * a control, whatever the document is allowed to hold.
 */
export const MIN_W = 2;
export const MIN_H = 2;

/** The core resolves the first 200 widgets and reports the rest as a problem; do not make 201. */
export const MAX_TILES = 200;

/** Two per tile, matching the core's ceiling. Bounded because the document is caller-supplied. */
export const MAX_CONNECTORS = 400;

/** How far back undo goes. Bounded, because a designer left open all afternoon is not a leak. */
export const HISTORY_DEPTH = 50;

const DEFAULT_W = 6;
const DEFAULT_H = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whole(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * A pointer distance in pixels, as grid units.
 *
 * **Rounded rather than truncated.** Truncation makes a tile trail half a cell behind the pointer
 * the whole way and only catch up at the end of the drag, which reads as the canvas being slow
 * rather than as the grid being coarse.
 */
export function unitsFromPixels(pixels: number): number {
  return Math.round(pixels / CELL);
}

/** A box moved back inside the canvas, its size untouched. */
export function clampMoved(box: Box): Box {
  return {
    ...box,
    x: Math.max(0, Math.min(box.x, COLUMNS - box.w)),
    y: Math.max(0, Math.min(box.y, ROWS - box.h)),
  };
}

/** A box resized back inside the canvas, its position untouched. */
export function clampSized(box: Box): Box {
  return {
    ...box,
    w: Math.min(Math.max(MIN_W, box.w), Math.max(MIN_W, COLUMNS - box.x)),
    h: Math.min(Math.max(MIN_H, box.h), Math.max(MIN_H, ROWS - box.y)),
  };
}

/**
 * A box from anywhere made to fit.
 *
 * **Sized against the canvas rather than against its own x**, which is what `clampSized` does and
 * why this is not a call to it. Capping the width at `COLUMNS - x` is the right answer for a
 * resize handle, where x is where the operator anchored the tile; it is the wrong one for a
 * document that put the tile off the canvas entirely, because there x is the thing that is wrong
 * and a tile written at column 999 came back 2 wide. Size first, then position, both against the
 * grid.
 */
export function fit(box: Box): Box {
  return clampMoved({
    ...box,
    w: Math.min(Math.max(MIN_W, box.w), COLUMNS),
    h: Math.min(Math.max(MIN_H, box.h), ROWS),
  });
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where a new tile goes.
 *
 * **Overlap is allowed everywhere else and refused only here.** A map is a picture — a label over
 * a background image, a legend across a group box — and a designer that packs tiles apart is
 * fighting the person using it. But a new tile landing exactly on top of the last one looks like
 * the Add button did nothing, and that is the one case worth searching for a gap over.
 */
export function firstFreeBox(canvas: Canvas, w = DEFAULT_W, h = DEFAULT_H): Box {
  for (let y = 0; y + h <= ROWS; y += 1) {
    for (let x = 0; x + w <= COLUMNS; x += 1) {
      const box = { x, y, w, h };
      if (!canvas.tiles.some((tile) => overlaps(tile.box, box))) return box;
    }
  }
  return fit({ x: 0, y: 0, w, h });
}

function replace(canvas: Canvas, id: string, next: (tile: Tile) => Tile): Canvas {
  // The canvas comes back unchanged, by identity, when the id names nothing — `sameCanvas` is
  // what every caller would otherwise have to run to find that out.
  const found = canvas.tiles.find((tile) => tile.id === id);
  if (found === undefined) return canvas;
  return {
    ...canvas,
    tiles: canvas.tiles.map((tile) => (tile === found ? next(tile) : tile)),
  };
}

export function tileById(canvas: Canvas, id: string | null): Tile | undefined {
  return id === null ? undefined : canvas.tiles.find((tile) => tile.id === id);
}

export function moveTile(canvas: Canvas, id: string, dx: number, dy: number): Canvas {
  return replace(canvas, id, (tile) => ({
    ...tile,
    box: clampMoved({ ...tile.box, x: tile.box.x + dx, y: tile.box.y + dy }),
  }));
}

export function resizeTile(canvas: Canvas, id: string, dw: number, dh: number): Canvas {
  return replace(canvas, id, (tile) => ({
    ...tile,
    box: clampSized({ ...tile.box, w: tile.box.w + dw, h: tile.box.h + dh }),
  }));
}

/** Used by a pointer drag, which knows where the tile should be rather than how far it moved. */
export function placeTile(canvas: Canvas, id: string, box: Box): Canvas {
  return replace(canvas, id, (tile) => ({ ...tile, box: fit(box) }));
}

export function retitleTile(canvas: Canvas, id: string, title: string): Canvas {
  return replace(canvas, id, (tile) => ({ ...tile, title }));
}

export function retimeTile(canvas: Canvas, id: string, rangeMinutes: number): Canvas {
  return replace(canvas, id, (tile) => ({ ...tile, rangeMinutes }));
}

/** Pins a tile to a place, or takes it off the ground and back onto the grid with `null`. */
export function placeAt(
  canvas: Canvas,
  id: string,
  at: { lat: number; lon: number } | null,
): Canvas {
  if (at !== null && (!inLatitude(at.lat) || !inLongitude(at.lon))) return canvas;
  return replace(canvas, id, (tile) => ({ ...tile, at }));
}

/** A map's home view. `null` makes it an ordinary canvas again without losing the widgets. */
export function setGeo(canvas: Canvas, geo: MapGeo | null): Canvas {
  if (geo !== null && (!inLatitude(geo.lat) || !inLongitude(geo.lon))) return canvas;
  return { ...canvas, geo };
}

const inLatitude = (lat: number): boolean => Number.isFinite(lat) && lat >= -90 && lat <= 90;
const inLongitude = (lon: number): boolean => Number.isFinite(lon) && lon >= -180 && lon <= 180;

/** Truncated rather than refused, the same as the core does when it reads one back. */
export function rewriteHtml(canvas: Canvas, id: string, html: string): Canvas {
  return replace(canvas, id, (tile) => ({ ...tile, html: html.slice(0, MAX_HTML) }));
}

/**
 * Removes a tile **and every line that touched it**.
 *
 * Leaving the lines would save a document the core can only report as broken — a connector whose
 * endpoint is not on the canvas has no geometry, so it cannot be drawn as a broken line the way a
 * widget is drawn as a broken tile. Undo restores both together, because it restores the canvas.
 */
export function removeTile(canvas: Canvas, id: string): Canvas {
  const tiles = canvas.tiles.filter((tile) => tile.id !== id);
  if (tiles.length === canvas.tiles.length) return canvas;
  return {
    ...canvas,
    tiles,
    connectors: canvas.connectors.filter((line) => line.from !== id && line.to !== id),
  };
}

/** A line between two tiles, or the canvas unchanged when it would be a duplicate or a loop. */
export function connect(canvas: Canvas, from: string, to: string): Canvas {
  if (from === to) return canvas;
  const known = new Set(canvas.tiles.map((tile) => tile.id));
  if (!known.has(from) || !known.has(to)) return canvas;
  // Undirected as far as duplicates go: A→B and B→A are one line on screen, and letting both
  // exist means a canvas that looks unchanged and a document that grows every time it is clicked.
  const already = canvas.connectors.some(
    (line) => (line.from === from && line.to === to) || (line.from === to && line.to === from),
  );
  if (already) return canvas;
  return {
    ...canvas,
    connectors: [...canvas.connectors, { id: nextConnectorId(canvas), from, to }],
  };
}

export function disconnect(canvas: Canvas, id: string): Canvas {
  const connectors = canvas.connectors.filter((line) => line.id !== id);
  return connectors.length === canvas.connectors.length ? canvas : { ...canvas, connectors };
}

function nextConnectorId(canvas: Canvas): string {
  const taken = new Set(canvas.connectors.map((line) => line.id));
  let n = canvas.connectors.length + 1;
  while (taken.has(`c${String(n)}`)) n += 1;
  return `c${String(n)}`;
}

/**
 * Where a line between two tiles starts and ends, in pixels.
 *
 * **Clipped to each tile's own edge rather than drawn centre to centre.** A line under both tiles
 * is invisible where it matters — at the tiles — and reads as two boxes with a gap between them
 * rather than as a connection. The clip is the point where the centre-to-centre ray leaves each
 * rectangle: whichever of the two edges it reaches first.
 */
export function connectorLine(
  from: Box,
  to: Box,
): { x1: number; y1: number; x2: number; y2: number } {
  const a = { x: (from.x + from.w / 2) * CELL, y: (from.y + from.h / 2) * CELL };
  const b = { x: (to.x + to.w / 2) * CELL, y: (to.y + to.h / 2) * CELL };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Two tiles stacked exactly on top of each other have no direction to clip along. A zero-length
  // line is the honest answer; anything else would be a made-up direction.
  if (dx === 0 && dy === 0) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };

  const start = edge(a, dx, dy, from);
  const end = edge(b, -dx, -dy, to);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

function edge(
  centre: { x: number; y: number },
  dx: number,
  dy: number,
  box: Box,
): { x: number; y: number } {
  const hw = (box.w * CELL) / 2;
  const hh = (box.h * CELL) / 2;
  // How far along the ray each edge is; the nearer one is the edge it actually crosses.
  const toSide = dx === 0 ? Infinity : hw / Math.abs(dx);
  const toTop = dy === 0 ? Infinity : hh / Math.abs(dy);
  const scale = Math.min(toSide, toTop);
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

/**
 * A new tile, or the canvas unchanged when there is no room for one.
 *
 * Refused at the ceiling rather than added and truncated later: the core resolves the first 200
 * and reports the rest as a problem, so a designer that let somebody make the 201st would be
 * saving work that silently stops being drawn.
 */
export function addTile(canvas: Canvas, tile: Tile): Canvas {
  if (canvas.tiles.length >= MAX_TILES) return canvas;
  if (canvas.tiles.some((existing) => existing.id === tile.id)) return canvas;
  return { ...canvas, tiles: [...canvas.tiles, { ...tile, box: fit(tile.box) }] };
}

export function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function sameCanvas(a: Canvas, b: Canvas): boolean {
  if (a === b) return true;
  if (a.tiles.length !== b.tiles.length) return false;
  if (a.geo?.lat !== b.geo?.lat || a.geo?.lon !== b.geo?.lon) return false;
  if (a.geo?.zoom !== b.geo?.zoom || a.geo?.publicTiles !== b.geo?.publicTiles) return false;
  if (a.connectors.length !== b.connectors.length) return false;
  const linesAgree = a.connectors.every((line, index) => {
    const other = b.connectors[index];
    return (
      other !== undefined &&
      line.id === other.id &&
      line.from === other.from &&
      line.to === other.to
    );
  });
  if (!linesAgree) return false;
  return a.tiles.every((tile, index) => {
    const other = b.tiles[index];
    return (
      other !== undefined &&
      tile.id === other.id &&
      tile.kind === other.kind &&
      tile.objectId === other.objectId &&
      tile.title === other.title &&
      tile.rangeMinutes === other.rangeMinutes &&
      tile.html === other.html &&
      tile.at?.lat === other.at?.lat &&
      tile.at?.lon === other.at?.lon &&
      sameBox(tile.box, other.box)
    );
  });
}

/* ------------------------------------------------------------------ undo */

export interface Timeline {
  readonly past: readonly Canvas[];
  readonly present: Canvas;
  readonly future: readonly Canvas[];
}

export function timeline(present: Canvas): Timeline {
  return { past: [], present, future: [] };
}

/**
 * The canvas as it looks *during* a gesture — no undo entry.
 *
 * A drag produces one of these per pointer move. Recording each would make Ctrl+Z step the tile
 * back one cell at a time for as long as the drag took, which is not undo; it is a replay.
 */
export function draft(line: Timeline, present: Canvas): Timeline {
  return { ...line, present };
}

/**
 * One entry for a whole gesture, `before` being how the canvas looked when it started.
 *
 * **A gesture that ended where it started records nothing.** Picking a tile up and putting it
 * back is not an edit, and an undo stack full of those is an undo button that appears broken —
 * the operator presses it, the canvas does not move, and they conclude the feature is dead.
 */
export function record(line: Timeline, before: Canvas): Timeline {
  if (sameCanvas(before, line.present)) return line;
  return {
    past: [...line.past, before].slice(-HISTORY_DEPTH),
    present: line.present,
    future: [],
  };
}

/** An edit that happens all at once: a key press, a delete, an added tile. */
export function change(line: Timeline, present: Canvas): Timeline {
  return record(draft(line, present), line.present);
}

export function canUndo(line: Timeline): boolean {
  return line.past.length > 0;
}

export function canRedo(line: Timeline): boolean {
  return line.future.length > 0;
}

export function undo(line: Timeline): Timeline {
  const previous = line.past[line.past.length - 1];
  if (previous === undefined) return line;
  return {
    past: line.past.slice(0, -1),
    present: previous,
    future: [line.present, ...line.future].slice(0, HISTORY_DEPTH),
  };
}

export function redo(line: Timeline): Timeline {
  const [next, ...rest] = line.future;
  if (next === undefined) return line;
  return {
    past: [...line.past, line.present].slice(-HISTORY_DEPTH),
    present: next,
    future: rest,
  };
}

/**
 * The selection after the canvas changed underneath it.
 *
 * Undoing the addition of a tile leaves the selection pointing at something that no longer
 * exists, and a toolbar acting on a phantom id silently does nothing — the same failure
 * `keepActive` fixes for the tree, where an index past the end left no focusable row at all.
 */
export function keepSelection(canvas: Canvas, selected: string | null): string | null {
  if (selected === null) return null;
  return canvas.tiles.some((tile) => tile.id === selected) ? selected : null;
}

/* --------------------------------------------------------------- gestures */

export interface Gesture {
  readonly id: string;
  readonly mode: 'move' | 'resize';
  /** The tile's box when the pointer went down. Every frame is computed from this, not the last */
  readonly origin: Box;
  /** Where the pointer went down, in pixels. */
  readonly from: { readonly x: number; readonly y: number };
  /** The whole canvas when the pointer went down, which is the one undo entry the drag makes. */
  readonly before: Canvas;
}

/**
 * Where the dragged tile is now.
 *
 * **Computed from the origin every frame rather than accumulated.** Adding a delta to the last
 * position rounds once per pointer move, and those roundings compound into a tile that drifts
 * away from the cursor over a long drag — the classic snapping bug, and invisible in a test that
 * moves the pointer once.
 */
export function gestureBox(gesture: Gesture, to: { x: number; y: number }): Box {
  const dx = unitsFromPixels(to.x - gesture.from.x);
  const dy = unitsFromPixels(to.y - gesture.from.y);
  const origin = gesture.origin;
  return gesture.mode === 'move'
    ? clampMoved({ ...origin, x: origin.x + dx, y: origin.y + dy })
    : clampSized({ ...origin, w: origin.w + dx, h: origin.h + dy });
}

/* ------------------------------------------------------------- keyboard */

export type CanvasCommand =
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'resize'; readonly dw: number; readonly dh: number }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'none' };

const NONE: CanvasCommand = { kind: 'none' };

export interface KeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

const ARROWS: Readonly<Record<string, { dx: number; dy: number }>> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

/**
 * What a key press means on the canvas (`U-11`).
 *
 * **A designer that needs a mouse fails the same criterion the tree did**, and for the same
 * reason: drag-and-drop is 2.1.1 Keyboard, and there is no exception for "it is a canvas". Every
 * gesture the pointer can make has a key here — move, resize, delete, undo, redo, abandon.
 *
 * **The accelerator is Ctrl *or* Cmd**, because this is the one place a Mac and a PC disagree
 * about the same intention, and a designer where undo works on one and not the other is a bug
 * report nobody can reproduce.
 *
 * **An arrow with a modifier we do not own returns `none`.** Ctrl+Arrow and Alt+Arrow are the
 * browser's and the window manager's — moving a tile out from under them would steal a shortcut
 * the operator did not aim here.
 */
export function canvasCommand(press: KeyPress, hasSelection: boolean): CanvasCommand {
  const accel = press.ctrlKey || press.metaKey;

  if (accel && (press.key === 'z' || press.key === 'Z')) {
    return press.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
  }
  if (accel && (press.key === 'y' || press.key === 'Y')) return { kind: 'redo' };
  if (press.key === 'Escape') return { kind: 'cancel' };

  if (!hasSelection) return NONE;
  if (press.key === 'Delete' || press.key === 'Backspace') return { kind: 'delete' };

  const step = ARROWS[press.key];
  if (step === undefined || accel || press.altKey) return NONE;
  return press.shiftKey
    ? { kind: 'resize', dw: step.dx, dh: step.dy }
    : { kind: 'move', dx: step.dx, dy: step.dy };
}

/** What a tile's position reads as out loud, for the live region that announces every edit. */
export function describeBox(box: Box): string {
  return `column ${String(box.x + 1)}, row ${String(box.y + 1)}, ${String(box.w)} by ${String(box.h)}`;
}

/* ------------------------------------------------------- the document */

/**
 * The saved layout, read the way the core reads it.
 *
 * **Defensively, and for the same reason**: `map.layout` is a `jsonb` document an API caller
 * wrote, and one unreadable tile must not be a designer that will not open. A tile that cannot be
 * read is dropped here rather than kept as a problem — the core keeps it so a *viewer* can see
 * that something is broken, while a designer that re-saves has to write a document it understands
 * or it would launder a broken tile into a valid-looking one.
 */
export function readCanvas(layout: unknown): Canvas {
  const raw = isRecord(layout) && Array.isArray(layout['widgets']) ? layout['widgets'] : [];
  const tiles: Tile[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.slice(0, MAX_TILES).entries()) {
    if (!isRecord(entry)) continue;
    const kind = entry['kind'];
    if (typeof kind !== 'string' || !(WIDGET_KINDS as readonly string[]).includes(kind)) continue;
    const rawObjectId = entry['objectId'];
    const objectId =
      typeof rawObjectId === 'number' && Number.isInteger(rawObjectId) && rawObjectId > 0
        ? rawObjectId
        : null;
    // Only the kinds that draw one need one; the core reads it back the same way.
    if (objectId === null && OBJECT_KINDS.has(kind as WidgetKind)) continue;

    // A duplicate id is two tiles React would give the same key and two tiles the toolbar could
    // not tell apart; the second one gets a fresh one rather than being dropped.
    const claimed = typeof entry['id'] === 'string' ? entry['id'] : '';
    const id = claimed !== '' && !seen.has(claimed) ? claimed : `tile-${String(index)}-${claimed}`;
    seen.add(id);

    const box = isRecord(entry['box']) ? entry['box'] : {};
    tiles.push({
      id,
      kind: kind as WidgetKind,
      objectId: OBJECT_KINDS.has(kind as WidgetKind) ? objectId : null,
      title: typeof entry['title'] === 'string' ? entry['title'] : '',
      rangeMinutes: whole(entry['rangeMinutes'], DEFAULT_RANGE_MINUTES),
      html: typeof entry['html'] === 'string' ? entry['html'].slice(0, MAX_HTML) : '',
      at: readAt(entry['at']),
      box: fit({
        x: whole(box['x'], 0),
        y: whole(box['y'], 0),
        w: whole(box['w'], DEFAULT_W),
        h: whole(box['h'], DEFAULT_H),
      }),
    });
  }

  // Connectors last, because an endpoint has to be a tile that survived the read above: a line
  // to a widget the document could not describe is a line with nowhere to start.
  const known = new Set(tiles.map((tile) => tile.id));
  const rawLines =
    isRecord(layout) && Array.isArray(layout['connectors']) ? layout['connectors'] : [];
  const connectors: Connector[] = [];
  const claimed = new Set<string>();
  for (const [index, entry] of rawLines.slice(0, MAX_CONNECTORS).entries()) {
    if (!isRecord(entry)) continue;
    const from = entry['from'];
    const to = entry['to'];
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (from === to || !known.has(from) || !known.has(to)) continue;
    const id = typeof entry['id'] === 'string' ? entry['id'] : `c${String(index)}`;
    if (claimed.has(id)) continue;
    claimed.add(id);
    connectors.push({ id, from, to });
  }

  return { tiles, connectors, geo: readGeo(layout) };
}

function readAt(raw: unknown): { lat: number; lon: number } | null {
  if (!isRecord(raw)) return null;
  const lat = raw['lat'];
  const lon = raw['lon'];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  // Out of range is a typo rather than a place, and clamping would put a widget somewhere real
  // and wrong — the same rule the core applies when it reads the document back.
  return inLatitude(lat) && inLongitude(lon) ? { lat, lon } : null;
}

function readGeo(layout: unknown): MapGeo | null {
  const raw = isRecord(layout) && isRecord(layout['geo']) ? layout['geo'] : null;
  if (raw === null) return null;
  const lat = raw['lat'];
  const lon = raw['lon'];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!inLatitude(lat) || !inLongitude(lon)) return null;
  return {
    lat,
    lon,
    zoom: whole(raw['zoom'], 3),
    publicTiles: raw['publicTiles'] === true,
  };
}

export function writeLayout(canvas: Canvas): {
  widgets: Record<string, unknown>[];
  connectors: Connector[];
  geo?: MapGeo;
} {
  return {
    // Absent rather than null when the map is not geographical: a `geo` key holding nothing is a
    // key the next reader has to decide about.
    ...(canvas.geo === null ? {} : { geo: canvas.geo }),
    connectors: [...canvas.connectors],
    widgets: canvas.tiles.map((tile) => ({
      id: tile.id,
      kind: tile.kind,
      objectId: tile.objectId,
      title: tile.title,
      rangeMinutes: tile.rangeMinutes,
      html: tile.html,
      ...(tile.at === null ? {} : { at: tile.at }),
      box: tile.box,
    })),
  };
}

/** An id for a new tile. Not `crypto.randomUUID` — this has to be stable to read in a document. */
export function nextTileId(canvas: Canvas): string {
  let n = canvas.tiles.length + 1;
  const taken = new Set(canvas.tiles.map((tile) => tile.id));
  while (taken.has(`w${String(n)}`)) n += 1;
  return `w${String(n)}`;
}

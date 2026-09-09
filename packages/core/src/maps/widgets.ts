/**
 * What a widget is, and what resolving one can produce (`G-02`).
 *
 * **The document is validated, never trusted.** `map.layout` is `jsonb` that an API caller wrote,
 * so every field here is read defensively and a widget that does not parse becomes a widget that
 * says so — the map still renders, with one broken tile, rather than failing whole. A designer
 * that saved something odd should not take a wall display down with it.
 */

/** The kinds resolved today. Geo is `G-08`. */
export const WIDGET_KINDS = ['status', 'sensor-list', 'table', 'graph', 'html'] as const;

/**
 * The kinds that draw an object, which is every kind but one.
 *
 * `html` draws whatever an operator typed and names nothing — so requiring an `objectId` of it
 * would mean inventing one, and a widget carrying a sensor id it does not read is a widget that
 * blocks that sensor's deletion in a future ticket that starts believing the field.
 */
const OBJECT_KINDS: ReadonlySet<string> = new Set(['status', 'sensor-list', 'table', 'graph']);

export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** Where a widget sits on the canvas. Grid units, not pixels: `G-03` decides how big one is. */
export interface WidgetBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Widget {
  /** Stable within the map, so a resolution can be matched back to the tile that asked. */
  readonly id: string;
  readonly kind: WidgetKind;
  readonly box: WidgetBox;
  /** What this widget draws. A sensor for `status` and `table`, any object for `sensor-list`. */
  /** The object this widget draws, or `null` for the kinds that draw none (`G-07`). */
  readonly objectId: number | null;
  readonly title: string;
  /**
   * The markup a `html` widget renders (`G-07`, `ADR-002` Decision 2). Empty for every other kind.
   *
   * **Stored exactly as it was typed, and deliberately not sanitised.** A sanitiser is safe for
   * as long as it is complete and stays complete against the entire history of browser parsing
   * quirks; the renderer puts this in a sandboxed iframe with no same-origin access, which is
   * safe by construction. Cleaning it here would be a second, weaker defence that invites
   * somebody to rely on it.
   */
  readonly html: string;
  /**
   * How far back a `graph` widget draws (`G-04`). Ignored by every other kind.
   *
   * **Per widget, unlike the sensor page's one range control for the whole tab.** A map is built
   * to be looked at rather than read through: the point of putting a week beside an hour is the
   * comparison, and a single range for a whole canvas would make that impossible. The reason the
   * sensor page refuses per-panel ranges — two panels silently showing different periods — does
   * not apply where each tile is separately labelled with its own.
   */
  readonly rangeMinutes: number;
}

/**
 * What became of one widget.
 *
 * **`unavailable` does not say why, and that is deliberate.** A widget can fail to resolve because
 * the object was deleted or because this viewer may not see it, and telling them apart tells a
 * reader whether an id they already know about still exists — the same oracle `G-01` refused when
 * it made an unreadable map answer 404. The reason is carried only for a viewer holding `full` on
 * the map, who is the person fixing it, and never for `G-06`'s public audience.
 */
export type ResolvedWidget =
  | {
      readonly id: string;
      readonly kind: WidgetKind;
      readonly box: WidgetBox;
      readonly title: string;
      readonly state: 'ok';
      readonly data: WidgetData;
    }
  | {
      readonly id: string;
      readonly kind: WidgetKind;
      readonly box: WidgetBox;
      readonly title: string;
      readonly state: 'unavailable';
      readonly reason?: UnavailableReason;
    }
  | {
      readonly id: string;
      readonly kind: WidgetKind;
      readonly box: WidgetBox;
      readonly title: string;
      readonly state: 'invalid';
      readonly problem: string;
    };

export type UnavailableReason = 'object-deleted' | 'not-visible';

export type WidgetData =
  | {
      /**
       * Markup, passed through untouched (`G-07`).
       *
       * The renderer's contract is `<iframe sandbox srcdoc>` with no `allow-same-origin`, so this
       * string is inert wherever it lands. Nothing between here and there cleans it, and that is
       * the decision `ADR-002` took: safe by construction beats safe by a sanitiser that has to
       * stay complete.
       */
      readonly kind: 'html';
      readonly html: string;
    }
  | {
      /**
       * What a graph tile needs to *start* (`G-04`).
       *
       * **The series are not here, and that is deliberate.** A resolved map is one request; a
       * week of buckets for every graph on the canvas is not a thing to put inside it, and each
       * tile draws its own range. What the resolver settles is which sensor, what it is called,
       * how it is doing, and which channels exist — everything a client would otherwise have to
       * ask a second question to find out.
       */
      readonly kind: 'graph';
      readonly objectId: number;
      readonly name: string;
      readonly sensorState: string;
      readonly rangeMinutes: number;
      readonly channels: readonly ChannelLine[];
    }
  | {
      readonly kind: 'status';
      readonly objectId: number;
      readonly name: string;
      readonly sensorState: string;
      readonly message: string;
      readonly since: string;
    }
  | {
      readonly kind: 'sensor-list';
      readonly objectId: number;
      readonly name: string;
      readonly sensors: readonly SensorLine[];
    }
  | {
      readonly kind: 'table';
      readonly objectId: number;
      readonly name: string;
      readonly channels: readonly ChannelLine[];
    };

export interface SensorLine {
  readonly id: number;
  readonly name: string;
  readonly sensorState: string;
  readonly message: string;
}

export interface ChannelLine {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  /** `null` is a gap, never a zero — a Down sensor recorded no value (`CLAUDE.md`). */
  readonly value: number | null;
}

const MAX_TITLE = 80;
/** Per widget. A tile is a tile; anything longer is a page, and a page is not a widget. */
const MAX_HTML = 4096;
const MAX_WIDGETS = 200;
/** Two per widget. Bounded for the same reason the widgets are: the document is caller-supplied. */
const MAX_CONNECTORS = 400;
/** A day either side of the default hour, and a ceiling a document cannot argue past. */
const MIN_RANGE_MINUTES = 5;
const MAX_RANGE_MINUTES = 60 * 24 * 31;
const DEFAULT_RANGE_MINUTES = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whole(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** One widget, or the reason it could not be read. Never throws: a bad tile is not a bad map. */
export function readWidget(raw: unknown, index: number): Widget | { problem: string; id: string } {
  const id = isRecord(raw) && typeof raw['id'] === 'string' ? raw['id'] : `widget-${String(index)}`;
  if (!isRecord(raw)) return { id, problem: 'not an object' };

  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    return { id, problem: `unknown widget kind ${String(kind)}` };
  }

  const rawObjectId = raw['objectId'];
  const objectId =
    typeof rawObjectId === 'number' && Number.isInteger(rawObjectId) && rawObjectId > 0
      ? rawObjectId
      : null;
  if (objectId === null && OBJECT_KINDS.has(kind)) {
    return { id, problem: 'objectId must be a positive whole number' };
  }

  const box = isRecord(raw['box']) ? raw['box'] : {};
  const title = typeof raw['title'] === 'string' ? raw['title'].slice(0, MAX_TITLE) : '';
  const range = whole(raw['rangeMinutes'], DEFAULT_RANGE_MINUTES);

  return {
    id,
    kind: kind as WidgetKind,
    // Dropped for the kinds that do not draw one, even when a document carries it: a field that
    // is read by nothing is a field a later reader starts trusting.
    objectId: OBJECT_KINDS.has(kind) ? objectId : null,
    title,
    // Bounded, and truncated rather than refused — a tile showing the first few kilobytes of
    // what somebody typed is a better answer than a map that will not open. The layout as a
    // whole is bounded again by the request body limit.
    html: typeof raw['html'] === 'string' ? raw['html'].slice(0, MAX_HTML) : '',
    // Clamped rather than refused: a range somebody typed badly is a tile drawn over a strange
    // period, not a map that will not open — and an unbounded one is a query anybody can ask.
    rangeMinutes: Math.min(Math.max(MIN_RANGE_MINUTES, range), MAX_RANGE_MINUTES),
    box: {
      x: whole(box['x'], 0),
      y: whole(box['y'], 0),
      // A zero-sized tile is invisible and unclickable, which reads as a widget that vanished.
      w: Math.max(1, whole(box['w'], 4)),
      h: Math.max(1, whole(box['h'], 3)),
    },
  };
}

/**
 * Every widget on a layout, with the unreadable ones kept as problems rather than dropped.
 *
 * **Bounded, because the layout is caller-supplied.** A map holding fifty thousand widgets is one
 * request that resolves fifty thousand objects; past the ceiling the rest are reported as a single
 * problem instead of being silently ignored, which is `CLAUDE.md`'s rule that backpressure is
 * visible.
 */
/**
 * A line drawn between two widgets (`G-05`).
 *
 * **Endpoints are widget ids, not object ids.** A connector says "this tile connects to that tile",
 * which is a statement about the picture; the same sensor can appear twice on a canvas, and a
 * connector to *the sensor* would be ambiguous about which of the two tiles it meant.
 *
 * No styling here on purpose: a line is a line until somebody asks for more, and a colour or a
 * dash pattern in the document is a thing every later renderer has to keep honouring.
 */
export interface Connector {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Every connector on a layout, with the ones that cannot be drawn kept as problems.
 *
 * **A connector naming a widget that is not on the canvas is reported, not dropped.** It has no
 * geometry, so it cannot be rendered as a broken line the way a widget is rendered as a broken
 * tile — but silently discarding it would let a designer save a document, reopen it, and find the
 * line gone with nothing said. Same rule as the widgets: what could not be read is named.
 *
 * A connector from a widget to itself is refused rather than drawn as a dot.
 */
export function readConnectors(
  layout: unknown,
  widgets: readonly Widget[],
): { connectors: Connector[]; problems: { id: string; problem: string }[] } {
  const raw = isRecord(layout) && Array.isArray(layout['connectors']) ? layout['connectors'] : [];
  const known = new Set(widgets.map((widget) => widget.id));
  const connectors: Connector[] = [];
  const problems: { id: string; problem: string }[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.slice(0, MAX_CONNECTORS).entries()) {
    const id =
      isRecord(entry) && typeof entry['id'] === 'string'
        ? entry['id']
        : `connector-${String(index)}`;
    if (!isRecord(entry)) {
      problems.push({ id, problem: 'not an object' });
      continue;
    }
    const from = entry['from'];
    const to = entry['to'];
    if (typeof from !== 'string' || typeof to !== 'string') {
      problems.push({ id, problem: 'from and to must be widget ids' });
      continue;
    }
    if (from === to) {
      problems.push({ id, problem: 'a connector cannot join a widget to itself' });
      continue;
    }
    if (!known.has(from) || !known.has(to)) {
      problems.push({ id, problem: `no widget called ${known.has(from) ? to : from}` });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ id, problem: 'two connectors share an id' });
      continue;
    }
    seen.add(id);
    connectors.push({ id, from, to });
  }

  if (raw.length > MAX_CONNECTORS) {
    problems.push({
      id: 'connectors',
      problem: `this map holds ${String(raw.length)} connectors; only the first ${String(MAX_CONNECTORS)} are drawn`,
    });
  }

  return { connectors, problems };
}

export function readWidgets(layout: unknown): {
  widgets: Widget[];
  problems: { id: string; problem: string }[];
} {
  const raw = isRecord(layout) && Array.isArray(layout['widgets']) ? layout['widgets'] : [];
  const widgets: Widget[] = [];
  const problems: { id: string; problem: string }[] = [];

  for (const [index, entry] of raw.slice(0, MAX_WIDGETS).entries()) {
    const read = readWidget(entry, index);
    if ('problem' in read) problems.push(read);
    else widgets.push(read);
  }

  if (raw.length > MAX_WIDGETS) {
    problems.push({
      id: 'layout',
      problem: `this map holds ${String(raw.length)} widgets; only the first ${String(MAX_WIDGETS)} are resolved`,
    });
  }

  return { widgets, problems };
}

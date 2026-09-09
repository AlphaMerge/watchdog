/**
 * What a widget is, and what resolving one can produce (`G-02`).
 *
 * **The document is validated, never trusted.** `map.layout` is `jsonb` that an API caller wrote,
 * so every field here is read defensively and a widget that does not parse becomes a widget that
 * says so — the map still renders, with one broken tile, rather than failing whole. A designer
 * that saved something odd should not take a wall display down with it.
 */

/** The kinds resolved today. Custom HTML is `G-07`, geo `G-08`. */
export const WIDGET_KINDS = ['status', 'sensor-list', 'table', 'graph'] as const;

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
  readonly objectId: number;
  readonly title: string;
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
const MAX_WIDGETS = 200;
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

  const objectId = raw['objectId'];
  if (typeof objectId !== 'number' || !Number.isInteger(objectId) || objectId <= 0) {
    return { id, problem: 'objectId must be a positive whole number' };
  }

  const box = isRecord(raw['box']) ? raw['box'] : {};
  const title = typeof raw['title'] === 'string' ? raw['title'].slice(0, MAX_TITLE) : '';
  const range = whole(raw['rangeMinutes'], DEFAULT_RANGE_MINUTES);

  return {
    id,
    kind: kind as WidgetKind,
    objectId,
    title,
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

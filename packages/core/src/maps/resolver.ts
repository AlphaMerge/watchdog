import type { Database, Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { AccessService } from '../auth/access.js';
import { atLeast, Visibility } from '../auth/access.js';
import type { HistoryService, SensorValues } from '../timeseries/history.js';
import { readGeoView, type GeoView } from './geo.js';
import type { MapViewer } from './service.js';
import {
  readConnectors,
  readWidgets,
  type ChannelLine,
  type Connector,
  type ResolvedWidget,
  type SensorLine,
  type Widget,
  type WidgetData,
} from './widgets.js';

/**
 * Filling a map's widgets with what they draw (`G-02`).
 *
 * **The audience is a choice at the call site, not an absent principal.** `ADR-002` gives `G-06` a
 * public route with no principal at all, and the way that goes wrong is a resolver where
 * `principal === undefined` quietly means "no checks" — so any future caller that forgets to pass
 * one gets an unauthenticated read of everything. Naming the two modes in a discriminated union
 * means the permissive one has to be asked for.
 *
 * **One pass, not one per widget.** A map with forty tiles must not be forty round trips: every
 * object id on the canvas is collected first, then resolved in a fixed number of queries. That is
 * also the only place both rules can be enforced at once — what a viewer may see, and what has
 * been deleted underneath the map.
 *
 * **That claim was only two-thirds true until `G-10`.** The object lookup and the access
 * resolution were one pass from the start; the per-widget reads underneath them were not — a
 * subtree query per sensor list and `latestForSensor` (three statements of its own) per channel
 * table, awaited one at a time. Forty tables were about a hundred and twenty sequential round
 * trips. Every one of those is now batched, so the query count is a small constant whatever is on
 * the canvas, and the test counts each of them rather than only the first.
 */

/**
 * Who is looking. `public` is `G-06`, a link holder with no login — **seeing through the link's
 * maker** (`A-22`), as the maker stands now, or seeing nothing when the maker is gone. `ADR-002`
 * made the widget list the authorisation on the premise that it is what the maker was looking at;
 * after `A-12` an author granted one branch can name any id, so the premise is enforced here
 * rather than assumed.
 *
 * **No field says how far a viewer is trusted with a broken tile**, and there was one: `G-02`
 * carried `holdsFull` so the map's `full` holders could be told why a tile was unavailable. But
 * `full` is what a map's creator gets, and anybody who may write can create one, so the person
 * told was anybody who asked (`A-15`).
 */
export type MapAudience =
  | { readonly kind: 'viewer'; readonly viewer: MapViewer }
  | { readonly kind: 'public'; readonly maker: MapViewer | null };

export interface MapResolverOptions {
  readonly db: Database;
  readonly access: AccessService;
  /**
   * Where a table widget's numbers come from.
   *
   * **Reused rather than queried directly**, and that is not tidiness: `latestForSensor` applies
   * a staleness window that is a multiple of *this sensor's* interval, so a sensor Down for a day
   * reports a gap instead of its last healthy figure. A second query against the readings would
   * have been a second, worse answer to a question already answered carefully.
   */
  readonly history: HistoryService;
}

/** How many sensors one list widget shows. Per widget, not per request — see `#sensorLists`. */
const SENSORS_PER_LIST = 100;

export interface ResolvedMap {
  readonly widgets: readonly ResolvedWidget[];
  /** The map's home view, or `null` when it is not geographical (`G-08`). */
  readonly geo: GeoView | null;
  /** The lines between them (`G-05`). Geometry is the client's; which tiles is the document's. */
  readonly connectors: readonly Connector[];
  /** Widgets and connectors whose document could not be read, kept rather than dropped. */
  readonly problems: readonly { id: string; problem: string }[];
}

interface ObjectRow {
  id: string;
  kind: string;
  name: string;
  state: string | null;
  message: string | null;
  since: Date | null;
}

export class MapResolver {
  readonly #db: Database;
  readonly #access: AccessService;
  readonly #history: HistoryService;

  constructor(options: MapResolverOptions) {
    this.#db = options.db;
    this.#access = options.access;
    this.#history = options.history;
  }

  async resolve(
    layout: unknown,
    audience: MapAudience,
    q: Queryable = this.#db,
  ): Promise<ResolvedMap> {
    const { widgets, problems } = readWidgets(layout);
    // Read against the widgets, because a connector's endpoints are widget ids and a line to a
    // tile that is not on the canvas is a problem rather than a line.
    const lines = readConnectors(layout, widgets);
    const geo = readGeoView(layout);
    const allProblems = [...problems, ...lines.problems];
    if (widgets.length === 0) {
      return { widgets: [], connectors: lines.connectors, geo, problems: allProblems };
    }

    // Only the widgets that name one. A `html` tile draws whatever an operator typed and needs
    // no lookup, no visibility decision, and no place in either of the batched reads (`G-07`).
    const ids = [...new Set(widgets.map((widget) => widget.objectId).filter((id) => id !== null))];
    const objects = await this.#objects(q, ids);
    const visible = await this.#visible(audience, ids, q);

    // **What the surviving widgets need, gathered before anything is drawn.** Only the tiles that
    // passed both checks: a deleted or invisible object must not put its id into a query, or a
    // widget nobody may see would still cost the read it was refused.
    const drawable = widgets.filter(
      (widget) =>
        widget.objectId !== null && objects.has(widget.objectId) && visible.has(widget.objectId),
    );
    const listRoots = new Set<number>();
    const tableSensors = new Set<number>();
    for (const widget of drawable) {
      const objectId = widget.objectId;
      /* c8 ignore next -- `drawable` has already filtered these out */
      if (objectId === null) continue;
      if (widget.kind === 'sensor-list') listRoots.add(objectId);
      // A channel table or a graph on something that is not a sensor has nothing to read.
      const drawsChannels = widget.kind === 'table' || widget.kind === 'graph';
      if (drawsChannels && objects.get(objectId)?.kind === 'sensor') {
        tableSensors.add(objectId);
      }
    }

    const [lists, latest] = await Promise.all([
      this.#sensorLists(q, [...listRoots], audience),
      this.#history.latestForSensors([...tableSensors]),
    ]);

    const resolved: ResolvedWidget[] = [];
    for (const widget of widgets) {
      // A widget that names nothing cannot be unavailable: there is no object to be deleted or
      // hidden, and the markup is already in the document.
      if (widget.objectId === null) {
        resolved.push({
          id: widget.id,
          kind: widget.kind,
          box: widget.box,
          ...(widget.at === null ? {} : { at: widget.at }),
          title: widget.title,
          state: 'ok',
          data: { kind: 'html', html: widget.html },
        });
        continue;
      }

      // Deleted and not visible are one branch on purpose: see `#unavailable`.
      const object = objects.get(widget.objectId);
      if (object === undefined || !visible.has(widget.objectId)) {
        resolved.push(this.#unavailable(widget));
        continue;
      }
      resolved.push({
        id: widget.id,
        kind: widget.kind,
        box: widget.box,
        ...(widget.at === null ? {} : { at: widget.at }),
        title: widget.title,
        state: 'ok',
        data: this.#data(widget, object, lists, latest),
      });
    }

    return { widgets: resolved, connectors: lines.connectors, geo, problems: allProblems };
  }

  /**
   * A widget that could not be drawn, and **not why — to anybody** (`A-15`).
   *
   * "Deleted" against "you may not see it" is the difference between knowing an id is dead and
   * knowing it is alive, which is the oracle `G-01` closed for maps and `E-03` for reports. `G-02`
   * told the reason to whoever held `full` on the map, as the person fixing it; but the creator
   * of a map holds `full`, a layout's ids are not checked against its author when it is written,
   * and so anybody who may write could put tiles on ids they were curious about and read the
   * answer. Telling administrators alone would add nothing: they can read every id, so for them
   * an unavailable tile is always a deleted one. `E-03` settled on the same bare answer.
   */
  #unavailable(widget: Widget): ResolvedWidget {
    return {
      id: widget.id,
      kind: widget.kind,
      box: widget.box,
      title: widget.title,
      state: 'unavailable',
    };
  }

  /** Every object a widget names, in one query. Absent from the map means deleted. */
  async #objects(q: Queryable, ids: readonly number[]): Promise<Map<number, ObjectRow>> {
    // A canvas of nothing but custom HTML names no objects, and `ANY('{}')` is a round trip to
    // be told so (`G-07`).
    if (ids.length === 0) return new Map();
    const rows = await q.query<ObjectRow>(
      `SELECT o.id::text AS id, o.kind, o.name,
              r.state::text AS state, r.message, r.since
       FROM object o
       LEFT JOIN sensor_runtime r ON r.object_id = o.id
       WHERE o.id = ANY($1::bigint[])`,
      [ids],
    );
    return new Map(rows.map((row) => [Number(row.id), row]));
  }

  /**
   * Which of these the audience may see.
   *
   * Checked against the object tree exactly as any other read would be — a widget must not become
   * a way to read a sensor the viewer has no right to. **A public view is its link maker's view**
   * (`A-22`): the stored widget list said what the author chose, and until this it was also the
   * whole authorisation, so a `readwrite` account granted one branch could put the root on a
   * canvas, share it, and publish every sensor to anybody with the URL. A stored map that names
   * objects its maker cannot see — saved before `A-22`, or since the maker lost a grant — draws
   * those tiles `unavailable`.
   */
  async #visible(
    audience: MapAudience,
    ids: readonly number[],
    q: Queryable,
  ): Promise<Set<number>> {
    const viewer = viewerOf(audience);
    if (viewer === null) return new Set();
    const rights = await this.#access.resolveManyFor(
      {
        userId: viewer.userId,
        role: viewer.role,
        ...(viewer.scope === undefined ? {} : { scope: viewer.scope }),
      },
      ids,
      q,
    );

    const allowed = new Set<number>();
    for (const id of ids) {
      const held = rights.get(id);
      if (held !== undefined && atLeast(held, 'read')) allowed.add(id);
    }
    return allowed;
  }

  /**
   * Every sensor below every list widget's root, in one recursive query.
   *
   * **Ranked per root rather than limited per query**, because the limit is a property of one
   * widget: a hundred sensors under *each* root, not a hundred across all of them, which is what
   * a plain `LIMIT` over the union would have meant.
   *
   * **A `none` carved below the root is honoured** (`A-12`). `#visible` checked the widget's root
   * and nothing under it, so a viewer who could read a group read every sensor in it, holes
   * included — names, states and failure messages. The viewer's visibility is a condition in the
   * ranking, so the hundred are a hundred the viewer may see; for a public map, a hundred its
   * link's maker may see (`A-22`).
   *
   * **By name, then id** (`P-381`'s review). Names repeat: every device has a Ping. Ranked by name
   * alone, which of the equal names made the hundred, and in what order, was the plan's choice,
   * so a Down Ping could drop off a wall display between two refreshes. The id makes the cut and
   * the order one answer.
   */
  async #sensorLists(
    q: Queryable,
    roots: readonly number[],
    audience: MapAudience,
  ): Promise<Map<number, SensorLine[]>> {
    const lists = new Map<number, SensorLine[]>();
    if (roots.length === 0) return lists;

    const viewer = viewerOf(audience);
    const visibility =
      viewer === null
        ? Visibility.nothing(null)
        : await this.#access.visibilityFor(
            {
              userId: viewer.userId,
              role: viewer.role,
              ...(viewer.scope === undefined ? {} : { scope: viewer.scope }),
            },
            q,
          );
    const values: unknown[] = [[...roots], SENSORS_PER_LIST];
    const visible = visibility.where('o.id', (value) => `$${String(values.push(value))}`);

    const rows = await q.query<{
      root: string;
      id: string;
      name: string;
      state: string;
      message: string;
    }>(
      `WITH RECURSIVE below AS (
         SELECT o.id AS root, o.id AS id, 0 AS depth FROM object o WHERE o.id = ANY($1::bigint[])
         UNION ALL
         SELECT b.root, c.id, b.depth + 1 FROM object c JOIN below b ON c.parent_id = b.id
         WHERE b.depth < ${String(MAX_WALK_DEPTH)}
       ),
       ranked AS (
         SELECT b.root, o.id::text AS id, o.name,
                r.state::text AS state, r.message,
                row_number() OVER (PARTITION BY b.root ORDER BY lower(o.name), o.id) AS rn
         FROM below b
         JOIN object o ON o.id = b.id
         JOIN sensor_runtime r ON r.object_id = o.id
         WHERE o.kind = 'sensor' AND ${visible}
       )
       -- The root made text on the way out, and sorted as the number it is (P-392).
       SELECT root::text AS root, id, name, state, message FROM ranked
       WHERE rn <= $2 ORDER BY ranked.root, rn`,
      values,
    );

    for (const root of roots) lists.set(root, []);
    for (const row of rows) {
      lists.get(Number(row.root))?.push({
        id: Number(row.id),
        name: row.name,
        sensorState: row.state,
        message: row.message,
      });
    }
    return lists;
  }

  /**
   * What one widget draws, from what has already been read. No queries: everything this needs
   * was gathered for the whole canvas before the first tile was built.
   */
  #data(
    widget: Widget,
    object: ObjectRow,
    lists: ReadonlyMap<number, SensorLine[]>,
    latest: ReadonlyMap<number, SensorValues>,
  ): WidgetData {
    const objectId = Number(object.id);
    if (widget.kind === 'status') {
      return {
        kind: 'status',
        objectId,
        name: object.name,
        // An object with no runtime row has never been scanned, which is Unknown rather than a
        // state anybody should read as fine.
        sensorState: object.state ?? 'unknown',
        message: object.message ?? '',
        since: (object.since ?? new Date(0)).toISOString(),
      };
    }

    if (widget.kind === 'sensor-list') {
      return {
        kind: 'sensor-list',
        objectId,
        name: object.name,
        sensors: lists.get(objectId) ?? [],
      };
    }

    // A table or graph widget on something that is not a sensor has no channels to draw, and
    // saying so is better than an empty table that looks like a sensor reporting nothing.
    const values = latest.get(objectId);
    const channels: ChannelLine[] =
      values === undefined
        ? []
        : values.channels.map((channel) => ({
            key: channel.key,
            name: channel.name,
            unit: channel.unit,
            // Null is a gap, never a zero: a Down sensor recorded no value, and the staleness
            // window already refuses to present an old reading as a current one.
            value: channel.value,
          }));

    if (widget.kind === 'graph') {
      return {
        kind: 'graph',
        objectId,
        name: object.name,
        sensorState: object.state ?? 'unknown',
        rangeMinutes: widget.rangeMinutes,
        channels,
      };
    }

    return { kind: 'table', objectId, name: object.name, channels };
  }
}

/** Whose rights decide what this audience sees: the viewer's, or a public link's maker's. */
function viewerOf(audience: MapAudience): MapViewer | null {
  return audience.kind === 'viewer' ? audience.viewer : audience.maker;
}

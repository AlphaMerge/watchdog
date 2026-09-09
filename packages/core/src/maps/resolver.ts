import type { Database, Queryable } from '../db/pool.js';
import type { AccessService } from '../auth/access.js';
import { atLeast } from '../auth/access.js';
import type { HistoryService } from '../timeseries/history.js';
import type { MapViewer } from './service.js';
import {
  readWidgets,
  type ChannelLine,
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
 */

/** Who is looking. `public` is `G-06`: the widget list itself is the authorisation. */
export type MapAudience =
  | { readonly kind: 'viewer'; readonly viewer: MapViewer; readonly holdsFull: boolean }
  | { readonly kind: 'public' };

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

export interface ResolvedMap {
  readonly widgets: readonly ResolvedWidget[];
  /** Widgets whose document could not be read at all, kept rather than dropped. */
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
    if (widgets.length === 0) return { widgets: [], problems };

    const ids = [...new Set(widgets.map((widget) => widget.objectId))];
    const objects = await this.#objects(q, ids);
    const visible = await this.#visible(audience, ids, q);

    const resolved: ResolvedWidget[] = [];
    for (const widget of widgets) {
      const object = objects.get(widget.objectId);
      if (object === undefined) {
        resolved.push(this.#unavailable(widget, audience, 'object-deleted'));
        continue;
      }
      if (!visible.has(widget.objectId)) {
        resolved.push(this.#unavailable(widget, audience, 'not-visible'));
        continue;
      }
      resolved.push({
        id: widget.id,
        kind: widget.kind,
        box: widget.box,
        title: widget.title,
        state: 'ok',
        data: await this.#data(q, widget, object),
      });
    }

    return { widgets: resolved, problems };
  }

  /**
   * A widget that could not be drawn.
   *
   * The reason rides along only for somebody holding `full` on the map — the person fixing it.
   * A plain reader, and `G-06`'s public viewer, are told the tile is unavailable and nothing
   * more: "deleted" against "you may not see it" is the difference between knowing an id is dead
   * and knowing it is alive, which is exactly the oracle `G-01` closed.
   */
  #unavailable(
    widget: Widget,
    audience: MapAudience,
    reason: 'object-deleted' | 'not-visible',
  ): ResolvedWidget {
    const tell = audience.kind === 'viewer' && audience.holdsFull;
    return {
      id: widget.id,
      kind: widget.kind,
      box: widget.box,
      title: widget.title,
      state: 'unavailable',
      ...(tell ? { reason } : {}),
    };
  }

  /** Every object a widget names, in one query. Absent from the map means deleted. */
  async #objects(q: Queryable, ids: readonly number[]): Promise<Map<number, ObjectRow>> {
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
   * **A public map's widget list is its own authorisation** (`ADR-002` Decision 1): the author
   * chose what is on the canvas and the route serves that and nothing else, so there is nobody to
   * resolve rights for. An authenticated viewer is checked against the object tree exactly as any
   * other read would be — a widget must not become a way to read a sensor the viewer has no right
   * to.
   */
  async #visible(
    audience: MapAudience,
    ids: readonly number[],
    q: Queryable,
  ): Promise<Set<number>> {
    if (audience.kind === 'public') return new Set(ids);

    const { viewer } = audience;
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

  async #data(q: Queryable, widget: Widget, object: ObjectRow): Promise<WidgetData> {
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
      const rows = await q.query<{ id: string; name: string; state: string; message: string }>(
        `WITH RECURSIVE below AS (
           SELECT id FROM object WHERE id = $1
           UNION ALL SELECT c.id FROM object c JOIN below b ON c.parent_id = b.id
         )
         SELECT o.id::text AS id, o.name, r.state::text AS state, r.message
         FROM object o JOIN below ON below.id = o.id
         JOIN sensor_runtime r ON r.object_id = o.id
         WHERE o.kind = 'sensor'
         ORDER BY lower(o.name) LIMIT 100`,
        [objectId],
      );
      const sensors: SensorLine[] = rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        sensorState: row.state,
        message: row.message,
      }));
      return { kind: 'sensor-list', objectId, name: object.name, sensors };
    }

    // A table widget on something that is not a sensor has no channels to draw, and saying so
    // is better than an empty table that looks like a sensor reporting nothing.
    if (object.kind !== 'sensor') {
      return { kind: 'table', objectId, name: object.name, channels: [] };
    }

    const latest = await this.#history.latestForSensor(objectId);
    const channels: ChannelLine[] = latest.channels.map((channel) => ({
      key: channel.key,
      name: channel.name,
      unit: channel.unit,
      // Null is a gap, never a zero: a Down sensor recorded no value, and `latestForSensor`
      // already refuses to present a stale reading as a current one.
      value: channel.value,
    }));
    return { kind: 'table', objectId, name: object.name, channels };
  }
}

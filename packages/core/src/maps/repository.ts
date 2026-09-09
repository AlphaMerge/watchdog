import type { Queryable } from '../db/pool.js';
import type { AccessRight } from '../auth/access.js';

/**
 * Rows in and rows out for maps (`G-01`).
 *
 * **SQL and nothing else**, the same split `ObjectRepository` keeps: no access decisions, no
 * validation, no audit. Everything that decides something lives in `MapService` above it, which
 * is what lets the service be tested against the decisions rather than against a database.
 */

export interface MapRow {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly layout: MapLayout;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The canvas.
 *
 * `widgets` is deliberately loose here: `G-02` defines what a widget is, and typing it now would
 * be typing a guess. What `G-01` fixes is that the document exists, has that key, and is never
 * null.
 */
export interface MapLayout {
  readonly widgets: readonly Record<string, unknown>[];
}

export interface MapGrant {
  readonly groupId: number;
  readonly groupName: string;
  readonly right: AccessRight;
  readonly grantedAt: Date;
  readonly grantedBy: string;
}

interface RawMap {
  id: string;
  name: string;
  description: string;
  priority: number;
  layout: MapLayout;
  version: string;
  created_at: Date;
  updated_at: Date;
}

function toMap(row: RawMap): MapRow {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    priority: row.priority,
    layout: row.layout,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'id, name, description, priority, layout, version, created_at, updated_at';

export class MapRepository {
  async list(q: Queryable): Promise<MapRow[]> {
    const rows = await q.query<RawMap>(
      `SELECT ${COLUMNS} FROM map ORDER BY priority DESC, lower(name)`,
    );
    return rows.map(toMap);
  }

  /**
   * The maps a set of groups may see, at the right they hold.
   *
   * **One query rather than list-then-filter.** Filtering in the caller means fetching every map
   * on the installation to show somebody the two they can see, and the difference is visible the
   * first time a large site opens the list.
   */
  async listFor(q: Queryable, groupIds: readonly number[]): Promise<MapRow[]> {
    if (groupIds.length === 0) return [];
    // **`EXISTS` rather than a join with `DISTINCT`.** A map granted to two of the viewer's
    // groups joins twice, and de-duplicating afterwards forces every ordering expression into the
    // select list — which is how `ORDER BY lower(name)` becomes a syntax error and then becomes
    // an ordering nobody meant.
    const rows = await q.query<RawMap>(
      `SELECT ${COLUMNS} FROM map m
       WHERE EXISTS (
         SELECT 1 FROM map_access a
         WHERE a.map_id = m.id AND a.group_id = ANY($1::bigint[]) AND a.right_ <> 'none'
       )
       ORDER BY m.priority DESC, lower(m.name)`,
      [groupIds],
    );
    return rows.map(toMap);
  }

  async find(q: Queryable, id: number): Promise<MapRow | undefined> {
    const rows = await q.query<RawMap>(`SELECT ${COLUMNS} FROM map WHERE id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? undefined : toMap(row);
  }

  async create(
    q: Queryable,
    input: { name: string; description: string; priority: number; layout: MapLayout },
  ): Promise<MapRow> {
    const rows = await q.query<RawMap>(
      `INSERT INTO map (name, description, priority, layout)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${COLUMNS}`,
      [input.name, input.description, input.priority, JSON.stringify(input.layout)],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the insert returned no row');
    return toMap(row);
  }

  /**
   * Writes a map, refusing when it has moved on since the caller read it.
   *
   * **The version is in the WHERE clause, not checked first.** Reading, comparing and then
   * writing leaves a window between the read and the write in which the other designer commits;
   * making the comparison part of the statement closes it, and the zero-row result *is* the
   * conflict.
   */
  async update(
    q: Queryable,
    id: number,
    expectedVersion: number,
    patch: {
      name?: string;
      description?: string;
      priority?: number;
      layout?: MapLayout;
    },
  ): Promise<MapRow | undefined> {
    const rows = await q.query<RawMap>(
      `UPDATE map SET
         name        = COALESCE($3, name),
         description = COALESCE($4, description),
         priority    = COALESCE($5, priority),
         layout      = COALESCE($6::jsonb, layout),
         version     = version + 1
       WHERE id = $1 AND version = $2
       RETURNING ${COLUMNS}`,
      [
        id,
        expectedVersion,
        patch.name ?? null,
        patch.description ?? null,
        patch.priority ?? null,
        patch.layout === undefined ? null : JSON.stringify(patch.layout),
      ],
    );
    const row = rows[0];
    return row === undefined ? undefined : toMap(row);
  }

  async remove(q: Queryable, id: number): Promise<boolean> {
    const rows = await q.query<{ id: string }>(`DELETE FROM map WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  async grants(q: Queryable, mapId: number): Promise<MapGrant[]> {
    const rows = await q.query<{
      group_id: string;
      name: string;
      right_: AccessRight;
      granted_at: Date;
      granted_by: string;
    }>(
      `SELECT a.group_id, g.name, a.right_, a.granted_at, a.granted_by
       FROM map_access a JOIN user_group g ON g.id = a.group_id
       WHERE a.map_id = $1 ORDER BY lower(g.name)`,
      [mapId],
    );
    return rows.map((row) => ({
      groupId: Number(row.group_id),
      groupName: row.name,
      right: row.right_,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
    }));
  }

  /** Upsert, because granting twice is a correction rather than an error. */
  async grant(
    q: Queryable,
    mapId: number,
    groupId: number,
    right: AccessRight,
    grantedBy: string,
  ): Promise<void> {
    await q.query(
      `INSERT INTO map_access (map_id, group_id, right_, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (map_id, group_id)
       DO UPDATE SET right_ = EXCLUDED.right_, granted_at = now(), granted_by = EXCLUDED.granted_by`,
      [mapId, groupId, right, grantedBy],
    );
  }

  async revoke(q: Queryable, mapId: number, groupId: number): Promise<boolean> {
    const rows = await q.query<{ map_id: string }>(
      `DELETE FROM map_access WHERE map_id = $1 AND group_id = $2 RETURNING map_id`,
      [mapId, groupId],
    );
    return rows.length > 0;
  }

  /**
   * The highest right any of these groups holds on this map.
   *
   * Flat: no ancestor walk, because maps do not nest. `access_rank` comes from migration 033 so
   * the ordering is the one `object_access` already uses — `max()` over the text would sort them
   * alphabetically, which is wrong in every position.
   */
  async rightFor(q: Queryable, mapId: number, groupIds: readonly number[]): Promise<AccessRight> {
    if (groupIds.length === 0) return 'none';
    const rows = await q.query<{ right_: AccessRight | null }>(
      `SELECT right_ FROM map_access
       WHERE map_id = $1 AND group_id = ANY($2::bigint[])
       ORDER BY access_rank(right_) DESC LIMIT 1`,
      [mapId, groupIds],
    );
    return rows[0]?.right_ ?? 'none';
  }
}

import type { Queryable } from '../db/pool.js';
import { grantedTo, type FlatGrant, type GrantTable } from '../auth/flat-access.js';

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

/**
 * A stored background, without its bytes (`G-05`).
 *
 * Separate from the bytes because almost every caller wants only this: whether there is one, what
 * it is, and the `ETag` that decides whether the client already has it. Reading two megabytes to
 * answer a conditional request would defeat the point of answering it.
 */
export interface MapBackground {
  readonly mediaType: string;
  readonly digest: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly uploadedAt: Date;
  readonly uploadedBy: string;
}

/**
 * A share link, as anybody managing one sees it (`G-06`).
 *
 * **No token, and there cannot be one.** Only its hash is stored, so the URL is returned once at
 * creation and is unrecoverable afterwards — which is the property that keeps a database backup
 * from being a set of working share links.
 */
export interface MapShare {
  readonly id: number;
  readonly label: string;
  /** The first few characters, so a list is readable. Never enough to use. */
  readonly prefix: string;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export type MapGrant = FlatGrant;

/** Where a map's grants live, for `FlatAccess` (`L-01`). */
export const MAP_GRANTS: GrantTable = {
  table: 'map_access',
  key: 'map_id',
  subject: 'map',
};

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
    const rows = await q.query<RawMap>(
      `SELECT ${COLUMNS} FROM map m
       WHERE ${grantedTo(MAP_GRANTS, 'm.id', '$1')}
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

  /* ---------------------------------------------------------- backgrounds */

  /** What is stored, without reading it. */
  async background(q: Queryable, mapId: number): Promise<MapBackground | undefined> {
    const rows = await q.query<{
      media_type: string;
      digest: string;
      width: number;
      height: number;
      bytes: string;
      uploaded_at: Date;
      uploaded_by: string;
    }>(
      `SELECT media_type, digest, width, height,
              octet_length(bytes)::text AS bytes, uploaded_at, uploaded_by
       FROM map_background WHERE map_id = $1`,
      [mapId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      mediaType: row.media_type,
      digest: row.digest,
      width: row.width,
      height: row.height,
      bytes: Number(row.bytes),
      uploadedAt: row.uploaded_at,
      uploadedBy: row.uploaded_by,
    };
  }

  /** The bytes. Only the serving route asks for these, and only after a cache check. */
  async backgroundBytes(q: Queryable, mapId: number): Promise<Buffer | undefined> {
    const rows = await q.query<{ bytes: Buffer }>(
      `SELECT bytes FROM map_background WHERE map_id = $1`,
      [mapId],
    );
    return rows[0]?.bytes;
  }

  /**
   * Stores one, replacing whatever was there.
   *
   * An upsert rather than a delete-then-insert: a map has one background, and the two-statement
   * version has a window where it has none — which a wall display would render as a blank canvas.
   */
  async putBackground(
    q: Queryable,
    mapId: number,
    image: {
      mediaType: string;
      digest: string;
      width: number;
      height: number;
      bytes: Buffer;
      uploadedBy: string;
    },
  ): Promise<void> {
    await q.query(
      `INSERT INTO map_background
         (map_id, media_type, digest, width, height, bytes, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (map_id) DO UPDATE SET
         media_type = excluded.media_type,
         digest = excluded.digest,
         width = excluded.width,
         height = excluded.height,
         bytes = excluded.bytes,
         uploaded_by = excluded.uploaded_by,
         uploaded_at = excluded.uploaded_at`,
      [
        mapId,
        image.mediaType,
        image.digest,
        image.width,
        image.height,
        image.bytes,
        image.uploadedBy,
      ],
    );
  }

  async removeBackground(q: Queryable, mapId: number): Promise<boolean> {
    const rows = await q.query<{ map_id: string }>(
      `DELETE FROM map_background WHERE map_id = $1 RETURNING map_id::text`,
      [mapId],
    );
    return rows.length > 0;
  }

  /* --------------------------------------------------------------- shares */

  async shares(q: Queryable, mapId: number): Promise<MapShare[]> {
    const rows = await q.query<RawShare>(
      `SELECT id::text AS id, label, prefix, expires_at, last_used_at, revoked_at,
              created_at, created_by
       FROM map_share WHERE map_id = $1 ORDER BY created_at DESC`,
      [mapId],
    );
    return rows.map(toShare);
  }

  async createShare(
    q: Queryable,
    mapId: number,
    share: {
      label: string;
      tokenHash: string;
      prefix: string;
      expiresAt: Date;
      createdBy: string;
    },
  ): Promise<MapShare> {
    const rows = await q.query<RawShare>(
      `INSERT INTO map_share (map_id, label, token_hash, prefix, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id, label, prefix, expires_at, last_used_at, revoked_at,
                 created_at, created_by`,
      [mapId, share.label, share.tokenHash, share.prefix, share.expiresAt, share.createdBy],
    );
    const row = rows[0];
    /* c8 ignore next -- an INSERT ... RETURNING either throws or returns its row */
    if (row === undefined) throw new Error('the share link was not created');
    return toShare(row);
  }

  async revokeShare(q: Queryable, mapId: number, shareId: number, by: string): Promise<boolean> {
    const rows = await q.query<{ id: string }>(
      `UPDATE map_share SET revoked_at = now(), revoked_by = $3
       WHERE map_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING id::text AS id`,
      [mapId, shareId, by],
    );
    return rows.length > 0;
  }

  /**
   * The map a live token opens, or nothing.
   *
   * **Expiry and revocation are in the `WHERE` clause**, not checked by the caller afterwards.
   * A row that comes back is a link that works; there is no second step somebody can forget, and
   * no window where a revoked token resolves because two queries disagreed.
   */
  async shareByToken(
    q: Queryable,
    tokenHash: string,
  ): Promise<{ shareId: number; mapId: number; lastUsedAt: Date | null } | undefined> {
    const rows = await q.query<{ id: string; map_id: string; last_used_at: Date | null }>(
      `SELECT id::text AS id, map_id::text AS map_id, last_used_at
       FROM map_share
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { shareId: Number(row.id), mapId: Number(row.map_id), lastUsedAt: row.last_used_at };
  }

  /** At most one write a minute per link, whatever a wall display's polling interval is. */
  async touchShare(q: Queryable, shareId: number): Promise<void> {
    await q.query(
      `UPDATE map_share SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [shareId],
    );
  }
}

interface RawShare {
  id: string;
  label: string;
  prefix: string;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  created_by: string;
}

function toShare(row: RawShare): MapShare {
  return {
    id: Number(row.id),
    label: row.label,
    prefix: row.prefix,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

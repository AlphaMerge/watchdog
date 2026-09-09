import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { atLeast, cappedBy, type AccessRight } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import { MapError, changedUnderneath, invisible, mapNotFound } from './errors.js';
import { createHash } from 'node:crypto';
import { readImage } from './images.js';
import type { MapBackground, MapGrant, MapLayout, MapRepository, MapRow } from './repository.js';

/**
 * Everything about a map that decides something (`G-01`).
 *
 * **Access is resolved here and nowhere else**, the same rule `CLAUDE.md` states for inheritance.
 * Two callers will want it — the authenticated API, and `G-06`'s public route, which has no
 * principal at all — and the only way that stays honest is if both go through one method that
 * says what a viewer may do.
 */

/** Who is asking. `undefined` is `G-06`'s public viewer, which holds a link and nothing else. */
export interface MapViewer {
  readonly userId: number;
  readonly role: AccountRole;
  /** A token's ceiling, where the request presented one (`A-06`). */
  readonly scope?: AccessRight;
}

export interface MapServiceOptions {
  readonly db: Database;
  readonly repository: MapRepository;
  readonly logger: Logger;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;

export class MapService {
  readonly #db: Database;
  readonly #repository: MapRepository;
  readonly #logger: Logger;

  constructor(options: MapServiceOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#logger = options.logger.child({ component: 'maps' });
  }

  /**
   * What this viewer may do with this map.
   *
   * **A member of any administrator group short-circuits the lookup**, exactly as `AccessService`
   * does for objects: "may do anything, including to things that do not exist yet" is not a grant
   * and must not depend on a row, or an installation locks itself out by deleting one.
   *
   * **Two ceilings after that, and both only lower.** The account's role caps what its groups
   * granted (`A-04`), and a token's scope caps its owner (`A-06`). A read-only account in a group
   * holding `full` on a map still holds `read`.
   */
  async rightFor(viewer: MapViewer, mapId: number, q: Queryable = this.#db): Promise<AccessRight> {
    const admin = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.is_admin`,
      [viewer.userId],
    );

    const granted =
      Number(admin[0]?.total ?? 0) > 0
        ? 'full'
        : await this.#repository.rightFor(q, mapId, await this.#groupsOf(viewer.userId, q));

    const afterRole = cappedBy(viewer.role, granted);
    return viewer.scope === undefined ? afterRole : lowerOf(afterRole, viewer.scope);
  }

  /** Throws unless the viewer holds at least this right; an unreadable map reads as absent. */
  async require(
    viewer: MapViewer,
    mapId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<MapRow> {
    return (await this.withRight(viewer, mapId, needed, q)).map;
  }

  /**
   * The map, and what this viewer holds on it.
   *
   * **One resolution, not two.** `G-10`'s view route needs the map *and* whether the caller holds
   * `full` — the resolver tells only a `full` holder why a widget could not be drawn — and asking
   * `require` and then `rightFor` would resolve the same access twice per request. `require` is
   * this method with the right thrown away.
   */
  async withRight(
    viewer: MapViewer,
    mapId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<{ map: MapRow; right: AccessRight }> {
    const map = await this.#repository.find(q, mapId);
    if (map === undefined) throw mapNotFound(mapId);

    const held = await this.rightFor(viewer, mapId, q);
    // Absent rather than forbidden: see `invisible`. A caller who cannot read it learns nothing
    // about whether it exists.
    if (!atLeast(held, 'read')) throw invisible(mapId);
    if (!atLeast(held, needed)) {
      throw new MapError('MAP_FORBIDDEN', `this account may not ${needed} map ${String(mapId)}`, {
        context: { mapId, phase: 'authorize' },
        details: { held, needed },
      });
    }
    return { map, right: held };
  }

  /** The maps this viewer may see. Administrators see all of them. */
  async list(viewer: MapViewer): Promise<MapRow[]> {
    const admin = await this.#db.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.is_admin`,
      [viewer.userId],
    );
    if (Number(admin[0]?.total ?? 0) > 0) return this.#repository.list(this.#db);
    return this.#repository.listFor(this.#db, await this.#groupsOf(viewer.userId, this.#db));
  }

  async get(viewer: MapViewer, id: number): Promise<MapRow> {
    return this.require(viewer, id, 'read');
  }

  /**
   * Creates a map, and grants its creator's primary group `full` on it in the same transaction.
   *
   * **Otherwise the creator cannot see what they just made.** Access is per group and a new map
   * has no grants, so a non-administrator would create a map and immediately lose it — which is
   * the kind of thing that gets discovered by a user rather than by a test.
   */
  async create(
    viewer: MapViewer,
    input: { name: string; description?: string; priority?: number; layout?: MapLayout },
    actor: string,
  ): Promise<MapRow> {
    const name = validName(input.name);
    const description = validDescription(input.description ?? '');
    const priority = validPriority(input.priority ?? 3);
    const layout = input.layout ?? { widgets: [] };

    return this.#db.tx(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM map WHERE lower(name) = lower($1)`,
        [name],
      );
      if (existing.length > 0) {
        throw new MapError('MAP_NAME_TAKEN', `a map called ${name} already exists`, {
          context: { phase: 'create' },
          details: { name },
        });
      }

      const map = await this.#repository.create(tx, { name, description, priority, layout });

      const primary = await tx.query<{ group_id: string }>(
        `SELECT group_id FROM user_group_member
         WHERE user_id = $1 ORDER BY is_primary DESC, group_id LIMIT 1`,
        [viewer.userId],
      );
      const groupId = primary[0]?.group_id;
      if (groupId !== undefined) {
        await this.#repository.grant(tx, map.id, Number(groupId), 'full', actor);
      }

      this.#logger.info({ mapId: map.id, name, actor }, 'map created');
      return map;
    });
  }

  /**
   * Updates a map, refusing when it has moved on since the caller read it.
   *
   * The version goes into the statement rather than being compared first — see the repository —
   * so the zero-row result *is* the conflict, with no window between the read and the write.
   */
  async update(
    viewer: MapViewer,
    id: number,
    expectedVersion: number,
    patch: { name?: string; description?: string; priority?: number; layout?: MapLayout },
    actor: string,
  ): Promise<MapRow> {
    return this.#db.tx(async (tx) => {
      const current = await this.require(viewer, id, 'write', tx);

      const next: {
        name?: string;
        description?: string;
        priority?: number;
        layout?: MapLayout;
      } = {};
      if (patch.name !== undefined) next.name = validName(patch.name);
      if (patch.description !== undefined) next.description = validDescription(patch.description);
      if (patch.priority !== undefined) next.priority = validPriority(patch.priority);
      if (patch.layout !== undefined) next.layout = patch.layout;

      if (next.name !== undefined && next.name.toLowerCase() !== current.name.toLowerCase()) {
        const clash = await tx.query<{ id: string }>(
          `SELECT id FROM map WHERE lower(name) = lower($1) AND id <> $2`,
          [next.name, id],
        );
        if (clash.length > 0) {
          throw new MapError('MAP_NAME_TAKEN', `a map called ${next.name} already exists`, {
            context: { mapId: id, phase: 'update' },
            details: { name: next.name },
          });
        }
      }

      const updated = await this.#repository.update(tx, id, expectedVersion, next);
      if (updated === undefined) throw changedUnderneath(id, expectedVersion, current.version);

      this.#logger.info({ mapId: id, actor, version: updated.version }, 'map updated');
      return updated;
    });
  }

  async remove(viewer: MapViewer, id: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      await this.#repository.remove(tx, id);
      this.#logger.info({ mapId: id, actor }, 'map deleted');
    });
  }

  /* ---------------------------------------------------------- backgrounds */

  /**
   * Stores a background, having decided what the bytes actually are (`G-05`, `ADR-003`).
   *
   * **`write`, not `full`.** Putting a floor plan behind the widgets is editing the canvas, which
   * is the same right as moving a tile; deciding who else may see the map is what `full` is for.
   *
   * The format and the dimensions come from `readImage`, which reads the file's own header — the
   * declared content type never reaches this method, because it is a claim by the client and
   * accepting it is the oldest upload hole there is.
   */
  async setBackground(
    viewer: MapViewer,
    id: number,
    bytes: Buffer,
    actor: string,
  ): Promise<MapBackground> {
    const facts = readImage(bytes);
    if ('problem' in facts) {
      throw new MapError('MAP_INVALID', facts.problem, {
        context: { mapId: id, phase: 'upload-background' },
      });
    }

    const digest = createHash('sha256').update(bytes).digest('hex');
    return this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'write', tx);
      await this.#repository.putBackground(tx, id, {
        mediaType: facts.mediaType,
        digest,
        width: facts.width,
        height: facts.height,
        bytes,
        uploadedBy: actor,
      });
      this.#logger.info(
        { mapId: id, actor, mediaType: facts.mediaType, bytes: bytes.length, digest },
        'map background stored',
      );
      const stored = await this.#repository.background(tx, id);
      /* c8 ignore next -- it was written in this transaction */
      if (stored === undefined) throw mapNotFound(id);
      return stored;
    });
  }

  /** What is stored, without the bytes. `read`, because it is part of looking at the map. */
  async backgroundOf(viewer: MapViewer, id: number): Promise<MapBackground | undefined> {
    return this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'read', tx);
      return this.#repository.background(tx, id);
    });
  }

  /**
   * The bytes, for a caller that has already been told it does not have them.
   *
   * Split from `backgroundOf` so a conditional request costs one small row: a serving route asks
   * for the metadata, answers 304 against the digest, and only then reads two megabytes.
   */
  async backgroundBytes(viewer: MapViewer, id: number): Promise<Buffer | undefined> {
    return this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'read', tx);
      return this.#repository.backgroundBytes(tx, id);
    });
  }

  async removeBackground(viewer: MapViewer, id: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'write', tx);
      const removed = await this.#repository.removeBackground(tx, id);
      if (removed) this.#logger.info({ mapId: id, actor }, 'map background removed');
    });
  }

  async grants(viewer: MapViewer, id: number): Promise<MapGrant[]> {
    await this.require(viewer, id, 'full');
    return this.#repository.grants(this.#db, id);
  }

  /** Granting needs `full`: a `write` holder may edit the canvas, not decide who else sees it. */
  async grant(
    viewer: MapViewer,
    id: number,
    groupId: number,
    right: AccessRight,
    actor: string,
  ): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      const group = await tx.query<{ id: string }>(`SELECT id FROM user_group WHERE id = $1`, [
        groupId,
      ]);
      if (group.length === 0) {
        throw new MapError('MAP_GROUP_NOT_FOUND', `group ${String(groupId)} does not exist`, {
          context: { mapId: id, phase: 'grant' },
          details: { groupId },
        });
      }
      await this.#repository.grant(tx, id, groupId, right, actor);
      this.#logger.info({ mapId: id, groupId, right, actor }, 'map access granted');
    });
  }

  async revoke(viewer: MapViewer, id: number, groupId: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      await this.#repository.revoke(tx, id, groupId);
      this.#logger.info({ mapId: id, groupId, actor }, 'map access revoked');
    });
  }

  async #groupsOf(userId: number, q: Queryable): Promise<number[]> {
    const rows = await q.query<{ group_id: string }>(
      `SELECT group_id FROM user_group_member WHERE user_id = $1`,
      [userId],
    );
    return rows.map((row) => Number(row.group_id));
  }
}

const ORDER: Readonly<Record<AccessRight, number>> = { none: 0, read: 1, write: 2, full: 3 };

function lowerOf(a: AccessRight, b: AccessRight): AccessRight {
  return ORDER[a] <= ORDER[b] ? a : b;
}

function validName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    throw new MapError('MAP_INVALID', `a map name must be 1 to ${String(MAX_NAME)} characters`, {
      context: { phase: 'validate' },
      details: { field: 'name' },
    });
  }
  return name;
}

function validDescription(raw: string): string {
  if (raw.length > MAX_DESCRIPTION) {
    throw new MapError(
      'MAP_INVALID',
      `a map description may be at most ${String(MAX_DESCRIPTION)} characters`,
      { context: { phase: 'validate' }, details: { field: 'description' } },
    );
  }
  return raw;
}

function validPriority(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 5) {
    throw new MapError('MAP_INVALID', 'priority is a whole number from 1 to 5', {
      context: { phase: 'validate' },
      details: { field: 'priority' },
    });
  }
  return raw;
}

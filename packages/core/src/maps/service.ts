import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { atLeast, type AccessRight } from '../auth/access.js';
import { FlatAccess, ceilingOf, verdict, type FlatViewer } from '../auth/flat-access.js';
import { MapError, changedUnderneath, invisible, mapNotFound } from './errors.js';
import { createHash } from 'node:crypto';
import { readImage } from './images.js';
import { mintShareToken, shareTokenHash } from './shares.js';
import {
  MAP_GRANTS,
  type MapBackground,
  type MapGrant,
  type MapLayout,
  type MapRepository,
  type MapRow,
  type MapShare,
} from './repository.js';

/**
 * Everything about a map that decides something (`G-01`).
 *
 * **Access is resolved here and nowhere else**, the same rule `CLAUDE.md` states for inheritance.
 * Two callers will want it — the authenticated API, and `G-06`'s public route, which has no
 * principal at all — and the only way that stays honest is if both go through one method that
 * says what a viewer may do.
 */

/**
 * Who is asking. `G-06`'s public viewer is not one of these: it holds a link and nothing else, and
 * reaches the one method here that takes a token instead.
 */
export type MapViewer = FlatViewer;

export interface MapServiceOptions {
  readonly db: Database;
  readonly repository: MapRepository;
  readonly logger: Logger;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;
const MAX_SHARE_LABEL = 100;
/** A year. Long enough for a wall display, short enough that somebody revisits the decision. */
const MAX_SHARE_MS = 365 * 24 * 60 * 60 * 1000;

export class MapService {
  readonly #db: Database;
  readonly #repository: MapRepository;
  readonly #access = new FlatAccess(MAP_GRANTS);
  readonly #logger: Logger;

  constructor(options: MapServiceOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#logger = options.logger.child({ component: 'maps' });
  }

  /** What this viewer may do with this map. The rules are `FlatAccess`'s, shared with reports. */
  async rightFor(viewer: MapViewer, mapId: number, q: Queryable = this.#db): Promise<AccessRight> {
    return this.#access.rightFor(viewer, mapId, q);
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
   * **One resolution, not two**: a caller that needs the map *and* the right would otherwise ask
   * `require` and then `rightFor`, resolving the same access twice. `require` is this method with
   * the right thrown away. (`G-10`'s view route was that caller, to decide whether a broken tile
   * said why; nobody is told why any more — `A-15`.)
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
    switch (verdict(held, needed)) {
      case 'ok':
        return { map, right: held };
      case 'invisible':
        // Absent rather than forbidden: see `invisible`. A caller who cannot read it learns
        // nothing about whether it exists.
        throw invisible(mapId);
      case 'forbidden':
        throw new MapError('MAP_FORBIDDEN', `this account may not ${needed} map ${String(mapId)}`, {
          context: { mapId, phase: 'authorize' },
          details: { held, needed },
        });
    }
  }

  /** The maps this viewer may see. Administrators see all of them. */
  async list(viewer: MapViewer): Promise<MapRow[]> {
    const scope = await this.#access.listScope(viewer, this.#db);
    return scope.all
      ? this.#repository.list(this.#db)
      : this.#repository.listFor(this.#db, scope.groupIds);
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
   *
   * **Refused to anybody who could not change a map** (`A-14`). Every other write here asks for a
   * right on the map, capped by the role and the token; a new map has no right to cap, so the
   * ceilings are the whole check — and until this they were not consulted, so a read-only account
   * and a read-scoped token created maps and were handed `full` on them. Asked before the input
   * is read, so a caller who may not create learns nothing about what a map must look like.
   */
  async create(
    viewer: MapViewer,
    input: { name: string; description?: string; priority?: number; layout?: MapLayout },
    actor: string,
  ): Promise<MapRow> {
    if (!atLeast(ceilingOf(viewer), 'write')) {
      throw new MapError('MAP_FORBIDDEN', 'this account may not create maps', {
        context: { phase: 'create' },
        details: {
          role: viewer.role,
          ...(viewer.scope === undefined ? {} : { scope: viewer.scope }),
        },
      });
    }
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
      await this.#access.grantCreator(tx, map.id, viewer, actor);

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

  /* --------------------------------------------------------------- shares */

  /**
   * The share links on a map. **`full`, because a link is a grant to everybody.**
   *
   * The same right that decides who else may see the map decides who may publish it to people
   * with no account at all — `write` moves a widget, `full` decides the audience, and a public
   * link is the largest audience there is.
   */
  async shares(viewer: MapViewer, id: number): Promise<MapShare[]> {
    return this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      return this.#repository.shares(tx, id);
    });
  }

  /**
   * Mints one, and returns the URL's secret **exactly once**.
   *
   * Only the hash is stored, so this return value is the only time the token exists anywhere this
   * system can produce it. That is a property rather than an inconvenience: a link that can be
   * re-read from the database is a link that leaks with a backup.
   */
  async createShare(
    viewer: MapViewer,
    id: number,
    request: { label: string; expiresAt: Date },
    actor: string,
  ): Promise<{ share: MapShare; token: string }> {
    const label = request.label.trim();
    if (label === '' || label.length > MAX_SHARE_LABEL) {
      throw new MapError('MAP_INVALID', 'a share link needs a label of 1 to 100 characters', {
        context: { mapId: id, phase: 'share' },
      });
    }
    // **Both ends bounded.** In the past it is a link that never works, which reads as a bug; too
    // far ahead it is the permanent unauthenticated route `ADR-002` refuses to allow.
    const now = new Date();
    if (request.expiresAt <= now) {
      throw new MapError('MAP_INVALID', 'a share link cannot expire in the past', {
        context: { mapId: id, phase: 'share' },
      });
    }
    if (request.expiresAt.getTime() - now.getTime() > MAX_SHARE_MS) {
      throw new MapError('MAP_INVALID', 'a share link may last at most a year', {
        context: { mapId: id, phase: 'share' },
      });
    }

    const minted = mintShareToken();
    return this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      // Checked rather than caught, the same way `create` checks a map name: a unique violation
      // inside a transaction aborts it, and every statement after that fails for the wrong reason.
      const clash = await tx.query<{ id: string }>(
        `SELECT id FROM map_share
         WHERE map_id = $1 AND lower(label) = lower($2) AND revoked_at IS NULL`,
        [id, label],
      );
      if (clash.length > 0) {
        throw new MapError('MAP_NAME_TAKEN', `this map already has a link called ${label}`, {
          context: { mapId: id, phase: 'share' },
        });
      }

      const share = await this.#repository.createShare(tx, id, {
        label,
        tokenHash: minted.tokenHash,
        prefix: minted.prefix,
        expiresAt: request.expiresAt,
        createdBy: actor,
      });
      // The label and the expiry, never the token: a share link in the journal is a share link in
      // whatever ships the journal somewhere else.
      this.#logger.info(
        { mapId: id, actor, label, expiresAt: request.expiresAt.toISOString() },
        'map share link created',
      );
      return { share, token: minted.token };
    });
  }

  async revokeShare(viewer: MapViewer, id: number, shareId: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      const revoked = await this.#repository.revokeShare(tx, id, shareId, actor);
      if (!revoked) {
        throw new MapError(
          'MAP_NOT_FOUND',
          `map ${String(id)} has no live link ${String(shareId)}`,
          {
            context: { mapId: id, phase: 'share' },
          },
        );
      }
      this.#logger.info({ mapId: id, actor, shareId }, 'map share link revoked');
    });
  }

  /**
   * What a presented token opens — **the one method here that takes no viewer**.
   *
   * `ADR-002` Decision 1: the token *is* the authorisation, and it authorises exactly one map's
   * already-chosen widgets. Nothing else in this service can be reached without a `MapViewer`,
   * and that asymmetry is deliberate: the public surface is one function, and it is this one.
   *
   * Expiry and revocation are decided by the query, so a row coming back is a link that works.
   */
  async openShare(token: string): Promise<{ mapId: number; map: MapRow } | undefined> {
    if (token.length < 16 || token.length > 100) return undefined;
    return this.#db.tx(async (tx) => {
      const found = await this.#repository.shareByToken(tx, shareTokenHash(token));
      if (found === undefined) return undefined;
      const map = await this.#repository.find(tx, found.mapId);
      // The map is gone but the row is not: impossible through the foreign key, and cheap to be
      // sure of rather than to reason about.
      /* c8 ignore next */
      if (map === undefined) return undefined;
      await this.#repository.touchShare(tx, found.shareId);
      return { mapId: found.mapId, map };
    });
  }

  /**
   * The background behind a shared map, and its bytes.
   *
   * **Keyed by the token, not by a map id, and that is the invariant worth keeping.** Every method
   * on this service is either viewer-gated or token-gated; none of them takes a bare map id and
   * trusts the caller to have checked something first. A `backgroundOfShared(mapId)` would have
   * been one query cheaper and would have been a method that returns an operator's uploaded image
   * to anybody who can call it — exactly the shape of mistake this file exists to prevent.
   *
   * The extra lookup is an indexed hit on a hash, on a route a wall display calls once per open.
   */
  async sharedBackground(token: string): Promise<MapBackground | undefined> {
    const opened = await this.openShare(token);
    if (opened === undefined) return undefined;
    return this.#db.tx((tx) => this.#repository.background(tx, opened.mapId));
  }

  async sharedBackgroundBytes(token: string): Promise<Buffer | undefined> {
    const opened = await this.openShare(token);
    if (opened === undefined) return undefined;
    return this.#db.tx((tx) => this.#repository.backgroundBytes(tx, opened.mapId));
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
    return this.#access.grants(this.#db, id);
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
      if ((await this.#access.grant(tx, id, groupId, right, actor)) === 'no-such-group') {
        throw new MapError('MAP_GROUP_NOT_FOUND', `group ${String(groupId)} does not exist`, {
          context: { mapId: id, phase: 'grant' },
          details: { groupId },
        });
      }
      this.#logger.info({ mapId: id, groupId, right, actor }, 'map access granted');
    });
  }

  async revoke(viewer: MapViewer, id: number, groupId: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      await this.#access.revoke(tx, id, groupId);
      this.#logger.info({ mapId: id, groupId, actor }, 'map access revoked');
    });
  }
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

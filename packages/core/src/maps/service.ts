import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { AccessService, atLeast, grantedByLabel, type AccessRight } from '../auth/access.js';
import { FlatAccess, ceilingOf, verdict, type FlatViewer } from '../auth/flat-access.js';
import type { Actor, AuditSink, MapAudit, MapBackgroundAudit } from '../objects/audit.js';
import { MapError, changedUnderneath, invisible, mapNotFound } from './errors.js';
import { createHash } from 'node:crypto';
import { readImage } from './images.js';
import { mintShareToken, shareTokenHash } from './shares.js';
import { readWidgets } from './widgets.js';
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
  /**
   * Where every change to a map and its grants is recorded, in the change's transaction
   * (`A-17`). Required, so a build cannot wire maps and forget to record what is done to them.
   */
  readonly audit: AuditSink;
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
  readonly #access: FlatAccess;
  /** What a saver may put on a canvas: the object tree's rights, not the map's (`A-22`). */
  readonly #objects: AccessService;
  readonly #audit: AuditSink;
  readonly #logger: Logger;

  constructor(options: MapServiceOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#audit = options.audit;
    this.#access = new FlatAccess(MAP_GRANTS, options.audit);
    // Read here and never written through, but built whole: `A-17` made the audit sink required.
    this.#objects = new AccessService({
      db: options.db,
      audit: options.audit,
      logger: options.logger,
    });
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
    actor: Actor,
    now = new Date(),
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
      await this.#mayPlace(viewer, layout, null, tx, 'create');
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
      await this.#audit.record(
        tx,
        actor,
        [{ action: 'map.created', objectId: null, mapId: map.id, after: auditOf(map) }],
        now,
      );
      await this.#access.grantCreator(tx, map.id, viewer, actor, now);

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
    actor: Actor,
    now = new Date(),
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
      if (patch.layout !== undefined) {
        await this.#mayPlace(viewer, patch.layout, current.layout, tx, 'update', id);
        next.layout = patch.layout;
      }

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

      await this.#audit.record(
        tx,
        actor,
        [
          {
            action: 'map.updated',
            objectId: null,
            mapId: id,
            before: auditOf(current),
            after: auditOf(updated),
          },
        ],
        now,
      );
      this.#logger.info({ mapId: id, actor, version: updated.version }, 'map updated');
      return updated;
    });
  }

  async remove(viewer: MapViewer, id: number, actor: Actor, now = new Date()): Promise<void> {
    await this.#db.tx(async (tx) => {
      const current = await this.require(viewer, id, 'full', tx);
      await this.#repository.remove(tx, id);
      await this.#audit.record(
        tx,
        actor,
        [{ action: 'map.deleted', objectId: null, mapId: id, before: auditOf(current) }],
        now,
      );
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
    actor: Actor,
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
        createdBy: grantedByLabel(actor),
        // The viewer, not the actor: the account whose rights were checked is the one a public
        // view is resolved through (`A-22`).
        createdByUser: viewer.userId,
      });
      await this.#audit.record(
        tx,
        actor,
        [
          {
            action: 'map.share.created',
            objectId: null,
            mapId: id,
            shareId: share.id,
            label: share.label,
            prefix: share.prefix,
            expiresAt: share.expiresAt,
          },
        ],
        now,
      );
      // The label and the expiry, never the token: a share link in the journal is a share link in
      // whatever ships the journal somewhere else.
      this.#logger.info(
        { mapId: id, actor, label, expiresAt: request.expiresAt.toISOString() },
        'map share link created',
      );
      return { share, token: minted.token };
    });
  }

  async revokeShare(
    viewer: MapViewer,
    id: number,
    shareId: number,
    actor: Actor,
    now = new Date(),
  ): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      const revoked = await this.#repository.revokeShare(tx, id, shareId, grantedByLabel(actor));
      if (!revoked) {
        throw new MapError(
          'MAP_NOT_FOUND',
          `map ${String(id)} has no live link ${String(shareId)}`,
          {
            context: { mapId: id, phase: 'share' },
          },
        );
      }
      await this.#audit.record(
        tx,
        actor,
        [{ action: 'map.share.revoked', objectId: null, mapId: id, shareId }],
        now,
      );
      this.#logger.info({ mapId: id, actor, shareId }, 'map share link revoked');
    });
  }

  /**
   * Refuses a layout that adds a widget on an object the saver cannot read (`A-22`).
   *
   * **What a link publishes is bounded by its maker's visibility when it is viewed** — see
   * `MapResolver` — so this is not what keeps a share honest. It keeps the document honest: a map
   * built by an account granted one branch names only that branch, so what the author sees on the
   * canvas and what anybody given the map sees agree about what it is a picture of.
   *
   * **Only the ids the layout adds.** One already on the map stays however it got there — an
   * object since deleted, or placed by somebody who can see more — or a map with one stale tile
   * could never be saved again, by anybody.
   *
   * **A hidden id and an id never issued are refused in the same words**, with the ids the caller
   * sent and nothing else, so a save is not the existence oracle `A-15` closed on the view.
   */
  async #mayPlace(
    viewer: MapViewer,
    layout: unknown,
    stored: unknown,
    q: Queryable,
    phase: 'create' | 'update',
    mapId?: number,
  ): Promise<void> {
    const named = (document: unknown): number[] =>
      readWidgets(document)
        .widgets.map((widget) => widget.objectId)
        .filter((id): id is number => id !== null);
    const before = new Set(stored === null ? [] : named(stored));
    const added = [...new Set(named(layout))].filter((id) => !before.has(id));
    if (added.length === 0) return;

    const rights = await this.#objects.resolveManyFor(
      {
        userId: viewer.userId,
        role: viewer.role,
        ...(viewer.scope === undefined ? {} : { scope: viewer.scope }),
      },
      added,
      q,
    );
    const refused = added.filter((id) => {
      const right = rights.get(id);
      return right === undefined || !atLeast(right, 'read');
    });
    if (refused.length === 0) return;
    throw new MapError('MAP_FORBIDDEN', 'a widget names an object this account may not read', {
      context: { phase, ...(mapId === undefined ? {} : { mapId }) },
      details: { objectIds: refused },
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
   * It comes back with the link's maker as the maker stands now, because a public view is that
   * account's view (`A-22`).
   *
   * **A link whose maker is gone or disabled is not opened at all** (`A-31`): the same answer as
   * a revoked one, for the map and its background alike. Opened, it served nothing from the tree
   * but still served the map's name, its tile titles, its layout, its HTML tiles and its floor
   * plan, on the authority of an account that no longer has any, to somebody told the link had
   * gone blank. Re-enabling the account brings the link back; revoking it ends it.
   */
  async openShare(
    token: string,
  ): Promise<{ mapId: number; map: MapRow; maker: MapViewer } | undefined> {
    if (token.length < 16 || token.length > 100) return undefined;
    return this.#db.tx(async (tx) => {
      const found = await this.#repository.shareByToken(tx, shareTokenHash(token));
      if (found === undefined || found.maker === null) return undefined;
      const map = await this.#repository.find(tx, found.mapId);
      // The map is gone but the row is not: impossible through the foreign key, and cheap to be
      // sure of rather than to reason about.
      /* c8 ignore next */
      if (map === undefined) return undefined;
      await this.#repository.touchShare(tx, found.shareId);
      return { mapId: found.mapId, map, maker: found.maker };
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
    actor: Actor,
    now = new Date(),
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
      const replaced = await this.#repository.background(tx, id);
      await this.#repository.putBackground(tx, id, {
        mediaType: facts.mediaType,
        digest,
        width: facts.width,
        height: facts.height,
        bytes,
        uploadedBy: grantedByLabel(actor),
      });
      this.#logger.info(
        { mapId: id, actor, mediaType: facts.mediaType, bytes: bytes.length, digest },
        'map background stored',
      );
      const stored = await this.#repository.background(tx, id);
      /* c8 ignore next -- it was written in this transaction */
      if (stored === undefined) throw mapNotFound(id);
      await this.#audit.record(
        tx,
        actor,
        [
          {
            action: 'map.background.set',
            objectId: null,
            mapId: id,
            before: replaced === undefined ? null : backgroundAuditOf(replaced),
            after: backgroundAuditOf(stored),
          },
        ],
        now,
      );
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

  async removeBackground(
    viewer: MapViewer,
    id: number,
    actor: Actor,
    now = new Date(),
  ): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'write', tx);
      const before = await this.#repository.background(tx, id);
      const removed = await this.#repository.removeBackground(tx, id);
      // Nothing removed, nothing recorded: removing a background that is not there changes
      // nothing, the same rule a revoke that found no grant follows.
      if (!removed || before === undefined) return;
      await this.#audit.record(
        tx,
        actor,
        [
          {
            action: 'map.background.removed',
            objectId: null,
            mapId: id,
            before: backgroundAuditOf(before),
          },
        ],
        now,
      );
      this.#logger.info({ mapId: id, actor }, 'map background removed');
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
    actor: Actor,
    now = new Date(),
  ): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      if ((await this.#access.grant(tx, id, groupId, right, actor, now)) === 'no-such-group') {
        throw new MapError('MAP_GROUP_NOT_FOUND', `group ${String(groupId)} does not exist`, {
          context: { mapId: id, phase: 'grant' },
          details: { groupId },
        });
      }
      this.#logger.info({ mapId: id, groupId, right, actor }, 'map access granted');
    });
  }

  async revoke(
    viewer: MapViewer,
    id: number,
    groupId: number,
    actor: Actor,
    now = new Date(),
  ): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      await this.#access.revoke(tx, id, groupId, actor, now);
      this.#logger.info({ mapId: id, groupId, actor }, 'map access revoked');
    });
  }
}

/** A map as the audit log records it. */
function auditOf(map: MapRow): MapAudit {
  return {
    name: map.name,
    description: map.description,
    priority: map.priority,
    layout: layoutText(map.layout),
  };
}

/**
 * A layout as lines: each item of a list on its own, prefixed by the list it is in.
 *
 * **Read as `unknown`, the way the resolver reads it.** Nothing holds the column to having
 * `widgets` — the route accepts any object and `G-02` keeps what it cannot parse — so an audit that
 * assumed the shape would turn a strange save into a 500. And the whole layout, not the widgets:
 * connectors and the geographical view are edits too.
 */
function layoutText(layout: unknown): string {
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
    return JSON.stringify(layout);
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(layout)) {
    if (Array.isArray(value) && value.length > 0) {
      for (const item of value) lines.push(`${key}: ${JSON.stringify(item)}`);
    } else {
      // An empty list is said, as `widgets: []`: rendered as no lines it would read the same as a
      // layout that had no such list at all.
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n');
}

function backgroundAuditOf(background: MapBackground): MapBackgroundAudit {
  return {
    mediaType: background.mediaType,
    digest: background.digest,
    width: background.width,
    height: background.height,
    bytes: background.bytes,
  };
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

import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { AccountRole } from './accounts.js';
import { AuthError } from './errors.js';

/**
 * Per-object access rights (`A-03`, `CAPABILITIES.MD §14`).
 *
 * Three rules, and they compose in one direction only:
 *
 *   1. **Inheritance up the tree** — a right holds for everything beneath the object it was
 *      granted on, until something lower overrides it.
 *   2. **Explicit beats inherited** — the nearest ancestor that defines a right for *this group*
 *      is the one that counts, so a grant on a device overrides one on its probe.
 *   3. **Highest wins across groups** — an account's right is the maximum over the groups it
 *      belongs to.
 *
 * **Rules 2 and 3 are applied in that order, per group and then across them, and the order is
 * the whole design.** Doing it the other way — find the nearest ancestor defining a right for
 * *anybody*, then take the maximum only at that level — sounds equivalent and is not: granting
 * one group `read` on a deep device would silently strip another group's inherited `full`.
 * Adding a grant must never take one away, which is the same principle `A-02` applies to the
 * primary group.
 *
 * **Resolved in SQL, in one query, for the same reason the settings resolver is** — this is
 * asked on the hottest path in the system, once per object per request, and fetching a chain to
 * loop over it in JavaScript would be a round trip per level. It is deliberately the *only*
 * place that walks the tree for rights: `CLAUDE.md`'s rule that inheritance is resolved in one
 * place is about exactly this kind of duplication.
 */

export type AccessRight = 'none' | 'read' | 'write' | 'full';

const RANK: Readonly<Record<AccessRight, number>> = { none: 0, read: 1, write: 2, full: 3 };

export function atLeast(held: AccessRight, needed: AccessRight): boolean {
  return RANK[held] >= RANK[needed];
}

/**
 * The most an account of this role may hold, whatever its groups grant (`A-04`).
 *
 * **A role is a ceiling, not a starting point.** A read-only account that is a member of a group
 * holding `full` still may not write: somebody made it read-only on purpose, and a group
 * membership is not a way to undo that. Applied where the right is resolved rather than at each
 * route, for the same reason redaction lives at one boundary — a new endpoint cannot forget a
 * cap it never has to apply.
 */
const CEILING: Readonly<Record<AccountRole, AccessRight>> = {
  admin: 'full',
  readwrite: 'full',
  readonly: 'read',
};

export function cappedBy(role: AccountRole, right: AccessRight): AccessRight {
  return lower(right, CEILING[role]);
}

/** The lesser of two rights. Every ceiling in this system is one of these. */
export function lower(a: AccessRight, b: AccessRight): AccessRight {
  return RANK[a] <= RANK[b] ? a : b;
}

/** How a right was arrived at, which is what an administrator needs to debug a refusal. */
export interface ResolvedAccess {
  right: AccessRight;
  /** The object the winning grant sits on — the object itself when it was explicit. */
  sourceObjectId: number | null;
  /** The group whose grant won. */
  sourceGroupId: number | null;
  inherited: boolean;
  /** True when the account administers everything and no grant was consulted. */
  viaAdminGroup: boolean;
  /**
   * True when the account's role held it below what its groups granted (`A-04`).
   *
   * Reported rather than silent: "you have full on this device and may not edit it" is
   * incomprehensible without it, and an administrator looking at a read-only account's
   * complaint needs to see that the cap is why.
   */
  cappedByRole?: boolean;
  /** True when the *token* used for this request held it below what the account could do. */
  cappedByToken?: boolean;
}

const DENIED: ResolvedAccess = {
  right: 'none',
  sourceObjectId: null,
  sourceGroupId: null,
  inherited: false,
  viaAdminGroup: false,
};

const MAX_WALK_DEPTH = 1000;

export interface AccessServiceOptions {
  db: Database;
  logger: Logger;
}

export class AccessService {
  readonly #db: Database;
  readonly #logger: Logger;

  constructor(options: AccessServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'access' });
  }

  /**
   * What this account may do with this object.
   *
   * **A member of any administrator group short-circuits the whole walk.** "May do anything,
   * including to objects that do not exist yet" is not a statement about a position in the tree,
   * so it is not expressible as a grant — and making administrators depend on a row is how an
   * installation locks itself out by deleting one.
   */
  async resolve(
    userId: number,
    objectId: number,
    q: Queryable = this.#db,
  ): Promise<ResolvedAccess> {
    const admin = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.is_admin`,
      [userId],
    );
    if (Number(admin[0]?.total ?? 0) > 0) {
      return {
        right: 'full',
        sourceObjectId: null,
        sourceGroupId: null,
        inherited: false,
        viaAdminGroup: true,
      };
    }

    const rows = await q.query<{
      right_: AccessRight;
      object_id: string;
      group_id: string;
      depth: number;
    }>(
      `
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth
        FROM object
        WHERE id = $2

        UNION ALL

        SELECT parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      ),
      -- **Rule 2, per group.** The nearest ancestor defining a right for each of this account's
      -- groups; depth 0 is the object itself, which is what makes explicit beat inherited.
      nearest AS (
        SELECT DISTINCT ON (a.group_id)
               a.right_, a.object_id, a.group_id, chain.depth
        FROM chain
        JOIN object_access a ON a.object_id = chain.id
        JOIN user_group_member m ON m.group_id = a.group_id AND m.user_id = $1
        ORDER BY a.group_id, chain.depth ASC
      )
      -- **Rule 3, across groups**, and only now: each group has already had its own nearest
      -- ancestor found, so a grant added for one group cannot displace another's.
      SELECT right_, object_id::text AS object_id, group_id::text AS group_id, depth
      FROM nearest
      ORDER BY access_rank(right_) DESC, depth ASC
      LIMIT 1
      `,
      [userId, objectId],
    );

    const row = rows[0];
    if (row === undefined) return DENIED;
    return {
      right: row.right_,
      sourceObjectId: Number(row.object_id),
      sourceGroupId: Number(row.group_id),
      inherited: row.depth > 0,
      viaAdminGroup: false,
    };
  }

  /**
   * What this account may do, with its role's ceiling applied (`A-04`).
   *
   * The one an authorisation check should call. `resolve` answers what the *groups* grant, which
   * is what an administrator wants to see when debugging a grant; this answers what the account
   * may actually do, which is a different question whenever the two disagree.
   */
  async resolveFor(
    principal: { userId: number; role: AccountRole; scope?: AccessRight },
    objectId: number,
    q: Queryable = this.#db,
  ): Promise<ResolvedAccess> {
    const resolved = await this.resolve(principal.userId, objectId, q);

    // **Two ceilings, applied in order, and both only ever lower.** The role is what the account
    // is allowed to be (`A-04`); the scope is what this particular credential may do (`A-06`).
    // A token cannot exceed its owner, and its owner cannot exceed their role — so a read-only
    // account's `full` token is still read, and a read-write account's `read` token is still
    // read even on an object where its groups grant `full`.
    const afterRole = cappedBy(principal.role, resolved.right);
    const afterScope =
      principal.scope === undefined ? afterRole : lower(afterRole, principal.scope);

    if (afterScope === resolved.right) return resolved;
    return {
      ...resolved,
      right: afterScope,
      cappedByRole: afterRole !== resolved.right,
      ...(afterScope !== afterRole ? { cappedByToken: true } : {}),
    };
  }

  /** Throws unless the account holds at least this right, after its role's ceiling. */
  async requireFor(
    principal: { userId: number; role: AccountRole; scope?: AccessRight },
    objectId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<ResolvedAccess> {
    const resolved = await this.resolveFor(principal, objectId, q);
    if (!atLeast(resolved.right, needed)) {
      throw new AuthError('AUTH_FORBIDDEN', `this action needs ${needed} on that object`, {
        objectId,
        held: resolved.right,
        needed,
        ...(resolved.cappedByRole === true ? { cappedByRole: principal.role } : {}),
        ...(resolved.cappedByToken === true ? { cappedByToken: principal.scope ?? '' } : {}),
      });
    }
    return resolved;
  }

  /** Throws unless the account's *groups* grant at least this right, ignoring its role. */
  async require(
    userId: number,
    objectId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<ResolvedAccess> {
    const resolved = await this.resolve(userId, objectId, q);
    if (!atLeast(resolved.right, needed)) {
      // **404 is not used for a hidden object here**, and that is a decision worth stating. It
      // would hide the existence of objects an account may not see, which is the stronger
      // posture — and it makes every "why can I not see this?" unanswerable for the operator and
      // the administrator alike. `A-04` revisits it for the read-only case if it needs to.
      throw new AuthError('AUTH_FORBIDDEN', `this action needs ${needed} on that object`, {
        objectId,
        held: resolved.right,
        needed,
      });
    }
    return resolved;
  }

  /**
   * Resolves the right for many objects at once.
   *
   * The list view asks for a page of objects and would otherwise be one walk per row. Same three
   * rules, applied per object inside the query.
   */
  async resolveMany(
    userId: number,
    objectIds: readonly number[],
    q: Queryable = this.#db,
  ): Promise<Map<number, AccessRight>> {
    const result = new Map<number, AccessRight>();
    if (objectIds.length === 0) return result;

    const admin = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.is_admin`,
      [userId],
    );
    if (Number(admin[0]?.total ?? 0) > 0) {
      for (const id of objectIds) result.set(id, 'full');
      return result;
    }

    const rows = await q.query<{ root_id: string; right_: AccessRight }>(
      `
      WITH RECURSIVE chain AS (
        SELECT id AS root_id, id, parent_id, 0 AS depth
        FROM object
        WHERE id = ANY($2)

        UNION ALL

        SELECT chain.root_id, parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      ),
      nearest AS (
        SELECT DISTINCT ON (chain.root_id, a.group_id)
               chain.root_id, a.right_, chain.depth
        FROM chain
        JOIN object_access a ON a.object_id = chain.id
        JOIN user_group_member m ON m.group_id = a.group_id AND m.user_id = $1
        ORDER BY chain.root_id, a.group_id, chain.depth ASC
      )
      SELECT DISTINCT ON (root_id) root_id::text AS root_id, right_
      FROM nearest
      ORDER BY root_id, access_rank(right_) DESC
      `,
      [userId, [...objectIds]],
    );

    for (const row of rows) result.set(Number(row.root_id), row.right_);
    // Anything the query said nothing about has no grant anywhere above it.
    for (const id of objectIds) if (!result.has(id)) result.set(id, 'none');
    return result;
  }

  /**
   * `resolveMany`, with the role and token ceilings applied (`A-04`, `A-06`).
   *
   * The batched twin of `resolveFor`, and it exists for the bulk route: a selection of six
   * hundred objects must not be six hundred walks, and it must not be *unchecked* either —
   * which is what it was. `resolveMany` answers what the groups grant, which is never the
   * question an authorisation check is asking.
   */
  async resolveManyFor(
    principal: { userId: number; role: AccountRole; scope?: AccessRight },
    objectIds: readonly number[],
    q: Queryable = this.#db,
  ): Promise<Map<number, AccessRight>> {
    const granted = await this.resolveMany(principal.userId, objectIds, q);
    const capped = new Map<number, AccessRight>();
    for (const [id, right] of granted) {
      const afterRole = cappedBy(principal.role, right);
      capped.set(id, principal.scope === undefined ? afterRole : lower(afterRole, principal.scope));
    }
    return capped;
  }

  /** Every grant sitting directly on this object. */
  async grantsOn(
    objectId: number,
  ): Promise<{ groupId: number; groupName: string; right: AccessRight; grantedBy: string }[]> {
    const rows = await this.#db.query<{
      group_id: string;
      name: string;
      right_: AccessRight;
      granted_by: string;
    }>(
      `SELECT a.group_id::text AS group_id, g.name, a.right_, a.granted_by
       FROM object_access a JOIN user_group g ON g.id = a.group_id
       WHERE a.object_id = $1
       ORDER BY lower(g.name)`,
      [objectId],
    );
    return rows.map((row) => ({
      groupId: Number(row.group_id),
      groupName: row.name,
      right: row.right_,
      grantedBy: row.granted_by,
    }));
  }

  async grant(
    objectId: number,
    groupId: number,
    right: AccessRight,
    grantedBy: string,
  ): Promise<void> {
    try {
      await this.#db.query(
        `INSERT INTO object_access (object_id, group_id, right_, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (object_id, group_id)
         DO UPDATE SET right_ = EXCLUDED.right_, granted_by = EXCLUDED.granted_by,
                       granted_at = now()`,
        [objectId, groupId, right, grantedBy.slice(0, 64)],
      );
    } catch (error: unknown) {
      throw new AuthError('ACCESS_TARGET_MISSING', 'no such object or group', {
        objectId,
        groupId,
        cause: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }
    this.#logger.info({ objectId, groupId, right, grantedBy }, 'access granted');
  }

  /**
   * Removes an explicit grant, so the object falls back to what it inherits.
   *
   * Not the same as granting `none`: revoking restores inheritance, while `none` *overrides* it.
   * An administrator needs both — one to undo a mistake, the other to carve a hole in a branch
   * somebody else has access to.
   */
  async revoke(objectId: number, groupId: number): Promise<boolean> {
    const rows = await this.#db.query<{ object_id: string }>(
      `DELETE FROM object_access WHERE object_id = $1 AND group_id = $2
       RETURNING object_id::text AS object_id`,
      [objectId, groupId],
    );
    return rows.length > 0;
  }
}

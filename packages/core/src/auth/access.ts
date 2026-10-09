import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
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

/**
 * No right, from no grant: what an object outside every grant resolves to, and so what an unused
 * id does too. Also what a non-administrator is told about their own `none`, whatever made it,
 * so that a hidden object answers exactly as an absent one (`A-49`).
 */
export const DENIED: ResolvedAccess = {
  right: 'none',
  sourceObjectId: null,
  sourceGroupId: null,
  inherited: false,
  viaAdminGroup: false,
};

/** What a principal may do to an object, and the least it may do anywhere beneath it (`A-35`). */
export interface SubtreeAccess {
  /** On the object itself: `resolveManyFor`'s answer. */
  own: AccessRight;
  /** The weakest right on the object or on anything in the subtree beneath it. */
  weakest: AccessRight;
}

/** Who a right is resolved for: an account, its role, and the scope of the credential in use. */
export interface AccessPrincipal {
  userId: number;
  role: AccountRole;
  scope?: AccessRight;
}

/**
 * The right a principal may exercise, given what its groups grant: the role's ceiling (`A-04`),
 * then the token's (`A-06`). Both only ever lower.
 */
function ceilingFor(principal: AccessPrincipal, granted: AccessRight): AccessRight {
  const afterRole = cappedBy(principal.role, granted);
  return principal.scope === undefined ? afterRole : lower(afterRole, principal.scope);
}

/** True when the account is in a group that administers the installation. */
function administers(user: string): string {
  return `EXISTS (
    SELECT 1 FROM user_group_member m JOIN user_group g ON g.id = m.group_id
    WHERE m.user_id = ${user} AND g.is_admin
  )`;
}

/**
 * The right an account's groups grant on each of `ids`, as rows of `(root_id, right_)`.
 *
 * **The one piece of SQL that applies `A-03`'s three rules**, built here so that `resolveMany`
 * and `visibilityFor` run the same text rather than two copies that could drift (`A-12`). An id
 * with no grant anywhere above it produces no row; the caller reads that as `none`.
 *
 * `user` and `ids` are SQL expressions — placeholders, or a subquery producing a `bigint[]`.
 */
function rightsOf(user: string, ids: string): string {
  return `
      ${nearestGrants(ids, user)}
      -- **Rule 3, across groups**, and only now: each group has already had its own nearest
      -- ancestor found, so a grant added for one group cannot displace another's.
      SELECT DISTINCT ON (root_id) root_id, right_
      FROM nearest
      ORDER BY root_id, access_rank(right_) DESC
  `;
}

/**
 * Rules 1 and 2: each group's nearest grant on each of `ids`, as a `nearest` CTE of
 * `(root_id, group_id, right_, depth)`. `user` limits it to that account's groups, or null asks
 * it of every group (`A-76`). Shared by `rightsOf` and `groupRightsOn`, so the two cannot come to
 * disagree about which grant is a group's.
 */
function nearestGrants(ids: string, user: string | null): string {
  const member =
    user === null
      ? ''
      : `JOIN user_group_member m ON m.group_id = a.group_id AND m.user_id = ${user}`;
  return `
      WITH RECURSIVE chain AS (
        SELECT id AS root_id, id, parent_id, 0 AS depth
        FROM object
        WHERE id = ANY(${ids})

        UNION ALL

        SELECT chain.root_id, parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      ),
      -- **Rule 2, per group.** The nearest ancestor defining a right for each group; depth 0 is
      -- the object itself, which is what makes explicit beat inherited.
      nearest AS (
        SELECT DISTINCT ON (chain.root_id, a.group_id)
               chain.root_id, a.group_id, a.right_, chain.depth
        FROM chain
        JOIN object_access a ON a.object_id = chain.id
        ${member}
        ORDER BY chain.root_id, a.group_id, chain.depth ASC
      )
  `;
}

/**
 * What each group's own grants give it on each of these objects: rule 2 alone, before rule 3
 * picks among an account's groups (`A-76`).
 *
 * For a question about a group rather than an account: whether a `read` copied with a clone
 * narrows what that group holds where the copy landed, or would hand it something. A group with
 * no grant at or above an object is absent from that object's map, which means `none`.
 */
export async function groupRightsOn(
  q: Queryable,
  objectIds: readonly number[],
): Promise<Map<number, Map<number, AccessRight>>> {
  const result = new Map<number, Map<number, AccessRight>>();
  if (objectIds.length === 0) return result;
  const rows = await q.query<{ root_id: string; group_id: string; right_: AccessRight }>(
    `${nearestGrants('$1::bigint[]', null)}
     SELECT root_id::text AS root_id, group_id::text AS group_id, right_ FROM nearest`,
    [[...objectIds]],
  );
  for (const row of rows) {
    const id = Number(row.root_id);
    const groups = result.get(id) ?? new Map<number, AccessRight>();
    groups.set(Number(row.group_id), row.right_);
    result.set(id, groups);
  }
  return result;
}

/**
 * Every object carrying a grant for one of this account's groups: its *boundaries* (`A-12`).
 *
 * The only objects at which what the account may do can differ from what it may do to the
 * parent — between two of them, every group's nearest grant is the same row.
 */
function boundariesOf(user: string): string {
  return `ARRAY(
    SELECT DISTINCT a.object_id
    FROM object_access a
    JOIN user_group_member m ON m.group_id = a.group_id AND m.user_id = ${user}
  )`;
}

/**
 * What one principal may see of the object tree (`A-12`).
 *
 * **Rights are not resolved here.** They are resolved once, by `resolveMany`'s own SQL, at the
 * principal's *boundaries* — the objects carrying a grant for one of its groups, which are the
 * only places the answer can change. Between two boundaries every group's nearest grant is the
 * same row, so an object is visible exactly when its nearest boundary is, and hidden when it has
 * none above it. What this class carries is that labelling, and the two ways of applying it:
 *
 *   - `where`, a SQL condition, so that a list query filters *inside* itself — a page of 100 is
 *     still 100, a keyset cursor does not skip, and a total counts only what it shows;
 *   - `sees`, for a root-first path already in hand, which is every event the stream publishes.
 *
 * Both are structural and neither contains a right, so neither can disagree with the resolver
 * about one. The structural claim is what `access-rights.test.ts` checks, object by object,
 * against `resolveManyFor` over a randomised tree.
 *
 * **"Everything" has to be asked for.** Services that list take one of these as a required
 * argument, and the permissive value is a named constant, for the reason `MapAudience` is a
 * union: a default that means "no checks" is how the next caller gets an unauthenticated read of
 * everything by leaving an argument out.
 */
export class Visibility {
  /**
   * The whole tree, including objects that do not exist yet.
   *
   * An internal caller that is not acting for anybody, or an installation that has not switched
   * the authorisation layer on. An administrator gets `Visibility.everything(epoch)` instead, so
   * that a stream socket can notice when they stop being one.
   */
  static readonly EVERYTHING = new Visibility(null, false, null);

  /** The whole tree, as of this access epoch. */
  static everything(epoch: number | null): Visibility {
    return new Visibility(null, false, epoch);
  }

  /** Nothing at all — a token scoped to `none`, or an account with no grant anywhere. */
  static nothing(epoch: number | null): Visibility {
    return new Visibility(new Map(), false, epoch);
  }

  /** From labelled boundaries. `rootSees` is the root's label, or false when it has none. */
  static of(
    boundaries: ReadonlyMap<number, boolean>,
    rootSees: boolean,
    epoch: number | null,
  ): Visibility {
    return new Visibility(boundaries, rootSees, epoch);
  }

  readonly #boundaries: ReadonlyMap<number, boolean> | null;
  readonly #rootSees: boolean;
  /**
   * The `access_epoch` this was resolved at (migration 052), or null when nobody resolved it.
   * The stream compares it with the current one to know when to resolve again.
   */
  readonly epoch: number | null;

  private constructor(
    boundaries: ReadonlyMap<number, boolean> | null,
    rootSees: boolean,
    epoch: number | null,
  ) {
    this.#boundaries = boundaries;
    this.#rootSees = rootSees;
    this.epoch = epoch;
  }

  /** True when nothing is hidden, so a query needs no condition at all. */
  get everything(): boolean {
    return this.#boundaries === null;
  }

  /**
   * Whether the object at the end of this root-first path is visible.
   *
   * The nearest boundary on the path decides, and no boundary at all means no grant anywhere
   * above it — which the resolver answers `none`. The path has to be the whole path from the
   * root: a truncated one would lose the boundary that decides it.
   */
  sees(path: readonly number[]): boolean {
    const boundaries = this.#boundaries;
    if (boundaries === null) return true;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const label = boundaries.get(path[i] ?? 0);
      if (label !== undefined) return label;
    }
    return false;
  }

  /**
   * The steps of a root-first path this principal may see, in order.
   *
   * **The containers above a granted branch are outside it**, so a path is trimmed rather than
   * shown whole: a customer granted one group sees that group and what is under it, and never
   * learns what the probe above it is called. Not necessarily a prefix-free cut — a hole carved
   * in the middle of a readable branch removes the steps inside it and keeps the ones below a
   * grant that re-opens it.
   */
  trim(path: readonly number[]): number[] {
    const boundaries = this.#boundaries;
    if (boundaries === null) return [...path];
    const kept: number[] = [];
    let seen = false;
    for (const id of path) {
      const label = boundaries.get(id);
      if (label !== undefined) seen = label;
      if (seen) kept.push(id);
    }
    return kept;
  }

  /**
   * A SQL condition that holds exactly for the rows whose `column` names a visible object.
   *
   * **The walk is over the part of the tree that disagrees with the root**, which is what keeps
   * it cheap for the two shapes an installation actually has. Starting from the boundaries whose
   * label differs from the root's and stopping at any boundary, it reaches the *exceptions*: the
   * holes, for an account that sees the root, or the granted branches, for one that does not. A
   * row is visible when it is `NOT IN` the exceptions in the first case and `IN` them in the
   * second — and an account with no exceptions at all gets no walk.
   *
   * `bind` adds a parameter and returns its placeholder, in whatever style the caller's query
   * builds them.
   *
   * `mayBeDeleted` is for a column that can name an object which no longer exists — the state
   * log outlives its sensors. Nothing records which branch a deleted sensor was in, so its rows
   * are visible to nobody but an administrator, the same answer the resolver gives for any id
   * that does not exist. (The notification log does not outlive them: its rows cascade.)
   */
  where(
    column: string,
    bind: (value: unknown) => string,
    options: { mayBeDeleted?: boolean } = {},
  ): string {
    const boundaries = this.#boundaries;
    if (boundaries === null) return 'TRUE';

    const starts: number[] = [];
    const stops: number[] = [];
    for (const [id, label] of boundaries) {
      stops.push(id);
      if (label !== this.#rootSees) starts.push(id);
    }

    const exists =
      options.mayBeDeleted === true
        ? ` AND EXISTS (SELECT 1 FROM object WHERE id = ${column})`
        : '';
    if (starts.length === 0) return this.#rootSees ? `(TRUE${exists})` : 'FALSE';

    const exceptions = `
      WITH RECURSIVE exception AS (
        SELECT o.id, 0 AS depth FROM object o WHERE o.id = ANY(${bind(starts)}::bigint[])
        UNION ALL
        SELECT c.id, exception.depth + 1
        FROM object c
        JOIN exception ON c.parent_id = exception.id
        WHERE exception.depth < ${String(MAX_WALK_DEPTH)}
          AND c.id <> ALL(${bind(stops)}::bigint[])
      )
      SELECT id FROM exception
    `;
    return this.#rootSees
      ? `(${column} NOT IN (${exceptions})${exists})`
      : `${column} IN (${exceptions})`;
  }

  /**
   * A SQL condition for a row whose **parent is already known to be visible** (`A-12`).
   *
   * Visibility changes only at a boundary, so beneath a visible object the only children that
   * are not visible are hidden boundaries themselves — a `none` carved exactly there. That is a
   * membership test against a handful of ids and needs no walk, which is what keeps `hasChildren`
   * and `childCount` from paying for a second walk of the tree beside the one that chose the
   * rows. Only for that shape: asked of a row whose parent may be hidden, it answers wrongly.
   */
  whereChildOfVisible(column: string, bind: (value: unknown) => string): string {
    const boundaries = this.#boundaries;
    if (boundaries === null) return 'TRUE';
    const hidden = [...boundaries].filter(([, label]) => !label).map(([id]) => id);
    return hidden.length === 0 ? 'TRUE' : `${column} <> ALL(${bind(hidden)}::bigint[])`;
  }

  /**
   * Which of these objects are visible — for the answers about one object that name another.
   *
   * An inherited trigger names where it is defined, a pause names what it is inherited from, a
   * dependency names its master: each is a visible object's own fact with a second object's name
   * in it, and that second object can be outside the branch (`A-12`). The same condition as every
   * list, asked of a handful of ids rather than a table.
   */
  async visibleAmong(q: Queryable, ids: readonly number[]): Promise<Set<number>> {
    if (this.#boundaries === null || ids.length === 0) return new Set(ids);
    const values: unknown[] = [ids];
    const visible = this.where('id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM object WHERE id = ANY($1::bigint[]) AND ${visible}`,
      values,
    );
    return new Set(rows.map((row) => Number(row.id)));
  }

  /**
   * Whether anything beneath this object is hidden (`A-46`): for a count an object's history
   * recorded over somebody else's view, which counts it.
   *
   * **Asked of an object this principal can see**, which is the history route's bar. Beneath a
   * visible object visibility changes only at a boundary, so something beneath it is hidden
   * exactly when a hidden boundary is. The walk climbs from those, a handful, and never descends
   * a subtree of thousands.
   */
  async hidesBeneath(q: Queryable, id: number): Promise<boolean> {
    const boundaries = this.#boundaries;
    if (boundaries === null) return false;
    const hidden = [...boundaries].filter(([, label]) => !label).map(([boundary]) => boundary);
    if (hidden.length === 0) return false;
    const rows = await q.query<{ hides: boolean }>(
      `WITH RECURSIVE above AS (
         SELECT o.parent_id AS id, 1 AS depth FROM object o WHERE o.id = ANY($1::bigint[])
         UNION ALL
         SELECT o.parent_id, above.depth + 1
         FROM object o
         JOIN above ON o.id = above.id
         WHERE o.parent_id IS NOT NULL AND above.depth < ${String(MAX_WALK_DEPTH)}
       )
       SELECT EXISTS (SELECT 1 FROM above WHERE above.id = $2) AS hides`,
      [hidden, id],
    );
    return rows[0]?.hides === true;
  }

  /**
   * Whether any child of this object is hidden (`A-46`): for a position among siblings an
   * object's history recorded over somebody else's view. The parent may be hidden itself, where
   * the object alone was granted, so this is the whole condition and not `whereChildOfVisible`.
   */
  async hidesChildOf(q: Queryable, parentId: number): Promise<boolean> {
    if (this.#boundaries === null) return false;
    const values: unknown[] = [parentId];
    const visible = this.where('c.id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ hides: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM object c WHERE c.parent_id = $1 AND NOT (${visible})
       ) AS hides`,
      values,
    );
    return rows[0]?.hides === true;
  }

  /**
   * The boundaries this principal can see, or null when it sees everything.
   *
   * The only candidates for where a branch account's tree starts (`ObjectRepository.tops`).
   */
  seenBoundaries(): number[] | null {
    const boundaries = this.#boundaries;
    if (boundaries === null) return null;
    return [...boundaries].filter(([, label]) => label).map(([id]) => id);
  }

  /** Whether two resolutions would show the same objects. The stream's "has my view changed". */
  sameAs(other: Visibility): boolean {
    const mine = this.#boundaries;
    const theirs = other.#boundaries;
    if (mine === null || theirs === null) return mine === theirs;
    if (this.#rootSees !== other.#rootSees || mine.size !== theirs.size) return false;
    for (const [id, label] of mine) if (theirs.get(id) !== label) return false;
    return true;
  }
}

/**
 * Which of some objects a caller may act on, each by the right that naming it alone would need
 * (`A-31`).
 *
 * For an action that one call writes onto each child of what it names: an acknowledgement, or a
 * forced error. `A-35`'s rule is that an action through a parent may not do to a child what the
 * caller could not do to that child directly, so a sensor granted only `read` under a device
 * its caller may write is left out and reported rather than reached. A pause is not one of
 * these. It is state on the parent that the children inherit, and nothing is written onto them.
 *
 * Asked after `Visibility`, never instead of it: what is split here has already been cut to
 * what the caller can see, so what is left out is never a hole.
 *
 * As `Visibility` is, "everything" has to be asked for by name.
 */
export class Reach {
  /** An internal caller acting for nobody, or an installation with the layer switched off. */
  static readonly EVERYTHING = new Reach((_q, objectIds) => Promise.resolve(new Set(objectIds)));

  readonly #reached: (q: Queryable, objectIds: readonly number[]) => Promise<ReadonlySet<number>>;

  constructor(
    reached: (q: Queryable, objectIds: readonly number[]) => Promise<ReadonlySet<number>>,
  ) {
    this.#reached = reached;
  }

  /** The ids split in the order given: those it may act on, and those it may only see. */
  async split(
    q: Queryable,
    objectIds: readonly number[],
  ): Promise<{ reached: number[]; skipped: number[] }> {
    const reached = objectIds.length === 0 ? new Set<number>() : await this.#reached(q, objectIds);
    return {
      reached: objectIds.filter((id) => reached.has(id)),
      skipped: objectIds.filter((id) => !reached.has(id)),
    };
  }
}

/**
 * Who granted a right, as a `granted_by` column stores it: a login, or nothing for a non-person.
 *
 * The audit entry carries the whole actor; this column is the short answer a grants list shows.
 * Here rather than beside the flat grants that also use it, because they import from this module
 * and an object grant is the older of the two.
 */
export function grantedByLabel(actor: Actor): string {
  return actor.kind === 'user' ? actor.login.slice(0, 64) : '';
}

export interface AccessServiceOptions {
  db: Database;
  /**
   * Where a grant on an object is recorded, inside the grant's own transaction (`A-17`).
   *
   * Required, although most of this service only reads: a grant decides who sees a branch of the
   * tree, and a sink that could be left out is how one was — object grants went unaudited from
   * `A-02` until this ticket, while every edit to what they protect was recorded.
   */
  audit: AuditSink;
  logger: Logger;
}

export class AccessService {
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  #rootId: number | undefined;

  constructor(options: AccessServiceOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
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
    const admin = await q.query<{ admin: boolean }>(`SELECT ${administers('$1')} AS admin`, [
      userId,
    ]);
    if (admin[0]?.admin === true) {
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
      --
      -- The tie goes to the lowest group id, and qualified (P-385): a bare group_id here names
      -- the text column this SELECT returns, which sorts 100 before 99.
      SELECT right_, object_id::text AS object_id, group_id::text AS group_id, depth
      FROM nearest
      ORDER BY access_rank(right_) DESC, depth ASC, nearest.group_id
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

    const admin = await q.query<{ admin: boolean }>(`SELECT ${administers('$1')} AS admin`, [
      userId,
    ]);
    if (admin[0]?.admin === true) {
      for (const id of objectIds) result.set(id, 'full');
      return result;
    }

    const rows = await q.query<{ root_id: string; right_: AccessRight }>(
      `SELECT root_id::text AS root_id, right_ FROM (${rightsOf('$1', '$2')}) AS rights`,
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
    principal: AccessPrincipal,
    objectIds: readonly number[],
    q: Queryable = this.#db,
  ): Promise<Map<number, AccessRight>> {
    const granted = await this.resolveMany(principal.userId, objectIds, q);
    const capped = new Map<number, AccessRight>();
    for (const [id, right] of granted) capped.set(id, ceilingFor(principal, right));
    return capped;
  }

  /**
   * What this principal may do to each object, and the least it may do anywhere beneath it
   * (`A-35`).
   *
   * For the changes that take a whole subtree with them. A delete destroys everything beneath
   * the object and a move carries it, so `write` on the object alone is the wrong question: an
   * operator with `write` on a device whose sensor was carved `none` was refused that sensor,
   * and then destroyed it by deleting the device.
   *
   * **Only the principal's boundaries are resolved.** Between two of them every group's nearest
   * grant is the same row (`boundariesOf`), so the rights held anywhere in a subtree are the
   * right on its top and the rights on the boundaries inside it. That is a set the size of the
   * grants, however many sensors the subtree holds, and `resolveManyFor` resolves it, so this
   * cannot disagree with that method about any one object.
   *
   * An administrator short-circuits, as in `resolve`, and nothing is walked.
   */
  async resolveSubtreesFor(
    principal: AccessPrincipal,
    objectIds: readonly number[],
    q: Queryable = this.#db,
  ): Promise<Map<number, SubtreeAccess>> {
    const result = new Map<number, SubtreeAccess>();
    if (objectIds.length === 0) return result;

    const admin = await q.query<{ admin: boolean }>(`SELECT ${administers('$1')} AS admin`, [
      principal.userId,
    ]);
    if (admin[0]?.admin === true) {
      const right = ceilingFor(principal, 'full');
      for (const id of objectIds) result.set(id, { own: right, weakest: right });
      return result;
    }

    const inside = await q.query<{ top: string; boundary: string }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT id AS top, id, 0 AS depth FROM object WHERE id = ANY($2::bigint[])

        UNION ALL

        SELECT subtree.top, c.id, subtree.depth + 1
        FROM object c
        JOIN subtree ON c.parent_id = subtree.id
        WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT DISTINCT s.top::text AS top, s.id::text AS boundary
      FROM subtree s
      WHERE s.depth > 0 AND s.id = ANY(${boundariesOf('$1')})
      `,
      [principal.userId, [...objectIds]],
    );

    const beneath = new Map<number, number[]>();
    const asked = new Set<number>(objectIds);
    for (const row of inside) {
      const top = Number(row.top);
      const boundary = Number(row.boundary);
      beneath.set(top, [...(beneath.get(top) ?? []), boundary]);
      asked.add(boundary);
    }

    const rights = await this.resolveManyFor(principal, [...asked], q);
    for (const id of objectIds) {
      const own = rights.get(id) ?? 'none';
      let weakest = own;
      for (const boundary of beneath.get(id) ?? []) {
        weakest = lower(weakest, rights.get(boundary) ?? 'none');
      }
      result.set(id, { own, weakest });
    }
    return result;
  }

  /**
   * Throws unless the principal holds this right on the object and on everything beneath it
   * (`A-35`).
   *
   * **The refusal says that there is something, and never what or how much** (`A-16`). It names
   * no object, no count and no right: whether the hole is `none` or `read` would tell the caller
   * which objects there are to find.
   */
  async requireSubtreeFor(
    principal: AccessPrincipal,
    objectId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<void> {
    const resolved = (await this.resolveSubtreesFor(principal, [objectId], q)).get(objectId);
    if (resolved !== undefined && atLeast(resolved.weakest, needed)) return;
    throw new AuthError(
      'AUTH_FORBIDDEN',
      `this action needs ${needed} on everything beneath that object, and this account does not hold it on all of it`,
      { objectId, needed, reach: 'subtree' },
    );
  }

  /**
   * What this principal may see of the tree, for a list query or a stream (`A-12`).
   *
   * **One query, and the rights in it are `resolveMany`'s** — the same text, from `rightsOf` —
   * applied to the principal's boundaries and then capped exactly as `resolveManyFor` caps them.
   * So a list filtered by the answer and a single object resolved by `resolveFor` cannot
   * disagree about a right; the only thing the answer adds is where each right holds, which is
   * structure, and `Visibility` documents why that is safe.
   *
   * **An administrator short-circuits, as in `resolve`** — "may see everything, including what
   * does not exist yet" is not a set of boundaries — but still carries the epoch, because an
   * administrator's stream has to notice being removed from the administrators' group.
   */
  async visibilityFor(principal: AccessPrincipal, q: Queryable = this.#db): Promise<Visibility> {
    const rows = await q.query<{
      admin: boolean;
      epoch: string;
      object_id: string | null;
      right_: AccessRight | null;
      is_root: boolean | null;
    }>(
      `SELECT ${administers('$1')} AS admin,
              (SELECT value::text FROM access_epoch) AS epoch,
              rights.root_id::text AS object_id,
              rights.right_,
              o.parent_id IS NULL AS is_root
       FROM (SELECT 1) AS one
       LEFT JOIN (${rightsOf('$1', boundariesOf('$1'))}) AS rights ON true
       LEFT JOIN object o ON o.id = rights.root_id`,
      [principal.userId],
    );

    const first = rows[0];
    const epoch = first === undefined ? null : Number(first.epoch);
    if (first?.admin === true) {
      return atLeast(ceilingFor(principal, 'full'), 'read')
        ? Visibility.everything(epoch)
        : Visibility.nothing(epoch);
    }

    const boundaries = new Map<number, boolean>();
    let rootSees = false;
    for (const row of rows) {
      if (row.object_id === null || row.right_ === null) continue;
      const sees = atLeast(ceilingFor(principal, row.right_), 'read');
      boundaries.set(Number(row.object_id), sees);
      if (row.is_root === true) rootSees = sees;
    }
    return Visibility.of(boundaries, rootSees, epoch);
  }

  /**
   * The root's id, read once: migration 001 seeds exactly one root and nothing replaces it.
   *
   * For a route whose answer is about the whole installation (`INSTALLATION`, `A-12`).
   */
  async rootId(q: Queryable = this.#db): Promise<number> {
    if (this.#rootId !== undefined) return this.#rootId;
    const rows = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM object WHERE parent_id IS NULL`,
    );
    const id = Number(rows[0]?.id);
    if (!Number.isInteger(id)) throw new AuthError('AUTH_FORBIDDEN', 'the object tree has no root');
    this.#rootId = id;
    return id;
  }

  /** The current `access_epoch`, for a stream deciding whether its visibility went stale. */
  async epoch(q: Queryable = this.#db): Promise<number> {
    const rows = await q.query<{ value: string }>('SELECT value::text AS value FROM access_epoch');
    return Number(rows[0]?.value ?? 0);
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

  /**
   * Grants a group a right on an object, replacing any it held: granting twice is a correction.
   *
   * **Audited in the grant's own transaction** (`A-17`), with what the group held here before, so
   * "who gave that group `full` on this branch?" has an answer, and a grant that fails leaves no
   * entry describing it. The entry carries the object's id and so appears in that object's history
   * beside its edits.
   *
   * The group is read rather than its foreign key caught: the entry needs its name and what it held
   * here, and the check that it exists is that same row. A missing object is still caught at the
   * insert, which is the last statement before the transaction rolls back.
   */
  async grant(
    objectId: number,
    groupId: number,
    right: AccessRight,
    actor: Actor,
    now = new Date(),
  ): Promise<void> {
    const missing = (cause: string): AuthError =>
      new AuthError('ACCESS_TARGET_MISSING', 'no such object or group', {
        objectId,
        groupId,
        cause,
      });
    await this.#db.tx(async (q) => {
      const found = await q.query<{ name: string; right_: AccessRight | null }>(
        `SELECT g.name, a.right_ FROM user_group g
         LEFT JOIN object_access a ON a.group_id = g.id AND a.object_id = $1
         WHERE g.id = $2`,
        [objectId, groupId],
      );
      const group = found[0];
      if (group === undefined) throw missing('no such group');
      try {
        await q.query(
          `INSERT INTO object_access (object_id, group_id, right_, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (object_id, group_id)
           DO UPDATE SET right_ = EXCLUDED.right_, granted_by = EXCLUDED.granted_by,
                         granted_at = now()`,
          [objectId, groupId, right, grantedByLabel(actor)],
        );
      } catch (error: unknown) {
        throw missing(error instanceof Error ? error.message.slice(0, 200) : 'unknown');
      }
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'grant.set',
            objectId,
            subject: { kind: 'object', id: objectId },
            groupId,
            groupName: group.name,
            before: group.right_,
            after: right,
          },
        ],
        now,
      );
    });
    this.#logger.info({ objectId, groupId, right, actor }, 'access granted');
  }

  /**
   * Removes an explicit grant, so the object falls back to what it inherits.
   *
   * Not the same as granting `none`: revoking restores inheritance, while `none` *overrides* it.
   * An administrator needs both — one to undo a mistake, the other to carve a hole in a branch
   * somebody else has access to. Audited as a grant is; a revoke that found nothing to take writes
   * no entry, because nothing changed.
   */
  async revoke(
    objectId: number,
    groupId: number,
    actor: Actor,
    now = new Date(),
  ): Promise<boolean> {
    return this.#db.tx(async (q) => {
      const rows = await q.query<{ right_: AccessRight; name: string }>(
        `DELETE FROM object_access a USING user_group g
         WHERE a.object_id = $1 AND a.group_id = $2 AND g.id = a.group_id
         RETURNING a.right_, g.name`,
        [objectId, groupId],
      );
      const removed = rows[0];
      if (removed === undefined) return false;
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'grant.revoked',
            objectId,
            subject: { kind: 'object', id: objectId },
            groupId,
            groupName: removed.name,
            before: removed.right_,
          },
        ],
        now,
      );
      return true;
    });
  }
}

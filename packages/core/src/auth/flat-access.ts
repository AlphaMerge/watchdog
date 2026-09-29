import type { Queryable } from '../db/pool.js';
import type { Actor, AuditSink, GrantSubject, Mutation } from '../objects/audit.js';
import type { AccountRole } from './accounts.js';
import { atLeast, cappedBy, grantedByLabel, lower, type AccessRight } from './access.js';

/**
 * Who may do what to a thing that is not in the object tree: a map, a report, a library (`L-01`).
 *
 * **Access to these is flat.** `object_access` walks ancestors because objects nest; a map, a
 * report and a library do not, so a grant on one is a grant on it and nothing else. `§9` grants
 * access to "tree, libraries, maps and reports" per group, and every one of the three answers the
 * same questions the same way — which is why they are answered here once.
 *
 * **Extracted at the third copy, and not before.** `MapService` and `ReportService` each carried
 * these rules line for line: the administrator short-circuit, the two ceilings, the creator's
 * grant, the grant SQL. `V2-17` records why two copies were left alone — the third instance is
 * the one that says which half varies — and libraries are that instance. What varies turned out
 * to be the error each entity throws and nothing else, so the rules live here and each service
 * keeps its own error class.
 *
 * The ceilings (`A-04`, `A-06`) and the ranking come from `auth/access.ts`, and so does the
 * `access_right` enum the grant tables share (migration 033). Nothing here decides what a right
 * *means*; it decides who holds one.
 */

/** Who is asking. Every flat entity's viewer is this, under its own name. */
export interface FlatViewer {
  readonly userId: number;
  readonly role: AccountRole;
  /** A token's ceiling, where the request presented one (`A-06`). */
  readonly scope?: AccessRight;
}

/** One group's grant, as the access routes answer it. */
export interface FlatGrant {
  groupId: number;
  groupName: string;
  right: AccessRight;
  grantedAt: Date;
  grantedBy: string;
}

/**
 * Where one kind of entity keeps its grants.
 *
 * **A closed set of literals, never a string from anywhere else.** These are interpolated into
 * SQL as identifiers, which is safe only because the type admits exactly the tables that exist; a
 * `string` here would be one refactor away from an injection. `subject` is also the entity's own
 * table, which `nameTaken` reads.
 */
export type GrantTable =
  | { readonly table: 'map_access'; readonly key: 'map_id'; readonly subject: 'map' }
  | { readonly table: 'report_access'; readonly key: 'report_id'; readonly subject: 'report' }
  | { readonly table: 'library_access'; readonly key: 'library_id'; readonly subject: 'library' };

/** Which rows of an entity a viewer may list: all of them, or those granted to these groups. */
export type ListScope =
  { readonly all: true } | { readonly all: false; readonly groupIds: number[] };

/**
 * What a held right means for a request needing another.
 *
 * **`invisible` before `forbidden`, always.** A caller who cannot read the thing must learn
 * nothing about it — not even that it exists — so every entity answers that case as it answers a
 * missing row. Only a caller who *can* see it is told they may not change it.
 */
export type Verdict = 'ok' | 'invisible' | 'forbidden';

export function verdict(held: AccessRight, needed: AccessRight): Verdict {
  if (!atLeast(held, 'read')) return 'invisible';
  return atLeast(held, needed) ? 'ok' : 'forbidden';
}

/**
 * The most this viewer could hold on anything: the role's ceiling, lowered by a token's scope.
 *
 * What `A-14` checks before creating one — a new entity has no grant to cap, so the ceilings are
 * the whole of the check.
 */
export function ceilingOf(viewer: FlatViewer): AccessRight {
  const role = cappedBy(viewer.role, 'full');
  return viewer.scope === undefined ? role : lower(role, viewer.scope);
}

/**
 * The condition a listing puts on each row: some group of the viewer's grants it anything.
 *
 * A function rather than a method so a repository can write its own listing with it, and the rule
 * about what makes a row visible still lives here.
 *
 * **`EXISTS` rather than a join with `DISTINCT`.** A row granted to two of the viewer's groups
 * joins twice, and de-duplicating afterwards forces every ordering expression into the select
 * list — which is how `ORDER BY lower(name)` became a syntax error in `G-01` and then an ordering
 * nobody meant.
 *
 * @param idColumn the listed row's id, qualified — `m.id`. Written by the caller's own SQL.
 * @param groupsParam the placeholder holding the group ids — `$1`.
 */
export function grantedTo(grants: GrantTable, idColumn: string, groupsParam: string): string {
  return `EXISTS (
      SELECT 1 FROM ${grants.table} a
      WHERE a.${grants.key} = ${idColumn} AND a.group_id = ANY(${groupsParam}::bigint[])
        AND a.right_ <> 'none'
    )`;
}

export class FlatAccess {
  readonly #grants: GrantTable;
  readonly #audit: AuditSink;

  /**
   * @param audit where every grant change is recorded, in the caller's transaction (`A-17`).
   *   Required, and here rather than in each service, so that the one place granting is written
   *   is the one place it is audited — three services each remembering to record it is how three
   *   services forgot to.
   */
  constructor(grants: GrantTable, audit: AuditSink) {
    this.#grants = grants;
    this.#audit = audit;
  }

  /**
   * What this viewer holds on this one.
   *
   * **A member of any administrator group short-circuits the lookup**, exactly as `AccessService`
   * does for objects: "may do anything, including to things that do not exist yet" is not a grant
   * and must not depend on a row, or an installation locks itself out by deleting one.
   *
   * **Two ceilings after that, and both only lower.** The account's role caps what its groups
   * granted (`A-04`), and a token's scope caps its owner (`A-06`). A read-only account in a group
   * holding `full` still holds `read`.
   */
  async rightFor(viewer: FlatViewer, id: number, q: Queryable): Promise<AccessRight> {
    const granted = (await this.#isAdmin(viewer.userId, q))
      ? 'full'
      : await this.#granted(q, id, await this.#groupsOf(viewer.userId, q));
    const afterRole = cappedBy(viewer.role, granted);
    return viewer.scope === undefined ? afterRole : lower(afterRole, viewer.scope);
  }

  /** Which rows this viewer may list. Administrators list every one. */
  async listScope(viewer: FlatViewer, q: Queryable): Promise<ListScope> {
    if (await this.#isAdmin(viewer.userId, q)) return { all: true };
    return { all: false, groupIds: await this.#groupsOf(viewer.userId, q) };
  }

  /**
   * Whether another one this viewer can read already has this name (`L-06`).
   *
   * **Unique among what the viewer can read, not across the installation.** A name unique
   * everywhere made the refusal an oracle: a writer on one branch learned what another branch's
   * maps, reports and libraries were called by trying names. Two groups may now each have a "Core
   * Network", and an administrator, who reads both, tells them apart by id.
   *
   * **Serialised per name** by a transaction-scoped advisory lock on (kind, `lower(name)`), taken
   * before the question is asked. No unique index stops two concurrent creates any more, and
   * without the lock both would ask, both be told no, and both insert. The lock is held until the
   * caller's transaction ends, so the second asks after the first has committed — and under READ
   * COMMITTED each statement sees what committed before it began. The two-key form, so it cannot
   * meet the single-key locks the tree and the housekeeper take.
   *
   * @param q the caller's transaction, which the lock lasts as long as.
   * @param exceptId the one being renamed, which does not clash with itself.
   */
  async nameTaken(
    q: Queryable,
    viewer: FlatViewer,
    name: string,
    exceptId: number | null,
  ): Promise<boolean> {
    const { subject } = this.#grants;
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext(lower($2)))`, [
      `ms:${subject}-name`,
      name,
    ]);
    const scope = await this.listScope(viewer, q);
    const visible = scope.all ? '' : `AND ${grantedTo(this.#grants, 'e.id', '$3')}`;
    const rows = await q.query<{ id: string }>(
      `SELECT e.id FROM ${subject} e
       WHERE lower(e.name) = lower($1) AND ($2::bigint IS NULL OR e.id <> $2) ${visible}
       LIMIT 1`,
      scope.all ? [name, exceptId] : [name, exceptId, scope.groupIds],
    );
    return rows.length > 0;
  }

  /**
   * Whether this viewer is acting as an administrator (`A-13`).
   *
   * **Asked of the groups, as `rightFor` asks it**, not of the role: removing somebody from the
   * administrators group has to end this along with everything else it confers. The role needs no
   * check of its own, because migration 034 refuses a read-only account in an administrator group
   * at the database. The token does: one below `full` is not an administrator's authority,
   * whoever holds it, which is the bar `ADMIN` sets for a route.
   */
  async administers(viewer: FlatViewer, q: Queryable): Promise<boolean> {
    if (viewer.scope !== undefined && viewer.scope !== 'full') return false;
    return this.#isAdmin(viewer.userId, q);
  }

  /**
   * Grants a new one's creator `full` through their primary group, in the caller's transaction.
   *
   * **Otherwise the creator cannot see what they just made.** Access is per group and a new one
   * has no grants, so a non-administrator would create it and immediately lose it — the kind of
   * thing a user finds rather than a test. An account in no group gets no grant, and what it made
   * is visible to administrators alone.
   *
   * @returns the group granted, when there was one.
   */
  async grantCreator(
    q: Queryable,
    id: number,
    viewer: FlatViewer,
    actor: Actor,
    now = new Date(),
  ): Promise<number | undefined> {
    const primary = await q.query<{ group_id: string; name: string }>(
      `SELECT m.group_id, g.name FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 ORDER BY m.is_primary DESC, m.group_id LIMIT 1`,
      [viewer.userId],
    );
    const row = primary[0];
    if (row === undefined) return undefined;
    const groupId = Number(row.group_id);
    await this.#upsert(q, id, groupId, 'full', actor);
    // Audited like any other grant: it is one, and it is the grant that decides who can see a
    // new thing at all.
    await this.#record(q, actor, now, {
      action: 'grant.set',
      objectId: null,
      subject: this.#subject(id),
      groupId,
      groupName: row.name,
      before: null,
      after: 'full',
    });
    return groupId;
  }

  async grants(q: Queryable, id: number): Promise<FlatGrant[]> {
    const { table, key } = this.#grants;
    const rows = await q.query<{
      group_id: string;
      name: string;
      right_: AccessRight;
      granted_at: Date;
      granted_by: string;
    }>(
      `SELECT a.group_id, g.name, a.right_, a.granted_at, a.granted_by
       FROM ${table} a JOIN user_group g ON g.id = a.group_id
       WHERE a.${key} = $1 ORDER BY lower(g.name)`,
      [id],
    );
    return rows.map((row) => ({
      groupId: Number(row.group_id),
      groupName: row.name,
      right: row.right_,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
    }));
  }

  /**
   * Grants a group a right, replacing any it held: granting twice is a correction, not a clash.
   *
   * **The group is checked rather than the foreign key caught**: a violation inside a transaction
   * aborts it, and every statement after that fails for the wrong reason.
   */
  async grant(
    q: Queryable,
    id: number,
    groupId: number,
    right: AccessRight,
    actor: Actor,
    now = new Date(),
  ): Promise<'granted' | 'no-such-group'> {
    const { table, key } = this.#grants;
    // The group and what it held here, in one read: the audit entry needs both, and the check
    // that the group exists is this same row.
    const found = await q.query<{ name: string; right_: AccessRight | null }>(
      `SELECT g.name, a.right_ FROM user_group g
       LEFT JOIN ${table} a ON a.group_id = g.id AND a.${key} = $1
       WHERE g.id = $2`,
      [id, groupId],
    );
    const group = found[0];
    if (group === undefined) return 'no-such-group';
    await this.#upsert(q, id, groupId, right, actor);
    await this.#record(q, actor, now, {
      action: 'grant.set',
      objectId: null,
      subject: this.#subject(id),
      groupId,
      groupName: group.name,
      before: group.right_,
      after: right,
    });
    return 'granted';
  }

  /**
   * Takes a group's grant away. False when it held none, which is not an error — and writes no
   * audit entry, because nothing changed.
   */
  async revoke(
    q: Queryable,
    id: number,
    groupId: number,
    actor: Actor,
    now = new Date(),
  ): Promise<boolean> {
    const { table, key } = this.#grants;
    const rows = await q.query<{ right_: AccessRight; name: string }>(
      `DELETE FROM ${table} a USING user_group g
       WHERE a.${key} = $1 AND a.group_id = $2 AND g.id = a.group_id
       RETURNING a.right_, g.name`,
      [id, groupId],
    );
    const removed = rows[0];
    if (removed === undefined) return false;
    await this.#record(q, actor, now, {
      action: 'grant.revoked',
      objectId: null,
      subject: this.#subject(id),
      groupId,
      groupName: removed.name,
      before: removed.right_,
    });
    return true;
  }

  #subject(id: number): GrantSubject {
    return { kind: this.#grants.subject, id };
  }

  async #record(q: Queryable, actor: Actor, now: Date, mutation: Mutation): Promise<void> {
    await this.#audit.record(q, actor, [mutation], now);
  }

  async #upsert(
    q: Queryable,
    id: number,
    groupId: number,
    right: AccessRight,
    actor: Actor,
  ): Promise<void> {
    const { table, key } = this.#grants;
    await q.query(
      `INSERT INTO ${table} (${key}, group_id, right_, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (${key}, group_id)
       DO UPDATE SET right_ = EXCLUDED.right_, granted_at = now(), granted_by = EXCLUDED.granted_by`,
      [id, groupId, right, grantedByLabel(actor)],
    );
  }

  /**
   * The highest right any of these groups holds here, or `none`.
   *
   * `access_rank` comes from migration 033 so the ordering is the one `object_access` already
   * uses — `max()` over the text would sort the rights alphabetically, which is wrong in every
   * position.
   */
  async #granted(q: Queryable, id: number, groupIds: readonly number[]): Promise<AccessRight> {
    if (groupIds.length === 0) return 'none';
    const { table, key } = this.#grants;
    const rows = await q.query<{ right_: AccessRight | null }>(
      `SELECT right_ FROM ${table}
       WHERE ${key} = $1 AND group_id = ANY($2::bigint[])
       ORDER BY access_rank(right_) DESC LIMIT 1`,
      [id, groupIds],
    );
    return rows[0]?.right_ ?? 'none';
  }

  async #isAdmin(userId: number, q: Queryable): Promise<boolean> {
    const rows = await q.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.is_admin`,
      [userId],
    );
    return Number(rows[0]?.total ?? 0) > 0;
  }

  async #groupsOf(userId: number, q: Queryable): Promise<number[]> {
    const rows = await q.query<{ group_id: string }>(
      `SELECT group_id FROM user_group_member WHERE user_id = $1`,
      [userId],
    );
    return rows.map((row) => Number(row.group_id));
  }
}

import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { Actor, AuditSink, GroupAudit, GroupRef, Mutation } from '../objects/audit.js';
import { AuthError } from './errors.js';

/**
 * User groups (`A-02`).
 *
 * **Groups exist so that rights are not granted per person.** `A-03` hangs per-object access
 * off a group rather than an account, because an installation with forty operators and six
 * hundred devices cannot be administered one grant at a time — and because a right attached to
 * a person has to be reissued when somebody else joins the rota, while a right attached to a
 * group is one somebody is added to.
 *
 * **The primary group is the *default* one, not the strongest one.** It answers exactly one
 * question — which group owns an object this user creates — and nothing else. What a user may
 * see and change is the union of all their groups, because any other rule would make *adding*
 * somebody to a group able to take access away, which is the opposite of what an administrator
 * expects when they do it.
 */

export interface UserGroup {
  id: number;
  name: string;
  description: string;
  isAdmin: boolean;
  isDefault: boolean;
  isBuiltin: boolean;
  memberCount: number;
}

export interface GroupMembership {
  groupId: number;
  name: string;
  isAdmin: boolean;
  isPrimary: boolean;
}

export interface GroupServiceOptions {
  db: Database;
  /**
   * Where every change to a group and its members is recorded, in the change's own transaction
   * (`A-18`). Required: adding an account to an administrator group is the largest escalation this
   * system has, and it went unrecorded from `A-02` until a sink was impossible to leave out.
   */
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

export class GroupService {
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: GroupServiceOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'groups' });
    this.#now = options.now ?? ((): Date => new Date());
  }

  async create(
    request: {
      name: string;
      description?: string;
      isAdmin?: boolean;
    },
    actor: Actor,
  ): Promise<UserGroup> {
    const name = request.name.trim();
    if (name === '' || name.length > 100) {
      throw new AuthError('GROUP_INVALID', 'a group name must be between 1 and 100 characters');
    }
    try {
      const group = await this.#db.tx(async (q) => {
        const rows = await q.query<GroupRow>(
          `INSERT INTO user_group (name, description, is_admin)
           VALUES ($1, $2, $3)
           RETURNING ${COLUMNS}, 0::bigint AS member_count`,
          [name, request.description ?? '', request.isAdmin ?? false],
        );
        const row = rows[0];
        if (row === undefined) throw new AuthError('GROUP_INVALID', 'the group was not created');
        const created = read(row);
        await this.#record(q, actor, [
          { action: 'group.created', objectId: null, groupId: created.id, after: auditOf(created) },
        ]);
        return created;
      });
      this.#logger.info({ name, isAdmin: request.isAdmin ?? false }, 'group created');
      return group;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AuthError('GROUP_EXISTS', `a group named ${name} already exists`);
      }
      throw error;
    }
  }

  async list(): Promise<UserGroup[]> {
    const rows = await this.#db.query<GroupRow>(
      `SELECT ${COLUMNS},
              (SELECT count(*) FROM user_group_member m WHERE m.group_id = g.id) AS member_count
       FROM user_group g
       ORDER BY g.is_builtin DESC, lower(g.name)`,
    );
    return rows.map(read);
  }

  async get(id: number): Promise<UserGroup | null> {
    const rows = await this.#db.query<GroupRow>(
      `SELECT ${COLUMNS},
              (SELECT count(*) FROM user_group_member m WHERE m.group_id = g.id) AS member_count
       FROM user_group g WHERE g.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  /**
   * Renames a group, describes it, or changes what it grants — audited with before and after
   * (`A-18`). Turning `isAdmin` on makes every member an administrator at once, which is why the
   * flag is in the diff. An update that changed nothing writes nothing.
   */
  async update(
    id: number,
    request: { name?: string; description?: string; isAdmin?: boolean },
    actor: Actor,
  ): Promise<UserGroup> {
    return this.#db.tx(async (q) => this.#update(q, id, request, actor));
  }

  async #update(
    q: Queryable,
    id: number,
    request: { name?: string; description?: string; isAdmin?: boolean },
    actor: Actor,
  ): Promise<UserGroup> {
    const existing = await locked(q, id);
    if (existing === null) throw new AuthError('GROUP_NOT_FOUND', `no group with id ${String(id)}`);

    // **A built-in group may be described, never renamed or re-privileged.** Renaming
    // "Administrators" or clearing its admin flag is a one-way door out of your own
    // installation, and the description is the only part of it nobody can lock themselves out
    // with.
    if (existing.isBuiltin && (request.name !== undefined || request.isAdmin !== undefined)) {
      throw new AuthError(
        'GROUP_BUILTIN',
        `${existing.name} is a built-in group; only its description can be changed`,
      );
    }

    const rows = await q.query<GroupRow>(
      `UPDATE user_group g
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           is_admin = COALESCE($4, is_admin),
           updated_at = now()
       WHERE g.id = $1
       RETURNING ${COLUMNS},
                 (SELECT count(*) FROM user_group_member m WHERE m.group_id = g.id) AS member_count`,
      [id, request.name ?? null, request.description ?? null, request.isAdmin ?? null],
    );
    const row = rows[0];
    if (row === undefined) throw new AuthError('GROUP_NOT_FOUND', `no group with id ${String(id)}`);
    const updated = read(row);
    const before = auditOf(existing);
    const after = auditOf(updated);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await this.#record(q, actor, [
        { action: 'group.updated', objectId: null, groupId: id, before, after },
      ]);
    }
    return updated;
  }

  async delete(id: number, actor: Actor): Promise<void> {
    const name = await this.#db.tx(async (q) => {
      const existing = await locked(q, id);
      if (existing === null) {
        throw new AuthError('GROUP_NOT_FOUND', `no group with id ${String(id)}`);
      }
      if (existing.isBuiltin) {
        throw new AuthError(
          'GROUP_BUILTIN',
          `${existing.name} is a built-in group and cannot be deleted`,
        );
      }

      // **Members are not deleted with the group**, and their primary group has to survive it.
      // The cascade removes the membership rows; anybody whose *primary* group this was is given
      // one back, or they would be a member of groups with no default among them.
      const members = await q.query<{ user_id: string; login: string; is_primary: boolean }>(
        `SELECT m.user_id::text AS user_id, a.login, m.is_primary
         FROM user_group_member m JOIN user_account a ON a.id = m.user_id
         WHERE m.group_id = $1
         ORDER BY lower(a.login)`,
        [id],
      );
      await q.query(`DELETE FROM user_group WHERE id = $1`, [id]);

      // The members by login, because the cascade has just taken the rows that said who they were
      // (`A-18`); and each primary group the repair handed out, because that decides who owns what
      // they create next.
      const mutations: Mutation[] = [
        {
          action: 'group.deleted',
          objectId: null,
          groupId: id,
          before: auditOf(existing),
          members: members.map((member) => member.login),
        },
      ];
      const gone: GroupRef = { groupId: id, groupName: existing.name };
      for (const member of members.filter((one) => one.is_primary)) {
        const userId = Number(member.user_id);
        const next = await this.#repairPrimary(q, userId);
        if (next !== null) {
          mutations.push({
            action: 'group.primarySet',
            objectId: null,
            accountId: userId,
            login: member.login,
            before: gone,
            after: next,
          });
        }
      }
      await this.#record(q, actor, mutations);
      return existing.name;
    });
    this.#logger.info({ groupId: id, name }, 'group deleted');
  }

  /** Every group this user belongs to, primary first. */
  async membershipsOf(userId: number): Promise<GroupMembership[]> {
    const rows = await this.#db.query<{
      group_id: string;
      name: string;
      is_admin: boolean;
      is_primary: boolean;
    }>(
      `SELECT g.id::text AS group_id, g.name, g.is_admin, m.is_primary
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1
       ORDER BY m.is_primary DESC, lower(g.name)`,
      [userId],
    );
    return rows.map((row) => ({
      groupId: Number(row.group_id),
      name: row.name,
      isAdmin: row.is_admin,
      isPrimary: row.is_primary,
    }));
  }

  async membersOf(
    groupId: number,
  ): Promise<{ userId: number; login: string; isPrimary: boolean }[]> {
    const rows = await this.#db.query<{ user_id: string; login: string; is_primary: boolean }>(
      `SELECT m.user_id::text AS user_id, a.login, m.is_primary
       FROM user_group_member m JOIN user_account a ON a.id = m.user_id
       WHERE m.group_id = $1
       ORDER BY lower(a.login)`,
      [groupId],
    );
    return rows.map((row) => ({
      userId: Number(row.user_id),
      login: row.login,
      isPrimary: row.is_primary,
    }));
  }

  /**
   * Adds a user to a group.
   *
   * **The first group anybody joins becomes their primary one**, because a user with groups and
   * no primary among them is a state nothing else in the system is prepared for — object
   * ownership would have nothing to answer with.
   *
   * **Audited in the same transaction** (`A-18`), and the entry says whether the group administers
   * the installation — adding somebody to one is the largest escalation this system has, and the
   * person reading the log later should not need to know which group ids confer it. Adding a
   * member who is already there changes nothing and writes nothing, unless it moves their primary
   * group, which is then recorded as that.
   */
  async addMember(groupId: number, userId: number, actor: Actor, primary = false): Promise<void> {
    await this.#db.tx(async (q) => {
      const found = await q.query<{
        name: string;
        is_admin: boolean;
        login: string;
        member: boolean;
        is_primary: boolean;
      }>(
        `SELECT g.name, g.is_admin, a.login,
                m.user_id IS NOT NULL AS member, COALESCE(m.is_primary, false) AS is_primary
         FROM user_group g
         CROSS JOIN user_account a
         LEFT JOIN user_group_member m ON m.group_id = g.id AND m.user_id = a.id
         WHERE g.id = $1 AND a.id = $2`,
        [groupId, userId],
      );
      const subject = found[0];
      if (subject === undefined) throw new AuthError('GROUP_NOT_FOUND', 'no such group or account');
      const previous = await primaryOf(q, userId);
      const isFirst = !(await belongsAnywhere(q, userId));
      const shouldBePrimary = primary || isFirst;

      if (shouldBePrimary) {
        await q.query(`UPDATE user_group_member SET is_primary = false WHERE user_id = $1`, [
          userId,
        ]);
      }
      try {
        await q.query(
          `INSERT INTO user_group_member (group_id, user_id, is_primary)
           VALUES ($1, $2, $3)
           ON CONFLICT (group_id, user_id)
           DO UPDATE SET is_primary = user_group_member.is_primary OR EXCLUDED.is_primary`,
          [groupId, userId, shouldBePrimary],
        );
      } catch (error: unknown) {
        if (isForeignKeyViolation(error)) {
          throw new AuthError('GROUP_NOT_FOUND', 'no such group or account');
        }
        // **A read-only account may not join a group that administers the installation**
        // (`A-04`). Refused rather than quietly promoted or quietly ignored: an account somebody
        // believes is read-only that administers everything is a silent, total failure.
        if (isReadonlyAdminViolation(error)) {
          throw new AuthError(
            'ACCOUNT_READONLY_ADMIN',
            'that account is read-only and cannot join a group that administers the installation',
            { groupId, userId },
          );
        }
        throw error;
      }

      const here: GroupRef = { groupId, groupName: subject.name };
      if (!subject.member) {
        await this.#record(q, actor, [
          {
            action: 'group.memberAdded',
            objectId: null,
            groupId,
            groupName: subject.name,
            administers: subject.is_admin,
            accountId: userId,
            login: subject.login,
            primary: shouldBePrimary,
          },
        ]);
      } else if (shouldBePrimary && !subject.is_primary) {
        await this.#record(q, actor, [
          {
            action: 'group.primarySet',
            objectId: null,
            accountId: userId,
            login: subject.login,
            before: previous,
            after: here,
          },
        ]);
      }
    });
  }

  /**
   * Removes a user from a group, and never leaves them without a primary one.
   *
   * The last membership can go: an account belonging to no group is a real state — it is what a
   * suspended operator looks like — and it simply has no rights beyond its account role.
   */
  async removeMember(groupId: number, userId: number, actor: Actor): Promise<void> {
    await this.#db.tx(async (q) => {
      const removed = await q.query<{
        is_primary: boolean;
        name: string;
        is_admin: boolean;
        login: string;
      }>(
        `WITH removed AS (
           DELETE FROM user_group_member WHERE group_id = $1 AND user_id = $2
           RETURNING group_id, user_id, is_primary
         )
         SELECT removed.is_primary, g.name, g.is_admin, a.login
         FROM removed
         JOIN user_group g ON g.id = removed.group_id
         JOIN user_account a ON a.id = removed.user_id`,
        [groupId, userId],
      );
      const gone = removed[0];
      // Not a member: nothing changed, so nothing is recorded (`A-18`).
      if (gone === undefined) return;

      const mutations: Mutation[] = [
        {
          action: 'group.memberRemoved',
          objectId: null,
          groupId,
          groupName: gone.name,
          administers: gone.is_admin,
          accountId: userId,
          login: gone.login,
          wasPrimary: gone.is_primary,
        },
      ];
      if (gone.is_primary) {
        const next = await this.#repairPrimary(q, userId);
        if (next !== null) {
          mutations.push({
            action: 'group.primarySet',
            objectId: null,
            accountId: userId,
            login: gone.login,
            before: { groupId, groupName: gone.name },
            after: next,
          });
        }
      }
      await this.#record(q, actor, mutations);
    });
  }

  /** Makes one of a user's existing groups their primary one. Audited when it moves (`A-18`). */
  async setPrimary(groupId: number, userId: number, actor: Actor): Promise<void> {
    await this.#db.tx(async (q) => {
      const rows = await q.query<{ name: string; is_primary: boolean; login: string }>(
        `SELECT g.name, m.is_primary, a.login
         FROM user_group_member m
         JOIN user_group g ON g.id = m.group_id
         JOIN user_account a ON a.id = m.user_id
         WHERE m.group_id = $1 AND m.user_id = $2`,
        [groupId, userId],
      );
      const membership = rows[0];
      if (membership === undefined) {
        // The rule the schema cannot express: a primary group has to be one they are in.
        throw new AuthError(
          'GROUP_NOT_MEMBER',
          'a primary group must be one this account already belongs to',
        );
      }
      if (membership.is_primary) return;
      const previous = await primaryOf(q, userId);
      await q.query(`UPDATE user_group_member SET is_primary = false WHERE user_id = $1`, [userId]);
      await q.query(
        `UPDATE user_group_member SET is_primary = true WHERE user_id = $1 AND group_id = $2`,
        [userId, groupId],
      );
      await this.#record(q, actor, [
        {
          action: 'group.primarySet',
          objectId: null,
          accountId: userId,
          login: membership.login,
          before: previous,
          after: { groupId, groupName: membership.name },
        },
      ]);
    });
  }

  /** The group a new account joins when nobody says otherwise. */
  async defaultGroup(): Promise<UserGroup | null> {
    const rows = await this.#db.query<GroupRow>(
      `SELECT ${COLUMNS},
              (SELECT count(*) FROM user_group_member m WHERE m.group_id = g.id) AS member_count
       FROM user_group g WHERE g.is_default`,
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  /**
   * Whether this account is in any group that administers the installation.
   *
   * **Asked of the groups, not of the account's role.** `A-01`'s role says what an account is
   * allowed to be; this says what its memberships currently grant, and the two are deliberately
   * separate — removing somebody from the administrators group has to take effect without
   * anybody remembering to change their role as well.
   */
  async administers(userId: number): Promise<boolean> {
    const rows = await this.#db.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM user_group_member m JOIN user_group g ON g.id = m.group_id
       WHERE m.user_id = $1 AND g.is_admin`,
      [userId],
    );
    return Number(rows[0]?.total ?? 0) > 0;
  }

  async #record(q: Queryable, actor: Actor, mutations: readonly Mutation[]): Promise<void> {
    await this.#audit.record(q, actor, mutations, this.#now());
  }

  /**
   * Gives a user a primary group when they have groups but none is marked, and says which it gave
   * — or null, when it gave none because they have no group left or already had a primary one.
   */
  async #repairPrimary(q: Queryable, userId: number): Promise<GroupRef | null> {
    const repaired = await q.query<{ group_id: string }>(
      `UPDATE user_group_member SET is_primary = true
       WHERE user_id = $1
         AND group_id = (
           SELECT m.group_id FROM user_group_member m
           JOIN user_group g ON g.id = m.group_id
           WHERE m.user_id = $1
           ORDER BY lower(g.name)
           LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_group_member p WHERE p.user_id = $1 AND p.is_primary
         )
       RETURNING group_id::text AS group_id`,
      [userId],
    );
    return repaired[0] === undefined ? null : primaryOf(q, userId);
  }
}

/** A group's row, locked for the change about to be made to it, so its `before` is the real one. */
async function locked(q: Queryable, id: number): Promise<UserGroup | null> {
  const rows = await q.query<GroupRow>(
    `SELECT ${COLUMNS},
            (SELECT count(*) FROM user_group_member m WHERE m.group_id = g.id) AS member_count
     FROM user_group g WHERE g.id = $1
     FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : read(row);
}

/** The group a user's creations belong to now, or null when they have none. */
async function primaryOf(q: Queryable, userId: number): Promise<GroupRef | null> {
  const rows = await q.query<{ group_id: string; name: string }>(
    `SELECT g.id::text AS group_id, g.name
     FROM user_group_member m JOIN user_group g ON g.id = m.group_id
     WHERE m.user_id = $1 AND m.is_primary`,
    [userId],
  );
  const row = rows[0];
  return row === undefined ? null : { groupId: Number(row.group_id), groupName: row.name };
}

async function belongsAnywhere(q: Queryable, userId: number): Promise<boolean> {
  const rows = await q.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM user_group_member WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

function auditOf(group: UserGroup): GroupAudit {
  return { name: group.name, description: group.description, isAdmin: group.isAdmin };
}

/**
 * Unqualified on purpose: this is used in an `INSERT … RETURNING`, which has no table alias to
 * qualify against. Every other query putting it after `FROM user_group g` has a single table in
 * scope, so the bare names resolve there too.
 */
const COLUMNS = `id, name, description, is_admin, is_default, is_builtin`;

interface GroupRow {
  id: string | number;
  name: string;
  description: string;
  is_admin: boolean;
  is_default: boolean;
  is_builtin: boolean;
  member_count: string | number;
}

function read(row: GroupRow): UserGroup {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    isAdmin: row.is_admin,
    isDefault: row.is_default,
    isBuiltin: row.is_builtin,
    memberCount: Number(row.member_count),
  };
}

/** `A-04`'s trigger, seen through the pool's wrapper. Matched on state *and* sentence. */
function isReadonlyAdminViolation(error: unknown): boolean {
  return (
    sqlstateOf(error) === '23514' &&
    error instanceof Error &&
    error.message.includes('cannot be in a group that administers')
  );
}

function isUniqueViolation(error: unknown): boolean {
  return sqlstateOf(error) === '23505';
}

function isForeignKeyViolation(error: unknown): boolean {
  return sqlstateOf(error) === '23503';
}

/** The pool wraps driver errors, carrying SQLSTATE in `context` rather than on the error. */
function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('context' in error) {
    const context = (error as { context?: Record<string, unknown> }).context;
    const state = context?.['sqlstate'];
    if (typeof state === 'string') return state;
  }
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return undefined;
}

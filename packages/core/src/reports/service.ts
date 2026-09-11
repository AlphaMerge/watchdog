import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { atLeast, cappedBy, type AccessRight } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import { ReportError, changedUnderneath, invisible, reportNotFound } from './errors.js';
import {
  isReportKind,
  type ReportGrant,
  type ReportKind,
  type ReportOutputs,
  type ReportRepository,
  type ReportRow,
  type ReportSchedule,
  type ReportSpan,
  type ReportSubjects,
} from './repository.js';

/**
 * What a caller may do with a report, and every write that changes one (`E-01`).
 *
 * **Access is resolved here and nowhere else**, the same rule `CLAUDE.md` states for inheritance
 * and `MapService` already follows. `E-08`'s scheduler will be the second caller and it has no
 * principal at all, which is exactly the situation that makes a second copy of these rules drift.
 *
 * **The security context is this service's own responsibility, not the repository's.** Migration
 * 047 stores an id and a login; deciding that a context must name a real account at the moment it
 * is written, and that losing that account is a readable state rather than a silent widening, is
 * policy. `E-03` adds the half that refuses to *run*; this is the half that refuses to *store*
 * nonsense.
 */

export interface ReportViewer {
  readonly userId: number;
  readonly role: AccountRole;
  /** A token's ceiling, where the request presented one (`A-06`). */
  readonly scope?: AccessRight;
}

export interface ReportServiceOptions {
  readonly db: Database;
  readonly repository: ReportRepository;
  readonly logger: Logger;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;
/**
 * A report covering everything is a report nobody reads and a query nobody bounded.
 *
 * Chosen the way `G-02`'s widget ceiling was: high enough that no real report meets it, low
 * enough that a caller cannot turn one request into a scan of the installation.
 */
const MAX_SUBJECTS = 500;

export interface ReportInput {
  readonly name: string;
  readonly description?: string;
  readonly kind: string;
  readonly subjects?: ReportSubjects;
  readonly span?: ReportSpan;
  readonly outputs?: ReportOutputs;
  readonly schedule?: ReportSchedule;
  /** The login whose visibility this report renders through (`§6`). */
  readonly runAs?: string;
}

export class ReportService {
  readonly #db: Database;
  readonly #repository: ReportRepository;
  readonly #logger: Logger;

  constructor(options: ReportServiceOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#logger = options.logger.child({ component: 'reports' });
  }

  /**
   * What this viewer may do with this report.
   *
   * A member of any administrator group short-circuits the lookup, as `AccessService` does for
   * objects: "may do anything" must not depend on a row, or an installation locks itself out by
   * deleting one. Two ceilings after that and both only lower — the account's role caps what its
   * groups granted (`A-04`), and a token's scope caps its owner (`A-06`).
   */
  async rightFor(
    viewer: ReportViewer,
    reportId: number,
    q: Queryable = this.#db,
  ): Promise<AccessRight> {
    const granted = (await this.#isAdmin(viewer.userId, q))
      ? 'full'
      : await this.#repository.rightFor(q, reportId, await this.#groupsOf(viewer.userId, q));

    const afterRole = cappedBy(viewer.role, granted);
    return viewer.scope === undefined ? afterRole : lowerOf(afterRole, viewer.scope);
  }

  /** Throws unless the viewer holds at least this right; an unreadable report reads as absent. */
  async require(
    viewer: ReportViewer,
    reportId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<ReportRow> {
    return (await this.withRight(viewer, reportId, needed, q)).report;
  }

  /** The report, and what this viewer holds on it — resolved once rather than twice. */
  async withRight(
    viewer: ReportViewer,
    reportId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<{ report: ReportRow; right: AccessRight }> {
    const report = await this.#repository.find(q, reportId);
    if (report === undefined) throw reportNotFound(reportId);

    const held = await this.rightFor(viewer, reportId, q);
    // Absent rather than forbidden: see `invisible`.
    if (!atLeast(held, 'read')) throw invisible(reportId);
    if (!atLeast(held, needed)) {
      throw new ReportError(
        'REPORT_FORBIDDEN',
        `this account may not ${needed} report ${String(reportId)}`,
        { context: { reportId, phase: 'authorize' }, details: { held, needed } },
      );
    }
    return { report, right: held };
  }

  /** The reports this viewer may see. Administrators see all of them. */
  async list(viewer: ReportViewer): Promise<ReportRow[]> {
    if (await this.#isAdmin(viewer.userId, this.#db)) return this.#repository.list(this.#db);
    return this.#repository.listFor(this.#db, await this.#groupsOf(viewer.userId, this.#db));
  }

  async get(viewer: ReportViewer, id: number): Promise<ReportRow> {
    return this.require(viewer, id, 'read');
  }

  /**
   * Creates a report, and grants its creator's primary group `full` in the same transaction.
   *
   * Otherwise the creator cannot see what they just made: access is per group and a new report has
   * no grants, so a non-administrator would create one and immediately lose it.
   */
  async create(viewer: ReportViewer, input: ReportInput, actor: string): Promise<ReportRow> {
    const name = validName(input.name);
    const description = validDescription(input.description ?? '');
    const kind = validKind(input.kind);
    const subjects = validSubjects(input.subjects ?? { objectIds: [] });

    return this.#db.tx(async (tx) => {
      await this.#refuseDuplicateName(tx, name, null);
      const runAs = await this.#resolveContext(tx, input.runAs ?? actor, null);

      const report = await this.#repository.create(tx, {
        name,
        description,
        kind,
        subjects,
        span: input.span ?? { kind: 'month' },
        outputs: input.outputs ?? { formats: ['html'], delivery: 'store' },
        schedule: input.schedule ?? { kind: 'manual' },
        runAsUserId: runAs.userId,
        runAsLogin: runAs.login,
      });

      const primary = await tx.query<{ group_id: string }>(
        `SELECT group_id FROM user_group_member
         WHERE user_id = $1 ORDER BY is_primary DESC, group_id LIMIT 1`,
        [viewer.userId],
      );
      const groupId = primary[0]?.group_id;
      if (groupId !== undefined) {
        await this.#repository.grant(tx, report.id, Number(groupId), 'full', actor);
      }

      this.#logger.info(
        { reportId: report.id, name, kind, runAs: runAs.login, actor },
        'report created',
      );
      return report;
    });
  }

  /**
   * Updates a report, refusing when it has moved on since the caller read it.
   *
   * **Changing the security context needs `full`, not `write`.** Everything else here is editing a
   * document; that one field decides whose data the output contains, so it is the same class of
   * act as granting access and is gated the same way. A `write` holder can change what the report
   * measures and cannot change who it measures it as.
   */
  async update(
    viewer: ReportViewer,
    id: number,
    expectedVersion: number,
    patch: Partial<ReportInput>,
    actor: string,
  ): Promise<ReportRow> {
    return this.#db.tx(async (tx) => {
      const current = await this.require(viewer, id, 'write', tx);

      const next: {
        name?: string;
        description?: string;
        kind?: ReportKind;
        subjects?: ReportSubjects;
        span?: ReportSpan;
        outputs?: ReportOutputs;
        schedule?: ReportSchedule;
        runAs?: { userId: number | null; login: string };
      } = {};
      if (patch.name !== undefined) next.name = validName(patch.name);
      if (patch.description !== undefined) next.description = validDescription(patch.description);
      if (patch.kind !== undefined) next.kind = validKind(patch.kind);
      if (patch.subjects !== undefined) next.subjects = validSubjects(patch.subjects);
      if (patch.span !== undefined) next.span = patch.span;
      if (patch.outputs !== undefined) next.outputs = patch.outputs;
      if (patch.schedule !== undefined) next.schedule = patch.schedule;

      if (patch.runAs !== undefined && patch.runAs !== current.runAsLogin) {
        await this.require(viewer, id, 'full', tx);
        next.runAs = await this.#resolveContext(tx, patch.runAs, id);
      }

      if (next.name !== undefined && next.name.toLowerCase() !== current.name.toLowerCase()) {
        await this.#refuseDuplicateName(tx, next.name, id);
      }

      const updated = await this.#repository.update(tx, id, expectedVersion, next);
      if (updated === undefined) throw changedUnderneath(id, expectedVersion, current.version);

      this.#logger.info({ reportId: id, actor, version: updated.version }, 'report updated');
      return updated;
    });
  }

  /** Deleting needs `full`: a report is a grantable thing, and removing one removes its grants. */
  async remove(viewer: ReportViewer, id: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      const gone = await this.#repository.remove(tx, id);
      if (!gone) throw reportNotFound(id);
      this.#logger.warn({ reportId: id, actor }, 'report deleted');
    });
  }

  async grants(viewer: ReportViewer, id: number): Promise<ReportGrant[]> {
    await this.require(viewer, id, 'full');
    return this.#repository.grants(this.#db, id);
  }

  async grant(
    viewer: ReportViewer,
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
        throw new ReportError('REPORT_GROUP_NOT_FOUND', `there is no group ${String(groupId)}`, {
          context: { reportId: id, phase: 'grant' },
          details: { groupId },
        });
      }
      await this.#repository.grant(tx, id, groupId, right, actor);
      this.#logger.info({ reportId: id, groupId, right, actor }, 'report access granted');
    });
  }

  async revoke(viewer: ReportViewer, id: number, groupId: number, actor: string): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      await this.#repository.revoke(tx, id, groupId);
      this.#logger.info({ reportId: id, groupId, actor }, 'report access revoked');
    });
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Turns a login into a stored security context, refusing one that names nobody.
   *
   * **Refused at the write rather than at the run**, because the alternative is a report that
   * looks configured and fails on a schedule at 03:00 — and because the account has to exist for
   * the id to be worth storing at all. The login is snapshotted as the account spells it, not as
   * the caller typed it, so the two halves agree about case.
   */
  async #resolveContext(
    q: Queryable,
    login: string,
    reportId: number | null,
  ): Promise<{ userId: number; login: string }> {
    const trimmed = login.trim();
    if (trimmed === '') {
      throw new ReportError('REPORT_INVALID', 'a report needs an account to render through', {
        context: { ...(reportId === null ? {} : { reportId }), phase: 'context' },
      });
    }
    const account = await this.#repository.findAccount(q, trimmed);
    if (account === undefined) {
      throw new ReportError('REPORT_USER_NOT_FOUND', `there is no account "${trimmed}"`, {
        context: { ...(reportId === null ? {} : { reportId }), phase: 'context' },
        details: { runAs: trimmed },
      });
    }
    // The login as the *account* spells it, not as the caller typed it: the two halves of the
    // context have to agree about case, or the refusal message names something unfindable.
    return { userId: account.id, login: account.login };
  }

  async #refuseDuplicateName(q: Queryable, name: string, exceptId: number | null): Promise<void> {
    const clash = await q.query<{ id: string }>(
      `SELECT id FROM report WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2)`,
      [name, exceptId],
    );
    if (clash.length > 0) {
      throw new ReportError('REPORT_NAME_TAKEN', `a report called ${name} already exists`, {
        context: { ...(exceptId === null ? {} : { reportId: exceptId }), phase: 'name' },
        details: { name },
      });
    }
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

const ORDER: Readonly<Record<AccessRight, number>> = { none: 0, read: 1, write: 2, full: 3 };

function lowerOf(a: AccessRight, b: AccessRight): AccessRight {
  return ORDER[a] <= ORDER[b] ? a : b;
}

function validName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    throw new ReportError(
      'REPORT_INVALID',
      `a report name is 1 to ${String(MAX_NAME)} characters`,
      {
        context: { phase: 'validate' },
        details: { length: name.length },
      },
    );
  }
  return name;
}

function validDescription(raw: string): string {
  if (raw.length > MAX_DESCRIPTION) {
    throw new ReportError(
      'REPORT_INVALID',
      `a report description is at most ${String(MAX_DESCRIPTION)} characters`,
      { context: { phase: 'validate' }, details: { length: raw.length } },
    );
  }
  return raw;
}

function validKind(raw: string): ReportKind {
  if (!isReportKind(raw)) {
    throw new ReportError('REPORT_INVALID', `there is no report template called "${raw}"`, {
      context: { phase: 'validate' },
      details: { kind: raw },
    });
  }
  return raw;
}

/**
 * The object ids a report covers, deduplicated and bounded.
 *
 * **Not checked against `object`, deliberately.** The whole reason migration 047 stores a document
 * is that a subject can be deleted later; refusing an id that does not exist *now* would be a
 * guard that stops working the moment it matters, and would make restoring a backup out of order
 * fail. `E-04` renders a missing subject as a row that says so.
 */
function validSubjects(raw: ReportSubjects): ReportSubjects {
  // **`unknown`, not the declared type.** This value came off the wire or out of a jsonb column,
  // so `ReportSubjects` is a claim rather than a fact — and `Array.isArray` narrowing an already
  // typed value hands back `any[]`, which is precisely how an unchecked element walks through the
  // function whose whole job is checking elements.
  const ids: unknown = raw.objectIds;
  if (!Array.isArray(ids)) {
    throw new ReportError('REPORT_INVALID', 'a report covers a list of object ids', {
      context: { phase: 'validate' },
    });
  }
  const seen = new Set<number>();
  for (const id of ids as readonly unknown[]) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new ReportError('REPORT_INVALID', `"${JSON.stringify(id)}" is not an object id`, {
        context: { phase: 'validate' },
        details: { objectId: id },
      });
    }
    seen.add(id);
  }
  if (seen.size > MAX_SUBJECTS) {
    throw new ReportError(
      'REPORT_INVALID',
      `a report covers at most ${String(MAX_SUBJECTS)} objects`,
      { context: { phase: 'validate' }, details: { count: seen.size } },
    );
  }
  return { objectIds: [...seen] };
}

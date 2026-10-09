import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { atLeast, type AccessRight, type AccessService } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import type { ObjectKind } from '../objects/types.js';
import { ReportError, contextLost } from './errors.js';
import type { ReportRepository, ReportRow } from './repository.js';

/**
 * Whose eyes a report is rendered through (`E-03`, `CAPABILITIES.MD §6`).
 *
 * **This is an "act as" path, and the thing to prove is a negative.** A report contains what one
 * named account could see — not what the person who scheduled it could see, not what the process
 * running it could see, and above all not everything. The scheduler `E-08` adds has no session at
 * all, which is the situation that produces the classic failure: an absent principal read as "no
 * checks apply", and a nightly PDF that quietly contains the whole installation.
 *
 * Three things make that hard to write by accident.
 *
 * ## 1. A principal cannot be fabricated
 *
 * `ReportPrincipal` carries a brand no other module can produce, so the only way to obtain one is
 * `resolve()` — which is also the only place the refusals below are applied. A future caller
 * cannot pass `{ userId: 1, role: 'admin' }` to `subjectsFor` and skip them, because that object
 * does not typecheck. `MapAudience` learned the same lesson from `G-06` by naming its permissive
 * mode; here there is no permissive mode to name.
 *
 * ## 2. Two ways to lose a security context, and `E-01` only closed one
 *
 * Migration 047 nulls `run_as_user_id` when the account is deleted, and `E-01` refuses on that.
 * **A disabled account keeps its row**, so the reference stays valid and nothing in `E-01` would
 * have noticed — a report would go on rendering through a departed colleague's scope indefinitely.
 * Disabling is how this system revokes an account (031 says so: disabled rather than deleted, so
 * the audit trail survives), so ignoring it would make revocation not work for the one path that
 * runs unattended. Both now refuse with `REPORT_NO_CONTEXT`.
 *
 * A *locked* account is deliberately not refused. Lockout is `A-08`'s brute-force defence and is
 * transient — it says somebody is guessing that account's password, not that the account should
 * stop existing. Stopping a monthly report because of a lockout that clears in ten minutes would
 * be a denial of service anybody could trigger from the login form.
 *
 * ## 3. What a report cannot see, it cannot describe
 *
 * `subjectsFor` reports objects it will not render as bare ids and **does not say whether they are
 * missing or merely invisible**. That looks like lost operational detail and is the fix for a real
 * hole: a `write` holder on a report needs no access to the object tree, so a report that told the
 * two apart would be an existence oracle for every id in the installation — add ids, run it, read
 * which ones came back "forbidden" rather than "gone". The distinction is written to the log
 * instead, where only an administrator reads it.
 */

declare const runsAs: unique symbol;

export interface ReportPrincipal {
  /** Unforgeable outside this module; see the note above. Never read. */
  readonly [runsAs]: true;
  readonly userId: number;
  readonly role: AccountRole;
  readonly login: string;
  /**
   * **There is no `scope`, and its absence is the point.** `A-06`'s token ceiling belongs to a
   * credential presented on a request; a report is not a request and holds no token. Adding one
   * here would be inventing a ceiling nobody set.
   */
}

/** One object a report will render. Identity only — see below on why there is no `params`. */
export interface ReportSubject {
  readonly id: number;
  readonly kind: ObjectKind;
  readonly name: string;
}

export interface ResolvedSubjects {
  readonly principal: ReportPrincipal;
  /** In the order the author listed them, minus the ones this context cannot see. */
  readonly visible: readonly ReportSubject[];
  /**
   * Ids this report will not render, deleted and forbidden deliberately not told apart.
   *
   * **Reported rather than dropped.** A report that silently covers seven of the ten sensors it
   * names is the most durable way this system can tell a lie — `CLAUDE.md`'s "no-data is not zero"
   * applied to subjects rather than samples. `E-04` renders these as rows that say so.
   */
  readonly unavailable: readonly number[];
}

export interface ReportContextOptions {
  readonly db: Database;
  readonly repository: ReportRepository;
  /**
   * **The same `AccessService` the object API uses**, for the reason `G-10` gives about the map
   * resolver: a report must not become a second, more permissive way to read a sensor. Every rule
   * `A-03` and `A-04` encode — inheritance, explicit-beats-inherited, highest-across-groups, the
   * role ceiling — arrives here for free and cannot drift.
   */
  readonly access: AccessService;
  readonly logger: Logger;
}

export class ReportContext {
  readonly #db: Database;
  readonly #repository: ReportRepository;
  readonly #access: AccessService;
  readonly #logger: Logger;

  constructor(options: ReportContextOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#access = options.access;
    this.#logger = options.logger.child({ component: 'report-context' });
  }

  /**
   * The account a report renders through, or a refusal naming what was lost.
   *
   * Throws `REPORT_NO_CONTEXT` — a 422, because the request is understood and the report is real;
   * what is missing is the account, which no right the caller could hold would fix.
   */
  async resolve(report: ReportRow, q: Queryable = this.#db): Promise<ReportPrincipal> {
    if (report.runAsUserId === null) {
      this.#logger.warn(
        { reportId: report.id, runAs: report.runAsLogin, why: 'deleted' },
        'a report has no security context',
      );
      throw contextLost(report.id, report.runAsLogin);
    }

    const account = await this.#repository.findRunAs(q, report.runAsUserId);
    if (account === undefined) {
      // The row went between the read and here. Racy, and the refusal is the same one.
      this.#logger.warn(
        { reportId: report.id, runAs: report.runAsLogin, why: 'vanished' },
        'a report has no security context',
      );
      throw contextLost(report.id, report.runAsLogin);
    }
    if (account.disabled) {
      this.#logger.warn(
        { reportId: report.id, runAs: account.login, why: 'disabled' },
        'a report will not run: the account it renders through has been disabled',
      );
      throw new ReportError(
        'REPORT_NO_CONTEXT',
        `report ${String(report.id)} runs as "${account.login}", and that account is disabled`,
        {
          context: { reportId: report.id, phase: 'context' },
          details: { runAsLogin: account.login, reason: 'disabled' },
        },
      );
    }

    return {
      userId: account.id,
      role: account.role,
      login: account.login,
    } as ReportPrincipal;
  }

  /**
   * The objects this report will render, as its security context sees them.
   *
   * One `resolveManyFor` for the whole list rather than one per subject — five hundred subjects
   * must not be five hundred tree walks, and `MAX_SUBJECTS` exists so this stays one query.
   *
   * **Identity only, and there is no `params` field on purpose.** `CLAUDE.md` says credentials are
   * never returned by any route to anyone; the strongest form of that is a projection with nowhere
   * to put one. An installation report needs configuration and must get it from `ObjectService`,
   * whose `#redact` is the one boundary that strips `writeOnly` parameters — never from the
   * repository, and never by widening this shape.
   */
  async subjectsFor(report: ReportRow, q: Queryable = this.#db): Promise<ResolvedSubjects> {
    const principal = await this.resolve(report, q);
    const requested = report.subjects.objectIds;
    if (requested.length === 0) {
      return { principal, visible: [], unavailable: [] };
    }

    const rows = await q.query<{ id: string; kind: ObjectKind; name: string }>(
      `SELECT id::text AS id, kind, name FROM object WHERE id = ANY($1::bigint[])`,
      [[...requested]],
    );
    const found = new Map(rows.map((row) => [Number(row.id), row]));
    const rights = await this.#access.resolveManyFor(principal, requested, q);

    const visible: ReportSubject[] = [];
    const unavailable: number[] = [];
    let forbidden = 0;
    let gone = 0;

    for (const id of requested) {
      const row = found.get(id);
      if (row === undefined) {
        gone += 1;
        unavailable.push(id);
        continue;
      }
      if (!atLeast(rights.get(id) ?? 'none', 'read')) {
        forbidden += 1;
        unavailable.push(id);
        continue;
      }
      visible.push({ id, kind: row.kind, name: row.name });
    }

    if (unavailable.length > 0) {
      // **The one place the two are told apart**, and it is a log an administrator reads rather
      // than a field a report carries. See the block comment on the existence oracle.
      this.#logger.info(
        {
          reportId: report.id,
          runAs: principal.login,
          requested: requested.length,
          visible: visible.length,
          forbidden,
          gone,
        },
        'a report covers objects its security context cannot render',
      );
    }

    return { principal, visible, unavailable };
  }

  /** What this context may do with one object. For `E-04`, which reads more than a name. */
  async rightOn(
    principal: ReportPrincipal,
    objectId: number,
    q: Queryable = this.#db,
  ): Promise<AccessRight> {
    return (await this.#access.resolveFor(principal, objectId, q)).right;
  }
}

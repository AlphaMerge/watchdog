import type { Queryable } from '../db/pool.js';
import type { AccessRight } from '../auth/access.js';
import type { ReportSpan } from './span.js';

/**
 * Every statement a report needs, and nothing that decides anything (`E-01`).
 *
 * The same split `maps/repository.ts` keeps: SQL here, rights and audit in the service. The
 * idioms are deliberately identical where the question is identical — `EXISTS` rather than a
 * join for the visible-list, the version in the `WHERE` clause rather than checked first,
 * `access_rank` from migration 033 for "highest right held" — because two tables answering the
 * same question two ways is how one of them ends up wrong.
 */

/** The seven templates `CAPABILITIES.MD §6` lists, as migration 047's enum spells them. */
export const REPORT_KINDS = [
  'graph_and_table',
  'table_only',
  'graph_only',
  'sensor_list',
  'installation',
  'top_values',
  'top_uptime',
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value);
}

/**
 * What a report covers.
 *
 * A document rather than child rows, and migration 047 explains why at length: a sensor deleted
 * between scheduling and running must leave a reference that the renderer can report, rather than
 * vanishing from a document somebody reads months later. `E-04` is what turns a missing id into a
 * row that says so.
 */
export interface ReportSubjects {
  readonly objectIds: readonly number[];
}

/** Stubs until `E-08` and `E-09`. Stored, never interpreted here. */
export type ReportOutputs = Record<string, unknown>;
export type ReportSchedule = Record<string, unknown>;

export interface ReportRow {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly kind: ReportKind;
  readonly subjects: ReportSubjects;
  readonly span: ReportSpan;
  readonly outputs: ReportOutputs;
  readonly schedule: ReportSchedule;
  /**
   * The account this report renders through, and who that was.
   *
   * **Both halves, because either alone is a lie.** A null id with a login present is an account
   * that has been deleted — the report must refuse to run rather than run unscoped (`E-03`), and
   * an operator needs the name to put it back. See migration 047.
   */
  readonly runAsUserId: number | null;
  readonly runAsLogin: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReportGrant {
  readonly groupId: number;
  readonly groupName: string;
  readonly right: AccessRight;
  readonly grantedAt: Date;
  readonly grantedBy: string;
}

interface RawReport {
  id: string;
  name: string;
  description: string;
  kind: ReportKind;
  subjects: ReportSubjects;
  span: ReportSpan;
  outputs: ReportOutputs;
  schedule: ReportSchedule;
  run_as_user_id: string | null;
  run_as_login: string;
  version: string;
  created_at: Date;
  updated_at: Date;
}

function toReport(row: RawReport): ReportRow {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    kind: row.kind,
    subjects: row.subjects,
    span: row.span,
    outputs: row.outputs,
    schedule: row.schedule,
    // `bigint` arrives as text and `null` stays null — `Number(null)` is 0, which would name
    // account zero rather than saying there is none.
    runAsUserId: row.run_as_user_id === null ? null : Number(row.run_as_user_id),
    runAsLogin: row.run_as_login,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  'id, name, description, kind, subjects, span, outputs, schedule, ' +
  'run_as_user_id, run_as_login, version, created_at, updated_at';

export class ReportRepository {
  async list(q: Queryable): Promise<ReportRow[]> {
    const rows = await q.query<RawReport>(`SELECT ${COLUMNS} FROM report ORDER BY lower(name)`);
    return rows.map(toReport);
  }

  /**
   * The reports a set of groups may see.
   *
   * `EXISTS` rather than a join with `DISTINCT`, for the reason the map repository gives: a report
   * granted to two of the viewer's groups joins twice, and de-duplicating forces every ordering
   * expression into the select list.
   */
  async listFor(q: Queryable, groupIds: readonly number[]): Promise<ReportRow[]> {
    if (groupIds.length === 0) return [];
    const rows = await q.query<RawReport>(
      `SELECT ${COLUMNS} FROM report r
       WHERE EXISTS (
         SELECT 1 FROM report_access a
         WHERE a.report_id = r.id AND a.group_id = ANY($1::bigint[]) AND a.right_ <> 'none'
       )
       ORDER BY lower(r.name)`,
      [groupIds],
    );
    return rows.map(toReport);
  }

  async find(q: Queryable, id: number): Promise<ReportRow | undefined> {
    const rows = await q.query<RawReport>(`SELECT ${COLUMNS} FROM report WHERE id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? undefined : toReport(row);
  }

  async create(
    q: Queryable,
    input: {
      name: string;
      description: string;
      kind: ReportKind;
      subjects: ReportSubjects;
      span: ReportSpan;
      outputs: ReportOutputs;
      schedule: ReportSchedule;
      runAsUserId: number | null;
      runAsLogin: string;
    },
  ): Promise<ReportRow> {
    const rows = await q.query<RawReport>(
      `INSERT INTO report
         (name, description, kind, subjects, span, outputs, schedule, run_as_user_id, run_as_login)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        input.name,
        input.description,
        input.kind,
        JSON.stringify(input.subjects),
        JSON.stringify(input.span),
        JSON.stringify(input.outputs),
        JSON.stringify(input.schedule),
        input.runAsUserId,
        input.runAsLogin,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the insert returned no row');
    return toReport(row);
  }

  /**
   * Writes a report, refusing when it has moved on since the caller read it.
   *
   * The version is in the `WHERE` clause rather than compared first, so the zero-row result *is*
   * the conflict and there is no window between the read and the write.
   *
   * **`runAsUserId` cannot use `COALESCE`,** and that is the one place this differs from the map
   * repository in substance rather than in names: null is a meaningful value here — "the account
   * is gone" — so `COALESCE($n, run_as_user_id)` would make clearing it impossible and would
   * silently keep the old scope. A separate flag says whether the caller is setting it at all.
   */
  async update(
    q: Queryable,
    id: number,
    expectedVersion: number,
    patch: {
      name?: string;
      description?: string;
      kind?: ReportKind;
      subjects?: ReportSubjects;
      span?: ReportSpan;
      outputs?: ReportOutputs;
      schedule?: ReportSchedule;
      runAs?: { userId: number | null; login: string };
    },
  ): Promise<ReportRow | undefined> {
    const rows = await q.query<RawReport>(
      `UPDATE report SET
         name           = COALESCE($3, name),
         description    = COALESCE($4, description),
         kind           = COALESCE($5::report_kind, kind),
         subjects       = COALESCE($6::jsonb, subjects),
         span           = COALESCE($7::jsonb, span),
         outputs        = COALESCE($8::jsonb, outputs),
         schedule       = COALESCE($9::jsonb, schedule),
         run_as_user_id = CASE WHEN $10 THEN $11 ELSE run_as_user_id END,
         run_as_login   = CASE WHEN $10 THEN $12 ELSE run_as_login END,
         version        = version + 1
       WHERE id = $1 AND version = $2
       RETURNING ${COLUMNS}`,
      [
        id,
        expectedVersion,
        patch.name ?? null,
        patch.description ?? null,
        patch.kind ?? null,
        patch.subjects === undefined ? null : JSON.stringify(patch.subjects),
        patch.span === undefined ? null : JSON.stringify(patch.span),
        patch.outputs === undefined ? null : JSON.stringify(patch.outputs),
        patch.schedule === undefined ? null : JSON.stringify(patch.schedule),
        patch.runAs !== undefined,
        patch.runAs?.userId ?? null,
        patch.runAs?.login ?? '',
      ],
    );
    const row = rows[0];
    return row === undefined ? undefined : toReport(row);
  }

  async remove(q: Queryable, id: number): Promise<boolean> {
    const rows = await q.query<{ id: string }>(`DELETE FROM report WHERE id = $1 RETURNING id`, [
      id,
    ]);
    return rows.length > 0;
  }

  async grants(q: Queryable, reportId: number): Promise<ReportGrant[]> {
    const rows = await q.query<{
      group_id: string;
      name: string;
      right_: AccessRight;
      granted_at: Date;
      granted_by: string;
    }>(
      `SELECT a.group_id, g.name, a.right_, a.granted_at, a.granted_by
       FROM report_access a JOIN user_group g ON g.id = a.group_id
       WHERE a.report_id = $1 ORDER BY lower(g.name)`,
      [reportId],
    );
    return rows.map((row) => ({
      groupId: Number(row.group_id),
      groupName: row.name,
      right: row.right_,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
    }));
  }

  /** Upsert, because granting twice is a correction rather than an error. */
  async grant(
    q: Queryable,
    reportId: number,
    groupId: number,
    right: AccessRight,
    grantedBy: string,
  ): Promise<void> {
    await q.query(
      `INSERT INTO report_access (report_id, group_id, right_, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (report_id, group_id)
       DO UPDATE SET right_ = EXCLUDED.right_, granted_at = now(), granted_by = EXCLUDED.granted_by`,
      [reportId, groupId, right, grantedBy],
    );
  }

  async revoke(q: Queryable, reportId: number, groupId: number): Promise<boolean> {
    const rows = await q.query<{ report_id: string }>(
      `DELETE FROM report_access WHERE report_id = $1 AND group_id = $2 RETURNING report_id`,
      [reportId, groupId],
    );
    return rows.length > 0;
  }

  /**
   * The highest right any of these groups holds on this report.
   *
   * Flat, because reports do not nest. `access_rank` comes from migration 033 so the ordering is
   * the one `object_access` already uses — `max()` over the text would sort alphabetically, which
   * is wrong in every position.
   */
  async rightFor(
    q: Queryable,
    reportId: number,
    groupIds: readonly number[],
  ): Promise<AccessRight> {
    if (groupIds.length === 0) return 'none';
    const rows = await q.query<{ right_: AccessRight | null }>(
      `SELECT right_ FROM report_access
       WHERE report_id = $1 AND group_id = ANY($2::bigint[])
       ORDER BY access_rank(right_) DESC LIMIT 1`,
      [reportId, groupIds],
    );
    return rows[0]?.right_ ?? 'none';
  }

  /**
   * An account by login, for setting a report's security context.
   *
   * Folded, because `user_account` compares logins folded and a context set as `Alice` must be
   * the same account as one set as `alice` — otherwise a report renders through an account
   * nobody can find in the UI.
   */
  async findAccount(
    q: Queryable,
    login: string,
  ): Promise<{ id: number; login: string } | undefined> {
    const rows = await q.query<{ id: string; login: string }>(
      `SELECT id, login FROM user_account WHERE lower(login) = lower($1)`,
      [login],
    );
    const row = rows[0];
    return row === undefined ? undefined : { id: Number(row.id), login: row.login };
  }
}

import { createHash } from 'node:crypto';
import { describeError, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { DocumentMessage } from '../notifications/delivery/email.js';
import type { DeliveryResult } from '../notifications/delivery/transport.js';
import { renderCsv, renderHtml, type ReportDocument } from './table.js';
import { buildZip } from './zip.js';
import {
  keepsOutput,
  sendsEmail,
  validateOutputs,
  type ReportDeliveryMode,
  type ReportFormat,
  type ReportOutputs,
} from './outputs.js';
import type { ReportRow } from './repository.js';

/**
 * Storing a rendered report, and getting it to somebody (`E-09`, `ADR-005`).
 *
 * **The failure this ticket exists to design against has a rule already.** `CLAUDE.md` says one
 * outage, one alarm, and that backpressure is visible and never silent. A scheduled report that
 * cannot deliver must therefore do neither of the two obvious things: not retry forever into a
 * storm, and not give up quietly. So —
 *
 * - **One row, one state.** The attempt count and the error live on the run, so a relay that has
 *   been down for an hour is one report in `failed`, not sixty log lines and no record.
 * - **Bounded attempts with a growing delay**, and the delay is per report rather than global: a
 *   hundred reports queued behind one dead relay retry on their own schedules and stop on their
 *   own schedules.
 * - **A permanent rejection is not retried at all.** `N-07`'s transport already distinguishes an
 *   address the relay refused from a relay that timed out, which is exactly the distinction that
 *   decides whether waiting can help. Retrying the first is how a queue fills with mail nobody
 *   will ever receive.
 * - **Terminal means terminal.** A run that has exhausted its attempts stays `failed` until
 *   somebody acts. Nothing re-arms it on a timer, because a report that quietly succeeds three
 *   days late is worse than one an operator was told about.
 */

export interface StoredOutput {
  readonly id: number;
  readonly runId: number;
  readonly format: 'html' | 'csv' | 'zip';
  readonly filename: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: Date;
}

export interface StoredOutputBody extends StoredOutput {
  readonly body: Buffer;
}

interface RawOutput {
  id: string;
  run_id: string;
  format: 'html' | 'csv' | 'zip';
  filename: string;
  byte_size: number;
  sha256: string;
  created_at: Date;
  body?: Buffer;
}

function toOutput(row: RawOutput): StoredOutput {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    format: row.format,
    filename: row.filename,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

const META = 'id, run_id, format, filename, byte_size, sha256, created_at';

export class ReportOutputRepository {
  async store(
    q: Queryable,
    runId: number,
    output: { format: 'html' | 'csv' | 'zip'; filename: string; body: Buffer },
  ): Promise<StoredOutput> {
    const sha256 = createHash('sha256').update(output.body).digest('hex');
    const rows = await q.query<RawOutput>(
      `INSERT INTO report_output (run_id, format, filename, byte_size, sha256, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, format) DO UPDATE SET
         filename = EXCLUDED.filename, byte_size = EXCLUDED.byte_size,
         sha256 = EXCLUDED.sha256, body = EXCLUDED.body, created_at = now()
       RETURNING ${META}`,
      [runId, output.format, output.filename, output.body.length, sha256, output.body],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('storing a report output returned no row');
    return toOutput(row);
  }

  /** What a run produced, without the bytes — a listing must not read a megabyte a row. */
  async list(q: Queryable, runId: number): Promise<StoredOutput[]> {
    const rows = await q.query<RawOutput>(
      `SELECT ${META} FROM report_output WHERE run_id = $1 ORDER BY format`,
      [runId],
    );
    return rows.map(toOutput);
  }

  async read(q: Queryable, runId: number, format: string): Promise<StoredOutputBody | undefined> {
    const rows = await q.query<RawOutput>(
      `SELECT ${META}, body FROM report_output WHERE run_id = $1 AND format = $2`,
      [runId, format],
    );
    const row = rows[0];
    if (row === undefined || row.body === undefined) return undefined;
    return { ...toOutput(row), body: row.body };
  }

  async readAll(q: Queryable, runId: number): Promise<StoredOutputBody[]> {
    const rows = await q.query<RawOutput>(
      `SELECT ${META}, body FROM report_output WHERE run_id = $1 ORDER BY format`,
      [runId],
    );
    return rows
      .filter((row): row is RawOutput & { body: Buffer } => row.body !== undefined)
      .map((row) => ({ ...toOutput(row), body: row.body }));
  }

  /**
   * Every run's outputs in one query.
   *
   * A page of fifty runs must not be fifty round trips to say how big things are — the same
   * reasoning `G-10` applied to the map resolver's per-widget reads, and the same failure if it is
   * written the obvious way.
   */
  async listFor(q: Queryable, runIds: readonly number[]): Promise<Map<number, StoredOutput[]>> {
    const grouped = new Map<number, StoredOutput[]>();
    if (runIds.length === 0) return grouped;
    const rows = await q.query<RawOutput>(
      `SELECT ${META} FROM report_output WHERE run_id = ANY($1::bigint[]) ORDER BY run_id, format`,
      [[...runIds]],
    );
    for (const row of rows) {
      const output = toOutput(row);
      const held = grouped.get(output.runId);
      if (held === undefined) grouped.set(output.runId, [output]);
      else held.push(output);
    }
    return grouped;
  }

  /**
   * Deletes stored documents past their horizon (`E-10`, `ADR-005`).
   *
   * **A pending delivery is never pruned**, whatever its age. `E-09` treats missing bytes as a
   * permanent delivery failure — correctly, since there is nothing left to send — so retention
   * taking them out from under a queued report would be this system manufacturing the one failure
   * it cannot recover from. The bound on attempts means a pending run cannot be old anyway, which
   * makes the guard cheap as well as right.
   *
   * The run row survives: "this report ran on the 1st and produced 40 kB" is worth keeping long
   * after the 40 kB is not, which is why `E-10` has two horizons.
   */
  async pruneOlderThan(q: Queryable, olderThan: Date, limit: number): Promise<number> {
    const rows = await q.query<{ count: string }>(
      `WITH gone AS (
         DELETE FROM report_output
         WHERE id IN (
           SELECT o.id FROM report_output o
           JOIN report_run r ON r.id = o.run_id
           WHERE o.created_at < $1 AND r.delivery_state <> 'pending'
           ORDER BY o.id LIMIT $2
         )
         RETURNING 1
       )
       SELECT count(*) AS count FROM gone`,
      [olderThan, limit],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** `ADR-005` Decision 4: an email-only report keeps nothing once it has gone. */
  async discard(q: Queryable, runId: number): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `DELETE FROM report_output WHERE run_id = $1 RETURNING id`,
      [runId],
    );
    return rows.length;
  }
}

/* ------------------------------------------------------------------- rendering */

const MEDIA: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
};

export function mediaTypeOf(format: string): string {
  return MEDIA[format] ?? 'application/octet-stream';
}

/**
 * A filename a folder of these can be read and sorted by.
 *
 * The report's name and the period it covered, because those are the two facts somebody looking at
 * a directory listing needs and neither is recoverable from the other. Reduced to characters every
 * filesystem and every mail client agrees on: an operator's report title can hold anything, and a
 * colon alone makes a file unopenable on Windows.
 */
export function filenameFor(report: ReportRow, spanLabel: string, extension: string): string {
  const slug = (raw: string): string =>
    raw
      .replaceAll(/[^\w.-]+/gu, '-')
      .replaceAll(/-{2,}/gu, '-')
      .replace(/^-+|-+$/gu, '');
  const name = slug(report.name) || 'report';
  const period = slug(spanLabel);
  return `${[name, period].filter((part) => part !== '').join('_')}.${extension}`.slice(0, 200);
}

export interface RenderedOutput {
  readonly format: 'html' | 'csv' | 'zip';
  readonly filename: string;
  readonly body: Buffer;
}

/**
 * Every file this report's outputs document asks for.
 *
 * **The ZIP replaces the parts rather than joining them.** An email carrying both an archive and
 * the files it contains is twice the size and asks the recipient which one to open; `§6` calls
 * this "optional ZIP", singular. The parts are what goes into it.
 */
export function renderOutputs(
  report: ReportRow,
  document: ReportDocument,
  outputs: ReportOutputs,
  at: Date,
): RenderedOutput[] {
  const parts: RenderedOutput[] = outputs.formats.map((format: ReportFormat) => ({
    format,
    filename: filenameFor(report, document.window.label, format),
    body: Buffer.from(format === 'csv' ? renderCsv(document) : renderHtml(document), 'utf8'),
  }));

  if (!outputs.zip) return parts;
  return [
    {
      format: 'zip',
      filename: filenameFor(report, document.window.label, 'zip'),
      body: buildZip(
        parts.map((part) => ({ name: part.filename, content: part.body })),
        at,
      ),
    },
  ];
}

/* ------------------------------------------------------------------- delivery */

/**
 * How many times a delivery is attempted before it is somebody's problem.
 *
 * **Five, spread over roughly an hour and a half.** Enough to ride out a relay restart or a
 * network blip, which is what retrying is for; few enough that a relay which is genuinely down
 * becomes a visible failure inside the window an operator would notice anyway rather than a
 * report that keeps trying quietly for a day.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * How long to wait before attempt `n`, in milliseconds: 1, 5, 15, 45 minutes.
 *
 * Growing, because a relay that refused once will usually refuse again a second later and the only
 * thing a tight retry adds is load on something already struggling. Capped rather than doubling
 * forever: past three quarters of an hour the answer is a person, not another attempt.
 */
export function backoffMs(attempt: number): number {
  const minutes = [1, 5, 15, 45];
  return (minutes[Math.min(attempt, minutes.length - 1)] ?? 45) * 60_000;
}

export interface ReportDeliveryOptions {
  readonly db: Database;
  readonly outputs: ReportOutputRepository;
  /**
   * `N-07`'s transport — a report is an attachment, not a new channel.
   *
   * Typed by the one method this needs rather than by the class, so a test can supply a relay
   * that fails on demand without standing up SMTP.
   */
  readonly email: { sendDocument: (message: DocumentMessage) => Promise<DeliveryResult> };
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface DeliveryStats {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  /** Runs still waiting to be delivered. A gauge, and the "never silent" half of the rule. */
  readonly pending: number;
}

interface DueRun {
  id: string;
  report_id: string;
  span_label: string;
  delivery_attempts: number;
  name: string;
  outputs: unknown;
}

export class ReportDelivery {
  readonly #db: Database;
  readonly #outputs: ReportOutputRepository;
  readonly #email: ReportDeliveryOptions['email'];
  readonly #logger: Logger;
  readonly #now: () => Date;

  #sent = 0;
  #retried = 0;
  #failed = 0;
  #pending = 0;

  constructor(options: ReportDeliveryOptions) {
    this.#db = options.db;
    this.#outputs = options.outputs;
    this.#email = options.email;
    this.#logger = options.logger.child({ component: 'report-delivery' });
    this.#now = options.now ?? ((): Date => new Date());
  }

  stats(): DeliveryStats {
    return {
      sent: this.#sent,
      retried: this.#retried,
      failed: this.#failed,
      pending: this.#pending,
    };
  }

  /**
   * Stores what a run produced, and arms its delivery.
   *
   * **An email-only report is stored too**, and that is `ADR-005` Decision 4 rather than an
   * oversight: a delivery that fails is retried, a retry needs the bytes, and the alternatives are
   * re-rendering — minutes of work, and a *different document* once a rollup has moved underneath
   * it — or holding megabytes in memory across an outage that may last hours. The row is deleted
   * once it has gone.
   */
  async place(
    runId: number,
    report: ReportRow,
    document: ReportDocument,
    q: Queryable = this.#db,
  ): Promise<{ outputs: readonly StoredOutput[]; mode: ReportDeliveryMode }> {
    const outputs = validateOutputs(report.outputs);
    const rendered = renderOutputs(report, document, outputs, this.#now());

    const stored: StoredOutput[] = [];
    for (const file of rendered) {
      stored.push(await this.#outputs.store(q, runId, file));
    }

    if (sendsEmail(outputs.delivery)) {
      await q.query(
        // **This module's clock, not the database's.** `tick` compares `delivery_next_at` against
        // `this.#now()`, so writing it with SQL's `now()` would be a comparison between two
        // clocks — which is fine until they differ, and then nothing is ever due. The backoff
        // below has the same rule for the same reason.
        `UPDATE report_run SET delivery_state = 'pending', delivery_next_at = $2 WHERE id = $1`,
        [runId, this.#now()],
      );
    }
    return { outputs: stored, mode: outputs.delivery };
  }

  /**
   * Sends whatever is due, and records what happened to each.
   *
   * Never throws: this runs on a background sweep, and a timer that can reject takes the process
   * with it. One report's failure must not stop the next report's delivery.
   */
  async tick(limit = 10): Promise<number> {
    const now = this.#now();
    const due = await this.#db.query<DueRun>(
      `SELECT r.id, r.report_id, r.span_label, r.delivery_attempts, p.name, p.outputs
       FROM report_run r JOIN report p ON p.id = r.report_id
       WHERE r.delivery_state = 'pending' AND r.delivery_next_at <= $1
       ORDER BY r.delivery_next_at LIMIT $2`,
      [now.toISOString(), limit],
    );

    let delivered = 0;
    for (const row of due) {
      try {
        if (await this.#deliver(row)) delivered += 1;
      } catch (error) {
        // A delivery that failed *to record* must not stop the others. The row keeps its pending
        // state and its next-attempt time, so the following sweep picks it up again.
        this.#logger.error(
          { runId: Number(row.id), ...describeError(error) },
          'a report delivery could not be recorded',
        );
      }
    }

    this.#pending = await this.#countPending();
    return delivered;
  }

  async #countPending(): Promise<number> {
    const rows = await this.#db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM report_run WHERE delivery_state = 'pending'`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  async #deliver(row: DueRun): Promise<boolean> {
    const runId = Number(row.id);
    const outputs = validateOutputs(row.outputs);
    const files = await this.#outputs.readAll(this.#db, runId);

    if (files.length === 0) {
      // Reachable only if retention or a hand-edit removed the bytes underneath a pending
      // delivery. Permanent by definition — there is nothing to send and nothing to wait for.
      await this.#fail(runId, 'the rendered report is no longer stored', false, 0);
      return false;
    }

    const result = await this.#email.sendDocument({
      requestId: runId,
      subject: `${row.name} — ${row.span_label}`,
      body:
        `The attached report covers ${row.span_label}.\n\n` +
        'An empty value means no reading was recorded in that interval, not a reading of zero.\n',
      recipients: outputs.recipients,
      attachments: files.map((file) => ({
        filename: file.filename,
        contentType: mediaTypeOf(file.format),
        content: file.body,
      })),
    });

    if (result.ok) {
      await this.#db.query(
        `UPDATE report_run SET
           delivery_state = 'sent', delivered_at = $2, delivery_next_at = NULL,
           delivery_attempts = delivery_attempts + 1, delivery_error = ''
         WHERE id = $1`,
        [runId, this.#now()],
      );
      if (!keepsOutput(outputs.delivery)) await this.#outputs.discard(this.#db, runId);
      this.#sent += 1;
      this.#logger.info(
        { runId, reportId: Number(row.report_id), recipients: outputs.recipients.length },
        'a report was delivered',
      );
      return true;
    }

    await this.#fail(runId, result.error, result.retryable, row.delivery_attempts);
    return false;
  }

  async #fail(runId: number, error: string, retryable: boolean, attempts: number): Promise<void> {
    const next = attempts + 1;
    const giveUp = !retryable || next >= MAX_DELIVERY_ATTEMPTS;

    if (giveUp) {
      await this.#db.query(
        `UPDATE report_run SET
           delivery_state = 'failed', delivery_next_at = NULL,
           delivery_attempts = $2, delivery_error = $3
         WHERE id = $1`,
        [runId, next, error.slice(0, 1_000)],
      );
      this.#failed += 1;
      // **One line per report, at the moment it stops trying.** Not one per attempt: a relay that
      // has been down for an hour is one failed report, and a log that says so sixty times is how
      // the one that matters gets missed.
      this.#logger.error(
        { runId, attempts: next, retryable, error },
        'a report could not be delivered and will not be retried',
      );
      return;
    }

    const at = new Date(this.#now().getTime() + backoffMs(next - 1));
    await this.#db.query(
      `UPDATE report_run SET
         delivery_attempts = $2, delivery_error = $3, delivery_next_at = $4
       WHERE id = $1`,
      [runId, next, error.slice(0, 1_000), at],
    );
    this.#retried += 1;
    this.#logger.warn(
      { runId, attempt: next, nextAttemptAt: at, error },
      'a report delivery failed',
    );
  }
}

import { describeError, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { DatabaseError } from '../db/pool.js';
import { ScheduleRepository } from '../schedules/repository.js';
import { countCells, type ReportDocument } from './table.js';
import { nextReportRun, validateSchedule } from './cadence.js';
import { ReportError } from './errors.js';
import type { ReportRepository, ReportRow } from './repository.js';
import type { ReportRenderer } from './render.js';
import type { ReportDelivery } from './delivery.js';

/**
 * Running a report, on a schedule or on demand (`E-08`, `CAPABILITIES.MD §6`).
 *
 * **Two rules from `CLAUDE.md` decide the whole shape of this file.**
 *
 * *Nothing blocks the scheduler.* A report is the longest-running thing this system does — a
 * render walks every subject and reads a month of history for each — so it runs nowhere near the
 * timing wheel that dispatches checks. It runs on its own sweep, at most `MAX_CONCURRENT` at a
 * time, and a sweep that overruns is skipped rather than queued. The check path never waits on it
 * and never learns it exists.
 *
 * *Backpressure is visible, never silent.* Every refusal is counted and every run leaves a row.
 * A report that has failed every night for a week is a question an operator can ask the database,
 * not a thing they discover when somebody asks where the report is.
 *
 * ## The next run is booked before the render starts
 *
 * `D-07` arrived at this the same way and it is worth restating: booking afterwards means a render
 * that throws leaves the report due for ever, and the sweep retries the same failing report every
 * minute instead of once a month. The booking is the first write; the outcome is the last.
 *
 * ## One run at a time, and the database says so
 *
 * `report_run_active_idx` is a partial unique index. Two attempts to start the same report — a
 * double-clicked button, a sweep overlapping a manual run — race on an insert, and the loser is
 * told the report is already running. A code-level check would have a window between the look and
 * the insert exactly the width of a double-click.
 */

export type ReportRunState = 'running' | 'succeeded' | 'failed';
export type ReportRunTrigger = 'manual' | 'scheduled';

export interface ReportRun {
  readonly id: number;
  readonly reportId: number;
  readonly trigger: ReportRunTrigger;
  readonly requestedBy: string;
  readonly state: ReportRunState;
  readonly queuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly durationMs: number | null;
  /** The period it covered, as `E-02` labelled it. Empty until the span has been resolved. */
  readonly spanLabel: string;
  readonly sections: number | null;
  readonly unavailable: number | null;
  readonly cells: number | null;
  readonly errorCode: string;
  readonly errorMessage: string;
  /** Where the document went (`E-09`). */
  readonly delivery: {
    readonly state: 'none' | 'pending' | 'sent' | 'failed';
    readonly attempts: number;
    readonly error: string;
    readonly nextAttemptAt: Date | null;
    readonly deliveredAt: Date | null;
  };
}

interface RawRun {
  id: string;
  report_id: string;
  trigger: ReportRunTrigger;
  requested_by: string;
  state: ReportRunState;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  span_label: string;
  sections: number | null;
  unavailable: number | null;
  cells: number | null;
  error_code: string;
  error_message: string;
  delivery_state: 'none' | 'pending' | 'sent' | 'failed';
  delivery_attempts: number;
  delivery_error: string;
  delivery_next_at: Date | null;
  delivered_at: Date | null;
}

const RUN_COLUMNS =
  'id, report_id, trigger, requested_by, state, queued_at, started_at, finished_at, ' +
  'duration_ms, span_label, sections, unavailable, cells, error_code, error_message, ' +
  'delivery_state, delivery_attempts, delivery_error, delivery_next_at, delivered_at';

function toRun(row: RawRun): ReportRun {
  return {
    id: Number(row.id),
    reportId: Number(row.report_id),
    trigger: row.trigger,
    requestedBy: row.requested_by,
    state: row.state,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    spanLabel: row.span_label,
    sections: row.sections,
    unavailable: row.unavailable,
    cells: row.cells,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    delivery: {
      state: row.delivery_state,
      attempts: row.delivery_attempts,
      error: row.delivery_error,
      nextAttemptAt: row.delivery_next_at,
      deliveredAt: row.delivered_at,
    },
  };
}

export class ReportRunRepository {
  /**
   * Claims the one active slot for a report, or returns undefined because somebody else has it.
   *
   * The unique violation *is* the answer: see the block comment on why this is not a look followed
   * by an insert.
   */
  async claim(
    q: Queryable,
    reportId: number,
    trigger: ReportRunTrigger,
    requestedBy: string,
  ): Promise<ReportRun | undefined> {
    try {
      const rows = await q.query<RawRun>(
        `INSERT INTO report_run (report_id, trigger, requested_by, state, started_at)
         VALUES ($1, $2, $3, 'running', now())
         RETURNING ${RUN_COLUMNS}`,
        [reportId, trigger, requestedBy],
      );
      const row = rows[0];
      return row === undefined ? undefined : toRun(row);
    } catch (error) {
      // 23505 is unique_violation, and the constraint says which — `report_run_active_idx` is the
      // one this method races on, and any other unique violation here would be a different bug
      // that must not be reported as "already running". Switching on the SQLSTATE and the
      // constraint name rather than on message text, as `api/errors.ts` insists.
      if (
        error instanceof DatabaseError &&
        error.sqlstate === '23505' &&
        error.constraint === 'report_run_active_idx'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async finish(
    q: Queryable,
    runId: number,
    outcome:
      | {
          state: 'succeeded';
          spanLabel: string;
          sections: number;
          unavailable: number;
          cells: number;
        }
      | { state: 'failed'; spanLabel: string; code: string; message: string },
  ): Promise<void> {
    if (outcome.state === 'succeeded') {
      await q.query(
        `UPDATE report_run SET
           state = 'succeeded', finished_at = now(),
           duration_ms = (extract(epoch FROM now() - started_at) * 1000)::integer,
           span_label = $2, sections = $3, unavailable = $4, cells = $5
         WHERE id = $1`,
        [runId, outcome.spanLabel, outcome.sections, outcome.unavailable, outcome.cells],
      );
      return;
    }
    await q.query(
      `UPDATE report_run SET
         state = 'failed', finished_at = now(),
         duration_ms = (extract(epoch FROM now() - started_at) * 1000)::integer,
         span_label = $2, error_code = $3, error_message = $4
       WHERE id = $1`,
      // Truncated to the column's bound rather than allowed to violate it: a run that failed and
      // then failed to record why is the worst of both.
      [runId, outcome.spanLabel, outcome.code.slice(0, 64), outcome.message.slice(0, 1_000)],
    );
  }

  async list(q: Queryable, reportId: number, limit: number): Promise<ReportRun[]> {
    const rows = await q.query<RawRun>(
      `SELECT ${RUN_COLUMNS} FROM report_run
       WHERE report_id = $1 ORDER BY queued_at DESC, id DESC LIMIT $2`,
      [reportId, limit],
    );
    return rows.map(toRun);
  }

  async find(q: Queryable, runId: number): Promise<ReportRun | undefined> {
    const rows = await q.query<RawRun>(`SELECT ${RUN_COLUMNS} FROM report_run WHERE id = $1`, [
      runId,
    ]);
    const row = rows[0];
    return row === undefined ? undefined : toRun(row);
  }

  /**
   * Deletes run history past its horizon (`E-10`).
   *
   * **A run that is still running or still waiting to be delivered is never pruned**, whatever
   * `queued_at` says. Deleting a running row would free the partial unique index and let a second
   * render of the same report start beside the first; deleting a pending one would cascade its
   * output away and turn a queued delivery into a permanent failure. Both are this system
   * breaking something that was working, in the name of a bound that had all the time in the
   * world to wait one more pass.
   *
   * The cascade from `report_output` means the documents go with the run, so setting the run
   * horizon shorter than the document horizon simply makes the shorter one win.
   */
  async pruneOlderThan(q: Queryable, olderThan: Date, limit: number): Promise<number> {
    const rows = await q.query<{ count: string }>(
      `WITH gone AS (
         DELETE FROM report_run
         WHERE id IN (
           SELECT id FROM report_run
           WHERE queued_at < $1 AND state <> 'running' AND delivery_state <> 'pending'
           ORDER BY id LIMIT $2
         )
         RETURNING 1
       )
       SELECT count(*) AS count FROM gone`,
      [olderThan, limit],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Marks runs that were in flight when the core stopped.
   *
   * **Called once at startup, because `running` is a claim about a process that no longer exists.**
   * Without it the partial unique index keeps that report unrunnable for ever: every later attempt
   * collides with a row nothing will ever finish. Found by asking what a `kill -9` in the middle of
   * a render leaves behind — it leaves the report permanently stuck.
   */
  async reapAbandoned(q: Queryable): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `UPDATE report_run SET
         state = 'failed', finished_at = now(),
         error_code = 'REPORT_INTERRUPTED',
         error_message = 'the core stopped while this report was rendering'
       WHERE state = 'running'
       RETURNING id`,
    );
    return rows.length;
  }
}

export interface ReportRunnerOptions {
  readonly db: Database;
  readonly reports: ReportRepository;
  readonly runs: ReportRunRepository;
  readonly renderer: ReportRenderer;
  /**
   * Where the document goes (`E-09`). Optional, so a build with no reporting delivery still runs
   * and records — and so the `E-08` tests that predate it keep asserting what they were about.
   */
  readonly delivery?: ReportDelivery;
  readonly logger: Logger;
  /** Records that a report ran, for the audit log (`E-03` deferred this here). */
  readonly audit?: (event: ReportRanEvent) => Promise<void>;
  readonly now?: () => Date;
  readonly maxConcurrent?: number;
}

export interface ReportRanEvent {
  readonly reportId: number;
  readonly reportName: string;
  readonly runId: number;
  readonly trigger: ReportRunTrigger;
  readonly requestedBy: string;
  /** The account the report rendered through — the act-as fact that makes this auditable. */
  readonly runAs: string;
  readonly spanLabel: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly errorCode: string;
}

export interface ReportRunnerStats {
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Runs refused because the report was already running. Counted, never silent. */
  readonly rejectedBusy: number;
  /** Reports a sweep found due and did not start because the pool was full. */
  readonly deferred: number;
  readonly running: number;
}

/**
 * How many reports render at once.
 *
 * **Two, and the number is a bound rather than a target.** Each render is a long sequence of reads
 * against the same database that is serving live checks (`P-192` names it as the one competitor
 * that certainly reaches everything else), so the useful setting is "enough that a slow report does
 * not block a fast one, few enough that reports cannot become the load". Anything above this is a
 * claim about throughput, and `CLAUDE.md` wants a measurement before one — `P-203` is the ticket.
 */
const MAX_CONCURRENT = 2;

/** How far behind its booking a report may be and still run, rather than being skipped. */
const MAX_LATENESS_MS = 6 * 60 * 60 * 1_000;

export class ReportRunner {
  readonly #db: Database;
  readonly #reports: ReportRepository;
  readonly #runs: ReportRunRepository;
  readonly #renderer: ReportRenderer;
  readonly #delivery: ReportDelivery | undefined;
  readonly #logger: Logger;
  readonly #audit: ((event: ReportRanEvent) => Promise<void>) | undefined;
  readonly #now: () => Date;
  readonly #maxConcurrent: number;
  readonly #schedules = new ScheduleRepository();

  #started = 0;
  #succeeded = 0;
  #failed = 0;
  #rejectedBusy = 0;
  #deferred = 0;
  #running = 0;

  constructor(options: ReportRunnerOptions) {
    this.#db = options.db;
    this.#reports = options.reports;
    this.#runs = options.runs;
    this.#renderer = options.renderer;
    this.#delivery = options.delivery;
    this.#logger = options.logger.child({ component: 'report-runner' });
    this.#audit = options.audit;
    this.#now = options.now ?? ((): Date => new Date());
    this.#maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;
  }

  stats(): ReportRunnerStats {
    return {
      started: this.#started,
      succeeded: this.#succeeded,
      failed: this.#failed,
      rejectedBusy: this.#rejectedBusy,
      deferred: this.#deferred,
      running: this.#running,
    };
  }

  /** Clears runs abandoned by a core that stopped mid-render. Call once, at startup. */
  async recover(): Promise<number> {
    const reaped = await this.#runs.reapAbandoned(this.#db);
    if (reaped > 0) {
      this.#logger.warn({ reaped }, 'report runs were abandoned by a previous core');
    }
    return reaped;
  }

  /**
   * Runs a report now, or refuses because one is already in flight.
   *
   * Refusing rather than queueing: a report that takes minutes and a button somebody pressed six
   * times must not become six renders, and "it is already running" is a better answer than a queue
   * nobody asked for.
   */
  async runNow(report: ReportRow, requestedBy: string): Promise<ReportRun> {
    return this.#run(report, 'manual', requestedBy);
  }

  /**
   * Starts whatever is due, up to the concurrency bound.
   *
   * **The booking is written before the render**, so a render that throws does not leave the report
   * due for ever — the failure this file's block comment records from `D-07`.
   */
  async tick(): Promise<number> {
    const now = this.#now();
    const free = this.#maxConcurrent - this.#running;
    if (free <= 0) return 0;

    const due = await this.#db.query<{ id: string }>(
      `SELECT id FROM report
       WHERE next_run_at IS NOT NULL AND next_run_at <= $1
       ORDER BY next_run_at LIMIT $2`,
      [now.toISOString(), free + 1],
    );
    if (due.length > free) {
      // Counted rather than silent: a backlog of due reports is the shape of an installation that
      // has scheduled more than it can render, and nothing else would say so.
      this.#deferred += due.length - free;
    }

    let started = 0;
    for (const row of due.slice(0, free)) {
      const report = await this.#reports.find(this.#db, Number(row.id));
      if (report === undefined) continue;

      const booking = await this.#book(report, now);
      const late = now.getTime() - (report.nextRunAt?.getTime() ?? now.getTime());
      if (late > MAX_LATENESS_MS) {
        // **Skipped, and said out loud.** A core that was down for two days would otherwise run
        // every missed occurrence in a burst, each covering a period already covered by the next.
        // The booking has already moved on, so the next one is on time.
        this.#logger.warn(
          { reportId: report.id, lateMs: late, nextRunAt: booking },
          'a scheduled report was skipped for being too far behind',
        );
        continue;
      }

      await this.#run(report, 'scheduled', '').catch(() => {
        // `#run` records its own outcome and never rethrows for a render failure; this catches the
        // case where the *recording* failed, which must not stop the other due reports.
      });
      started += 1;
    }
    return started;
  }

  /** Re-books a report after an edit, so a changed schedule takes effect without waiting. */
  async reschedule(report: ReportRow, from: Date = this.#now()): Promise<Date | null> {
    return this.#book(report, from);
  }

  async #book(report: ReportRow, from: Date): Promise<Date | null> {
    let next: Date | null = null;
    try {
      const schedule = validateSchedule(report.schedule);
      const window =
        schedule.scheduleId === undefined
          ? undefined
          : ((await this.#schedules.get(this.#db, schedule.scheduleId))?.definition ?? undefined);
      next = nextReportRun(schedule, from, window);
    } catch (error) {
      // A schedule that cannot be read is a report that never runs, which is the safe direction —
      // but it must not be a silent one, and it must not stop the sweep.
      this.#logger.error(
        { reportId: report.id, ...describeError(error) },
        'a report schedule could not be read, so it will not run',
      );
    }
    await this.#db.query(`UPDATE report SET next_run_at = $2 WHERE id = $1`, [report.id, next]);
    return next;
  }

  async #run(
    report: ReportRow,
    trigger: ReportRunTrigger,
    requestedBy: string,
  ): Promise<ReportRun> {
    const claimed = await this.#runs.claim(this.#db, report.id, trigger, requestedBy);
    if (claimed === undefined) {
      this.#rejectedBusy += 1;
      throw new ReportError('REPORT_BUSY', `report ${String(report.id)} is already running`, {
        context: { reportId: report.id, phase: 'run' },
        details: { reportId: report.id },
      });
    }

    this.#started += 1;
    this.#running += 1;
    let spanLabel = '';
    let runAs = report.runAsLogin;
    try {
      let document: ReportDocument;
      try {
        document = await this.#renderer.build(report, this.#now());
      } catch (error) {
        const code = error instanceof ReportError ? error.code : 'REPORT_RENDER_FAILED';
        const message = error instanceof Error ? error.message : 'the render failed';
        await this.#runs.finish(this.#db, claimed.id, {
          state: 'failed',
          spanLabel,
          code,
          message,
        });
        this.#failed += 1;
        this.#logger.error(
          { reportId: report.id, runId: claimed.id, trigger, code, message },
          'a report failed to render',
        );
        await this.#record(
          report,
          claimed.id,
          trigger,
          requestedBy,
          runAs,
          spanLabel,
          'failed',
          code,
        );
        return (await this.#runs.find(this.#db, claimed.id)) ?? claimed;
      }

      spanLabel = document.window.label;
      runAs = document.runAs;

      // **Stored and armed before the run is marked succeeded**, so a run that says it worked has
      // its output. The reverse order would leave a succeeded run with nothing to download after a
      // crash between the two writes, which is the state that reads as data loss.
      try {
        await this.#delivery?.place(claimed.id, report, document);
      } catch (error) {
        const code = error instanceof ReportError ? error.code : 'REPORT_STORE_FAILED';
        const message = error instanceof Error ? error.message : 'the output could not be stored';
        await this.#runs.finish(this.#db, claimed.id, {
          state: 'failed',
          spanLabel,
          code,
          message,
        });
        this.#failed += 1;
        this.#logger.error(
          { reportId: report.id, runId: claimed.id, code, message },
          'a report rendered but its output could not be stored',
        );
        await this.#record(
          report,
          claimed.id,
          trigger,
          requestedBy,
          runAs,
          spanLabel,
          'failed',
          code,
        );
        return (await this.#runs.find(this.#db, claimed.id)) ?? claimed;
      }

      await this.#runs.finish(this.#db, claimed.id, {
        state: 'succeeded',
        spanLabel,
        sections: document.sections.length,
        unavailable: document.unavailable.length,
        cells: countCells(document.sections),
      });
      this.#succeeded += 1;
      await this.#db.query(
        `UPDATE report SET last_run_at = now(), last_run_id = $2 WHERE id = $1`,
        [report.id, claimed.id],
      );
      this.#logger.info(
        {
          reportId: report.id,
          runId: claimed.id,
          trigger,
          runAs,
          span: spanLabel,
          sections: document.sections.length,
        },
        'a report ran',
      );
      await this.#record(
        report,
        claimed.id,
        trigger,
        requestedBy,
        runAs,
        spanLabel,
        'succeeded',
        '',
      );
      return (await this.#runs.find(this.#db, claimed.id)) ?? claimed;
    } finally {
      this.#running -= 1;
    }
  }

  /**
   * Writes the audit row `E-03` deferred to this ticket.
   *
   * **An act-as that actually happened is the auditable event**, and until now nothing ran a
   * report so there was nothing to record. What is recorded is who asked and *whose visibility it
   * rendered through*, because those are different accounts and the second is the one that decides
   * what left the building.
   */
  async #record(
    report: ReportRow,
    runId: number,
    trigger: ReportRunTrigger,
    requestedBy: string,
    runAs: string,
    spanLabel: string,
    outcome: 'succeeded' | 'failed',
    errorCode: string,
  ): Promise<void> {
    if (this.#audit === undefined) return;
    try {
      await this.#audit({
        reportId: report.id,
        reportName: report.name,
        runId,
        trigger,
        requestedBy,
        runAs,
        spanLabel,
        outcome,
        errorCode,
      });
    } catch (error) {
      // An audit sink that is briefly unavailable must not turn a successful report into a failed
      // one; the run row is already written and is the operational record.
      this.#logger.error(
        { reportId: report.id, runId, ...describeError(error) },
        'a report ran but its audit entry could not be written',
      );
    }
  }
}

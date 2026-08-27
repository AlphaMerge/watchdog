import { parseIpRange, type SweepEnding, type SweepHost, type SweepJob } from '@ms/shared';
import type { Logger } from '@ms/shared';
import { DiscoveryError } from './errors.js';

/**
 * Discovery runs, from the core's side (`D-01`).
 *
 * **The core owns the cursor and the probe owns the pinging**, and that split is the whole
 * design. A sweep has to survive a probe restart, a reconnect and a core failover; the only
 * thing that survives all three is a row. So the probe reports how far it has got, the core
 * writes it, and a resume is the core sending back what it last wrote. Re-sweeping a few
 * addresses is free — the unique key on `(run_id, address)` makes a repeated host a no-op — so
 * the cursor is advanced *after* the hosts in the same message are stored, never before.
 *
 * **A run is assigned to a probe, not to whichever one is free.** Discovery is a
 * local-network job: the probe that can reach `10.0.0.0/24` is the one on that network, and
 * `WORKFLOW.MD §14` already says local-only checks belong to the probe that can see them.
 *
 * **Only one run per probe at a time.** Two sweeps from one probe would each stand down for the
 * other's traffic and for live checks, and the operator's mental model — "discovery is running"
 * — has no room for two. A second run queues.
 */

export interface DiscoveryRunRow {
  id: number;
  groupId: number;
  probeId: number;
  range: string;
  total: number;
  cursor: number;
  found: number;
  failed: number;
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  message: string;
  timeoutMs: number;
  concurrency: number;
  ratePerSecond: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * The slice of the database this service uses.
 *
 * Structural rather than the concrete `Database`, so the tests can drive it with a stub and so
 * nothing here can reach for a transaction or a listener it has no business with.
 */
interface Db {
  query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface DiscoveryServiceOptions {
  db: Db;
  logger: Logger;
  /** Sends a message to a connected probe. False when that probe is not connected. */
  dispatch: (probeId: number, message: DispatchMessage) => boolean;
}

/** Exactly what the probe endpoint's `sendSweep` takes, so there is one shape and no mapping. */
export type DispatchMessage = { kind: 'start'; job: SweepJob } | { kind: 'cancel'; runId: number };

export interface StartRequest {
  groupId: number;
  probeId: number;
  range: string;
  timeoutMs?: number;
  concurrency?: number;
  ratePerSecond?: number;
  createdBy?: number;
}

export class DiscoveryService {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #dispatch: DiscoveryServiceOptions['dispatch'];
  #started = 0;
  #resumed = 0;
  #hostsStored = 0;

  constructor(options: DiscoveryServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'discovery' });
    this.#dispatch = options.dispatch;
  }

  stats(): { started: number; resumed: number; hostsStored: number } {
    return { started: this.#started, resumed: this.#resumed, hostsStored: this.#hostsStored };
  }

  /**
   * Records a run and offers it to its probe.
   *
   * The range is parsed here as well as on the probe — not out of distrust, but because an
   * operator who typed a /8 should be told so while the form is still open, and because `total`
   * has to be right before a progress bar means anything.
   */
  async start(request: StartRequest): Promise<DiscoveryRunRow> {
    // Throws `IpRangeError` for anything unusable, which the API surfaces as a 400 with the
    // sentence the parser wrote rather than "invalid range".
    const range = parseIpRange(request.range);

    const rows = await this.#db.query<Record<string, unknown>>(
      `INSERT INTO discovery_run
         (group_id, probe_id, range_text, total, timeout_ms, concurrency, rate_per_second,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        request.groupId,
        request.probeId,
        range.text,
        range.size,
        request.timeoutMs ?? 1_000,
        request.concurrency ?? 32,
        request.ratePerSecond ?? 0,
        request.createdBy ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new DiscoveryError('DISCOVERY_FAILED', 'the run could not be recorded');
    }

    this.#started += 1;
    this.#logger.info(
      { runId: Number(row['id']), range: range.text, total: range.size, probeId: request.probeId },
      'discovery run created',
    );
    // Best effort: a probe that is not connected picks the run up on its next `resume`, which is
    // the same path a probe restart takes. Nothing is lost by the offer failing.
    await this.pump(request.probeId);
    return read(row);
  }

  /**
   * Offers a probe the run it should be doing, if it is not already doing it.
   *
   * Called when a probe connects and after any change to the queue. Idempotent by construction:
   * sending `sweep-start` for a run the probe is already running supersedes it with the same
   * cursor, which is a no-op the probe reports honestly rather than a duplicate sweep.
   */
  async pump(probeId: number): Promise<void> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_run
       WHERE probe_id = $1 AND status IN ('queued', 'running')
       ORDER BY id
       LIMIT 1`,
      [probeId],
    );
    const row = rows[0];
    if (row === undefined) return;

    const run = read(row);
    const sent = this.#dispatch(run.probeId, {
      kind: 'start',
      job: {
        runId: run.id,
        range: run.range,
        cursor: run.cursor,
        timeoutMs: run.timeoutMs,
        concurrency: run.concurrency,
        ratePerSecond: run.ratePerSecond,
      },
    });
    if (!sent) return;

    if (run.status === 'queued') {
      await this.#db.query(
        `UPDATE discovery_run SET status = 'running', started_at = COALESCE(started_at, now())
         WHERE id = $1 AND status = 'queued'`,
        [run.id],
      );
    } else {
      this.#resumed += 1;
      this.#logger.info({ runId: run.id, cursor: run.cursor }, 'discovery run resumed');
    }
  }

  /**
   * Stores what a sweep found and moves the cursor.
   *
   * **Hosts first, cursor second, in that order and in one statement each.** A cursor written
   * ahead of the hosts it covers is a host silently missed if the core stops in between — and
   * the run would report itself complete, so nobody would ever know to look.
   *
   * The cursor only ever moves forward. A probe that resumed from an older position and reported
   * it would otherwise walk the run backwards, and the range would be swept twice.
   */
  async progress(
    runId: number,
    cursor: number,
    found: readonly SweepHost[],
    failed: number,
  ): Promise<void> {
    if (found.length > 0) {
      // One statement for the batch. `ON CONFLICT DO NOTHING` is what makes a resume free: a
      // replayed address is already there and inserting it again changes nothing.
      const values: unknown[] = [runId];
      const tuples = found.map((host, at) => {
        values.push(host.address, host.rttMs);
        return `($1, $${String(at * 2 + 2)}::inet, $${String(at * 2 + 3)}::numeric)`;
      });
      const inserted = await this.#db.query<{ address: string }>(
        `INSERT INTO discovery_host (run_id, address, rtt_ms)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (run_id, address) DO NOTHING
         RETURNING host(address) AS address`,
        values,
      );
      this.#hostsStored += inserted.length;
      // `found` counts distinct hosts, so it is incremented by what was actually inserted rather
      // than by what was offered — otherwise a resume inflates the total the summary reports.
      if (inserted.length > 0) {
        await this.#db.query(`UPDATE discovery_run SET found = found + $2 WHERE id = $1`, [
          runId,
          inserted.length,
        ]);
      }
    }

    await this.#db.query(
      `UPDATE discovery_run
       SET cursor = GREATEST(cursor, $2), failed = failed + $3
       WHERE id = $1 AND status = 'running'`,
      [runId, cursor, failed],
    );
  }

  /**
   * Records how a sweep ended.
   *
   * `cancelled` and `failed` are terminal; `superseded` is not an ending at all — it means a
   * newer `sweep-start` for the same run took over, so the run stays running and the message is
   * dropped. Treating it as an ending would mark a run finished at the moment it restarted.
   */
  async finished(
    runId: number,
    ending: SweepEnding,
    cursor: number,
    message: string,
  ): Promise<void> {
    if (ending === 'superseded') return;

    // A cancelled run goes back to `queued` only if the operator did not ask for the cancel —
    // which is the shutdown case, and is why the probe reports `cancelled` on stop. The
    // difference is recorded in `status` before the message arrives: `cancel()` sets it, so a
    // run still `running` here was stopped by something other than the operator.
    await this.#db.query(
      `UPDATE discovery_run
       SET cursor = GREATEST(cursor, $2),
           status = CASE
             WHEN status = 'cancelled' THEN 'cancelled'
             WHEN $3 = 'done' THEN 'done'
             WHEN $3 = 'failed' THEN 'failed'
             ELSE 'queued'
           END,
           message = $4,
           finished_at = CASE WHEN $3 = 'cancelled' AND status <> 'cancelled' THEN NULL
                              ELSE now() END
       WHERE id = $1`,
      [runId, cursor, ending, message],
    );
    this.#logger.info({ runId, ending, cursor }, 'discovery run ended');
  }

  /** Asks the probe to stop, and records the operator's decision immediately. */
  async cancel(runId: number): Promise<DiscoveryRunRow | null> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `UPDATE discovery_run
       SET status = 'cancelled', finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING *`,
      [runId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const run = read(row);
    // Recorded first, sent second. A cancel the probe never receives — because it is not
    // connected — must still stop the run, or the operator's click did nothing and the sweep
    // resumes the moment the probe comes back.
    this.#dispatch(run.probeId, { kind: 'cancel', runId });
    return run;
  }

  async get(runId: number): Promise<DiscoveryRunRow | null> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_run WHERE id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  async list(groupId: number, limit = 25): Promise<DiscoveryRunRow[]> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_run WHERE group_id = $1 ORDER BY id DESC LIMIT $2`,
      [groupId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(read);
  }

  /** The live hosts a run found, in address order. */
  async hosts(runId: number, limit = 1_000): Promise<{ address: string; rttMs: number | null }[]> {
    const rows = await this.#db.query<{ address: string; rtt_ms: string | null }>(
      // `discovery_host.address`, qualified, and that is not decoration. A bare `address` in
      // ORDER BY binds to the *output* column — the text this select renamed — so the rows come
      // back sorted as strings and 10.0.0.10 precedes 10.0.0.9. The whole reason the column is
      // `inet` is to sort as an address, and an operator scanning the list for gaps is exactly
      // who a string sort misleads. Found by the test that asserts the order.
      `SELECT host(address) AS address, rtt_ms
       FROM discovery_host WHERE run_id = $1
       ORDER BY discovery_host.address LIMIT $2`,
      [runId, Math.min(Math.max(limit, 1), 65_536)],
    );
    return rows.map((row) => ({
      address: row.address,
      rttMs: row.rtt_ms === null ? null : Number(row.rtt_ms),
    }));
  }

  /**
   * Marks every run a probe was doing as needing a resume, on disconnect.
   *
   * Not `failed`: a probe that dropped is coming back, and its run is a cursor away from
   * continuing. Marking it failed would make an operator restart a sweep that only needed to
   * wait.
   */
  async probeDisconnected(probeId: number): Promise<void> {
    await this.#db.query(
      `UPDATE discovery_run SET status = 'queued' WHERE probe_id = $1 AND status = 'running'`,
      [probeId],
    );
  }
}

function read(row: Record<string, unknown>): DiscoveryRunRow {
  return {
    id: Number(row['id']),
    groupId: Number(row['group_id']),
    probeId: Number(row['probe_id']),
    range: String(row['range_text']),
    total: Number(row['total']),
    cursor: Number(row['cursor']),
    found: Number(row['found']),
    failed: Number(row['failed']),
    status: row['status'] as DiscoveryRunRow['status'],
    message: typeof row['message'] === 'string' ? row['message'] : '',
    timeoutMs: Number(row['timeout_ms']),
    concurrency: Number(row['concurrency']),
    ratePerSecond: Number(row['rate_per_second']),
    createdAt: iso(row['created_at']),
    startedAt: row['started_at'] === null ? null : iso(row['started_at']),
    finishedAt: row['finished_at'] === null ? null : iso(row['finished_at']),
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

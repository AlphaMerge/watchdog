import {
  parseIpRange,
  type Fingerprint,
  type IdentifyJob,
  type SweepEnding,
  type SweepHost,
  type SweepJob,
} from '@ms/shared';
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

/** One address a run found, and what it turned out to be. */
export interface DiscoveredHost {
  address: string;
  rttMs: number | null;
  /** Null until `D-02` has identified it, and for a run at `level: 'ping'`. */
  fingerprint: Fingerprint | null;
}

export interface DiscoveryRunRow {
  id: number;
  groupId: number;
  probeId: number;
  range: string;
  total: number;
  cursor: number;
  found: number;
  failed: number;
  status: 'queued' | 'running' | 'identifying' | 'done' | 'cancelled' | 'failed';
  /** `ping` stops after the sweep; `identify` runs D-02's second stage. D-06 adds more. */
  level: 'ping' | 'identify';
  identified: number;
  identifyCursor: number;
  snmpCommunity: string;
  devicesCreated: number;
  devicesMatched: number;
  sensorsCreated: number;
  provisionedAt: string | null;
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
export type DispatchMessage =
  | { kind: 'start'; job: SweepJob }
  | { kind: 'cancel'; runId: number }
  | { kind: 'identify'; job: IdentifyJob }
  | { kind: 'identify-cancel'; runId: number };

export interface StartRequest {
  groupId: number;
  probeId: number;
  range: string;
  timeoutMs?: number;
  concurrency?: number;
  ratePerSecond?: number;
  createdBy?: number;
  level?: 'ping' | 'identify';
  snmpCommunity?: string;
}

/** How many hosts one `identify-start` names, so a /16 does not become a megabyte of addresses. */
const IDENTIFY_BATCH = 4_096;

/**
 * How many times one batch may be offered without its cursor moving before the run fails.
 *
 * **A liveness bound, added after a live run spun 298 times in three minutes.** A fingerprint
 * that PostgreSQL refused — a NUL byte from a binary banner, `22P05` — made the write throw, so
 * the cursor never advanced; the probe reported the pass finished, this offered the same batch
 * again, and the pair looped as fast as the network allowed. Every layer behaved correctly on
 * its own: the endpoint caught the error rather than dropping the connection, the probe answered
 * every job it was given, and the service resumed from the cursor it had. What was missing was
 * anybody noticing that no progress was being made.
 *
 * Three, because a genuine transient — a lock, a failover — clears in one retry, and a fourth
 * attempt at the same batch is a permanent fault wearing a retry's clothes.
 */
const MAX_STALLED_OFFERS = 3;

export class DiscoveryService {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #dispatch: DiscoveryServiceOptions['dispatch'];
  #started = 0;
  #resumed = 0;
  #hostsStored = 0;
  #identifiedCount = 0;
  #stalled = 0;
  /** Per run: the cursor an offer was last made at, and how many times from there. */
  readonly #offers = new Map<number, { cursor: number; times: number }>();

  constructor(options: DiscoveryServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'discovery' });
    this.#dispatch = options.dispatch;
  }

  stats(): {
    started: number;
    resumed: number;
    hostsStored: number;
    identified: number;
    /** Runs failed for making no progress. Visible, because a stall that nobody counts recurs. */
    stalled: number;
  } {
    return {
      started: this.#started,
      resumed: this.#resumed,
      hostsStored: this.#hostsStored,
      identified: this.#identifiedCount,
      stalled: this.#stalled,
    };
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
          created_by, level, snmp_community)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        request.level ?? 'identify',
        request.snmpCommunity ?? '',
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
       WHERE probe_id = $1 AND status IN ('queued', 'running', 'identifying')
       ORDER BY id
       LIMIT 1`,
      [probeId],
    );
    const row = rows[0];
    if (row === undefined) return;

    const run = read(row);
    if (run.status === 'identifying') {
      await this.#offerIdentify(run);
      return;
    }
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

    // A sweep that covered its range hands over to identification rather than ending — the two
    // are stages of one run, because an operator starts one discovery and watches one thing
    // finish. `level: 'ping'` is how somebody says they want the addresses and nothing else, and
    // a sweep that found nothing has nothing to identify.
    if (ending === 'done') {
      const run = await this.get(runId);
      if (run !== null && run.status === 'running' && run.level === 'identify' && run.found > 0) {
        await this.#db.query(
          `UPDATE discovery_run SET status = 'identifying', cursor = GREATEST(cursor, $2)
           WHERE id = $1 AND status = 'running'`,
          [runId, cursor],
        );
        const moved = await this.get(runId);
        if (moved !== null) await this.#offerIdentify(moved);
        this.#logger.info({ runId, hosts: run.found }, 'sweep finished; identifying');
        return;
      }
    }

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

  /**
   * Offers the hosts a sweep found, from wherever identification has got to.
   *
   * **The addresses are read fresh each time, in the same order every time**, because the cursor
   * is an index into that order. `ORDER BY discovery_host.address` on the `inet` column is what
   * makes it stable — anything else and a resumed pass would identify a different host from the
   * one the cursor was counting.
   */
  async #offerIdentify(run: DiscoveryRunRow): Promise<void> {
    // **A batch offered again and again from the same cursor is not making progress.** See
    // `MAX_STALLED_OFFERS`: the loop this prevents was found live and cost nothing to any
    // individual component, which is exactly why it needs catching here rather than by any of
    // them.
    const seen = this.#offers.get(run.id);
    const times = seen !== undefined && seen.cursor === run.identifyCursor ? seen.times + 1 : 1;
    this.#offers.set(run.id, { cursor: run.identifyCursor, times });
    if (times > MAX_STALLED_OFFERS) {
      this.#stalled += 1;
      this.#offers.delete(run.id);
      this.#logger.error(
        { runId: run.id, cursor: run.identifyCursor, attempts: times },
        'identification is not making progress; failing the run',
      );
      await this.#db.query(
        `UPDATE discovery_run
         SET status = 'failed', finished_at = now(),
             message = 'identification stopped making progress at host ' || identify_cursor ||
                       ' — the core log says why the fingerprints could not be stored'
         WHERE id = $1 AND status = 'identifying'`,
        [run.id],
      );
      return;
    }

    const rows = await this.#db.query<{ address: string }>(
      `SELECT host(address) AS address
       FROM discovery_host WHERE run_id = $1
       ORDER BY discovery_host.address
       OFFSET $2 LIMIT $3`,
      [run.id, run.identifyCursor, IDENTIFY_BATCH],
    );
    if (rows.length === 0) {
      // Nothing left to identify. Recorded here rather than waiting for the probe to say so,
      // because a batch of zero would otherwise be a run that stayed `identifying` for ever.
      await this.#db.query(
        `UPDATE discovery_run SET status = 'done', finished_at = now()
         WHERE id = $1 AND status = 'identifying'`,
        [run.id],
      );
      this.#logger.info({ runId: run.id }, 'discovery run finished');
      this.#offers.delete(run.id);
      return;
    }

    this.#dispatch(run.probeId, {
      kind: 'identify',
      job: {
        runId: run.id,
        addresses: rows.map((row) => row.address),
        // Zero, not the run's cursor: the batch *is* the remaining work, so the probe counts
        // from the start of what it was handed and the core adds its own offset back on.
        cursor: 0,
        timeoutMs: Math.max(1_000, run.timeoutMs),
        // Its own bound, far below the sweep's: each host here opens a dozen TCP connections, a
        // UDP socket and a resolver query, and thirty-two of those at once is four hundred file
        // descriptors and a burst that looks exactly like a port scan to anything watching.
        concurrency: 8,
        community: run.snmpCommunity,
      },
    });
  }

  /**
   * Stores fingerprints and moves the identification cursor.
   *
   * The probe counts from the start of the batch it was handed, so its cursor is *added* to the
   * one the core holds rather than replacing it — otherwise a resumed pass reporting `40` would
   * walk the run back to its fortieth host.
   */
  async identified(runId: number, batchCursor: number, raw: readonly unknown[]): Promise<void> {
    // **Validated here, and this is a real boundary rather than a formality.** The wire schema
    // deliberately does not enumerate a fingerprint's fields — the shape grows, and a schema
    // that refused a newer probe's perfectly good answer would defeat the version negotiation —
    // so the check happens where the meaning is known. TypeScript would not have caught the gap
    // either: `DiscoverySink` declares `unknown[]` and this method's parameters are bivariant,
    // so a `Fingerprint[]` signature compiled and would have written whatever arrived straight
    // into a jsonb column that `D-03` then matches templates against.
    const found = raw.map(readFingerprint).filter((one): one is Fingerprint => one !== null);
    if (found.length < raw.length) {
      this.#logger.warn(
        { runId, offered: raw.length, usable: found.length },
        'a probe sent fingerprints this core cannot read',
      );
    }
    if (found.length > 0) {
      // `WHERE h.run_id = $1` rather than a blind update by address: a fingerprint for an address
      // this run never found is a probe answering about the wrong run, and writing it would put a
      // host into a run that never saw it. `fingerprint IS NULL` makes a replay free, the same
      // way the sweep's `ON CONFLICT DO NOTHING` does.
      const values: unknown[] = [runId];
      const tuples = found.map((one, at) => {
        values.push(one.address, JSON.stringify(one));
        return `($${String(at * 2 + 2)}::inet, $${String(at * 2 + 3)}::jsonb)`;
      });
      const updated = await this.#db.query<{ address: string }>(
        `UPDATE discovery_host AS h
         SET fingerprint = v.fingerprint
         FROM (VALUES ${tuples.join(', ')}) AS v(address, fingerprint)
         WHERE h.run_id = $1 AND h.address = v.address AND h.fingerprint IS NULL
         RETURNING host(h.address) AS address`,
        values,
      );
      this.#identifiedCount += updated.length;
      if (updated.length > 0) {
        await this.#db.query(
          `UPDATE discovery_run SET identified = identified + $2 WHERE id = $1`,
          [runId, updated.length],
        );
      }
    }

    await this.#db.query(
      `UPDATE discovery_run
       SET identify_cursor = identify_cursor + $2
       WHERE id = $1 AND status = 'identifying'`,
      [runId, batchCursor],
    );
  }

  /**
   * Records how an identification pass ended, and offers the next batch if there is one.
   *
   * A `done` here does not necessarily finish the run: a large sweep is many batches, and the run
   * is only over when a batch comes back empty — which `#offerIdentify` decides, in one place.
   */
  async identifyFinished(runId: number, ending: SweepEnding, message: string): Promise<void> {
    if (ending === 'superseded') return;

    if (ending === 'failed') {
      await this.#db.query(
        `UPDATE discovery_run SET status = 'failed', message = $2, finished_at = now()
         WHERE id = $1 AND status = 'identifying'`,
        [runId, message],
      );
      return;
    }
    if (ending === 'cancelled') {
      // The same rule the sweep follows: a probe restarting reports `cancelled` for everything it
      // was doing, and the run stays `identifying` so the next connect resumes it. A run the
      // operator cancelled is already `cancelled`, and this touches nothing.
      return;
    }

    const run = await this.get(runId);
    if (run !== null && run.status === 'identifying') await this.#offerIdentify(run);
  }

  /** Asks the probe to stop, and records the operator's decision immediately. */
  async cancel(runId: number): Promise<DiscoveryRunRow | null> {
    this.#offers.delete(runId);
    const rows = await this.#db.query<Record<string, unknown>>(
      `UPDATE discovery_run
       SET status = 'cancelled', finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running', 'identifying')
       RETURNING *`,
      [runId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const run = read(row);
    // Recorded first, sent second. A cancel the probe never receives — because it is not
    // connected — must still stop the run, or the operator's click did nothing and the sweep
    // resumes the moment the probe comes back.
    // Both stages, rather than whichever the status said: the statement above has already
    // changed it, so it no longer says which stage was running — and a cancel for a stage that
    // was not running is a no-op the probe answers honestly.
    this.#dispatch(run.probeId, { kind: 'cancel', runId });
    this.#dispatch(run.probeId, { kind: 'identify-cancel', runId });
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

  /** The live hosts a run found, in address order, with whatever `D-02` learnt about them. */
  async hosts(runId: number, limit = 1_000): Promise<DiscoveredHost[]> {
    const rows = await this.#db.query<{
      address: string;
      rtt_ms: string | null;
      fingerprint: unknown;
    }>(
      // `discovery_host.address`, qualified, and that is not decoration. A bare `address` in
      // ORDER BY binds to the *output* column — the text this select renamed — so the rows come
      // back sorted as strings and 10.0.0.10 precedes 10.0.0.9. The whole reason the column is
      // `inet` is to sort as an address, and an operator scanning the list for gaps is exactly
      // who a string sort misleads. Found by the test that asserts the order.
      `SELECT host(address) AS address, rtt_ms, fingerprint
       FROM discovery_host WHERE run_id = $1
       ORDER BY discovery_host.address LIMIT $2`,
      [runId, Math.min(Math.max(limit, 1), 65_536)],
    );
    return rows.map((row) => {
      const fingerprint = readFingerprint(row.fingerprint);
      return {
        address: row.address,
        rttMs: row.rtt_ms === null ? null : Number(row.rtt_ms),
        // Null rather than an absent key: "not identified yet" is a state a client renders, and
        // a missing field would be indistinguishable from a client that forgot to ask.
        fingerprint,
      };
    });
  }

  /** Which device a host became (`D-04`), so a re-run knows what it already made. */
  async recordDevice(runId: number, address: string, deviceId: number): Promise<void> {
    await this.#db.query(
      `UPDATE discovery_host SET device_id = $3
       WHERE run_id = $1 AND address = $2::inet`,
      [runId, address, deviceId],
    );
  }

  /**
   * Records what a provisioning pass did, and what it could not do.
   *
   * **Counts are added rather than assigned.** Provisioning can be run twice — an operator who
   * configured a credential and wants the sensors it unlocks — and the run's total is what it
   * created across all of them, not what the last one happened to do.
   */
  async recordProvisioning(
    runId: number,
    report: {
      devicesCreated: number;
      matched: number;
      sensorsCreated: number;
      problems: readonly { address: string; problem: string }[];
    },
  ): Promise<void> {
    await this.#db.query(
      `UPDATE discovery_run
       SET devices_created = devices_created + $2,
           devices_matched = devices_matched + $3,
           sensors_created = sensors_created + $4,
           provisioned_at = now()
       WHERE id = $1`,
      [runId, report.devicesCreated, report.matched, report.sensorsCreated],
    );

    if (report.problems.length > 0) {
      // One row per address, so several failing sensors on one host become one line an operator
      // reads rather than eight that say the same thing. The primary key would refuse them
      // anyway; joining them here is what keeps the *last* one from being the only one kept.
      const byAddress = new Map<string, string[]>();
      for (const one of report.problems) {
        const held = byAddress.get(one.address);
        if (held === undefined) byAddress.set(one.address, [one.problem]);
        else held.push(one.problem);
      }
      const values: unknown[] = [runId];
      const tuples = [...byAddress].map(([address, problems], at) => {
        values.push(address, problems.join('; ').slice(0, 2_000));
        return `($1, $${String(at * 2 + 2)}::inet, $${String(at * 2 + 3)})`;
      });
      // A second attempt that failed differently replaces the first record: what an operator
      // needs is why it is *still* failing, not an archaeology of every attempt.
      await this.#db.query(
        `INSERT INTO discovery_problem (run_id, address, problem)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (run_id, address) DO UPDATE SET problem = EXCLUDED.problem, at = now()`,
        values,
      );
    }
  }

  /** What a provisioning pass could not create, and why. */
  async problems(runId: number): Promise<{ address: string; problem: string }[]> {
    const rows = await this.#db.query<{ address: string; problem: string }>(
      `SELECT host(address) AS address, problem
       FROM discovery_problem WHERE run_id = $1
       ORDER BY discovery_problem.address`,
      [runId],
    );
    return rows.map((row) => ({ address: row.address, problem: row.problem }));
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
      // A run mid-identification stays `identifying`: its own cursor says where to pick up, and
      // sending it back to `queued` would re-run the sweep it has already finished.
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
    level: row['level'] === 'ping' ? 'ping' : 'identify',
    identified: Number(row['identified'] ?? 0),
    identifyCursor: Number(row['identify_cursor'] ?? 0),
    devicesCreated: Number(row['devices_created'] ?? 0),
    devicesMatched: Number(row['devices_matched'] ?? 0),
    sensorsCreated: Number(row['sensors_created'] ?? 0),
    provisionedAt: row['provisioned_at'] == null ? null : iso(row['provisioned_at']),
    snmpCommunity: typeof row['snmp_community'] === 'string' ? row['snmp_community'] : '',
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

/** The device kinds this build knows. A probe naming another is a newer probe, and is refused. */
const KINDS = new Set(['windows', 'linux', 'network', 'printer', 'hypervisor', 'nas', 'unknown']);

/**
 * A fingerprint from a probe, or null.
 *
 * **Strict about the two fields anything downstream depends on and permissive about the rest.**
 * `address` is what the row is matched by and `kind` is what `D-03` maps to a sensor set; a
 * fingerprint missing either is not usable for anything. Everything else is carried through as it
 * arrived, because a newer probe reporting a field this build has never heard of is exactly the
 * case the wire schema left open on purpose — dropping it would lose information a later release
 * knows how to read, and the column is `jsonb`.
 */
function readFingerprint(value: unknown): Fingerprint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const address = record['address'];
  if (typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  const confidence = Number(record['confidence']);
  return {
    ...record,
    address,
    kind: kind as Fingerprint['kind'],
    confidence: Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 0,
    ports: Array.isArray(record['ports']) ? (record['ports'] as Fingerprint['ports']) : [],
    evidence: Array.isArray(record['evidence'])
      ? (record['evidence'] as unknown[]).filter((one): one is string => typeof one === 'string')
      : [],
  };
}

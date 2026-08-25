import { describeError, type HousekeepingConfig, type Logger } from '@ms/shared';
import { AuditRepository } from '../audit/store.js';
import type { Database, Queryable } from '../db/pool.js';
import type { EngineCapabilities } from './engine.js';
import { SqlTimeSeriesStore, type TimeSeriesStore } from './store.js';
import { ROLLUP_TIERS, type RollupTier, type RollupTierId } from './tiers.js';

/**
 * One advisory-lock namespace for the data lifecycle. Two cores against one database — which
 * happens during a rolling restart, and will happen properly when clustering arrives — must not
 * both roll up, compress and drop at once.
 */
const HOUSEKEEPING_LOCK = `hashtext('ms:housekeeping')::bigint`;

/** Slices per tier per pass. Bounds how long one pass can hold the lock. */
export const MAX_SLICES_PER_TIER = 8;

/** Backfill entries collapsed into one window per pass. */
export const MAX_BACKFILL_ENTRIES = 256;

/** Chunks compressed per table per pass. Compression rewrites a chunk; it is not free. */
const MAX_CHUNKS_PER_PASS = 4;

/** Reaped channels per pass. */
const MAX_REAP_PER_PASS = 32;

/**
 * Audit entries deleted per statement, and statements per pass.
 *
 * Bounded twice over because the first sweep after someone shortens the retention could
 * otherwise be one DELETE across years of history, holding locks the whole time.
 */
const MAX_AUDIT_PER_STATEMENT = 5_000;
const MAX_AUDIT_STATEMENTS_PER_PASS = 10;

export interface TierReport {
  bucketsWritten: number;
  /** Where the tier is materialised to after this pass, ISO-8601, or null if it never ran. */
  watermark: string | null;
  /** True when the tier still has ground to cover and the next pass will continue. */
  behind: boolean;
}

export interface HousekeepingReport {
  /** False when another core held the lock: this pass did nothing, and that is not an error. */
  ran: boolean;
  durationMs: number;
  backfillWindows: number;
  backfillBucketsWritten: number;
  tiers: Record<RollupTierId, TierReport>;
  compressedChunks: number;
  droppedChunks: number;
  prunedAuditEntries: number;
  reapedChannels: number;
  reapedRows: number;
  /** A step that failed. The pass continues: every step is guarded by a watermark, not by the
   *  success of the one before it, so a compression failure must not stop retention. */
  failures: { step: string; message: string }[];
}

export interface HousekeeperOptions {
  db: Database;
  logger: Logger;
  config: HousekeepingConfig;
  store?: TimeSeriesStore;
  auditRepository?: AuditRepository;
}

/**
 * The data lifecycle: roll up, compress, drop, reap.
 *
 * This is the loop that TimescaleDB's own job scheduler would have run, if `add_job`,
 * `add_compression_policy` and `add_retention_policy` were not all Timescale-License
 * (ADR-001 Decision 4 amendment). Doing it here is not only a licence workaround — it means
 * one scheduler in the system instead of two, and rollup logic that a different storage engine
 * could carry unchanged (S-12).
 *
 * The ordering within a pass matters and is not arbitrary:
 *
 *   1. Backfill, so late data is summarised before anything considers dropping its source.
 *   2. Forward roll, finest tier first, because each tier reads the one below it.
 *   3. Compress, never past the point the tier above has consumed.
 *   4. Retention, likewise, so raw is never dropped before it has been rolled up.
 *   5. Reap orphaned readings, which the missing foreign key leaves behind (S-05).
 *
 * Steps 3 and 4 are guarded by watermarks rather than by step 2 having succeeded. That is what
 * makes it safe to keep going after a failure: if the rollup did not advance, neither horizon
 * moves, and nothing gets dropped that has not been summarised.
 */
export class Housekeeper {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #config: HousekeepingConfig;
  readonly #store: TimeSeriesStore;
  readonly #audit: AuditRepository;
  readonly #abort = new AbortController();

  #capabilities: EngineCapabilities | undefined;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<HousekeepingReport> | undefined;

  constructor(options: HousekeeperOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'housekeeper' });
    this.#config = options.config;
    this.#store = options.store ?? new SqlTimeSeriesStore();
    this.#audit = options.auditRepository ?? new AuditRepository();
  }

  /**
   * Records that samples landed in `[from, to)` behind a watermark, so the affected buckets are
   * rolled up again.
   *
   * Ingestion (S-07) calls this when a probe replays its spool. Cheap enough to call for any
   * batch whose oldest sample precedes the watermark; a no-op window is one row and one pass.
   */
  async noteLateSamples(from: Date, to: Date, reason: string): Promise<void> {
    await this.#db.tx((q) => this.#store.enqueueBackfill(q, from, to, reason));
    this.#logger.debug(
      { from: from.toISOString(), to: to.toISOString(), reason },
      'backfill queued',
    );
  }

  /**
   * Told by ingestion about every range of readings it writes; enqueues a backfill only when
   * that range precedes a bucket already materialised.
   *
   * This is `LateDataSink`. One statement against `rollup_watermark`, run inside ingestion's own
   * write transaction, so a replayed spool cannot leave the rollups quietly wrong: the readings
   * and the promise to re-roll them commit or fail together.
   */
  async noteWrittenRange(q: Queryable, from: Date, to: Date): Promise<boolean> {
    return this.#store.enqueueBackfillIfLate(
      q,
      from,
      // Inclusive of the newest reading's own bucket: the range is [from, to] as ingestion sees
      // it and [from, to) on the queue, so the last bucket has to be brought inside it.
      new Date(to.getTime() + 1),
      'readings written behind the rollup watermark',
    );
  }

  start(): void {
    if (!this.#config.enabled) {
      this.#logger.warn(
        'housekeeping is disabled: rollups, compression and retention will not run',
      );
      return;
    }
    const period = this.#config.intervalSeconds * 1_000;
    this.#timer = setInterval(() => void this.#tick(), period);
    // The loop must not be the reason the process stays alive; the lifecycle decides that.
    this.#timer.unref();
    // A pass immediately on start, not after one interval. A core that is restarted more often
    // than the interval would otherwise never run the lifecycle at all — and the pass right
    // after a restart is the one with the most catching up to do.
    void this.#tick();
    this.#logger.info({ intervalSeconds: this.#config.intervalSeconds }, 'housekeeping started');
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    // Let the pass in flight finish its current slice and unwind; each slice is bounded, so
    // this cannot wait indefinitely. Its outcome has already been logged.
    await this.#inFlight?.catch(() => undefined);
  }

  /**
   * Whether shutdown has begun.
   *
   * A method rather than a bare property read: TypeScript narrows a readonly property to `false`
   * after the first check and keeps that narrowing across `await`, so the second check inside a
   * loop would be flagged as dead code — while at runtime it is exactly the check that stops a
   * long pass from running on after `stop()`.
   */
  #aborted(): boolean {
    return this.#abort.signal.aborted;
  }

  async #tick(): Promise<void> {
    if (this.#inFlight !== undefined) {
      this.#logger.debug('previous pass still running, skipping this tick');
      return;
    }
    this.#inFlight = this.runOnce();
    try {
      await this.#inFlight;
    } catch (error: unknown) {
      this.#logger.error({ err: describeError(error) }, 'housekeeping pass failed');
    } finally {
      this.#inFlight = undefined;
    }
  }

  /** One bounded pass. Safe to call directly; tests do. */
  async runOnce(): Promise<HousekeepingReport> {
    const started = process.hrtime.bigint();
    const report = emptyReport();

    await this.#db.withClient(async (client) => {
      // try, not wait: if another core is mid-pass there is nothing useful to do behind it, and
      // queueing would just stack passes up behind a slow one.
      const rows = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(${HOUSEKEEPING_LOCK}) AS locked`,
      );
      if (rows.rows[0]?.locked !== true) {
        this.#logger.debug('another core holds the housekeeping lock');
        return;
      }
      report.ran = true;
      try {
        await this.#pass(report);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${HOUSEKEEPING_LOCK})`);
      }
    });

    report.durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (report.ran) {
      const level = report.failures.length > 0 ? 'warn' : 'info';
      this.#logger[level](
        {
          durationMs: Math.round(report.durationMs),
          backfillWindows: report.backfillWindows,
          bucketsWritten:
            report.backfillBucketsWritten +
            Object.values(report.tiers).reduce((sum, tier) => sum + tier.bucketsWritten, 0),
          compressedChunks: report.compressedChunks,
          droppedChunks: report.droppedChunks,
          prunedAuditEntries: report.prunedAuditEntries,
          reapedChannels: report.reapedChannels,
          failures: report.failures.length,
        },
        'housekeeping pass complete',
      );
    }
    return report;
  }

  async #pass(report: HousekeepingReport): Promise<void> {
    await this.#step(report, 'backfill', () => this.#backfill(report));
    await this.#step(report, 'rollup', () => this.#rollForward(report));
    await this.#step(report, 'compress', () => this.#compress(report));
    await this.#step(report, 'retention', () => this.#retention(report));
    await this.#step(report, 'reap', () => this.#reap(report));
    await this.#step(report, 'audit-retention', () => this.#pruneAudit(report));
  }

  async #step(report: HousekeepingReport, step: string, run: () => Promise<void>): Promise<void> {
    if (this.#aborted()) return;
    try {
      await run();
    } catch (error: unknown) {
      const described = describeError(error);
      report.failures.push({ step, message: described.message });
      this.#logger.error({ err: described, step }, 'housekeeping step failed');
    }
  }

  /** Re-rolls windows where late data landed behind a watermark. */
  async #backfill(report: HousekeepingReport): Promise<void> {
    const claimed = await this.#db.tx((q) => this.#store.claimBackfill(q, MAX_BACKFILL_ENTRIES));
    if (claimed === null) return;

    report.backfillWindows = claimed.ids.length;
    const watermarks = await this.#db.tx((q) => this.#store.watermarks(q));

    // A window can be wider than one pass is allowed to re-roll — a probe that spooled for a
    // fortnight, or a queue drained after a long stop. Deleting the queue entry once the slice
    // budget ran out would abandon the rest of it silently, so what was not reached goes back
    // on the queue before the claim is cleared.
    let unfinishedFrom: number | null = null;

    for (const tier of ROLLUP_TIERS) {
      const watermark = watermarks.get(tier.id);
      // A tier that has never run has nothing to correct: its first forward pass will read this
      // window from scratch.
      if (watermark === undefined) continue;

      const from = alignDown(claimed.from, tier.bucketSeconds);
      const end = alignDown(claimed.to, tier.bucketSeconds).getTime() + tier.bucketSeconds * 1_000;
      // Never past the watermark: beyond it is the forward roll's ground, not a correction.
      const to = new Date(Math.min(end, watermark.getTime()));
      if (to <= from) continue;

      const progress = await this.#rollRange(tier, from, to, { replace: true, advance: false });
      report.backfillBucketsWritten += progress.written;
      if (progress.reached < to) {
        const reached = progress.reached.getTime();
        unfinishedFrom = unfinishedFrom === null ? reached : Math.min(unfinishedFrom, reached);
      }
    }

    await this.#db.tx(async (q) => {
      if (unfinishedFrom !== null) {
        await this.#store.enqueueBackfill(
          q,
          new Date(unfinishedFrom),
          claimed.to,
          'continuation of an unfinished backfill',
        );
      }
      await this.#store.clearBackfill(q, claimed.ids);
    });
    if (unfinishedFrom !== null) {
      this.#logger.info(
        { from: new Date(unfinishedFrom).toISOString(), to: claimed.to.toISOString() },
        'backfill window requeued for the next pass',
      );
    }
  }

  /** Materialises each tier up to the newest bucket it is allowed to complete. */
  async #rollForward(report: HousekeepingReport): Promise<void> {
    const watermarks = await this.#db.tx((q) => this.#store.watermarks(q));

    for (const tier of ROLLUP_TIERS) {
      if (this.#aborted()) return;

      // Lazily, and in tier order: a tier's starting point is derived from its source, and the
      // source may only have been materialised moments ago, in this same pass.
      let watermark = watermarks.get(tier.id);
      if (watermark === undefined) {
        watermark = await this.#db.tx(async (q) => {
          const start = await this.#store.startingWatermark(q, tier);
          await this.#store.advanceWatermark(q, tier, start);
          return start;
        });
        this.#logger.info(
          { tier: tier.id, watermark: watermark.toISOString() },
          'rollup tier initialised',
        );
      }

      const sourceWatermark =
        tier.source.kind === 'rollup' ? (watermarks.get(tier.source.tier) ?? null) : null;
      const target = await this.#db.tx((q) =>
        this.#store.rollupTarget(q, tier, this.#config.rollupLagSeconds, sourceWatermark),
      );

      const tierReport = report.tiers[tier.id];
      if (target <= watermark) {
        tierReport.watermark = watermark.toISOString();
        watermarks.set(tier.id, watermark);
        continue;
      }

      const progress = await this.#rollRange(tier, watermark, target, {
        replace: false,
        advance: true,
      });
      tierReport.bucketsWritten = progress.written;
      const reached = await this.#db.tx((q) => this.#store.watermarks(q));
      const now = reached.get(tier.id) ?? watermark;
      watermarks.set(tier.id, now);
      tierReport.watermark = now.toISOString();
      tierReport.behind = now < target;
    }
  }

  /**
   * Rolls `[from, to)` in bounded slices, reporting the buckets written and how far it got.
   *
   * Each slice commits with its own watermark advance, so a crash halfway through leaves the
   * watermark pointing at the last slice that actually landed — never past it. The slice budget
   * means `reached` can fall short of `to`; every caller has to decide what to do about that,
   * which is the point of returning it.
   */
  async #rollRange(
    tier: RollupTier,
    from: Date,
    to: Date,
    options: { replace: boolean; advance: boolean },
  ): Promise<{ written: number; reached: Date }> {
    const sliceMs = tier.sliceBuckets * tier.bucketSeconds * 1_000;
    let cursor = from;
    let written = 0;

    for (let slice = 0; slice < MAX_SLICES_PER_TIER && cursor < to; slice += 1) {
      if (this.#aborted()) break;
      const end = new Date(Math.min(to.getTime(), cursor.getTime() + sliceMs));
      const boundary = end;
      const start = cursor;
      written += await this.#db.tx(async (q) => {
        const count = await this.#store.rollUp(q, tier, start, boundary, {
          replace: options.replace,
        });
        if (options.advance) await this.#store.advanceWatermark(q, tier, boundary);
        return count;
      });
      cursor = end;
    }
    return { written, reached: cursor };
  }

  /**
   * Compresses aged chunks, never past what the tier above has already consumed.
   *
   * Writing into a compressed chunk works but is slower, so the horizon is deliberately well
   * behind the rollup: by the time a chunk is compressed, everything that reads it routinely
   * has moved on.
   */
  async #compress(report: HousekeepingReport): Promise<void> {
    if (!(await this.#canCompact())) return;

    const watermarks = await this.#db.tx((q) => this.#store.watermarks(q));
    const pending = await this.#db.tx((q) => this.#store.earliestPendingBackfill(q));

    const targets: { table: string; afterDays: number; consumedBy: RollupTierId }[] = [
      {
        table: 'sample',
        afterDays: this.#config.compression.rawAfterDays,
        consumedBy: 'sample_5m',
      },
      {
        table: 'sample_5m',
        afterDays: this.#config.compression.fiveMinuteAfterDays,
        consumedBy: 'sample_1h',
      },
    ];

    for (const target of targets) {
      if (this.#aborted()) return;
      const before = this.#limit(
        await this.#db.tx((q) => this.#store.horizon(q, target.afterDays)),
        watermarks.get(target.consumedBy),
        pending,
      );
      if (before === null) continue;

      const chunks = await this.#db.tx((q) =>
        this.#store.compactableChunks(q, target.table, before, MAX_CHUNKS_PER_PASS),
      );
      for (const chunk of chunks) {
        if (this.#aborted()) return;
        await this.#db.tx((q) => this.#store.compact(q, chunk));
        report.compressedChunks += 1;
        this.#logger.info({ table: target.table, chunk }, 'chunk compressed');
      }
    }
  }

  /**
   * Drops whole chunks past each tier's retention horizon.
   *
   * The horizon is capped twice over, and both caps are the difference between housekeeping and
   * data loss: never past what the next tier up has summarised, and never into a window a
   * pending backfill still has to re-read.
   */
  async #retention(report: HousekeepingReport): Promise<void> {
    const watermarks = await this.#db.tx((q) => this.#store.watermarks(q));
    const pending = await this.#db.tx((q) => this.#store.earliestPendingBackfill(q));
    const retention = this.#config.retention;

    const targets: { table: string; days: number; consumedBy: RollupTierId | null }[] = [
      { table: 'sample', days: retention.rawDays, consumedBy: 'sample_5m' },
      { table: 'sample_5m', days: retention.fiveMinuteDays, consumedBy: 'sample_1h' },
      { table: 'sample_1h', days: retention.hourlyDays, consumedBy: 'sample_1d' },
      // The coarsest tier has nothing above it: its horizon is the only limit.
      { table: 'sample_1d', days: retention.dailyDays, consumedBy: null },
    ];

    for (const target of targets) {
      if (this.#aborted()) return;
      const olderThan = this.#limit(
        await this.#db.tx((q) => this.#store.horizon(q, target.days)),
        target.consumedBy === null ? undefined : watermarks.get(target.consumedBy),
        pending,
      );
      if (olderThan === null) continue;

      const dropped = await this.#db.tx((q) =>
        this.#store.dropOlderThan(q, target.table, olderThan),
      );
      report.droppedChunks += dropped.length;
      for (const chunk of dropped) {
        this.#logger.info(
          { table: target.table, chunk, olderThan: olderThan.toISOString() },
          'chunk dropped by retention',
        );
      }
    }
  }

  /** Deletes readings belonging to channels that no longer exist (S-05). */
  async #reap(report: HousekeepingReport): Promise<void> {
    const candidates = await this.#db.tx((q) => this.#store.reapCandidates(q, MAX_REAP_PER_PASS));
    if (candidates.length === 0) return;

    // One transaction: dropping the queue entry without the rows would orphan them for ever,
    // because nothing else remembers the channel ever existed.
    const rows = await this.#db.tx((q) => this.#store.reapChannels(q, candidates));
    report.reapedChannels = candidates.length;
    report.reapedRows = rows;
    this.#logger.info({ channels: candidates.length, rows }, 'orphaned readings reaped');
  }

  /**
   * Whether this engine can compact at all, asked once.
   *
   * An engine without columnar storage — plain PostgreSQL, if `S-11` ever needs it — would
   * otherwise be asked to compact on every pass and fail on every pass. Asking once and
   * believing the answer turns a recurring error into a line in the start-up log.
   */
  async #canCompact(): Promise<boolean> {
    if (this.#capabilities === undefined) {
      this.#capabilities = await this.#db.tx((q) => this.#store.capabilities(q));
      if (!this.#capabilities.compaction) {
        this.#logger.info(
          { engine: this.#capabilities.engine },
          'this storage engine cannot compact; housekeeping will not try',
        );
      }
    }
    return this.#capabilities.compaction;
  }

  /**
   * Drops configuration audit entries past their own horizon (WORKFLOW.MD §9).
   *
   * No watermark guard here, and none is needed: nothing downstream consumes the audit log, so
   * the only thing protecting it is its retention setting — which is why that setting defaults
   * to twice the raw data's. "Who changed this" is asked long after the readings either side of
   * the change have been rolled up and dropped.
   */
  async #pruneAudit(report: HousekeepingReport): Promise<void> {
    const olderThan = await this.#db.tx((q) =>
      this.#store.horizon(q, this.#config.retention.auditDays),
    );

    for (let statement = 0; statement < MAX_AUDIT_STATEMENTS_PER_PASS; statement += 1) {
      if (this.#aborted()) return;
      const pruned = await this.#db.tx((q) =>
        this.#audit.prune(q, olderThan, MAX_AUDIT_PER_STATEMENT),
      );
      report.prunedAuditEntries += pruned;
      // Short of the limit means the horizon is clear; anything else and the next pass carries
      // on where this one stopped.
      if (pruned < MAX_AUDIT_PER_STATEMENT) break;
    }

    if (report.prunedAuditEntries > 0) {
      this.#logger.info(
        { entries: report.prunedAuditEntries, olderThan: olderThan.toISOString() },
        'audit entries pruned by retention',
      );
    }
  }

  /**
   * Caps an age horizon by the two things that make it unsafe to act on.
   *
   * A tier that has never run yields `undefined` and returns null — refusing to compress or drop
   * anything at all, because nothing above has consumed it yet. That is the correct behaviour on
   * a system whose rollups are failing: it stops the lifecycle rather than quietly eating the
   * only copy of the data.
   */
  #limit(horizon: Date, consumedTo: Date | undefined, pendingBackfill: Date | null): Date | null {
    if (consumedTo === undefined) return null;
    let limit = horizon.getTime() < consumedTo.getTime() ? horizon : consumedTo;
    if (pendingBackfill !== null && pendingBackfill.getTime() < limit.getTime()) {
      limit = pendingBackfill;
    }
    return limit;
  }
}

/** Floors an instant to a bucket boundary, matching the engine's Unix-epoch alignment. */
export function alignDown(at: Date, bucketSeconds: number): Date {
  const size = bucketSeconds * 1_000;
  return new Date(Math.floor(at.getTime() / size) * size);
}

function emptyReport(): HousekeepingReport {
  const tiers = {} as Record<RollupTierId, TierReport>;
  for (const tier of ROLLUP_TIERS) {
    tiers[tier.id] = { bucketsWritten: 0, watermark: null, behind: false };
  }
  return {
    ran: false,
    durationMs: 0,
    backfillWindows: 0,
    backfillBucketsWritten: 0,
    tiers,
    compressedChunks: 0,
    droppedChunks: 0,
    prunedAuditEntries: 0,
    reapedChannels: 0,
    reapedRows: 0,
    failures: [],
  };
}

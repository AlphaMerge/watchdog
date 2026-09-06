import { describeError, type IngestionConfig, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { CounterStore } from './counter-store.js';
import type { CounterSample } from './counters.js';
import { writeRuntimes, writeStateHistory } from '../state/runtime.js';
import type {
  CommittedStates,
  RuntimeWrite,
  StateDecisions,
  StateTransition,
} from '../state/runtime.js';

/** One channel reading, resolved to a channel id and ready to write. */
export interface SampleRow {
  channelId: number;
  at: Date;
  value: number;
}

export interface IngestBatch {
  /** Where it came from — a probe gid, or `local`. For logs and per-source metrics. */
  source: string;
  samples: readonly SampleRow[];
  /**
   * The counter baselines these readings advanced (`P-107`).
   *
   * **Written in the readings' own transaction**, for the reason `states` is. They used to be
   * committed in `#prepare`, before the batch was even offered — so a batch the ingestor refused
   * (queue-full) or failed to write left the baseline advanced to its own last sample. The probe
   * still held the batch and re-offered it, and on the resend every reading divided against
   * itself: `current.at - previous.at` is zero for the last one and negative for the earlier
   * ones, so `rateFrom` answered `no-elapsed` for all of them and produced no samples at all.
   * The interval's traffic was gone for good, with no counter incremented and no log line,
   * during exactly the pressure event an operator was investigating.
   *
   * The state machine has an explicit rewind for this hazard — `SensorStateService.forget` — and
   * the counter store had none. Committing with the samples is the same fix a different way: if
   * the write rolls back, the baseline rolls back with it.
   */
  counters?: ReadonlyMap<number, CounterSample>;
  /**
   * What the same results did to their sensors' states (`M-02`).
   *
   * A second row type rather than a second pipeline, and written in the readings' own
   * transaction: a state change committed without the readings that caused it, or readings
   * committed without the state change, is a history that disagrees with itself. It also means
   * a failed write rolls both back, and the probe — which was never acknowledged — offers the
   * whole thing again.
   */
  states?: StateDecisions;
  /**
   * When the probe sent this batch, by the probe's own clock (`P-169`).
   *
   * **Staleness has to be measured in one clock, and this is the one that has both hands.**
   * `CheckResult.at` is the probe's clock, so `sentAt - max(result.at)` is a duration on a
   * single machine: seconds for a live batch, hours for a spool drain, and right however far
   * that machine's clock is from the core's. `P-146` compared the results against the *core's*
   * now, which made a probe five minutes slow look like a permanent replay and stopped every
   * alarm under it (`R17`).
   *
   * `P-157` replaced that with the probe's `backlog`, which was wrong for a different reason:
   * `backlog` is `pending - batch.length` — rows still on disk *right now* — so a live probe
   * whose scan tick queues more than one batch reports thousands of them, and every one of its
   * live batches was read as a replay. At 5,047 sensors and a 500-row batch that is the normal
   * case, not an edge. `backlog` is a pacing signal and `R-03` is what added it.
   *
   * Absent from a probe below protocol 16, and then the core's own clock is the fallback —
   * `P-146`'s test, with `P-146`'s skew problem, which is the best that can be done without it.
   */
  sentAt?: Date;
}

export type IngestOutcome =
  | { accepted: true; storedSamples: number; retryAfterMs: number }
  | {
      accepted: false;
      reason: 'queue-full' | 'shutting-down' | 'storage-error';
      retryAfterMs: number;
    };

/**
 * Told about every range of readings that lands, so the rollup can correct itself.
 *
 * The `Housekeeper` implements this: it enqueues a backfill window when — and only when — the
 * readings precede a bucket it has already materialised, which is what a probe replaying its
 * disk spool looks like (R-03). Without it those readings sit in raw, correct and invisible,
 * until retention drops them.
 *
 * It takes the `Queryable` so it joins the write's own transaction. That is the difference
 * between a guarantee and a hope: the readings and the promise to re-roll them commit together,
 * and a crash in between cannot leave one without the other.
 */
export interface LateDataSink {
  noteWrittenRange(q: Queryable, from: Date, to: Date): Promise<boolean>;
}

/** Just enough of `Database` to run one transaction — the whole of what ingestion needs. */
export interface IngestTarget {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

/**
 * What reacts to a batch's state changes (`M-11`).
 *
 * A master going Down pauses its dependents, and that has to happen in the transaction that
 * recorded the master going Down — otherwise a dependent's next result arrives between the two
 * and produces the alarm the dependency exists to suppress.
 */
export interface DependencyReactor {
  react(
    q: Queryable,
    changes: readonly {
      sensorId: number;
      state: string;
      previousState: string | null;
      at?: Date;
    }[],
    now: Date,
  ): Promise<{ moved: number; transitions: number }>;
}

/**
 * Just enough of `AlarmEngine` to reconcile the sensors a batch moved (`N-02`).
 *
 * Narrow for the same reason `DependencyReactor` is: ingestion has no business knowing what a
 * notification is, only that something wants to look at what it just decided.
 */
export interface AlarmReactor {
  react(q: Queryable, sensorIds: readonly number[], now: Date): Promise<unknown>;
  /**
   * Whether this batch has to be reconciled in full rather than only where the state moved.
   *
   * True exactly when some enabled threshold trigger exists (`P-104`): its condition is a
   * reading, and a reading changes without the state changing.
   */
  reconcilesReadings(q: Queryable): Promise<boolean>;
}

export interface IngestorOptions {
  /** Narrower than the pool, so a test can hand it a stub that fails. */
  db: IngestTarget;
  logger: Logger;
  config: IngestionConfig;
  lateData?: LateDataSink;
  dependencies?: DependencyReactor;
  /**
   * How far behind a batch's newest result may be and still be reacted to (`P-146`).
   *
   * A live batch is milliseconds old. Anything older than this is a probe draining its spool, and
   * the present cannot be decided from it. Generous by default: a minute covers an ordinary scan
   * interval and a slow network, and what is being excluded is hours.
   */
  catchUpGraceMs?: number;
  /**
   * What arms and stands down notification chains (`N-02`).
   *
   * Reacts **after** the dependency reaction. In an alarm storm every dependent records its own
   * Down in this same batch on its way to being paused by the master's (`M-17`), so reconciling
   * against the state the transaction actually ends in arms one chain instead of forty.
   *
   * Not load-bearing, and measured rather than assumed: reacting first also ends with one, because
   * the dependency reaction re-reconciles the sensors it paused through `reevaluate` — inside this
   * same transaction, so nothing outside ever sees the pair. Doing the work once is simply better
   * than arming thirty-nine chains and standing them down two statements later.
   */
  alarms?: AlarmReactor;
  /**
   * Told which state changes committed, so `U-02` can push them (after the commit, never
   * inside it — a frame about a transaction that rolled back is an outage that never happened).
   */
  onStatesCommitted?: CommittedStates;
  /**
   * Poked after a write whose state changes moved a dependency (`M-11`).
   *
   * The ingestion path is the one write path that does **not** go through the audit sink — a
   * check result is not a configuration change — so nothing else would tell the probes that a
   * master going Down has taken its dependents out of their assignments. Without this they keep
   * scanning sensors the core has already paused: harmless to the states, which the pause layer
   * decides, but wasted work during exactly the outage that made the network slow.
   */
  onDependencyChange?: () => void;
}

export interface IngestionStats {
  /** Readings waiting to be written. The number Core Health watches (P-12). */
  queuedRows: number;
  queuedBatches: number;
  acceptedBatches: number;
  /** Batches turned away because the queue was full. Never silently dropped, always counted. */
  refusedBatches: number;
  refusedRows: number;
  failedBatches: number;
  storedSamples: number;
  /** Readings that were already there — normal during a replay, suspicious otherwise. */
  duplicateSamples: number;
  /** Transitions appended to `sensor_state`. What uptime and SLA are computed from. */
  storedStateChanges: number;
  /** Sensors whose current row moved forward. */
  runtimeWrites: number;
  /**
   * Runtime updates that matched no row, because the sensor was deleted between the decision
   * and the write, or because the result was older than what is already stored. Expected during
   * a replay; a steady stream of them outside one means the two disagree about time.
   */
  staleRuntimeWrites: number;
  /**
   * Sensors paused or released because a master's state moved (`M-11`).
   *
   * On Core Health beside the rest: a number that climbs steadily means a master is flapping,
   * which is the shape of the alarm storm dependencies exist to prevent showing up as churn
   * instead.
   */
  dependencyPauses: number;
  /**
   * Batches whose newest result was too old to decide the present from, so the alarm reaction was
   * left to the batch after them (`P-146`).
   *
   * Counted rather than silent, which is `CLAUDE.md`'s rule for anything deferred: a probe that
   * never catches up is a probe whose alarms are never reconciled, and that has to be visible.
   */
  staleReactions: number;
  /**
   * Sensors whose alarm reaction is waiting for a batch that is not a replay (`R04`).
   *
   * **Visible because it is the shape of a stuck probe.** A number that goes up during a drain
   * and back to zero when it ends is the mechanism working. A number that stays up is a probe
   * that never reports itself caught up, and every one of those sensors has an unarmed alarm.
   */
  deferredReactions: number;
  writes: number;
  /** Write latency in milliseconds over the last 1,024 writes. */
  writeMs: { p50: number; p95: number; p99: number; max: number };
  /** True while acknowledgements are carrying a slow-down hint. */
  slowingDown: boolean;
  backfillsQueued: number;
}

/** A minute: an ordinary scan interval and a slow network, against the hours a drain spans. */
const DEFAULT_CATCH_UP_GRACE_MS = 60_000;

interface Queued {
  batch: IngestBatch;
  settle: (outcome: IngestOutcome) => void;
}

/** Write durations kept for the percentile the exit criterion is stated in. */
const LATENCY_WINDOW = 1_024;

/**
 * The core's write path for check results.
 *
 * Three properties, in the order they matter:
 *
 * **Bounded.** The queue has a row limit. Past it, batches are refused with a reason and a
 * retry delay rather than accepted into a heap that grows until the process dies. Refusing is
 * the safe answer because the probe has not been acknowledged and still holds the batch in its
 * disk spool (R-02) — the backlog belongs on the probe's disk, not in our memory.
 *
 * **Visible.** Every refusal, duplicate and failure is counted (CLAUDE.md: "backpressure is
 * visible, never silent... never drop without counting"). `stats()` is what Core Health reads.
 *
 * **Idempotent.** Writes are `ON CONFLICT DO NOTHING` against the unique index S-05 put on
 * `(channel_id, time)`, so a probe that resends after a lost acknowledgement costs a duplicate
 * write and nothing else. That is what lets the acknowledgement mean "durably stored" without
 * any exactly-once machinery on the wire.
 */
export class Ingestor {
  readonly #db: IngestTarget;
  readonly #logger: Logger;
  readonly #config: IngestionConfig;
  readonly #lateData: LateDataSink | undefined;
  /** Stateless, so a second instance is the same store (`P-107`). */
  readonly #counters = new CounterStore();
  readonly #dependencies: DependencyReactor | undefined;
  readonly #alarms: AlarmReactor | undefined;
  readonly #onStatesCommitted: CommittedStates | undefined;
  readonly #onDependencyChange: (() => void) | undefined;
  #dependencyPauses = 0;
  #staleReactions = 0;
  readonly #catchUpGraceMs: number;
  /**
   * Sensors whose state moved in a batch the alarm reaction skipped (`R04`, `G02`).
   *
   * **Deferred, not dropped, and that distinction is the whole ticket.** `P-146` skipped the
   * reaction for a stale batch on the reasoning that "the drain ends with a live batch, and
   * that one decides the present correctly". A live batch decides the present for the sensors
   * *it* carries a transition for — and a sensor that went Down during the spooled window
   * transitions once, in a skipped batch, and never transitions again while the outage
   * continues. Every later batch has it in `runtimes` and not in `transitions`, so it is armed
   * by nothing and nobody is paged for an outage that is still happening. One outage, zero
   * alarms.
   *
   * **In memory, and a restart drops it** (`P-177`). That is a real hole and it is closed
   * elsewhere rather than here: `main()` reconciles standing alarms once at boot, which arms
   * every sensor that is Down without one — the deferred ones and anything else a crash lost.
   * Persisting the set would put a write on the hot ingest path to solve a problem one
   * idempotent pass at startup already solves.
   *
   * So the ids are held here instead and folded into the first batch that is not stale, which
   * reconciles them against their current state — arming what is still Down and standing down
   * what recovered while the spool drained. Bounded by the sensor count, and cleared whole:
   * every id in it is included in that reaction.
   */
  readonly #deferredReactions = new Map<string, Set<number>>();

  readonly #queue: Queued[] = [];
  readonly #latencies: number[] = [];

  #queuedRows = 0;
  #flushing = false;
  #timer: NodeJS.Timeout | undefined;
  #stopping = false;
  #idle: Promise<void> | undefined;
  #idleResolve: (() => void) | undefined;

  #acceptedBatches = 0;
  #refusedBatches = 0;
  #refusedRows = 0;
  #failedBatches = 0;
  #storedSamples = 0;
  #duplicateSamples = 0;
  #writes = 0;
  #backfillsQueued = 0;
  #storedStateChanges = 0;
  #runtimeWrites = 0;
  #staleRuntimeWrites = 0;

  constructor(options: IngestorOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'ingestor' });
    this.#config = options.config;
    this.#lateData = options.lateData;
    this.#dependencies = options.dependencies;
    this.#catchUpGraceMs = options.catchUpGraceMs ?? DEFAULT_CATCH_UP_GRACE_MS;
    this.#alarms = options.alarms;
    this.#onStatesCommitted = options.onStatesCommitted;
    this.#onDependencyChange = options.onDependencyChange;
  }

  /**
   * Offers a batch. Resolves once the readings are committed, or once the batch has been
   * refused.
   *
   * Never rejects: the caller always has an answer to send back to the probe, and a thrown
   * exception here would leave a probe waiting for an acknowledgement that never came.
   */
  async submit(batch: IngestBatch): Promise<IngestOutcome> {
    const rows = batch.samples.length;
    // A failed check records no channel values at all, so the batch that matters most to the
    // state machine is exactly the one with no readings in it. Counting only samples here would
    // acknowledge an outage and never write it down.
    const stateRows =
      (batch.states?.transitions.length ?? 0) + (batch.states?.runtimes.length ?? 0);
    // And for the same reason again (`P-107`): a counter's *first* reading produces no sample —
    // there is nothing to divide it by yet — and it is precisely the one that has to move the
    // baseline, or the next scan has nothing to divide either and the channel never reports.
    const counterRows = batch.counters?.size ?? 0;

    if (this.#stopping) {
      this.#refuse(rows);
      return { accepted: false, reason: 'shutting-down', retryAfterMs: this.#config.retryAfterMs };
    }

    // An empty batch is not an error — a probe with nothing due has results for nothing — and it
    // must still be acknowledged, or the probe will offer it again for ever.
    if (rows === 0 && stateRows === 0 && counterRows === 0) {
      this.#acceptedBatches += 1;
      return { accepted: true, storedSamples: 0, retryAfterMs: this.#retryHint() };
    }

    // The queue limit counts readings only, not state rows. State rows are bounded by the
    // number of sensors in the batch and are written in the same flush, so they cannot be the
    // thing that fills memory — and counting them here without also counting them in the flush
    // would leave `queuedRows` drifting upward until the queue wedged shut. `queuedBatches` is
    // what watches the other dimension.
    if (this.#queuedRows + rows > this.#config.queueMaxRows) {
      this.#refuse(rows);
      this.#logger.warn(
        { source: batch.source, rows, queuedRows: this.#queuedRows, refused: this.#refusedBatches },
        'ingestion queue is full, refusing a batch',
      );
      return { accepted: false, reason: 'queue-full', retryAfterMs: this.#config.retryAfterMs };
    }

    this.#queuedRows += rows;
    this.#acceptedBatches += 1;

    const outcome = new Promise<IngestOutcome>((resolve) => {
      this.#queue.push({ batch, settle: resolve });
    });

    this.#schedule();
    return outcome;
  }

  /**
   * Stops accepting work and writes what is already queued.
   *
   * Everything in the queue has been promised durability, so draining is not optional: a probe
   * waiting on an acknowledgement would otherwise resend the batch, which is survivable, but a
   * local caller with no spool would simply lose it.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#queue.length > 0 || this.#flushing) {
      this.#schedule(true);
      await this.#idlePromise();
    }
    this.#logger.info(
      { storedSamples: this.#storedSamples, refusedBatches: this.#refusedBatches },
      'ingestion stopped',
    );
  }

  stats(): IngestionStats {
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const at = (fraction: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
      return Number((sorted[index] ?? 0).toFixed(3));
    };
    return {
      queuedRows: this.#queuedRows,
      queuedBatches: this.#queue.length,
      acceptedBatches: this.#acceptedBatches,
      refusedBatches: this.#refusedBatches,
      refusedRows: this.#refusedRows,
      failedBatches: this.#failedBatches,
      storedSamples: this.#storedSamples,
      duplicateSamples: this.#duplicateSamples,
      storedStateChanges: this.#storedStateChanges,
      runtimeWrites: this.#runtimeWrites,
      staleRuntimeWrites: this.#staleRuntimeWrites,
      dependencyPauses: this.#dependencyPauses,
      staleReactions: this.#staleReactions,
      deferredReactions: [...this.#deferredReactions.values()].reduce(
        (n, held) => n + held.size,
        0,
      ),
      writes: this.#writes,
      writeMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) },
      slowingDown: this.#retryHint() > 0,
      backfillsQueued: this.#backfillsQueued,
    };
  }

  #refuse(rows: number): void {
    this.#refusedBatches += 1;
    this.#refusedRows += rows;
  }

  /**
   * How long a probe should wait before offering more.
   *
   * Zero until the queue passes the slow-down mark, then the configured delay. Gradual on
   * purpose: a system that only ever says "full, go away" has already built the backlog it is
   * complaining about.
   */
  #retryHint(): number {
    const mark = (this.#config.queueMaxRows * this.#config.slowDownAtPercent) / 100;
    return this.#queuedRows >= mark ? this.#config.retryAfterMs : 0;
  }

  #schedule(immediate = false): void {
    if (this.#flushing) return;
    if (this.#timer !== undefined) return;

    // Full batch, or told to go now: no reason to wait for company.
    if (immediate || this.#queuedRows >= this.#config.batchMaxRows) {
      void this.#flush();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, this.#config.batchMaxDelayMs);
    this.#timer.unref();
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#queue.length > 0) {
        await this.#writeOne();
      }
    } finally {
      this.#flushing = false;
      if (this.#queue.length === 0) this.#settleIdle();
      else this.#schedule();
    }
  }

  /** Takes up to `batchMaxRows` worth of queued batches and writes them in one statement. */
  async #writeOne(): Promise<void> {
    const taken: Queued[] = [];
    let rows = 0;
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (next === undefined) break;
      // Always take at least one, even if a single batch is larger than the target size —
      // otherwise an oversized batch would sit at the head of the queue for ever.
      if (taken.length > 0 && rows + next.batch.samples.length > this.#config.batchMaxRows) break;
      this.#queue.shift();
      taken.push(next);
      rows += next.batch.samples.length;
    }
    if (taken.length === 0) return;

    const times: Date[] = [];
    const channelIds: number[] = [];
    const values: number[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    const transitions: StateTransition[] = [];
    // One runtime row per sensor, whatever the merge swept in: the UPDATE joins on the sensor
    // id, and two rows for the same sensor would let the database pick either of them.
    const runtimes = new Map<number, RuntimeWrite>();
    // One baseline per channel, newest wins — the same merge rule as `runtimes`, and for the
    // same reason: two rows for one channel would let the database pick either (`P-107`).
    const counters = new Map<number, CounterSample>();
    // **Per source, because staleness is a property of the probe and not of the write**
    // (`P-169`). One write coalesces submissions from every connected probe, so judging the
    // whole write as stale or live gets both answers wrong: a draining probe's replay was
    // reconciled by the local probe's next live batch — the storm `P-146` exists to stop — and,
    // the other way, a live probe's batch was deferred because a different probe was draining.
    const sensorsBySource = new Map<string, Set<number>>();
    const staleBySource = new Map<string, boolean>();
    for (const queued of taken) {
      for (const sample of queued.batch.samples) {
        times.push(sample.at);
        channelIds.push(sample.channelId);
        values.push(sample.value);
        const at = sample.at.getTime();
        if (at < oldest) oldest = at;
        if (at > newest) newest = at;
      }
      for (const [channelId, sample] of queued.batch.counters ?? []) {
        const held = counters.get(channelId);
        if (held === undefined || sample.at.getTime() >= held.at.getTime()) {
          counters.set(channelId, sample);
        }
      }
      const states = queued.batch.states;
      if (states === undefined) continue;
      transitions.push(...states.transitions);
      for (const write of states.runtimes) {
        const held = runtimes.get(write.sensorId);
        if (held === undefined || write.at.getTime() >= held.at.getTime()) {
          runtimes.set(write.sensorId, write);
        }
      }
    }

    // A second pass, so every submission is judged whether or not it decided any state: the
    // sensors it carries, and whether it is a replay.
    for (const queued of taken) {
      const source = queued.batch.source;
      const mine = sensorsBySource.get(source) ?? new Set<number>();
      for (const write of queued.batch.states?.runtimes ?? []) mine.add(write.sensorId);
      for (const transition of queued.batch.states?.transitions ?? [])
        mine.add(transition.sensorId);
      sensorsBySource.set(source, mine);

      // **How old these results are to the probe that took them** (`P-169`). Both timestamps are
      // the probe's, so the comparison is immune to any skew between the two machines — which is
      // what `R17` was about, and what `backlog` failed to answer because it counts rows on disk
      // rather than the age of the data.
      const newestHere = [...(queued.batch.states?.runtimes ?? [])].reduce(
        (best, write) => Math.max(best, write.at.getTime()),
        (queued.batch.states?.transitions ?? []).reduce(
          (best, transition) => Math.max(best, transition.at.getTime()),
          0,
        ),
      );
      if (newestHere === 0) continue;
      const against = queued.batch.sentAt?.getTime() ?? Date.now();
      const isStale = against - newestHere > this.#catchUpGraceMs;
      staleBySource.set(source, (staleBySource.get(source) ?? false) || isStale);
    }

    // Which sources this write may reconcile, and which it must hold back for.
    const liveSources = [...sensorsBySource.keys()].filter(
      (one) => staleBySource.get(one) !== true,
    );
    const staleSources = [...sensorsBySource.keys()].filter(
      (one) => staleBySource.get(one) === true,
    );
    if (staleSources.length > 0) this.#staleReactions += 1;

    const startedAt = process.hrtime.bigint();
    try {
      const { stored, late, changes, moved, dependents } = await this.#db.tx(async (q) => {
        // Guarded rather than relying on `unnest` of empty arrays: with no readings at all the
        // range below is (+Infinity, -Infinity), and an Invalid Date reaching the backfill
        // queue would corrupt the rollup's idea of what needs re-rolling.
        const written =
          times.length === 0
            ? []
            : await q.query<{ channel_id: number; time: Date }>(
                `INSERT INTO sample (time, channel_id, value)
                 SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::float8[])
                 ON CONFLICT (channel_id, time) DO NOTHING
                 RETURNING channel_id, time`,
                [times, channelIds, values],
              );
        // In the same transaction, deliberately. If this fails the readings roll back with it —
        // which is the right way round: the probe still holds the batch and will offer it again,
        // whereas committed readings with no backfill queued would leave the rollup silently
        // wrong with nothing left to notice it.
        const noted =
          this.#lateData === undefined || times.length === 0
            ? false
            : await this.#lateData.noteWrittenRange(q, new Date(oldest), new Date(newest));
        // Same transaction, same reason: the readings and the state they decided commit
        // together or not at all (M-02).
        // **At the instants the probe measured them** (`P-145`). A spool replay is an hour of
        // genuine history arriving late; stamping it after the newest stored row rewrote the
        // whole outage into consecutive milliseconds, in the table uptime is computed from.
        const appended = await writeStateHistory(
          q,
          transitions,
          this.#onStatesCommitted,
          'as-measured',
        );
        const advanced = await writeRuntimes(q, [...runtimes.values()]);
        // Same transaction, same reason again (`P-107`): a baseline that advanced for readings
        // that were never stored makes the next scan of that counter unmeasurable.
        if (counters.size > 0) await this.#counters.save(q, counters);
        // Last, and in the same transaction: a master's dependents must be paused by the time
        // the master's own Down is visible. Reacting after the commit would leave a window in
        // which a dependent's result arrives, finds itself unpaused, and raises exactly the
        // alarm the dependency exists to suppress (M-11).
        const dependents =
          this.#dependencies === undefined || transitions.length === 0
            ? 0
            : (await this.#dependencies.react(q, transitions, new Date())).moved;
        // After the dependency reaction, and in the same transaction. A chain armed against a
        // state that rolled back would page somebody about a sensor that is fine.
        //
        // **Which sensors depends on what kind of trigger exists** (`P-104`). A state trigger
        // fires on a transition, so the sensors that transitioned are the complete answer for
        // it. A threshold trigger fires on a *reading* — and a reading changes without the
        // state changing, so `transitions.length > 0` meant a breach on a stable Up sensor
        // never armed anything, and a breach that cleared while the sensor stayed Up was never
        // stood down and paged after its latency with a value that was minutes stale.
        //
        // **And not at all while a probe is still catching up** (`P-146`). The chain's clock is
        // not `now`: `arm` takes `initialDueAt(sensor.since, settings)`, and `since` is the
        // *replayed result's* own timestamp. A Down replayed from six hours ago arms with a due
        // time six hours in the past, `onArmed` wakes the scheduler, and the sweep fires within a
        // second — then the escalation on the next sweep, and the repeat after that, because
        // every deadline computed from that `since` is also in the past. The recovery that ended
        // the outage is still in the probe's spool, tens of batches behind: at 5,000 sensors on a
        // 60 s interval a ten-minute outage separates its Down from its Up by roughly
        // twenty-five ingest transactions.
        //
        // So the whole point of the initial latency — "a 30-second blip on a five-minute latency
        // produces no notification at all" — is defeated for every blip a probe spooled, and the
        // operator is paged, escalated and repeated about an outage that ended before the link
        // came back. What it must not do is decide the present twenty-five times on the way
        // there.
        //
        // **But skipped is not the same as forgotten** (`R04`, `G02`). `P-146` skipped the
        // reaction outright, reasoning that the last batch of the drain would decide the present
        // — and the reaction is keyed on *this batch's* transitions, so a sensor that went Down
        // inside a skipped batch and is still Down when the drain ends transitions in no later
        // batch and is armed by nothing. Nobody is paged for an outage that is happening now.
        // The moved ids are held instead and folded in here, so the first live batch reconciles
        // them along with its own.
        //
        // **And per source, because one write carries several probes** (`P-169`). Judging the
        // whole write reconciled a draining probe's replayed rows on the local probe's next live
        // batch — restoring the storm for every installation with more than one probe — and, the
        // other way round, deferred a live probe because a different one was catching up.
        //
        // `reactionTime` in `dependencies/pauses.ts` exists because the dependency reaction had
        // this class of bug; the alarm reaction had no equivalent.
        if (this.#alarms !== undefined && liveSources.length > 0) {
          const live = new Set<number>();
          for (const source of liveSources) {
            for (const id of sensorsBySource.get(source) ?? []) live.add(id);
            for (const id of this.#deferredReactions.get(source) ?? []) live.add(id);
          }
          const widen = await this.#alarms.reconcilesReadings(q);
          const scanned = widen
            ? [...live]
            : [
                ...new Set([
                  ...transitions.map((t) => t.sensorId).filter((id) => live.has(id)),
                  ...liveSources.flatMap((source) => [
                    ...(this.#deferredReactions.get(source) ?? []),
                  ]),
                ]),
              ];
          if (scanned.length > 0) await this.#alarms.react(q, scanned, new Date());
        }
        return {
          stored: written,
          late: noted,
          changes: appended,
          moved: advanced,
          dependents,
        };
      });

      // **After the commit, because a rolled-back write decided nothing.** Held for a source
      // whose batch was a replay, dropped for one whose was not — every id dropped here was in
      // that reaction's `scanned` (`R04`, `G02`, `P-169`). Only while there is an alarm engine
      // to defer *to*; without one the map would grow for the life of the process and be read
      // by nobody.
      if (this.#alarms !== undefined) {
        for (const source of staleSources) {
          const held = this.#deferredReactions.get(source) ?? new Set();
          for (const transition of transitions) {
            if (sensorsBySource.get(source)?.has(transition.sensorId) === true) {
              held.add(transition.sensorId);
            }
          }
          if (held.size > 0) this.#deferredReactions.set(source, held);
        }
        for (const source of liveSources) this.#deferredReactions.delete(source);
      }

      this.#record(Number(process.hrtime.bigint() - startedAt) / 1e6);
      this.#queuedRows -= rows;
      this.#writes += 1;
      this.#storedSamples += stored.length;
      this.#duplicateSamples += rows - stored.length;
      this.#storedStateChanges += changes;
      this.#runtimeWrites += moved;
      this.#staleRuntimeWrites += runtimes.size - moved;
      this.#dependencyPauses += dependents;
      // After the commit, never inside it: the probes are told about a tree that exists.
      if (dependents > 0) this.#onDependencyChange?.();
      if (late) {
        this.#backfillsQueued += 1;
        this.#logger.info(
          { from: new Date(oldest).toISOString(), to: new Date(newest).toISOString() },
          'readings landed behind the rollup watermark, backfill queued',
        );
      }

      // Which rows landed, so each batch is told the truth about its own readings rather than a
      // share of the write's total. Duplicates are normal on replay and worth reporting exactly.
      const landed = new Set(stored.map((row) => key(row.channel_id, row.time)));
      const retryAfterMs = this.#retryHint();
      for (const queued of taken) {
        // Counted once per distinct reading: a batch that repeats (channel, time) writes one
        // row, and reporting two would overstate what was stored.
        const counted = new Set<string>();
        for (const sample of queued.batch.samples) {
          const id = key(sample.channelId, sample.at);
          if (landed.has(id)) counted.add(id);
        }
        queued.settle({ accepted: true, storedSamples: counted.size, retryAfterMs });
      }
    } catch (error: unknown) {
      this.#record(Number(process.hrtime.bigint() - startedAt) / 1e6);
      this.#queuedRows -= rows;
      this.#failedBatches += taken.length;
      this.#logger.error(
        { err: describeError(error), batches: taken.length, rows },
        'ingestion write failed',
      );
      // The rows are gone from our queue but not from the probe's spool: it was never
      // acknowledged, so it will offer them again. Nothing is lost, and the failure is counted.
      for (const queued of taken) {
        queued.settle({
          accepted: false,
          reason: 'storage-error',
          retryAfterMs: this.#config.retryAfterMs,
        });
      }
    }
  }

  #record(ms: number): void {
    this.#latencies.push(ms);
    if (this.#latencies.length > LATENCY_WINDOW) this.#latencies.shift();
  }

  #idlePromise(): Promise<void> {
    this.#idle ??= new Promise<void>((resolve) => {
      this.#idleResolve = resolve;
    });
    return this.#idle;
  }

  #settleIdle(): void {
    this.#idleResolve?.();
    this.#idle = undefined;
    this.#idleResolve = undefined;
  }
}

function key(channelId: number, at: Date): string {
  return `${String(channelId)}:${String(at.getTime())}`;
}

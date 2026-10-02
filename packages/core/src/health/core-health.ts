import { CORE_HEALTH_CHANNELS, CORE_HEALTH_COUNTERS } from '@ms/sensors';
import {
  CpuMeter,
  DeltaMeter,
  describeError,
  type ChannelReading,
  type CheckResult,
  type AvailableMemoryLow,
  type Logger,
  type LogOutputStats,
} from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { storedVoucher, type VoucherCheck } from '../objects/vouching.js';
import { ROLLUP_TIERS } from '../timeseries/tiers.js';
import { CORE_CLOCK_BEHIND_SECONDS, judgeCoreClock, type CoreClockVerdict } from './core-clock.js';

/**
 * The Core Health sensor's readings (`P-12`).
 *
 * **This is where `CLAUDE.md`'s "the system monitors itself" stops being a rule and becomes a
 * sensor.** Every subsystem with a queue, a pool or a connection has been adding a `stats()` for
 * this ticket; here they become channels with history, limits, triggers and alarms, on the same
 * path a probe's readings take.
 *
 * **Nothing is computed here that a subsystem already computes.** Delivery health is read from
 * `DeliveryHealthReader` rather than recounted, so the sensor and `GET /notification-health`
 * cannot disagree about whether alarms are going out; the rollup lag is read from
 * `rollup_watermark`, which is what the housekeeper itself steers by. A second implementation of
 * a health question is a second answer to it.
 */

/** What this needs from the rest of the core. Small on purpose: every one is a fake in a test. */
export interface CoreHealthSources {
  /** `Ingestor.stats()` — the queue, what it refused, and how long writes are taking. */
  ingestion: () => {
    queuedRows: number;
    refusedRows: number;
    dependencyPauses: number;
    /** Sensors whose alarm reaction is waiting for a batch that is not a replay (`P-157`). */
    deferredReactions: number;
    writeMs: { p95: number };
  };
  /**
   * `StateBroadcaster.stats()` — subscribers cut off for falling behind, sockets closed to protect
   * the core (`A-30`), sockets signed out and the checks that could not say (`A-34`), and probe
   * changes folded into a frame a watcher had not yet taken (`U-24`).
   */
  stream: () => {
    overflowed: number;
    severed: number;
    probeCoalesced: number;
    signedOut: Readonly<Record<'ended' | 'expired' | 'revoked' | 'disabled', number>>;
    credentialCheckFailures: number;
    /** Sockets closed to reconnect because their check could not be made (`U-26`). */
    unsure: number;
    /** The sweep's own queries that have not answered (`U-26`). */
    checksOutstanding: number;
  };
  /** `ProbeReachability.stats()` — probes the core is not currently connected to. */
  probes: () => { probesDown: number; probesSilent: number };
  /**
   * `AlarmScheduler.stats` — steps fired, and how far past its wake the scheduler is (`P-22`),
   * measured on the monotonic clock its timer runs on (`P-247`).
   */
  alarms: () => { fired: number; overdueMs: number };
  /** `ProbeQueryService.stats()` — on-demand checks turned away at the bound (`R-09`). */
  queries: () => { refused: number };
  /**
   * `ReportRunner.stats()` — the report sweep's queue and its failures (`E-08`).
   *
   * A report is the longest-running thing this core does and the only one that runs unattended
   * for minutes at a time, so it is a subsystem with a pool and a queue — `CLAUDE.md` says one of
   * those adds a metric here. `deferred` is the backpressure: reports the sweep found due and
   * could not start because the bound was reached. `failed` is the one an operator acts on — a
   * report that has failed every night for a week is otherwise discovered by somebody asking
   * where the report is. `undelivered` is `E-09`'s half of the same rule: a report that rendered
   * and is still waiting on a mail relay is neither a success nor yet a failure, and a gauge is
   * the only shape that says "this is piling up" while it still is.
   *
   * **Absent in a build that has no reporting** (`H-12`): the v1 profile constructs none of it,
   * and its five channels are gaps there rather than zeros — a zero would say that nothing failed,
   * which is a claim about a subsystem that is not running.
   */
  reports?: () => {
    deferred: number;
    failed: number;
    undelivered: number;
    /**
     * `ReportFormatter.stats()` (`P-204`) — documents waiting for a formatting worker, and those
     * turned away because the queue was full. The pool is new and has a queue, which is exactly
     * what `CLAUDE.md` says adds a line here: a queue that fills up silently is a render button that
     * starts failing with nobody able to say why.
     */
    formatsWaiting: number;
    formatsRefused: number;
  };
  /**
   * `IngestionService.stats()` — results refused because their clock was implausible (`P-99`).
   *
   * The only one of that service's discard counters on this sensor, and deliberately: the others
   * describe a batch that was rejected and will be re-offered, while this one describes data
   * that is gone and a probe host that needs its clock fixed.
   */
  ingestionDiscards: () => {
    discardedFutureTime: number;
    discardedPastTime: number;
    /** Results whose timestamp could not be read at all, dropped whole (`P-247`). */
    discardedUnreadableTime: number;
  };
  /**
   * The clock offsets of the connected probes that are not the local one, in milliseconds as
   * `ProbeLink.clockOffsetMs` carries them (`remoteClockOffsets`), from which Core Health judges
   * whether its own clock is the one behind (`P-247`). Absent, and the channel gaps, where there
   * are no probes to compare with.
   */
  probeClocks?: (q: Queryable) => Promise<readonly (number | null)[]>;
  /**
   * `ApiServer.hostStats()` — requests refused for a `Host` this core does not answer to, since
   * it started (`A-47`). Absent where there is no API to refuse them, and the channel gaps.
   */
  hosts?: () => { refused: number };
  /**
   * `ApiServer.rateLimitStats()` — requests the per-client rate limit refused, since it started
   * (`A-39`). Absent, or answering nothing, where no limit is registered, and the channel gaps.
   */
  rateLimit?: () => { refused: number } | undefined;
  /**
   * `Heartbeat.stats()` — heartbeats that were due and did not reach their receiver, since the
   * core started (`H-18`). Absent where no `heartbeat.url` is set, and the channel gaps: a
   * heartbeat nobody configured has not failed zero times.
   */
  heartbeat?: () => { failures: number };
  /**
   * The last housekeeping pass's view of the disk (`S-17`).
   *
   * Read from the *report* rather than measured here, and that is deliberate: the number Core
   * Health shows has to be the number eviction acted on. Two independent `statfs` calls a few
   * seconds apart would disagree during exactly the incident this channel exists for, and an
   * operator comparing the graph with the log would be told two different stories.
   *
   * Null until the first pass, and on any core that cannot honestly speak for a disk.
   */
  disk: () => { freePercent: number; freeBytes: number; databaseBytes: number } | null;
  /** Chunks dropped ahead of the configured retention because the disk was filling (`S-17`). */
  evictedChunks: () => number;
  /**
   * How much this core's machine has left — the lowest in the last thirty seconds (`P-208`).
   *
   * Null where the platform cannot say, and before the first sample. A `MachineMemoryWatch`
   * sampled on a timer of its own, because this service is only read every thirty seconds and a
   * squeeze that ends in a kill can be shorter than that.
   */
  machineMemory: () => AvailableMemoryLow | null;
  /**
   * How close the core's own cgroup is to its memory ceiling — the lowest headroom in the last
   * thirty seconds (`P-210`). Null where there is no ceiling, and before the first sample.
   */
  limitMemory: () => AvailableMemoryLow | null;
  /**
   * The core's log output (`P-216` part 3): lines it dropped since the core started, and what it
   * holds that the journal has not taken. Absent under `logPretty`, and the channels gap.
   */
  log?: () => LogOutputStats;
  /**
   * The same running total from the probe beside the core (`probe_config.is_local`), from its
   * latest heartbeat, or null when there is none or it does not report one.
   *
   * **One journal, one alarm** (`M-21`'s rule). On a single host both services write to the same
   * journald, and a journal that stops reading makes both drop at once: Probe Health and Core
   * Health warning together would be two alarms for one stall. Core Health owns it, as it owns the
   * machine's memory, and its `logDropped` counts the local probe's lines with its own; the local
   * probe's `logDropped` gaps. A probe on its own host keeps its own.
   */
  localProbeLog?: (q: Queryable) => Promise<LocalProbeLog | null>;
  /**
   * `CredentialVault.setsWithUndeclaredKeys` — the credential sets written before writes were
   * checked against their kind that hold a key it does not declare (`A-43`). Counted at every
   * reading rather than once at start-up, so it falls as the sets are re-entered.
   */
  credentialsToReenter: (q: Queryable) => Promise<number>;
  /**
   * `CredentialVault.unboundedSets` — the credential sets with no allowed targets and no SSH host
   * keys, which go wherever somebody with `write` on their owner vouches for (`A-41b`). A count to
   * read, not a warning: most installations start with every set unbounded, and a channel that
   * warned from the first reading would be one nobody looks at.
   */
  unboundedCredentials?: (q: Queryable) => Promise<number>;
  /**
   * `CredentialVouching.stats().withheld` — sensors not being scanned because of their
   * credentials (`A-41`, `A-41b`, `A-41c`): withheld from their probe by the core, or refused by
   * the probe, which found the device's name resolving outside the set's targets.
   */
  credentialsWithheld?: () => number;
  /**
   * `CredentialVouching.stats().recordWritesGivenUp` — writes of the late-refusal record that
   * gave way, were not waited for, or failed (`A-68`). A running total; the channel is a counter.
   */
  lateRefusalWritesGivenUp?: () => number;
  /** `DeliveryHealthReader.read()` — undelivered alarms, and how old the oldest one is. */
  delivery: (q: Queryable) => Promise<{
    pending: number;
    failed: number;
    oldestPendingAgeMs: number;
  }>;
}

export interface CoreHealthServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly sources: CoreHealthSources;
  /** Where results go. The same entry point a probe's batch uses. */
  readonly ingest: (results: readonly CheckResult[]) => Promise<void>;
  /**
   * Asked before a sensor is read, whether whoever vouched for it may still read the root
   * (`A-29`) — the bar `/core-health` has, which a sensor must not go on getting around.
   */
  readonly vouching: VoucherCheck;
  readonly now?: () => Date;
  /** Process counters, injectable so a test does not measure the test runner. */
  readonly process?: {
    cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
    memoryUsage: () => { rss: number; heapUsed: number };
    uptime: () => number;
    hrtime: () => bigint;
  };
}

export interface CoreHealthStats {
  readonly sweeps: number;
  readonly evaluated: number;
  readonly failed: number;
  /** Sensors not read because of who vouched for them (`A-29`), counted per sweep. */
  readonly withheld: number;
}

/** One reading of every channel. `null` is a gap and stays one — never a zero (`CLAUDE.md`). */
export type CoreHealthReading = Readonly<Record<string, number | null>>;

const HEALTH_TYPE = 'ms.core.health';

/** The local probe's running total of log lines dropped, from its latest heartbeat (`P-216`). */
export interface LocalProbeLog {
  readonly droppedLines: number;
  readonly uptimeSeconds: number;
  /** When its session connected, in epoch ms: a new session starts a new baseline (`P-250`). */
  readonly session: number;
}

/**
 * One reader's baselines (`CpuMeter`'s reason, `P-216` part 3): CPU, the log's drops and refused
 * `Host`s are each the difference between two readings, and each reading consumes the one before.
 * The sweep, the route and a scrape each hold their own, so none shortens another's interval.
 */
export class CoreHealthMeters {
  readonly cpu = new CpuMeter();
  readonly log = new DeltaMeter();
  localProbeLog: { readonly meter: DeltaMeter; readonly session: number } | undefined;
  readonly hosts = new DeltaMeter();
  readonly rateLimit = new DeltaMeter();
  readonly heartbeat = new DeltaMeter();
}

const MB = 1024 * 1024;

export class CoreHealthService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #sources: CoreHealthSources;
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly #vouching: VoucherCheck;
  readonly #now: () => Date;
  readonly #process: NonNullable<CoreHealthServiceOptions['process']>;

  /**
   * Two CPU meters, and the second one is not redundant.
   *
   * CPU is a *rate*, so it needs a previous sample — and each reading consumes the previous one.
   * A single meter shared between the sweep and the route would mean a dashboard polling
   * `/core-health` every two seconds silently turned the *recorded* channel into a two-second
   * sample: every reading honest, the history noisier for being watched. Two baselines keep the
   * sensor's history a thirty-second average whatever anyone is doing to the route.
   */
  readonly #sweepMeters = new CoreHealthMeters();
  readonly #liveMeters = new CoreHealthMeters();

  #sweeps = 0;
  #evaluated = 0;
  #failed = 0;
  #withheld = 0;

  constructor(options: CoreHealthServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'core-health' });
    this.#sources = options.sources;
    this.#ingest = options.ingest;
    this.#vouching = options.vouching;
    this.#now = options.now ?? ((): Date => new Date());
    this.#process = options.process ?? {
      cpuUsage: (previous?: NodeJS.CpuUsage) => process.cpuUsage(previous),
      memoryUsage: () => process.memoryUsage(),
      uptime: () => process.uptime(),
      hrtime: () => process.hrtime.bigint(),
    };
  }

  stats(): CoreHealthStats {
    return {
      sweeps: this.#sweeps,
      evaluated: this.#evaluated,
      failed: this.#failed,
      withheld: this.#withheld,
    };
  }

  /**
   * Every channel, read now.
   *
   * Public and independent of whether a sensor exists, because `GET /api/v1/core-health` serves
   * it — an operator must be able to ask how the core is without first having created a sensor,
   * and the answer has to survive the case where writing a sensor's reading is exactly what is
   * broken.
   */
  async read(
    meters: CoreHealthMeters = this.#liveMeters,
    /**
     * Whether an unreachable database is a gap rather than a failure (`P-126`).
     *
     * **Two callers, two right answers.** The sweep writes a *sensor reading*, and a Core Health
     * sensor whose numbers are unavailable must fail with a message and no channel values — a row
     * of zeros is what a perfectly idle, perfectly healthy core looks like. `GET /core-health` is
     * the other case: an operator asking how the core is, at the moment it is least well, was
     * answered 500 — losing the CPU, the memory and the ingest queue too, none of which need a
     * database at all. There the database-backed channels become gaps and the rest answers.
     */
    degradeOnDatabaseError = false,
  ): Promise<CoreHealthReading> {
    return (await this.#read(meters, degradeOnDatabaseError)).reading;
  }

  /** The reading, and the parked backfill's error, which is words and not a channel. */
  async #read(
    meters: CoreHealthMeters,
    degradeOnDatabaseError: boolean,
    /** The sweep's, taken before anything could skip the reading (`P-250`); a route takes its own. */
    takenLogDropped?: number | null,
  ): Promise<{ reading: CoreHealthReading; parkedError: string | null }> {
    const now = this.#now();
    const ingestion = this.#sources.ingestion();
    const stream = this.#sources.stream();
    const probes = this.#sources.probes();
    const alarms = this.#sources.alarms();
    const queries = this.#sources.queries();
    const reports = this.#sources.reports?.() ?? null;
    const disk = this.#sources.disk();
    const machine = this.#sources.machineMemory();
    const limit = this.#sources.limitMemory();
    const log = this.#sources.log?.();
    const hosts = this.#sources.hosts?.();
    const rateLimit = this.#sources.rateLimit?.();
    const heartbeat = this.#sources.heartbeat?.();

    const memory = this.#process.memoryUsage();
    const queues = await this.#queues(now, degradeOnDatabaseError);
    const uptime = this.#process.uptime();
    const dropped =
      takenLogDropped === undefined ? await this.#takeLogDropped(meters) : takenLogDropped;
    const coreClock = await this.#coreClock();

    const discards = this.#sources.ingestionDiscards();
    const reading: CoreHealthReading = {
      ingestQueue: ingestion.queuedRows,
      writeLatency: ingestion.writeMs.p95,
      ingestRefused: ingestion.refusedRows,
      cpu: this.#cpuPercent(meters.cpu),
      memory: round(memory.rss / MB, 1),
      heap: round(memory.heapUsed / MB, 1),
      // Gaps, not zeros, where the platform cannot say: a zero is this channel's error limit.
      memoryAvailable: machine === null ? null : machine.availablePercent,
      memoryAvailableBytes: machine === null ? null : round(machine.availableBytes / MB, 1),
      // Gaps where the core has no ceiling to be near: no limit, cgroup v1, or not Linux.
      memoryLimitUsage: limit === null ? null : round(100 - limit.availablePercent, 1),
      memoryLimit: limit === null ? null : round(limit.totalBytes / MB, 1),
      uptime: Math.round(uptime),
      rollupLag: queues.rollup,
      backfillQueue: queues.backfill,
      backfillParked: queues.parked.count,
      // Gaps, not zeros, when this core has no disk it can speak for. `CLAUDE.md`: a Down sensor
      // records no channel values, and a channel that cannot be measured is the same case.
      diskFree: disk === null ? null : disk.freePercent,
      diskFreeBytes: disk === null ? null : round(disk.freeBytes / MB, 1),
      databaseSize: disk === null ? null : round(disk.databaseBytes / MB, 1),
      evictedChunks: this.#sources.evictedChunks(),
      reapQueue: queues.reap,
      notifyPending: queues.delivery.pending,
      notifyOldest:
        queues.delivery.oldestPendingAgeMs === null
          ? null
          : Math.round(queues.delivery.oldestPendingAgeMs / 1_000),
      notifyFailed: queues.delivery.failed,
      // Subscribers cut off, and sockets closed outright (`A-30`): a client the core stopped
      // serving either way.
      streamCutoffs: stream.overflowed + stream.severed,
      // Not a cut-off: nothing was lost and nobody was detached. Its own number (`U-24`).
      streamCoalesced: stream.probeCoalesced,
      // Signed out, by why, and the checks that could not say (`A-34`).
      streamEnded: stream.signedOut.ended,
      streamExpired: stream.signedOut.expired,
      streamRevoked: stream.signedOut.revoked,
      streamDisabled: stream.signedOut.disabled,
      streamCheckFailures: stream.credentialCheckFailures,
      // Closed to reconnect on a check that failed, and the sweep's questions still out (`U-26`).
      streamUnsure: stream.unsure,
      streamChecksOutstanding: stream.checksOutstanding,
      dependencyPauses: ingestion.dependencyPauses,
      probesDown: probes.probesDown,
      probesSilent: probes.probesSilent,
      // Never negative: a wake that is still ahead is not "minus forty seconds overdue", it is
      // on time. A scheduler that has never armed anything has no wake at all, which is also on
      // time — a gap here would read as "unknown" for a state that is simply quiet. The
      // scheduler's own figure, on its timer's clock, so a wall-clock step is not lateness
      // (`P-247`).
      alarmOverdue: Math.round(alarms.overdueMs / 1_000),
      alarmsFired: alarms.fired,
      queriesRefused: queries.refused,
      reportsDeferred: reports === null ? null : reports.deferred,
      reportsFailed: reports === null ? null : reports.failed,
      reportsUndelivered: reports === null ? null : reports.undelivered,
      reportFormatsWaiting: reports === null ? null : reports.formatsWaiting,
      reportFormatsRefused: reports === null ? null : reports.formatsRefused,
      resultsFutureDated: discards.discardedFutureTime,
      resultsPastDated: discards.discardedPastTime,
      resultsUnreadableTime: discards.discardedUnreadableTime,
      // Seconds behind every remote probe, two or more of them (`P-247`); a gap with fewer.
      clockBehind: coreClock.behindSeconds,
      reactionsDeferred: ingestion.deferredReactions,
      credentialsToReenter: queues.credentials,
      credentialsUnbounded: queues.unbounded,
      credentialsWithheld: this.#sources.credentialsWithheld?.() ?? null,
      lateRefusalWritesGivenUp: this.#sources.lateRefusalWritesGivenUp?.() ?? null,
      logDropped: dropped,
      logBacklog: log === undefined ? null : round(log.backlogBytes / MB, 2),
      // Since the last reading, and the whole count on the first: the total started with this
      // process, as the meter did.
      hostsRefused: hosts === undefined ? null : meters.hosts.take(hosts.refused, uptime, true),
      // The same shape: refused since the last reading, and the whole count on the first.
      rateLimited:
        rateLimit === undefined ? null : meters.rateLimit.take(rateLimit.refused, uptime, true),
      // And again: failed since the last reading, and the whole count on the first (`H-18`).
      heartbeatFailures:
        heartbeat === undefined ? null : meters.heartbeat.take(heartbeat.failures, uptime, true),
    };
    return { reading, parkedError: queues.parked.lastError };
  }

  /**
   * One sweep: read once, and report it to every Core Health sensor there is.
   *
   * **Read once however many sensors exist.** The numbers are facts about this process, so two
   * sensors reading them a millisecond apart would differ for no reason an operator could act on,
   * and the two queries would be run twice for the same answer.
   */
  async sweep(): Promise<number> {
    this.#sweeps += 1;
    // **The log's baselines, whether or not anything is recorded** (`P-250`). Taken only when a
    // sensor was read, a core with no Core Health sensor, or only withheld ones, gave the sensor
    // added days later a count of every line dropped since it started, stamped now: a warning for
    // a stall long over. What this sweep does not record is let go, and is a gap.
    const takenLogDropped = await this.#takeLogDropped(this.#sweepMeters);
    const every = await this.#db.query<{
      id: string;
      params: Record<string, unknown>;
      vouched_by: string;
      vouched_by_user: string | null;
    }>(
      `SELECT object_id::text AS id, params, vouched_by, vouched_by_user::text AS vouched_by_user
       FROM sensor_config WHERE type = $1`,
      [HEALTH_TYPE],
    );
    // Settled even when there are none, so a sensor withheld last sweep and deleted since is let
    // go. A withheld one is not read and records nothing: a gap, and Unknown (`A-29`).
    const withheld = await this.#vouching.refusals(
      every.map((row) => ({
        sensorId: Number(row.id),
        sensorType: HEALTH_TYPE,
        params: row.params,
        enclosingProbeId: null,
        voucher: storedVoucher(row.vouched_by, row.vouched_by_user),
      })),
    );
    await this.#vouching.settle('core-health', withheld);
    const sensors = every.filter((row) => !withheld.has(Number(row.id)));
    this.#withheld += every.length - sensors.length;
    if (sensors.length === 0) return 0;

    // ISO-8601 on the wire, exactly as a probe's result carries it: these go through
    // `acceptResults` unchanged, and a second shape would be a second code path.
    const at = this.#now().toISOString();
    let reading: CoreHealthReading;
    let parkedError: string | null;
    try {
      ({ reading, parkedError } = await this.#read(this.#sweepMeters, false, takenLogDropped));
    } catch (error: unknown) {
      // **The sensor fails rather than the sweep**, and it fails with a message. A Core Health
      // sensor that silently stopped reporting is the failure this whole ticket exists to make
      // impossible; `outcome: 'error'` carries no channel values, so the graphs gap rather than
      // reading zero.
      this.#failed += sensors.length;
      // Logged as well as recorded. The sensor's own message reaches whoever is looking at the
      // sensor; the log reaches whoever is looking at the core, and this failure is more likely
      // to be found from that end.
      this.#logger.error({ ...describeError(error) }, 'Core Health could not read its own numbers');
      const results: CheckResult[] = sensors.map((row) => ({
        sensorId: Number(row.id),
        at,
        outcome: 'error' as const,
        durationMs: 0,
        channels: [],
        message: `Core Health could not read its own numbers: ${messageOf(error)}`,
      }));
      await this.#ingest(results);
      return results.length;
    }

    const channels = readingsFrom(reading);
    const results: CheckResult[] = sensors.map((row) => ({
      sensorId: Number(row.id),
      at,
      outcome: 'ok' as const,
      durationMs: 0,
      channels,
      message: describe(reading, parkedError),
    }));
    this.#evaluated += results.length;
    await this.#ingest(results);
    return results.length;
  }

  /**
   * The log lines dropped since these meters were last taken, the core's and the local probe's.
   * The local probe's part is a gap where the database cannot say which probe that is.
   */
  /** Whether this core's clock is behind every remote probe's (`P-247`), or a gap. */
  async #coreClock(): Promise<CoreClockVerdict> {
    if (this.#sources.probeClocks === undefined) return { behindSeconds: null, owned: false };
    try {
      return judgeCoreClock(await this.#sources.probeClocks(this.#db));
    } catch (error: unknown) {
      this.#logger.warn(
        { err: describeError(error) },
        "core health could not read the probes' clocks; clockBehind is a gap",
      );
      return { behindSeconds: null, owned: false };
    }
  }

  async #takeLogDropped(meters: CoreHealthMeters): Promise<number | null> {
    let local: LocalProbeLog | null = null;
    try {
      local = (await this.#sources.localProbeLog?.(this.#db)) ?? null;
    } catch (error: unknown) {
      this.#logger.warn(
        { err: describeError(error) },
        "core health could not read the local probe's log; its part of logDropped is a gap",
      );
    }
    return logDropped(meters, this.#sources.log?.(), local, this.#process.uptime());
  }

  /**
   * CPU as a percentage of one core, over the interval since the last reading.
   *
   * Over 100 on a core using more than one thread, which is correct and deliberate: normalising
   * by core count would report a core saturating one thread as "12% busy" on a sixteen-core box,
   * and a single-threaded event loop at its ceiling is precisely the thing worth alarming on.
   */
  #cpuPercent(meter: CpuMeter): number | null {
    return meter.percent(this.#process.cpuUsage(), this.#process.hrtime());
  }

  /**
   * How far behind the worst rollup tier is, in seconds, *beyond its own bucket width*.
   *
   * The subtraction is the whole point. A one-day tier can only ever be materialised to the last
   * complete day, so `now - watermark` is up to 24 hours on a perfectly healthy installation, and
   * a channel carrying that would compare a healthy 1d tier unfavourably with a broken 5m one.
   * What is worth watching is the excess over the floor, which is zero on every tier that is
   * keeping up whatever its width.
   *
   * A tier that has never run has no row, and that is a gap rather than an infinite lag: a core
   * that started a minute ago has not fallen behind.
   */
  /**
   * The channels that need a database, or gaps where it could not be reached (`P-126`).
   *
   * Logged at warn rather than silently: a health reader that quietly reports gaps for an hour is
   * indistinguishable from a subsystem that has nothing to say.
   */
  async #queues(
    now: Date,
    degrade: boolean,
  ): Promise<{
    delivery: { pending: number | null; oldestPendingAgeMs: number | null; failed: number | null };
    rollup: number | null;
    backfill: number | null;
    parked: { count: number | null; lastError: string | null };
    reap: number | null;
    credentials: number | null;
    unbounded: number | null;
  }> {
    try {
      return await this.#db.tx(async (q) => ({
        delivery: await this.#sources.delivery(q),
        rollup: await this.#rollupLag(q, now),
        backfill: await count(q, 'SELECT count(*)::int AS n FROM rollup_backfill'),
        parked: await parkedBackfill(q),
        reap: await count(q, 'SELECT count(*)::int AS n FROM channel_reap'),
        credentials: await this.#sources.credentialsToReenter(q),
        unbounded:
          this.#sources.unboundedCredentials === undefined
            ? null
            : await this.#sources.unboundedCredentials(q),
      }));
    } catch (error: unknown) {
      if (!degrade) throw error;
      this.#logger.warn(
        { err: describeError(error) },
        'core health could not read the database; its queue channels are gaps for this reading',
      );
      return {
        delivery: { pending: null, oldestPendingAgeMs: null, failed: null },
        rollup: null,
        backfill: null,
        parked: { count: null, lastError: null },
        reap: null,
        credentials: null,
        unbounded: null,
      };
    }
  }

  async #rollupLag(q: Queryable, now: Date): Promise<number | null> {
    const rows = await q.query<{ tier: string; watermark: Date }>(
      'SELECT tier, watermark FROM rollup_watermark',
    );
    if (rows.length === 0) return null;
    const held = new Map(rows.map((row) => [row.tier, row.watermark]));
    let worst: number | null = null;
    for (const tier of ROLLUP_TIERS) {
      const watermark = held.get(tier.id);
      if (watermark === undefined) continue;
      const behind = (now.getTime() - watermark.getTime()) / 1_000 - tier.bucketSeconds;
      const excess = Math.max(0, Math.round(behind));
      worst = worst === null ? excess : Math.max(worst, excess);
    }
    return worst;
  }
}

/**
 * The reading as channel readings.
 *
 * **A `null` is left out rather than sent as zero**, which is `CLAUDE.md`'s rule and the one thing
 * this conversion must not get wrong: a CPU channel reading 0% because it has not been measured
 * yet is indistinguishable, on a graph and to a limit, from a core that is idle.
 */
export function readingsFrom(reading: CoreHealthReading): ChannelReading[] {
  const out: ChannelReading[] = [];
  for (const key of CORE_HEALTH_CHANNELS) {
    const value = reading[key];
    if (value === undefined || value === null || !Number.isFinite(value)) continue;
    out.push(
      CORE_HEALTH_COUNTERS.has(key)
        ? // Declared counters, so the core's counter path turns them into rates (`T-02`). The
          // exact value goes as text for the same reason every other counter does.
          { key, value, counter: String(Math.trunc(value)), counterBits: 64 }
        : { key, value },
    );
  }
  return out;
}

/** The one line an operator reads in a list, naming what is not zero. */
function describe(reading: CoreHealthReading, parkedError: string | null = null): string {
  const parts: string[] = [];
  const queue = reading['ingestQueue'];
  parts.push(queue === null || queue === undefined ? 'queue unknown' : `${String(queue)} queued`);
  const write = reading['writeLatency'];
  // Rounded here and not in the channel: a sentence saying "writes 20.077 ms" is precision
  // nobody reads, while the channel it came from is a graph where the decimals are the point.
  if (write !== null && write !== undefined) parts.push(`writes ${String(Math.round(write))} ms`);
  const pending = reading['notifyPending'];
  if (pending !== null && pending !== undefined && pending > 0) {
    parts.push(`${String(pending)} notifications undelivered`);
  }
  const lag = reading['rollupLag'];
  if (lag !== null && lag !== undefined && lag > 0) parts.push(`rollup ${String(lag)} s behind`);
  const overdue = reading['alarmOverdue'];
  if (overdue !== null && overdue !== undefined && overdue > 0) {
    parts.push(`alarm sweep ${String(overdue)} s overdue`);
  }
  const behind = reading['clockBehind'];
  if (behind !== null && behind !== undefined && behind > CORE_CLOCK_BEHIND_SECONDS) {
    parts.push(`this core's clock is ${String(Math.round(behind))} s behind every probe's`);
  }
  const down = reading['probesDown'];
  if (down !== null && down !== undefined && down > 0) parts.push(`${String(down)} probes down`);
  const silent = reading['probesSilent'];
  if (silent !== null && silent !== undefined && silent > 0) {
    parts.push(`${String(silent)} connected but not delivering`);
  }
  // Last, because it carries a sentence of its own: the parked entry's error, which is what an
  // operator needs and what the channel's limit cannot say (`P-226`).
  const parked = reading['backfillParked'];
  if (parked !== null && parked !== undefined && parked > 0) {
    const what = `${String(parked)} rollup backfill${parked === 1 ? '' : 's'} parked`;
    parts.push(parkedError === null ? what : `${what}, the last failing with: ${parkedError}`);
  }
  return parts.join(', ');
}

/**
 * Log lines dropped since the last reading: the core's own, and the local probe's (`P-216` part 3).
 *
 * **A count per reading, not the running total** — a total would warn for ever after one stall —
 * and not a counter channel's rate, which gaps on the first reading after a restart and so misses
 * the lines dropped in the stall that caused it. The core's own first reading is its whole total:
 * the meter started with the process. The local probe's counts in full only when it started after
 * this core did; a probe running from before gaps its part for one reading, since the core before
 * this one may have recorded it. A gap in one part leaves the other; a gap in both is a gap.
 */
function logDropped(
  meters: CoreHealthMeters,
  own: LogOutputStats | undefined,
  local: LocalProbeLog | null,
  uptime: number,
): number | null {
  const mine = own === undefined ? null : meters.log.take(own.droppedLines, uptime, true);
  let theirs: number | null = null;
  if (local !== null) {
    const held = meters.localProbeLog;
    if (held === undefined || held.session !== local.session) {
      // A probe first met counts in full only if it started after this core did; one met again on
      // a new session gaps, since what it dropped while away fell in no reading (`P-250`).
      const meter = new DeltaMeter();
      meters.localProbeLog = { meter, session: local.session };
      theirs = meter.take(
        local.droppedLines,
        local.uptimeSeconds,
        held === undefined && local.uptimeSeconds < uptime,
      );
    } else {
      theirs = held.meter.take(local.droppedLines, local.uptimeSeconds, false);
    }
  }
  if (mine === null && theirs === null) return null;
  return (mine ?? 0) + (theirs ?? 0);
}

/** How many backfills are parked, and the error of the one that failed last (`P-226`). */
async function parkedBackfill(q: Queryable): Promise<{ count: number; lastError: string | null }> {
  const rows = await q.query<{ n: number; last_error: string | null }>(
    `SELECT count(*)::int AS n,
            (array_agg(last_error ORDER BY failed_at DESC, id DESC))[1] AS last_error
     FROM rollup_backfill
     WHERE retry_at IS NOT NULL`,
  );
  return { count: rows[0]?.n ?? 0, lastError: rows[0]?.last_error ?? null };
}

async function count(q: Queryable, sql: string): Promise<number> {
  const rows = await q.query<{ n: number }>(sql);
  return rows[0]?.n ?? 0;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { CORE_HEALTH_CHANNELS, CORE_HEALTH_COUNTERS } from '@ms/sensors';
import {
  CpuMeter,
  describeError,
  type ChannelReading,
  type CheckResult,
  type Logger,
} from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { ROLLUP_TIERS } from '../timeseries/tiers.js';

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
    writeMs: { p95: number };
  };
  /** `StateBroadcaster.stats()` — subscribers cut off for falling behind. */
  stream: () => { overflowed: number };
  /** `ProbeReachability.stats()` — probes the core is not currently connected to. */
  probes: () => { probesDown: number; probesSilent: number };
  /** `AlarmScheduler.stats` — steps fired, and when it next means to look (`P-22`). */
  alarms: () => { fired: number; nextWakeAt: Date | null };
  /** `ProbeQueryService.stats()` — on-demand checks turned away at the bound (`R-09`). */
  queries: () => { refused: number };
  /**
   * `IngestionService.stats()` — results refused because their clock was implausible (`P-99`).
   *
   * The only one of that service's discard counters on this sensor, and deliberately: the others
   * describe a batch that was rejected and will be re-offered, while this one describes data
   * that is gone and a probe host that needs its clock fixed.
   */
  ingestionDiscards: () => { discardedFutureTime: number };
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
}

/** One reading of every channel. `null` is a gap and stays one — never a zero (`CLAUDE.md`). */
export type CoreHealthReading = Readonly<Record<string, number | null>>;

const HEALTH_TYPE = 'ms.core.health';

const MB = 1024 * 1024;

export class CoreHealthService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #sources: CoreHealthSources;
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
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
  readonly #sweepCpu = new CpuMeter();
  readonly #liveCpu = new CpuMeter();

  #sweeps = 0;
  #evaluated = 0;
  #failed = 0;

  constructor(options: CoreHealthServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'core-health' });
    this.#sources = options.sources;
    this.#ingest = options.ingest;
    this.#now = options.now ?? ((): Date => new Date());
    this.#process = options.process ?? {
      cpuUsage: (previous?: NodeJS.CpuUsage) => process.cpuUsage(previous),
      memoryUsage: () => process.memoryUsage(),
      uptime: () => process.uptime(),
      hrtime: () => process.hrtime.bigint(),
    };
  }

  stats(): CoreHealthStats {
    return { sweeps: this.#sweeps, evaluated: this.#evaluated, failed: this.#failed };
  }

  /**
   * Every channel, read now.
   *
   * Public and independent of whether a sensor exists, because `GET /api/v1/core-health` serves
   * it — an operator must be able to ask how the core is without first having created a sensor,
   * and the answer has to survive the case where writing a sensor's reading is exactly what is
   * broken.
   */
  async read(meter: CpuMeter = this.#liveCpu): Promise<CoreHealthReading> {
    const now = this.#now();
    const ingestion = this.#sources.ingestion();
    const stream = this.#sources.stream();
    const probes = this.#sources.probes();
    const alarms = this.#sources.alarms();
    const queries = this.#sources.queries();
    const disk = this.#sources.disk();

    const memory = this.#process.memoryUsage();
    const queues = await this.#db.tx(async (q) => ({
      delivery: await this.#sources.delivery(q),
      rollup: await this.#rollupLag(q, now),
      backfill: await count(q, 'SELECT count(*)::int AS n FROM rollup_backfill'),
      reap: await count(q, 'SELECT count(*)::int AS n FROM channel_reap'),
    }));

    return {
      ingestQueue: ingestion.queuedRows,
      writeLatency: ingestion.writeMs.p95,
      ingestRefused: ingestion.refusedRows,
      cpu: this.#cpuPercent(meter),
      memory: round(memory.rss / MB, 1),
      heap: round(memory.heapUsed / MB, 1),
      uptime: Math.round(this.#process.uptime()),
      rollupLag: queues.rollup,
      backfillQueue: queues.backfill,
      // Gaps, not zeros, when this core has no disk it can speak for. `CLAUDE.md`: a Down sensor
      // records no channel values, and a channel that cannot be measured is the same case.
      diskFree: disk === null ? null : disk.freePercent,
      diskFreeBytes: disk === null ? null : round(disk.freeBytes / MB, 1),
      databaseSize: disk === null ? null : round(disk.databaseBytes / MB, 1),
      evictedChunks: this.#sources.evictedChunks(),
      reapQueue: queues.reap,
      notifyPending: queues.delivery.pending,
      notifyOldest: Math.round(queues.delivery.oldestPendingAgeMs / 1_000),
      notifyFailed: queues.delivery.failed,
      streamCutoffs: stream.overflowed,
      dependencyPauses: ingestion.dependencyPauses,
      probesDown: probes.probesDown,
      probesSilent: probes.probesSilent,
      // Never negative: a wake that is still ahead is not "minus forty seconds overdue", it is
      // on time. A scheduler that has never armed anything has no wake at all, which is also on
      // time — a gap here would read as "unknown" for a state that is simply quiet.
      alarmOverdue: overdueSeconds(alarms.nextWakeAt, now),
      alarmsFired: alarms.fired,
      queriesRefused: queries.refused,
      resultsFutureDated: this.#sources.ingestionDiscards().discardedFutureTime,
    };
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
    const sensors = await this.#db.query<{ id: string }>(
      `SELECT object_id::text AS id FROM sensor_config WHERE type = $1`,
      [HEALTH_TYPE],
    );
    if (sensors.length === 0) return 0;

    // ISO-8601 on the wire, exactly as a probe's result carries it: these go through
    // `acceptResults` unchanged, and a second shape would be a second code path.
    const at = this.#now().toISOString();
    let reading: CoreHealthReading;
    try {
      reading = await this.read(this.#sweepCpu);
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
      message: describe(reading),
    }));
    this.#evaluated += results.length;
    await this.#ingest(results);
    return results.length;
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
function describe(reading: CoreHealthReading): string {
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
  const down = reading['probesDown'];
  if (down !== null && down !== undefined && down > 0) parts.push(`${String(down)} probes down`);
  const silent = reading['probesSilent'];
  if (silent !== null && silent !== undefined && silent > 0) {
    parts.push(`${String(silent)} connected but not delivering`);
  }
  return parts.join(', ');
}

async function count(q: Queryable, sql: string): Promise<number> {
  const rows = await q.query<{ n: number }>(sql);
  return rows[0]?.n ?? 0;
}

/** How late the next sweep is, in whole seconds. Zero when it is still ahead, or unarmed. */
function overdueSeconds(nextWakeAt: Date | null, now: Date): number {
  if (nextWakeAt === null) return 0;
  return Math.max(0, Math.round((now.getTime() - nextWakeAt.getTime()) / 1_000));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

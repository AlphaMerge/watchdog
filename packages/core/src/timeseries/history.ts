import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { ObjectError } from '../objects/errors.js';
import { InheritanceResolver } from '../settings/inheritance.js';
import { SCAN_INTERVAL_SECONDS } from '../settings/registry.js';
import {
  planSeries,
  segmentsFor,
  type QueryAdjustment,
  type SeriesRequest,
  type SeriesSource,
} from './query.js';
import { SqlTimeSeriesStore, type TimeSeriesStore } from './store.js';

export interface HistoryChannel {
  id: number;
  key: string;
  name: string;
  unit: string;
  /** The channel's display precision, or `null` for automatic — a chart axis honours it. */
  decimals: number | null;
  /**
   * Aligned to `buckets`, one entry each. **`null` is a gap, never a zero** — a Down or paused
   * sensor produced no readings, and CLAUDE.md is explicit that a graph must break the line
   * rather than draw it to the floor. Returning a dense array with nulls, rather than a sparse
   * list of the buckets that happen to have data, is what makes that hard for a client to get
   * wrong: there is no way to plot these without deciding what to do about the nulls.
   */
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  /** Readings behind each bucket. Useful for spotting a bucket built from one sample. */
  count: (number | null)[];
}

export interface SensorHistory {
  sensorId: number;
  from: string;
  to: string;
  resolutionSeconds: number;
  bucketCount: number;
  /** Which table served the bulk of the range. */
  source: SeriesSource;
  /** How the range was actually assembled. More than one entry means a rollup was behind. */
  segments: { table: SeriesSource; from: string; to: string }[];
  /** What the query rules changed about the request, and why. */
  adjustments: QueryAdjustment[];
  /** Every bucket boundary in the effective range, ISO-8601. */
  buckets: string[];
  channels: HistoryChannel[];
}

/** One channel's current reading, or the absence of one. */
export interface ChannelValue {
  id: number;
  key: string;
  name: string;
  unit: string;
  /** The channel's display precision, or `null` for automatic. */
  decimals: number | null;
  /** `null` when nothing was recorded inside the lookback — a gap, never a zero. */
  value: number | null;
  /** When that reading was taken. `null` alongside a `null` value. */
  at: string | null;
}

export interface SensorValues {
  sensorId: number;
  /** Read at this instant, so a client can say how old the answer itself is. */
  readAt: string;
  /** Nothing older than this was considered. */
  notBefore: string;
  /** The scan interval the window was derived from, so the number is explicable. */
  intervalSeconds: number;
  channels: ChannelValue[];
}

/**
 * How many scan intervals back a reading may be and still count as current.
 *
 * Three, because one is too tight to survive a single missed scan and a sensor that missed one
 * scan is not a sensor with no data. Beyond that it stops being the current reading: at four
 * intervals the failure policy has long since taken the sensor to Down (`M-03`), and the state
 * badge beside the table is already saying so.
 */
export const CURRENT_INTERVALS = 3;

/** The floor under the window, for a sensor scanned every second. */
export const MIN_LOOKBACK_MS = 60_000;

export interface HistoryServiceOptions {
  db: Database;
  logger: Logger;
  store?: TimeSeriesStore;
}

/**
 * Historic data for a sensor, at whatever resolution the rules allow (S-08).
 *
 * The awkward part is not the aggregation, it is that there is no real-time aggregation: a
 * rollup tier is only authoritative up to its watermark, so an answer has to be stitched from
 * the tier plus whatever is newer, down to raw. `segmentsFor` decides that; this assembles the
 * result and reports which sources it used, because "where did this number come from" is a
 * question an operator eventually asks.
 */
export class HistoryService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #store: TimeSeriesStore;
  readonly #settings: InheritanceResolver;

  constructor(options: HistoryServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'history' });
    this.#store = options.store ?? new SqlTimeSeriesStore();
    // Built here rather than injected: it needs the database and a logger, both of which this
    // already has, and every one of its callers would otherwise have to wire up a dependency
    // whose only job is to answer one question about one setting.
    this.#settings = new InheritanceResolver({ db: options.db, logger: this.#logger });
  }

  async forSensor(sensorId: number, request: SeriesRequest): Promise<SensorHistory> {
    const plan = planSeries(request);

    const { exists, channels } = await this.#db.tx((q) => this.#store.sensorChannels(q, sensorId));
    if (!exists) {
      throw new ObjectError('OBJECT_NOT_FOUND', 'no such sensor', {
        context: { objectId: sensorId, phase: 'read-history' },
      });
    }

    const watermarks = await this.#db.tx((q) => this.#store.watermarks(q));
    const segments = segmentsFor(plan, watermarks);

    const rows =
      channels.length === 0
        ? []
        : await this.#db.tx((q) =>
            this.#store.readSeries(q, {
              channelIds: channels.map((channel) => channel.id),
              segments,
              bucketSeconds: plan.bucketSeconds,
            }),
          );

    const size = plan.bucketSeconds * 1_000;
    const start = plan.from.getTime();
    const buckets = Array.from({ length: plan.bucketCount }, (_, index) =>
      new Date(start + index * size).toISOString(),
    );

    const byChannel = new Map<number, HistoryChannel>();
    for (const channel of channels) {
      byChannel.set(channel.id, {
        id: channel.id,
        key: channel.key,
        name: channel.name,
        unit: channel.unit,
        decimals: channel.decimals,
        avg: new Array<number | null>(plan.bucketCount).fill(null),
        min: new Array<number | null>(plan.bucketCount).fill(null),
        max: new Array<number | null>(plan.bucketCount).fill(null),
        count: new Array<number | null>(plan.bucketCount).fill(null),
      });
    }

    for (const row of rows) {
      const channel = byChannel.get(row.channelId);
      if (channel === undefined) continue;
      const index = (row.bucket.getTime() - start) / size;
      // A bucket outside the range can only come from a boundary bug; dropping it silently
      // would hide that, so it is worth a line in the log.
      if (!Number.isInteger(index) || index < 0 || index >= plan.bucketCount) {
        this.#logger.warn(
          { sensorId, channelId: row.channelId, bucket: row.bucket.toISOString() },
          'a bucket fell outside the requested range',
        );
        continue;
      }
      channel.avg[index] = row.sum / row.count;
      channel.min[index] = row.min;
      channel.max[index] = row.max;
      channel.count[index] = row.count;
    }

    return {
      sensorId,
      from: plan.from.toISOString(),
      to: plan.to.toISOString(),
      resolutionSeconds: plan.bucketSeconds,
      bucketCount: plan.bucketCount,
      source: plan.source,
      segments: segments.map((segment) => ({
        table: segment.table,
        from: segment.from.toISOString(),
        to: segment.to.toISOString(),
      })),
      adjustments: plan.adjustments,
      buckets,
      channels: [...byChannel.values()],
    };
  }

  /**
   * What each channel is reading now (`U-04`).
   *
   * Separate from `forSensor` because it answers a different question with a different lifetime.
   * A history request is a range somebody chose and can be cached against; this is "what does it
   * say at this moment", it changes every scan interval, and it is the thing a channel table
   * shows beside each row.
   *
   * **A reading older than the lookback is reported as no reading.** Not the last value with a
   * timestamp beside it and the reader left to judge — the value is withheld, because a number
   * on screen is read as current whatever is printed next to it, and a sensor that has been Down
   * for a day showing its last healthy figure is precisely the failure this system exists to
   * prevent. `at` says how old the reading that *is* shown really is.
   */
  async latestForSensor(sensorId: number): Promise<SensorValues> {
    const found = await this.latestForSensors([sensorId]);
    const values = found.get(sensorId);
    if (values === undefined) {
      throw new ObjectError('OBJECT_NOT_FOUND', 'no such sensor', {
        context: { objectId: sensorId, phase: 'read-values' },
      });
    }
    return values;
  }

  /**
   * How many channels each sensor has, without reading a single reading (`P-203`).
   *
   * **For deciding whether to read at all.** A report's size is its channels times its buckets,
   * and both are known before any history is fetched — so a report over the value limit can be
   * refused for the price of one query, rather than after reading every sensor it names. Measured
   * before this existed: a 500-sensor report read for ten seconds and was then refused, on every
   * scheduled run. A sensor that does not exist is absent, as in `latestForSensors`.
   */
  async channelCounts(sensorIds: readonly number[]): Promise<Map<number, number>> {
    const unique = [...new Set(sensorIds)];
    if (unique.length === 0) return new Map();
    const byId = await this.#db.tx((q) => this.#store.sensorsChannels(q, unique));
    return new Map([...byId].map(([id, channels]) => [id, channels.length]));
  }

  /**
   * The same, for many sensors, in a fixed number of queries (`G-10`).
   *
   * **Three statements whatever the count**, and that is the whole point: channels for every
   * sensor at once, the effective interval for every sensor at once — `resolveForObjects` exists
   * because the scheduler needed exactly this — and one newest-per-channel scan over the union of
   * their channels. A map with forty channel tables was forty times this, sequentially, which is
   * the N+1 `G-10` exists to remove.
   *
   * **One query, but every sensor keeps its own window.** `latestValues` takes a single
   * `notBefore`, so it is asked for the widest of them and each sensor's rows are then held to
   * its own — a daily check and a minute-interval sensor cannot share a cut-off, and widening the
   * *query* is free while widening the *rule* would let a stale reading through as current.
   *
   * A sensor id that is not a sensor, or has been deleted, is simply absent from the result.
   */
  async latestForSensors(sensorIds: readonly number[]): Promise<Map<number, SensorValues>> {
    const out = new Map<number, SensorValues>();
    if (sensorIds.length === 0) return out;

    const unique = [...new Set(sensorIds)];
    const byId = await this.#db.tx((q) => this.#store.sensorsChannels(q, unique));
    if (byId.size === 0) return out;

    const present = [...byId.keys()];
    const intervals = await this.#settings.resolveForObjects<number>(
      present,
      SCAN_INTERVAL_SECONDS.key,
    );

    const readAt = new Date();
    const windows = new Map<number, { intervalSeconds: number; notBefore: Date }>();
    let widest = MIN_LOOKBACK_MS;
    for (const sensorId of present) {
      const intervalSeconds = intervals.get(sensorId)?.value ?? SCAN_INTERVAL_SECONDS.default;
      const lookbackMs = Math.max(MIN_LOOKBACK_MS, intervalSeconds * CURRENT_INTERVALS * 1_000);
      widest = Math.max(widest, lookbackMs);
      windows.set(sensorId, {
        intervalSeconds,
        notBefore: new Date(readAt.getTime() - lookbackMs),
      });
    }

    const channelIds = [...byId.values()].flatMap((channels) =>
      channels.map((channel) => channel.id),
    );
    const latest =
      channelIds.length === 0
        ? []
        : await this.#db.tx((q) =>
            this.#store.latestValues(q, {
              channelIds,
              notBefore: new Date(readAt.getTime() - widest),
            }),
          );
    const byChannel = new Map(latest.map((row) => [row.channelId, row]));

    for (const sensorId of present) {
      const channels = byId.get(sensorId) ?? [];
      const window = windows.get(sensorId);
      /* c8 ignore next -- every present sensor got a window in the loop above */
      if (window === undefined) continue;
      out.set(sensorId, {
        sensorId,
        readAt: readAt.toISOString(),
        notBefore: window.notBefore.toISOString(),
        intervalSeconds: window.intervalSeconds,
        channels: channels.map((channel) => {
          const row = byChannel.get(channel.id);
          // The query was asked the widest question; this is where each sensor's own answer is
          // cut back to its own window.
          const current = row !== undefined && row.at >= window.notBefore ? row : undefined;
          return {
            id: channel.id,
            key: channel.key,
            name: channel.name,
            unit: channel.unit,
            decimals: channel.decimals,
            value: current?.value ?? null,
            at: current === undefined ? null : current.at.toISOString(),
          };
        }),
      });
    }

    return out;
  }
}

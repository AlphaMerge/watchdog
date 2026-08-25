import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { ObjectError } from '../objects/errors.js';
import { planSeries, segmentsFor, type QueryAdjustment, type SeriesRequest } from './query.js';
import { SqlTimeSeriesStore, type TimeSeriesStore } from './store.js';

export interface HistoryChannel {
  id: number;
  key: string;
  name: string;
  unit: string;
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
  source: string;
  /** How the range was actually assembled. More than one entry means a rollup was behind. */
  segments: { table: string; from: string; to: string }[];
  /** What the query rules changed about the request, and why. */
  adjustments: QueryAdjustment[];
  /** Every bucket boundary in the effective range, ISO-8601. */
  buckets: string[];
  channels: HistoryChannel[];
}

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

  constructor(options: HistoryServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'history' });
    this.#store = options.store ?? new SqlTimeSeriesStore();
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
}

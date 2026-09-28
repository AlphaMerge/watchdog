import type { Queryable } from '../db/pool.js';
import { TimescaleEngine, type EngineCapabilities, type StorageEngine } from './engine.js';
import type { QuerySegment } from './query.js';
import { SAMPLE_TABLES, type RollupTier, type RollupTierId } from './tiers.js';
import type { SensorState, SensorStateCause } from '../state/tables.js';

/**
 * What one sensor's state was at the retention horizon (`S-15`).
 *
 * Carries the cause forward as well as the state: an anchor that said "Down" without saying it
 * was a limit, a lookup or a lost probe would answer half the question an operator asks when
 * they scroll to the oldest thing the log still holds.
 */
export interface StateAnchor {
  readonly sensorId: number;
  readonly state: SensorState;
  readonly cause: SensorStateCause;
}

/** One bucket of one channel, as every tier and raw are normalised into. */
export interface SeriesRow {
  bucket: Date;
  channelId: number;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface ChannelRef {
  id: number;
  key: string;
  name: string;
  unit: string;
  /**
   * The channel's display precision, or `null` for automatic (`M-07`).
   *
   * Carried through the time-series reads because a chart axis has to honour it: a channel
   * configured to two decimals and plotted to six says the device is more precise than it is,
   * and one plotted to zero flattens a millisecond RTT to a row of "0".
   */
  decimals: number | null;
}

/**
 * How a roll treats a bucket that already exists (`P-226`).
 *
 * - `recompute` replaces it with what the source holds now. Right wherever the source still holds
 *   everything that bucket was built from.
 * - `keep` leaves it alone and writes only buckets that do not exist yet. Right beyond the
 *   source's retention, where the source may hold only the readings that arrived late: rebuilding
 *   from those would replace a complete bucket with a bucket of a few readings.
 */
export type RollConflict = 'recompute' | 'keep';

export interface RollOptions {
  /** The channels to roll, or every channel when absent. Never empty: that would roll nothing. */
  readonly channels?: readonly number[];
  readonly conflict?: RollConflict;
}

/** Readings as they were written, in two parallel arrays, as ingestion already holds them. */
export interface WrittenReadings {
  readonly channelIds: readonly number[];
  readonly times: readonly Date[];
}

/** One queue entry: a window, and the channels whose readings in it arrived late. */
export interface BackfillEntry {
  readonly from: Date;
  readonly to: Date;
  /** Null for an entry that does not know, which re-rolls every channel. */
  readonly channels: readonly number[] | null;
}

/** The entries one pass re-rolls (`P-226`). */
export interface BackfillClaim {
  readonly ids: readonly string[];
  readonly entries: readonly BackfillEntry[];
  /** The span of all of them, for the log. */
  readonly from: Date;
  readonly to: Date;
  /** Whether this is a parked entry, claimed on its own because it is due a retry. */
  readonly parked: boolean;
}

/** When an entry that failed is tried again. */
export interface BackfillRetry {
  /** Failures after which an entry is parked, and stops holding retention back. */
  readonly parkAfter: number;
  /** How long after the failure that parks it. */
  readonly firstRetrySeconds: number;
  /** How long after every failure after that. */
  readonly laterRetrySeconds: number;
}

/** The longest error a queue entry keeps: one line for Core Health, as the column requires. */
export const BACKFILL_ERROR_LENGTH = 500;

/** The newest reading one channel has, inside a bounded lookback. */
export interface LatestValue {
  channelId: number;
  at: Date;
  value: number;
}

/**
 * Every way this system touches time-series data (S-12).
 *
 * Callers depend on this rather than on the class below, so nothing outside can reach past it
 * into engine-specific SQL — `storage-boundary.test.ts` enforces that by scanning the source.
 * `CLAUDE.md` puts it plainly: "time-series access goes through the repository interface, so
 * the storage engine can be swapped."
 *
 * Note where the real variation lives. Most of this is ordinary SQL that any PostgreSQL would
 * run; only bucketing and the chunk lifecycle differ between engines, and those are behind
 * `StorageEngine`. A second engine is a four-method object, not a reimplementation of all of
 * this.
 */
export interface TimeSeriesStore {
  capabilities(q: Queryable): Promise<EngineCapabilities>;
  watermarks(q: Queryable): Promise<Map<RollupTierId, Date>>;
  startingWatermark(q: Queryable, tier: RollupTier): Promise<Date>;
  rollupTarget(
    q: Queryable,
    tier: RollupTier,
    lagSeconds: number,
    sourceWatermark: Date | null,
  ): Promise<Date>;
  rollUp(
    q: Queryable,
    tier: RollupTier,
    from: Date,
    to: Date,
    options?: RollOptions,
  ): Promise<number>;
  advanceWatermark(q: Queryable, tier: RollupTier, to: Date): Promise<void>;
  enqueueBackfill(
    q: Queryable,
    from: Date,
    to: Date,
    reason: string,
    channels?: readonly number[] | null,
  ): Promise<void>;
  enqueueBackfillIfLate(q: Queryable, written: WrittenReadings, reason: string): Promise<boolean>;
  claimBackfill(q: Queryable, limit: number): Promise<BackfillClaim | null>;
  clearBackfill(q: Queryable, ids: readonly string[]): Promise<void>;
  failBackfill(
    q: Queryable,
    ids: readonly string[],
    error: string,
    retry: BackfillRetry,
  ): Promise<{ parked: number }>;
  earliestPendingBackfill(q: Queryable): Promise<Date | null>;
  /** Every channel there is, ascending, for an entry that does not say which it needs. */
  allChannels(q: Queryable): Promise<number[]>;
  /** See `StorageEngine.allowDecompression`: the caller bounds the transaction. */
  allowDecompression(q: Queryable): Promise<void>;
  compactableChunks(q: Queryable, table: string, before: Date, limit: number): Promise<string[]>;
  compact(q: Queryable, chunk: string): Promise<void>;
  dropOlderThan(q: Queryable, table: string, olderThan: Date): Promise<string[]>;
  /** The oldest instant a table still holds, or null when it holds nothing (`S-17`). */
  oldestAt(q: Queryable, table: string): Promise<Date | null>;
  /** The state each sensor was in at the horizon, for those with nothing newer (`S-15`). */
  stateAtHorizon(q: Queryable, horizon: Date): Promise<StateAnchor[]>;
  /** Anchors the candidates the drop left with no state at all (`S-15`). */
  anchorStates(q: Queryable, horizon: Date, candidates: readonly StateAnchor[]): Promise<number>;
  sensorChannels(
    q: Queryable,
    sensorId: number,
  ): Promise<{ exists: boolean; channels: ChannelRef[] }>;
  /**
   * The same, for many sensors at once (`G-10`).
   *
   * A sensor that exists is a key with a possibly-empty list; a id that is not a sensor, or is
   * gone, is absent. The distinction is what lets a caller answer "no such sensor" without a
   * second query.
   */
  sensorsChannels(q: Queryable, sensorIds: readonly number[]): Promise<Map<number, ChannelRef[]>>;
  readSeries(
    q: Queryable,
    options: {
      channelIds: readonly number[];
      segments: readonly QuerySegment[];
      bucketSeconds: number;
    },
  ): Promise<SeriesRow[]>;
  latestValues(
    q: Queryable,
    options: { channelIds: readonly number[]; notBefore: Date },
  ): Promise<LatestValue[]>;
  horizon(q: Queryable, days: number): Promise<Date>;
  reapCandidates(q: Queryable, limit: number): Promise<number[]>;
  reapChannels(q: Queryable, channelIds: readonly number[]): Promise<number>;
}

/**
 * Every statement the data lifecycle runs, over PostgreSQL. No transactions, no locks, no
 * logging — the housekeeper owns those, the same split the object model uses between repository
 * and service.
 *
 * Table names are interpolated because PostgreSQL cannot parameterise an identifier. They come
 * only from the constants in `tiers.ts`, never from a request, and `assertKnownTable` makes
 * that a checked property rather than a convention someone has to remember. The same is true of
 * the bucketing expression the engine supplies.
 */
export class SqlTimeSeriesStore implements TimeSeriesStore {
  readonly #engine: StorageEngine;

  constructor(engine: StorageEngine = new TimescaleEngine()) {
    this.#engine = engine;
  }

  /** What this engine is and what it can do. Logged at start-up, shown on Core Health. */
  async capabilities(q: Queryable): Promise<EngineCapabilities> {
    return this.#engine.check(q);
  }

  /** How far each tier is materialised. Absent means the tier has never run. */
  async watermarks(q: Queryable): Promise<Map<RollupTierId, Date>> {
    const rows = await q.query<{ tier: string; watermark: Date }>(
      'SELECT tier, watermark FROM rollup_watermark',
    );
    return new Map(rows.map((row) => [row.tier as RollupTierId, row.watermark]));
  }

  /**
   * Where a tier should start when it has never run: the bucket containing the oldest row its
   * source holds, or the current bucket if the source is empty.
   *
   * This must be called only when the tier's source has already been rolled up in this pass,
   * which is why the loop initialises lazily, tier by tier, finest first. Reading `min()` from
   * an empty `sample_5m` while raw holds a year of history would strand that year.
   */
  async startingWatermark(q: Queryable, tier: RollupTier): Promise<Date> {
    assertKnownTable(tier.source.table);
    const rows = await q.query<{ watermark: Date }>(
      `SELECT coalesce(
                ${this.#engine.bucket('$1', `min(${tier.source.timeColumn})`)},
                ${this.#engine.bucket('$1', 'now()')}
              ) AS watermark
       FROM ${tier.source.table}`,
      [tier.bucket],
    );
    const watermark = rows[0]?.watermark;
    /* c8 ignore next -- an aggregate over any table always returns exactly one row */
    if (watermark === undefined) throw new Error(`could not determine a start for ${tier.id}`);
    return watermark;
  }

  /**
   * The newest bucket boundary this tier may materialise up to, exclusive.
   *
   * Two limits, whichever is lower. The lag keeps us off the bucket that is still filling and
   * gives in-flight writes time to land. The source watermark is the harder one: a tier cannot
   * summarise buckets its source has not built yet, and bucketing that watermark rounds
   * it down — with `sample_5m` materialised to 10:35, the 10:00 hourly bucket is still
   * incomplete, so hourly may only go up to 10:00.
   *
   * LEAST ignores NULL, so the raw-sourced tier passes null and gets the lag limit alone.
   */
  async rollupTarget(
    q: Queryable,
    tier: RollupTier,
    lagSeconds: number,
    sourceWatermark: Date | null,
  ): Promise<Date> {
    const rows = await q.query<{ target: Date }>(
      `SELECT LEAST(
                ${this.#engine.bucket('$1', 'now() - make_interval(secs => $2::double precision)')},
                ${this.#engine.bucket('$1', '$3::timestamptz')}
              ) AS target`,
      [tier.bucket, lagSeconds, sourceWatermark],
    );
    const target = rows[0]?.target;
    /* c8 ignore next -- a scalar SELECT always returns exactly one row */
    if (target === undefined) throw new Error(`could not determine a target for ${tier.id}`);
    return target;
  }

  /**
   * Materialises `[from, to)` for one tier and returns the number of buckets written.
   *
   * `ON CONFLICT DO UPDATE` recomputes each bucket outright rather than adding to it, so
   * running this twice over the same window converges instead of double-counting. That is what
   * makes a crash mid-pass, and a replayed backfill, both safe.
   *
   * **It never deletes** (`P-226`). A backfill used to clear its window first, so that a bucket
   * whose readings had all gone would not linger. Nothing needs that: a reaped channel's buckets
   * go with its readings, in `reapChannels`, and a bucket whose raw readings retention dropped is
   * the whole point of keeping a coarser tier. What the clearing did do was take every channel's
   * buckets for the window and rebuild only the ones the source still held, which after a replay
   * into a window past the raw retention was one channel's.
   */
  async rollUp(
    q: Queryable,
    tier: RollupTier,
    from: Date,
    to: Date,
    options: RollOptions = {},
  ): Promise<number> {
    assertKnownTable(tier.table);
    assertKnownTable(tier.source.table);
    const { channels, conflict = 'recompute' } = options;
    if (channels?.length === 0) {
      throw new Error(`refusing to roll ${tier.id} for an empty set of channels`);
    }

    // Raw carries one reading per row; a rollup carries a summary that has to be re-summed.
    // count(*) versus sum(sample_count) is the whole difference, and getting it wrong would
    // silently reweight every average above five minutes.
    const aggregate =
      tier.source.kind === 'raw'
        ? 'count(*)::int, sum(value), min(value), max(value)'
        : 'sum(sample_count)::int, sum(value_sum), min(value_min), max(value_max)';

    const onConflict =
      conflict === 'keep'
        ? 'DO NOTHING'
        : `DO UPDATE SET
           sample_count = EXCLUDED.sample_count,
           value_sum    = EXCLUDED.value_sum,
           value_min    = EXCLUDED.value_min,
           value_max    = EXCLUDED.value_max`;
    const parameters: unknown[] = [tier.bucket, from, to];
    if (channels !== undefined) parameters.push(channels);

    const rows = await q.query<{ written: string }>(
      `WITH rolled AS (
         INSERT INTO ${tier.table} (bucket, channel_id, sample_count, value_sum, value_min, value_max)
         SELECT ${this.#engine.bucket('$1', tier.source.timeColumn)}, channel_id, ${aggregate}
         FROM ${tier.source.table}
         WHERE ${tier.source.timeColumn} >= $2 AND ${tier.source.timeColumn} < $3
           ${channels === undefined ? '' : 'AND channel_id = ANY($4::int[])'}
         GROUP BY 1, 2
         ON CONFLICT (channel_id, bucket) ${onConflict}
         RETURNING 1
       )
       SELECT count(*) AS written FROM rolled`,
      parameters,
    );
    return Number(rows[0]?.written ?? 0);
  }

  /** Moves a watermark forward. Never backwards — a backfill re-rolls old ground. */
  async advanceWatermark(q: Queryable, tier: RollupTier, to: Date): Promise<void> {
    await q.query(
      `INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, $2)
       ON CONFLICT (tier) DO UPDATE
         SET watermark  = GREATEST(rollup_watermark.watermark, EXCLUDED.watermark),
             updated_at = now()`,
      [tier.id, to],
    );
  }

  /**
   * Records a window that has to be rolled up again.
   *
   * Called by ingestion when a probe replays its spool (R-03) and the samples land behind a
   * watermark — inside buckets that were summarised while the probe was away. Without this the
   * readings would sit in raw, correct and invisible, until retention dropped them.
   */
  async enqueueBackfill(
    q: Queryable,
    from: Date,
    to: Date,
    reason: string,
    channels: readonly number[] | null = null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO rollup_backfill (from_time, to_time, reason, channel_ids)
       VALUES ($1, $2, $3, $4)`,
      [from, to, reason, channels],
    );
  }

  /**
   * Takes pending entries.
   *
   * Only the ids it saw are returned, so entries arriving while the re-roll runs survive to the
   * next pass instead of being deleted unprocessed. They are returned as entries rather than
   * collapsed into one window, because what each channel still needs is its own: collapsing a
   * continuation that has got as far as the tenth day with an entry that starts on the first
   * would start the continuation's channels again from the first (`P-226`).
   *
   * **Entries that have not been parked come first, and a parked one is claimed only when there
   * are none, and on its own** (`P-226`). A parked entry has already failed three times. Claimed
   * together with fresh ones, its next failure would count against all of them, and in three
   * passes it would have parked them too.
   */
  async claimBackfill(q: Queryable, limit: number): Promise<BackfillClaim | null> {
    type Row = { id: string; from_time: Date; to_time: Date; channel_ids: number[] | null };
    let parked = false;
    let rows = await q.query<Row>(
      `SELECT id, from_time, to_time, channel_ids FROM rollup_backfill
       WHERE retry_at IS NULL
       ORDER BY id LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) {
      parked = true;
      rows = await q.query<Row>(
        `SELECT id, from_time, to_time, channel_ids FROM rollup_backfill
         WHERE retry_at <= now()
         ORDER BY retry_at, id LIMIT 1`,
      );
    }
    const first = rows[0];
    if (first === undefined) return null;

    let from = first.from_time;
    let to = first.to_time;
    for (const row of rows) {
      if (row.from_time < from) from = row.from_time;
      if (row.to_time > to) to = row.to_time;
    }
    return {
      ids: rows.map((row) => row.id),
      entries: rows.map((row) => ({
        from: row.from_time,
        to: row.to_time,
        channels: row.channel_ids,
      })),
      from,
      to,
      parked,
    };
  }

  async clearBackfill(q: Queryable, ids: readonly string[]): Promise<void> {
    await q.query('DELETE FROM rollup_backfill WHERE id = ANY($1::bigint[])', [ids]);
  }

  /**
   * Counts a failure against each entry, and parks those that have failed often enough.
   *
   * The retry is decided per entry, because entries claimed together can have failed a different
   * number of times before. Returns how many are parked now.
   */
  async failBackfill(
    q: Queryable,
    ids: readonly string[],
    error: string,
    retry: BackfillRetry,
  ): Promise<{ parked: number }> {
    const rows = await q.query<{ parked: boolean }>(
      `UPDATE rollup_backfill
       SET attempts   = attempts + 1,
           last_error = $2,
           failed_at  = now(),
           retry_at   = CASE
             WHEN attempts + 1 < $3 THEN NULL
             WHEN attempts + 1 = $3 THEN now() + make_interval(secs => $4::double precision)
             ELSE now() + make_interval(secs => $5::double precision)
           END
       WHERE id = ANY($1::bigint[])
       RETURNING retry_at IS NOT NULL AS parked`,
      [ids, oneLine(error), retry.parkAfter, retry.firstRetrySeconds, retry.laterRetrySeconds],
    );
    return { parked: rows.filter((row) => row.parked).length };
  }

  /**
   * Enqueues the written readings that precede what the five-minute tier has already
   * materialised, as one entry naming their channels. Returns whether it did.
   *
   * **Two statements, and the second only when something is late** (`P-226`). The first compares
   * the oldest reading with the watermark, which is what this was before it needed the channels:
   * one row, on every write. Only a write with something late sends its readings back to find
   * which ones, and that is a replay, not the steady state. The second reads the watermark again
   * rather than trusting the first, so a watermark that moved in between widens the entry and
   * never narrows it.
   *
   * `time < watermark` is exactly "the bucket this reading belongs to has been rolled up
   * already": the watermark is always on a bucket boundary, so bucket(time) < watermark and
   * time < watermark say the same thing. The entry ends a millisecond after the newest late
   * reading, because the queue's windows are half-open.
   */
  async enqueueBackfillIfLate(
    q: Queryable,
    written: WrittenReadings,
    reason: string,
  ): Promise<boolean> {
    let oldest: Date | undefined;
    for (const at of written.times) if (oldest === undefined || at < oldest) oldest = at;
    if (oldest === undefined) return false;

    const behind = await q.query<{ late: boolean }>(
      `SELECT true AS late FROM rollup_watermark
       WHERE tier = 'sample_5m' AND watermark > $1::timestamptz`,
      [oldest],
    );
    if (behind.length === 0) return false;

    const rows = await q.query<{ id: string }>(
      `INSERT INTO rollup_backfill (from_time, to_time, reason, channel_ids)
       SELECT min(w.time), max(w.time) + interval '1 millisecond', $3,
              array_agg(DISTINCT w.channel_id ORDER BY w.channel_id)
       FROM rollup_watermark m
       CROSS JOIN unnest($1::int[], $2::timestamptz[]) AS w(channel_id, time)
       WHERE m.tier = 'sample_5m' AND w.time < m.watermark
       HAVING count(*) > 0
       RETURNING id`,
      [written.channelIds, written.times, reason],
    );
    return rows.length > 0;
  }

  /**
   * The oldest instant a pending backfill still needs, or null when there is none.
   *
   * **A parked entry does not count** (`P-226`). Compression and retention stop here, so an entry
   * that fails every time would otherwise hold both back for good, and the disk would fill behind
   * one bad window. Once parked, it gives up that claim: if retention drops its source before a
   * retry succeeds, the retry keeps the buckets it finds rather than rebuilding them from what is
   * left.
   */
  async earliestPendingBackfill(q: Queryable): Promise<Date | null> {
    const rows = await q.query<{ from_time: Date | null }>(
      'SELECT min(from_time) AS from_time FROM rollup_backfill WHERE retry_at IS NULL',
    );
    return rows[0]?.from_time ?? null;
  }

  async allChannels(q: Queryable): Promise<number[]> {
    const rows = await q.query<{ id: number }>('SELECT id FROM channel ORDER BY id');
    return rows.map((row) => row.id);
  }

  async allowDecompression(q: Queryable): Promise<void> {
    await this.#engine.allowDecompression(q);
  }

  /** Aged chunks the engine can still compact. The table check stays on this side. */
  async compactableChunks(
    q: Queryable,
    table: string,
    before: Date,
    limit: number,
  ): Promise<string[]> {
    assertKnownTable(table);
    return this.#engine.compactableChunks(q, table, before, limit);
  }

  async compact(q: Queryable, chunk: string): Promise<void> {
    await this.#engine.compact(q, chunk);
  }

  async dropOlderThan(q: Queryable, table: string, olderThan: Date): Promise<string[]> {
    assertKnownTable(table);
    return this.#engine.dropOlderThan(q, table, olderThan);
  }

  /**
   * Where a table's history starts (`S-17`).
   *
   * Read rather than assumed, because emergency eviction walks *forward* from it: an
   * installation whose oldest raw data is a week old has nothing to evict however full the disk
   * is, and one whose oldest is a year old has a year to work through a day at a time. A
   * `min(time)` over a hypertable is per-chunk index scans, which is affordable in a loop that
   * runs every five minutes and is not on any request path.
   */
  async oldestAt(q: Queryable, table: string): Promise<Date | null> {
    assertKnownTable(table);
    const rows = await q.query<{ at: Date | null }>(`SELECT min(time) AS at FROM ${table}`);
    return rows[0]?.at ?? null;
  }

  /**
   * A sensor's channels, and whether the sensor exists at all.
   *
   * One query for both, because "no such sensor" and "a sensor with no channels yet" are
   * different answers — 404 against an empty series — and asking twice would let them race.
   */
  /** One sensor, through the batched query, so there is one statement to keep correct. */
  async sensorChannels(
    q: Queryable,
    sensorId: number,
  ): Promise<{ exists: boolean; channels: ChannelRef[] }> {
    const found = await this.sensorsChannels(q, [sensorId]);
    const channels = found.get(sensorId);
    return channels === undefined ? { exists: false, channels: [] } : { exists: true, channels };
  }

  async sensorsChannels(
    q: Queryable,
    sensorIds: readonly number[],
  ): Promise<Map<number, ChannelRef[]>> {
    const found = new Map<number, ChannelRef[]>();
    if (sensorIds.length === 0) return found;

    const rows = await q.query<{
      sensor_id: string;
      channel_id: number | null;
      key: string | null;
      name: string | null;
      unit: string | null;
      decimals: number | null;
    }>(
      `SELECT o.id::text AS sensor_id, c.id AS channel_id, c.key, c.name, c.unit, c.decimals
       FROM object o
       LEFT JOIN channel c ON c.sensor_id = o.id
       WHERE o.id = ANY($1::bigint[]) AND o.kind = 'sensor'
       ORDER BY o.id, c.is_primary DESC NULLS LAST, c.key`,
      [[...sensorIds]],
    );

    for (const row of rows) {
      const sensorId = Number(row.sensor_id);
      // The row exists, so the sensor does — the left join means a sensor with no channels
      // still arrives, once, with nulls. That is a key with an empty list, not a missing key.
      let channels = found.get(sensorId);
      if (channels === undefined) {
        channels = [];
        found.set(sensorId, channels);
      }
      if (row.channel_id === null || row.key === null) continue;
      channels.push({
        id: row.channel_id,
        key: row.key,
        name: row.name ?? row.key,
        unit: row.unit ?? '',
        decimals: row.decimals,
      });
    }
    return found;
  }

  /**
   * Reads one series per channel, assembled from however many sources hold the range.
   *
   * The segments come from `segmentsFor`, which never overlaps them, so the outer aggregate can
   * add them up: a bucket straddling the boundary between a rollup tier and raw gets part of
   * its readings from each and is still counted exactly once.
   *
   * Every source is normalised to (count, sum, min, max) before the union, which is what makes
   * the average `sum(sum) / sum(count)` rather than an average of averages. Getting that wrong
   * would reweight every bucket whose sources held different numbers of readings — which is
   * every bucket containing a gap.
   */
  async readSeries(
    q: Queryable,
    options: {
      channelIds: readonly number[];
      segments: readonly QuerySegment[];
      bucketSeconds: number;
    },
  ): Promise<SeriesRow[]> {
    if (options.channelIds.length === 0 || options.segments.length === 0) return [];

    const values: unknown[] = [`${String(options.bucketSeconds)} seconds`, [...options.channelIds]];
    const parts = options.segments.map((segment) => {
      assertKnownTable(segment.table);
      const from = values.push(segment.from);
      const to = values.push(segment.to);
      const raw = segment.table === 'sample';
      const timeColumn = raw ? 'time' : 'bucket';
      const aggregate = raw
        ? 'count(*)::bigint AS n, sum(value) AS s, min(value) AS lo, max(value) AS hi'
        : 'sum(sample_count)::bigint AS n, sum(value_sum) AS s, min(value_min) AS lo, max(value_max) AS hi';
      return `SELECT ${this.#engine.bucket('$1', timeColumn)} AS b, channel_id, ${aggregate}
              FROM ${segment.table}
              WHERE channel_id = ANY($2::int[])
                AND ${timeColumn} >= $${String(from)} AND ${timeColumn} < $${String(to)}
              GROUP BY 1, 2`;
    });

    const rows = await q.query<{
      bucket: Date;
      channel_id: number;
      n: string;
      s: number;
      lo: number;
      hi: number;
    }>(
      `WITH merged AS (${parts.join(' UNION ALL ')})
       SELECT b AS bucket, channel_id, sum(n)::bigint AS n, sum(s) AS s,
              min(lo) AS lo, max(hi) AS hi
       FROM merged
       GROUP BY 1, 2
       ORDER BY channel_id, bucket`,
      values,
    );

    return rows.map((row) => ({
      bucket: row.bucket,
      channelId: row.channel_id,
      count: Number(row.n),
      sum: row.s,
      min: row.lo,
      max: row.hi,
    }));
  }

  /**
   * The newest reading each channel has, provided it is recent enough to still mean anything.
   *
   * **Bounded, and the bound is the design rather than an optimisation.** A channel table showing
   * "Response time: 0.4 ms" beside a sensor that has been Down for two days is the same lie as a
   * graph drawing a gap to zero — CLAUDE.md's rule is that no-data is not zero, and a stale
   * reading dressed as a current one is no-data wearing a number. Nothing older than `notBefore`
   * is returned at all, so a caller cannot show one by accident; the absence is the answer.
   *
   * It is also what keeps this cheap. `sample` is a hypertable, and an unbounded
   * newest-per-channel scan on a channel that stopped reporting walks back through every chunk
   * that ever existed. With the bound, `(channel_id, time)` serves it — a backwards index scan
   * per channel, stopping at the boundary.
   */
  async latestValues(
    q: Queryable,
    options: { channelIds: readonly number[]; notBefore: Date },
  ): Promise<LatestValue[]> {
    if (options.channelIds.length === 0) return [];
    const rows = await q.query<{ channel_id: number; time: Date; value: number }>(
      `SELECT DISTINCT ON (channel_id) channel_id, time, value
       FROM sample
       WHERE channel_id = ANY($1::int[]) AND time >= $2
       ORDER BY channel_id, time DESC`,
      [[...options.channelIds], options.notBefore],
    );
    return rows.map((row) => ({ channelId: row.channel_id, at: row.time, value: row.value }));
  }

  /** `now()` from the database, so every horizon is measured against the data's own clock. */
  async horizon(q: Queryable, days: number): Promise<Date> {
    const rows = await q.query<{ at: Date }>(
      'SELECT now() - make_interval(days => $1::int) AS at',
      [days],
    );
    const at = rows[0]?.at;
    /* c8 ignore next -- a scalar SELECT always returns exactly one row */
    if (at === undefined) throw new Error('could not compute a horizon');
    return at;
  }

  /**
   * The state each sensor was in at the horizon, for sensors with nothing newer (`S-15`).
   *
   * Taken **before** the drop, because after it the answer is gone. Only sensors whose newest
   * transition is already older than the horizon are candidates: one with a later row keeps a
   * known state whatever is dropped beneath it, and that row's `previous_state` still says what
   * came before.
   */
  async stateAtHorizon(q: Queryable, horizon: Date): Promise<StateAnchor[]> {
    const rows = await q.query<{
      sensor_id: string;
      state: SensorState;
      cause: SensorStateCause;
    }>(
      `SELECT DISTINCT ON (sensor_id) sensor_id::text AS sensor_id, state::text AS state,
              cause::text AS cause
       FROM sensor_state
       WHERE time < $1
       ORDER BY sensor_id, time DESC`,
      [horizon],
    );
    return rows.map((row) => ({
      sensorId: Number(row.sensor_id),
      state: row.state,
      cause: row.cause,
    }));
  }

  /**
   * Writes an anchor for every candidate the drop left with no state at all (`S-15`).
   *
   * **After the drop, and conditioned on the sensor now having no rows** — which is what stops
   * this writing a row on every pass. A quiet sensor is anchored once; on the next pass its
   * newest row is that anchor, the drop leaves it alone because its chunk is not old enough yet,
   * and this finds it still has a row and does nothing. When the anchor's own chunk is eventually
   * dropped, the sensor is empty again and is anchored afresh.
   *
   * A sensor that no longer exists in the tree is not anchored: its history is on its way out
   * with it, and resurrecting a row for a deleted sensor would keep it alive for ever.
   */
  async anchorStates(
    q: Queryable,
    horizon: Date,
    candidates: readonly StateAnchor[],
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    const rows = await q.query<{ sensor_id: string }>(
      `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message, carried)
       SELECT $1,
              candidate.sensor_id,
              candidate.state::sensor_state_kind,
              candidate.state::sensor_state_kind,
              candidate.cause::sensor_state_cause,
              'state carried forward past the retention horizon',
              true
       FROM unnest($2::bigint[], $3::text[], $4::text[])
            AS candidate(sensor_id, state, cause)
       WHERE EXISTS (SELECT 1 FROM object o WHERE o.id = candidate.sensor_id)
         AND NOT EXISTS (
           SELECT 1 FROM sensor_state s WHERE s.sensor_id = candidate.sensor_id
         )
       ON CONFLICT (sensor_id, time) DO NOTHING
       RETURNING sensor_id::text AS sensor_id`,
      [
        horizon,
        candidates.map((one) => one.sensorId),
        candidates.map((one) => one.state),
        candidates.map((one) => one.cause),
      ],
    );
    return rows.length;
  }

  /** Channels that have been deleted and whose readings are therefore orphaned (S-05). */
  async reapCandidates(q: Queryable, limit: number): Promise<number[]> {
    const rows = await q.query<{ channel_id: number }>(
      'SELECT channel_id FROM channel_reap ORDER BY enqueued_at, channel_id LIMIT $1',
      [limit],
    );
    return rows.map((row) => row.channel_id);
  }

  /**
   * Deletes every reading belonging to reaped channels, across raw and all three tiers, and
   * clears the queue entries.
   *
   * The caller runs this in one transaction: dropping the queue entry without the rows would
   * orphan them for ever, since nothing else remembers the channel existed.
   */
  async reapChannels(q: Queryable, channelIds: readonly number[]): Promise<number> {
    // A reaped channel's old readings are in compressed chunks, and deleting them unpacks every
    // one: a channel kept forty days at a minute is 57,600 rows before its rollups. From 2.17.0
    // (`#6882`) a delete by the segmenting column alone drops whole segments instead, but not
    // one with a RETURNING clause, which this has for its count, so the lift is needed on every
    // release. Bounded by the channels the caller passes (`P-226`).
    await this.#engine.allowDecompression(q);
    let deleted = 0;
    for (const table of SAMPLE_TABLES) {
      assertKnownTable(table);
      const rows = await q.query<{ count: string }>(
        `WITH gone AS (DELETE FROM ${table} WHERE channel_id = ANY($1::int[]) RETURNING 1)
         SELECT count(*) AS count FROM gone`,
        [channelIds],
      );
      deleted += Number(rows[0]?.count ?? 0);
    }
    await q.query('DELETE FROM channel_reap WHERE channel_id = ANY($1::int[])', [channelIds]);
    return deleted;
  }
}

// `sensor_state` joins the sample tables here because `S-15` drops its chunks too — it is
// the one non-sample hypertable retention touches, and it is a constant like the rest.
const KNOWN_TABLES = new Set([...SAMPLE_TABLES, 'sensor_state']);

/** The first line of an error, trimmed to what a queue entry keeps. */
function oneLine(error: string): string {
  const first = error.split('\n', 1)[0] ?? '';
  return first.length <= BACKFILL_ERROR_LENGTH
    ? first
    : `${first.slice(0, BACKFILL_ERROR_LENGTH - 1)}…`;
}

/**
 * The only defence an interpolated identifier gets, and the reason it is enough: every caller
 * passes a constant from `tiers.ts`. If a future change ever routes a request value here, this
 * throws instead of composing SQL out of it.
 */
function assertKnownTable(table: string): void {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`refusing to build SQL for an unknown table: ${table}`);
  }
}

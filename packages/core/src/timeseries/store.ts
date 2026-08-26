import type { Queryable } from '../db/pool.js';
import { TimescaleEngine, type EngineCapabilities, type StorageEngine } from './engine.js';
import type { QuerySegment } from './query.js';
import { SAMPLE_TABLES, type RollupTier, type RollupTierId } from './tiers.js';

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
    options?: { replace: boolean },
  ): Promise<number>;
  advanceWatermark(q: Queryable, tier: RollupTier, to: Date): Promise<void>;
  enqueueBackfill(q: Queryable, from: Date, to: Date, reason: string): Promise<void>;
  enqueueBackfillIfLate(q: Queryable, from: Date, to: Date, reason: string): Promise<boolean>;
  claimBackfill(
    q: Queryable,
    limit: number,
  ): Promise<{ ids: string[]; from: Date; to: Date } | null>;
  clearBackfill(q: Queryable, ids: readonly string[]): Promise<void>;
  earliestPendingBackfill(q: Queryable): Promise<Date | null>;
  compactableChunks(q: Queryable, table: string, before: Date, limit: number): Promise<string[]>;
  compact(q: Queryable, chunk: string): Promise<void>;
  dropOlderThan(q: Queryable, table: string, olderThan: Date): Promise<string[]>;
  sensorChannels(
    q: Queryable,
    sensorId: number,
  ): Promise<{ exists: boolean; channels: ChannelRef[] }>;
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
   * `replace` additionally clears the window first. A forward roll never needs it — the window
   * is new — but a backfill does: if the source lost rows since the window was last rolled
   * (retention dropped a chunk, or a channel was reaped), the buckets they produced would
   * otherwise linger for ever, updated by nothing.
   */
  async rollUp(
    q: Queryable,
    tier: RollupTier,
    from: Date,
    to: Date,
    options: { replace: boolean } = { replace: false },
  ): Promise<number> {
    assertKnownTable(tier.table);
    assertKnownTable(tier.source.table);

    if (options.replace) {
      await q.query(`DELETE FROM ${tier.table} WHERE bucket >= $1 AND bucket < $2`, [from, to]);
    }

    // Raw carries one reading per row; a rollup carries a summary that has to be re-summed.
    // count(*) versus sum(sample_count) is the whole difference, and getting it wrong would
    // silently reweight every average above five minutes.
    const aggregate =
      tier.source.kind === 'raw'
        ? 'count(*)::int, sum(value), min(value), max(value)'
        : 'sum(sample_count)::int, sum(value_sum), min(value_min), max(value_max)';

    const rows = await q.query<{ written: string }>(
      `WITH rolled AS (
         INSERT INTO ${tier.table} (bucket, channel_id, sample_count, value_sum, value_min, value_max)
         SELECT ${this.#engine.bucket('$1', tier.source.timeColumn)}, channel_id, ${aggregate}
         FROM ${tier.source.table}
         WHERE ${tier.source.timeColumn} >= $2 AND ${tier.source.timeColumn} < $3
         GROUP BY 1, 2
         ON CONFLICT (channel_id, bucket) DO UPDATE SET
           sample_count = EXCLUDED.sample_count,
           value_sum    = EXCLUDED.value_sum,
           value_min    = EXCLUDED.value_min,
           value_max    = EXCLUDED.value_max
         RETURNING 1
       )
       SELECT count(*) AS written FROM rolled`,
      [tier.bucket, from, to],
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
  async enqueueBackfill(q: Queryable, from: Date, to: Date, reason: string): Promise<void> {
    await q.query('INSERT INTO rollup_backfill (from_time, to_time, reason) VALUES ($1, $2, $3)', [
      from,
      to,
      reason,
    ]);
  }

  /**
   * Takes the pending backfill entries and collapses them into one window.
   *
   * Only the ids it saw are returned, so entries arriving while the re-roll runs survive to the
   * next pass instead of being deleted unprocessed.
   */
  async claimBackfill(
    q: Queryable,
    limit: number,
  ): Promise<{ ids: string[]; from: Date; to: Date } | null> {
    const rows = await q.query<{ id: string; from_time: Date; to_time: Date }>(
      'SELECT id, from_time, to_time FROM rollup_backfill ORDER BY id LIMIT $1',
      [limit],
    );
    const first = rows[0];
    if (first === undefined) return null;

    let from = first.from_time;
    let to = first.to_time;
    for (const row of rows) {
      if (row.from_time < from) from = row.from_time;
      if (row.to_time > to) to = row.to_time;
    }
    return { ids: rows.map((row) => row.id), from, to };
  }

  async clearBackfill(q: Queryable, ids: readonly string[]): Promise<void> {
    await q.query('DELETE FROM rollup_backfill WHERE id = ANY($1::bigint[])', [ids]);
  }

  /**
   * Enqueues a backfill window, but only if it precedes what the five-minute tier has already
   * materialised. Returns whether it did.
   *
   * One statement on purpose. Ingestion calls this after every write, so reading the watermark
   * and deciding in this process would be both an extra round trip and a race: the housekeeping
   * pass could advance the watermark between the two.
   */
  async enqueueBackfillIfLate(
    q: Queryable,
    from: Date,
    to: Date,
    reason: string,
  ): Promise<boolean> {
    // watermark > from is exactly "the bucket this reading belongs to has been rolled up
    // already": the watermark is always on a bucket boundary, so bucket(from) < watermark
    // and from < watermark say the same thing.
    const rows = await q.query<{ id: string }>(
      `INSERT INTO rollup_backfill (from_time, to_time, reason)
       SELECT $1::timestamptz, $2::timestamptz, $3
       FROM rollup_watermark
       WHERE tier = 'sample_5m' AND watermark > $1::timestamptz
       RETURNING id`,
      [from, to, reason],
    );
    return rows.length > 0;
  }

  /** The oldest instant any pending backfill still needs, or null when the queue is empty. */
  async earliestPendingBackfill(q: Queryable): Promise<Date | null> {
    const rows = await q.query<{ from_time: Date | null }>(
      'SELECT min(from_time) AS from_time FROM rollup_backfill',
    );
    return rows[0]?.from_time ?? null;
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
   * A sensor's channels, and whether the sensor exists at all.
   *
   * One query for both, because "no such sensor" and "a sensor with no channels yet" are
   * different answers — 404 against an empty series — and asking twice would let them race.
   */
  async sensorChannels(
    q: Queryable,
    sensorId: number,
  ): Promise<{ exists: boolean; channels: ChannelRef[] }> {
    const rows = await q.query<{
      channel_id: number | null;
      key: string | null;
      name: string | null;
      unit: string | null;
      decimals: number | null;
    }>(
      `SELECT c.id AS channel_id, c.key, c.name, c.unit, c.decimals
       FROM object o
       LEFT JOIN channel c ON c.sensor_id = o.id
       WHERE o.id = $1 AND o.kind = 'sensor'
       ORDER BY c.is_primary DESC NULLS LAST, c.key`,
      [sensorId],
    );

    if (rows.length === 0) return { exists: false, channels: [] };
    const channels: ChannelRef[] = [];
    for (const row of rows) {
      if (row.channel_id === null || row.key === null) continue;
      channels.push({
        id: row.channel_id,
        key: row.key,
        name: row.name ?? row.key,
        unit: row.unit ?? '',
        decimals: row.decimals,
      });
    }
    return { exists: true, channels };
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

const KNOWN_TABLES = new Set(SAMPLE_TABLES);

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

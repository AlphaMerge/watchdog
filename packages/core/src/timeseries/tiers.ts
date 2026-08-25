/**
 * The rollup tiers, and the fact that each is built from the one below it.
 *
 * Cascading rather than each tier reading raw is both cheaper and exactly as accurate, because
 * the tiers store `value_sum` and `sample_count` instead of an average: one hour is twelve
 * five-minute rows, not sixty raw ones, and `sum(value_sum) / sum(sample_count)` weights each
 * source bucket by how many readings it actually held. See migration 004 for why an average of
 * averages would be wrong.
 */
export type RollupTierId = 'sample_5m' | 'sample_1h' | 'sample_1d';

/** Where a tier's input comes from. Raw and rollup sources have different column shapes. */
export type RollupSource =
  | { readonly kind: 'raw'; readonly table: 'sample'; readonly timeColumn: 'time' }
  | {
      readonly kind: 'rollup';
      readonly table: string;
      readonly timeColumn: 'bucket';
      readonly tier: RollupTierId;
    };

export interface RollupTier {
  /** Persisted in `rollup_watermark.tier`. Never rename one of these. */
  readonly id: RollupTierId;
  readonly table: string;
  /** PostgreSQL interval literal, bound as the engine's bucketing parameter. */
  readonly bucket: string;
  /**
   * The same interval in seconds, for slicing arithmetic in this process. Kept beside the
   * literal rather than parsed out of it — and `tiers.test.ts` asks PostgreSQL whether the two
   * agree, so they cannot drift.
   */
  readonly bucketSeconds: number;
  readonly source: RollupSource;
  /**
   * Buckets per statement. A first pass over a populated database, or a backfill spanning a
   * long probe outage, must not turn into one unbounded INSERT ... SELECT holding locks for
   * minutes: the loop takes slices until it catches up.
   */
  readonly sliceBuckets: number;
  /** Which `housekeeping.retention` key governs this tier. */
  readonly retentionKey: 'fiveMinuteDays' | 'hourlyDays' | 'dailyDays';
}

const FIVE_MINUTES: RollupTier = {
  id: 'sample_5m',
  table: 'sample_5m',
  bucket: '5 minutes',
  bucketSeconds: 300,
  source: { kind: 'raw', table: 'sample', timeColumn: 'time' },
  sliceBuckets: 288, // one day of buckets
  retentionKey: 'fiveMinuteDays',
};

const ONE_HOUR: RollupTier = {
  id: 'sample_1h',
  table: 'sample_1h',
  bucket: '1 hour',
  bucketSeconds: 3_600,
  source: { kind: 'rollup', table: 'sample_5m', timeColumn: 'bucket', tier: 'sample_5m' },
  sliceBuckets: 720, // thirty days of buckets
  retentionKey: 'hourlyDays',
};

const ONE_DAY: RollupTier = {
  id: 'sample_1d',
  table: 'sample_1d',
  bucket: '1 day',
  bucketSeconds: 86_400,
  source: { kind: 'rollup', table: 'sample_1h', timeColumn: 'bucket', tier: 'sample_1h' },
  sliceBuckets: 365,
  retentionKey: 'dailyDays',
};

/**
 * Coarsest last. The housekeeping loop depends on this order: a tier can only materialise
 * buckets its source has already materialised, so five minutes must run before one hour, which
 * must run before one day.
 */
export const ROLLUP_TIERS: readonly RollupTier[] = [FIVE_MINUTES, ONE_HOUR, ONE_DAY];

/**
 * Every table holding sample data, finest first — the three tiers plus raw.
 *
 * Retention and orphan reaping walk all four; only the three tiers are rolled up.
 */
export const SAMPLE_TABLES: readonly string[] = [
  'sample',
  ...ROLLUP_TIERS.map((tier) => tier.table),
];

export function tierById(id: RollupTierId): RollupTier {
  const tier = ROLLUP_TIERS.find((candidate) => candidate.id === id);
  /* c8 ignore next -- RollupTierId is exhaustive over ROLLUP_TIERS; this is a guard, not a path */
  if (tier === undefined) throw new Error(`unknown rollup tier: ${id}`);
  return tier;
}

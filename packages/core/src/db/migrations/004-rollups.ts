import type { Migration } from './types.js';

/**
 * Rollup tiers, the bookkeeping that drives them, and native compression.
 *
 * We write the tiers ourselves rather than using continuous aggregates. That is a licence
 * decision, made on measurements: see the ADR-001 Decision 4 amendment and
 * docs/findings/2026-08-25-rollup-storage-spike.md. Continuous aggregates were 2.4x faster to
 * refresh and a wash on disk; compression was 12.5x on disk with no Apache-licensed substitute.
 * So we take the Timescale Community licence for compression alone and keep every line of
 * rollup logic in our own code, where it stays engine-agnostic (S-12).
 *
 * Everything the TSL job scheduler would have done — refresh, compress, drop — is done by the
 * core's housekeeping loop instead, because add_job is TSL too.
 */
export const migration004: Migration = {
  id: 4,
  name: 'rollups',

  // create_hypertable and the compression ALTERs do not all belong in one transaction, and a
  // half-applied migration has to be safe to re-run. Every statement below is idempotent.
  transactional: false,

  up: `
    -- ---------------------------------------------------------------------------------------
    -- Preflight: the licence this migration depends on.
    --
    -- Native compression is Timescale License, not Apache (see the ADR-001 Decision 4
    -- amendment). Under timescaledb.license = apache the ALTER TABLE below fails with
    -- "functionality not supported under the current apache license", which names neither the
    -- setting nor the fix. The licence is a start-up parameter, so this migration cannot set it;
    -- the only useful thing it can do is say precisely what is wrong before it has created
    -- anything.
    -- ---------------------------------------------------------------------------------------
    DO $$
    DECLARE
      granted text := current_setting('timescaledb.license', true);
    BEGIN
      IF granted IS DISTINCT FROM 'timescale' THEN
        RAISE EXCEPTION 'TimescaleDB is running under the "%" licence, but this build needs the Timescale Community licence for native compression', coalesce(granted, 'unknown')
          USING
            HINT = 'Set timescaledb.license = timescale in postgresql.conf and restart PostgreSQL. The Community licence is free for self-hosted use; see Decision 4 in docs/ADR-001-architecture.md for what we depend on it for.',
            ERRCODE = 'feature_not_supported';
      END IF;
    END
    $$;

    -- ---------------------------------------------------------------------------------------
    -- The three tiers.
    --
    -- Each stores sum and count, NEVER a precomputed average. This is the whole reason the
    -- tiers can be cascaded: 5m -> 1h -> 1d is exact, because sum(value_sum) / sum(sample_count)
    -- weights each source bucket by how many readings it actually held. An average of averages
    -- is wrong the moment two buckets hold different numbers of readings, which is the normal
    -- case here — a sensor that went down mid-hour, a probe that reconnected, a check that
    -- timed out twice. Rolling 1h from 5m instead of from raw is 12 rows per channel instead of
    -- 60, and it stays exact.
    --
    -- Deliberately absent: a "last value" column. It cannot be re-aggregated up a tier without
    -- also carrying the timestamp it came from, and nothing in v1 reads a last value from a
    -- rollup — the sensor detail page reads it from the sensor's current reading. If S-08 finds
    -- it needs one, it arrives with its own timestamp column and its own re-aggregation test.
    --
    -- A bucket exists only where readings existed. There is no zero-filling and no NULL row:
    -- "no-data is not zero" (CLAUDE.md) survives the rollup because a gap in the source
    -- produces no group, and therefore no row. sample_count is consequently always >= 1.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sample_5m (
      bucket       timestamptz      NOT NULL,
      channel_id   integer          NOT NULL,
      sample_count integer          NOT NULL CHECK (sample_count > 0),
      value_sum    double precision NOT NULL,
      value_min    double precision NOT NULL,
      value_max    double precision NOT NULL,
      CONSTRAINT sample_5m_min_max CHECK (value_min <= value_max)
    );

    CREATE TABLE IF NOT EXISTS sample_1h (
      bucket       timestamptz      NOT NULL,
      channel_id   integer          NOT NULL,
      sample_count integer          NOT NULL CHECK (sample_count > 0),
      value_sum    double precision NOT NULL,
      value_min    double precision NOT NULL,
      value_max    double precision NOT NULL,
      CONSTRAINT sample_1h_min_max CHECK (value_min <= value_max)
    );

    CREATE TABLE IF NOT EXISTS sample_1d (
      bucket       timestamptz      NOT NULL,
      channel_id   integer          NOT NULL,
      sample_count integer          NOT NULL CHECK (sample_count > 0),
      value_sum    double precision NOT NULL,
      value_min    double precision NOT NULL,
      value_max    double precision NOT NULL,
      CONSTRAINT sample_1d_min_max CHECK (value_min <= value_max)
    );

    -- Chunk intervals sized from the v1 target of 5,000 sensors at ~3 channels each
    -- (CAPABILITIES.MD §13), keeping the working set of recent chunks well inside a quarter of
    -- a 16 GB box, the same rule migration 003 applied to raw:
    --   5m: 288 buckets/channel/day  -> ~4.3M rows/day  -> 7 days   = ~30M rows/chunk
    --   1h:  24 buckets/channel/day  -> ~360k rows/day  -> 30 days  = ~11M rows/chunk
    --   1d:   1 bucket /channel/day  -> ~15k rows/day   -> 365 days = ~5.5M rows/chunk
    SELECT create_hypertable('sample_5m', 'bucket',
      chunk_time_interval => INTERVAL '7 days',   if_not_exists => TRUE);
    SELECT create_hypertable('sample_1h', 'bucket',
      chunk_time_interval => INTERVAL '30 days',  if_not_exists => TRUE);
    SELECT create_hypertable('sample_1d', 'bucket',
      chunk_time_interval => INTERVAL '365 days', if_not_exists => TRUE);

    -- One index per tier, doing the same two jobs as raw's: it answers "this channel over this
    -- range" for a graph, and its uniqueness is what makes a re-roll idempotent. The rollup
    -- writes ON CONFLICT DO UPDATE and recomputes the bucket outright, so running it twice over
    -- the same window — after a crash, or because late data arrived — converges rather than
    -- double-counting.
    CREATE UNIQUE INDEX IF NOT EXISTS sample_5m_channel_bucket_key ON sample_5m (channel_id, bucket);
    CREATE UNIQUE INDEX IF NOT EXISTS sample_1h_channel_bucket_key ON sample_1h (channel_id, bucket);
    CREATE UNIQUE INDEX IF NOT EXISTS sample_1d_channel_bucket_key ON sample_1d (channel_id, bucket);

    -- ---------------------------------------------------------------------------------------
    -- Native compression: the one Timescale-License feature we depend on.
    --
    -- Measured 459 MB -> 43 MB on 900k raw readings, with a graph query against a compressed
    -- chunk still answering in 1.25 ms. Segmenting by channel_id groups each series together so
    -- its values compress against each other rather than against an interleaved neighbour's,
    -- and ordering by time inside the segment is what makes the delta encoding pay.
    --
    -- Chunks are compressed by the housekeeping loop, not by add_compression_policy, which is
    -- TSL and would also put a second scheduler in the system.
    -- ---------------------------------------------------------------------------------------
    ALTER TABLE sample SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'channel_id',
      timescaledb.compress_orderby   = 'time'
    );

    ALTER TABLE sample_5m SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'channel_id',
      timescaledb.compress_orderby   = 'bucket'
    );

    -- ---------------------------------------------------------------------------------------
    -- How far each tier is materialised.
    --
    -- Without continuous aggregates there is no real-time aggregation, so a reader cannot
    -- assume a tier is current: everything after its watermark still lives one tier down, or in
    -- raw. This table is the contract. "watermark" means every bucket STARTING BEFORE this
    -- instant is materialised; the bucket starting at it is not.
    --
    -- It cannot be derived from max(bucket) in the tier itself. A channel that has been down
    -- for a week writes no rows, so max(bucket) would say the tier had stalled a week ago and
    -- the job would rebuild seven days of empty buckets on every pass.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS rollup_watermark (
      tier       text        PRIMARY KEY,
      watermark  timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- ---------------------------------------------------------------------------------------
    -- Windows that have to be rolled up again.
    --
    -- A probe that was offline replays its disk spool on reconnect (R-02, R-03), so raw rows
    -- land with timestamps behind the watermark, inside buckets that were rolled up while the
    -- probe was away. Without this queue those readings would sit in raw, correct and invisible,
    -- until retention dropped them — the rollup would never look at that window again.
    --
    -- Ingestion enqueues a range; the housekeeping loop re-rolls it and deletes the entry. Since
    -- the rollup recomputes each bucket from scratch, replaying a window is always safe.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS rollup_backfill (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      from_time   timestamptz NOT NULL,
      to_time     timestamptz NOT NULL,
      reason      text        NOT NULL DEFAULT '',
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rollup_backfill_range CHECK (to_time > from_time)
    );

    -- ---------------------------------------------------------------------------------------
    -- Channels whose samples are now orphaned.
    --
    -- S-05 ruled out a foreign key from sample.channel_id to channel: ON DELETE CASCADE would
    -- drag millions of hypertable rows into the delete transaction while it holds the exclusive
    -- tree lock, freezing every structural operation for minutes. The consequence is that
    -- deleting a device leaves its readings behind, and S-05 directed this job to reap them.
    --
    -- A trigger records the id at the moment it stops existing. Scanning for orphans instead
    -- would mean an anti-join between a hypertable and the channel table, which is the exact
    -- query that cannot be made cheap.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS channel_reap (
      channel_id  integer     PRIMARY KEY,
      enqueued_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION channel_reap_enqueue() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO channel_reap (channel_id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
      RETURN OLD;
    END;
    $$;

    DROP TRIGGER IF EXISTS channel_reap_on_delete ON channel;
    CREATE TRIGGER channel_reap_on_delete
      AFTER DELETE ON channel
      FOR EACH ROW EXECUTE FUNCTION channel_reap_enqueue();
  `,

  down: `
    DROP TRIGGER IF EXISTS channel_reap_on_delete ON channel;
    DROP FUNCTION IF EXISTS channel_reap_enqueue();
    DROP TABLE IF EXISTS channel_reap;
    DROP TABLE IF EXISTS rollup_backfill;
    DROP TABLE IF EXISTS rollup_watermark;

    -- Compression settings cannot be removed while a compressed chunk exists, so the rollback
    -- has to undo the compression itself. This rewrites every compressed chunk back to row
    -- storage and can take a while on a populated system; that is the honest cost of rolling
    -- back, and it is better than a rollback that half-succeeds.
    SELECT decompress_chunk(c, if_compressed => TRUE) FROM show_chunks('sample_5m') c;
    ALTER TABLE sample_5m SET (timescaledb.compress = false);
    DROP TABLE IF EXISTS sample_5m;
    DROP TABLE IF EXISTS sample_1h;
    DROP TABLE IF EXISTS sample_1d;

    SELECT decompress_chunk(c, if_compressed => TRUE) FROM show_chunks('sample') c;
    ALTER TABLE sample SET (timescaledb.compress = false);
  `,
};

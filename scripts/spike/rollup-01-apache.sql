-- The Apache-2.0 path: a plain hypertable, filled by a rollup statement we run ourselves.
-- Everything here works with timescaledb.license = apache.
\timing off
DROP TABLE IF EXISTS sample_5m;
CREATE TABLE sample_5m (
  bucket     timestamptz      NOT NULL,
  channel_id integer          NOT NULL,
  avg        double precision NOT NULL,
  min        double precision NOT NULL,
  max        double precision NOT NULL,
  count      integer          NOT NULL
);
SELECT create_hypertable('sample_5m', 'bucket', chunk_time_interval => INTERVAL '7 days');
CREATE UNIQUE INDEX sample_5m_channel_bucket_key ON sample_5m (channel_id, bucket);

\echo '=== APACHE: initial fill of the whole 4-hour window ==='
\timing on
INSERT INTO sample_5m (bucket, channel_id, avg, min, max, count)
SELECT time_bucket('5 minutes', time), channel_id, avg(value), min(value), max(value), count(*)
FROM sample
GROUP BY 1, 2
ON CONFLICT (channel_id, bucket) DO UPDATE
  SET avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max, count = EXCLUDED.count;
\timing off
ANALYZE sample_5m;
SELECT count(*) AS rollup_rows FROM sample_5m;

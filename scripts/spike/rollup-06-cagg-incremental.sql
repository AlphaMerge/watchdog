-- The same "one more hour arrives" step, so the two paths are compared on identical work.
\timing off
\echo '=== CAGG: ingesting one more hour of raw readings ==='
\timing on
INSERT INTO sample (time, channel_id, value)
SELECT ts, c, 50 + 40 * sin(extract(epoch FROM ts) / 3600) + random() * 5
FROM generate_series(
       timestamptz '2026-08-01 05:00:00Z',
       timestamptz '2026-08-01 05:59:00Z',
       INTERVAL '1 minute') ts,
     generate_series(1, 15000) c;
\timing off

\echo '=== CAGG: incremental refresh of the changed window ==='
\timing on
CALL refresh_continuous_aggregate(
  'sample_5m_cagg',
  timestamptz '2026-08-01 04:55:00Z',
  NULL);
\timing off
SELECT count(*) AS cagg_rows FROM sample_5m_cagg;

\echo '=== and the Apache path doing the identical incremental work, for comparison ==='
\timing on
INSERT INTO sample_5m (bucket, channel_id, avg, min, max, count)
SELECT time_bucket('5 minutes', time), channel_id, avg(value), min(value), max(value), count(*)
FROM sample
WHERE time >= timestamptz '2026-08-01 04:55:00Z'
GROUP BY 1, 2
ON CONFLICT (channel_id, bucket) DO UPDATE
  SET avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max, count = EXCLUDED.count;
\timing off

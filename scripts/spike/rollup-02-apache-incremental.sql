-- One more hour arrives. This is the steady-state cost: what the housekeeping job pays every
-- time it runs.
\timing off
\echo '=== APACHE: ingesting one more hour of raw readings ==='
\timing on
INSERT INTO sample (time, channel_id, value)
SELECT ts, c, 50 + 40 * sin(extract(epoch FROM ts) / 3600) + random() * 5
FROM generate_series(
       timestamptz '2026-08-01 04:00:00Z',
       timestamptz '2026-08-01 04:59:00Z',
       INTERVAL '1 minute') ts,
     generate_series(1, 15000) c;
\timing off

\echo '=== APACHE: refreshing only the buckets that could have changed ==='
-- The job recomputes from a watermark rather than the whole table. A bucket can still be open
-- when the job runs, so it reaches one bucket further back than the new data.
\timing on
INSERT INTO sample_5m (bucket, channel_id, avg, min, max, count)
SELECT time_bucket('5 minutes', time), channel_id, avg(value), min(value), max(value), count(*)
FROM sample
WHERE time >= timestamptz '2026-08-01 03:55:00Z'
GROUP BY 1, 2
ON CONFLICT (channel_id, bucket) DO UPDATE
  SET avg = EXCLUDED.avg, min = EXCLUDED.min, max = EXCLUDED.max, count = EXCLUDED.count;
\timing off
SELECT count(*) AS rollup_rows FROM sample_5m;

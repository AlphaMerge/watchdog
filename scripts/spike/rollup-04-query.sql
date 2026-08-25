-- What a graph actually asks of a rollup: one channel, a range, in bucket order.
\timing off
\echo '=== APACHE: reading a rollup ==='
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT bucket, avg FROM sample_5m
WHERE channel_id = 4242 AND bucket >= '2026-08-01' AND bucket < '2026-08-02'
ORDER BY bucket;

\echo '=== and the same question answered from raw data, for comparison ==='
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT time_bucket('5 minutes', time) AS bucket, avg(value) FROM sample
WHERE channel_id = 4242 AND time >= '2026-08-01' AND time < '2026-08-02'
GROUP BY 1 ORDER BY 1;

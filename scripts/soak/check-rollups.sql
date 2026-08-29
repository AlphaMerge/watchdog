-- Rollup correctness, checked against the raw samples they were built from (TASKS.md H-01).
--
-- Run periodically during a soak. Every completed 5-minute bucket must agree with a fresh
-- aggregate of the rows underneath it, on all four numbers: how many samples, their sum, their
-- minimum and their maximum. Comparing a rollup against *itself* — which is what reading it back
-- through the API would do — cannot fail.
--
-- **Only settled buckets.** The most recent one is still being written into, and a bucket that
-- disagrees because it is half-full is not a defect. The cut is two bucket-widths back, which is
-- also past the watermark the rollup job maintains.
--
-- **`sample_count` is the one that catches the important bug.** "No data is not zero" (CLAUDE.md)
-- survives a rollup only if a gap in the source produces no row rather than a zero, so a bucket
-- whose count exceeds the rows beneath it is a gap that got filled in somewhere.
WITH settled AS (
  SELECT max(bucket) - INTERVAL '10 minutes' AS cutoff FROM sample_5m
),
raw AS (
  SELECT
    time_bucket(INTERVAL '5 minutes', s.time) AS bucket,
    s.channel_id,
    count(*)      AS sample_count,
    sum(s.value)  AS value_sum,
    min(s.value)  AS value_min,
    max(s.value)  AS value_max
  FROM sample s, settled
  WHERE s.time < settled.cutoff
    AND s.time >= settled.cutoff - INTERVAL '1 hour'
    AND s.value IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  count(*)                                                        AS buckets_checked,
  count(*) FILTER (WHERE r.sample_count IS DISTINCT FROM raw.sample_count)  AS wrong_count,
  -- Floating-point sums are compared with a tolerance rather than exactly: the rollup adds in
  -- arrival order and this adds in scan order, and double-precision addition is not associative.
  -- A tolerance of 1e-6 relative is far below any real disagreement and far above that noise.
  count(*) FILTER (
    WHERE abs(r.value_sum - raw.value_sum) > 1e-6 * greatest(abs(raw.value_sum), 1)
  )                                                               AS wrong_sum,
  count(*) FILTER (WHERE r.value_min IS DISTINCT FROM raw.value_min) AS wrong_min,
  count(*) FILTER (WHERE r.value_max IS DISTINCT FROM raw.value_max) AS wrong_max,
  count(*) FILTER (WHERE r.channel_id IS NULL)                    AS missing_rollup
FROM raw
LEFT JOIN sample_5m r ON r.channel_id = raw.channel_id AND r.bucket = raw.bucket;

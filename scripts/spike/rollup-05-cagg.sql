-- The Timescale-License path: a continuous aggregate over the same raw data.
\timing off
DROP MATERIALIZED VIEW IF EXISTS sample_5m_cagg;

CREATE MATERIALIZED VIEW sample_5m_cagg
WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', time) AS bucket,
       channel_id,
       avg(value) AS avg,
       min(value) AS min,
       max(value) AS max,
       count(*)   AS count
FROM sample
GROUP BY 1, 2
WITH NO DATA;

\echo '=== CAGG: initial materialisation of the whole window ==='
\timing on
CALL refresh_continuous_aggregate('sample_5m_cagg', NULL, NULL);
\timing off
SELECT count(*) AS cagg_rows FROM sample_5m_cagg;

-- Native compression is the other Timescale-License feature, and the one with no Apache
-- equivalent at all.
\timing off
\echo '=== sizes before compression ==='
SELECT 'sample' AS object, pg_size_pretty(hypertable_size('sample')) AS on_disk
UNION ALL SELECT 'sample_5m (apache rollup)', pg_size_pretty(hypertable_size('sample_5m'))
UNION ALL SELECT 'sample_5m_cagg', pg_size_pretty(hypertable_size('sample_5m_cagg'));

ALTER TABLE sample SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'channel_id',
  timescaledb.compress_orderby   = 'time'
);

\echo '=== compressing every raw chunk ==='
\timing on
SELECT count(*) AS chunks_compressed FROM (SELECT compress_chunk(c) FROM show_chunks('sample') c) x;
\timing off

\echo '=== sizes after compression ==='
SELECT 'sample (compressed)' AS object, pg_size_pretty(hypertable_size('sample')) AS on_disk;

\echo '=== does a graph query still work against compressed chunks? ==='
\timing on
SELECT count(*) FROM sample WHERE channel_id = 4242 AND time >= '2026-08-01' AND time < '2026-08-02';
\timing off

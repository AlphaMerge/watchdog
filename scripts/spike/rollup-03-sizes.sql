-- Disk, per object, comparable across both paths.
\timing off
SELECT
  'sample'    AS object,
  (SELECT count(*) FROM sample) AS rows,
  pg_size_pretty(hypertable_size('sample')) AS on_disk
UNION ALL
SELECT
  'sample_5m',
  (SELECT count(*) FROM sample_5m),
  pg_size_pretty(hypertable_size('sample_5m'));

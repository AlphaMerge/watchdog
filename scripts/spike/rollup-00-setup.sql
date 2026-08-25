-- Shared starting point for both rollup paths: the real S-05 schema, filled with a realistic
-- shape of data.
--
-- 15,000 channels is the v1 target (5,000 sensors x ~3 channels, CAPABILITIES.MD §13) and the
-- interval is 60 seconds, so four hours is 3.6 million readings — enough to measure against
-- without waiting for a full day's 21.6 million.
\timing off
CREATE EXTENSION IF NOT EXISTS timescaledb;

DROP TABLE IF EXISTS sample CASCADE;
CREATE TABLE sample (
  time       timestamptz      NOT NULL,
  channel_id integer          NOT NULL,
  value      double precision NOT NULL
);
SELECT create_hypertable('sample', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE UNIQUE INDEX sample_channel_time_key ON sample (channel_id, time);

\echo '=== generating 4 hours x 15,000 channels ==='
\timing on
INSERT INTO sample (time, channel_id, value)
SELECT ts, c, 50 + 40 * sin(extract(epoch FROM ts) / 3600) + random() * 5
FROM generate_series(
       timestamptz '2026-08-01 00:00:00Z',
       timestamptz '2026-08-01 03:59:00Z',
       INTERVAL '1 minute') ts,
     generate_series(1, 15000) c;
\timing off

ANALYZE sample;
SELECT count(*) AS raw_rows FROM sample;

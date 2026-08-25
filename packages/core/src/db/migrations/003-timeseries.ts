import type { Migration } from './types.js';

/**
 * The two time-series tables: channel readings, and sensor state history.
 *
 * They are deliberately different shapes because they answer different questions.
 * `sample` answers "what was this channel reading at 14:05"; `sensor_state` answers "was this
 * sensor up between Tuesday and Friday". Uptime and SLA come from the second, never the first
 * (CLAUDE.md), so they stay correct across rollups and across gaps.
 */
export const migration003: Migration = {
  id: 3,
  name: 'timeseries',

  // TimescaleDB's create_hypertable and the policy calls below cannot all run inside one
  // transaction, and a partially applied migration must be safe to re-run.
  transactional: false,

  up: `
    -- ---------------------------------------------------------------------------------------
    -- Preflight.
    --
    -- Without this the operator sees 'function create_hypertable(...) does not exist', which
    -- names neither the missing component nor the fix. The extension cannot be installed from
    -- here — it needs a package, an entry in shared_preload_libraries and a restart — so the
    -- only useful thing this migration can do is say so precisely.
    -- ---------------------------------------------------------------------------------------
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE EXCEPTION 'the TimescaleDB extension is not installed in this database'
          USING
            HINT = 'Install the timescaledb package for your PostgreSQL version, add timescaledb to shared_preload_libraries, restart PostgreSQL, then run: CREATE EXTENSION timescaledb;',
            ERRCODE = 'feature_not_supported';
      END IF;
    END
    $$;

    -- ---------------------------------------------------------------------------------------
    -- Channel readings.
    --
    -- No foreign key to channel, on purpose (directed by S-03). ON DELETE CASCADE would pull
    -- millions of hypertable rows into the delete transaction while it holds the exclusive
    -- tree lock, turning "delete this test group" into a multi-minute freeze of every
    -- structural operation — and it would break in production rather than in test. Orphaned
    -- samples are reaped by housekeeping, which walks the data anyway.
    --
    -- value is NOT NULL because a missing reading is a missing ROW. "No-data is not zero"
    -- (CLAUDE.md) and no-data is not a NULL sitting in a row either: a Down sensor records no
    -- channel values at all, and the gap has to survive storage, rollup, query and rendering.
    -- Making the column NOT NULL means nobody can quietly write a placeholder.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sample (
      time       timestamptz      NOT NULL,
      channel_id integer          NOT NULL,
      value      double precision NOT NULL
    );

    -- One day per chunk, not the seven-day default.
    --
    -- The v1 target is 5,000 sensors at a 60-second interval (CAPABILITIES.MD §13). At roughly
    -- three channels a sensor that is ~21.6 million rows a day, so a seven-day chunk would hold
    -- ~150 million — far past the point where its indexes stop fitting in memory on the 16 GB
    -- box the target names. Timescale's own guidance is that the working set of recent chunks
    -- should fit in about a quarter of RAM.
    SELECT create_hypertable(
      'sample', 'time',
      chunk_time_interval => INTERVAL '1 day',
      if_not_exists => TRUE
    );

    -- ONE index of our own, doing two jobs.
    --
    -- It answers the query that matters — "this channel, over this range, newest first", which
    -- is what a graph asks — because PostgreSQL reads a btree backwards just as happily as
    -- forwards, so a separate DESC index buys nothing. Measured: adding one took storage from
    -- 99.3 to 139.7 bytes a row, which is 32 GB of the 112 GB that 40 days of raw data occupy
    -- at the v1 target. Indexes are most of this table's size, so a redundant one is not a
    -- rounding error.
    --
    -- It also makes replay idempotent. A probe reconnecting after an outage streams its disk
    -- spool (R-02, R-03), and a partly acknowledged spool resends rows the core already has,
    -- so ingestion can say ON CONFLICT DO NOTHING rather than reason about exactly-once
    -- delivery.
    --
    -- create_hypertable() also leaves a plain (time DESC) index behind. That one stays: the
    -- rollup job (S-06) scans a time window across every channel, which is exactly what it
    -- serves and what the composite index cannot.
    CREATE UNIQUE INDEX IF NOT EXISTS sample_channel_time_key ON sample (channel_id, time);

    -- ---------------------------------------------------------------------------------------
    -- Sensor state history.
    --
    -- All eight PRTG states exist in the type even though v1 implements six: Unusual needs
    -- historic baselining and Down (Partial) needs clustering, both [V2] (CAPABILITIES.MD §2).
    -- The type accommodating them costs nothing; a later migration that has to rewrite an enum
    -- on a hypertable costs a great deal.
    -- ---------------------------------------------------------------------------------------
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sensor_state_kind') THEN
        CREATE TYPE sensor_state_kind AS ENUM (
          'unknown',
          'up',
          'warning',
          'down',
          'down_acknowledged',
          'down_partial',
          'unusual',
          'paused'
        );
      END IF;

      -- Why the sensor entered this state. WORKFLOW.MD §4 rule 7: every transition is logged
      -- with its cause, and "the sensor went down" is not a diagnosis on its own.
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sensor_state_cause') THEN
        CREATE TYPE sensor_state_cause AS ENUM (
          'scan',           -- the check succeeded or failed
          'limit',          -- a channel crossed an error or warning limit
          'lookup',         -- a lookup mapped a value to a state
          'user',           -- acknowledged, paused or resumed by a person
          'schedule',       -- an inactive schedule window
          'dependency',     -- a master object went down
          'parent',         -- a hierarchical pause cascade
          'probe',          -- the probe carrying this sensor went away
          'simulated'       -- a forced state, for testing a notification chain
        );
      END IF;
    END
    $$;

    CREATE TABLE IF NOT EXISTS sensor_state (
      time           timestamptz        NOT NULL,
      sensor_id      bigint             NOT NULL,
      state          sensor_state_kind  NOT NULL,
      -- Stored rather than derived from the preceding row: retention eventually drops that row,
      -- and "what did it change from" must survive it. WORKFLOW.MD §4 requires the previous
      -- state on every transition.
      previous_state sensor_state_kind,
      cause          sensor_state_cause NOT NULL,
      message        text               NOT NULL DEFAULT ''
    );

    -- A week per chunk: state changes are orders of magnitude rarer than readings, and uptime
    -- queries span months, so wider chunks mean fewer of them to touch.
    SELECT create_hypertable(
      'sensor_state', 'time',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE
    );

    -- One index doing three jobs: uniqueness for replay, backwards scans for "what is this
    -- sensor's latest state", and — thanks to INCLUDE — an index-only answer to that question.
    -- The alarms view asks it for every sensor at once, so avoiding a heap fetch per sensor is
    -- the difference between one page read and five thousand.
    CREATE UNIQUE INDEX IF NOT EXISTS sensor_state_sensor_time_key
      ON sensor_state (sensor_id, time)
      INCLUDE (state);
  `,

  down: `
    DROP TABLE IF EXISTS sensor_state;
    DROP TYPE IF EXISTS sensor_state_cause;
    DROP TYPE IF EXISTS sensor_state_kind;
    DROP TABLE IF EXISTS sample;
  `,
};

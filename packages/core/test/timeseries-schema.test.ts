import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { silent } from './support/tree.js';

const available = await databaseAvailable();

describe(
  'time-series schema',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;

    before(async () => {
      scratch = await createScratchDatabase('timeseries');
      await new Migrator({ db: scratch.db, logger: silent, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    it('can read the licence setting migration 004 refuses to start without', async () => {
      // Migration 004's preflight reads this GUC by name. If the name were wrong,
      // current_setting(..., true) would return NULL and every install would be told it was
      // running under an "unknown" licence — so the name is worth pinning down here rather than
      // discovering on a customer's box.
      const rows = await scratch.db.query<{ granted: string | null }>(
        "SELECT current_setting('timescaledb.license', true) AS granted",
      );
      assert.equal(
        rows[0]?.granted,
        'timescale',
        'the test database runs the licence production runs, so compression is exercised here',
      );
    });

    it('creates both tables as hypertables', async () => {
      const rows = await scratch.db.query<{ hypertable_name: string }>(
        `SELECT hypertable_name FROM timescaledb_information.hypertables
         WHERE hypertable_schema = 'public' ORDER BY hypertable_name`,
      );
      // Exhaustive on purpose: raw plus state from this migration, and the three rollup tiers
      // migration 004 adds. A hypertable appearing here that nobody meant to create is a bug
      // worth failing on.
      assert.deepEqual(
        rows.map((r) => r.hypertable_name),
        ['sample', 'sample_1d', 'sample_1h', 'sample_5m', 'sensor_state'],
      );
    });

    it('uses the tuned chunk intervals, not the seven-day default', async () => {
      const rows = await scratch.db.query<{
        hypertable_name: string;
        time_interval: { days?: number; hours?: number } | string;
      }>(
        `SELECT h.hypertable_name, d.time_interval
         FROM timescaledb_information.hypertables h
         JOIN timescaledb_information.dimensions d
           ON d.hypertable_name = h.hypertable_name
         WHERE h.hypertable_schema = 'public'`,
      );

      const days = (value: { days?: number; hours?: number } | string): number =>
        typeof value === 'string' ? Number.NaN : (value.days ?? 0) + (value.hours ?? 0) / 24;
      const byTable = new Map(rows.map((r) => [r.hypertable_name, days(r.time_interval)]));

      // One day for samples: at the v1 target of 5,000 sensors on a 60-second interval, a
      // seven-day chunk would hold ~150 million rows and its indexes would stop fitting in
      // memory on the 16 GB box that target names.
      assert.equal(byTable.get('sample'), 1);
      // A week for state: transitions are orders of magnitude rarer, and uptime queries span
      // months, so wider chunks mean fewer of them to touch.
      assert.equal(byTable.get('sensor_state'), 7);
    });

    it('partitions rows into one chunk per day', async () => {
      await scratch.db.query(`
        INSERT INTO sample (time, channel_id, value)
        SELECT now() - (g || ' hours')::interval, 1, g
        FROM generate_series(1, 72) g
      `);

      const rows = await scratch.db.query<{ count: string }>(
        `SELECT count(*) AS count FROM timescaledb_information.chunks
         WHERE hypertable_name = 'sample'`,
      );
      // 72 hours spans three or four daily chunks depending on the time of day.
      assert.ok(Number(rows[0]?.count) >= 3, 'the data was actually partitioned');
    });

    it('has no foreign key from sample to channel', async () => {
      // Deliberate (directed by S-03): ON DELETE CASCADE would drag millions of hypertable
      // rows into the delete transaction while it holds the exclusive tree lock.
      const rows = await scratch.db.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.table_constraints
         WHERE table_name IN ('sample', 'sensor_state') AND constraint_type = 'FOREIGN KEY'`,
      );
      assert.equal(rows[0]?.count, '0');
    });

    it('refuses a NULL reading, because a gap is the absence of a row', async () => {
      await assert.rejects(
        () =>
          scratch.db.query('INSERT INTO sample (time, channel_id, value) VALUES (now(), 2, NULL)'),
        /null value|not-null/i,
      );
    });

    it('makes replay idempotent for samples and for state', async () => {
      // A probe reconnecting after an outage resends part of its spool (R-02, R-03). The
      // unique index lets ingestion say ON CONFLICT DO NOTHING rather than reason about
      // exactly-once delivery.
      const at = new Date('2026-08-25T10:00:00Z');

      await scratch.db.query('INSERT INTO sample (time, channel_id, value) VALUES ($1, 99, 1.5)', [
        at,
      ]);
      await assert.rejects(
        () =>
          scratch.db.query('INSERT INTO sample (time, channel_id, value) VALUES ($1, 99, 9.9)', [
            at,
          ]),
        /duplicate key|unique/i,
      );

      const inserted = await scratch.db.query<{ count: string }>(
        `INSERT INTO sample (time, channel_id, value) VALUES ($1, 99, 9.9)
         ON CONFLICT (channel_id, time) DO NOTHING
         RETURNING 1 AS count`,
        [at],
      );
      assert.equal(inserted.length, 0, 'a replayed row is dropped, not duplicated');

      const value = await scratch.db.query<{ value: number }>(
        'SELECT value FROM sample WHERE channel_id = 99 AND time = $1',
        [at],
      );
      assert.equal(value[0]?.value, 1.5, 'and the original reading is untouched');
    });

    it('accepts every state the specification names, including the v2 ones', async () => {
      const states = [
        'unknown',
        'up',
        'warning',
        'down',
        'down_acknowledged',
        'down_partial',
        'unusual',
        'paused',
      ];

      for (const [index, state] of states.entries()) {
        await scratch.db.query(
          `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
           VALUES ($1, 7, $2::sensor_state_kind, 'unknown', 'scan', $3)`,
          [new Date(Date.UTC(2026, 0, 1, index)), state, `entered ${state}`],
        );
      }

      const rows = await scratch.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM sensor_state WHERE sensor_id = 7',
      );
      assert.equal(rows[0]?.count, String(states.length));
    });

    it('rejects a state or cause the specification does not name', async () => {
      await assert.rejects(
        () =>
          scratch.db.query(
            `INSERT INTO sensor_state (time, sensor_id, state, cause)
             VALUES (now(), 8, 'flapping', 'scan')`,
          ),
        /invalid input value for enum/,
      );
      await assert.rejects(
        () =>
          scratch.db.query(
            `INSERT INTO sensor_state (time, sensor_id, state, cause)
             VALUES (now(), 8, 'down', 'vibes')`,
          ),
        /invalid input value for enum/,
      );
    });

    it('records what a sensor changed from, so retention cannot erase it', async () => {
      await scratch.db.query(
        `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message)
         VALUES ($1, 11, 'warning', 'up', 'scan', 'ping timed out'),
                ($2, 11, 'down', 'warning', 'scan', 'ping timed out again')`,
        [new Date('2026-08-25T10:00:00Z'), new Date('2026-08-25T10:01:00Z')],
      );

      const rows = await scratch.db.query<{ state: string; previous_state: string }>(
        'SELECT state, previous_state FROM sensor_state WHERE sensor_id = 11 ORDER BY time',
      );
      assert.deepEqual(rows, [
        { state: 'warning', previous_state: 'up' },
        { state: 'down', previous_state: 'warning' },
      ]);
    });

    it('answers "what is this sensor doing now" with an index scan, not a sort', async () => {
      await scratch.db.query(`
        INSERT INTO sensor_state (time, sensor_id, state, cause)
        SELECT now() - (g || ' minutes')::interval, 12,
               (ARRAY['up','warning','down'])[1 + g % 3]::sensor_state_kind, 'scan'
        FROM generate_series(1, 500) g
      `);
      await scratch.db.query('ANALYZE sensor_state');

      // **`ANALYZE`, because TimescaleDB will not say what it has not done yet.** From 2.30.0 the
      // plan is wrapped in `Custom Scan (DeferredChunkAppend)`, which defers chunk exclusion to
      // execution time and prints no children at all under a plain `EXPLAIN` — so the assertion
      // below saw a four-line plan with no scan named in it and failed, on a query whose plan had
      // not changed. Running it is what expands the node; `Order: "time" DESC` on the wrapper is
      // the ordered append, and the `Index Scan` this looks for is the child underneath it.
      //
      // Found when CI first ran on a local runner against 2.30.0 while the developer's stack was
      // still on 2.29.2 — the same moving `latest-pg17` tag, two versions (`P-198`). The image is
      // pinned now, and this reads through the wrapper either way.
      const plan = await scratch.db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
         SELECT state FROM sensor_state WHERE sensor_id = 12 ORDER BY time DESC LIMIT 1`,
      );
      const text = plan.map((r) => r['QUERY PLAN']).join('\n');
      assert.match(text, /Index (Only )?Scan/, `expected an index scan, got:\n${text}`);
      assert.ok(!/\bSort\b/.test(text), `the current state must not need a sort:\n${text}`);
    });

    it('carries no index that another index already covers', async () => {
      // Indexes are the majority of this table's size — measured at 62.6% before the redundant
      // ones came out. A duplicate here costs 32 GB across 40 days at the v1 target.
      const rows = await scratch.db.query<{ tablename: string; indexdef: string }>(
        `SELECT tablename, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ('sample', 'sensor_state')
         ORDER BY tablename, indexname`,
      );

      // Two per table: the (time DESC) index create_hypertable() leaves behind, which the
      // rollup job needs for range scans across every channel, and one of ours.
      const ours = rows.filter((r) => !/USING btree \("time" DESC\)$/.test(r.indexdef.trim()));
      assert.equal(
        ours.length,
        2,
        `expected one index of our own per table, got:\n${rows.map((r) => r.indexdef).join('\n')}`,
      );
      assert.ok(
        ours.every((r) => r.indexdef.includes('UNIQUE')),
        'and each of ours is the unique one, earning its keep twice over',
      );
    });

    it('serves a newest-first graph query by scanning the index backwards', async () => {
      await scratch.db.query(`
        INSERT INTO sample (time, channel_id, value)
        SELECT timestamptz '2026-07-01 00:00:00Z' + (g || ' minutes')::interval, 500, g
        FROM generate_series(1, 2000) g
      `);
      await scratch.db.query('ANALYZE sample');

      const plan = await scratch.db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF)
         SELECT time, value FROM sample
         WHERE channel_id = 500 AND time >= '2026-07-01' AND time < '2026-07-02'
         ORDER BY time DESC LIMIT 500`,
      );
      const text = plan.map((r) => r['QUERY PLAN']).join('\n');

      // A separate DESC index would buy nothing: PostgreSQL reads a btree backwards.
      assert.match(text, /Index Scan Backward/, `expected a backward index scan, got:\n${text}`);
      assert.ok(!/\bSort\b/.test(text), `and no sort:\n${text}`);
    });

    it('rolls the whole time-series schema back and forward again', async () => {
      const fresh = await createScratchDatabase('timeseries_roundtrip');
      try {
        const migrator = new Migrator({
          db: fresh.db,
          logger: silent,
          migrations: MIGRATIONS,
        });
        await migrator.up();

        // Everything stacked on top of this migration has to come off first, and the count is
        // derived rather than written down — a later migration should not silently turn this
        // into a test of something else.
        const index = MIGRATIONS.findIndex((migration) => migration.name === 'timeseries');
        assert.ok(index >= 0);
        const steps = MIGRATIONS.length - index;
        await migrator.down(steps);
        const gone = await fresh.db.query<{ exists: boolean }>(
          "SELECT to_regclass('sample') IS NOT NULL AS exists",
        );
        assert.equal(gone[0]?.exists, false);

        const enums = await fresh.db.query<{ count: string }>(
          `SELECT count(*) AS count FROM pg_type
           WHERE typname IN ('sensor_state_kind', 'sensor_state_cause')`,
        );
        assert.equal(enums[0]?.count, '0', 'the enum types go with the table');

        const { applied } = await migrator.up();
        assert.equal(applied.length, steps, 'and they all apply cleanly a second time');
      } finally {
        await fresh.drop();
      }
    });
  },
);

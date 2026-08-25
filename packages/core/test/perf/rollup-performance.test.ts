import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator } from '../../src/db/migrator.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { SqlTimeSeriesStore } from '../../src/timeseries/store.js';
import { tierById } from '../../src/timeseries/tiers.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { silent } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement, per CLAUDE.md: "performance claims need a measurement committed to
 * the repo, not an assertion".
 *
 * The claim is that the housekeeping loop keeps up at the v1 target — 5,000 sensors at a
 * 60-second interval, roughly three channels each (CAPABILITIES.MD §13) — with room to spare,
 * and that native compression is worth the Timescale Community licence we took for it
 * (ADR-001 Decision 4 amendment).
 *
 * The unit measured is the real one: a full five-minute bucket across every channel in the
 * target, rolled up by the same repository the service runs. Nothing here is extrapolated from
 * a smaller channel count.
 */
const CHANNELS = 15_000;
const BUCKETS = 4;
const MINUTES = BUCKETS * 5;

describe(
  'rollup performance at the v1 target',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    const repo = new SqlTimeSeriesStore();

    before(async () => {
      scratch = await createScratchDatabase('rollupperf');
      await new Migrator({ db: scratch.db, logger: silent, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    it('rolls up a full five-minute bucket for 15,000 channels well inside its period', async () => {
      const db = scratch.db;

      // Two days back so every bucket at every tier is closed, and aligned to a day boundary so
      // one day contains the whole dataset.
      const start = await db.query<{ at: Date }>(
        "SELECT time_bucket('1 day', now() - interval '2 days') AS at",
      );
      const from = start[0]?.at;
      assert.ok(from);
      const to = new Date(from.getTime() + MINUTES * 60_000);

      const generated = process.hrtime.bigint();
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT ts, ch, 50 + 40 * sin(extract(epoch FROM ts) / 600.0 + ch)
         FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 minute',
                              interval '1 minute') ts,
              generate_series(1, $3::int) ch`,
        [from, to, CHANNELS],
      );
      const generateMs = Number(process.hrtime.bigint() - generated) / 1e6;

      const rawRows = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(Number(rawRows[0]?.count), CHANNELS * MINUTES);

      // Raw -> five minutes. This is the tier that matters: everything above it reads a dataset
      // an order of magnitude smaller.
      const fiveMinute = tierById('sample_5m');
      const startedFive = process.hrtime.bigint();
      const fiveWritten = await db.tx((q) => repo.rollUp(q, fiveMinute, from, to));
      const fiveMs = Number(process.hrtime.bigint() - startedFive) / 1e6;
      assert.equal(fiveWritten, CHANNELS * BUCKETS);

      const hourly = tierById('sample_1h');
      const hourFrom = new Date(from.getTime());
      const hourTo = new Date(from.getTime() + 3_600_000);
      const startedHour = process.hrtime.bigint();
      const hourWritten = await db.tx((q) => repo.rollUp(q, hourly, hourFrom, hourTo));
      const hourMs = Number(process.hrtime.bigint() - startedHour) / 1e6;
      assert.equal(hourWritten, CHANNELS);

      const daily = tierById('sample_1d');
      const dayTo = new Date(from.getTime() + 86_400_000);
      const startedDay = process.hrtime.bigint();
      const dayWritten = await db.tx((q) => repo.rollUp(q, daily, from, dayTo));
      const dayMs = Number(process.hrtime.bigint() - startedDay) / 1e6;
      assert.equal(dayWritten, CHANNELS);

      const sizes = new Map<string, number>();
      for (const table of ['sample', 'sample_5m', 'sample_1h', 'sample_1d']) {
        const rows = await db.query<{ bytes: string }>(
          'SELECT hypertable_size($1::regclass) AS bytes',
          [table],
        );
        sizes.set(table, Number(rows[0]?.bytes ?? 0));
      }

      const perBucketMs = fiveMs / BUCKETS;
      const rawBytesPerRow = (sizes.get('sample') ?? 0) / (CHANNELS * MINUTES);
      const rollupBytesPerRow = (sizes.get('sample_5m') ?? 0) / (CHANNELS * BUCKETS);

      process.stdout.write(
        `\n    measured, ${String(CHANNELS)} channels at 60s (the v1 target):\n` +
          `      generated  ${String(CHANNELS * MINUTES)} raw readings in ${generateMs.toFixed(0)} ms\n` +
          `      raw -> 5m  ${fiveMs.toFixed(0)} ms for ${String(BUCKETS)} buckets ` +
          `(${perBucketMs.toFixed(0)} ms per 5-minute bucket, budget 300,000 ms)\n` +
          `      5m  -> 1h  ${hourMs.toFixed(0)} ms for ${String(hourWritten)} buckets\n` +
          `      1h  -> 1d  ${dayMs.toFixed(0)} ms for ${String(dayWritten)} buckets\n` +
          `      on disk    raw ${rawBytesPerRow.toFixed(1)} B/row, ` +
          `5m ${rollupBytesPerRow.toFixed(1)} B/row\n`,
      );

      // The rollup has a five-minute period to do five minutes of work in. Anything approaching
      // a tenth of that means the loop is on course to fall behind and never catch up, which is
      // the failure mode this bound exists to catch — not the exact millisecond count, which
      // depends on the machine.
      assert.ok(
        perBucketMs < 30_000,
        `a five-minute bucket took ${perBucketMs.toFixed(0)} ms of its 300,000 ms period`,
      );
    });

    it('compresses a day of readings per channel by an order of magnitude', async () => {
      const db = scratch.db;

      // Compression works on batches of rows within a segment, so the ratio depends on how many
      // readings each channel holds inside a chunk — not on how many channels there are. At the
      // v1 target a one-day chunk holds 1,440 readings per channel, so that is the shape worth
      // measuring; a wide-but-shallow dataset understates it badly. Measured at 4.4x with 20
      // readings per channel against 12.5x in the spike, purely from that difference.
      for (const table of ['sample', 'sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query(`SELECT drop_chunks($1::regclass, older_than => 'infinity'::timestamptz)`, [
          table,
        ]);
      }

      const start = await db.query<{ at: Date }>(
        "SELECT time_bucket('1 day', now() - interval '5 days') AS at",
      );
      const from = start[0]?.at;
      assert.ok(from);
      const to = new Date(from.getTime() + 86_400_000);

      const channels = 300;
      const perChannel = 1_440;
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT ts, ch, 50 + 40 * sin(extract(epoch FROM ts) / 600.0 + ch)
         FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 minute',
                              interval '1 minute') ts,
              generate_series(1, $3::int) ch`,
        [from, to, channels],
      );

      const sized = await db.query<{ bytes: string }>("SELECT hypertable_size('sample') AS bytes");
      const before = Number(sized[0]?.bytes ?? 0);

      const startedCompress = process.hrtime.bigint();
      await db.query('SELECT compress_chunk(c) FROM show_chunks($1::regclass) c', ['sample']);
      const compressMs = Number(process.hrtime.bigint() - startedCompress) / 1e6;

      const after = await db.query<{ bytes: string }>("SELECT hypertable_size('sample') AS bytes");
      const afterBytes = Number(after[0]?.bytes ?? 0);
      const ratio = before / afterBytes;

      // A graph still has to be answerable against columnar storage, or the saving is academic.
      const startedRead = process.hrtime.bigint();
      const read = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM sample WHERE channel_id = $1 AND time >= $2 AND time < $3',
        [42, from, to],
      );
      const readMs = Number(process.hrtime.bigint() - startedRead) / 1e6;
      assert.equal(Number(read[0]?.count), perChannel);

      process.stdout.write(
        `\n    measured, ${String(channels)} channels x ${String(perChannel)} readings ` +
          `(one day per channel, the production chunk shape):\n` +
          `      compressed ${(before / 1e6).toFixed(1)} MB -> ${(afterBytes / 1e6).toFixed(1)} MB ` +
          `(${ratio.toFixed(1)}x) in ${compressMs.toFixed(0)} ms\n` +
          `      graph read against compressed chunks ${readMs.toFixed(1)} ms\n`,
      );

      // This ratio is the entire reason we took the Timescale Community licence. If it ever
      // falls to single figures the trade needs revisiting, not quietly accepting.
      assert.ok(ratio > 8, `compression achieved only ${ratio.toFixed(1)}x`);
    });
  },
);

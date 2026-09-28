import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator } from '../../src/db/migrator.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import {
  BACKFILL_CHANNEL_BATCH,
  MAX_BACKFILL_DAYS_PER_PASS,
} from '../../src/timeseries/housekeeper.js';
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
 * One backfill batch-day, measured (`P-226`).
 *
 * A backfill works in batch-days: one day of one batch of channels, re-rolled in every tier, one
 * transaction a tier, into chunks that are compressed by then. A pass takes batch-days until half
 * the housekeeping interval has gone, and always takes at least one. So the number that matters
 * is how long one takes: it says how many a pass gets through, and it is how far the one a pass
 * always takes can overrun. The bound asserted is that a pass gets through at least four, which
 * keeps the one it always takes well inside the budget.
 *
 * **The first measurement failed a different bound, and the bound was wrong.** It divided the
 * interval by the 64 slices a pass then took, as if each were a five-minute slice. A pass takes
 * slices a tier at a time, and the hour and day tiers cost a twentieth of the five-minute one or
 * less.
 * That run is why the pass is now bounded by time rather than by a count; the findings have it.
 *
 * The shape is the worst a slice can meet at the v1 target: a full batch of channels, a full day
 * of readings at 60 s in compressed raw, a full day of five-minute buckets in a compressed chunk,
 * and a second day's worth of late readings on top, so that every bucket is recomputed and every
 * compressed batch it touches is unpacked.
 */
const CHANNELS = BACKFILL_CHANNEL_BATCH;
/** Half the default housekeeping interval, which is what `#reroll` gives a pass. */
const PASS_BUDGET_MS = 300_000 / 2;
const MINIMUM_DAYS_PER_PASS = 4;

describe(
  'a backfill slice at the v1 target',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    const store = new SqlTimeSeriesStore();

    before(async () => {
      scratch = await createScratchDatabase('backfillperf');
      await new Migrator({ db: scratch.db, logger: silent, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    it(`re-rolls a day of ${String(CHANNELS)} channels into compressed chunks`, async () => {
      const db = scratch.db;
      const start = await db.query<{ at: Date }>(
        "SELECT time_bucket('1 day', now() - interval '3 days') AS at",
      );
      const day = start[0]?.at;
      assert.ok(day);
      const next = new Date(day.getTime() + 86_400_000);
      const channels = Array.from({ length: CHANNELS }, (_, index) => index + 1);

      // What the core already held: a day at 60 s, rolled up and compressed.
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT ts, ch, 50 + 40 * sin(extract(epoch FROM ts) / 600.0 + ch)
         FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 minute',
                              interval '1 minute') ts,
              generate_series(1, $3::int) ch`,
        [day, next, CHANNELS],
      );
      for (const id of ['sample_5m', 'sample_1h', 'sample_1d'] as const) {
        await db.tx((q) => store.rollUp(q, tierById(id), day, next));
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [id]);
      }
      for (const table of ['sample', 'sample_5m']) {
        await db.query(`SELECT compress_chunk(c) FROM show_chunks($1::regclass) c`, [table]);
      }

      // The replay: a second reading a minute for every channel, thirty seconds off the first,
      // written into the compressed raw chunk. Timed for the record; it is ingestion's cost, not
      // the slice's.
      const replayed = process.hrtime.bigint();
      await db.tx(async (q) => {
        await store.allowDecompression(q);
        await q.query(
          `INSERT INTO sample (time, channel_id, value)
           SELECT ts + interval '30 seconds', ch, 10
           FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 minute',
                                interval '1 minute') ts,
                generate_series(1, $3::int) ch
           ON CONFLICT (channel_id, time) DO NOTHING`,
          [day, next, CHANNELS],
        );
      });
      const replayMs = Number(process.hrtime.bigint() - replayed) / 1e6;

      // The batch-day, in each tier, exactly as `#backfillDay` runs it.
      const measured: { id: string; ms: number; written: number }[] = [];
      for (const id of ['sample_5m', 'sample_1h', 'sample_1d'] as const) {
        const tier = tierById(id);
        const started = process.hrtime.bigint();
        const written = await db.tx(async (q) => {
          await store.allowDecompression(q);
          return store.rollUp(q, tier, day, next, { channels, conflict: 'recompute' });
        });
        measured.push({ id, ms: Number(process.hrtime.bigint() - started) / 1e6, written });
      }

      const five = measured[0];
      assert.ok(five);
      assert.equal(five.written, CHANNELS * 288, 'every five-minute bucket of the day, recomputed');
      const doubled = await db.query<{ n: number }>(
        'SELECT min(sample_count)::int AS n FROM sample_5m WHERE bucket >= $1 AND bucket < $2',
        [day, next],
      );
      assert.equal(doubled[0]?.n, 10, 'with the late readings in them');

      const dayMs = measured.reduce((sum, one) => sum + one.ms, 0);
      const perPass = Math.min(
        MAX_BACKFILL_DAYS_PER_PASS,
        Math.max(1, Math.ceil(PASS_BUDGET_MS / dayMs)),
      );
      process.stdout.write(
        `\n    measured, one backfill batch-day: one day of ${String(CHANNELS)} channels at 60 s:\n` +
          `      replay     ${String(CHANNELS * 1_440)} late readings into compressed raw in ` +
          `${replayMs.toFixed(0)} ms (ingestion's cost, for the record)\n` +
          measured
            .map(
              (one) =>
                `      ${one.id.padEnd(10)} ${one.ms.toFixed(0)} ms for ${String(one.written)} buckets\n`,
            )
            .join('') +
          `      batch-day  ${dayMs.toFixed(0)} ms, so a pass of ${String(PASS_BUDGET_MS)} ms takes ` +
          `about ${String(perPass)} (${String(perPass * CHANNELS)} channel-days)\n`,
      );
      assert.ok(
        dayMs * MINIMUM_DAYS_PER_PASS < PASS_BUDGET_MS,
        `a batch-day took ${dayMs.toFixed(0)} ms; a pass of ${String(PASS_BUDGET_MS)} ms would ` +
          `get through fewer than ${String(MINIMUM_DAYS_PER_PASS)}`,
      );
    });
  },
);

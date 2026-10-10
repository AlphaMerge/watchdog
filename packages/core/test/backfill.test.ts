import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { HousekeepingConfig, IngestionConfig } from '@ms/shared';
import { Database, type Queryable } from '../src/db/pool.js';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import {
  alignDown,
  BACKFILL_CHANNEL_BATCH,
  BACKFILL_RETRY,
  MAX_BACKFILL_DAYS_PER_PASS,
  Housekeeper,
  type HousekeepingReport,
} from '../src/timeseries/housekeeper.js';
import type { StorageEngine } from '../src/timeseries/engine.js';
import { SqlTimeSeriesStore, type RollOptions } from '../src/timeseries/store.js';
import type { RollupTier } from '../src/timeseries/tiers.js';
import { SAMPLE_TABLES, tierById } from '../src/timeseries/tiers.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { silent } from './support/tree.js';

const available = await databaseAvailable();

/**
 * What a backfill may touch, and what happens when one fails (`P-226`).
 *
 * **Everything here runs against a database whose decompression limit is ten rows**, set on the
 * scratch database with `ALTER DATABASE` so that every connection the test opens has it. At
 * TimescaleDB's default of 100,000 a test would need a hundred thousand rows in a compressed
 * chunk before a missing `allowDecompression` showed, so at the default it would pass whether or
 * not the limit is lifted. The first test proves the limit is in force.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const STEP_MS = 10 * 60_000;
const LIMIT = 10;

const REPLAYED = 8_101;
const OTHERS = [8_102, 8_103] as const;

function housekeeping(overrides: Partial<HousekeepingConfig> = {}): HousekeepingConfig {
  return {
    enabled: true,
    intervalSeconds: 300,
    rollupLagSeconds: 0,
    retention: {
      // Shorter than the replay below, which is the whole of round 3's case.
      rawDays: 7,
      fiveMinuteDays: 365,
      hourlyDays: 730,
      dailyDays: 3_650,
      auditDays: 730,
      stateDays: 3_650,
      reportDays: 90,
      reportRunDays: 730,
    },
    // As early as the configuration allows, so that the replay and the backfill both land in
    // compressed chunks.
    compression: { rawAfterDays: 1, fiveMinuteAfterDays: 1 },
    disk: { path: '', evictBelowPercent: 10, recoverAbovePercent: 15, minimumRetainedHours: 48 },
    ...overrides,
  };
}

function ingestion(): IngestionConfig {
  return {
    queueMaxRows: 200_000,
    batchMaxRows: 5_000,
    batchMaxDelayMs: 20,
    slowDownAtPercent: 50,
    retryAfterMs: 1_000,
    replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
  };
}

/** A reading every ten minutes over `[from, to)`, valued by its own time so every one differs. */
function readings(channelId: number, from: number, to: number): [number, Date, number][] {
  const out: [number, Date, number][] = [];
  for (let at = from; at < to; at += STEP_MS)
    out.push([channelId, new Date(at), (at / STEP_MS) % 997]);
  return out;
}

async function insert(q: Queryable, rows: readonly [number, Date, number][]): Promise<void> {
  await q.query(
    `INSERT INTO sample (time, channel_id, value)
     SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::float8[])`,
    [rows.map((row) => row[1]), rows.map((row) => row[0]), rows.map((row) => row[2])],
  );
}

type Bucket = [string, number, number, number, number];

async function tier(q: Queryable, table: string, channelId: number): Promise<Bucket[]> {
  const rows = await q.query<{
    bucket: Date;
    sample_count: number;
    value_sum: number;
    value_min: number;
    value_max: number;
  }>(
    `SELECT bucket, sample_count, value_sum, value_min, value_max
     FROM ${table} WHERE channel_id = $1 ORDER BY bucket`,
    [channelId],
  );
  return rows.map((row) => [
    row.bucket.toISOString(),
    row.sample_count,
    row.value_sum,
    row.value_min,
    row.value_max,
  ]);
}

/** The buckets `rows` make at `bucketMs`, as the rollup should have written them. */
function expected(rows: readonly [number, Date, number][], bucketMs: number): Bucket[] {
  const buckets = new Map<number, number[]>();
  for (const [, at, value] of rows) {
    const key = Math.floor(at.getTime() / bucketMs) * bucketMs;
    buckets.set(key, [...(buckets.get(key) ?? []), value]);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([key, values]) => [
      new Date(key).toISOString(),
      values.length,
      values.reduce((sum, value) => sum + value, 0),
      Math.min(...values),
      Math.max(...values),
    ]);
}

/** Passes until one does no rollup, backfill, compression or retention work. */
async function settle(keeper: Housekeeper, limit = 30): Promise<HousekeepingReport[]> {
  const reports: HousekeepingReport[] = [];
  for (let pass = 0; pass < limit; pass += 1) {
    const report = await keeper.runOnce();
    reports.push(report);
    assert.deepEqual(report.failures, [], `pass ${String(pass)} failed`);
    const idle =
      report.backfillWindows === 0 &&
      report.compressedChunks === 0 &&
      report.droppedChunks === 0 &&
      Object.values(report.tiers).every((one) => one.bucketsWritten === 0 && !one.behind);
    if (idle) return reports;
  }
  throw new Error(`still working after ${String(limit)} passes`);
}

/** Passes until the backfill queue is empty, none of them failing. */
async function drain(keeper: Housekeeper, db: Queryable, limit = 10): Promise<void> {
  for (let pass = 0; pass < limit; pass += 1) {
    const report = await keeper.runOnce();
    assert.deepEqual(report.failures, [], `pass ${String(pass)} failed`);
    const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rollup_backfill');
    if (left[0]?.n === 0) return;
  }
  throw new Error(`the backfill queue was not empty after ${String(limit)} passes`);
}

async function chunkStatus(q: Queryable, table: string): Promise<{ end: Date; status: number }[]> {
  return q.query<{ end: Date; status: number }>(
    `SELECT range_end AS end,
            _timescaledb_functions.chunk_status(format('%I.%I', chunk_schema, chunk_name)::regclass)
              AS status
     FROM timescaledb_information.chunks
     WHERE hypertable_name = $1
     ORDER BY range_end`,
    [table],
  );
}

/**
 * Where the decompression limit is lifted, as decisions (`P-226`).
 *
 * A replayed write lifts it for its transaction, and on TimescaleDB 2.14 and 2.15 needs it. From
 * 2.16.0 (`#7108`) an upsert unpacks a compressed batch only where it has a row to update, so on
 * the dev image's 2.29 the replay never meets the limit, and the scenario below passes with or
 * without that lift. What can be checked is that ingestion asks for it when it should. The reap
 * does meet the limit on 2.29, and the scenario shows that; here it is the order that is checked,
 * the lift before the first delete.
 */
describe('where the decompression limit is lifted (`P-226`)', () => {
  function recording(): { engine: StorageEngine; lifted: Queryable[] } {
    const lifted: Queryable[] = [];
    const engine = {
      name: 'recording',
      allowDecompression: (q: Queryable) => {
        lifted.push(q);
        return Promise.resolve();
      },
    } as unknown as StorageEngine;
    return { engine, lifted };
  }

  it('lifts it for a write old enough to reach a compressed chunk, and not otherwise', async () => {
    const { engine, lifted } = recording();
    const now = new Date('2026-09-28T12:00:00.000Z');
    const keeper = new Housekeeper({
      db: {} as Database,
      logger: silent,
      config: housekeeping(),
      store: new SqlTimeSeriesStore(engine),
      now: () => now,
    });
    const q = {} as Queryable;

    await keeper.prepareWrite(q, new Date(now.getTime() - 11 * HOUR_MS));
    assert.equal(lifted.length, 0, 'a live write never reaches a compressed chunk');
    await keeper.prepareWrite(q, new Date(now.getTime() - 13 * HOUR_MS));
    assert.deepEqual(lifted, [q], 'a replay might, and the lift is for its transaction');
  });

  it('lifts it for a reap, before the first delete, in the same transaction', async () => {
    const { engine, lifted } = recording();
    const order: string[] = [];
    const q = {
      query: (sql: string) => {
        order.push(lifted.length === 0 ? `before: ${sql.slice(0, 20)}` : 'after');
        return Promise.resolve([{ count: '0' }]);
      },
    } as unknown as Queryable;
    await new SqlTimeSeriesStore(engine).reapChannels(q, [1]);
    assert.deepEqual(lifted, [q]);
    assert.ok(
      order.every((one) => one === 'after'),
      `every statement after the lift: ${order.join(', ')}`,
    );
  });
});

describe(
  'backfill (`P-226`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('backfill');
      await new Migrator({ db: scratch.db, logger: silent, migrations: MIGRATIONS }).up();
      await scratch.db.query(
        `ALTER DATABASE ${scratch.name}
         SET timescaledb.max_tuples_decompressed_per_dml_transaction = ${String(LIMIT)}`,
      );
      // A pool opened after the change, so that every connection starts with it.
      db = new Database({
        config: testDatabaseConfig(),
        logger: silentLogger,
        databaseOverride: scratch.name,
      });
    });

    after(async () => {
      await db.close();
      await scratch.drop();
    });

    beforeEach(async () => {
      for (const table of SAMPLE_TABLES) {
        await db.query(`SELECT drop_chunks($1::regclass, older_than => 'infinity'::timestamptz)`, [
          table,
        ]);
      }
      await db.query('DELETE FROM rollup_watermark');
      await db.query('DELETE FROM rollup_backfill');
      await db.query('DELETE FROM channel_reap');
    });

    it('replays twenty days into a core keeping seven, and touches no other channel', async () => {
      const shown = await db.query<{ setting: string }>(
        "SELECT current_setting('timescaledb.max_tuples_decompressed_per_dml_transaction') AS setting",
      );
      assert.equal(shown[0]?.setting, String(LIMIT), 'the limit this file relies on is in force');

      const today = alignDown(new Date(), 86_400).getTime();
      const start = today - 25 * DAY_MS;
      const end = Date.now() - HOUR_MS;
      // The replayed channel was away from 20 days ago to 2 days ago. What it had before and
      // after is stored; its spool holds the gap and, as a spool that was partly delivered does,
      // one day it already sent.
      const away = today - 20 * DAY_MS;
      const back = today - 2 * DAY_MS;
      const history = [
        ...OTHERS.flatMap((id) => readings(id, start, end)),
        ...readings(REPLAYED, start, away),
        ...readings(REPLAYED, back - DAY_MS, end),
      ];
      await insert(db, history);

      const keeper = new Housekeeper({ db, logger: silent, config: housekeeping() });
      await settle(keeper);
      const raw = await db.query<{ oldest: Date }>('SELECT min(time) AS oldest FROM sample');
      assert.ok(
        (raw[0]?.oldest.getTime() ?? 0) >= today - 8 * DAY_MS,
        'retention took the raw data older than a week',
      );
      assert.ok(
        (await chunkStatus(db, 'sample')).some((chunk) => (chunk.status & 1) === 1),
        'and compressed the rest past a day',
      );
      assert.ok(
        (await chunkStatus(db, 'sample_5m')).some((chunk) => (chunk.status & 1) === 1),
        'the five-minute tier too',
      );

      const before = new Map<string, Bucket[]>();
      for (const id of [...OTHERS, REPLAYED]) {
        for (const table of ['sample_5m', 'sample_1h', 'sample_1d']) {
          before.set(`${table}:${String(id)}`, await tier(db, table, id));
        }
      }

      // The replay, through ingestion as a probe's drain would arrive: the housekeeper is its
      // late-data sink, so it lifts the limit for the write and queues the backfill.
      const spool = readings(REPLAYED, away, back);
      const ingestor = new Ingestor({ db, logger: silent, config: ingestion(), lateData: keeper });
      try {
        for (let at = 0; at < spool.length; at += 1_000) {
          const outcome = await ingestor.submit({
            source: 'replay',
            samples: spool
              .slice(at, at + 1_000)
              .map(([channelId, when, value]) => ({ channelId, at: when, value })),
          });
          assert.equal(outcome.accepted, true);
        }
      } finally {
        await ingestor.stop();
      }

      const queued = await db.query<{ channel_ids: number[] | null }>(
        'SELECT channel_ids FROM rollup_backfill',
      );
      assert.ok(queued.length > 0, 'the replay queued a backfill');
      for (const entry of queued) {
        assert.deepEqual(entry.channel_ids, [REPLAYED], 'naming the one channel that was late');
      }
      assert.ok(
        (await chunkStatus(db, 'sample')).some((chunk) => (chunk.status & 8) === 8),
        'the replay wrote into compressed raw chunks, which are now partial',
      );

      await settle(keeper);

      const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rollup_backfill');
      assert.equal(left[0]?.n, 0, 'the backfill finished');

      // **The defect.** A backfill used to clear its window for every channel and rebuild from
      // raw, and raw past a week held only the replayed channel.
      for (const id of OTHERS) {
        for (const table of ['sample_5m', 'sample_1h', 'sample_1d']) {
          assert.deepEqual(
            await tier(db, table, id),
            before.get(`${table}:${String(id)}`),
            `channel ${String(id)}'s ${table} is exactly what it was`,
          );
        }
      }

      // And the replayed channel's history is whole: what it had, and what it replayed.
      const replayed = [
        ...readings(REPLAYED, start, away),
        ...spool,
        ...readings(REPLAYED, back - DAY_MS, end),
      ].sort((a, b) => a[1].getTime() - b[1].getTime());
      const unique = replayed.filter(
        (row, index) => index === 0 || row[1].getTime() !== replayed[index - 1]?.[1].getTime(),
      );
      const closed = (bucketMs: number) =>
        unique.filter(
          (row) => Math.floor(row[1].getTime() / bucketMs) * bucketMs + bucketMs <= end,
        );
      assert.deepEqual(
        (await tier(db, 'sample_5m', REPLAYED)).filter(([bucket]) => Date.parse(bucket) < back),
        expected(
          closed(300_000).filter((row) => row[1].getTime() < back),
          300_000,
        ),
        'every five-minute bucket of the replayed channel, before and through the gap',
      );
      assert.deepEqual(
        (await tier(db, 'sample_1h', REPLAYED)).filter(([bucket]) => Date.parse(bucket) < back),
        expected(
          closed(HOUR_MS).filter((row) => row[1].getTime() < back),
          HOUR_MS,
        ),
        'and every hour',
      );

      // Recompressed: nothing past the compression horizon is left partial.
      const horizon = Date.now() - DAY_MS;
      for (const table of ['sample', 'sample_5m']) {
        const partial = (await chunkStatus(db, table)).filter(
          (chunk) => chunk.end.getTime() <= horizon && (chunk.status & 10) !== 0,
        );
        assert.deepEqual(partial, [], `${table}: every aged chunk compressed again`);
      }
      const stored = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM sample WHERE channel_id = $1 AND time >= $2 AND time < $3',
        [REPLAYED, new Date(today - 7 * DAY_MS), new Date(back)],
      );
      assert.equal(
        stored[0]?.n,
        unique.filter((row) => row[1].getTime() >= today - 7 * DAY_MS && row[1].getTime() < back)
          .length,
        'and reads back whole',
      );

      // First the control: the limit is real, and refuses a write that unpacks a compressed
      // chunk without the lift. An update, because it always unpacks what it changes.
      await assert.rejects(
        db.tx((q) =>
          q.query('UPDATE sample SET value = value + 1 WHERE channel_id = $1', [OTHERS[0]]),
        ),
        /decompress/iu,
        'the limit refuses an unbounded write into compressed chunks',
      );

      // The reap, through the same compressed chunks, and under the same limit. From 2.17.0
      // (`#6882`) a delete that filters on the segmenting column alone removes whole segments
      // without unpacking them, but not a delete with a RETURNING clause, and the reap counts
      // what it deletes with one. So it unpacks every batch of the channel, even on 2.29, and
      // without its lift this fails.
      await db.query('INSERT INTO channel_reap (channel_id) VALUES ($1)', [OTHERS[0]]);
      const reaped = await keeper.runOnce();
      assert.deepEqual(reaped.failures, []);
      assert.equal(reaped.reapedChannels, 1);
      for (const table of SAMPLE_TABLES) {
        const rows = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE channel_id = $1`,
          [OTHERS[0]],
        );
        assert.equal(rows[0]?.n, 0, `${table} holds nothing of the reaped channel`);
      }
    });

    it('recomputes a bucket inside a compressed five-minute chunk, under the limit', async () => {
      // From 2.16.0 (`#7108`) an upsert unpacks a compressed batch only where it has a row to
      // update, so on 2.29 the replay never meets the limit. A recompute always has a row to
      // update. The replay above cannot show this on every day of the week: which five-minute
      // chunks are compressed depends on where the week-long chunks fall, so this places one.
      for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tierId,
        ]);
      }
      const today = alignDown(new Date(), 86_400).getTime();
      const day = today - 14 * DAY_MS;
      const channel = 8_501;
      await insert(db, readings(channel, day, day + DAY_MS));
      await db.tx((q) =>
        new SqlTimeSeriesStore().rollUp(
          q,
          tierById('sample_5m'),
          new Date(day),
          new Date(day + DAY_MS),
        ),
      );
      await db.query(
        `SELECT compress_chunk(c)
         FROM show_chunks('sample_5m', older_than => now() - interval '1 day') c`,
      );
      const compressed = (await chunkStatus(db, 'sample_5m')).filter(
        (chunk) => chunk.end.getTime() > day && (chunk.status & 1) === 1,
      );
      assert.ok(compressed.length > 0, 'the day is in a compressed chunk, 144 buckets deep');

      await insert(db, [[channel, new Date(day + 60_000), 7]]);
      const keeper = new Housekeeper({
        db,
        logger: silent,
        // Every day of this inside the raw retention, so the bucket is recomputed.
        config: housekeeping({ retention: { ...housekeeping().retention, rawDays: 40 } }),
      });
      await keeper.noteLateSamples(new Date(day), new Date(day + 60_001), 'late', [channel]);
      await drain(keeper, db);

      const bucket = (await tier(db, 'sample_5m', channel)).find(([at]) => Date.parse(at) === day);
      assert.equal(bucket?.[1], 2, 'the late reading is in it');
    });

    it('keeps a bucket past the source retention, and recomputes one inside it', async () => {
      const today = alignDown(new Date(), 86_400).getTime();
      const outside = today - 10 * DAY_MS;
      const inside = today - 3 * DAY_MS;
      const channel = 8_201;
      for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tierId,
        ]);
      }
      // Two complete five-minute buckets, summarised from five readings each. Raw keeps none of
      // the one outside the retention; it keeps the other.
      for (const at of [outside, inside]) {
        await db.query(
          `INSERT INTO sample_5m (bucket, channel_id, sample_count, value_sum, value_min, value_max)
           VALUES ($1, $2, 5, 50, 10, 10)`,
          [new Date(at), channel],
        );
      }
      await insert(
        db,
        [0, 1, 2, 3, 4].map((minute) => [channel, new Date(inside + minute * 60_000), 10]),
      );
      // A neighbour whose bucket disagrees with its raw readings. Nothing late arrived for it, so
      // a backfill that recomputed it anyway, which is what an entry naming its channels exists
      // to prevent, would show here.
      const neighbour = 8_202;
      await db.query(
        `INSERT INTO sample_5m (bucket, channel_id, sample_count, value_sum, value_min, value_max)
         VALUES ($1, $2, 99, 99, 1, 1)`,
        [new Date(inside), neighbour],
      );
      await insert(db, [[neighbour, new Date(inside + 60_000), 5]]);

      // One late reading in each.
      const late: [number, Date, number][] = [
        [channel, new Date(outside + 30_000), 70],
        [channel, new Date(inside + 30_000), 70],
      ];
      await insert(db, late);
      const keeper = new Housekeeper({ db, logger: silent, config: housekeeping() });
      await db.tx((q) =>
        keeper.noteWritten(q, {
          channelIds: late.map((row) => row[0]),
          times: late.map((row) => row[1]),
        }),
      );
      await drain(keeper, db);

      const buckets = await tier(db, 'sample_5m', channel);
      assert.deepEqual(
        buckets.find(([bucket]) => Date.parse(bucket) === outside),
        [new Date(outside).toISOString(), 5, 50, 10, 10],
        'past the retention the source holds one reading; the bucket of five is kept',
      );
      assert.deepEqual(
        buckets.find(([bucket]) => Date.parse(bucket) === inside),
        [new Date(inside).toISOString(), 6, 120, 10, 70],
        'inside it the source holds all six, and the bucket is recomputed from them',
      );
      assert.deepEqual(
        await tier(db, 'sample_5m', neighbour),
        [[new Date(inside).toISOString(), 99, 99, 1, 1]],
        'a channel the entry does not name is not touched',
      );
    });

    it('re-rolls a window for every channel, a batch at a time, when an entry names none', async () => {
      // An entry queued before this change, or by `noteLateSamples` without channels. Every
      // channel is the channel table, stood in for with a list rather than a sensor tree.
      const count = BACKFILL_CHANNEL_BATCH + 3;
      const store = new (class extends SqlTimeSeriesStore {
        override allChannels(): Promise<number[]> {
          return Promise.resolve(Array.from({ length: count }, (_, index) => 9_000 + index));
        }
      })();
      const today = alignDown(new Date(), 86_400).getTime();
      const at = today - 2 * DAY_MS;
      await insert(
        db,
        Array.from({ length: count }, (_, index) => [9_000 + index, new Date(at), index]),
      );
      for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tierId,
        ]);
      }
      const keeper = new Housekeeper({ db, logger: silent, config: housekeeping(), store });
      await keeper.noteLateSamples(new Date(at), new Date(at + 1), 'an entry naming no channels');
      await drain(keeper, db);

      const rolled = await db.query<{ n: number }>(
        'SELECT count(DISTINCT channel_id)::int AS n FROM sample_5m WHERE bucket = $1',
        [new Date(at)],
      );
      assert.equal(rolled[0]?.n, count, 'every channel, across two batches');
    });

    it('finishes a month for three batches, never falling back', async () => {
      // More than one pass: three batches of channels over thirty-one days is 93 batch-days, and
      // with no readings to roll the clock never binds, so the ceiling does. The continuation of
      // each batch has to start where that batch stopped. Collapsed into one window with the
      // others, a batch that got furthest would start again from where the one that got least far
      // had stopped.
      assert.ok(3 * 31 > MAX_BACKFILL_DAYS_PER_PASS, 'more than one pass of work');
      for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tierId,
        ]);
      }
      const channels = Array.from({ length: 2 * BACKFILL_CHANNEL_BATCH + 1 }, (_, i) => 10_000 + i);
      const to = alignDown(new Date(), 300);
      const from = new Date(to.getTime() - 30 * DAY_MS);
      const keeper = new Housekeeper({ db, logger: silent, config: housekeeping() });
      await keeper.noteLateSamples(from, to, 'a month', channels);

      const progress = new Map<number, number>();
      for (let pass = 0; ; pass += 1) {
        assert.ok(pass < 15, 'drained within fifteen passes');
        const report = await keeper.runOnce();
        assert.deepEqual(report.failures, []);
        const queued = await db.query<{ from_time: Date; channel_ids: number[] }>(
          'SELECT from_time, channel_ids FROM rollup_backfill',
        );
        if (queued.length === 0) break;
        for (const entry of queued) {
          for (const id of entry.channel_ids) {
            const was = progress.get(id) ?? from.getTime();
            assert.ok(entry.from_time.getTime() >= was, `channel ${String(id)} fell back`);
            progress.set(id, entry.from_time.getTime());
          }
        }
      }
    });

    it('takes fewer days on a slow machine, but never none', async () => {
      // A clock that has spent the whole budget every time it is read: every pass stops after
      // the one day it always takes, on a boundary, and the next starts there (`P-226`).
      for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tierId,
        ]);
      }
      const config = housekeeping();
      let clock = 0;
      const keeper = new Housekeeper({
        db,
        logger: silent,
        config,
        monotonicMs: () => (clock += config.intervalSeconds * 1_000),
      });
      const today = alignDown(new Date(), 86_400).getTime();
      const from = new Date(today - 4 * DAY_MS);
      // Ending a millisecond before midnight, so the window is three days in every tier: a
      // window's end is inclusive of the bucket it falls in. A second channel in the same batch
      // needs only the last of the three, and its continuation must keep that start rather than
      // take its batch's.
      const end = new Date(today - DAY_MS - 1);
      await keeper.noteLateSamples(from, end, 'three days', [8_401]);
      await keeper.noteLateSamples(new Date(from.getTime() + 2 * DAY_MS), end, 'one day', [8_402]);

      const starts = async (): Promise<Record<string, number>> => {
        const rows = await db.query<{ from_time: Date; channel_ids: number[] }>(
          'SELECT from_time, channel_ids FROM rollup_backfill',
        );
        const out: Record<string, number> = {};
        for (const row of rows) {
          for (const id of row.channel_ids)
            out[String(id)] = row.from_time.getTime() - from.getTime();
        }
        return out;
      };
      const pass = async (): Promise<void> => {
        const report = await keeper.runOnce();
        assert.deepEqual(report.failures, []);
      };

      await pass();
      assert.deepEqual(
        await starts(),
        { '8401': DAY_MS, '8402': 2 * DAY_MS },
        'one day further, and the later channel keeps its own start',
      );
      await pass();
      assert.deepEqual(await starts(), { '8401': 2 * DAY_MS, '8402': 2 * DAY_MS });
      await pass();
      assert.deepEqual(await starts(), {}, 'and done after the third');
    });

    it('goes back no further than each tier keeps, however far back the readings are', async () => {
      // A probe whose clock was three years behind (round 3's second case). Every tier keeps a
      // month at most here, so the backfill has a month to do, not three years of days that
      // retention would drop on the next pass while it held retention back to do them.
      for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tierId,
        ]);
      }
      const keeper = new Housekeeper({
        db,
        logger: silent,
        config: housekeeping({
          retention: {
            ...housekeeping().retention,
            rawDays: 7,
            fiveMinuteDays: 10,
            hourlyDays: 20,
            dailyDays: 30,
          },
        }),
      });
      const today = alignDown(new Date(), 86_400).getTime();
      await keeper.noteLateSamples(
        new Date(today - 3 * 365 * DAY_MS),
        new Date(today - 2 * DAY_MS - 1),
        'a clock three years behind',
        [8_601],
      );
      assert.ok(3 * 365 > MAX_BACKFILL_DAYS_PER_PASS, 'three years would take many passes');

      const report = await keeper.runOnce();
      assert.deepEqual(report.failures, []);
      const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rollup_backfill');
      assert.equal(left[0]?.n, 0, 'a month, done in one pass');
    });

    describe('a backfill that keeps failing', () => {
      /** A store whose re-roll fails while `failing` is set, as a full disk would. */
      class FailingStore extends SqlTimeSeriesStore {
        failing = true;
        message = 'could not extend file: No space left on device';

        override rollUp(
          q: Queryable,
          rollupTier: RollupTier,
          from: Date,
          to: Date,
          options?: RollOptions,
        ): Promise<number> {
          // Only the backfill names its channels; the forward roll carries on.
          if (this.failing && options?.channels !== undefined) {
            return Promise.reject(new Error(this.message));
          }
          return super.rollUp(q, rollupTier, from, to, options);
        }
      }

      /** Bringing a parked retry forward, exactly as `docs/administration.md` gives it. */
      const RETRY_NOW = 'UPDATE rollup_backfill SET retry_at = now() WHERE retry_at IS NOT NULL';

      async function entries(): Promise<
        { id: string; attempts: number; last_error: string | null; retry_in: number | null }[]
      > {
        return db.query(
          `SELECT id::text, attempts, last_error,
                  extract(epoch FROM retry_at - now())::float8 AS retry_in
           FROM rollup_backfill ORDER BY rollup_backfill.id`,
        );
      }

      async function prepare(): Promise<{ keeper: Housekeeper; store: FailingStore; at: Date }> {
        for (const tierId of ['sample_5m', 'sample_1h', 'sample_1d']) {
          await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
            tierId,
          ]);
        }
        const store = new FailingStore();
        const keeper = new Housekeeper({ db, logger: silent, config: housekeeping(), store });
        const at = new Date(alignDown(new Date(), 300).getTime() - 3 * DAY_MS);
        await keeper.noteLateSamples(at, new Date(at.getTime() + 1), 'test', [8_301]);
        return { keeper, store, at };
      }

      it('is tried twice more, then parked with its error, and stops holding retention', async () => {
        const { keeper, at } = await prepare();
        const store = new SqlTimeSeriesStore();

        for (const attempt of [1, 2]) {
          const report = await keeper.runOnce();
          assert.equal(report.failures[0]?.step, 'backfill');
          const [entry] = await entries();
          assert.equal(entry?.attempts, attempt);
          assert.equal(entry.retry_in, null, 'not parked yet: the next pass tries again');
          assert.equal(
            (await db.tx((q) => store.earliestPendingBackfill(q)))?.getTime(),
            at.getTime(),
            'and until it is parked, it holds compression and retention back',
          );
        }

        await keeper.runOnce();
        const [parked] = await entries();
        assert.equal(parked?.attempts, BACKFILL_RETRY.parkAfter);
        assert.equal(parked.last_error, 'could not extend file: No space left on device');
        assert.ok(
          Math.abs((parked.retry_in ?? 0) - BACKFILL_RETRY.firstRetrySeconds) < 60,
          'parked for an hour',
        );
        assert.equal(
          await db.tx((q) => store.earliestPendingBackfill(q)),
          null,
          'a parked entry no longer stops retention',
        );

        // Not due: the next pass leaves it alone.
        const quiet = await keeper.runOnce();
        assert.equal(quiet.backfillWindows, 0);
        assert.equal((await entries())[0]?.attempts, BACKFILL_RETRY.parkAfter);
      });

      it('is retried when due, daily after that, and cleared once it succeeds', async () => {
        const { keeper, store } = await prepare();
        for (let pass = 0; pass < BACKFILL_RETRY.parkAfter; pass += 1) await keeper.runOnce();
        await db.query(RETRY_NOW);

        const retried = await keeper.runOnce();
        assert.equal(retried.backfillWindows, 1, 'claimed when due');
        const [again] = await entries();
        assert.equal(again?.attempts, BACKFILL_RETRY.parkAfter + 1);
        assert.ok(
          Math.abs((again.retry_in ?? 0) - BACKFILL_RETRY.laterRetrySeconds) < 60,
          'and then parked for a day',
        );

        store.failing = false;
        await db.query(RETRY_NOW);
        const cleared = await keeper.runOnce();
        assert.deepEqual(cleared.failures, []);
        assert.deepEqual(await entries(), [], 'a retry that succeeds clears it');
      });

      it('never drags a fresh entry down with it', async () => {
        const { keeper, store, at } = await prepare();
        for (let pass = 0; pass < BACKFILL_RETRY.parkAfter; pass += 1) await keeper.runOnce();
        await db.query(RETRY_NOW);
        await keeper.noteLateSamples(at, new Date(at.getTime() + 1), 'fresh', [8_302]);

        // With a fresh entry waiting, the due parked one is not claimed, so the fresh one fails
        // alone — once, not parked.
        await keeper.runOnce();
        const [parked, fresh] = await entries();
        assert.equal(parked?.attempts, BACKFILL_RETRY.parkAfter, 'the parked one waited');
        assert.equal(fresh?.attempts, 1);

        store.failing = false;
        const report = await keeper.runOnce();
        assert.equal(report.backfillWindows, 1, 'the fresh one, on its own');
        const [left] = await entries();
        assert.equal(left?.id, parked.id, 'and only the parked one is left');
      });

      it('keeps one line of the error, and no more than the column allows', async () => {
        const { keeper, store } = await prepare();
        store.message = `${'x'.repeat(900)}\nSELECT * FROM a_statement_nobody_should_read`;
        await keeper.runOnce();
        const [entry] = await entries();
        assert.ok(entry?.last_error);
        assert.equal(entry.last_error.length, 500);
        assert.ok(!entry.last_error.includes('SELECT'), 'the first line only');
      });
    });
  },
);

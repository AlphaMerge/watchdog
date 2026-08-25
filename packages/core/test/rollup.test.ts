import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { HousekeepingConfig } from '@ms/shared';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import type { Database } from '../src/db/pool.js';
import {
  Housekeeper,
  alignDown,
  MAX_BACKFILL_ENTRIES,
  MAX_SLICES_PER_TIER,
} from '../src/timeseries/housekeeper.js';
import { SqlTimeSeriesStore } from '../src/timeseries/store.js';
import { ROLLUP_TIERS, SAMPLE_TABLES } from '../src/timeseries/tiers.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function housekeeping(overrides: Partial<HousekeepingConfig> = {}): HousekeepingConfig {
  return {
    enabled: true,
    intervalSeconds: 300,
    // Zero: the tests place their data in the past deliberately, so there is nothing to wait
    // for, and a lag would only make "which buckets are closed" depend on the wall clock.
    rollupLagSeconds: 0,
    retention: {
      rawDays: 40,
      fiveMinuteDays: 365,
      hourlyDays: 730,
      dailyDays: 3_650,
      auditDays: 730,
    },
    compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
    ...overrides,
  };
}

interface Bucket {
  bucket: Date;
  channel_id: number;
  sample_count: number;
  value_sum: number;
  value_min: number;
  value_max: number;
}

async function readTier(db: Database, table: string, channelId: number): Promise<Bucket[]> {
  return db.query<Bucket>(
    `SELECT bucket, channel_id, sample_count, value_sum, value_min, value_max
     FROM ${table} WHERE channel_id = $1 ORDER BY bucket`,
    [channelId],
  );
}

function at(rows: readonly Bucket[], when: Date): Bucket | undefined {
  return rows.find((row) => row.bucket.getTime() === when.getTime());
}

async function insertSamples(
  db: Database,
  channelId: number,
  readings: readonly (readonly [Date, number])[],
): Promise<void> {
  await db.query(
    `INSERT INTO sample (time, channel_id, value)
     SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::float8[])`,
    [readings.map((r) => r[0]), readings.map(() => channelId), readings.map((r) => r[1])],
  );
}

/**
 * The dataset every aggregation assertion below is computed by hand from.
 *
 * Three days back so every bucket at every tier is closed, and shaped so the two mistakes that
 * matter are both visible: a gap that must stay a gap, and buckets of unequal size whose
 * average cannot be taken by averaging averages.
 *
 *   base + 0m    10, 20, 30   -> 5m bucket: n=3 sum=60  avg=20
 *   base + 5m    (nothing)    -> 5m bucket: ABSENT
 *   base + 10m   100          -> 5m bucket: n=1 sum=100 avg=100
 *   base + 2h    200          -> 5m bucket: n=1 sum=200 avg=200
 *
 *   hour  base      n=4 sum=160 avg=40    <- averaging the 5m averages would say 60
 *   hour  base + 1h ABSENT
 *   hour  base + 2h n=1 sum=200 avg=200
 *   day   base      n=5 sum=360 avg=72    <- averaging the hourly averages would say 120
 */
const CHANNEL = 7_001;

function baseInstant(): Date {
  return new Date(alignDown(new Date(), 86_400).getTime() - 3 * DAY_MS);
}

async function seed(db: Database, base: Date): Promise<void> {
  await insertSamples(db, CHANNEL, [
    [new Date(base.getTime()), 10],
    [new Date(base.getTime() + 60_000), 20],
    [new Date(base.getTime() + 120_000), 30],
    [new Date(base.getTime() + 10 * MINUTE_MS), 100],
    [new Date(base.getTime() + 2 * 60 * MINUTE_MS), 200],
  ]);
}

describe(
  'rollup tiers, compression and retention',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    const repo = new SqlTimeSeriesStore();

    before(async () => {
      scratch = await createScratchDatabase('rollup');
      db = scratch.db;
      await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      // Drop chunks rather than TRUNCATE: a compression test leaves chunk metadata behind, and
      // the next test's assertions about chunk state have to start from nothing.
      for (const table of SAMPLE_TABLES) {
        await db.query(`SELECT drop_chunks($1::regclass, older_than => 'infinity'::timestamptz)`, [
          table,
        ]);
      }
      await db.query('DELETE FROM rollup_watermark');
      await db.query('DELETE FROM rollup_backfill');
      await db.query('DELETE FROM channel_reap');
    });

    function housekeeper(config: HousekeepingConfig = housekeeping()): Housekeeper {
      return new Housekeeper({ db, logger: silent, config });
    }

    // ---------------------------------------------------------------------------------------
    // The constants this code slices time with have to mean the same thing to PostgreSQL.
    // ---------------------------------------------------------------------------------------

    it('agrees with PostgreSQL about how long each bucket is', async () => {
      for (const tier of ROLLUP_TIERS) {
        const rows = await db.query<{ seconds: string }>(
          'SELECT EXTRACT(epoch FROM $1::interval)::text AS seconds',
          [tier.bucket],
        );
        assert.equal(
          Number(rows[0]?.seconds),
          tier.bucketSeconds,
          `${tier.id}: the literal and the seconds must not drift`,
        );
      }
    });

    it('aligns buckets exactly where time_bucket does', async () => {
      // The housekeeper floors instants in JavaScript to work out slice boundaries, while the
      // rollup itself groups with time_bucket. If those two disagreed by so much as a bucket,
      // a slice boundary would cut a bucket in half and it would be written twice, each time
      // with a fraction of its readings.
      const probes = [
        new Date('2026-08-25T13:47:29.512Z'),
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-03-29T02:30:00.000Z'), // a European DST transition
        new Date('2026-12-31T23:59:59.999Z'),
      ];
      for (const tier of ROLLUP_TIERS) {
        for (const probe of probes) {
          const rows = await db.query<{ bucket: Date }>(
            'SELECT time_bucket($1::interval, $2::timestamptz) AS bucket',
            [tier.bucket, probe],
          );
          assert.equal(
            alignDown(probe, tier.bucketSeconds).toISOString(),
            rows[0]?.bucket.toISOString(),
            `${tier.id} at ${probe.toISOString()}`,
          );
        }
      }
    });

    // ---------------------------------------------------------------------------------------
    // Aggregation, against values computed by hand.
    // ---------------------------------------------------------------------------------------

    it('rolls raw readings into five-minute buckets exactly', async () => {
      const base = baseInstant();
      await seed(db, base);
      await housekeeper().runOnce();

      const rows = await readTier(db, 'sample_5m', CHANNEL);
      const first = at(rows, base);
      assert.ok(first, 'the first bucket exists');
      assert.equal(first.sample_count, 3);
      assert.equal(first.value_sum, 60);
      assert.equal(first.value_min, 10);
      assert.equal(first.value_max, 30);
      assert.equal(first.value_sum / first.sample_count, 20);

      const third = at(rows, new Date(base.getTime() + 10 * MINUTE_MS));
      assert.ok(third);
      assert.equal(third.sample_count, 1);
      assert.equal(third.value_sum, 100);
    });

    it('leaves a gap as a gap, at every tier', async () => {
      const base = baseInstant();
      await seed(db, base);
      await housekeeper().runOnce();

      // No readings between base+5m and base+10m. "No-data is not zero" (CLAUDE.md): the
      // absence has to survive the rollup as an absent row, not a row of zeros and not a row
      // with a NULL in it.
      const fiveMinute = await readTier(db, 'sample_5m', CHANNEL);
      assert.equal(at(fiveMinute, new Date(base.getTime() + 5 * MINUTE_MS)), undefined);

      // The hour between base+1h and base+2h is empty too, and stays empty one tier up.
      const hourly = await readTier(db, 'sample_1h', CHANNEL);
      assert.equal(at(hourly, new Date(base.getTime() + 60 * MINUTE_MS)), undefined);

      // And nothing anywhere invented a zero.
      for (const table of ['sample_5m', 'sample_1h', 'sample_1d']) {
        const zeros = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE sample_count = 0 OR value_sum IS NULL`,
        );
        assert.equal(zeros[0]?.count, '0', `${table} holds no manufactured empty bucket`);
      }
    });

    it('weights the hourly average by readings, not by bucket', async () => {
      const base = baseInstant();
      await seed(db, base);
      await housekeeper().runOnce();

      const hourly = await readTier(db, 'sample_1h', CHANNEL);
      const hour = at(hourly, base);
      assert.ok(hour, 'the first hour exists');

      // Four readings — 10, 20, 30, 100 — inside two five-minute buckets of unequal size.
      assert.equal(hour.sample_count, 4);
      assert.equal(hour.value_sum, 160);
      assert.equal(hour.value_min, 10);
      assert.equal(hour.value_max, 100);
      assert.equal(hour.value_sum / hour.sample_count, 40);

      // The bug this guards against: averaging the two five-minute averages, 20 and 100, gives
      // 60. It is only wrong when the buckets hold different numbers of readings — which is the
      // normal case, every time a sensor goes down mid-hour.
      const fiveMinute = await readTier(db, 'sample_5m', CHANNEL);
      const withinHour = fiveMinute.filter(
        (row) => row.bucket >= base && row.bucket.getTime() < base.getTime() + 60 * MINUTE_MS,
      );
      const averageOfAverages =
        withinHour.reduce((sum, row) => sum + row.value_sum / row.sample_count, 0) /
        withinHour.length;
      assert.equal(averageOfAverages, 60, 'the naive answer, for contrast');
      assert.notEqual(hour.value_sum / hour.sample_count, averageOfAverages);
    });

    it('weights the daily average by readings too, across two tiers of cascade', async () => {
      const base = baseInstant();
      await seed(db, base);
      await housekeeper().runOnce();

      const daily = await readTier(db, 'sample_1d', CHANNEL);
      const day = at(daily, base);
      assert.ok(day, 'the first day exists');

      // Five readings in total: 10, 20, 30, 100, 200.
      assert.equal(day.sample_count, 5);
      assert.equal(day.value_sum, 360);
      assert.equal(day.value_min, 10);
      assert.equal(day.value_max, 200);
      assert.equal(day.value_sum / day.sample_count, 72);

      // Averaging the two hourly averages, 40 and 200, would say 120. The error compounds with
      // every tier, which is why the tiers store sums and counts instead of averages.
      assert.notEqual(day.value_sum / day.sample_count, 120);
    });

    it('summarises the same readings identically however many passes it takes', async () => {
      const base = baseInstant();
      await seed(db, base);

      const keeper = housekeeper();
      await keeper.runOnce();
      const first = await readTier(db, 'sample_1d', CHANNEL);

      const second = await keeper.runOnce();
      const afterSecond = await readTier(db, 'sample_1d', CHANNEL);

      assert.deepEqual(
        afterSecond.map((row) => [row.bucket.toISOString(), row.sample_count, row.value_sum]),
        first.map((row) => [row.bucket.toISOString(), row.sample_count, row.value_sum]),
        'a second pass over ground already covered changes nothing',
      );
      assert.equal(second.tiers.sample_1d.bucketsWritten, 0, 'and does no work to prove it');
    });

    // ---------------------------------------------------------------------------------------
    // Late data.
    // ---------------------------------------------------------------------------------------

    it('re-rolls a bucket when a reading arrives behind the watermark', async () => {
      const base = baseInstant();
      await seed(db, base);
      const keeper = housekeeper();
      await keeper.runOnce();

      // A probe reconnects and replays its spool (R-03): a reading lands inside a bucket that
      // was summarised while the probe was away.
      await insertSamples(db, CHANNEL, [[new Date(base.getTime() + 180_000), 50]]);
      await keeper.noteLateSamples(base, new Date(base.getTime() + 5 * MINUTE_MS), 'probe replay');
      const report = await keeper.runOnce();

      assert.equal(report.backfillWindows, 1);

      const bucket = at(await readTier(db, 'sample_5m', CHANNEL), base);
      assert.ok(bucket);
      assert.equal(bucket.sample_count, 4, '10, 20, 30 and now 50');
      assert.equal(bucket.value_sum, 110);
      assert.equal(bucket.value_max, 50);

      // And it cascades: the hour and the day both have to move with it, or the tiers disagree
      // about the same readings.
      const hour = at(await readTier(db, 'sample_1h', CHANNEL), base);
      assert.ok(hour);
      assert.equal(hour.sample_count, 5);
      assert.equal(hour.value_sum, 210);

      const day = at(await readTier(db, 'sample_1d', CHANNEL), base);
      assert.ok(day);
      assert.equal(day.sample_count, 6);
      assert.equal(day.value_sum, 410);

      const remaining = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM rollup_backfill',
      );
      assert.equal(remaining[0]?.count, '0', 'the queue entry is consumed');
    });

    it('removes a bucket whose readings have all gone', async () => {
      const base = baseInstant();
      await seed(db, base);
      const keeper = housekeeper();
      await keeper.runOnce();

      const gapStart = new Date(base.getTime() + 10 * MINUTE_MS);
      assert.ok(at(await readTier(db, 'sample_5m', CHANNEL), gapStart), 'present to begin with');

      await db.query('DELETE FROM sample WHERE channel_id = $1 AND time >= $2 AND time < $3', [
        CHANNEL,
        gapStart,
        new Date(gapStart.getTime() + 5 * MINUTE_MS),
      ]);
      await keeper.noteLateSamples(gapStart, new Date(gapStart.getTime() + 5 * MINUTE_MS), 'test');
      await keeper.runOnce();

      // ON CONFLICT alone would have left this bucket standing for ever, updated by nothing —
      // which is why a backfill clears its window before rebuilding it.
      assert.equal(at(await readTier(db, 'sample_5m', CHANNEL), gapStart), undefined);
      const hour = at(await readTier(db, 'sample_1h', CHANNEL), base);
      assert.ok(hour);
      assert.equal(hour.sample_count, 3, 'and the hour above it shrank to match');
      assert.equal(hour.value_sum, 60);
    });

    it('never moves a watermark backwards', async () => {
      const base = baseInstant();
      await seed(db, base);
      const keeper = housekeeper();
      await keeper.runOnce();

      const before = await db.tx((q) => repo.watermarks(q));
      await keeper.noteLateSamples(base, new Date(base.getTime() + 5 * MINUTE_MS), 'test');
      await keeper.runOnce();
      const afterwards = await db.tx((q) => repo.watermarks(q));

      for (const tier of ROLLUP_TIERS) {
        const was = before.get(tier.id);
        const is = afterwards.get(tier.id);
        assert.ok(was && is);
        assert.ok(is >= was, `${tier.id} did not rewind`);
      }
    });

    // ---------------------------------------------------------------------------------------
    // Compression and retention, and the guards that stop them eating live data.
    // ---------------------------------------------------------------------------------------

    it('compresses aged raw chunks and still reads them correctly', async () => {
      const old = new Date(Date.now() - 20 * DAY_MS);
      await insertSamples(db, CHANNEL, [
        [old, 1],
        [new Date(old.getTime() + 60_000), 2],
      ]);
      // The tier above has consumed everything, so compression is allowed to proceed.
      await db.query("INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now())");

      const report = await housekeeper().runOnce();
      assert.ok(report.compressedChunks >= 1, 'at least the twenty-day-old chunk');

      const chunks = await db.query<{ is_compressed: boolean }>(
        `SELECT is_compressed FROM timescaledb_information.chunks
         WHERE hypertable_name = 'sample'`,
      );
      assert.ok(
        chunks.some((chunk) => chunk.is_compressed),
        'the chunk is in columnar storage',
      );

      const values = await db.query<{ value: number }>(
        'SELECT value FROM sample WHERE channel_id = $1 ORDER BY time',
        [CHANNEL],
      );
      assert.deepEqual(
        values.map((row) => row.value),
        [1, 2],
        'and the readings come back unchanged',
      );
    });

    it('does not try to compact on an engine that cannot', async () => {
      const old = new Date(Date.now() - 20 * DAY_MS);
      await insertSamples(db, CHANNEL, [[old, 1]]);
      await db.query("INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now())");

      // Plain PostgreSQL has no columnar storage. Asking it to compact every five minutes for
      // ever would be an error a pass, rather than one line at start-up.
      const keeper = new Housekeeper({
        db,
        logger: silent,
        config: housekeeping(),
        store: Object.assign(new SqlTimeSeriesStore(), {
          capabilities: () =>
            Promise.resolve({ engine: 'postgres', version: null, compaction: false }),
          compactableChunks: () => Promise.reject(new Error('should never be asked')),
        }),
      });

      const report = await keeper.runOnce();
      assert.equal(report.compressedChunks, 0);
      assert.deepEqual(report.failures, [], 'and it is not an error, it is a capability');
    });

    it('will not compress a chunk the rollup has not consumed', async () => {
      const old = new Date(Date.now() - 20 * DAY_MS);
      await insertSamples(db, CHANNEL, [[old, 1]]);
      // The five-minute tier is stuck a month back — perhaps it has been failing. Compressing
      // ahead of it is not a data-loss bug, but it makes the rollup's own reads slower exactly
      // when it is trying to catch up.
      await db.query(
        "INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now() - interval '30 days')",
      );

      const report = await housekeeper().runOnce();
      assert.equal(report.compressedChunks, 0);
    });

    it('drops raw chunks past the retention horizon', async () => {
      await insertSamples(db, CHANNEL, [[new Date(Date.now() - 100 * DAY_MS), 1]]);
      await db.query("INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now())");

      const report = await housekeeper(
        housekeeping({
          retention: {
            rawDays: 40,
            fiveMinuteDays: 365,
            hourlyDays: 730,
            dailyDays: 3_650,
            auditDays: 730,
          },
        }),
      ).runOnce();

      assert.ok(report.droppedChunks >= 1);
      const left = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(left[0]?.count, '0', 'the hundred-day-old reading is gone');
    });

    it('will not drop raw the rollup has not consumed, however old it is', async () => {
      // Fifty days of raw with a forty-day horizon: retention wants this chunk. The five-minute
      // tier has only reached sixty days ago, so those readings have never been summarised —
      // dropping them would destroy the only copy.
      await insertSamples(db, CHANNEL, [[new Date(Date.now() - 50 * DAY_MS), 1]]);
      await db.query(
        "INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now() - interval '60 days')",
      );

      const stalled = await housekeeper().runOnce();
      assert.equal(stalled.droppedChunks, 0, 'the guard held');
      const survived = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(survived[0]?.count, '1');

      // Once the tier catches up, the same horizon takes it.
      await db.query("UPDATE rollup_watermark SET watermark = now() WHERE tier = 'sample_5m'");
      const caughtUp = await housekeeper().runOnce();
      assert.ok(caughtUp.droppedChunks >= 1);
      const gone = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(gone[0]?.count, '0');
    });

    it('re-queues a backfill window it could not finish in one pass', async () => {
      // Thirty days of correction, and the five-minute tier is allowed eight one-day slices per
      // pass. The queue entry must not be deleted with twenty-two days of it unread.
      const to = new Date(alignDown(new Date(), 300).getTime());
      const from = new Date(to.getTime() - 30 * DAY_MS);
      for (const tier of ROLLUP_TIERS) {
        await db.query('INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, now())', [
          tier.id,
        ]);
      }
      await housekeeper().noteLateSamples(from, to, 'long outage');

      const report = await housekeeper().runOnce();
      assert.equal(report.backfillWindows, 1);

      const queued = await db.query<{ from_time: Date; to_time: Date; reason: string }>(
        'SELECT from_time, to_time, reason FROM rollup_backfill',
      );
      assert.equal(queued.length, 1, 'the remainder went back on the queue');
      const remainder = queued[0];
      assert.ok(remainder);
      const expected = alignDown(from, 300).getTime() + MAX_SLICES_PER_TIER * DAY_MS;
      assert.equal(
        remainder.from_time.getTime(),
        expected,
        'starting exactly where the slice budget ran out',
      );
      assert.equal(remainder.to_time.getTime(), to.getTime());
    });

    it('will not drop a window a backfill has not been applied to yet', async () => {
      await insertSamples(db, CHANNEL, [[new Date(Date.now() - 100 * DAY_MS), 1]]);
      await db.query("INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now())");

      // The queue is drained before retention runs, so the only entries retention can still see
      // are the ones a single pass could not claim. Fill the claim quota with recent windows,
      // then add one more that reaches back past the retention horizon.
      await db.query(
        `INSERT INTO rollup_backfill (from_time, to_time, reason)
         SELECT now() - interval '1 hour', now(), 'filler' FROM generate_series(1, $1)`,
        [MAX_BACKFILL_ENTRIES],
      );
      await db.query(
        `INSERT INTO rollup_backfill (from_time, to_time, reason)
         VALUES (now() - interval '200 days', now() - interval '199 days', 'unclaimed')`,
      );

      const report = await housekeeper().runOnce();
      assert.equal(report.backfillWindows, MAX_BACKFILL_ENTRIES, 'the quota, and no more');
      assert.equal(report.droppedChunks, 0, 'retention deferred to the window still pending');
      const survived = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(survived[0]?.count, '1', 'the hundred-day-old reading is still there');

      // Drain the last entry — one day of correction, well inside a pass's slice budget — and
      // the same horizon takes the chunk.
      const second = await housekeeper().runOnce();
      assert.equal(second.backfillWindows, 1);
      const drained = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM rollup_backfill',
      );
      assert.equal(drained[0]?.count, '0');
      // Retention runs after the backfill inside the same pass, so the queue is already empty
      // by the time it looks: the chunk goes on this pass, not the next one.
      assert.ok(second.droppedChunks >= 1);
      const gone = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(gone[0]?.count, '0');
    });

    // ---------------------------------------------------------------------------------------
    // Orphaned readings — the cost of having no foreign key (S-05).
    // ---------------------------------------------------------------------------------------

    it('queues a deleted channel for reaping', async () => {
      const harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'reap-probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'reap-test',
        host: '192.0.2.10',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'reap-sensor',
        sensorType: 'icmp.ping',
      });
      const inserted = await db.query<{ id: number }>(
        `INSERT INTO channel (sensor_id, key, name) VALUES ($1, 'rt', 'Round trip') RETURNING id`,
        [sensor.id],
      );
      const channelId = inserted[0]?.id;
      assert.ok(channelId);

      await db.query('DELETE FROM channel WHERE id = $1', [channelId]);

      const queued = await db.query<{ channel_id: number }>('SELECT channel_id FROM channel_reap');
      assert.deepEqual(
        queued.map((row) => row.channel_id),
        [channelId],
      );
      await harness.service.delete(
        testActor,
        probe.id,
        { kind: 'exact', descendants: 2 },
        { kind: 'none' },
      );
    });

    it('reaps orphaned readings from raw and from every tier', async () => {
      const base = baseInstant();
      await seed(db, base);
      const keeper = housekeeper();
      await keeper.runOnce();

      for (const table of SAMPLE_TABLES) {
        const rows = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE channel_id = $1`,
          [CHANNEL],
        );
        assert.notEqual(rows[0]?.count, '0', `${table} holds readings to begin with`);
      }

      await db.query('INSERT INTO channel_reap (channel_id) VALUES ($1)', [CHANNEL]);
      const report = await keeper.runOnce();

      assert.equal(report.reapedChannels, 1);
      // Five raw readings, the three five-minute buckets they fall in, the two hours those fall
      // in, and the one day above them.
      assert.equal(report.reapedRows, 5 + 3 + 2 + 1);
      for (const table of SAMPLE_TABLES) {
        const rows = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE channel_id = $1`,
          [CHANNEL],
        );
        assert.equal(rows[0]?.count, '0', `${table} is clear of the orphan`);
      }
      const queue = await db.query<{ count: string }>('SELECT count(*) AS count FROM channel_reap');
      assert.equal(queue[0]?.count, '0');
    });

    // ---------------------------------------------------------------------------------------
    // One writer.
    // ---------------------------------------------------------------------------------------

    it('lets only one core run the lifecycle at a time', async () => {
      const base = baseInstant();
      await seed(db, base);

      const [first, second] = await Promise.all([housekeeper().runOnce(), housekeeper().runOnce()]);

      // Exactly one of them did the work; the other found the lock held and returned rather
      // than queueing behind it.
      assert.equal([first, second].filter((report) => report.ran).length, 1);
      assert.ok(at(await readTier(db, 'sample_5m', CHANNEL), base), 'and the work happened');
    });

    it('reports a failing step without abandoning the rest of the pass', async () => {
      const base = baseInstant();
      await seed(db, base);

      const broken = new Housekeeper({
        db,
        logger: silent,
        config: housekeeping(),
        store: Object.assign(new SqlTimeSeriesStore(), {
          compactableChunks: () => Promise.reject(new Error('compaction is having a day')),
        }),
      });

      const report = await broken.runOnce();
      assert.equal(report.failures.length, 1);
      assert.equal(report.failures[0]?.step, 'compress');
      assert.ok(
        at(await readTier(db, 'sample_5m', CHANNEL), base),
        'the rollup, which runs before it, still landed',
      );
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import type { LookupCatalogue } from '../src/lookups/catalogue.js';
import { loadLookups } from '../src/lookups/loader.js';
import { SensorStateService } from '../src/state/service.js';
import { HistoryService, type SensorHistory } from '../src/timeseries/history.js';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * One gap, walked from the failed check that created it to the array a chart is drawn from
 * (`S-09`).
 *
 * **Every stage of this already has its own tests, and that is exactly why this file exists.**
 * `no-data is not zero` is not a property of storage, or of the rollup, or of the query, or of
 * the chart — it is a property of the five of them *composed*, and a composition holds only
 * where somebody checks it end to end. Each stage passing its own tests is consistent with a
 * zero appearing at any seam between them: an outer join filling a missing bucket, a rollup
 * counting minutes rather than readings, a serialiser rendering `null` as `0`, a chart library
 * defaulting `spanGaps` to true. None of those would fail a test written for one stage.
 *
 * The reading is a constant, so arithmetic is the assertion. Every scan that succeeds reports
 * exactly 100 ms; anything that interpolates, zero-fills, or divides by elapsed time instead of
 * by readings produces a number that is not 100, and the test says which stage produced it.
 *
 * The scan at minute 25 is the deliberately nasty one: a **failed** check that carries a reading
 * of zero anyway, which is what a sensor type that reports `0` on failure looks like from here.
 * The contract says a Down sensor records no channel values; this proves the core enforces that
 * rather than trusting the probe to.
 */

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

const MINUTE = 60_000;
const SCANS = 60;
const FIRST_FAILURE = 20;
const LAST_FAILURE = 29;
/** The failed scan that reports a zero anyway. */
const LYING_SCAN = 25;
const RTT_MS = 100;

/**
 * Three days back, so the rollup is not waiting for the lag window to pass before it will touch
 * the newest buckets. Same trick, and the same reason, as `history.test.ts`.
 */
const BASE = new Date(Date.now() - 3 * 86_400_000);
/** Aligned to an hour, so a five-minute bucket boundary is where the arithmetic expects it. */
const START = new Date(Math.floor(BASE.getTime() / 3_600_000) * 3_600_000);

const at = (minute: number): Date => new Date(START.getTime() + minute * MINUTE);
const failed = (minute: number): boolean => minute >= FIRST_FAILURE && minute <= LAST_FAILURE;

const housekeeping = {
  enabled: false,
  intervalSeconds: 300,
  rollupLagSeconds: 0,
  retention: {
    rawDays: 40,
    fiveMinuteDays: 365,
    hourlyDays: 730,
    dailyDays: 3_650,
    auditDays: 730,
    stateDays: 3_650,
  },
  compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
};

function scan(minute: number): CheckResult {
  if (!failed(minute)) {
    return {
      sensorId: 0,
      at: at(minute).toISOString(),
      outcome: 'ok',
      message: '1/1 replies',
      durationMs: 12,
      channels: [{ key: 'rtt', value: RTT_MS, name: 'Response time', unit: 'ms' }],
    };
  }
  return {
    sensorId: 0,
    at: at(minute).toISOString(),
    outcome: 'error',
    message: 'no ICMP reply from 192.0.2.40 (4 sent, 0 replies)',
    durationMs: 5_000,
    channels:
      minute === LYING_SCAN ? [{ key: 'rtt', value: 0, name: 'Response time', unit: 'ms' }] : [],
  };
}

interface CountRow {
  n: string;
}

interface BucketRow {
  bucket: Date;
  value_sum: string;
  sample_count: string;
}

interface StateRow {
  time: Date;
  state: string;
}

describe(
  'a gap, end to end',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let lookups: LookupCatalogue;
    let sensorId: number;
    let channelId: number;
    let stats: ReturnType<IngestionService['stats']>;

    before(async () => {
      lookups = await loadLookups({ logger: silent });
      scratch = await createScratchDatabase('gapscen');
      db = scratch.db;
      harness = await buildHarness(db);

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Gap probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Gap device',
        host: '192.0.2.40',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Gap sensor',
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;

      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const service = new IngestionService({
        db,
        logger: silent,
        ingestor,
        states: new SensorStateService({ db, logger: silent, settings: harness.resolver }),
        resolver: new ChannelResolver({ logger: silent, lookups }),
      });

      // One batch per scan, which is what a probe reporting on a one-minute interval does. A
      // single batch of sixty would let the state machine see the whole outage at once, and the
      // two-step failure rule is part of what is being walked here.
      for (let minute = 0; minute < SCANS; minute += 1) {
        await service.acceptResults('probe-gap', {
          type: 'results',
          batchId: `b${String(minute)}`,
          results: [{ ...scan(minute), sensorId }],
        });
      }
      await ingestor.stop();
      stats = service.stats();

      const channels = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
        [sensorId],
      );
      const first = channels[0];
      assert.ok(first !== undefined, 'the rtt channel was never created');
      channelId = Number(first.id);

      await new Housekeeper({ db, logger: silent, config: housekeeping }).runOnce();
    });

    after(async () => {
      await scratch.drop();
    });

    // ---------------------------------------------------------------------------------------
    // 1. Ingestion: the failed scans contribute nothing, and the one that lied is counted.
    // ---------------------------------------------------------------------------------------

    it('refuses the reading a failed check carried, and says how many it refused', () => {
      assert.equal(stats.resultsReceived, SCANS);
      // Fifty successes plus the one a failed scan smuggled in.
      assert.equal(stats.readingsReceived, SCANS - 10 + 1);
      assert.equal(
        stats.discardedOnError,
        1,
        'a reading on a failed check must be dropped and counted, not stored',
      );
    });

    // ---------------------------------------------------------------------------------------
    // 2. Storage: a gap is the absence of rows.
    // ---------------------------------------------------------------------------------------

    it('stores no row at all for the minutes the sensor was failing', async () => {
      const [inside] = await db.query<CountRow>(
        `SELECT count(*)::text AS n FROM sample
         WHERE channel_id = $1 AND time >= $2 AND time <= $3`,
        [channelId, at(FIRST_FAILURE), at(LAST_FAILURE)],
      );
      assert.equal(inside?.n, '0', 'the outage left rows behind');

      const [total] = await db.query<CountRow>(
        `SELECT count(*)::text AS n FROM sample WHERE channel_id = $1`,
        [channelId],
      );
      assert.equal(total?.n, String(SCANS - 10));
    });

    it('holds no zero anywhere, which is the shape the whole rule is about', async () => {
      const [zeroes] = await db.query<CountRow>(
        `SELECT count(*)::text AS n FROM sample WHERE channel_id = $1 AND value = 0`,
        [channelId],
      );
      assert.equal(zeroes?.n, '0', 'a zero was stored for a check that failed');
    });

    // ---------------------------------------------------------------------------------------
    // 3. State history: the outage is here, and it is not the same length as the gap.
    // ---------------------------------------------------------------------------------------

    it('records the outage as state, where uptime is computed from', async () => {
      const rows = await db.query<StateRow>(
        `SELECT time, state::text AS state FROM sensor_state WHERE sensor_id = $1 ORDER BY time`,
        [sensorId],
      );
      assert.deepEqual(
        rows.map((row) => row.state),
        ['up', 'warning', 'down', 'up'],
        'the two-step failure rule should give Warning once, then Down',
      );

      // **The gap and the downtime are different lengths, and that is the point of the rule.**
      // Readings stop at the first failed scan; the sensor is not Down until the second, because
      // `scan.retryWarnings` defaults to 1. Anything that computed uptime from where the samples
      // stop would report a minute of downtime that never happened — which is why CLAUDE.md
      // computes it from this table instead.
      const down = rows[2];
      const recovered = rows[3];
      assert.ok(down !== undefined && recovered !== undefined);
      assert.equal(down.time.getTime(), at(FIRST_FAILURE + 1).getTime());
      assert.equal(recovered.time.getTime(), at(LAST_FAILURE + 1).getTime());
      assert.equal(recovered.time.getTime() - down.time.getTime(), 9 * MINUTE);
    });

    // ---------------------------------------------------------------------------------------
    // 4. Rollup: no bucket, rather than an empty one.
    // ---------------------------------------------------------------------------------------

    it('rolls up no bucket where there were no readings', async () => {
      const rows = await db.query<BucketRow>(
        `SELECT bucket, value_sum::text AS value_sum, sample_count::text AS sample_count
         FROM sample_5m WHERE channel_id = $1 ORDER BY bucket`,
        [channelId],
      );
      assert.ok(rows.length > 0, 'the rollup produced nothing at all');

      const buckets = rows.map((row) => (row.bucket.getTime() - START.getTime()) / MINUTE);
      assert.equal(buckets.includes(20), false, 'a bucket exists for a five minutes with no data');
      assert.equal(buckets.includes(25), false, 'a bucket exists for a five minutes with no data');

      // Every bucket that does exist holds five readings of 100 — never ten, which is what
      // counting minutes rather than readings would give, and never a sum dragged toward zero.
      for (const row of rows) {
        assert.equal(row.sample_count, '5');
        assert.equal(Number(row.value_sum), 5 * RTT_MS);
      }
    });

    // ---------------------------------------------------------------------------------------
    // 5. Query: null, at every resolution, from every source.
    // ---------------------------------------------------------------------------------------

    async function series(resolutionSeconds: number): Promise<SensorHistory> {
      return new HistoryService({ db, logger: silent }).forSensor(sensorId, {
        from: START,
        to: at(SCANS),
        resolutionSeconds,
      });
    }

    it('answers null for the gap and never zero, reading raw', async () => {
      const history = await series(60);
      const rtt = history.channels.find((channel) => channel.key === 'rtt');
      assert.ok(rtt !== undefined);

      // **All four arrays, not just `avg`.** The line breaking while the min-max band draws to
      // the floor is the same bug wearing a different array, and a `count` of zero at a gap tells
      // a client that a reading was taken and happened to be nothing. A gap is `null` in every
      // series a bucket has, or it is not a gap.
      for (const [index, bucket] of history.buckets.entries()) {
        const minute = (Date.parse(bucket) - START.getTime()) / MINUTE;
        const at: (number | null | undefined)[] = [
          rtt.avg[index],
          rtt.min[index],
          rtt.max[index],
          rtt.count[index],
        ];
        if (failed(minute)) {
          assert.deepEqual(at, [null, null, null, null], `minute ${String(minute)} is not a gap`);
        } else {
          assert.deepEqual(at, [RTT_MS, RTT_MS, RTT_MS, 1], `minute ${String(minute)} misread`);
        }
      }
      assert.equal(
        rtt.avg.filter((value) => value === null).length,
        10,
        'exactly the failed minutes are gaps',
      );
    });

    it('answers null for the gap and never zero, reading a rollup tier', async () => {
      const history = await series(300);
      const rtt = history.channels.find((channel) => channel.key === 'rtt');
      assert.ok(rtt !== undefined);

      const gaps: number[] = [];
      for (const [index, bucket] of history.buckets.entries()) {
        if (rtt.avg[index] === null) gaps.push((Date.parse(bucket) - START.getTime()) / MINUTE);
      }
      assert.deepEqual(gaps, [20, 25], 'the two empty five-minute buckets should be gaps');
      for (const [index] of history.buckets.entries()) {
        const at: (number | null | undefined)[] = [
          rtt.avg[index],
          rtt.min[index],
          rtt.max[index],
          rtt.count[index],
        ];
        const gap: boolean = rtt.avg[index] === null;
        assert.deepEqual(
          at,
          gap ? [null, null, null, null] : [RTT_MS, RTT_MS, RTT_MS, 5],
          `bucket ${String(index)} is neither a clean gap nor five readings of ${String(RTT_MS)}`,
        );
      }
    });

    it('never averages across a gap, however wide the bucket is', async () => {
      // One bucket over the whole hour. Fifty readings of 100 average 100 — `sum / count`. An
      // average computed over elapsed time instead would give 83.3, and the difference between
      // those two numbers is the difference between "the link was fine for fifty minutes" and
      // "the link got slower", which is the wrong conclusion to hand an operator.
      const history = await series(3_600);
      const rtt = history.channels.find((channel) => channel.key === 'rtt');
      assert.ok(rtt !== undefined);
      assert.equal(rtt.avg.length, 1);
      assert.equal(rtt.avg[0], RTT_MS);
      assert.equal(rtt.count[0], SCANS - 10);
      assert.equal(rtt.min[0], RTT_MS);
      assert.equal(rtt.max[0], RTT_MS);
    });

    // ---------------------------------------------------------------------------------------
    // 6. The wire: what a chart is actually handed.
    // ---------------------------------------------------------------------------------------

    it('serialises the gap as JSON null, which is what the chart tests assume', async () => {
      // The last seam, and the cheapest place to lose a gap: `JSON.stringify` turns `undefined`
      // into a missing key and a sparse array into nulls, so an array that looked right in
      // process can arrive at the browser the wrong length. The web tests build their fixtures
      // by hand from this shape — this is what says the shape is real.
      const history = await series(300);
      const parsed = JSON.parse(JSON.stringify(history)) as SensorHistory;
      const rtt = parsed.channels.find((channel) => channel.key === 'rtt');
      assert.ok(rtt !== undefined);
      assert.equal(rtt.avg.length, parsed.buckets.length);
      assert.equal(rtt.min.length, parsed.buckets.length);
      assert.equal(rtt.max.length, parsed.buckets.length);
      assert.equal(rtt.count.length, parsed.buckets.length);
      // Every gap survives as a literal `null` in all four series — not a missing element, not a
      // zero, and not a shorter array with the buckets silently re-indexed underneath it.
      for (const series of [rtt.avg, rtt.min, rtt.max, rtt.count]) {
        assert.equal(JSON.stringify(series).includes('null'), true);
        assert.equal(series.filter((value) => value === null).length, 2);
      }
      assert.equal(
        rtt.avg.every((value) => value === null || value === RTT_MS),
        true,
      );
    });
  },
);

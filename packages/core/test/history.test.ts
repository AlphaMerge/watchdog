import { testCatalogue } from './support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AuditRepository } from '../src/audit/store.js';
import { ApiServer } from '../src/api/server.js';
import type { Database } from '../src/db/pool.js';
import { HistoryService, type SensorHistory } from '../src/timeseries/history.js';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const DAY_MS = 86_400_000;
const MINUTE = 60_000;

const housekeeping = {
  enabled: false,
  intervalSeconds: 300,
  // Zero: the fixture sits three days in the past, so there is nothing to wait for.
  rollupLagSeconds: 0,
  retention: {
    rawDays: 40,
    fiveMinuteDays: 365,
    hourlyDays: 730,
    dailyDays: 3_650,
    auditDays: 730,
  },
  compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
};

/**
 * One channel, laid out so the two mistakes that matter are both visible.
 *
 *   minutes 0-4   rtt = 10 each      5m bucket 0: n=5  sum=50   avg=10
 *   minute  5     rtt = 100          5m bucket 1: n=1  sum=100  avg=100
 *   minutes 10-14 nothing            5m bucket 2: GAP
 *   minute  15    rtt = 7            5m bucket 3: n=1  sum=7    avg=7
 *
 * At ten minutes the first bucket merges 5 readings with 1: the weighted average is 25, and
 * averaging the two five-minute averages would say 55.
 */
function readings(base: Date): [Date, number][] {
  return [
    [new Date(base.getTime()), 10],
    [new Date(base.getTime() + 1 * MINUTE), 10],
    [new Date(base.getTime() + 2 * MINUTE), 10],
    [new Date(base.getTime() + 3 * MINUTE), 10],
    [new Date(base.getTime() + 4 * MINUTE), 10],
    [new Date(base.getTime() + 5 * MINUTE), 100],
    [new Date(base.getTime() + 15 * MINUTE), 7],
  ];
}

describe(
  'historic data',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let history: HistoryService;
    let app: FastifyInstance;
    let sensorId: number;
    let otherSensorId: number;
    let rtt: number;
    let loss: number;
    let base: Date;

    before(async () => {
      scratch = await createScratchDatabase('history');
      db = scratch.db;
      harness = await buildHarness(db);
      history = new HistoryService({ db, logger: silent });

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history,
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', harness.service);
      app = server.app;

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'History probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'History device',
        host: '192.0.2.40',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'History sensor',
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;
      const bare = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Never scanned',
        sensorType: 'icmp.ping',
      });
      otherSensorId = bare.id;

      // The channels are not inserted here any more: since P-05 the sensor type declares them
      // and creating the sensor creates them. Reading them back is the stronger assertion — it
      // fails if the registry ever stops declaring what this suite depends on.
      const channels = await db.query<{ id: number; key: string }>(
        'SELECT id, key FROM channel WHERE sensor_id = $1',
        [sensorId],
      );
      rtt = channels.find((c) => c.key === 'rtt')?.id ?? 0;
      loss = channels.find((c) => c.key === 'loss')?.id ?? 0;
      assert.ok(rtt > 0 && loss > 0);
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      for (const table of ['sample', 'sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query(`SELECT drop_chunks($1::regclass, older_than => 'infinity'::timestamptz)`, [
          table,
        ]);
      }
      await db.query('DELETE FROM rollup_watermark');
      await db.query('DELETE FROM rollup_backfill');

      const midnight = await db.query<{ at: Date }>(
        "SELECT time_bucket('1 day', now() - interval '3 days') AS at",
      );
      base = midnight[0]?.at ?? new Date();

      const rows = readings(base);
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::float8[])`,
        [rows.map((r) => r[0]), rows.map(() => rtt), rows.map((r) => r[1])],
      );
      await db.query(
        `INSERT INTO sample (time, channel_id, value) VALUES ($1, $3, 0.5), ($2, $3, 1.5)`,
        [base, new Date(base.getTime() + 7 * MINUTE), loss],
      );
    });

    async function rollUp(): Promise<void> {
      await new Housekeeper({ db, logger: silent, config: housekeeping }).runOnce();
    }

    function channelOf(result: SensorHistory, key: string) {
      const channel = result.channels.find((c) => c.key === key);
      assert.ok(channel, `expected a ${key} channel`);
      return channel;
    }

    // ---------------------------------------------------------------------------------------
    // Aggregation.
    // ---------------------------------------------------------------------------------------

    it('reads raw when the resolution is finer than any tier', async () => {
      const result = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 10 * MINUTE),
        resolutionSeconds: 60,
      });

      assert.equal(result.source, 'sample');
      assert.deepEqual(
        result.segments.map((s) => s.table),
        ['sample'],
      );
      assert.equal(result.bucketCount, 10);
      assert.deepEqual(channelOf(result, 'rtt').avg, [10, 10, 10, 10, 10, 100, ...nulls(4)]);
    });

    it('reads the five-minute tier and reports where the numbers came from', async () => {
      await rollUp();
      const result = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 20 * MINUTE),
        resolutionSeconds: 300,
      });

      assert.equal(result.source, 'sample_5m');
      assert.equal(result.bucketCount, 4);
      const channel = channelOf(result, 'rtt');
      assert.deepEqual(channel.avg, [10, 100, null, 7]);
      assert.deepEqual(channel.count, [5, 1, null, 1]);
      assert.deepEqual(channel.min, [10, 100, null, 7]);
      assert.deepEqual(channel.max, [10, 100, null, 7]);
    });

    it('weights an average by readings, not by bucket', async () => {
      await rollUp();
      const result = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 20 * MINUTE),
        resolutionSeconds: 600,
      });

      const channel = channelOf(result, 'rtt');
      // Five readings of 10 and one of 100 in the same ten-minute bucket.
      assert.equal(channel.avg[0], 25);
      assert.equal(channel.count[0], 6);
      assert.equal(channel.min[0], 10);
      assert.equal(channel.max[0], 100);
      assert.notEqual(channel.avg[0], 55, 'the average of the two five-minute averages');
    });

    // ---------------------------------------------------------------------------------------
    // The rollup's progress must not be visible in the answer.
    // ---------------------------------------------------------------------------------------

    it('gives the same answer however far the rollup has got', async () => {
      await rollUp();
      const materialised = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 20 * MINUTE),
        resolutionSeconds: 300,
      });
      assert.deepEqual(
        materialised.segments.map((s) => s.table),
        ['sample_5m'],
      );

      // Wind the tier back to the middle of the range. Everything after it now has to come from
      // raw, and a bucket sits on the boundary — the case that double counts or vanishes if the
      // segments are wrong.
      await db.query("UPDATE rollup_watermark SET watermark = $1 WHERE tier = 'sample_5m'", [
        new Date(base.getTime() + 12 * MINUTE),
      ]);
      const stitched = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 20 * MINUTE),
        resolutionSeconds: 300,
      });

      assert.deepEqual(
        stitched.segments.map((s) => s.table),
        ['sample_5m', 'sample'],
        'assembled from two sources',
      );
      assert.deepEqual(
        stitched.channels,
        materialised.channels,
        'and indistinguishable from the fully materialised answer',
      );
    });

    it('serves the newest buckets even when nothing has been rolled up at all', async () => {
      // No housekeeping pass has run, so there are no watermarks and no tier rows. Reading the
      // tier alone would return an empty graph for data that is sitting right there in raw.
      const result = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 20 * MINUTE),
        resolutionSeconds: 300,
      });

      assert.deepEqual(
        result.segments.map((s) => s.table),
        ['sample'],
      );
      assert.deepEqual(channelOf(result, 'rtt').avg, [10, 100, null, 7]);
    });

    // ---------------------------------------------------------------------------------------
    // Gaps.
    // ---------------------------------------------------------------------------------------

    it('reports no-data as null, never as zero', async () => {
      await rollUp();
      const result = await history.forSensor(sensorId, {
        from: base,
        to: new Date(base.getTime() + 30 * MINUTE),
        resolutionSeconds: 300,
      });

      const channel = channelOf(result, 'rtt');
      assert.equal(channel.avg.length, result.buckets.length, 'dense, one entry per bucket');
      assert.equal(channel.avg[2], null, 'minutes 10-14 produced no readings');
      assert.equal(channel.count[2], null);
      assert.deepEqual(channel.avg.slice(4), nulls(2), 'and nothing after minute 20');
      assert.ok(
        !channel.avg.slice(4).includes(0),
        'a sensor that recorded nothing did not record zero',
      );

      // The other channel gaps in different places, which is why each carries its own array.
      assert.deepEqual(channelOf(result, 'loss').avg, [0.5, 1.5, null, null, null, null]);
    });

    // ---------------------------------------------------------------------------------------
    // Shape and errors.
    // ---------------------------------------------------------------------------------------

    it('returns declared channels, all gaps, for a sensor that has never reported', async () => {
      const result = await history.forSensor(otherSensorId, {
        from: base,
        to: new Date(base.getTime() + 10 * MINUTE),
        resolutionSeconds: 300,
      });

      // Not a 404, and since P-05 not an empty list either: the sensor type declares its
      // channels, so they exist from the moment the sensor does. A graph drawn from this shows
      // two named, empty series rather than a blank panel that looks like a broken query.
      assert.deepEqual(
        result.channels.map((channel) => channel.key),
        ['rtt', 'loss'],
      );
      assert.equal(result.bucketCount, 2);

      // And every bucket is a gap, not a zero (CLAUDE.md: no-data is not zero).
      for (const channel of result.channels) {
        assert.deepEqual(channel.avg, [null, null]);
        assert.deepEqual(channel.count, [null, null]);
      }
    });

    it('answers over HTTP with the effective range and what was adjusted', async () => {
      await rollUp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/history`,
        query: {
          from: base.toISOString(),
          to: new Date(base.getTime() + 20 * MINUTE).toISOString(),
          resolutionSeconds: '45',
        },
      });

      assert.equal(response.statusCode, 200);
      const body = response.json<SensorHistory>();
      assert.equal(body.resolutionSeconds, 60, 'snapped up to a supported interval');
      assert.equal(body.source, 'sample');
      assert.equal(body.adjustments[0]?.kind, 'resolution-coarsened');
      assert.equal(body.buckets.length, 20);
      assert.equal(body.channels.length, 2);
      const first = body.channels[0];
      assert.ok(first);
      assert.equal(first.key, 'rtt', 'the primary channel comes first');
      assert.equal(first.avg[0], 10);
      assert.equal(first.avg[6], null, 'and the nulls survive serialisation');
    });

    it('is a 404 for something that is not a sensor', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(harness.rootId)}/history`,
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'OBJECT_NOT_FOUND');
    });

    it('is a 400 for a range that does not go forwards', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/history`,
        query: { from: base.toISOString(), to: new Date(base.getTime() - MINUTE).toISOString() },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'QUERY_INVALID');
    });

    it('defaults to the last two days when asked for nothing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/history`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<SensorHistory>();
      const span = new Date(body.to).getTime() - new Date(body.from).getTime();
      assert.ok(Math.abs(span - 2 * DAY_MS) <= body.resolutionSeconds * 1_000);
      assert.deepEqual(body.adjustments, []);
    });
  },
);

function nulls(count: number): null[] {
  return new Array<null>(count).fill(null);
}

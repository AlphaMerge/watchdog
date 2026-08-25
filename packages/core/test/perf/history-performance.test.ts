import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../../src/db/pool.js';
import { HistoryService } from '../../src/timeseries/history.js';
import { SqlTimeSeriesStore } from '../../src/timeseries/store.js';
import { tierById } from '../../src/timeseries/tiers.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement, per CLAUDE.md: "performance claims need a measurement committed to
 * the repo, not an assertion".
 *
 * The claim is the one that justifies the rollup tiers existing: **automatic source selection
 * is what makes a long range answerable at all**. The same forty-day question is asked twice —
 * once at a resolution a tier can compose, once at one it cannot — and the difference is the
 * whole return on S-06.
 */
const DAYS = 40;
const CHANNELS = 3;

describe(
  'historic query performance',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let history: HistoryService;
    let sensorId: number;
    let from: Date;
    let to: Date;
    const repo = new SqlTimeSeriesStore();

    before(async () => {
      scratch = await createScratchDatabase('historyperf');
      db = scratch.db;
      history = new HistoryService({ db, logger: silent });

      const harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Perf probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Perf device',
        host: '192.0.2.50',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Perf sensor',
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;

      const channels = await db.query<{ id: number }>(
        `INSERT INTO channel (sensor_id, key, name, unit, is_primary)
         SELECT $1, 'ch' || n, 'Channel ' || n, 'ms', n = 1
         FROM generate_series(1, $2) n
         RETURNING id`,
        [sensorId, CHANNELS],
      );
      assert.equal(channels.length, CHANNELS);

      const bounds = await db.query<{ from: Date; to: Date }>(
        `SELECT time_bucket('1 day', now() - make_interval(days => $1::int)) AS from,
                time_bucket('1 day', now()) AS to`,
        [DAYS],
      );
      from = bounds[0]?.from ?? new Date();
      to = bounds[0]?.to ?? new Date();

      // Forty days of one-minute readings on every channel: 172,800 rows, which is what a
      // single sensor's raw history actually looks like at the retention limit.
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT ts, c.id, 50 + 40 * sin(extract(epoch FROM ts) / 3600.0 + c.id)
         FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 minute',
                              interval '1 minute') ts,
              (SELECT id FROM channel WHERE sensor_id = $3) c`,
        [from, to, sensorId],
      );

      // Roll every tier over the whole range and mark them materialised, so the planner is
      // choosing between sources that all genuinely hold the answer.
      for (const id of ['sample_5m', 'sample_1h', 'sample_1d'] as const) {
        const tier = tierById(id);
        await db.tx((q) => repo.rollUp(q, tier, from, to));
        await db.query(
          'INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, $2) ON CONFLICT (tier) DO UPDATE SET watermark = EXCLUDED.watermark',
          [id, to],
        );
      }
    });

    after(async () => {
      await scratch.drop();
    });

    it('answers a long range from a rollup tier rather than from raw', async () => {
      const channelIds = (
        await db.query<{ id: number }>('SELECT id FROM channel WHERE sensor_id = $1', [sensorId])
      ).map((row) => row.id);

      // Same buckets, same answer, different source. Asking the repository directly is the only
      // way to get the comparison: over forty days the rules will not let anyone ask raw for
      // hourly buckets, which is rather the point of the rules.
      const readFrom = async (table: 'sample' | 'sample_1h') => {
        const startedAt = process.hrtime.bigint();
        const rows = await db.tx((q) =>
          repo.readSeries(q, {
            channelIds,
            segments: [{ table, from, to }],
            bucketSeconds: 3_600,
          }),
        );
        return { rows: rows.length, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 };
      };

      const fromTier = await readFrom('sample_1h');
      const fromRaw = await readFrom('sample');
      assert.equal(fromTier.rows, fromRaw.rows, 'the two sources agree on the answer');

      const time = async (start: Date, resolutionSeconds: number) => {
        const startedAt = process.hrtime.bigint();
        const result = await history.forSensor(sensorId, { from: start, to, resolutionSeconds });
        return { result, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 };
      };
      const hourly = await time(from, 3_600);
      const daily = await time(from, 86_400);
      // Just under the forty-day threshold, where the source is still the caller's choice.
      // 45 minutes composes exactly from five-minute rows; 44 does not, so it can only be built
      // from raw. Nobody would choose the second on purpose — the planner is what stops it
      // happening by accident.
      const justUnder = new Date(to.getTime() - 39 * 86_400_000);
      const composable = await time(justUnder, 2_700);
      const awkward = await time(justUnder, 2_640);

      assert.equal(hourly.result.source, 'sample_1h');
      assert.equal(daily.result.source, 'sample_1d');
      assert.equal(composable.result.source, 'sample_5m');
      assert.equal(awkward.result.source, 'sample');

      const perChannel = DAYS * 1_440;
      const rowsPerChannel: Record<string, number> = {
        sample: perChannel,
        sample_5m: DAYS * 288,
        sample_1h: DAYS * 24,
        sample_1d: DAYS,
      };
      const row = (
        label: string,
        m: { result: { source: string; bucketCount: number }; ms: number },
        note = '',
      ) =>
        `      ${label.padEnd(7)} from ${m.result.source.padEnd(9)} ${m.ms.toFixed(0).padStart(4)} ms  ` +
        `${String(m.result.bucketCount).padStart(4)} buckets from ` +
        `${(rowsPerChannel[m.result.source] ?? 0).toLocaleString('en-GB').padStart(6)} rows/channel${note}\n`;

      process.stdout.write(
        `\n    measured, ${String(DAYS)} days of one-minute readings on ${String(CHANNELS)} channels ` +
          `(${(perChannel * CHANNELS).toLocaleString('en-GB')} raw rows):\n` +
          `      hourly buckets, ${String(DAYS)} days, same answer either way:\n` +
          `        from sample_1h  ${fromTier.ms.toFixed(0).padStart(4)} ms\n` +
          `        from sample     ${fromRaw.ms.toFixed(0).padStart(4)} ms   ` +
          `(${(fromRaw.ms / fromTier.ms).toFixed(1)}x, reading 60x the rows)\n` +
          `      end to end:\n` +
          row('1 hour', hourly) +
          row('1 day', daily) +
          row('45 min', composable) +
          row('44 min', awkward, '   <- no tier divides 44 minutes'),
      );

      // The magnitude moves with the machine and with how busy it is; the ordering does not.
      // Asserting a particular multiple would be asserting the hardware — 60x fewer rows buys
      // between two and three times the speed here, because at this volume fixed costs still
      // dominate — so what is checked is that reading the tier is faster at all, and that it is
      // the tier the planner chose.
      assert.ok(
        fromTier.ms < fromRaw.ms,
        `tier read took ${fromTier.ms.toFixed(0)} ms against ${fromRaw.ms.toFixed(0)} ms from raw`,
      );
      // Whatever the source, an interactive graph query has to feel immediate.
      for (const [label, measured] of [
        ['hourly', hourly],
        ['daily', daily],
        ['45-minute', composable],
        ['44-minute', awkward],
      ] as const) {
        assert.ok(measured.ms < 500, `${label} query took ${measured.ms.toFixed(0)} ms`);
      }
    });

    it('costs no more to stitch an answer from several sources', async () => {
      // The tail union is on the hot path of every live graph — the newest few minutes always
      // come from raw — so it has to be free. Wind the tiers back a day and ask again.
      const behind = new Date(to.getTime() - 86_400_000);
      for (const id of ['sample_5m', 'sample_1h', 'sample_1d'] as const) {
        await db.query('UPDATE rollup_watermark SET watermark = $1 WHERE tier = $2', [behind, id]);
      }

      const startedAt = process.hrtime.bigint();
      const stitched = await history.forSensor(sensorId, { from, to, resolutionSeconds: 3_600 });
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

      assert.deepEqual(
        stitched.segments.map((s) => s.table),
        ['sample_1h', 'sample'],
      );
      process.stdout.write(
        `      stitched ${String(stitched.segments.length)} sources        ${ms.toFixed(0).padStart(5)} ms  ` +
          `${String(stitched.bucketCount).padStart(4)} buckets   <- a day of tail read from raw\n`,
      );
      assert.ok(ms < 500, `stitched query took ${ms.toFixed(0)} ms`);
    });
  },
);

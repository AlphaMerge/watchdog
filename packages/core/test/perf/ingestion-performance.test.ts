import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { coreConfigSchema, loadConfig, type CheckResult, type CoreConfig } from '@ms/shared';
import type { Database } from '../../src/db/pool.js';
import { Ingestor, type SampleRow } from '../../src/ingestion/ingestor.js';
import { IngestionService } from '../../src/ingestion/service.js';
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
 * The claim is Phase 1's exit criterion from `PLAN.md`: **100,000 samples a minute sustained,
 * p99 write latency under 100 ms**. Both numbers come out of the pipeline the service runs, not
 * a hand-written INSERT — batching, the bounded queue and the per-batch attribution are all in
 * the path being timed.
 *
 * The measurements live in their own suite, run serially and before the correctness tests, for
 * a reason worth stating: taken alongside a dozen test files hammering the same PostgreSQL — or
 * immediately after fifteen scratch databases have been dropped — a latency percentile measures
 * the harness rather than the pipeline. The first version of this ran last and failed
 * intermittently at 136 ms while measuring 24 ms in isolation.
 */
const TARGET_PER_MINUTE = 100_000;
const P99_BUDGET_MS = 100;

/** The batch size we actually ship, read from the schema so the two cannot drift apart. */
const SHIPPED = loadConfig<CoreConfig>({ schema: coreConfigSchema, env: {}, argv: [] }).config
  .ingestion;

describe(
  'ingestion performance',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    const sensorIds: number[] = [];

    before(async () => {
      scratch = await createScratchDatabase('ingestperf');
      db = scratch.db;
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
        host: '192.0.2.30',
      });
      for (let index = 0; index < 100; index += 1) {
        const sensor = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: `perf-sensor-${String(index)}`,
          sensorType: 'icmp.ping',
        });
        sensorIds.push(sensor.id);
      }
    });

    after(async () => {
      await scratch.drop();
    });

    it('sustains 100,000 samples a minute with a p99 write inside 100 ms', async () => {
      // 100,000 readings across 2,000 channels — the shape a large installation produces in a
      // minute — offered in 500-reading batches, which is what a probe reporting a few hundred
      // sensors at once looks like.
      const channels = 2_000;
      const perChannel = 50;
      const total = channels * perChannel;

      const build = (base: number): SampleRow[][] => {
        const batches: SampleRow[][] = [];
        let current: SampleRow[] = [];
        for (let tick = 0; tick < perChannel; tick += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            current.push({
              channelId: 500_000 + channel,
              at: new Date(base + tick * 60_000),
              value: (tick % 97) + channel / 1_000,
            });
            if (current.length === 500) {
              batches.push(current);
              current = [];
            }
          }
        }
        if (current.length > 0) batches.push(current);
        return batches;
      };

      // Batch size trades write latency against round trips, and the exit criterion is stated in
      // both. Sweeping it here is what makes the shipped default a measured choice rather than a
      // round number — and it is why the default is not simply as large as it will go.
      const sizes = [1_000, 2_000, 5_000];
      const measured: { size: number; perMinute: number; p99: number; writes: number }[] = [];

      for (const [index, batchMaxRows] of sizes.entries()) {
        const ingestor = new Ingestor({
          db,
          logger: silent,
          config: { ...SHIPPED, batchMaxRows },
        });
        // A distinct day per run, so a later run is not measuring the first one's duplicates.
        const batches = build(new Date('2026-07-01T00:00:00.000Z').getTime() + index * 86_400_000);

        const startedAt = process.hrtime.bigint();
        // Offered all at once, as a fleet of probes would. The bounded queue is what keeps this
        // honest: at 200,000 rows it holds the lot, so nothing is refused and the elapsed time
        // is the pipeline's, not the test's pacing.
        const outcomes = await Promise.all(
          batches.map((samples, batch) =>
            ingestor.submit({ source: `probe-${String(batch)}`, samples }),
          ),
        );
        await ingestor.stop();
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const stats = ingestor.stats();

        assert.ok(
          outcomes.every((outcome) => outcome.accepted),
          'nothing was refused',
        );
        assert.equal(stats.storedSamples, total);
        assert.equal(stats.refusedBatches, 0);

        measured.push({
          size: batchMaxRows,
          perMinute: (total / elapsedMs) * 60_000,
          p99: stats.writeMs.p99,
          writes: stats.writes,
        });
      }

      const stored = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(
        Number(stored[0]?.count),
        total * sizes.length,
        'and every reading is actually in the table',
      );

      const lines = measured
        .map(
          (row) =>
            `      ${String(row.size).padStart(5)} rows/write  ` +
            `${Math.round(row.perMinute).toLocaleString('en-GB').padStart(11)} samples/min  ` +
            `p99 ${row.p99.toFixed(1).padStart(6)} ms  ${String(row.writes).padStart(3)} writes` +
            (row.size === SHIPPED.batchMaxRows ? '   <- shipped default' : ''),
        )
        .join('\n');
      process.stdout.write(
        `\n    measured, ${String(total)} readings per run, target ` +
          `${TARGET_PER_MINUTE.toLocaleString('en-GB')} samples/min and p99 under ` +
          `${String(P99_BUDGET_MS)} ms:\n${lines}\n`,
      );

      const shipped = measured.find((row) => row.size === SHIPPED.batchMaxRows);
      assert.ok(shipped, 'the sweep covers the size we ship');
      assert.ok(
        shipped.perMinute >= TARGET_PER_MINUTE,
        `sustained ${Math.round(shipped.perMinute).toString()} samples/minute, target ${String(TARGET_PER_MINUTE)}`,
      );
      // The criterion itself, on the size we actually ship.
      assert.ok(
        shipped.p99 < P99_BUDGET_MS,
        `p99 write was ${shipped.p99.toFixed(1)} ms, budget ${String(P99_BUDGET_MS)} ms`,
      );
      // And the decision behind the default: it exists because the largest batch size spends
      // latency to buy throughput it does not need. Comparing the two measurements from the
      // same run is stable in a way an absolute threshold is not — a busy machine moves both.
      const largest = measured.at(-1);
      assert.ok(largest);
      assert.ok(
        shipped.p99 < largest.p99,
        `the shipped batch size should write faster than ${String(largest.size)} rows: ` +
          `${shipped.p99.toFixed(1)} ms against ${largest.p99.toFixed(1)} ms`,
      );
    });

    it('costs almost nothing extra to go through the wire format and channel resolution', async () => {
      const ingestor = new Ingestor({ db, logger: silent, config: SHIPPED });
      const service = new IngestionService({ db, logger: silent, ingestor });

      // 100 sensors x 3 channels, reported 100 times: 30,000 readings that all have to be
      // mapped from (sensorId, key) to a channel id before they can be written.
      const keys = ['rtt', 'loss', 'jitter'];
      const base = new Date('2026-07-02T00:00:00.000Z').getTime();
      const messages: CheckResult[][] = [];
      for (let tick = 0; tick < 100; tick += 1) {
        messages.push(
          sensorIds.map((sensorId) => ({
            sensorId,
            at: new Date(base + tick * 60_000).toISOString(),
            outcome: 'ok' as const,
            message: '',
            durationMs: 2,
            channels: keys.map((key) => ({ key, value: tick + key.length })),
          })),
        );
      }
      const total = messages.length * sensorIds.length * keys.length;

      // One pass first, so the channels exist and the cache is warm — which is the steady state,
      // not the first minute after a restart.
      await service.acceptResults('probe-warm', {
        type: 'results',
        batchId: 'warm',
        results: messages[0] ?? [],
      });

      const startedAt = process.hrtime.bigint();
      const replies = await Promise.all(
        messages.map((results, index) =>
          service.acceptResults('probe-1', {
            type: 'results',
            batchId: `batch-${String(index)}`,
            results,
          }),
        ),
      );
      await ingestor.stop();
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      assert.ok(
        replies.every((reply) => reply.type === 'results-ack'),
        'every batch acknowledged',
      );
      const stats = service.stats();
      // Only `jitter` is new. Since P-05 the sensor type declares `rtt` and `loss`, so they were
      // created with the sensor and the first scan has two thirds less work to do — the point of
      // declaring channels up front rather than discovering them from the wire.
      assert.equal(stats.channelsCreated, sensorIds.length, 'one new channel per sensor');
      assert.equal(stats.cachedChannels, sensorIds.length * keys.length);

      const perMinute = (total / elapsedMs) * 60_000;
      process.stdout.write(
        `\n    measured, ${String(total)} readings through the full path:\n` +
          `      throughput ${Math.round(perMinute).toLocaleString('en-GB')} samples/minute\n` +
          `      channels   ${String(stats.channelsCreated)} created once, then ` +
          `${String(stats.cachedChannels)} resolved from cache with no query at all\n`,
      );

      assert.ok(
        perMinute >= TARGET_PER_MINUTE,
        `sustained ${Math.round(perMinute).toString()} samples/minute through the full path`,
      );
    });
  },
);

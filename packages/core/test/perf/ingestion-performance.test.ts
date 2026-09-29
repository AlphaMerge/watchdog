import { strict as assert } from 'node:assert';
import { PauseRepository } from '../../src/objects/pause-repository.js';
import { after, before, describe, it } from 'node:test';
import {
  coreConfigSchema,
  loadConfig,
  probeConfigSchema,
  type CheckResult,
  type CoreConfig,
  type ProbeConfig,
} from '@ms/shared';
import type { Database } from '../../src/db/pool.js';
import { CompositeAuditSink, DatabaseAuditSink } from '../../src/audit/store.js';
import { ChannelResolver } from '../../src/ingestion/channels.js';
import { Ingestor, type SampleRow } from '../../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../../src/ingestion/invalidation.js';
import { SensorOwnership } from '../../src/ingestion/ownership.js';
import type { TreeNodeInput } from '../../src/objects/tree-plan.js';
import { IngestionService } from '../../src/ingestion/service.js';
import { SensorStateService } from '../../src/state/service.js';
import type { ProbeOrigin } from '../../src/transport/probe-endpoint.js';
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
 *
 * **Every batch goes in the way a probe's does** (`P-233`): through `acceptProbeResults`, with
 * `P-228`'s ownership gate in front of both halves of ingestion. Until `P-233` these called
 * `acceptResults`, the core's own producers' path, which has no gate — so the budgets described
 * a pipeline no probe's batch takes. The gate caches who owns each sensor, a restart starts with
 * that cache empty, and every move or delete anywhere clears all of it, so the cases below
 * measure it both ways.
 */
const TARGET_PER_MINUTE = 100_000;
const P99_BUDGET_MS = 100;

/** The batch size we actually ship, read from the schema so the two cannot drift apart. */
const SHIPPED = loadConfig<CoreConfig>({ schema: coreConfigSchema, env: {}, argv: [] }).config
  .ingestion;

/** How many results a probe offers in one batch, as it ships: a first batch's worth of misses. */
const PROBE_BATCH = loadConfig<ProbeConfig>({ schema: probeConfigSchema, env: {}, argv: [] }).config
  .probe.spoolBatchMaxRows;

describe(
  'ingestion performance',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Awaited<ReturnType<typeof buildHarness>>;
    const sensorIds: number[] = [];
    /** Where every batch below says it came from: the probe the sensors are under. */
    let perfProbe: ProbeOrigin;

    before(async () => {
      scratch = await createScratchDatabase('ingestperf');
      db = scratch.db;
      harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Perf probe',
      });
      perfProbe = { gid: 'perf-probe', probeObjectId: probe.id };
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
      const measured: {
        size: number;
        perMinute: number;
        p50: number;
        p99: number;
        writes: number;
      }[] = [];

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
          p50: stats.writeMs.p50,
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
            `p50 ${row.p50.toFixed(1).padStart(6)} ms  ` +
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
      // latency on every write to buy throughput it does not need. **Compared on the median
      // write, not the p99** (`P-237`). At these sizes the p99 is the single slowest write: 100
      // writes at 1,000 rows and 20 at 5,000, and `floor(0.99 × n)` is the last index of either.
      // Two p99s are two stalls, and a stall is added to whichever write it lands on — one sweep
      // failed by 0.3 ms, 73.8 against 73.5, while the shipped size's p99 ran from 22.9 to
      // 285.6 ms across five (`findings/2026-09-29-probe-gate-ingestion.md`). The median is
      // over half the writes, which one stall does not move, and it is the cost a larger batch
      // actually adds. Measured on a deliberately busy machine, five sweeps back to back: the
      // median 5,000-row write took 2.8 to 8.7 times the shipped size's, so this holds with a
      // factor of nearly three to spare where the p99 comparison had none
      // (`findings/2026-09-29-batch-sweep-median-under-load.md`).
      const largest = measured.at(-1);
      assert.ok(largest);
      assert.ok(
        shipped.p50 < largest.p50,
        `the shipped batch size should write faster than ${String(largest.size)} rows: a median ` +
          `write of ${shipped.p50.toFixed(1)} ms against ${largest.p50.toFixed(1)} ms`,
      );
    });

    it('costs almost nothing extra to go through the wire format, the gate and channel resolution', async () => {
      const ingestor = new Ingestor({ db, logger: silent, config: SHIPPED });
      const ownership = new SensorOwnership();
      const service = new IngestionService({ db, logger: silent, ingestor, ownership });

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
      await service.acceptProbeResults(perfProbe, {
        type: 'results',
        batchId: 'warm',
        results: messages[0] ?? [],
      });

      // **Except for ownership, which starts empty** (`P-233`), as a restart or any move leaves
      // it. Every batch is offered before any lookup returns, so every one of them misses and
      // asks the database who owns its sensors: the restart case, where each probe's first batch
      // arrives at once, and the worst mix the gate sees.
      ownership.clear();
      assert.equal(ownership.cached, 0);

      const startedAt = process.hrtime.bigint();
      const replies = await Promise.all(
        messages.map((results, index) =>
          service.acceptProbeResults(perfProbe, {
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
      // The gate let everything through, and the lookups refilled the cache.
      assert.equal(stats.refusedUnknown + stats.refusedMoved + stats.refusedForeign, 0);
      assert.equal(stats.cachedOwners, sensorIds.length);

      const perMinute = (total / elapsedMs) * 60_000;
      process.stdout.write(
        `\n    measured, ${String(total)} readings through the full path:\n` +
          `      throughput ${Math.round(perMinute).toLocaleString('en-GB')} samples/minute\n` +
          `      channels   ${String(stats.channelsCreated)} created once, then ` +
          `${String(stats.cachedChannels)} resolved from cache with no query at all\n` +
          `      ownership  every one of ${String(messages.length)} batches offered to an empty ` +
          `cache, as a restart leaves it\n`,
      );

      assert.ok(
        perMinute >= TARGET_PER_MINUTE,
        `sustained ${Math.round(perMinute).toString()} samples/minute through the full path`,
      );
    });

    it('carries the state machine for a bounded, measured cost', async () => {
      // M-02 adds two statements per write: an UPDATE over `sensor_runtime` for every sensor in
      // the batch, and an INSERT into `sensor_state` only for the ones that actually moved. The
      // claim that this is affordable at the v1 target is measured here rather than asserted.
      const keys = ['rtt', 'loss', 'jitter'];
      const ticks = 100;
      const total = ticks * sensorIds.length * keys.length;

      const healthy = (from: number): CheckResult[][] =>
        Array.from({ length: ticks }, (_, tick) =>
          sensorIds.map((sensorId) => ({
            sensorId,
            at: new Date(from + tick * 60_000).toISOString(),
            outcome: 'ok' as const,
            message: '',
            durationMs: 2,
            channels: keys.map((key) => ({ key, value: tick + key.length })),
          })),
        );

      const build = (states: boolean): { service: IngestionService; ingestor: Ingestor } => {
        const ingestor = new Ingestor({ db, logger: silent, config: SHIPPED });
        return {
          ingestor,
          service: new IngestionService({
            db,
            logger: silent,
            ingestor,
            ownership: new SensorOwnership(),
            ...(states
              ? {
                  states: new SensorStateService({
                    db,
                    logger: silent,
                    pauses: new PauseRepository(),
                  }),
                }
              : {}),
          }),
        };
      };

      /**
       * Every batch offered at once, as a fleet of probes would.
       *
       * Valid here only because every result in this run succeeded: whichever order they land
       * in, the sensor is Up afterwards. Offering *one* probe's batches concurrently would not
       * be — the machine is a fold over time, and it correctly discards a result that arrives
       * behind a newer one. A probe never does that: the spool drain keeps one batch in flight.
       */
      const measure = async (
        label: string,
        from: number,
        states: boolean,
      ): Promise<{ label: string; perMinute: number; transitions: number; p99: number }> => {
        const { service, ingestor } = build(states);
        const messages = healthy(from);

        // Warm the caches — channels, runtimes and owners alike. Steady state is what is being
        // measured, not the first minute after a restart: the gate is a map lookup a result.
        await service.acceptProbeResults(perfProbe, {
          type: 'results',
          batchId: `warm-${label}`,
          results: messages[0] ?? [],
        });

        const startedAt = process.hrtime.bigint();
        await Promise.all(
          messages.map((results, index) =>
            service.acceptProbeResults(perfProbe, {
              type: 'results',
              batchId: `${label}-${String(index)}`,
              results,
            }),
          ),
        );
        await ingestor.stop();
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        return {
          label,
          perMinute: (total / elapsedMs) * 60_000,
          transitions: ingestor.stats().storedStateChanges,
          p99: ingestor.stats().writeMs.p99,
        };
      };

      const day = 86_400_000;
      const base = new Date('2026-07-10T00:00:00.000Z').getTime();
      const without = await measure('no states', base, false);
      const steady = await measure('steady', base + day, true);

      // What a flapping fleet costs, which is the other shape entirely: in steady state the
      // history insert never runs, and here it runs for every sensor on every scan. Offered one
      // batch at a time, because alternating outcomes *are* order-sensitive — so this measures
      // the cost of a batch rather than the throughput of a fleet, and is reported as such.
      const flapTicks = 20;
      const { service, ingestor } = build(true);
      const flapBase = base + 2 * day;
      const startedAt = process.hrtime.bigint();
      for (let tick = 0; tick < flapTicks; tick += 1) {
        await service.acceptProbeResults(perfProbe, {
          type: 'results',
          batchId: `flap-${String(tick)}`,
          results: sensorIds.map((sensorId) => ({
            sensorId,
            at: new Date(flapBase + tick * 60_000).toISOString(),
            outcome: tick % 2 === 1 ? ('error' as const) : ('ok' as const),
            message: tick % 2 === 1 ? 'simulated failure' : '',
            durationMs: 2,
            channels: tick % 2 === 1 ? [] : keys.map((key) => ({ key, value: tick + key.length })),
          })),
        });
      }
      await ingestor.stop();
      const flapMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const flapping = ingestor.stats();
      assert.ok(
        flapping.writeMs.p99 < P99_BUDGET_MS,
        `p99 write was ${flapping.writeMs.p99.toFixed(1)} ms while every sensor was flapping`,
      );

      process.stdout.write(
        `\n    measured, ${String(sensorIds.length)} sensors x ${String(ticks)} scans, ` +
          `${String(total)} readings:\n` +
          [without, steady]
            .map(
              (row) =>
                `      ${row.label.padEnd(10)} ` +
                `${Math.round(row.perMinute).toLocaleString('en-GB').padStart(11)} samples/min  ` +
                `p99 ${row.p99.toFixed(1).padStart(6)} ms  ` +
                `${String(row.transitions).padStart(5)} transitions written`,
            )
            .join('\n') +
          `\n      state machine costs ` +
          `${(100 - (steady.perMinute / without.perMinute) * 100).toFixed(1)}% of throughput\n` +
          `      flapping   every sensor changing state on every scan: p99 write ` +
          `${flapping.writeMs.p99.toFixed(1)} ms, ` +
          `${String(flapping.storedStateChanges)} transitions in ` +
          `${String(flapping.writes)} writes\n` +
          `                 (${(flapMs / flapTicks).toFixed(0)} ms per batch end to end, of ` +
          `which ${String(SHIPPED.batchMaxDelayMs)} ms is the flush timer — one probe offering ` +
          `one batch at a time never fills a write)\n`,
      );

      assert.equal(steady.transitions, sensorIds.length, 'one transition each, then nothing');
      assert.equal(
        flapping.storedStateChanges,
        sensorIds.length * (flapTicks - 1),
        'and a flapping fleet writes a row every time it moves — every scan, here',
      );
      // The criterion, with the machine in the path: adding states must not cost the phase's
      // exit number.
      assert.ok(
        steady.perMinute >= TARGET_PER_MINUTE,
        `sustained ${Math.round(steady.perMinute).toString()} samples/minute with the state machine`,
      );
      assert.ok(
        steady.p99 < P99_BUDGET_MS,
        `p99 write was ${steady.p99.toFixed(1)} ms with the state machine`,
      );
    });

    it('decides a v1 probe’s ownership inside a write’s budget: cold, warm and after a move', async () => {
      // `PLAN.md`'s v1 target is 5,000 sensors, and nothing stops them all sitting under one
      // probe. Shaped as a tree is — groups in groups, devices in those, a few sensors on each —
      // because a cold lookup walks every sensor's ancestry, and a flat tree would make that
      // walk look cheaper than it is. Built through `createTree`, the service's own path, so the
      // audit log a move is classified from is the one production writes.
      //
      // **The audit and the invalidator sit where they do in production**: the log written in
      // the mover's transaction, and the owner cache cleared in the same call, then again once
      // the move has settled. A test that cleared the cache by hand would prove nothing about
      // whether a move clears it, and the history walk reads the table this writes.
      const ownership = new SensorOwnership();
      const invalidator = new ResultCacheInvalidator({
        channels: new ChannelResolver({ logger: silent }),
        owners: ownership,
        logger: silent,
      });
      harness.audit.also = new CompositeAuditSink([new DatabaseAuditSink(), invalidator]);

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Gate probe',
      });
      const elsewhere = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Gate probe, the other one',
      });
      const branches: { group: number; sensors: number[] }[] = [];
      for (let branch = 0; branch < 10; branch += 1) {
        const at = String(branch);
        const nodes: TreeNodeInput[] = [{ kind: 'group', name: `branch-${at}`, ref: 'top' }];
        for (let group = 0; group < 10; group += 1) {
          const g = `${at}-${String(group)}`;
          nodes.push({ kind: 'group', name: `group-${g}`, parentRef: 'top', ref: `g${g}` });
          for (let device = 0; device < 10; device += 1) {
            const d = `${g}-${String(device)}`;
            nodes.push({
              kind: 'device',
              name: `device-${d}`,
              host: `10.${at}.${String(group)}.${String(device + 1)}`,
              parentRef: `g${g}`,
              ref: `d${d}`,
            });
            for (let sensor = 0; sensor < 5; sensor += 1) {
              nodes.push({
                kind: 'sensor',
                name: `ping-${d}-${String(sensor)}`,
                sensorType: 'icmp.ping',
                parentRef: `d${d}`,
              });
            }
          }
        }
        const made = await harness.service.createTree(testActor, { parentId: probe.id, nodes });
        const top = made.objects.find((one) => one.ref === 'top');
        assert.ok(top !== undefined);
        branches.push({
          group: top.id,
          sensors: made.objects.filter((one) => one.kind === 'sensor').map((one) => one.id),
        });
      }
      const sensors = branches.flatMap((branch) => branch.sensors);
      assert.equal(sensors.length, 5_000);

      /**
       * The probe's spool draining its sensors: one batch at a time, `PROBE_BATCH` results each,
       * which is how a probe offers them. Each batch's gate is timed on its own, because a batch
       * is what waits for it.
       */
      const drain = async (
        ownership: SensorOwnership,
      ): Promise<{ ms: number[]; admitted: number; moved: number; otherwise: number }> => {
        const ms: number[] = [];
        let admitted = 0;
        let moved = 0;
        let otherwise = 0;
        for (let offset = 0; offset < sensors.length; offset += PROBE_BATCH) {
          const results: CheckResult[] = sensors
            .slice(offset, offset + PROBE_BATCH)
            .map((sensorId) => ({
              sensorId,
              at: new Date('2026-07-20T00:00:00.000Z').toISOString(),
              outcome: 'ok' as const,
              message: '',
              durationMs: 2,
              channels: [{ key: 'rtt', value: 1 }],
            }));
          const startedAt = process.hrtime.bigint();
          const out = await ownership.admit(db, probe.id, results);
          ms.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
          admitted += out.results.length;
          moved += out.refused.moved.length;
          otherwise += out.refused.foreign.length + out.refused.unknown.length;
        }
        return { ms, admitted, moved, otherwise };
      };

      // A restart: nothing cached, so every batch of the probe's first pass asks the database.
      const cold = await drain(ownership);
      assert.equal(cold.admitted, 5_000, 'every sensor is the probe’s own');
      assert.equal(ownership.cached, 5_000);

      // The steady state: a map lookup a result, and no query at all.
      const warm = await drain(ownership);
      assert.equal(warm.admitted, 5_000);

      // A branch of 500 sensors moved to another probe, while this one's spool still holds their
      // results. The invalidator clears every owner on a move, so the whole pass misses again,
      // and the moved sensors' batch also walks the audit log to tell a move from a probe
      // reporting what it was never given. Nothing here clears the cache: if the move did not,
      // the moved branch would come back as this probe's, and the count below would say so.
      const branch = branches[0];
      assert.ok(branch !== undefined);
      await harness.service.move(testActor, branch.group, elsewhere.id, { kind: 'none' });
      const afterMove = await drain(ownership);
      invalidator.stop();
      harness.audit.also = undefined;
      assert.equal(afterMove.moved, branch.sensors.length, 'the moved branch is refused as moved');
      assert.equal(afterMove.otherwise, 0, 'and none of it reads as foreign');
      assert.equal(afterMove.admitted, 5_000 - branch.sensors.length);

      const summary = (label: string, ms: number[]): string => {
        const sorted = [...ms].sort((a, b) => a - b);
        const total = ms.reduce((sum, one) => sum + one, 0);
        return (
          `      ${label.padEnd(11)} ${String(ms.length)} batches of ${String(PROBE_BATCH)}: ` +
          `median ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2).padStart(6)} ms  ` +
          `worst ${(sorted.at(-1) ?? 0).toFixed(2).padStart(6)} ms  ` +
          `pass ${total.toFixed(1).padStart(6)} ms`
        );
      };
      process.stdout.write(
        `\n    measured, the ownership gate on one probe's 5,000 sensors, ` +
          `four levels below the probe, ${String(Math.ceil(sensors.length / PROBE_BATCH))} ` +
          `batches a pass:\n` +
          [
            summary('restart', cold.ms),
            summary('steady', warm.ms),
            summary('after move', afterMove.ms),
          ].join('\n') +
          `\n      (the first batch after the move, which starts with the ` +
          `${String(branch.sensors.length)} moved sensors and walks the audit log for them: ` +
          `${(afterMove.ms[0] ?? 0).toFixed(2)} ms)\n`,
      );

      // **A cold batch costs at most one write's budget**: a restart or a move adds, to each
      // batch of the pass after it, no more than Phase 1's criterion allows the write itself.
      // Every batch rather than a percentile: a pass is ten batches, which have no p99, and the
      // worst of them is what the probe waits for.
      for (const [label, ms] of [
        ['after a restart', cold.ms],
        ['after a move', afterMove.ms],
      ] as const) {
        const worst = Math.max(...ms);
        assert.ok(
          worst < P99_BUDGET_MS,
          `a batch's gate took ${worst.toFixed(1)} ms ${label}, budget ${String(P99_BUDGET_MS)} ms`,
        );
      }
      // **And a warm one costs next to nothing**: a twentieth of that budget, for a map lookup a
      // result, so the steady state the throughput budgets measure is not paying for the gate.
      const warmWorst = Math.max(...warm.ms);
      assert.ok(
        warmWorst < P99_BUDGET_MS / 20,
        `a warm batch's gate took ${warmWorst.toFixed(2)} ms, ` +
          `budget ${String(P99_BUDGET_MS / 20)} ms`,
      );
    });
  },
);

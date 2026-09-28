import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { coreConfigSchema, loadConfig, type CheckResult, type CoreConfig } from '@ms/shared';
import type { Database } from '../../src/db/pool.js';
import { Ingestor } from '../../src/ingestion/ingestor.js';
import { ReplayPacer } from '../../src/ingestion/replay-pacer.js';
import { IngestionService } from '../../src/ingestion/service.js';
import type { ProbeOrigin } from '../../src/transport/probe-endpoint.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A reconnecting probe must not stall everybody else's ingestion (`R-08`, the core's half).
 *
 * `R-08`'s criterion has two clauses and they fail in different places. **Zero data loss** is the
 * probe's spool and is measured in `@ms/probe`'s own soak. **No ingestion stall** is this: while
 * one probe empties an hour of backlog as fast as the core will take it, a probe reporting a
 * check that ran a second ago has to keep getting through at ordinary latency.
 *
 * **The failure being measured is fairness, not capacity.** The ingestion queue already has a
 * global back-pressure signal, and it is the wrong instrument here — it rises with queue depth
 * and asks *every* probe to slow down, so a probe reporting one live batch is throttled exactly
 * as hard as one dumping a spool, and by the time it rises the backlog has already been built.
 * `R-03`'s pacer adds delay to catch-up acknowledgements only. What is checked here is the
 * consequence an operator would notice: during a large replay, live readings are still stored
 * promptly and the replaying probe is the one asked to wait.
 *
 * The comparison is against the same live traffic with no replay running at all, measured in the
 * same run. An absolute threshold would measure the machine; the ratio measures the pacer.
 *
 * The in-suite run replays 5% of an hour so it can live in the ordinary suite.
 * `MS_SOAK_FRACTION=1` runs the criterion in full; the committed measurement was taken that way:
 *
 * ```
 * measured, two probes each replaying 300,000 readings (100% of an hour at the v1 target)
 * while another reports live:
 *   live, quiet     p50  263.7 ms   p99  274.6 ms    40 batches
 *   live, replaying p50  263.6 ms   p99  279.2 ms   300 batches   -> 1.02x, budget 3x
 *   replay          p50   24.5 ms   p99   48.5 ms   600 batches, cleared in 96.1 s
 *   pacing          the replaying probes were asked to wait up to 50 ms; the live one 0 ms
 * ```
 *
 * Live p99 moved by 2% while 600,000 spooled readings went past it. The ~263 ms floor on every
 * live figure is the ingestion flush timer, not the database — one probe offering one batch at a
 * time never fills a write, so each waits out `batchMaxDelayMs`. It is identical in both arms,
 * which is what makes the ratio the measurement.
 *
 * **`MS_SOAK_FRACTION=1` loads the machine for a minute and a half**, which is long enough to
 * disturb the latency percentiles of whichever benchmark runs next to it. Run it on its own when
 * the number matters.
 *
 * **Every batch arrives the way a probe's does** (`P-233`): through `acceptProbeResults` and
 * `P-228`'s ownership gate, from the probe object its sensors are under. Each probe's first batch
 * finds the gate's cache empty, as it would after a restart. The measurement above was taken
 * before the gate existed, on `acceptResults`: `P-233` ran this at the default fraction, and
 * re-taking the full hour through the gate belongs to the next full `test:perf`.
 */

/** `PLAN.md`'s v1 target: 5,000 sensors on a 60-second interval is 300,000 readings an hour. */
const HOUR_OF_BACKLOG = 300_000;
const SOAK_FRACTION = Number(process.env['MS_SOAK_FRACTION'] ?? '0.05');
const BACKLOG_RESULTS = Math.round(HOUR_OF_BACKLOG * SOAK_FRACTION);

/** What a probe offering a live batch looks like: one scan's worth, no backlog behind it. */
const LIVE_BATCH = 100;
const LIVE_BATCHES = 40;

/**
 * **Live latency must not degrade by more than this while a replay runs.** Some degradation is
 * honest — the database is doing more work — and the pacer's job is to keep it bounded rather
 * than to make it zero. Three times is the line between "slower" and "stalled".
 */
const MAX_DEGRADATION = 3;

const SHIPPED = loadConfig<CoreConfig>({ schema: coreConfigSchema, env: {}, argv: [] }).config
  .ingestion;

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
};

describe(
  'replay under load',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let service: IngestionService;
    let pacer: ReplayPacer;
    const replaySensors: number[] = [];
    const secondReplaySensors: number[] = [];
    const liveSensors: number[] = [];
    /** Each source's probe object: the one its sensors are under, so the gate admits them. */
    const probeOf = new Map<string, number>();

    before(async () => {
      scratch = await createScratchDatabase('replaysoak');
      db = scratch.db;
      const harness = await buildHarness(db);

      // **Three probes, and the count is the experiment.** Two of them replay against a limit of
      // one, because the pacer deliberately does *not* slow a lone catch-up — one probe emptying
      // its spool is not a fairness problem, it is just work. The delay starts when more probes
      // are catching up than the core will let run at full speed, so a two-probe test measures
      // the mechanism and a one-probe test measures its absence.
      for (const [name, into, source] of [
        ['Replaying probe', replaySensors, 'replaying-probe'],
        ['Second replaying probe', secondReplaySensors, 'second-replaying-probe'],
        ['Live probe', liveSensors, 'live-probe'],
      ] as const) {
        const probe = await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name,
        });
        probeOf.set(source, probe.id);
        const device = await harness.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: `${name} device`,
          host: '192.0.2.40',
        });
        for (let index = 0; index < 100; index += 1) {
          const sensor = await harness.service.create(testActor, {
            kind: 'sensor',
            parentId: device.id,
            name: `${name}-${String(index)}`,
            sensorType: 'icmp.ping',
          });
          into.push(sensor.id);
        }
      }

      // The first replaying probe again, under a name the pacer has not seen: how the last case
      // gets a probe with a fresh catch-up history without building another tree.
      probeOf.set('recovered-probe', probeOf.get('replaying-probe') ?? 0);

      pacer = new ReplayPacer({
        logger: silent,
        config: { maxConcurrentProbes: 1, stepMs: 50, maxDelayMs: 2_000, idleAfterMs: 30_000 },
      });
      const ingestor = new Ingestor({ db, logger: silent, config: SHIPPED });
      service = new IngestionService({ db, logger: silent, ingestor, pacer });
    });

    after(async () => {
      await scratch.drop();
    });

    const batch = (sensors: number[], sequence: number, size: number): CheckResult[] => {
      const results: CheckResult[] = [];
      for (let index = 0; index < size; index += 1) {
        const sensorId = sensors[(sequence * size + index) % sensors.length] ?? 0;
        results.push({
          sensorId,
          // Distinct times per sequence: the unique index on (channel_id, time) makes a repeat
          // a no-op, which would quietly turn this into a measurement of doing nothing.
          at: new Date(1_700_000_000_000 + (sequence * size + index) * 1_000).toISOString(),
          outcome: 'ok',
          message: '4/4 replies',
          durationMs: 12,
          channels: [{ key: 'rtt', value: 12.4 }],
        });
      }
      return results;
    };

    /** Offers one batch and reports how long the core took to store it. */
    const offer = async (
      source: string,
      results: CheckResult[],
      backlog: number,
      batchId: number,
    ): Promise<{ ms: number; retryAfterMs: number }> => {
      const started = process.hrtime.bigint();
      const origin: ProbeOrigin = { gid: source, probeObjectId: probeOf.get(source) ?? null };
      const reply = await service.acceptProbeResults(origin, {
        type: 'results',
        batchId: String(batchId),
        backlog,
        results,
      });
      return {
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        retryAfterMs: reply.type === 'results-ack' ? reply.retryAfterMs : -1,
      };
    };

    it('keeps storing live readings promptly while a probe empties an hour of backlog', async () => {
      // --- the control: live traffic with nothing else happening -------------------------
      const quiet: number[] = [];
      for (let index = 0; index < LIVE_BATCHES; index += 1) {
        const { ms } = await offer('live-probe', batch(liveSensors, index, LIVE_BATCH), 0, index);
        quiet.push(ms);
      }

      // --- the same live traffic, with a replay running against it -----------------------
      // Interleaved rather than run first: a replay that has already finished cannot interfere,
      // and "during" is the whole claim.
      const during: number[] = [];
      const replayLatencies: number[] = [];
      const pacedDelays: number[] = [];
      const livePacing: number[] = [];
      // Sampled during the replay, not after it: a probe drops out of the replaying set the
      // moment it reports no backlog, so by the last batch the count is correctly zero. Reading
      // it at the end would measure the recovery rather than the contention.
      let peakReplaying = 0;
      let replayed = 0;
      let liveSequence = LIVE_BATCHES;

      const started = process.hrtime.bigint();
      while (replayed < BACKLOG_RESULTS) {
        const size = Math.min(SHIPPED.batchMaxRows, BACKLOG_RESULTS - replayed);
        const remaining = BACKLOG_RESULTS - replayed - size;
        const sequence = replayed / SHIPPED.batchMaxRows;

        for (const [source, sensors] of [
          ['replaying-probe', replaySensors],
          ['second-replaying-probe', secondReplaySensors],
        ] as const) {
          const replay = await offer(
            source,
            batch(sensors, sequence, size),
            // The backlog behind this batch is what marks it as catch-up. A probe that reported
            // zero here would be treated as live and never paced — which is exactly the signal
            // R-03 depends on.
            remaining,
            replayed,
          );
          replayLatencies.push(replay.ms);
          pacedDelays.push(replay.retryAfterMs);
        }
        replayed += size;
        peakReplaying = Math.max(peakReplaying, pacer.stats().replaying);

        // A live probe reporting a scan that just ran, in among the replay.
        const live = await offer(
          'live-probe',
          batch(liveSensors, liveSequence, LIVE_BATCH),
          0,
          liveSequence,
        );
        during.push(live.ms);
        livePacing.push(live.retryAfterMs);
        liveSequence += 1;
      }
      const totalMs = Number(process.hrtime.bigint() - started) / 1e6;

      const quietP99 = percentile(quiet, 0.99);
      const duringP99 = percentile(during, 0.99);
      const degradation = duringP99 / quietP99;
      const maxPaced = Math.max(...pacedDelays);
      const livePaced = Math.max(...livePacing);

      process.stdout.write(
        `\n    measured, two probes each replaying ${BACKLOG_RESULTS.toLocaleString('en-GB')} readings ` +
          `(${(SOAK_FRACTION * 100).toFixed(0)}% of an hour at the v1 target, ` +
          `set MS_SOAK_FRACTION=1 for all of it) while another reports live:\n` +
          `      live, quiet     p50 ${percentile(quiet, 0.5).toFixed(1).padStart(6)} ms   ` +
          `p99 ${quietP99.toFixed(1).padStart(6)} ms   ${String(quiet.length)} batches\n` +
          `      live, replaying p50 ${percentile(during, 0.5).toFixed(1).padStart(6)} ms   ` +
          `p99 ${duringP99.toFixed(1).padStart(6)} ms   ${String(during.length)} batches   ` +
          `-> ${degradation.toFixed(2)}x, budget ${String(MAX_DEGRADATION)}x\n` +
          `      replay          p50 ${percentile(replayLatencies, 0.5).toFixed(1).padStart(6)} ms   ` +
          `p99 ${percentile(replayLatencies, 0.99).toFixed(1).padStart(6)} ms   ` +
          `${String(replayLatencies.length)} batches, cleared in ${(totalMs / 1000).toFixed(1)} s\n` +
          `      pacing          the replaying probe was asked to wait up to ${String(maxPaced)} ms; ` +
          `the live one ${String(livePaced)} ms\n`,
      );

      // Every batch was its probe's own. A source mapped to the wrong probe would be refused,
      // acknowledged at once and stored nowhere, which would read as a very fast replay.
      const ingested = service.stats();
      assert.equal(ingested.refusedUnknown + ingested.refusedMoved + ingested.refusedForeign, 0);

      // --- the criterion ----------------------------------------------------------------
      assert.ok(
        degradation < MAX_DEGRADATION,
        `live p99 went from ${quietP99.toFixed(1)} ms to ${duringP99.toFixed(1)} ms during a ` +
          `replay (${degradation.toFixed(2)}x), which is a stall rather than a slowdown`,
      );

      // **The replaying probe is the one asked to wait, and the live one never is.** That
      // asymmetry is the entire mechanism; without it the pacer is just another global throttle.
      assert.ok(
        maxPaced > 0,
        'with more probes catching up than the core allows, they should have been paced',
      );
      assert.equal(
        livePaced,
        0,
        'a probe reporting a fresh scan must never carry catch-up pacing, however busy the replay',
      );

      const stats = pacer.stats();
      assert.ok(stats.paced > 0, 'the pacer should have added delay to catch-up batches');
      assert.equal(peakReplaying, 2, 'both replaying probes should have been counted at the peak');
      // And the other end of the same mechanism: once they report no backlog they are no longer
      // catching up, so nothing is left being paced for an outage that is over.
      assert.equal(
        stats.replaying,
        0,
        'a probe that has emptied its backlog must stop counting as catching up',
      );
    });

    it('lets one probe catch up at full speed, because one is not a fairness problem', () => {
      // **The property the first draft of this test got wrong.** A single probe emptying its
      // spool is not competing with anyone — it is just work, and slowing it down only makes the
      // outage last longer for the sensors it carries. The delay exists for the case where
      // several probes come back at once and would otherwise share the core's capacity by
      // accident. Pacing a lone catch-up would look like caution and would cost recovery time
      // for nothing.
      const alone = new ReplayPacer({
        logger: silent,
        config: { maxConcurrentProbes: 1, stepMs: 50, maxDelayMs: 2_000, idleAfterMs: 30_000 },
      });
      assert.equal(alone.pace('only-probe', 10_000), 0, 'one probe catching up is not paced');
      assert.equal(alone.pace('only-probe', 5_000), 0, 'and still is not, batch after batch');
      assert.equal(alone.stats().paced, 0);

      // A second one arriving is what starts it, and the first one feels it too — the delay is
      // about how many are sharing the core, not about which of them was late.
      assert.ok(alone.pace('second-probe', 10_000) > 0, 'a second catch-up starts the pacing');
      assert.ok(alone.pace('only-probe', 4_000) > 0, 'and applies to the one already running');

      // And it stops the moment the crowd thins, without a timer or a sweep.
      assert.equal(alone.pace('second-probe', 0), 0, 'the one that finished is released at once');
      assert.equal(alone.pace('only-probe', 3_000), 0, 'and the survivor goes back to full speed');
    });

    it('lets a probe that has caught up rejoin the fast path on its very next batch', async () => {
      // Not on a timer, and not at the next sweep: a probe that reports no backlog is live from
      // that moment. Anything slower would keep punishing a probe for an outage it has already
      // recovered from — and the recovery is exactly when its readings matter most.
      const caughtUp = await offer('recovered-probe', batch(replaySensors, 9_000, 10), 5_000, 1);
      assert.ok(caughtUp.retryAfterMs >= 0);

      const nowLive = await offer('recovered-probe', batch(replaySensors, 9_001, 10), 0, 2);
      assert.equal(
        nowLive.retryAfterMs,
        0,
        'a batch with no backlog behind it must not carry catch-up pacing',
      );
    });
  },
);

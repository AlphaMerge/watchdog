import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  memoryReserveBytes,
  PROTOCOL_VERSION,
  type CheckResult,
  type IngestionConfig,
  type ProbeHealthReport,
} from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { loadLookups } from '../src/lookups/loader.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { SensorStateService } from '../src/state/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { everyVoucherHolds } from './support/vouching.js';

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

const MIB = 1024 * 1024;
/** The stock unit's `MemoryMax=6G`, and the machine of a probe with no ceiling. */
const TOTAL_MIB = 6_144;
/** The probe's main thread, spool and the rest that is not workers. */
const BASE_MIB = 300;
/** `WORKER_RESIDENT_MIB`, what the cap charges a worker. */
const WORKER_MIB = 40;
/** The pool ceiling 5,000 checks hanging to their timeout derive (`P-216b`). */
const CEILING = 256;

/**
 * Where the cap leaves a saturated pool: it grows while a worker's worth is spare above the
 * reserve, so it stops with less than that spare — the real arithmetic, not a copy of it.
 */
const reserveMiB = memoryReserveBytes(TOTAL_MIB * MIB) / MIB;
const SETTLED = Math.floor((TOTAL_MIB - reserveMiB - BASE_MIB) / WORKER_MIB);
const USED_MIB = BASE_MIB + SETTLED * WORKER_MIB;
const USED_PERCENT = Math.round((USED_MIB / TOTAL_MIB) * 1_000) / 10;

const CALM: ProbeHealthReport = {
  scheduled: 5_000,
  schedulerLagMs: { p50: 1, p95: 5, p99: 9, max: 20 },
  skippedTicks: 0,
  clockJumps: 0,
  poolSize: 8,
  poolBusy: 1,
  queued: 0,
  queueWaitMs: { p50: 0, p95: 1, p99: 2, max: 5 },
  deferred: 0,
  refused: 0,
  discarded: 0,
  poolState: 0,
  timedOut: 0,
  workerCrashes: 0,
  cpuPercent: 4,
  memoryMb: 620,
  uptimeSeconds: 3_600,
  poolCeiling: 16,
  poolMemoryCap: 120,
  poolHeldBack: 0,
};

/** Every worker the cap allows busy, the ceiling far above it, and checks refused. */
const SATURATED: ProbeHealthReport = {
  ...CALM,
  poolSize: SETTLED,
  poolBusy: SETTLED,
  queued: 1_000,
  refused: 6_000,
  memoryMb: USED_MIB,
  poolCeiling: CEILING,
  poolMemoryCap: SETTLED,
  poolHeldBack: CEILING - SETTLED,
};

/**
 * The saturation over — the targets answer again — and the pool not yet shrunk: every worker the
 * cap allowed is still held, idle, with the memory it takes. This is where a standing warning
 * would be, and what `P-216c` read as 89.9% in its baseline.
 */
const AFTER: ProbeHealthReport = {
  ...SATURATED,
  poolBusy: 2,
  queued: 0,
  refused: 0,
  poolCeiling: 16,
  poolHeldBack: 0,
};

/** On a ceiling: the cgroup's `memory.max` (`P-210`). The machine is someone else's. */
function onCeiling(report: ProbeHealthReport): ProbeHealthReport {
  return {
    ...report,
    memoryLimitMb: TOTAL_MIB,
    memoryLimitUsagePercent: report === CALM ? 10 : USED_PERCENT,
    memoryAvailablePercent: 60,
    memoryAvailableMb: 36_000,
  };
}

/** With no ceiling the cap measures the machine (`P-208`), and so does `memoryAvailable`. */
function onMachine(report: ProbeHealthReport): ProbeHealthReport {
  const usedMiB = report === CALM ? 620 : USED_MIB;
  return {
    ...report,
    memoryAvailablePercent: Math.round(((TOTAL_MIB - usedMiB) / TOTAL_MIB) * 1_000) / 10,
    memoryAvailableMb: TOTAL_MIB - usedMiB,
  };
}

/**
 * `P-244`: one saturation of a memory-capped probe is one alarm, and it ends with the saturation.
 *
 * `P-236`'s cap stops the pool where memory holds no more workers, so a saturated probe sits at
 * whatever the reserve leaves. At a tenth that was about 90% of its limit, over `memoryLimitUsage`'s
 * 80% warning, and the workers stay until the pool shrinks, so the warning outlived the episode —
 * for days on a probe whose targets stay down — and it was true: from 90% the surge that warning
 * is set for no longer fits. `poolUsage` is already Down for the saturation itself, so this asks
 * that nothing else is: Down while saturated, Up once it is not, whichever memory the cap reads.
 *
 * Asserted as states, as `M-17` does: a trigger fires once per transition, so every transition
 * into Warning or Down is an alarm.
 */
describe(
  'a saturated, memory-capped probe raises one alarm per saturation (P-244)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    const probes = new Map<number, (report: ProbeHealthReport) => ProbeHealthReport>();
    const healthIds = new Map<string, number>();
    // Just behind the wall clock: ingestion refuses a result stamped ahead of it (`P-146`).
    let now = new Date(Date.now() - 10 * 60_000);

    before(async () => {
      scratch = await createScratchDatabase('saturatedcap');
      db = scratch.db;
      harness = await buildHarness(db);
      for (const [name, shape] of [
        ['on a ceiling', onCeiling],
        ['on the machine', onMachine],
      ] as const) {
        const probe = await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name,
        });
        probes.set(probe.id, shape);
        const box = await harness.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: `${name} box`,
          host: '192.0.2.60',
        });
        const health = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: box.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          params: {},
        });
        healthIds.set(name, health.id);
      }
    });

    after(async () => {
      await scratch.drop();
    });

    const link = (health: ProbeHealthReport, at: Date): ProbeLink => ({
      connected: true,
      gid: 'probe-gid',
      clockOffsetMs: null,
      protocolVersion: PROTOCOL_VERSION,
      connectedAt: new Date(at.getTime() - 3_600_000),
      lastHeartbeatAt: at,
      approved: true,
      agentVersion: '1.0.0',
      assignedSensors: 5_000,
      cadenceSeconds: 60,
      connectedForMs: Number.MAX_SAFE_INTEGER,
      sinceResultsMs: 0,
      sinceConfigMs: 0,
      configured: true,
      configurable: true,
      lastResultsAt: at,
      configSentAt: at,
      health,
    });

    /** Probe Health's sweep, the way `main.ts` runs it, through ingestion and the state machine. */
    async function sweep(report: ProbeHealthReport): Promise<void> {
      const lookups = await loadLookups({ logger: silent });
      const states = new SensorStateService({
        db,
        logger: silent,
        settings: harness.resolver,
        pauses: new PauseRepository(),
      });
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const ingestion = new IngestionService({
        db,
        logger: silent,
        ingestor,
        states,
        resolver: new ChannelResolver({ logger: silent, lookups }),
      });
      let batch = 0;
      const ingest = async (results: readonly CheckResult[]): Promise<void> => {
        batch += 1;
        await ingestion.acceptResults('health', {
          type: 'results',
          batchId: `health-${now.toISOString()}-${String(batch)}`,
          results: [...results],
        });
      };
      const at = now;
      await new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: (probeObjectId) => link((probes.get(probeObjectId) ?? onCeiling)(report), at),
        },
        ingest,
        now: () => at,
      }).sweep();
      await ingestor.stop();
      now = new Date(now.getTime() + 30_000);
    }

    /** Every state the sensor has been in, in order, with repeats folded. */
    async function history(sensorId: number): Promise<{ state: string; message: string }[]> {
      const rows = await db.query<{ state: string; message: string }>(
        `SELECT state::text AS state, message FROM sensor_state WHERE sensor_id = $1 ORDER BY time`,
        [sensorId],
      );
      return rows.filter((row, i) => i === 0 || rows[i - 1]?.state !== row.state);
    }

    it('settles the pool under the memory warnings, from the real reserve', () => {
      // The premise, checked where it is cheap: if this fails the scenario below proves nothing.
      assert.ok(SETTLED > 100 && SETTLED < CEILING, `${String(SETTLED)} workers`);
      assert.ok(USED_PERCENT <= 80, `${String(USED_PERCENT)}% of the ceiling`);
    });

    it('is Down for each saturation and Up between them, on either memory', async () => {
      for (const report of [CALM, SATURATED, SATURATED, AFTER, AFTER, AFTER, SATURATED, AFTER]) {
        await sweep(report);
      }
      for (const [name, sensorId] of healthIds) {
        const seen = await history(sensorId);
        assert.deepEqual(
          seen.map((row) => row.state),
          ['up', 'down', 'up', 'down', 'up'],
          `${name}: ${JSON.stringify(seen)}`,
        );
        for (const row of seen.filter((r) => r.state === 'down')) {
          // Down for the pool, and for nothing about memory.
          assert.match(row.message, /pool/iu, `${name}: ${row.message}`);
          assert.doesNotMatch(row.message, /memory/iu, `${name}: ${row.message}`);
        }
      }
    });
  },
);

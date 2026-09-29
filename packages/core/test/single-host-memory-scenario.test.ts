import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  PROTOCOL_VERSION,
  type CheckResult,
  type IngestionConfig,
  type ProbeHealthReport,
} from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { CoreHealthService, type CoreHealthSources } from '../src/health/core-health.js';
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

/** A probe with nothing wrong with it but what a test says. */
const CALM: ProbeHealthReport = {
  scheduled: 120,
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
  memoryMb: 300,
  uptimeSeconds: 3_600,
  memoryLimitUsagePercent: 30,
  memoryLimitMb: 6_144,
  poolCeiling: 64,
  poolMemoryCap: 120,
  poolHeldBack: 0,
};

/** The machine, as `/proc/meminfo` says it: 8% available, under both types' error limit of 10. */
const SQUEEZED = { availablePercent: 8, availableBytes: 650 * MIB, totalBytes: 8_192 * MIB };

/**
 * `M-21`: one memory squeeze on a single-host install is one alarm.
 *
 * The default installation runs a local probe beside the core, and both read the same
 * `/proc/meminfo`. Core Health and Probe Health declare `memoryAvailable` with the same limits, so
 * before this a host at 8% sent both sensors Down in the same sweep: two alarms for one
 * condition, which `CLAUDE.md` forbids. Core Health now owns the machine where both could report
 * it, and the local probe's pair gaps. This goes the whole way — the sweeps, ingestion, the
 * declared limits, the state machine — because each is a place a second alarm could come from.
 *
 * Asserted as sensors Down, as `M-17` does: a notification is one per transition to Down through
 * whatever trigger an operator set, so two sensors Down is two alarms and one is one.
 */
describe(
  'one memory squeeze on a single-host install (M-21)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let localProbeId = 0;
    let remoteProbeId = 0;
    let coreHealthId = 0;
    let localHealthId = 0;
    let remoteHealthId = 0;
    // Just behind the wall clock: ingestion refuses a result stamped ahead of it (`P-146`).
    let now = new Date(Date.now() - 10 * 60_000);

    before(async () => {
      scratch = await createScratchDatabase('singlehostmem');
      db = scratch.db;
      harness = await buildHarness(db);

      // The core's own host: the local probe, and a device for the core's sensors under it.
      const local = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Local probe',
      });
      localProbeId = local.id;
      await db.query(
        `INSERT INTO probe_config (object_id, gid, is_local) VALUES ($1, 'local-gid', true)
         ON CONFLICT (object_id) DO UPDATE SET is_local = true`,
        [localProbeId],
      );
      const coreBox = await harness.service.create(testActor, {
        kind: 'device',
        parentId: localProbeId,
        name: 'core-box',
        host: '127.0.0.1',
      });
      coreHealthId = (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: coreBox.id,
          name: 'Core Health',
          sensorType: 'ms.core.health',
        })
      ).id;
      localHealthId = (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: coreBox.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          params: {},
        })
      ).id;

      // A remote probe, on a machine of its own.
      const remote = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Remote probe',
      });
      remoteProbeId = remote.id;
      const remoteBox = await harness.service.create(testActor, {
        kind: 'device',
        parentId: remoteProbeId,
        name: 'remote-box',
        host: '192.0.2.50',
      });
      remoteHealthId = (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: remoteBox.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          params: {},
        })
      ).id;
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
      assignedSensors: 120,
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

    const coreSources = (machine: typeof SQUEEZED): CoreHealthSources => ({
      disk: () => null,
      evictedChunks: () => 0,
      machineMemory: () => machine,
      limitMemory: () => null,
      ingestion: () => ({
        queuedRows: 0,
        refusedRows: 0,
        dependencyPauses: 0,
        deferredReactions: 0,
        writeMs: { p95: 1 },
      }),
      stream: () => ({
        overflowed: 0,
        severed: 0,
        signedOut: { ended: 0, expired: 0, revoked: 0, disabled: 0 },
        credentialCheckFailures: 0,
      }),
      probes: () => ({ probesDown: 0, probesSilent: 0 }),
      alarms: () => ({ fired: 0, nextWakeAt: null }),
      queries: () => ({ refused: 0 }),
      ingestionDiscards: () => ({ discardedFutureTime: 0, discardedPastTime: 0 }),
      credentialsToReenter: () => Promise.resolve(0),
      delivery: () => Promise.resolve({ pending: 0, failed: 0, oldestPendingAgeMs: 0 }),
    });

    /** Both services' sweeps, the way `main.ts` runs them, into one ingestion path. */
    async function sweep(health: {
      machine: typeof SQUEEZED;
      local: ProbeHealthReport;
      remote: ProbeHealthReport;
    }): Promise<Map<number, { state: string; message: string }>> {
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
      await new CoreHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: coreSources(health.machine),
        ingest,
        now: () => at,
      }).sweep();
      await new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link: (probeObjectId) =>
            link(probeObjectId === localProbeId ? health.local : health.remote, at),
        },
        ingest,
        now: () => at,
      }).sweep();
      await ingestor.stop();
      now = new Date(now.getTime() + 30_000);
      const rows = await db.query<{ object_id: string; state: string; message: string }>(
        'SELECT object_id::text AS object_id, state, message FROM sensor_runtime',
      );
      return new Map(rows.map((row) => [Number(row.object_id), row]));
    }

    const downOnTheCoreHost = (states: Map<number, { state: string }>): number =>
      [coreHealthId, localHealthId].filter((id) => states.get(id)?.state === 'down').length;

    it('is one sensor Down, and it is Core Health', async () => {
      const states = await sweep({
        machine: SQUEEZED,
        local: { ...CALM, memoryAvailablePercent: 8, memoryAvailableMb: 650 },
        remote: { ...CALM, memoryAvailablePercent: 60, memoryAvailableMb: 4_900 },
      });
      assert.equal(states.get(coreHealthId)?.state, 'down', 'the machine is nearly out');
      assert.equal(states.get(localHealthId)?.state, 'up', states.get(localHealthId)?.message);
      assert.equal(downOnTheCoreHost(states), 1, 'one squeeze, one alarm');
      // The local probe still says it, in words, without a second alarm.
      assert.match(
        states.get(localHealthId)?.message ?? '',
        /its machine has 8% memory available, which Core Health reports/u,
      );
      assert.equal(states.get(remoteHealthId)?.state, 'up', 'a machine that is not squeezed');
    });

    it('still warns on the local probe’s own limit, which is not the machine’s', async () => {
      // The probe's cgroup is its own: Core Health cannot see it, and `P-236` depends on it
      // being seen. The machine's squeeze stays one alarm; the probe nearing its own ceiling is
      // a second condition and says so.
      const states = await sweep({
        machine: SQUEEZED,
        local: {
          ...CALM,
          memoryAvailablePercent: 8,
          memoryAvailableMb: 650,
          memoryLimitUsagePercent: 85,
          poolMemoryCap: 40,
          poolCeiling: 40,
          poolHeldBack: 24,
        },
        remote: CALM,
      });
      assert.equal(states.get(coreHealthId)?.state, 'down');
      assert.equal(states.get(localHealthId)?.state, 'warning', states.get(localHealthId)?.message);
      assert.match(states.get(localHealthId)?.message ?? '', /nearing its memory limit/u);
      assert.equal(downOnTheCoreHost(states), 1);
    });

    it('leaves a remote probe’s machine to its own Probe Health', async () => {
      // Its machine is not the core's, and nothing else reports it.
      const states = await sweep({
        machine: { availablePercent: 60, availableBytes: 4_900 * MIB, totalBytes: 8_192 * MIB },
        local: { ...CALM, memoryAvailablePercent: 60, memoryAvailableMb: 4_900 },
        remote: { ...CALM, memoryAvailablePercent: 8, memoryAvailableMb: 650 },
      });
      assert.equal(states.get(remoteHealthId)?.state, 'down', states.get(remoteHealthId)?.message);
      assert.equal(states.get(coreHealthId)?.state, 'up');
      assert.equal(states.get(localHealthId)?.state, 'up');
    });

    it('reports the machine on the local probe again once it is no longer local', async () => {
      // The flag is the whole decision, so taking it away must give the reading back.
      await db.query('UPDATE probe_config SET is_local = false WHERE object_id = $1', [
        localProbeId,
      ]);
      try {
        const states = await sweep({
          machine: SQUEEZED,
          local: { ...CALM, memoryAvailablePercent: 8, memoryAvailableMb: 650 },
          remote: CALM,
        });
        assert.equal(states.get(localHealthId)?.state, 'down');
        assert.equal(downOnTheCoreHost(states), 2, 'what an unflagged probe beside the core costs');
      } finally {
        await db.query('UPDATE probe_config SET is_local = true WHERE object_id = $1', [
          localProbeId,
        ]);
      }
    });
  },
);

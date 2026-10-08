import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  PROTOCOL_VERSION,
  type CheckResult,
  type IngestionConfig,
  type ProbeHealthReport,
} from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { remoteClockOffsets } from '../src/health/core-clock.js';
import { CoreHealthService, type CoreHealthSources } from '../src/health/core-health.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { DEFAULT_MAX_FUTURE_SKEW_MS, IngestionService } from '../src/ingestion/service.js';
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
  memoryAvailablePercent: 60,
  memoryAvailableMb: 4_900,
};

const MINUTE = 60_000;

interface Clocks {
  /** Each remote probe's offset in ms as the core measures it; negative is ahead. */
  readonly remote: readonly (number | null)[];
  /** Remote probes not connected, by index. */
  readonly gone?: readonly number[];
}

/**
 * `P-247`: a core whose own clock is behind is one alarm, Core Health's, naming the core.
 *
 * Every clock check compares a probe with the core. A core twenty minutes slow sees every probe
 * twenty minutes ahead, refuses all their results as future-dated, and each probe's Probe Health
 * warned that its own clock was at fault: N alarms naming N machines that were fine. The whole
 * way — both sweeps, ingestion, the declared limits, the state machine — because each is a place a
 * second alarm could come from. Asserted as states, as `M-17` does: every sensor in Warning or
 * Down is an alarm, so the count of them is the count of alarms.
 */
describe(
  "the core's own clock behind every probe (P-247)",
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let localProbeId = 0;
    const remoteProbeIds: number[] = [];
    let coreHealthId = 0;
    let localHealthId = 0;
    const remoteHealthIds: number[] = [];
    // Just behind the wall clock: ingestion refuses a result stamped ahead of it (`P-146`).
    let now = new Date(Date.now() - 10 * MINUTE);

    before(async () => {
      scratch = await createScratchDatabase('coreclock');
      db = scratch.db;
      harness = await buildHarness(db);

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

      for (const n of [1, 2, 3]) {
        const probe = await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name: `Remote probe ${String(n)}`,
        });
        remoteProbeIds.push(probe.id);
        const box = await harness.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: `remote-box-${String(n)}`,
          host: `192.0.2.${String(60 + n)}`,
        });
        remoteHealthIds.push(
          (
            await harness.service.create(testActor, {
              kind: 'sensor',
              parentId: box.id,
              name: 'Probe Health',
              sensorType: 'ms.probe.health',
              params: {},
            })
          ).id,
        );
      }
    });

    after(async () => {
      await scratch.drop();
    });

    const connected = (id: number, clockOffsetMs: number | null, at: Date): ProbeLink => ({
      connected: true,
      gid: `gid-${String(id)}`,
      clockOffsetMs,
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
      health: CALM,
    });

    const coreSources = (): CoreHealthSources => ({
      disk: () => null,
      evictedChunks: () => 0,
      machineMemory: () => null,
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
        probeCoalesced: 0,
        signedOut: { ended: 0, expired: 0, revoked: 0, disabled: 0 },
        credentialCheckFailures: 0,
        unsure: 0,
        checksOutstanding: 0,
        edgesUnvetted: 0,
        withheld: 0,
        edgesCoalesced: 0,
      }),
      probes: () => ({ probesDown: 0, probesSilent: 0 }),
      alarms: () => ({ fired: 0, overdueMs: 0 }),
      queries: () => ({ refused: 0, unfit: 0 }),
      ingestionDiscards: () => ({
        discardedFutureTime: 0,
        discardedPastTime: 0,
        discardedUnreadableTime: 0,
        refusedUnfit: 0,
        discardedUnfitReadings: 0,
        channelsCreatedUndeclared: 0,
      }),
      credentialsToReenter: () => Promise.resolve(0),
      database: () => ({ statements: 0, locks: 0 }),
      delivery: () => Promise.resolve({ pending: 0, failed: 0, oldestPendingAgeMs: 0 }),
    });

    /** Both services' sweeps, the way `main.ts` wires them, into one ingestion path. */
    async function sweep(clocks: Clocks): Promise<Map<number, { state: string; message: string }>> {
      const at = now;
      const links = new Map<number, ProbeLink>([[localProbeId, connected(localProbeId, 0, at)]]);
      remoteProbeIds.forEach((id, i) => {
        links.set(
          id,
          clocks.gone?.includes(i) === true
            ? { connected: false }
            : connected(id, clocks.remote[i] ?? null, at),
        );
      });
      const link = (id: number): ProbeLink => links.get(id) ?? { connected: false };
      const connectedIds = [...links].filter(([, held]) => held.connected).map(([id]) => id);
      // What ingestion refuses from each probe, by gid as it counts them: its results, stamped by
      // its own clock, past the core's horizon (`P-99`).
      const offsetByGid = new Map(
        [...links.values()].flatMap((held) =>
          held.connected ? [[held.gid, held.clockOffsetMs] as const] : [],
        ),
      );
      const timeRefusals = (gid: string): { past: number; future: number } => {
        const offsetMs = offsetByGid.get(gid) ?? null;
        return {
          past: 0,
          future: offsetMs !== null && -offsetMs > DEFAULT_MAX_FUTURE_SKEW_MS ? 40 : 0,
        };
      };

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
          batchId: `health-${at.toISOString()}-${String(batch)}`,
          results: [...results],
        });
      };
      await new CoreHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          ...coreSources(),
          probeClocks: async (q) => {
            const rows = await q.query<{ object_id: string }>(
              'SELECT object_id::text AS object_id FROM probe_config WHERE is_local',
            );
            return remoteClockOffsets(
              connectedIds,
              new Set(rows.map((row) => Number(row.object_id))),
              link,
            );
          },
        },
        ingest,
        now: () => at,
      }).sweep();
      await new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: {
          link,
          connectedProbeIds: () => connectedIds,
          timeRefusals,
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

    const alarms = (states: Map<number, { state: string }>): number[] =>
      [coreHealthId, localHealthId, ...remoteHealthIds].filter((id) => {
        const state = states.get(id)?.state;
        return state === 'warning' || state === 'down';
      });

    it('is calm when every clock agrees', async () => {
      const states = await sweep({ remote: [0, 400, -300] });
      assert.deepEqual(alarms(states), [], JSON.stringify([...states]));
    });

    it('names one probe whose clock is ahead, and not the core', async () => {
      const states = await sweep({ remote: [0, 400, -20 * MINUTE] });
      assert.deepEqual(alarms(states), [remoteHealthIds[2]], JSON.stringify([...states]));
      assert.match(states.get(remoteHealthIds[2] ?? 0)?.message ?? '', /differs from the core/u);
    });

    it('is one alarm, on Core Health, when every probe is twenty minutes ahead', async () => {
      const ahead = -20 * MINUTE;
      const states = await sweep({ remote: [ahead - 400, ahead, ahead + 900] });
      assert.deepEqual(alarms(states), [coreHealthId], JSON.stringify([...states]));
      assert.equal(states.get(coreHealthId)?.state, 'down', 'past the point where all is refused');
      assert.match(states.get(coreHealthId)?.message ?? '', /core's clock is so far behind/u);
      // Each probe still says it, in words, without an alarm of its own.
      for (const id of remoteHealthIds) {
        assert.equal(states.get(id)?.state, 'up', states.get(id)?.message);
        assert.match(states.get(id)?.message ?? '', /s ahead of the core's, as every probe's/u);
      }
    });

    it('warns on Core Health, alone, when every probe is two minutes ahead', async () => {
      const states = await sweep({ remote: [-2 * MINUTE, -2.5 * MINUTE, -3 * MINUTE] });
      assert.deepEqual(alarms(states), [coreHealthId], JSON.stringify([...states]));
      assert.equal(states.get(coreHealthId)?.state, 'warning');
      assert.match(states.get(coreHealthId)?.message ?? '', /check time sync on the core's host/u);
    });

    it('does not blame the core on one probe’s word', async () => {
      // Two of three gone: one probe ahead cannot be told from one probe wrong.
      const states = await sweep({ remote: [-20 * MINUTE, 0, 0], gone: [1, 2] });
      assert.equal(states.get(coreHealthId)?.state, 'up', states.get(coreHealthId)?.message);
      assert.equal(states.get(remoteHealthIds[0] ?? 0)?.state, 'warning');
    });

    it('is Core Health’s again with two of them, and the local probe does not break the quorum', async () => {
      // The local probe reads the core's own clock, offset zero, and is left out of the vote.
      const states = await sweep({ remote: [-20 * MINUTE, -20 * MINUTE, 0], gone: [2] });
      // The third probe is Down for being gone, its own outage; nothing else is but Core Health.
      assert.equal(states.get(remoteHealthIds[2] ?? 0)?.state, 'down');
      assert.deepEqual(
        alarms(states).filter((id) => id !== remoteHealthIds[2]),
        [coreHealthId],
        JSON.stringify([...states]),
      );
    });

    it('is calm again when the core’s clock is put right', async () => {
      const states = await sweep({ remote: [0, 400, -300] });
      assert.deepEqual(alarms(states), [], JSON.stringify([...states]));
    });
  },
);

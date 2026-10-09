import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import {
  PROTOCOL_VERSION,
  type CheckResult,
  type IngestionConfig,
  type ProbeHealthReport,
} from '@ms/shared';
import { Database } from '../src/db/pool.js';
import { CoreHealthService, type CoreHealthSources } from '../src/health/core-health.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { SensorOwnership } from '../src/ingestion/ownership.js';
import { IngestionService, type ResultsMessage } from '../src/ingestion/service.js';
import { loadLookups } from '../src/lookups/loader.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { ProbeRefusals } from '../src/probes/refusals.js';
import { SensorStateService } from '../src/state/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { everyVoucherHolds } from './support/vouching.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

/** A probe with nothing wrong with it. */
const CALM: ProbeHealthReport = {
  scheduled: 1,
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

/**
 * `P-229`, one outage and one alarm: a lock held on the table ingestion writes.
 *
 * A session outside the core (a backup, an operator's `psql`) holds `sample` for 30 s of the
 * scenario's clock. Every write that needs it gives up after `lockTimeoutMs` (300 ms here,
 * scaled down from 5 s), and each batch is answered `storage-error`, which is what makes a probe
 * keep it and offer it again. What the ticket requires of it:
 *
 * - **Exactly one Core Health warning.** The lock waits given up are counted, and Core Health's
 *   `dbLockTimeouts` warns on any rate, once, and recovers when they stop.
 * - **No Probe Health warning.** A batch refused for a lock is the core's trouble, not the probe's:
 *   it is not a `P-228` refusal and is counted nowhere Probe Health reads.
 * - **No gap.** The probe's re-offer, once the lock is gone, stores every reading it was holding.
 *
 * Driven the way `main.ts` drives it: the probe's batches through `acceptProbeResults`, and both
 * health sensors' sweeps through the same ingestion, every 30 s of the scenario's clock.
 */
describe(
  'P-229: a lock held on the table ingestion writes',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let probeId = 0;
    let pingId = 0;
    let coreHealthId = 0;
    let probeHealthId = 0;

    before(async () => {
      scratch = await createScratchDatabase('dblockscenario');
      db = new Database({
        config: { ...testDatabaseConfig(), lockTimeoutMs: 300 },
        logger: silentLogger,
        databaseOverride: scratch.name,
      });
      h = await buildHarness(db);
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Probe',
      });
      probeId = probe.id;
      await db.query(
        `INSERT INTO probe_config (object_id, gid, is_local) VALUES ($1, 'probe-gid', false)
         ON CONFLICT (object_id) DO NOTHING`,
        [probeId],
      );
      const box = await h.service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'box',
        host: '192.0.2.20',
      });
      pingId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
          params: { count: 3 },
        })
      ).id;
      coreHealthId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box.id,
          name: 'Core Health',
          sensorType: 'ms.core.health',
        })
      ).id;
      probeHealthId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          params: {},
        })
      ).id;
    });

    after(async () => {
      await db.close();
      await scratch.drop();
    });

    it('is one Core Health warning, nothing on Probe Health, and no gap once the probe offers again', async () => {
      const lookups = await loadLookups({ logger: silent });
      const states = new SensorStateService({
        db,
        logger: silent,
        settings: h.resolver,
        pauses: new PauseRepository(),
      });
      const refusals = new ProbeRefusals();
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const ingestion = new IngestionService({
        db,
        logger: silent,
        ingestor,
        states,
        ownership: new SensorOwnership({ coreEvaluated: (type) => type.startsWith('ms.') }),
        refusals,
        resolver: new ChannelResolver({ logger: silent, lookups }),
      });

      // Just behind the wall clock: ingestion refuses a result stamped ahead of it (`P-146`).
      let now = new Date(Date.now() - 20 * 60_000);
      // When a batch last arrived, whatever became of it: what the endpoint stamps (`P-228`).
      let lastArrival = now;
      /** What the probe has sent and not had acknowledged: its spool. */
      const spool: ResultsMessage[] = [];
      const sent: string[] = [];
      let batch = 0;

      const offer = async (message: ResultsMessage): Promise<boolean> => {
        lastArrival = now;
        const reply = await ingestion.acceptProbeResults(
          { gid: 'probe-gid', probeObjectId: probeId },
          message,
        );
        if (reply.type === 'results-nack') {
          assert.equal(reply.reason, 'storage-error', 'a lock is the core’s trouble');
          return false;
        }
        return true;
      };

      /** The probe's minute: offer what it holds, oldest first, then this reading. */
      const probeTick = async (): Promise<void> => {
        batch += 1;
        const at = now.toISOString();
        sent.push(at);
        const result: CheckResult = {
          sensorId: pingId,
          at,
          outcome: 'ok',
          message: '3/3 replies',
          durationMs: 12,
          channels: [{ key: 'rtt', value: 1 + batch / 10 }],
        };
        spool.push({ type: 'results', batchId: `ping-${String(batch)}`, results: [result] });
        while (spool.length > 0) {
          const next = spool[0];
          if (next === undefined || !(await offer(next))) break;
          spool.shift();
        }
      };

      const link = (): ProbeLink => ({
        connected: true,
        gid: 'probe-gid',
        clockOffsetMs: null,
        protocolVersion: PROTOCOL_VERSION,
        connectedAt: new Date(now.getTime() - 3_600_000),
        lastHeartbeatAt: now,
        approved: true,
        agentVersion: '1.0.0',
        assignedSensors: 1,
        cadenceSeconds: 60,
        connectedForMs: Number.MAX_SAFE_INTEGER,
        sinceResultsMs: now.getTime() - lastArrival.getTime(),
        sinceConfigMs: 0,
        configured: true,
        configurable: true,
        lastResultsAt: lastArrival,
        configSentAt: now,
        health: CALM,
      });

      const coreSources: CoreHealthSources = {
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
          channelsCreatedOutsideDeclaration: 0,
        }),
        credentialsToReenter: () => Promise.resolve(0),
        // The pool's own count, which is the thing under test.
        database: () => db.timeouts(),
        delivery: () => Promise.resolve({ pending: 0, failed: 0, oldestPendingAgeMs: 0 }),
      };

      let sweepBatch = 0;
      const ingestHealth = async (results: readonly CheckResult[]): Promise<void> => {
        sweepBatch += 1;
        await ingestion.acceptResults('health', {
          type: 'results',
          batchId: `health-${String(sweepBatch)}`,
          results: [...results],
        });
      };

      /** Both sweeps, as `main.ts` runs them every 30 s, and the clock moved on. */
      const sweep = async (): Promise<void> => {
        const at = now;
        await new CoreHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: coreSources,
          ingest: ingestHealth,
          now: () => at,
        }).sweep();
        await new ProbeHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: {
            link,
            timeRefusals: (gid) => ingestion.timeRefusals(gid),
            refusals: (id) => refusals.countsFor(id),
          },
          ingest: ingestHealth,
          now: () => at,
        }).sweep();
        now = new Date(now.getTime() + 30_000);
      };

      const minute = async (): Promise<void> => {
        await probeTick();
        await sweep();
        await sweep();
      };

      // Three quiet minutes, so both health sensors have a baseline to take a rate from.
      for (let i = 0; i < 3; i += 1) await minute();

      const holder = new Client({ ...testDatabaseConfig(), database: scratch.name });
      await holder.connect();
      try {
        // What a writer needs and a reader does not: `SHARE` lets a backup read and stops
        // every insert.
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE sample IN SHARE MODE');
        // A minute of the scenario's clock: the probe's batch and two sweeps. Bounded, because
        // an insert with no lock limit waits for the holder, which is let go below.
        await within(20_000, 'the minute behind the held table', minute());
        assert.ok(spool.length > 0, 'the probe is holding what the core could not write');
        assert.ok(db.timeouts().locks > 0, 'and the core counted each wait it gave up');
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }

      // After: the probe offers what it held, and everything settles.
      for (let i = 0; i < 4; i += 1) await minute();
      await ingestor.stop();

      assert.equal(spool.length, 0, 'every batch was taken in the end');

      const history = async (sensorId: number): Promise<string[]> =>
        (
          await db.query<{ state: string }>(
            'SELECT state::text AS state FROM sensor_state WHERE sensor_id = $1 ORDER BY time',
            [sensorId],
          )
        ).map((row) => row.state);

      const core = await history(coreHealthId);
      assert.equal(core.filter((state) => state === 'warning').length, 1, core.join(' → '));
      assert.equal(core.at(-1), 'up', 'and it recovered');
      const probeStates = await history(probeHealthId);
      assert.deepEqual(
        probeStates.filter((state) => state !== 'up'),
        [],
        `Probe Health: ${probeStates.join(' → ')}`,
      );
      assert.deepEqual(refusals.countsFor(probeId), { refused: 0, foreignRecently: 0 });

      // No gap: a row for every reading the probe took, the held ones included.
      const stored = await db.query<{ at: Date }>(
        `SELECT s.time AS at FROM sample s JOIN channel c ON c.id = s.channel_id
         WHERE c.sensor_id = $1 AND c.key = 'rtt' ORDER BY s.time`,
        [pingId],
      );
      assert.deepEqual(
        stored.map((row) => row.at.toISOString()),
        sent,
      );
    });
  },
);

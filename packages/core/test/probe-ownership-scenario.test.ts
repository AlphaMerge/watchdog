import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION, type CheckResult, type IngestionConfig } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { SensorOwnership } from '../src/ingestion/ownership.js';
import { IngestionService } from '../src/ingestion/service.js';
import { IN_PROCESS_SOURCE } from '../src/ingestion/sources.js';
import { loadLookups } from '../src/lookups/loader.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmRepository } from '../src/notifications/repository.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { FOREIGN_WINDOW_MS, ProbeRefusals } from '../src/probes/refusals.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { everyVoucherHolds } from './support/vouching.js';

/**
 * `P-228` against alarm volume: a probe reporting on what is not its own, end to end.
 *
 * Refusing is the easy half. What these pin is what an operator would see, through the real
 * pipeline — the ownership gate, the state machine, the alarm engine, the triggers and the Probe
 * Health sweep — because every one of them is a place a refusal could still turn into an alarm,
 * or an ordinary move into a warning:
 *
 * - an administrator moving a few hundred sensors away from a probe whose spool is still
 *   draining gets no alarm at all, and no Down from the late results;
 * - a probe sending failures for another probe's sensor changes nothing about that sensor and
 *   raises exactly one warning, on itself, which clears on its own;
 * - a probe finishing another probe's discovery run provisions nothing.
 */

const available = await databaseAvailable();

/** Any id: the scheduler writes the obligation, and delivery is not what is being counted. */
const TEMPLATE = 401;

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

/** The moved group: several hundred sensors, as WatchDog's scenario asks. */
const DEVICES = 10;
const SENSORS_PER_DEVICE = 30;

describe(
  'a probe reporting on what is not its own (`P-228`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let triggers: TriggerService;
    let invalidator: ResultCacheInvalidator;
    let ownership: SensorOwnership;
    let channels: ChannelResolver;
    let serial = 0;

    before(async () => {
      scratch = await createScratchDatabase('p228scenario');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent, alarms: new AlarmRepository() });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      ownership = new SensorOwnership({
        coreEvaluated: (sensorType) => sensorType === 'ms.probe.health',
      });
      channels = new ChannelResolver({
        logger: silent,
        lookups: await loadLookups({ logger: silent }),
      });
      invalidator = new ResultCacheInvalidator({
        channels,
        owners: ownership,
        logger: silent,
        settleMs: 5,
      });
      // Production's order: the audit row and the cache invalidation in the mover's transaction.
      h.audit.also = new CompositeAuditSink([new DatabaseAuditSink(), invalidator, sync]);
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });

      // What an operator who wants to hear about trouble sets: Down and Warning, anywhere, at
      // once. Every alarm either scenario could raise would therefore reach a notification.
      for (const state of ['down', 'warning'] as const) {
        await triggers.create(testActor, h.rootId, {
          kind: 'state',
          settings: { state, initialLatencySeconds: 0, initialTemplateId: TEMPLATE },
        });
      }
    });

    after(async () => {
      scheduler.stop();
      invalidator.stop();
      await scratch.drop();
    });

    const named = (name: string): string => `${name}-${String(serial)}`;

    async function probe(name: string): Promise<{ id: number; device: number; health: number }> {
      const id = (
        await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name: named(name) })
      ).id;
      const device = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: id,
          name: named(`${name}-box`),
          host: '127.0.0.1',
        })
      ).id;
      const health = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device,
          name: named(`${name} health`),
          sensorType: 'ms.probe.health',
          params: {},
        })
      ).id;
      return { id, device, health };
    }

    async function ping(deviceId: number, name: string): Promise<number> {
      return (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name,
          sensorType: 'icmp.ping',
          params: {},
        })
      ).id;
    }

    /** Stamped now, so nothing here is a replay held back from reacting (`P-157`). */
    const outcome = (sensorId: number, kind: 'ok' | 'error'): CheckResult => ({
      sensorId,
      at: new Date().toISOString(),
      outcome: kind,
      message: kind === 'ok' ? '4/4 replies' : 'no replies',
      durationMs: 12,
      channels: kind === 'ok' ? [{ key: 'rtt', value: 1.5 }] : [],
    });

    function pipeline(refusals: ProbeRefusals): {
      ingestion: IngestionService;
      ingestor: Ingestor;
      sweep: () => Promise<void>;
    } {
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms: engine });
      const states = h.states;
      assert.ok(states !== undefined);
      const ingestion = new IngestionService({
        db,
        logger: silent,
        ingestor,
        states,
        resolver: channels,
        ownership,
        refusals,
      });
      let batch = 0;
      const link = (): ProbeLink => {
        const now = new Date();
        return {
          connected: true,
          gid: 'any',
          clockOffsetMs: null,
          protocolVersion: PROTOCOL_VERSION,
          connectedAt: now,
          lastHeartbeatAt: now,
          approved: true,
          agentVersion: '1.0.0',
          assignedSensors: 1,
          cadenceSeconds: 60,
          connectedForMs: 60_000,
          sinceResultsMs: 0,
          sinceConfigMs: 0,
          configured: true,
          configurable: true,
          lastResultsAt: now,
          configSentAt: now,
        };
      };
      const health = new ProbeHealthService({
        db,
        logger: silent,
        vouching: everyVoucherHolds,
        sources: { link, refusals: (probeObjectId) => refusals.countsFor(probeObjectId) },
        ingest: async (results) => {
          batch += 1;
          await ingestion.acceptResults(IN_PROCESS_SOURCE.probeHealth, {
            type: 'results',
            batchId: `probe-health-${String(batch)}`,
            results: [...results],
          });
        },
      });
      return {
        ingestion,
        ingestor,
        sweep: async () => {
          await health.sweep();
          await scheduler.sweep(new Date());
        },
      };
    }

    const report = (
      ingestion: IngestionService,
      from: { gid: string; id: number },
      results: CheckResult[],
      batchId: string,
    ) =>
      ingestion.acceptProbeResults(
        { gid: from.gid, probeObjectId: from.id },
        { type: 'results', batchId, results },
      );

    async function statesOf(ids: readonly number[]): Promise<Map<number, string>> {
      const rows = await db.query<{ id: string; state: string }>(
        'SELECT object_id::text AS id, state FROM sensor_runtime WHERE object_id = ANY($1::bigint[])',
        [ids],
      );
      return new Map(rows.map((row) => [Number(row.id), row.state]));
    }

    async function transitionsTo(state: string, ids: readonly number[]): Promise<number> {
      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sensor_state
         WHERE sensor_id = ANY($1::bigint[]) AND state = $2`,
        [ids, state],
      );
      return Number(rows[0]?.n ?? 0);
    }

    async function notificationsFor(ids: readonly number[]): Promise<number> {
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request WHERE sensor_id = ANY($1::bigint[])',
        [ids],
      );
      return Number(rows[0]?.n ?? 0);
    }

    it('raises nothing when a group moves away while the old probe’s spool is still draining', async (t) => {
      serial += 1;
      const a = await probe('A');
      const b = await probe('B');
      const group = (
        await h.service.create(testActor, { kind: 'group', parentId: a.id, name: named('moving') })
      ).id;
      const moving: number[] = [];
      for (let d = 0; d < DEVICES; d += 1) {
        const device = (
          await h.service.create(testActor, {
            kind: 'device',
            parentId: group,
            name: named(`dev-${String(d)}`),
            host: `192.0.2.${String(d + 1)}`,
          })
        ).id;
        for (let s = 0; s < SENSORS_PER_DEVICE; s += 1) {
          moving.push(await ping(device, `ping-${String(d)}-${String(s)}`));
        }
      }

      const refusals = new ProbeRefusals();
      const { ingestion, ingestor, sweep } = pipeline(refusals);
      try {
        // Everything Up, from the probe that owns it.
        for (let at = 0; at < moving.length; at += 100) {
          const slice = moving.slice(at, at + 100).map((id) => outcome(id, 'ok'));
          await report(ingestion, { gid: 'gid-a', id: a.id }, slice, `live-${String(at)}`);
        }
        await sweep();
        const before = await statesOf(moving);
        assert.ok(
          [...before.values()].every((state) => state === 'up'),
          'the group starts Up',
        );

        await h.service.move(testActor, group, b.id, { kind: 'none' });

        // A's spool, still draining after the move: every one of them a failure, and newer than
        // the last reading, so that without the gate the state machine would believe them and
        // the triggers would fire three hundred times.
        for (let at = 0; at < moving.length; at += 100) {
          const slice = moving.slice(at, at + 100).map((id) => outcome(id, 'error'));
          const reply = await report(
            ingestion,
            { gid: 'gid-a', id: a.id },
            slice,
            `spool-${String(at)}`,
          );
          assert.equal(reply.type, 'results-ack', 'acknowledged, so the spool drains');
        }
        await sweep();
        await sweep();

        assert.deepEqual(refusals.countsFor(a.id), { refused: moving.length, foreignRecently: 0 });
        assert.equal(ingestion.stats().refusedForeign, 0, 'not one of them foreign');
        assert.deepEqual(await statesOf(moving), before, 'no state change on the moved sensors');
        assert.equal(await transitionsTo('down', moving), 0);
        assert.equal(await transitionsTo('warning', [a.health, b.health]), 0, 'no warning');
        assert.equal(
          await notificationsFor([...moving, a.health, b.health]),
          0,
          'and no notification of any kind',
        );

        // And the probe they moved to owns them from the moment the move committed.
        const fromB = await report(
          ingestion,
          { gid: 'gid-b', id: b.id },
          [outcome(moving[0] ?? 0, 'ok')],
          'b-owns-it',
        );
        assert.ok(fromB.type === 'results-ack');
        assert.equal(fromB.storedSamples, 1);
        t.diagnostic(`${String(moving.length)} late results refused as moved, none foreign`);
      } finally {
        await ingestor.stop();
      }
    });

    it('leaves a sensor alone when another probe sends failures for it, and warns once, on the sender', async () => {
      serial += 1;
      const a = await probe('A');
      const b = await probe('B');
      const sensor = await ping(a.device, named('A’s ping'));

      let monotonic = 1_000_000;
      const refusals = new ProbeRefusals(() => monotonic);
      const { ingestion, ingestor, sweep } = pipeline(refusals);
      try {
        await report(ingestion, { gid: 'gid-a', id: a.id }, [outcome(sensor, 'ok')], 'a-live');
        await sweep();
        const before = await statesOf([sensor]);
        const history = await transitionsTo('up', [sensor]);
        assert.equal(before.get(sensor), 'up');

        // B, which was never given it: a failure, and a reading on a channel of its choosing.
        const reply = await report(
          ingestion,
          { gid: 'gid-b', id: b.id },
          [
            outcome(sensor, 'error'),
            { ...outcome(sensor, 'ok'), channels: [{ key: 'x', value: 9 }] },
          ],
          'b-forged',
        );
        assert.ok(reply.type === 'results-ack');
        assert.equal(reply.storedSamples, 0);

        await sweep();
        assert.deepEqual(await statesOf([sensor]), before, 'A’s sensor is as it was');
        assert.equal(await transitionsTo('down', [sensor]), 0);
        assert.equal(await transitionsTo('up', [sensor]), history, 'no transition at all');
        assert.equal(await notificationsFor([sensor]), 0, 'no notification for it');
        assert.equal((await statesOf([b.health])).get(b.health), 'warning', 'B warns on itself');

        // Still inside the window: still warning, and not warned again.
        monotonic += 30_000;
        await sweep();
        assert.equal((await statesOf([b.health])).get(b.health), 'warning');

        // Five minutes after the last one, it clears on its own.
        monotonic += FOREIGN_WINDOW_MS;
        await sweep();
        assert.equal((await statesOf([b.health])).get(b.health), 'up', 'the window emptied');

        assert.equal(await transitionsTo('warning', [b.health]), 1, 'exactly one warning');
        assert.equal(await notificationsFor([b.health]), 1, 'and one notification for it');
        assert.equal(await transitionsTo('warning', [a.health]), 0, 'none on the probe wronged');
      } finally {
        await ingestor.stop();
      }
    });

    it('provisions nothing when another probe finishes a run', async () => {
      serial += 1;
      const a = await probe('A');
      const b = await probe('B');
      const group = (
        await h.service.create(testActor, { kind: 'group', parentId: a.id, name: named('found') })
      ).id;
      const refusals = new ProbeRefusals();
      const announced: number[] = [];
      const discovery = new DiscoveryService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        dispatch: () => ({ kind: 'sent' }),
        // What `D-07` provisions from. Reached only when a run is recorded as finished.
        onFinished: (runId) => {
          announced.push(runId);
          return Promise.resolve();
        },
        refusals,
      });
      const run = await discovery.start(
        { groupId: group, probeId: a.id, range: '10.0.0.0/29', timeoutMs: 500, concurrency: 8 },
        testActor,
      );

      // Everything a probe would send to plant a host and have it provisioned.
      await discovery.progress(b.id, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(b.id, run.id, 'done', 6, '');
      await discovery.identified(b.id, run.id, 1, [
        { address: '10.0.0.1', ports: [], kind: 'linux', confidence: 90, evidence: ['forged'] },
      ]);
      await discovery.identifyFinished(b.id, run.id, 'done', '');

      const after = await discovery.get(run.id);
      assert.ok(after !== null);
      assert.equal(after.status, 'running', 'the run is still A’s, and still running');
      assert.equal(after.found, 0);
      assert.deepEqual(await discovery.hosts(run.id), []);
      assert.deepEqual(announced, [], 'nothing reached provisioning');
      const devices = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM object WHERE parent_id = $1 AND kind = 'device'`,
        [group],
      );
      assert.equal(Number(devices[0]?.n ?? 0), 0, 'and no device appeared');
      assert.deepEqual(refusals.countsFor(b.id), { refused: 4, foreignRecently: 4 });
    });
  },
);

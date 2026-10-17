import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PROTOCOL_VERSION } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { RecentMinimum } from '../src/health/recent-count.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import type { Mutation } from '../src/objects/audit.js';
import {
  CLOCK_FREEZE_TOLERANCE_MS,
  ClockFreeze,
  FROZEN_MESSAGE,
  THAWED_MESSAGE,
  type ClockFreezeOptions,
} from '../src/probes/clock-freeze.js';
import { ClockFreezeSync } from '../src/probes/clock-freeze-sync.js';
import { ProbeReachability } from '../src/probes/reachability.js';
import { writeRuntimes, writeStateHistory, type HeldWordsLookup } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The sensor types the core evaluates, from the catalogue, as `main.ts` works them out. */
const CORE_EVALUATED = ((): string[] => {
  const catalogue = testCatalogue();
  return catalogue.ids().filter((id) => catalogue.declaration(id).evaluatedBy === 'core');
})();

function link(clockOffsetMs: number | null): ProbeLink {
  const now = new Date();
  return {
    connected: true,
    gid: 'probe-gid',
    protocolVersion: PROTOCOL_VERSION,
    connectedAt: now,
    lastHeartbeatAt: now,
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: 0,
    cadenceSeconds: 60,
    connectedForMs: 0,
    sinceResultsMs: 0,
    sinceConfigMs: 0,
    configured: true,
    configurable: true,
    lastResultsAt: now,
    configSentAt: now,
    clockOffsetMs,
  };
}

/**
 * A probe whose clock steps back (`P-232`).
 *
 * Two halves. The predicate, table-driven against the real query: a sensor is frozen when its
 * last result is later than its probe's clock reads now, less a tolerance, and nothing else —
 * not a duplicate, not a replay, not a clock that is steadily wrong. And the path: a frozen
 * probe's sensors raise exactly the notifications a lost probe's do, on the step and on the lift,
 * because they are moved the same way.
 */
describe(
  'a probe whose clock steps back (`P-232`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let triggers: TriggerService;
    let templates: TemplateService;
    let scheduler: AlarmScheduler;

    /** Replaced per test; the state service reads whichever is current. */
    let freeze: ClockFreeze | undefined;
    let reachability: ProbeReachability | undefined;
    const none: HeldWordsLookup = new Map();

    /** Each connected probe's offset; absent is a probe with no session. */
    const offsets = new Map<number, number | null>();
    const links = {
      connectedProbeIds: (): number[] => [...offsets.keys()],
      linkFor: (probeObjectId: number): ProbeLink => {
        const offset = offsets.get(probeObjectId);
        return offset === undefined ? { connected: false } : link(offset);
      },
    };

    function newFreeze(now: () => Date = () => new Date()): ClockFreeze {
      assert.ok(h.states !== undefined && h.dependencies !== undefined);
      return new ClockFreeze({
        db,
        logger: silent,
        states: h.states,
        dependencies: h.dependencies,
        links,
        coreEvaluatedTypes: CORE_EVALUATED,
        now,
      });
    }

    /** A probe with a device, `count` pings and a Probe Health sensor, in one transaction. */
    async function probeWith(
      name: string,
      count: number,
    ): Promise<{ probe: number; pings: number[]; health: number }> {
      const probe = (await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name }))
        .id;
      const made = await h.service.createTree(testActor, {
        parentId: probe,
        nodes: [
          { kind: 'device', name: `${name}-box`, host: '192.0.2.10', ref: 'd' },
          ...Array.from({ length: count }, (_, at) => ({
            kind: 'sensor' as const,
            name: `${name}-ping-${String(at).padStart(3, '0')}`,
            sensorType: 'icmp.ping',
            parentRef: 'd',
            ref: `s${String(at)}`,
          })),
          {
            kind: 'sensor' as const,
            name: `${name}-health`,
            sensorType: 'ms.probe.health',
            params: {},
            parentRef: 'd',
            ref: 'health',
          },
        ],
      });
      const pings = made.objects
        .filter((one) => one.kind === 'sensor' && one.ref?.startsWith('s') === true)
        .map((one) => one.id);
      const health = made.objects.find((one) => one.ref === 'health')?.id;
      assert.ok(health !== undefined);
      return { probe, pings, health };
    }

    /** Results into states the way ingestion writes them: decide, write, react (`M-11`). */
    async function ingest(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      if (results.length === 0) return;
      const decisions = await states.decide(results);
      const at = results[0]?.at ?? new Date();
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(
          q,
          results.map((result) => result.sensorId),
          at,
        );
      });
    }

    async function runtimeOf(
      sensorId: number,
    ): Promise<{ state: string; cause: string; message: string }> {
      const [row] = await db.query<{ state: string; cause: string; message: string }>(
        `SELECT state::text AS state, cause::text AS cause, message
         FROM sensor_runtime WHERE object_id = $1`,
        [sensorId],
      );
      assert.ok(row !== undefined);
      return row;
    }

    async function lastResultAt(sensorId: number, at: Date | null): Promise<void> {
      await db.query('UPDATE sensor_runtime SET last_result_at = $2 WHERE object_id = $1', [
        sensorId,
        at,
      ]);
    }

    before(async () => {
      scratch = await createScratchDatabase('clockfreeze');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        lostSensors: () => reachability?.heldWords('link') ?? none,
        silentSensors: () => reachability?.heldWords('silence') ?? none,
        clockFrozenSensors: () => freeze?.heldWords() ?? none,
      });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts: new MessageContextLoader({
          settings: h.resolver,
          publicUrl: 'https://monitoring.example.test',
          siteName: 'Clock',
        }),
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(() => {
      offsets.clear();
      freeze = undefined;
      reachability = undefined;
    });

    describe('which sensors are frozen', () => {
      let probe = 0;
      let ping = 0;
      let health = 0;

      before(async () => {
        const made = await probeWith('table', 1);
        probe = made.probe;
        health = made.health;
        const first = made.pings[0];
        assert.ok(first !== undefined);
        ping = first;
      });

      const now = new Date();
      const CASES: readonly {
        readonly name: string;
        /** The sensor's last accepted result, relative to the core's clock now. */
        readonly lastResult: number | null;
        /** The probe's clock offset: positive when it is behind. Null is not yet measured. */
        readonly offset: number | null;
        readonly frozen: boolean;
      }[] = [
        {
          name: 'a clock that stepped back an hour',
          lastResult: -MINUTE,
          offset: HOUR,
          frozen: true,
        },
        {
          name: 'NTP correcting a clock that was ten minutes fast',
          lastResult: 9 * MINUTE,
          offset: 0,
          frozen: true,
        },
        {
          name: 'a clock that stepped forward',
          lastResult: -MINUTE,
          offset: -10 * MINUTE,
          frozen: false,
        },
        {
          name: 'a duplicate after a reconnect, the clock fine',
          lastResult: -MINUTE,
          offset: 200,
          frozen: false,
        },
        {
          name: "a replay of an hour's outage",
          lastResult: -HOUR,
          offset: 0,
          frozen: false,
        },
        {
          name: 'a clock steadily an hour behind, which never stepped',
          lastResult: -HOUR - MINUTE,
          offset: HOUR,
          frozen: false,
        },
        {
          name: 'just inside the tolerance',
          lastResult: CLOCK_FREEZE_TOLERANCE_MS - 1_000,
          offset: 0,
          frozen: false,
        },
        {
          name: 'just past it',
          lastResult: CLOCK_FREEZE_TOLERANCE_MS + 1_000,
          offset: 0,
          frozen: true,
        },
        { name: 'a sensor never measured', lastResult: null, offset: HOUR, frozen: false },
        { name: 'an offset not yet measured', lastResult: -MINUTE, offset: null, frozen: false },
      ];

      for (const row of CASES) {
        it(`${row.frozen ? 'freezes' : 'leaves'}: ${row.name}`, async () => {
          await lastResultAt(
            ping,
            row.lastResult === null ? null : new Date(now.getTime() + row.lastResult),
          );
          offsets.set(probe, row.offset);
          freeze = newFreeze(() => now);
          await freeze.sweep();
          assert.equal(freeze.frozenSensors().has(ping), row.frozen);
          assert.equal(freeze.frozenOn(probe), row.frozen ? 1 : 0);
          if (row.frozen) {
            const runtime = await runtimeOf(ping);
            assert.deepEqual(
              { state: runtime.state, cause: runtime.cause, message: runtime.message },
              { state: 'unknown', cause: 'probe', message: FROZEN_MESSAGE },
            );
          }
          // Thawed again, so the next row starts from a sensor nobody froze.
          offsets.set(probe, -HOUR);
          await freeze.sweep();
          assert.equal(freeze.frozenSensors().size, 0);
          if (row.frozen) {
            // And says so until its next result (`R-11`), where it said nothing.
            const runtime = await runtimeOf(ping);
            assert.deepEqual(
              { state: runtime.state, message: runtime.message },
              { state: 'up', message: THAWED_MESSAGE },
            );
          }
        });
      }

      it('leaves a core-evaluated sensor under the same probe, stamped by the core', async () => {
        // A Probe Health or a Sensor Factory under a probe whose clock is an hour behind has
        // results stamped by the core's clock, which is an hour ahead of the probe's.
        await lastResultAt(ping, new Date(now.getTime() - MINUTE));
        await lastResultAt(health, new Date(now.getTime() - MINUTE));
        offsets.set(probe, HOUR);
        freeze = newFreeze(() => now);
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().has(ping), true);
        assert.equal(freeze.frozenSensors().has(health), false);
        offsets.set(probe, -HOUR);
        await freeze.sweep();
      });

      it('releases the dependents of a master its clock has frozen', async () => {
        // As a lost probe's master does (`P-135`): Unknown is not Down, so whatever the master
        // held is let go, and nothing else would notice — a frozen sensor applies no results.
        const elsewhere = await probeWith('elsewhere', 1);
        const dependent = elsewhere.pings[0];
        assert.ok(dependent !== undefined);
        await h.service.setDependency(testActor, dependent, 'object', ping, undefined);
        await db.query(`UPDATE sensor_runtime SET state = 'down' WHERE object_id = $1`, [ping]);
        const dependencies = h.dependencies;
        assert.ok(dependencies !== undefined);
        await db.tx((q) => dependencies.recompute(q, new Date()));
        const paused = async (): Promise<boolean | undefined> =>
          (
            await db.query<{ paused: boolean }>(
              'SELECT paused_by_dependency AS paused FROM sensor_runtime WHERE object_id = $1',
              [dependent],
            )
          )[0]?.paused;
        assert.equal(await paused(), true, 'held while the master is Down');

        await lastResultAt(ping, new Date(now.getTime() - MINUTE));
        offsets.set(probe, HOUR);
        freeze = newFreeze(() => now);
        await freeze.sweep();
        assert.equal(await paused(), false, 'a frozen master holds nobody');

        offsets.set(probe, -HOUR);
        await freeze.sweep();
        await h.service.setDependency(testActor, dependent, 'parent', undefined, undefined);
      });

      it('is not moved by one delayed batch when the clock is fine', async () => {
        // The offset is the smallest reading over five minutes, so a batch that sat ninety
        // seconds in a send buffer reads as what it is: late, not behind.
        const readings = new RecentMinimum(5 * MINUTE);
        for (const one of [150, 90_000, 120]) readings.add(one);
        await lastResultAt(ping, new Date(now.getTime() - 5_000));
        offsets.set(probe, readings.minimum());
        freeze = newFreeze(() => now);
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().has(ping), false);
      });

      it('keeps what it froze while the offset is not measured, and thaws once it is', async () => {
        // A reconnect: the new session has sent no `sentAt` yet, so nothing is decided, and a
        // probe that comes back still behind does not show last readings before freezing again.
        await lastResultAt(ping, new Date(now.getTime() - MINUTE));
        offsets.set(probe, HOUR);
        freeze = newFreeze(() => now);
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().has(ping), true);

        offsets.delete(probe); // disconnected
        await freeze.sweep();
        offsets.set(probe, null); // back, nothing measured yet
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().has(ping), true, 'nothing measured, nothing decided');
        assert.equal((await runtimeOf(ping)).state, 'unknown');

        offsets.set(probe, 0); // measured: the clock was put right while it was away
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().has(ping), false);
        assert.notEqual((await runtimeOf(ping)).state, 'unknown');
      });

      it("never lets one probe's clock thaw another probe's sensors", async () => {
        // Each probe decides only the sensors under it, so what it froze is kept by probe.
        const second = await probeWith('second', 1);
        const other = second.pings[0];
        assert.ok(other !== undefined);
        await lastResultAt(ping, new Date(now.getTime() - MINUTE));
        await lastResultAt(other, new Date(now.getTime() - MINUTE));
        offsets.set(probe, HOUR);
        offsets.set(second.probe, HOUR);
        freeze = newFreeze(() => now);
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().size, 2);

        offsets.set(second.probe, 0);
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().has(ping), true, 'the first probe is still behind');
        assert.equal(freeze.frozenSensors().has(other), false);
        assert.deepEqual([freeze.frozenOn(probe), freeze.frozenOn(second.probe)], [1, 0]);

        offsets.set(probe, -HOUR);
        await freeze.sweep();
        assert.equal(freeze.frozenSensors().size, 0);
      });
    });

    describe('kept in step with the tree (`P-239`)', () => {
      it('thaws a sensor moved off a frozen probe that has gone away, and only that one', async () => {
        // A probe decides its sensors only on its own sweep, and one that has gone away is never
        // swept, so the moved sensor stayed Unknown with cause `probe` on its new, healthy probe
        // for as long as the old one was away: `P-103`'s defect, in this overlay.
        const from = await probeWith('moved-from', 2);
        const to = await probeWith('moved-to', 0);
        const [moved, stays] = from.pings;
        assert.ok(moved !== undefined && stays !== undefined);
        const now = new Date();
        await ingest(
          [moved, stays].map((sensorId) => ({
            sensorId,
            at: new Date(now.getTime() - MINUTE),
            outcome: 'ok' as const,
            message: 'up',
          })),
        );
        offsets.set(from.probe, HOUR);
        freeze = newFreeze(() => now);
        await freeze.sweep();
        assert.equal(freeze.frozenOn(from.probe), 2);
        assert.equal((await runtimeOf(moved)).cause, 'probe');
        offsets.delete(from.probe); // gone, and never swept again

        const parentOf = async (id: number): Promise<number> => {
          const [row] = await db.query<{ id: string }>(
            'SELECT parent_id::text AS id FROM object WHERE id = $1',
            [id],
          );
          assert.ok(row !== undefined);
          return Number(row.id);
        };
        const previous = h.audit.also;
        const sync = new ClockFreezeSync({ clockFreeze: () => freeze });
        h.audit.also = new CompositeAuditSink(previous === undefined ? [sync] : [previous, sync]);
        try {
          // A tree change that leaves both where they are keeps both frozen.
          await h.service.create(testActor, {
            kind: 'sensor',
            parentId: await parentOf(moved),
            name: 'moved-from-arrival',
            sensorType: 'icmp.ping',
          });
          assert.equal(freeze.frozenOn(from.probe), 2, 'nothing left the frozen probe');

          await h.service.move(testActor, moved, await parentOf(to.health), { kind: 'none' });
        } finally {
          h.audit.also = previous;
        }
        assert.equal(freeze.frozenSensors().has(moved), false);
        assert.equal(freeze.carrierOf(moved), undefined);
        const runtime = await runtimeOf(moved);
        assert.equal(runtime.state, 'up', 'back to what its last reading said');
        assert.notEqual(runtime.cause, 'probe');

        // The one still under the frozen probe is still frozen, by it.
        assert.deepEqual(freeze.frozenBy(from.probe)?.sensorIds, new Set([stays]));
        assert.equal(freeze.carrierOf(stays), from.probe);
        assert.equal((await runtimeOf(stays)).cause, 'probe');
      });
    });

    describe('what it costs in notifications', () => {
      it('queues exactly what a lost probe queues, on the step and on the lift', async () => {
        // **One path, so one answer** (`CLAUDE.md`: one outage, one alarm). Two probes of the
        // same shape: one is lost, one has its clock stepped back an hour. A trigger on Down,
        // one on Unknown and one on Up, at the root, so both see all three. What is queued for
        // each is compared kind by kind and reason by reason, on the step and on the lift.
        const COUNT = 150;
        const lost = await probeWith('lost', COUNT);
        const frozen = await probeWith('frozen', COUNT);

        for (const state of ['down', 'unknown', 'up'] as const) {
          const template = await templates.create(testActor, {
            name: `Clock ${state}`,
            method: 'email',
            settings: {},
            subject: '%sensor is %status',
            body: '%lastmessage',
            recipients: [{ kind: 'address', value: 'noc@example.test' }],
            summaryWindowSeconds: 60,
          });
          await triggers.create(testActor, h.rootId, {
            kind: 'state',
            settings: {
              state,
              initialLatencySeconds: 0,
              initialTemplateId: template.id,
              recoveryTemplateId: template.id,
            },
          });
        }

        // Every fifth sensor Down, the rest Up, all a minute ago: two failed scans, then one
        // good or bad scan each, so both probes stand in the same place before anything moves.
        const t0 = Date.now() - 3 * MINUTE;
        for (const set of [lost.pings, frozen.pings]) {
          await ingest(
            set.map((sensorId) => ({
              sensorId,
              at: new Date(t0),
              outcome: 'ok' as const,
              message: 'up',
            })),
          );
          const failing = set.filter((_, at) => at % 5 === 0);
          for (const step of [1, 2]) {
            await ingest(
              failing.map((sensorId) => ({
                sensorId,
                at: new Date(t0 + step * MINUTE),
                outcome: 'error' as const,
                message: 'no reply',
              })),
            );
          }
        }
        await scheduler.sweep(new Date(Date.now() + MINUTE));

        assert.ok(h.states !== undefined);
        reachability = new ProbeReachability({
          db,
          logger: silent,
          states: h.states,
          dependencies: h.dependencies ?? { recompute: () => Promise.resolve({ moved: 0 }) },
          coreEvaluatedTypes: CORE_EVALUATED,
        });
        freeze = newFreeze();

        const queued = async (
          after: number,
          sensors: readonly number[],
        ): Promise<Record<string, number>> => {
          const rows = await db.query<{ key: string; n: string }>(
            `SELECT t.settings->>'state' || ':' || r.reason || ':' || r.state::text AS key,
                    count(*)::text AS n
             FROM notification_request r
             JOIN notification_trigger t ON t.id = r.trigger_id
             WHERE r.id > $1 AND r.sensor_id = ANY($2::bigint[])
             GROUP BY 1 ORDER BY 1`,
            [after, sensors],
          );
          return Object.fromEntries(rows.map((row) => [row.key, Number(row.n)]));
        };
        const mark = async (): Promise<number> => {
          const [row] = await db.query<{ id: string | null }>(
            'SELECT max(id)::text AS id FROM notification_request',
          );
          return Number(row?.id ?? 0);
        };

        // The step.
        const beforeStep = await mark();
        await reachability.lost(lost.probe);
        offsets.set(frozen.probe, HOUR);
        await freeze.sweep();
        assert.equal(freeze.frozenOn(frozen.probe), COUNT, 'every ping, and not Probe Health');
        await scheduler.sweep(new Date(Date.now() + MINUTE));

        const lostStep = await queued(beforeStep, lost.pings);
        const frozenStep = await queued(beforeStep, frozen.pings);
        assert.deepEqual(frozenStep, lostStep, 'the step: exactly what a lost probe queues');
        assert.equal(lostStep['down:initial:down'] ?? 0, 0, 'no Down is paged for Unknown');
        assert.equal(
          Object.entries(lostStep)
            .filter(([key]) => key.startsWith('unknown:initial:'))
            .reduce((sum, [, n]) => sum + n, 0),
          COUNT,
          'not two empty answers: this engine has no episode index, so one Unknown per sensor, ' +
            'which is what `M-22` holds behind Probe Health when it has one',
        );

        // The lift.
        const beforeLift = await mark();
        await reachability.found(lost.probe);
        offsets.set(frozen.probe, 0);
        await freeze.sweep();
        assert.equal(freeze.frozenOn(frozen.probe), 0);
        await scheduler.sweep(new Date(Date.now() + MINUTE));

        const lostLift = await queued(beforeLift, lost.pings);
        const frozenLift = await queued(beforeLift, frozen.pings);
        assert.deepEqual(frozenLift, lostLift, 'the lift: exactly what a lost probe queues');
        assert.equal(
          Object.entries(lostLift)
            .filter(([key]) => key.startsWith('down:'))
            .reduce((sum, [, n]) => sum + n, 0),
          0,
          'no second wave for the Down alarms, which resume where they were',
        );

        for (const id of frozen.pings) {
          assert.notEqual((await runtimeOf(id)).state, 'unknown', 'every sensor back');
        }
      });
    });
  },
);

describe('a freeze whose write does not land (`P-232`)', () => {
  it('takes the set back, so it never claims a state that was not written', async () => {
    // `P-80`'s rule, as `ProbeReachability.lost` keeps it: the set changes before the
    // re-evaluation, because the state service reads it, and back if the transaction fails.
    const rejected = new ClockFreeze({
      db: {
        query: () => Promise.resolve([{ id: '5' }]),
        tx: () => Promise.reject(new Error('the database went away')),
      } as unknown as ClockFreezeOptions['db'],
      logger: silent,
      states: { reevaluate: () => Promise.resolve(1) },
      dependencies: { recompute: () => Promise.resolve({ moved: 0 }) },
      links: { connectedProbeIds: () => [9], linkFor: () => link(HOUR) },
    });
    assert.equal(await rejected.sweep(), 0);
    assert.equal(rejected.frozenSensors().size, 0);
    assert.equal(rejected.frozenOn(9), 0);
    assert.equal(rejected.frozenBy(9), undefined, 'nor an episode for the alarm engine (`M-22`)');
    assert.equal(rejected.carrierOf(5), undefined);
  });
});

/** A `ClockFreeze` over a stand-in database, deciding the sensors `under` lists per probe. */
function standIn(
  under: ReadonlyMap<number, readonly string[]>,
  reevaluated: { ids: number[]; message: string }[],
  reject?: (message: string) => boolean,
): ClockFreeze {
  return new ClockFreeze({
    db: {
      query: (_sql: string, values: readonly unknown[]) =>
        Promise.resolve((under.get(Number(values[0])) ?? []).map((id) => ({ id }))),
      tx: <T>(fn: (q: unknown) => Promise<T>) => fn({}),
    } as unknown as ClockFreezeOptions['db'],
    logger: silent,
    states: {
      reevaluate: (_q, ids, _at, cause) => {
        if (reject?.(cause.message) === true) {
          return Promise.reject(new Error('the transaction is aborted'));
        }
        reevaluated.push({ ids: [...ids], message: cause.message });
        return Promise.resolve(ids.length);
      },
    },
    dependencies: { recompute: () => Promise.resolve({ moved: 0 }) },
    links: { connectedProbeIds: () => [...under.keys()], linkFor: () => link(HOUR) },
  });
}

describe('one sensor in two probes’ sets (`P-239`)', () => {
  it('stays frozen while either holds it, and settling one issues no thaw', async () => {
    // Moved off a probe whose set was never brought up to date, and frozen again by the one it
    // went to. The global set is the union: one probe letting it go is not a thaw.
    // Sensor 7 is in the second probe's set alone, so letting both go thaws 7 and not 5.
    const under = new Map<number, readonly string[]>([
      [9, ['5']],
      [10, ['5', '7']],
    ]);
    const reevaluated: { ids: number[]; message: string }[] = [];
    const freeze = standIn(under, reevaluated);
    await freeze.sweep();
    assert.deepEqual([freeze.frozenOn(9), freeze.frozenOn(10)], [1, 2]);
    assert.equal(freeze.carrierOf(5), 10, 'carried by the one that froze it last');

    reevaluated.length = 0;
    under.set(10, []);
    await freeze.sweep();
    assert.equal(freeze.frozenSensors().has(5), true);
    assert.equal(freeze.frozenSensors().has(7), false);
    assert.deepEqual([freeze.frozenOn(9), freeze.frozenOn(10)], [1, 0]);
    assert.equal(freeze.carrierOf(5), 9, 'carried by the one that still holds it');
    assert.deepEqual(
      reevaluated.filter((call) => call.message !== FROZEN_MESSAGE && call.ids.includes(5)),
      [],
      'no thaw issued for 5',
    );
    assert.deepEqual(
      reevaluated.map((call) => call.ids),
      [[7]],
      'the thaw is 7 alone',
    );

    under.set(9, []);
    await freeze.sweep();
    assert.equal(freeze.frozenSensors().has(5), false);
    assert.equal(freeze.carrierOf(5), undefined);
    assert.deepEqual(
      reevaluated.filter((call) => call.ids.includes(5)).map((call) => call.message),
      [THAWED_MESSAGE],
      'thawed once, when the last set let it go',
    );
  });
});

describe('a resync (`P-239`)', () => {
  it('reads nothing when nothing is frozen', async () => {
    const freeze = standIn(new Map(), []);
    const q = { query: () => Promise.reject(new Error('read')) } as unknown as Queryable;
    assert.equal(await freeze.resync(q), 0);
  });

  it('takes its sets back, and fails the mutation, when the thaw cannot be written', async () => {
    // The transaction is aborted by then, and a COMMIT on it rolls back without an error, so a
    // caught failure would tell the caller that a mutation nobody wrote had succeeded.
    const freeze = standIn(new Map([[9, ['5', '6']]]), [], (message) => message !== FROZEN_MESSAGE);
    await freeze.sweep();
    const since = freeze.frozenBy(9)?.since;
    const q = { query: () => Promise.resolve([{ id: '6' }]) } as unknown as Queryable;
    await assert.rejects(freeze.resync(q), /the transaction is aborted/u);
    assert.deepEqual(freeze.frozenBy(9), { sensorIds: new Set([5, 6]), since });
    assert.equal(freeze.carrierOf(5), 9);
    assert.equal(freeze.frozenSensors().has(5), true);
  });
});

describe('the sink that runs it (`P-239`)', () => {
  function counting(fail = false): { sink: ClockFreezeSync; calls: () => number } {
    let calls = 0;
    const freeze = {
      resync: (): Promise<number> => {
        calls += 1;
        return fail ? Promise.reject(new Error('the transaction is aborted')) : Promise.resolve(0);
      },
    } as unknown as ClockFreeze;
    return { sink: new ClockFreezeSync({ clockFreeze: () => freeze }), calls: () => calls };
  }
  const q = {} as Queryable;
  const one = (action: string): Mutation[] => [{ action, objectId: 1 } as unknown as Mutation];

  it('resyncs on every mutation that can move a sensor, and on nothing else', async () => {
    const { sink, calls } = counting();
    await sink.record(q, testActor, one('object.updated'), new Date());
    assert.equal(calls(), 0);
    for (const action of ['object.moved', 'object.created', 'object.cloned', 'object.deleted']) {
      await sink.record(q, testActor, one(action), new Date());
    }
    assert.equal(calls(), 4);
  });

  it('lets a failure through, so the mutation fails with it', async () => {
    const { sink } = counting(true);
    await assert.rejects(
      sink.record(q, testActor, one('object.moved'), new Date()),
      /the transaction is aborted/u,
    );
  });

  it('does nothing before the clock freeze exists', async () => {
    const sink = new ClockFreezeSync({ clockFreeze: () => undefined });
    await sink.record(q, testActor, one('object.moved'), new Date());
  });
});

describe('what a freeze tells the alarm engine (`M-22`)', () => {
  it('says which probe froze which sensor, since when, and re-evaluates the probe’s alarm', async () => {
    let frozen = ['5', '6'];
    let clock = new Date('2026-09-29T10:00:00.000Z');
    const reevaluated: number[][] = [];
    const freeze = new ClockFreeze({
      db: {
        query: () => Promise.resolve(frozen.map((id) => ({ id }))),
        tx: <T>(fn: (q: unknown) => Promise<T>) => fn({}),
      } as unknown as ClockFreezeOptions['db'],
      logger: silent,
      states: {
        reevaluate: (_q, ids) => {
          reevaluated.push([...ids]);
          return Promise.resolve(ids.length);
        },
      },
      dependencies: { recompute: () => Promise.resolve({ moved: 0 }) },
      links: { connectedProbeIds: () => [9], linkFor: () => link(HOUR) },
      probeAlarms: () => [70],
      now: () => clock,
    });

    await freeze.sweep();
    const since = clock;
    assert.equal(freeze.carrierOf(5), 9);
    assert.deepEqual(freeze.frozenBy(9), { sensorIds: new Set([5, 6]), since });
    assert.deepEqual(reevaluated, [[5, 6], [70]]);

    // One more sensor later: the same freeze, from the same start.
    clock = new Date(clock.getTime() + MINUTE);
    frozen = ['5', '6', '7'];
    await freeze.sweep();
    assert.equal(freeze.frozenBy(9)?.since, since);

    frozen = [];
    await freeze.sweep();
    assert.equal(freeze.frozenBy(9), undefined);
    assert.equal(freeze.carrierOf(5), undefined);
  });
});

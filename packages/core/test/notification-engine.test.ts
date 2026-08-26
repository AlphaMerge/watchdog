import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmRepository } from '../src/notifications/repository.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { SensorState } from '../src/state/tables.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const T0 = new Date('2026-08-26T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/** The template ids a real installation would have; `N-05` gives them meaning. */
const INITIAL = 101;
const ESCALATION = 102;
const RECOVERY = 103;

interface QueuedRequest {
  reason: string;
  templateId: number | null;
  state: SensorState;
  sensorId: number;
  message: string;
  at: Date;
}

/**
 * `N-02`: the state trigger's chain, against a real database.
 *
 * `notification-chain.test.ts` proves the decisions. This proves they are wired to something:
 * that a state change reaches the engine, that a due time survives being written down, and that
 * `PLAN.md`'s exit criteria hold end to end — a blip under its latency notifies nobody, and
 * acknowledging cancels the escalation while leaving the recovery owed.
 */
describe(
  'the state trigger engine',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let alarms: AlarmRepository;
    let triggers: TriggerService;
    let deviceId: number;
    let sensorId: number;
    let otherSensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('alarms');
      db = scratch.db;

      alarms = new AlarmRepository();
      engine = new AlarmEngine({ logger: silent, alarms });
      // The engine goes in before the state service, because `reevaluate` is where a pause, an
      // acknowledgement or a schedule window reaches it — production wires it the same way.
      h = await buildHarness(db, { states: true, alarms: engine });
      assert.ok(h.states !== undefined);
      // Where it sits in production: inside the mutation's own transaction, behind the audit
      // sink every write already goes through. Adding a trigger during an outage has to arm the
      // outage, and only this makes that true.
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      // Every test starts from an empty tree. A trigger on the root applies to every sensor in
      // the installation — which is the behaviour under test, and exactly why an earlier test's
      // sensors must not still be sitting there Down.
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: 'device',
          host: '192.0.2.10',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      otherSensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'ping2',
          sensorType: 'icmp.ping',
        })
      ).id;
    });

    // ---------------------------------------------------------------------------------------
    // Helpers: drive states the way ingestion does, and read what the chain decided.
    // ---------------------------------------------------------------------------------------

    /**
     * One scan, written the way ingestion writes it: decide, write, then reconcile — all in one
     * transaction, in that order.
     */
    async function scan(sensors: readonly number[], ok: boolean, when: Date): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = sensors.map((id) => ({
        sensorId: id,
        at: when,
        outcome: ok ? 'ok' : 'error',
        message: ok ? 'reachable' : 'no ICMP reply from 192.0.2.10',
      }));
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, sensors, when);
      });
    }

    async function sweep(when: Date): Promise<number> {
      return (await db.tx((q) => engine.sweep(q, when))).fired;
    }

    async function queued(): Promise<QueuedRequest[]> {
      const rows = await db.query<{
        reason: string;
        template_id: string | null;
        state: SensorState;
        sensor_id: string;
        message: string;
        at: Date;
      }>(
        `SELECT reason, template_id::text AS template_id, state, sensor_id::text AS sensor_id,
                message, at
         FROM notification_request ORDER BY id`,
      );
      return rows.map((row) => ({
        reason: row.reason,
        templateId: row.template_id === null ? null : Number(row.template_id),
        state: row.state,
        sensorId: Number(row.sensor_id),
        message: row.message,
        at: row.at,
      }));
    }

    async function standing(): Promise<
      { sensorId: number; phase: string; nextDueAt: Date | null; suppressed: boolean }[]
    > {
      const rows = await db.query<{
        sensor_id: string;
        phase: string;
        next_due_at: Date | null;
        suppressed: boolean;
      }>(
        `SELECT sensor_id::text AS sensor_id, phase, next_due_at, suppressed
         FROM notification_alarm ORDER BY id`,
      );
      return rows.map((row) => ({
        sensorId: Number(row.sensor_id),
        phase: row.phase,
        nextDueAt: row.next_due_at,
        suppressed: row.suppressed,
      }));
    }

    async function downTrigger(
      on: number,
      settings: Record<string, unknown> = {},
    ): Promise<number> {
      const created = await triggers.create(testActor, on, {
        kind: 'state',
        settings: { state: 'down', initialTemplateId: INITIAL, ...settings },
      });
      return created.id;
    }

    // ---------------------------------------------------------------------------------------
    // Arming and the plain chain.
    // ---------------------------------------------------------------------------------------

    it('costs one query when nothing is configured to notify anybody', async () => {
      await scan([sensorId], false, T0);
      assert.equal(await alarms.anyWork(db), false);
      assert.deepEqual(await standing(), []);
      assert.deepEqual(await queued(), []);
    });

    it('arms an alarm when a sensor enters the state, and notifies at zero latency', async () => {
      await downTrigger(deviceId);
      // Two failures: the two-step rule takes a sensor to Warning first (docs/state-machine.md).
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(60));

      const armed = await standing();
      assert.equal(armed.length, 1);
      assert.equal(armed[0]?.phase, 'pending');

      assert.equal(await sweep(at(61)), 1);
      const sent = await queued();
      assert.equal(sent.length, 1);
      const [first] = sent;
      assert.ok(first !== undefined);
      assert.equal(first.reason, 'initial');
      assert.equal(first.templateId, INITIAL);
      assert.equal(first.state, 'down');
      assert.equal(first.sensorId, sensorId);
      // The probe's own words travel with it: "ETIMEDOUT" alone is not a diagnosis.
      assert.match(first.message, /no ICMP reply/);
      assert.equal((await standing())[0]?.phase, 'notified');
    });

    it('produces no notification at all for a blip under its latency', async () => {
      // WORKFLOW.MD §6, and PLAN.md's exit criterion: a 30-second blip on a five-minute latency.
      await downTrigger(deviceId, { initialLatencySeconds: 300, recoveryTemplateId: RECOVERY });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      assert.equal((await standing()).length, 1, 'the alarm is armed');

      assert.equal(await sweep(at(20)), 0, 'and not yet due');
      await scan([sensorId], true, at(30));

      assert.deepEqual(await standing(), [], 'the alarm is gone');
      assert.deepEqual(await queued(), [], 'and nobody was told anything, recovery included');
    });

    it('waits out the latency and then notifies', async () => {
      await downTrigger(deviceId, { initialLatencySeconds: 300 });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));

      assert.equal(await sweep(at(299)), 0);
      assert.equal(await sweep(at(311)), 1);
      assert.equal((await queued()).length, 1);
    });

    it('escalates, then repeats', async () => {
      await downTrigger(deviceId, {
        escalationLatencySeconds: 600,
        escalationTemplateId: ESCALATION,
        repeatMinutes: 5,
      });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));

      await sweep(at(11));
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['initial'],
      );
      // The escalation is measured from the state's beginning, so it is not due at 300s.
      assert.equal(await sweep(at(300)), 0);
      assert.equal(await sweep(at(610)), 1);
      await sweep(at(910));
      await sweep(at(1_210));

      const sent = await queued();
      assert.deepEqual(
        sent.map((request) => request.reason),
        ['initial', 'escalation', 'repeat', 'repeat'],
      );
      assert.deepEqual(
        sent.map((request) => request.templateId),
        [INITIAL, ESCALATION, ESCALATION, ESCALATION],
        'a repeat resends what the chain last said',
      );
    });

    it('runs the chain through a step that names no template', async () => {
      await triggers.create(testActor, deviceId, {
        kind: 'state',
        settings: {
          state: 'down',
          initialTemplateId: null,
          escalationLatencySeconds: 600,
          escalationTemplateId: ESCALATION,
        },
      });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));

      assert.equal(await sweep(at(11)), 1, 'the initial step fires');
      assert.deepEqual(await queued(), [], 'and sends nothing');
      assert.equal(await sweep(at(610)), 1);
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['escalation'],
        'which is the only reason the trigger exists',
      );
    });

    // ---------------------------------------------------------------------------------------
    // Recovery, acknowledgement and the states that are neither.
    // ---------------------------------------------------------------------------------------

    it('sends a recovery notification when the sensor comes back', async () => {
      await downTrigger(deviceId, { recoveryTemplateId: RECOVERY });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      await sweep(at(11));
      await scan([sensorId], true, at(120));

      const sent = await queued();
      assert.deepEqual(
        sent.map((request) => request.reason),
        ['initial', 'recovery'],
      );
      const recovery = sent[1];
      assert.ok(recovery !== undefined);
      assert.equal(recovery.templateId, RECOVERY);
      assert.equal(recovery.state, 'up');
      assert.deepEqual(await standing(), [], 'and the alarm is over');
    });

    it('does not call a pause a recovery', async () => {
      // A false all-clear is worse than silence, because somebody stops looking.
      await downTrigger(deviceId, { recoveryTemplateId: RECOVERY });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      await sweep(at(11));

      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'maintenance');

      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['initial'],
        'nothing was sent about the pause',
      );
      assert.deepEqual(await standing(), [], 'and the chain stopped');
    });

    it('cancels the escalation on acknowledgement and still fires the recovery', async () => {
      // PLAN.md's third exit criterion, in one test, because it is one behaviour: the two halves
      // pull in opposite directions and getting one right by breaking the other is the bug.
      await downTrigger(deviceId, {
        escalationLatencySeconds: 600,
        escalationTemplateId: ESCALATION,
        repeatMinutes: 5,
        recoveryTemplateId: RECOVERY,
      });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      await sweep(at(11));

      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'looking at it');

      const [held] = await standing();
      assert.ok(held !== undefined, 'the alarm stands');
      assert.equal(held.suppressed, true);
      assert.equal(held.nextDueAt, null, 'and owes nothing further');

      assert.equal(await sweep(at(710)), 0, 'so the escalation never comes');
      assert.equal(await sweep(at(4_000)), 0, 'nor any repeat');

      await scan([sensorId], true, at(5_000));
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['initial', 'recovery'],
        'and the recovery still fires',
      );
    });

    it('picks the escalation back up when an acknowledgement is lifted', async () => {
      await downTrigger(deviceId, {
        escalationLatencySeconds: 600,
        escalationTemplateId: ESCALATION,
      });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      await sweep(at(11));
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'mine');
      assert.equal(await sweep(at(710)), 0);

      // Un-acknowledged: the sensor is plainly Down again, and the operator who was putting the
      // escalation off should get it rather than a second initial notification.
      //
      // Swept relative to the *real* clock, not `T0`. Acknowledging and clearing are the two
      // calls in this file that take no timestamp — production has no synthetic clock, so they
      // stamp `new Date()` — and the chain resumes from when the acknowledgement was lifted. A
      // sweep at `at(810)` therefore only fired while the wall clock happened to be behind
      // 09:00Z, which is how this passed all morning and failed after lunch.
      await h.service.clearAcknowledgement(testActor, sensorId);
      const lifted = Date.now();
      await sweep(new Date(lifted + 700_000));
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['initial', 'escalation'],
      );
    });

    // ---------------------------------------------------------------------------------------
    // Configuration changes.
    // ---------------------------------------------------------------------------------------

    it('arms an outage that is already in progress when the trigger is created', async () => {
      // The case TriggerSync exists for. An operator who notices a device is down and adds
      // "tell me when things go down" means *this* one.
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      assert.deepEqual(await standing(), [], 'nothing was watching');

      await downTrigger(deviceId, { initialLatencySeconds: 300 });
      const armed = await standing();
      assert.equal(armed.length, 1);
      // Measured from the sensor's own `since`, so the latency has already elapsed.
      assert.equal(await sweep(at(330)), 1);
      assert.deepEqual(
        (await queued()).map((request) => request.reason),
        ['initial'],
      );
    });

    it('stands alarms down when the trigger is deleted', async () => {
      const triggerId = await downTrigger(deviceId);
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      assert.equal((await standing()).length, 1);

      await triggers.delete(testActor, triggerId);
      assert.deepEqual(await standing(), [], 'nothing is left to fire');
      assert.equal(await sweep(at(1_000)), 0);
    });

    it('stands alarms down when the trigger is switched off', async () => {
      const triggerId = await downTrigger(deviceId);
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));

      await triggers.update(testActor, triggerId, {
        kind: 'state',
        settings: { state: 'down', initialTemplateId: INITIAL },
        enabled: false,
      });
      assert.deepEqual(await standing(), []);
    });

    it('follows the object: moving a sensor out from under a trigger ends its alarm', async () => {
      await downTrigger(deviceId);
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      assert.equal((await standing()).length, 1);

      const elsewhere = await h.service.create(testActor, {
        kind: 'device',
        parentId: (await h.repository.get(db, deviceId))?.parentId ?? h.rootId,
        name: 'elsewhere',
        host: '192.0.2.11',
      });
      await h.service.move(testActor, sensorId, elsewhere.id, { kind: 'none' });

      assert.deepEqual(await standing(), [], 'the trigger no longer applies');
      assert.deepEqual(await queued(), [], 'and nothing recovered, so nobody was told');
    });

    it('stands alarms down when a subtree is fenced off from its triggers', async () => {
      // `N-16`. Fencing a subtree off is the same kind of change as deleting the trigger, for
      // the sensors below it: what was watching them no longer does, so a chain in progress is a
      // chain nobody asked for.
      await downTrigger(h.rootId);
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      assert.equal((await standing()).length, 1);

      await h.service.update(
        testActor,
        deviceId,
        { kind: 'device', inheritsTriggers: false },
        { kind: 'none' },
      );
      assert.deepEqual(await standing(), [], 'the root’s trigger no longer reaches it');
      assert.deepEqual(await queued(), [], 'and nothing recovered, so nobody was told');

      await h.service.update(
        testActor,
        deviceId,
        { kind: 'device', inheritsTriggers: true },
        { kind: 'none' },
      );
      const armed = await standing();
      assert.equal(armed.length, 1, 'taking the fence down arms the outage that is still running');
    });

    it('applies an inherited trigger to every sensor beneath it', async () => {
      await downTrigger(h.rootId);
      await scan([sensorId, otherSensorId], false, T0);
      await scan([sensorId, otherSensorId], false, at(10));
      assert.equal((await standing()).length, 2);

      assert.equal(await sweep(at(11)), 2);
      assert.deepEqual(
        (await queued()).map((request) => request.sensorId).sort((a, b) => a - b),
        [sensorId, otherSensorId].sort((a, b) => a - b),
      );
    });

    it('runs two triggers on one sensor as two independent chains', async () => {
      // Accumulating inheritance (N-01) means a sensor can carry several. One escalating and one
      // not must not interfere.
      await downTrigger(h.rootId, { initialTemplateId: INITIAL });
      await downTrigger(deviceId, {
        initialTemplateId: null,
        escalationLatencySeconds: 600,
        escalationTemplateId: ESCALATION,
      });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      assert.equal((await standing()).length, 2);

      await sweep(at(11));
      assert.deepEqual(
        (await queued()).map((request) => request.templateId),
        [INITIAL],
      );
      await sweep(at(700));
      assert.deepEqual(
        (await queued()).map((request) => request.templateId),
        [INITIAL, ESCALATION],
      );
    });

    // ---------------------------------------------------------------------------------------
    // Durability, and the guards.
    // ---------------------------------------------------------------------------------------

    it('arms one chain for an outage behind a dependency, not one per sensor', async () => {
      // `CLAUDE.md`: one outage, one alarm. `M-17` proved the *states* behave — one Down, forty
      // Paused — and left the notification count to `N-15`. This is the half N-02 owes, asserted
      // immediately after the batch that took everything down rather than once the storm has
      // settled, because every dependent records its own Down in that batch on its way to being
      // paused (`M-17`) and the question is whether any of them armed a chain.
      //
      // Measured, not assumed: reversing the two reactions below still ends with one alarm. The
      // engine does arm both for a moment, and then the dependency reaction's own `reevaluate`
      // re-reconciles the sensors it just paused — in the same transaction, so nothing outside
      // ever sees the pair. That is reconciliation earning its keep: two orderings, one answer.
      // The order below is still the right one, because doing the work once beats arming a chain
      // and standing it down two statements later.
      const master = sensorId;
      await h.service.setDependency(testActor, otherSensorId, 'object', master, undefined);
      await downTrigger(h.rootId);

      const states = h.states;
      assert.ok(states !== undefined);
      const round = async (when: Date): Promise<void> => {
        const results: SensorResult[] = [master, otherSensorId].map((id) => ({
          sensorId: id,
          at: when,
          outcome: 'error' as const,
          message: 'switch unplugged',
        }));
        const decisions = await states.decide(results);
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
          // This order, and not the other one. Reversing these two lines leaves the assertion
          // below seeing two armed alarms.
          // The production order. Not load-bearing, as it turns out — see the note above.
          await h.dependencies?.react(q, decisions.transitions, when);
          await engine.react(q, [master, otherSensorId], when);
        });
      };

      await round(T0);
      // The second failure is where the two-step rule takes both sensors Down, and where the
      // dependency pauses the dependent — all in one transaction.
      await round(at(60));

      assert.deepEqual(
        (await standing()).map((alarm) => alarm.sensorId),
        [master],
        'the dependent is Paused by the same transaction, and a paused sensor is nobody’s alarm',
      );
      await sweep(at(61));
      assert.equal((await queued()).length, 1, 'one outage, one notification');
    });

    it('survives a restart, because the due time is in the table and not in a timer', async () => {
      await downTrigger(deviceId, { initialLatencySeconds: 300 });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));

      // A fresh engine, holding nothing: what a restarted ms-core has.
      const restarted = new AlarmEngine({ logger: silent });
      const fired = await db.tx((q) => restarted.sweep(q, at(400)));
      assert.equal(fired.fired, 1);
      assert.equal(fired.queued, 1);
    });

    it('reports when the next alarm falls due, so N-04 can wait rather than poll', async () => {
      assert.equal(await engine.nextDueAt(db), null);
      await downTrigger(deviceId, { initialLatencySeconds: 300 });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      // From the sensor's own `since`, which is the *second* failure: the two-step rule takes
      // it to Warning first.
      assert.deepEqual(await engine.nextDueAt(db), at(310));
    });

    it('stands a stale alarm down rather than firing it', async () => {
      // The last thing between a row nothing cleaned up and a page at 3 a.m. Forced by hand,
      // because every path that goes through a transaction clears it properly.
      await downTrigger(deviceId, { initialLatencySeconds: 300 });
      await scan([sensorId], false, T0);
      await scan([sensorId], false, at(10));
      await db.query(`UPDATE sensor_runtime SET state = 'up' WHERE object_id = $1`, [sensorId]);

      assert.equal(await sweep(at(400)), 0);
      assert.deepEqual(await standing(), [], 'and the row is gone');
      assert.deepEqual(await queued(), []);
    });

    it('bounds one sweep and comes straight back for the rest', async () => {
      const bounded = new AlarmEngine({ logger: silent, maxPerSweep: 1 });
      await downTrigger(h.rootId);
      await scan([sensorId, otherSensorId], false, T0);
      await scan([sensorId, otherSensorId], false, at(10));

      const sweeper = new AlarmScheduler({ db, engine: bounded, logger: silent });
      const fired = await sweeper.sweep(at(11));
      assert.equal(fired, 2, 'both, in two rounds, without waiting for the next tick');
      assert.equal((await queued()).length, 2);
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from '../../src/db/pool.js';
import { AlarmEngine } from '../../src/notifications/engine.js';
import { AlarmScheduler } from '../../src/notifications/scheduler.js';
import { TriggerService } from '../../src/triggers/service.js';
import { DatabaseAuditSink } from '../../src/audit/store.js';
import { writeRuntimes, writeStateHistory } from '../../src/state/runtime.js';
import type { SensorResult } from '../../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor, type Harness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement, per `CLAUDE.md`: "performance claims need a measurement committed to
 * the repo, not an assertion".
 *
 * The claim is `N-04`'s own: **timers cancel on recovery and on acknowledgement; survive a
 * restart; no leaks across thousands of sensors.** The first two are behaviour and are asserted
 * in `alarm-scheduler.test.ts`. The third is a cost, and the only honest way to state a cost is
 * to measure it.
 *
 * The design being measured is the absence of a design: there is no timer per pending
 * notification. A `setTimeout` apiece would be 2,000 live handles here — and 15,000 in the v1
 * target installation, where 5,000 sensors each carry an initial, an escalation and a repeat —
 * every one of them a closure holding a sensor id, every cancellation a chance to leak one, and
 * all of them gone after a restart. The due times are rows instead, and this measures what that
 * costs: one timer, one indexed query, and a reaction whose work is proportional to the batch
 * rather than to the installation.
 */
const SENSORS = 2_000;

/**
 * What one reaction over the whole installation may cost.
 *
 * Generous on purpose — this runs on whatever the developer or CI has — and still an order of
 * magnitude below the point where a scan interval would notice. It is a regression bound, not a
 * target: what would fail it is an accidental per-sensor query, which turns 2,000 into minutes.
 */
const REACTION_BUDGET_MS = 5_000;

describe(
  'notification timer cost',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    const sensorIds: number[] = [];
    /**
     * A clock that only ever moves forward, shared by both measurements.
     *
     * A result is applied only if it is strictly newer than the last one this sensor saw — the
     * predicate that makes the probe's at-least-once delivery safe (`docs/state-machine.md`). A
     * second test starting from a fresh `new Date()` would hand every sensor a result older than
     * the one the first test left it with, and every one of them would be discarded as a
     * duplicate.
     */
    let clock = Date.now();
    const tick = (minutes = 1): Date => {
      clock += minutes * 60_000;
      return new Date(clock);
    };

    before(async () => {
      scratch = await createScratchDatabase('alarmperf');
      db = scratch.db;
      engine = new AlarmEngine({
        logger: silent,
        maxPerSweep: SENSORS,
        onArmed: () => {
          scheduler.wake();
        },
      });
      h = await buildHarness(db, { states: true, alarms: engine });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Alarm perf probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Alarm perf device',
        host: '192.0.2.60',
      });
      for (let index = 0; index < SENSORS; index += 1) {
        const sensor = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: `alarm-perf-${String(index)}`,
          sensorType: 'icmp.ping',
        });
        sensorIds.push(sensor.id);
      }

      // One trigger on the root, inherited by every sensor — the shape `WORKFLOW.MD §6` uses as
      // its own example of what inheritance is for, and the worst case for the engine.
      const triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });
      await triggers.create(testActor, h.rootId, {
        kind: 'state',
        settings: {
          state: 'down',
          initialLatencySeconds: 300,
          initialTemplateId: 1,
          escalationLatencySeconds: 1_800,
          escalationTemplateId: 2,
          repeatMinutes: 60,
        },
      });
    });

    after(async () => {
      scheduler.stop();
      await scratch.drop();
    });

    /** One scan of everything, written the way ingestion writes it. */
    async function scanAll(ok: boolean, when: Date): Promise<number> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = sensorIds.map((sensorId) => ({
        sensorId,
        at: when,
        outcome: ok ? 'ok' : 'error',
        message: ok ? 'reachable' : 'no ICMP reply',
      }));
      const decisions = await states.decide(results);
      const startedAt = process.hrtime.bigint();
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, sensorIds, when);
      });
      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    }

    async function standing(): Promise<number> {
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_alarm',
      );
      return Number(rows[0]?.n ?? 0);
    }

    it(`arms, holds and cancels ${String(SENSORS)} chains with one timer`, async () => {
      scheduler.start();
      await sleep(50);
      const idleTimers = timerCount();

      // Warning, then Down: the two-step rule (docs/state-machine.md §2.1).
      const first = await scanAll(false, tick());
      const armAt = await scanAll(false, tick());
      assert.equal(await standing(), SENSORS, 'every sensor has a chain pending');

      // Three more scans while every one of them is inside its five-minute latency: the steady
      // state of a large outage, and the one that a per-sensor design pays for repeatedly.
      const holds: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        holds.push(await scanAll(false, tick()));
      }

      const armedTimers = timerCount();
      const recoverAt = await scanAll(true, tick());
      assert.equal(await standing(), 0, 'and every one of them cancels');
      const clearedTimers = timerCount();

      const worstHold = Math.max(...holds);
      // eslint-disable-next-line no-console -- the measurement is the point of this file
      console.log(
        `\n  ${String(SENSORS)} sensors, one inherited state trigger\n` +
          `    first failure (nothing armed): ${first.toFixed(0)} ms\n` +
          `    arming ${String(SENSORS)} chains:      ${armAt.toFixed(0)} ms\n` +
          `    holding them (worst of 3):    ${worstHold.toFixed(0)} ms\n` +
          `    cancelling all of them:       ${recoverAt.toFixed(0)} ms\n` +
          `    timers: ${String(idleTimers)} idle, ${String(armedTimers)} with ` +
          `${String(SENSORS)} pending, ${String(clearedTimers)} after\n`,
      );

      // The claim: the count never *grows* with the number of pending notifications. Not
      // equality — between cycles the scheduler is momentarily holding no timer at all, so a
      // sample taken then legitimately reads one fewer, and asserting equality would be
      // asserting when the sample was taken rather than what the design does.
      assert.ok(
        armedTimers <= idleTimers,
        `${String(armedTimers)} timers with ${String(SENSORS)} pending, ${String(idleTimers)} idle`,
      );
      assert.ok(
        clearedTimers <= idleTimers,
        `${String(clearedTimers)} timers after cancelling, ${String(idleTimers)} idle`,
      );
      for (const [label, ms] of [
        ['arming', armAt],
        ['holding', worstHold],
        ['cancelling', recoverAt],
      ] as const) {
        assert.ok(ms < REACTION_BUDGET_MS, `${label} took ${ms.toFixed(0)} ms`);
      }
    });

    it(`fires ${String(SENSORS)} due chains in one sweep`, async () => {
      // A core that was down through an outage comes back with everything due at once. The
      // sweep is bounded per round and loops while it comes back full, so the backlog drains in
      // one wake rather than one alarm per tick.
      await scanAll(false, tick());
      await scanAll(false, tick());
      assert.equal(await standing(), SENSORS);

      // Long past every initial latency, which is what a restart after an outage looks like.
      const when = tick(60);
      // Stopped first: the scheduler started in the previous measurement is still cycling, and a
      // sweep that arrives while one is in flight returns zero rather than re-entering. Timing a
      // deterministic sweep means being the only one running it.
      scheduler.stop();
      const startedAt = process.hrtime.bigint();
      const fired = await scheduler.sweep(when);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

      // eslint-disable-next-line no-console -- the measurement is the point of this file
      console.log(`    firing ${String(fired)} due steps:         ${ms.toFixed(0)} ms\n`);

      // Two steps per sensor, not one: an hour of outage is past both the five-minute initial
      // latency and the thirty-minute escalation, so each chain owes an initial notification and
      // an escalation. That takes two rounds, which is the loop earning its keep — a scheduler
      // that fired one bounded batch per wake would need a second tick to finish, and a design
      // with a timer per step would have had 4,000 of them to rebuild from nothing.
      assert.equal(fired, SENSORS * 2, 'every chain caught all the way up, in one sweep');
      assert.ok(ms < REACTION_BUDGET_MS, `firing took ${ms.toFixed(0)} ms`);

      const queued = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      assert.equal(Number(queued[0]?.n ?? 0), SENSORS * 2);
    });
  },
);

/**
 * How many timers this process is holding.
 *
 * `process.getActiveResourcesInfo()` names every handle the event loop knows about. Counting the
 * `Timeout`s is the only way to assert "one timer, not one per sensor" without reaching into
 * Node's internals — and it is the assertion the whole design rests on.
 */
function timerCount(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

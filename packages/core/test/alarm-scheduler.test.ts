import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmRepository } from '../src/notifications/repository.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { pollWithin } from './support/within.js';
import { otherTimers, watchNotifierTimers } from './support/notifier-timers.js';
import { Reach, Visibility } from '../src/auth/access.js';

const available = await databaseAvailable();

const INITIAL = 401;

/**
 * How long a test will wait for the scheduler to do something before calling it broken.
 *
 * Generous, because these are correctness assertions and not timing ones: a dozen test files
 * share one PostgreSQL, and a round trip that normally takes milliseconds can take seconds under
 * that. The timing claims are made through `stats.nextWakeAt` instead, which does not care how
 * busy the database is.
 */
const PATIENCE_MS = 20_000;

/** Until `predicate` holds, or a failure naming `what` at `PATIENCE_MS`, asking no more after. */
function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  return pollWithin(PATIENCE_MS, what, predicate, 10);
}

// -------------------------------------------------------------------------------------------
// The sleep arithmetic, without waiting for any of it.
// -------------------------------------------------------------------------------------------

describe('how long the scheduler sleeps', () => {
  const scheduler = new AlarmScheduler({
    db: null as unknown as Database,
    engine: null as unknown as AlarmEngine,
    logger: silent,
    maxSleepMs: 60_000,
    minSleepMs: 25,
  });
  const now = new Date('2026-08-26T13:00:00Z');
  const inMs = (ms: number): Date => new Date(now.getTime() + ms);

  it('sleeps until the next due time', () => {
    assert.equal(scheduler.delayFor(inMs(4_000), now), 4_000);
  });

  it('caps a distant due time', () => {
    // The safety net, not the schedule: a wait that only a poke can end is a wait one lost poke
    // turns into silence. It is also what bounds the damage from a wall-clock jump.
    assert.equal(scheduler.delayFor(inMs(3 * 3_600_000), now), 60_000);
  });

  it('caps an empty table the same way', () => {
    assert.equal(scheduler.delayFor(null, now), 60_000);
  });

  it('never busy-loops on a due time in the past', () => {
    // An alarm a sweep cannot clear would otherwise be re-queried as fast as the event loop
    // allows.
    assert.equal(scheduler.delayFor(inMs(-1), now), 25);
    assert.equal(scheduler.delayFor(inMs(-3_600_000), now), 25);
    assert.equal(scheduler.delayFor(now, now), 25);
  });

  it('is never negative, whatever it is handed', () => {
    for (const offset of [-1e12, -1, 0, 1, 24, 25, 26, 1e12]) {
      assert.ok(scheduler.delayFor(inMs(offset), now) >= 25, String(offset));
    }
  });
});

// -------------------------------------------------------------------------------------------
// What the stats say while a sweep is still running, with no database and no clock.
// -------------------------------------------------------------------------------------------

/**
 * `P-20` was filed as a flaky test — "counts what it did, for Core Health" reading
 * `{"sweeps":3,"fired":0,"wakes":1}` about one run in ten inside the full suite — and the ticket
 * guessed at an injected clock. It was not a timing assertion. It was a real counter bug that
 * only a busy machine made wide enough to see.
 *
 * `sweep()` drains a backlog in rounds. Each round commits its own transaction, so the
 * `notification_request` rows are visible the moment it returns — but `#fired` was added up
 * across the whole loop and applied once at the end. Between those two points the requests
 * exist and the number describing them is zero, and the loop only *continues* when a round came
 * back full: the gap is widest during exactly the backlog Core Health is most worth reading
 * during. The test was not flaky, it was right one time in ten.
 *
 * Deterministic here because nothing real is involved: a fake engine reports one full round then
 * an empty one, and reads the counter from inside the second round — which is a moment that
 * genuinely exists, after the first round's commit and before the loop ends.
 */
describe('what the stats say while a sweep is still running', () => {
  it('counts a fired step as its round commits, not once the loop ends', async () => {
    const readings: number[] = [];
    let rounds = 0;

    const engine = {
      sweep: () => {
        rounds += 1;
        if (rounds === 1) return Promise.resolve({ fired: 3, queued: 3 });
        // Round one has committed. Anything reading the stats at this moment must already know
        // about its three requests. Reading `scheduler` here is safe and deliberate: the closure
        // captures the binding, and nothing calls it until `sweep()` is under way.
        readings.push(scheduler.stats.fired);
        return Promise.resolve({ fired: 0, queued: 0 });
      },
    } as unknown as AlarmEngine;

    // Never touched: the fake engine ignores the queryable it is handed.
    const db = {
      tx: <T>(fn: (q: never) => Promise<T>): Promise<T> => fn(undefined as never),
    } as unknown as Database;

    const scheduler = new AlarmScheduler({ db, engine, logger: silent });
    const fired = await scheduler.sweep();

    assert.equal(fired, 3);
    assert.deepEqual(readings, [3], 'the counter lagged the rows it counts');
    assert.equal(scheduler.stats.fired, 3);
    assert.equal(scheduler.stats.sweeps, 1, 'one sweep, however many rounds it took');
  });

  it('counts nothing, and calls the wake idle, when every round is empty', async () => {
    const engine = {
      sweep: () => Promise.resolve({ fired: 0, queued: 0 }),
    } as unknown as AlarmEngine;
    const db = {
      tx: <T>(fn: (q: never) => Promise<T>): Promise<T> => fn(undefined as never),
    } as unknown as Database;

    const scheduler = new AlarmScheduler({ db, engine, logger: silent });
    assert.equal(await scheduler.sweep(), 0);
    assert.equal(scheduler.stats.fired, 0);
    assert.equal(scheduler.stats.idleWakes, 1);
  });
});

// `P-247`: how late the scheduler is, on the clock its timer runs on. Measured as the wall clock
// less `nextWakeAt`, a forward step of the wall clock read as a sweep that never ran.
describe('how overdue the scheduler is', () => {
  it('is measured on the monotonic clock, so a wall-clock step is not lateness', async () => {
    let mono = 1_000_000;
    const engine = {
      sweep: () => Promise.resolve({ fired: 0, queued: 0 }),
      nextDueAt: () => Promise.resolve(null),
    } as unknown as AlarmEngine;
    const db = {
      tx: <T>(fn: (q: never) => Promise<T>): Promise<T> => fn(undefined as never),
    } as unknown as Database;
    const scheduler = new AlarmScheduler({
      db,
      engine,
      logger: silent,
      maxSleepMs: 60_000,
      settleMs: [],
      monotonicNow: () => mono,
    });
    assert.equal(scheduler.stats.overdueMs, 0, 'nothing armed is not late');
    const realNow = Date.now;
    try {
      scheduler.start();
      await until(
        () => scheduler.stats.sweeps >= 1 && scheduler.stats.nextWakeAt !== null,
        'a sweep',
      );
      await until(
        () => (scheduler.stats.nextWakeAt?.getTime() ?? 0) - realNow() > 30_000,
        'the scheduler to sleep the cap',
      );
      assert.equal(scheduler.stats.overdueMs, 0, 'asleep with its wake ahead');

      // The wall clock jumps an hour ahead; the timer's clock does not move.
      const stepped = realNow() + 3_600_000;
      Date.now = (): number => stepped;
      assert.equal(scheduler.stats.overdueMs, 0, 'a step of the wall clock is not lateness');

      // The timer's own clock passing its wake is.
      mono += 60_000 + 90_000;
      assert.equal(scheduler.stats.overdueMs, 90_000);
    } finally {
      Date.now = realNow;
      scheduler.stop();
    }
    assert.equal(scheduler.stats.overdueMs, 0, 'a stopped scheduler is not late');
  });
});

// -------------------------------------------------------------------------------------------
// Against a real database.
// -------------------------------------------------------------------------------------------

describe(
  'the latency timer engine',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let triggers: TriggerService;
    let deviceId: number;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('alarmtimers');
      db = scratch.db;
      engine = new AlarmEngine({
        logger: silent,
        alarms: new AlarmRepository(),
        onArmed: () => {
          scheduler.wake();
        },
      });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
    });

    after(async () => {
      scheduler.stop();
      await scratch.drop();
    });

    beforeEach(async () => {
      scheduler.stop();
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
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
          host: '192.0.2.40',
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
    });

    async function scan(sensors: readonly number[], ok: boolean): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const when = new Date();
      const results: SensorResult[] = sensors.map((id) => ({
        sensorId: id,
        at: when,
        outcome: ok ? 'ok' : 'error',
        message: ok ? 'reachable' : 'no ICMP reply',
      }));
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, sensors, when);
      });
    }

    async function requests(): Promise<number> {
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      return Number(rows[0]?.n ?? 0);
    }

    async function alarmsStanding(): Promise<{ nextDueAt: Date | null; suppressed: boolean }[]> {
      const rows = await db.query<{ next_due_at: Date | null; suppressed: boolean }>(
        'SELECT next_due_at, suppressed FROM notification_alarm ORDER BY id',
      );
      return rows.map((row) => ({ nextDueAt: row.next_due_at, suppressed: row.suppressed }));
    }

    /**
     * One sweep, driven by a scheduler nobody started.
     *
     * A stopped scheduler refuses to sweep — see `AlarmScheduler.sweep` — so asking the one this
     * test just stopped would return zero without looking at a single row, and every assertion
     * built on it would hold for the wrong reason.
     */
    async function freshSweep(now: Date): Promise<number> {
      return new AlarmScheduler({ db, engine, logger: silent }).sweep(now);
    }

    async function downTrigger(settings: Record<string, unknown> = {}): Promise<number> {
      const created = await triggers.create(testActor, deviceId, {
        kind: 'state',
        settings: { state: 'down', initialTemplateId: INITIAL, ...settings },
      });
      return created.id;
    }

    // -------------------------------------------------------------------------------------
    // Firing on time, without a tick.
    // -------------------------------------------------------------------------------------

    it('is woken by an alarm armed after it went to sleep', async () => {
      // The whole point of `wake()`. Sleeping until the next due time is no good if the alarm
      // was armed after the scheduler worked out when that was.
      //
      // Asserted through the sleep it was holding rather than through a stopwatch: on a loaded
      // machine a round trip can take a second, and a test that measured milliseconds would be
      // measuring PostgreSQL. If the scheduler is asleep for the full cap and the notification
      // arrives anyway, the wake is the only thing that could have sent it.
      await downTrigger();
      scheduler.start();
      await until(
        () => (scheduler.stats.nextWakeAt?.getTime() ?? 0) - Date.now() > 30_000,
        'the scheduler to settle into a long sleep',
      );
      const wakesBefore = scheduler.stats.wakes;

      await scan([sensorId], false);
      await scan([sensorId], false);
      await until(async () => (await requests()) === 1, 'the notification to be sent');
      assert.ok(scheduler.stats.wakes > wakesBefore, 'and it was the engine that woke it');
    });

    it('waits out a latency and then fires, without polling in between', async () => {
      // Asserted through the sleep it schedules rather than through elapsed time. A test that
      // slept for part of a latency and then checked nothing had been sent would be racing the
      // latency on a loaded machine, and would measure PostgreSQL when it lost.
      const latencySeconds = 3;
      await downTrigger({ initialLatencySeconds: latencySeconds });
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      assert.equal((await alarmsStanding()).length, 1, 'armed');

      await until(() => {
        const until = (scheduler.stats.nextWakeAt?.getTime() ?? 0) - Date.now();
        // Neither the 60-second cap nor a one-second tick: it has read the due time and is
        // sleeping until exactly that. This is the whole claim, and counting sweeps is not —
        // the settle re-checks after a wake (see `settleMs`) make the count of an idle wait
        // indistinguishable from a tick's, while the sleep it schedules is not.
        return until > 500 && until <= latencySeconds * 1_000;
      }, 'the scheduler to sleep until the due time');

      await until(async () => (await requests()) === 1, 'the notification to be sent');
    });

    it('sleeps rather than polling when nothing is pending', async () => {
      scheduler.start();
      await sleep(300);
      // One sweep at start-up, and then it sleeps until the cap. The old tick would have run
      // three by now, and thirty by the time an operator noticed.
      assert.ok(scheduler.stats.sweeps <= 2, `swept ${String(scheduler.stats.sweeps)} times idle`);
      const nextWakeAt = scheduler.stats.nextWakeAt;
      assert.ok(nextWakeAt !== null);
      assert.ok(
        nextWakeAt.getTime() - Date.now() > 30_000,
        'and is asleep for a long time, not a short one',
      );
    });

    // -------------------------------------------------------------------------------------
    // What the ticket asks for: cancellation, restart, no leaks.
    // -------------------------------------------------------------------------------------

    it('cancels on recovery, leaving nothing that could fire', async () => {
      await downTrigger({
        escalationLatencySeconds: 1,
        escalationTemplateId: 403,
        repeatMinutes: 1,
        recoveryTemplateId: 402,
      });
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      await until(async () => (await requests()) === 1, 'the initial notification');

      await scan([sensorId], true);
      assert.deepEqual(await alarmsStanding(), [], 'the timer is the row, and the row is gone');

      // A sweep an hour into the future, rather than a wait long enough to outlive the
      // escalation. Deterministic: if anything were still armed it would be long overdue and
      // would fire, so "nothing fires" is a statement about the rows and not about the clock.
      //
      // A *fresh* scheduler drives it. A stopped one refuses to sweep at all, which would make
      // this assertion pass without looking at anything.
      scheduler.stop();
      assert.equal(await freshSweep(hence(3_600_000)), 0);
      assert.equal(await requests(), 2, 'the initial and the recovery, and nothing else');
    });

    it('sends nothing at all when a blip clears inside its latency', async () => {
      // The other half of cancellation, and the one that is easy to get backwards: nothing was
      // sent, so nobody is owed a recovery notification either. `WORKFLOW.MD §6`'s 30-second
      // blip on a five-minute latency produces no notification at all — not one saying it is
      // better now.
      await downTrigger({ initialLatencySeconds: 60, recoveryTemplateId: 402 });
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      assert.equal((await alarmsStanding()).length, 1, 'armed');

      await scan([sensorId], true);
      assert.deepEqual(await alarmsStanding(), []);
      scheduler.stop();
      assert.equal(await freshSweep(hence(3_600_000)), 0);
      assert.equal(await requests(), 0);
    });

    it('cancels on acknowledgement, and the recovery still fires', async () => {
      await downTrigger({
        initialLatencySeconds: 0,
        escalationLatencySeconds: 1,
        escalationTemplateId: 403,
        repeatMinutes: 1,
        recoveryTemplateId: 402,
      });
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      await until(async () => (await requests()) === 1, 'the initial notification');

      await h.service.acknowledge(
        testActor,
        sensorId,
        { kind: 'indefinite' },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'mine',
      );
      const [held] = await alarmsStanding();
      assert.ok(held !== undefined, 'the alarm stands');
      assert.equal(held.suppressed, true);
      assert.equal(held.nextDueAt, null, 'and there is no due time left to fire');

      // An hour into the future, where the escalation and every repeat would be long overdue.
      // A suppressed alarm has no due time, so there is nothing for the sweep to find.
      scheduler.stop();
      assert.equal(await freshSweep(hence(3_600_000)), 0, 'nothing escalated');
      assert.equal(await requests(), 1);

      scheduler.start();
      await scan([sensorId], true);
      await until(async () => (await requests()) === 2, 'the recovery notification');
    });

    it('survives a restart: a new scheduler fires what the old one was sleeping on', async () => {
      await downTrigger({ initialLatencySeconds: 1 });
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      assert.equal(await requests(), 0);

      // Killed mid-wait, the way a deploy does it.
      scheduler.stop();
      const restarted = new AlarmScheduler({ db, engine, logger: silent });
      restarted.start();
      try {
        await until(async () => (await requests()) === 1, 'the restarted scheduler to fire it');
      } finally {
        restarted.stop();
      }
    });

    it('keeps one timer for the whole installation, however many alarms are pending', async () => {
      // "No leaks across thousands of sensors" — structural rather than promised. A timer per
      // pending notification would be one closure per sensor, one cancellation to forget per
      // recovery, and nothing at all after a restart.
      const sensors = [sensorId];
      for (let index = 0; index < 40; index += 1) {
        sensors.push(
          (
            await h.service.create(testActor, {
              kind: 'sensor',
              parentId: deviceId,
              name: `ping-${String(index)}`,
              sensorType: 'icmp.ping',
            })
          ).id,
        );
      }
      await downTrigger({ initialLatencySeconds: 30 });
      // The notification code's own timers, `unref`'d included: the scheduler's is, and a count
      // of the timers holding the process open never saw it (`P-252`).
      const notifier = watchNotifierTimers();
      try {
        scheduler.start();
        // Seen before it is relied on, or a count that cannot see it passes whatever happens.
        await until(() => notifier.live() === 1, 'the scheduler’s timer to be seen');
        await sleep(50);
        const others = otherTimers(db);

        await scan(sensors, false);
        await scan(sensors, false);
        assert.equal((await alarmsStanding()).length, sensors.length, 'all of them are pending');
        await sleep(100);
        // At most one, rather than exactly one: between cycles the scheduler is momentarily
        // holding no timer at all, so equality would assert when the sample was taken.
        assert.ok(notifier.live() <= 1, `${String(notifier.live())} timers with alarms pending`);
        assert.ok(otherTimers(db) <= others, 'and nothing else took a timer per alarm');

        await scan(sensors, true);
        assert.deepEqual(await alarmsStanding(), [], 'and all of them cancel together');
        assert.ok(notifier.live() <= 1);
        assert.ok(otherTimers(db) <= others);
      } finally {
        notifier.stop();
      }
    });

    it('counts what it did, for Core Health', async () => {
      // CLAUDE.md: any new subsystem with a queue, a pool or a connection adds a metric. P-12 is
      // where these land.
      await downTrigger();
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      await until(async () => (await requests()) === 1, 'the notification to be sent');

      const stats = scheduler.stats;
      const seen = JSON.stringify(stats);
      assert.ok(stats.sweeps > 0, seen);
      assert.ok(stats.fired >= 1, seen);
      assert.ok(stats.wakes > 0, `the engine should have poked it when it armed: ${seen}`);
      assert.ok(stats.nextWakeAt !== null, `it should say when it looks again: ${seen}`);
    });

    it('looks again when a wake arrives before the commit it is about', async () => {
      // The race that cost a test twenty seconds before it was understood. `wake()` fires inside
      // the arming transaction, so a scheduler quick enough to sweep before the commit sees
      // nothing — and a scheduler that believed that answer would go back to sleep for the full
      // cap while the alarm sat there committed and overdue.
      //
      // Forced rather than raced: the wake is delivered while a long transaction is still open,
      // which is the same shape and happens every time.
      await downTrigger();
      scheduler.start();
      await until(
        () => (scheduler.stats.nextWakeAt?.getTime() ?? 0) - Date.now() > 30_000,
        'the scheduler to settle into a long sleep',
      );

      const states = h.states;
      assert.ok(states !== undefined);
      await scan([sensorId], false);
      const when = new Date();
      const decisions = await states.decide([
        { sensorId, at: when, outcome: 'error', message: 'no ICMP reply' },
      ]);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, [sensorId], when);
        // Still inside the transaction, and the wake has already been delivered. Anything the
        // scheduler reads now cannot see the alarm.
        assert.equal(await requests(), 0, 'nothing is visible outside this transaction yet');
        await sleep(120);
      });

      await until(async () => (await requests()) === 1, 'the notification to be sent anyway');
    });

    it('would sleep through that commit with no re-check, which is why there is one', async () => {
      // The same forced race against a scheduler configured to believe an empty sweep. It ends
      // asleep on the cap with an alarm committed and overdue — which is the bug, demonstrated
      // rather than described.
      const credulous = new AlarmScheduler({ db, engine, logger: silent, settleMs: [] });
      try {
        await downTrigger();
        credulous.start();
        await until(
          () => (credulous.stats.nextWakeAt?.getTime() ?? 0) - Date.now() > 30_000,
          'it to settle into a long sleep',
        );

        const states = h.states;
        assert.ok(states !== undefined);
        await scan([sensorId], false);
        const when = new Date();
        const decisions = await states.decide([
          { sensorId, at: when, outcome: 'error', message: 'no ICMP reply' },
        ]);
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
          await engine.react(q, [sensorId], when);
          credulous.wake();
          await sleep(120);
        });

        await sleep(300);
        assert.equal(await requests(), 0, 'nothing was sent');
        const asleepFor = (credulous.stats.nextWakeAt?.getTime() ?? 0) - Date.now();
        assert.ok(asleepFor > 30_000, `and it is asleep for another ${String(asleepFor)} ms`);
      } finally {
        credulous.stop();
      }
    });

    it('is not re-entered by a wake during a sweep', async () => {
      await downTrigger();
      scheduler.start();
      await scan([sensorId], false);
      await scan([sensorId], false);
      for (let index = 0; index < 50; index += 1) scheduler.wake();
      await until(async () => (await requests()) === 1, 'the notification to be sent');
      await sleep(100);
      assert.equal(await requests(), 1, 'fifty wakes are still one notification');
    });
  },
);

/** A moment far enough ahead that anything still armed would be overdue. */
function hence(ms: number): Date {
  return new Date(Date.now() + ms);
}

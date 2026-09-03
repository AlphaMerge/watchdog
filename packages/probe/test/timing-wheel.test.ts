import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { phaseFor, TimingWheel, type ScheduledTask } from '../src/scheduler/wheel.js';
import { V1_TARGET_BURST } from '../src/measured.js';

const silent = pino({ level: 'silent' });
const SECOND = 1_000_000_000n;

/**
 * A wheel on a clock the test owns.
 *
 * The only honest way to test a scheduler: drive time rather than sleep and hope. An hour of
 * scheduling at the v1 target runs in milliseconds, and a suspended machine is one assignment.
 */
function harness(options: { slots?: number } = {}) {
  let ns = 0n;
  let wallMs = 1_700_000_000_000;
  const fired: { tick: number; ids: number[] }[] = [];

  const wheel = new TimingWheel({
    logger: silent,
    onDue: (ids, tick) => fired.push({ tick, ids: [...ids] }),
    now: () => ns,
    wallNow: () => wallMs,
    ...(options.slots === undefined ? {} : { slots: options.slots }),
  });

  return {
    wheel,
    fired,
    /** Moves both clocks forward together, as an ordinary second does. */
    tick(seconds = 1): void {
      for (let i = 0; i < seconds; i += 1) {
        ns += SECOND;
        wallMs += 1_000;
        wheel.advance();
      }
    },
    /** Moves both clocks forward at once, as a blocked process looks from the inside. */
    stall(seconds: number): void {
      ns += SECOND * BigInt(seconds);
      wallMs += seconds * 1_000;
      wheel.advance();
    },
    /** Steps the wall clock only, as NTP does. */
    stepWallClock(ms: number): void {
      wallMs += ms;
    },
    idsAt(tick: number): number[] {
      return fired.find((entry) => entry.tick === tick)?.ids ?? [];
    },
    all(): number[] {
      return fired.flatMap((entry) => entry.ids);
    },
  };
}

describe('phase spreading', () => {
  it('is deterministic and inside the interval', () => {
    for (const id of [1, 2, 3, 999, 123_456]) {
      const phase = phaseFor(id, 60);
      assert.equal(phase, phaseFor(id, 60), 'the same sensor always gets the same second');
      assert.ok(phase >= 0 && phase < 60);
    }
  });

  it('scatters sequential ids across the whole interval', () => {
    // The case this exists for: a discovery run provisions a rack, or an operator clones a
    // template, and five thousand sensors are created with consecutive ids seconds apart.
    const buckets = new Array<number>(60).fill(0);
    for (let id = 1; id <= 5_000; id += 1) {
      const phase = phaseFor(id, 60);
      buckets[phase] = (buckets[phase] ?? 0) + 1;
    }

    const ideal = V1_TARGET_BURST;
    const worst = Math.max(...buckets);
    assert.ok(
      buckets.every((count) => count > 0),
      'no second goes unused',
    );
    assert.ok(
      worst < ideal * 1.5,
      `the busiest second holds ${String(worst)} of an ideal ${ideal.toFixed(0)}`,
    );
  });
});

describe('timing wheel', () => {
  it('fires a task on its phase, one interval after it is added', () => {
    const h = harness();
    h.wheel.add({ id: 42, intervalSeconds: 10 });
    const phase = phaseFor(42, 10);

    h.tick(30);
    const ticks = h.fired.filter((entry) => entry.ids.includes(42)).map((entry) => entry.tick);
    assert.ok(ticks.length >= 2);
    for (const tick of ticks) {
      assert.equal(tick % 10, phase, 'every firing lands on the sensor’s own second');
    }
    assert.ok(ticks[0] !== undefined && ticks[0] > 0, 'and never on the tick it was added');
  });

  it('spreads a bulk add across the interval instead of stampeding', () => {
    // What a configuration push looks like (R-04): five hundred sensors arrive on one tick. They
    // must not all scan on the next one — but nor should they wait a whole interval, because the
    // first scan of a new sensor is the one an operator is watching for.
    const h = harness();
    for (let id = 1; id <= 500; id += 1) h.wheel.add({ id, intervalSeconds: 60 });

    h.tick(60);
    assert.equal(h.all().length, 500, 'every one of them ran inside the first interval');
    const busiest = Math.max(...h.fired.map((entry) => entry.ids.length));
    assert.ok(busiest < 25, `the busiest second took ${String(busiest)} of an ideal 8`);
  });

  it('adds, removes and counts', () => {
    const h = harness();
    h.wheel.add({ id: 1, intervalSeconds: 5 });
    h.wheel.add({ id: 2, intervalSeconds: 5 });
    assert.equal(h.wheel.size, 2);
    assert.ok(h.wheel.has(1));

    assert.equal(h.wheel.remove(1), true);
    assert.equal(h.wheel.remove(1), false, 'removing twice is not an error');
    assert.equal(h.wheel.size, 1);

    h.tick(20);
    assert.ok(!h.all().includes(1), 'a removed sensor never fires again');
    assert.ok(h.all().includes(2));
  });

  it('re-schedules when an interval changes and leaves it alone when it does not', () => {
    const h = harness();
    h.wheel.add({ id: 5, intervalSeconds: 60 });
    h.tick(10);

    h.wheel.add({ id: 5, intervalSeconds: 60 });
    assert.equal(h.wheel.size, 1, 'the same interval is not a change');

    h.wheel.add({ id: 5, intervalSeconds: 5 });
    h.tick(20);
    const ticks = h.fired.filter((entry) => entry.ids.includes(5)).map((entry) => entry.tick);
    assert.ok(ticks.length >= 3, 'and the new interval takes effect');
  });

  it('refuses an interval that is not a whole number of seconds', () => {
    const h = harness();
    assert.throws(() => {
      h.wheel.add({ id: 1, intervalSeconds: 0 });
    }, RangeError);
    assert.throws(() => {
      h.wheel.add({ id: 1, intervalSeconds: 1.5 });
    }, RangeError);
  });

  it('handles the extremes of the interval range', () => {
    const h = harness();
    h.wheel.add({ id: 1, intervalSeconds: 1 });
    // A day, which is 24 revolutions of a one-hour wheel: the entry is visited 24 times and is
    // due on the last one.
    h.wheel.add({ id: 2, intervalSeconds: 86_400 });

    h.tick(120);
    assert.equal(h.all().filter((id) => id === 1).length, 120, 'every second, on the second');
    assert.equal(h.all().filter((id) => id === 2).length, 0, 'and not the daily one yet');

    h.stall(86_400);
    assert.equal(h.all().filter((id) => id === 2).length, 1);
  });
});

describe('timing wheel under load', () => {
  it('holds every 60-second sensor to exactly 60 seconds across a simulated hour', () => {
    // The claim ADR-001 Decision 2 rests on, and the one WORKFLOW.MD §3 states as a constraint:
    // a 60-second sensor fires every 60 seconds under full load. Five thousand of them, an hour
    // of scheduling, and the assertion is exactness rather than a tolerance.
    const h = harness();
    const tasks: ScheduledTask[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: index + 1,
      intervalSeconds: 60,
    }));
    for (const task of tasks) h.wheel.add(task);

    const previous = new Map<number, number>();
    const counts = new Map<number, number>();
    let worstGap = 0;

    const startedAt = process.hrtime.bigint();
    for (let second = 0; second < 3_600; second += 1) {
      h.tick();
      const entry = h.fired.at(-1);
      if (entry === undefined || entry.tick !== h.wheel.tick) continue;
      for (const id of entry.ids) {
        const last = previous.get(id);
        if (last !== undefined) {
          const gap: number = entry.tick - last;
          assert.equal(gap, 60, `sensor ${String(id)} fired ${String(gap)} seconds after the last`);
          if (gap > worstGap) worstGap = gap;
        }
        previous.set(id, entry.tick);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.equal(counts.size, 5_000, 'every sensor ran');
    const perSensor = [...counts.values()];
    assert.equal(Math.min(...perSensor), 60, 'and each ran once a minute for the hour');
    assert.equal(Math.max(...perSensor), 60, 'no more and no less');

    // Nothing piles onto one second: 5,000 sensors over 60 phases is ~83 each.
    const perTick = h.fired.map((entry) => entry.ids.length);
    assert.ok(
      Math.max(...perTick) < 120,
      `the busiest second dispatched ${String(Math.max(...perTick))} of an ideal 83`,
    );

    process.stdout.write(
      `\n    measured: 5,000 sensors, 3,600 simulated seconds, ` +
        `${String(h.wheel.stats().dispatched)} dispatches in ${elapsedMs.toFixed(0)} ms; ` +
        `busiest second ${String(Math.max(...perTick))}, worst gap ${String(worstGap)} s\n`,
    );
  });
});

describe('timing wheel and the clock', () => {
  it('fires a stalled sensor once, not once per missed period', () => {
    // A stop-the-world pause, a suspended VM, a laptop lid. Thirty backlogged pings arriving at
    // once would be a stampede at the worst possible moment; monitoring wants the state of the
    // world now.
    const h = harness();
    h.wheel.add({ id: 9, intervalSeconds: 10 });
    h.tick(15);
    const before = h.all().filter((id) => id === 9).length;

    h.stall(300);
    const after = h.all().filter((id) => id === 9).length;

    assert.equal(after - before, 1, 'thirty missed periods, one firing');
    assert.ok(h.wheel.stats().skippedTicks >= 299, 'and the skip is counted, never silent');
  });

  it('keeps a sensor on its own second across a catch-up', () => {
    const h = harness();
    h.wheel.add({ id: 11, intervalSeconds: 60 });
    const phase = phaseFor(11, 60);

    h.stall(1_000);
    h.tick(180);

    const ticks = h.fired.filter((entry) => entry.ids.includes(11)).map((entry) => entry.tick);
    const settled = ticks.filter((tick) => tick > 1_000);
    assert.ok(settled.length >= 2, 'it keeps running afterwards');
    for (const tick of settled) {
      assert.equal(tick % 60, phase, 'and on the second it started on');
    }
  });

  it('fires everything once when it wakes more than a revolution behind', () => {
    // Two hours against a one-hour wheel: every slot is visited, and no entry is found twice.
    const h = harness({ slots: 3_600 });
    for (let id = 1; id <= 200; id += 1) h.wheel.add({ id, intervalSeconds: 60 });
    h.tick(120);
    const before = h.all().length;

    h.stall(7_200);
    const during = h.all().length - before;

    assert.equal(during, 200, 'each sensor exactly once');
  });

  it('ignores a wall-clock step, and says that it saw one', () => {
    const h = harness();
    h.wheel.add({ id: 3, intervalSeconds: 3_600 });
    h.tick(5);
    const before = h.all().length;

    // NTP steps an hour forward. The monotonic clock does not move, so neither does the wheel.
    h.stepWallClock(3_600_000);
    h.tick(1);

    assert.equal(h.all().length, before, 'an hour on the wall is not an hour of scheduling');
    assert.equal(h.wheel.stats().clockJumps, 1, 'but it is worth a counter and a log line');

    // And it is reported once, not on every tick from then on.
    h.tick(5);
    assert.equal(h.wheel.stats().clockJumps, 1);
  });

  it('advances on its own timer against the real clock', async () => {
    // Everything else here drives an injected clock, which is the only way to assert dispatch
    // times — but it leaves the timer that re-arms the wheel untested, and that is the part the
    // probe actually depends on. One real second is worth spending on it.
    const fired: number[] = [];
    const wheel = new TimingWheel({
      logger: silent,
      onDue: (due) => fired.push(...due),
    });
    wheel.add({ id: 1, intervalSeconds: 1 });
    wheel.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_400));
      assert.ok(fired.length >= 2, `expected at least two ticks, got ${String(fired.length)}`);
      // Re-armed to the tick boundary rather than a fixed delay, so it does not drift.
      assert.ok(
        wheel.stats().lagMs.p95 < 250,
        `p95 tick lag was ${String(wheel.stats().lagMs.p95)} ms`,
      );
    } finally {
      wheel.stop();
    }
  });

  it('reports lag against the instant each tick should have run at', () => {
    const h = harness();
    h.wheel.add({ id: 1, intervalSeconds: 1 });
    h.tick(10);
    // The harness advances exactly a second at a time, so the wheel is never late.
    assert.equal(h.wheel.stats().lagMs.max, 0);
    assert.equal(h.wheel.stats().tick, 10);
  });
});

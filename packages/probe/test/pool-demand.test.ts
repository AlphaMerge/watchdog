import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  nextCeiling,
  poolDemand,
  type DemandInput,
  type DemandOptions,
} from '../src/runner/demand.js';

const OPTIONS: DemandOptions = { fallbackMs: 600, min: 4, max: 1_024, margin: 1.3 };

/** `n` sensors of one type on one interval, which is how every case here is shaped. */
function fleet(sensorType: string, count: number, intervalSeconds: number): DemandInput[] {
  return Array.from({ length: count }, () => ({ sensorType, intervalSeconds }));
}

describe('poolDemand (P-34)', () => {
  it('is Little’s law, summed per assignment', () => {
    // The v1 target in the type we ship: 5,000 sensors, 60 s apart, 600 ms a check. 83.3 a
    // second holding a worker for 0.6 s is 50 in flight — the number `P-32` found the shipped
    // ceiling of 48 to be one under.
    const demand = poolDemand(fleet('icmp.ping', 5_000, 60), () => 600, OPTIONS);

    assert.equal(Math.round(demand.required), 50);
    assert.equal(demand.ceiling, 65, '50 x 1.3, rounded up');
    assert.equal(demand.clamped, false);
  });

  it('scales with the check duration, not the sensor count', () => {
    // The point `H-08` made and `P-33` had to correct: the multiplier is the duration. Same
    // sensors, three durations.
    const at = (ms: number): number => poolDemand(fleet('t', 5_000, 60), () => ms, OPTIONS).ceiling;

    assert.equal(at(200), 22, '16.7 required');
    assert.equal(at(600), 65, '50 required');
    assert.equal(at(2_000), 217, '166.7 required — the case sizing.md used to put at 83');
  });

  it('adds up a mixed catalogue rather than taking the worst type', () => {
    // The case one constant cannot serve, and the reason this is a sum: a probe watching both
    // needs the two requirements added, not the larger of them.
    const mixed = [...fleet('icmp.ping', 1_000, 60), ...fleet('snmp.traffic', 1_000, 60)];
    const durations = new Map([
      ['icmp.ping', 600],
      ['snmp.traffic', 40],
    ]);
    const demand = poolDemand(mixed, (type) => durations.get(type), OPTIONS);

    // 1000/60 x 0.6 = 10.0, plus 1000/60 x 0.04 = 0.67.
    assert.equal(demand.required.toFixed(2), '10.67');
    assert.equal(demand.measured, 2_000);
    assert.equal(demand.assumed, 0);
  });

  it('assumes a duration for a type nothing has run yet, and says how many', () => {
    // A probe that has just started has no timings. Deriving from zero would give a ceiling of
    // nothing and then meet the workload the hard way, which is `P-32` again.
    const demand = poolDemand(fleet('brand.new', 5_000, 60), () => undefined, OPTIONS);

    assert.equal(demand.assumed, 5_000);
    assert.equal(demand.measured, 0);
    assert.equal(demand.ceiling, 65, 'the fallback is the shipped check duration, so the same');
  });

  it('prefers what it measured over what it assumed, per type', () => {
    const mixed = [...fleet('measured', 1_000, 60), ...fleet('unmeasured', 1_000, 60)];
    const demand = poolDemand(mixed, (type) => (type === 'measured' ? 100 : undefined), OPTIONS);

    assert.equal(demand.measured, 1_000);
    assert.equal(demand.assumed, 1_000);
    // 1000/60 x 0.1 = 1.67 measured, plus 1000/60 x 0.6 = 10.0 assumed.
    assert.equal(demand.required.toFixed(2), '11.67');
  });

  it('lets a longer interval pay for a slower check', () => {
    // `docs/sizing.md`'s "lengthening the interval helps twice". 5,000 three-second checks are
    // unaffordable at 60 s and ordinary at 600 s.
    const tight = poolDemand(fleet('slow', 5_000, 60), () => 3_000, OPTIONS);
    const relaxed = poolDemand(fleet('slow', 5_000, 600), () => 3_000, OPTIONS);

    assert.equal(Math.round(tight.required), 250);
    assert.equal(Math.round(relaxed.required), 25);
  });

  it('never derives below the floor or above the operator’s ceiling', () => {
    const tiny = poolDemand(fleet('icmp.ping', 5, 60), () => 600, OPTIONS);
    assert.equal(tiny.ceiling, 4, 'a five-sensor probe still gets the minimum');
    assert.equal(tiny.clamped, true);

    const huge = poolDemand(fleet('icmp.ping', 500_000, 60), () => 600, {
      ...OPTIONS,
      max: 64,
    });
    assert.equal(huge.ceiling, 64, 'the operator’s bound is the last word');
    assert.equal(huge.clamped, true, 'and the caller can tell it bound');
  });

  it('ignores an assignment whose interval is not a positive number', () => {
    // Not defensiveness for its own sake: dividing by zero here would make the ceiling Infinity
    // and `Math.ceil(Infinity)` is not a pool size. One corrupt assignment must not decide how
    // much memory the probe asks for.
    const broken: DemandInput[] = [
      { sensorType: 'icmp.ping', intervalSeconds: 0 },
      { sensorType: 'icmp.ping', intervalSeconds: -60 },
      { sensorType: 'icmp.ping', intervalSeconds: Number.NaN },
      { sensorType: 'icmp.ping', intervalSeconds: 60 },
    ];
    const demand = poolDemand(broken, () => 600, OPTIONS);

    assert.equal(demand.required.toFixed(2), '0.01', 'only the one sound assignment counted');
    assert.ok(Number.isFinite(demand.ceiling));
  });

  it('is empty-safe', () => {
    const demand = poolDemand([], () => 600, OPTIONS);
    assert.equal(demand.required, 0);
    assert.equal(demand.ceiling, 4, 'the minimum, so a probe with no work still starts');
  });
});

/**
 * When the pool ceiling should actually move (`P-40`).
 *
 * **A consequence of `P-39` rather than a new idea.** While a lowered ceiling decayed one worker
 * a minute, following every twitch cost little. Now it sheds at once, so a derived ceiling that
 * wobbles destroys and rebuilds workers for a workload that has not changed — at the v1 target a
 * ping duration of 600 ± 40 ms moves the answer between 64 and 73 every thirty seconds.
 */
describe('nextCeiling (P-40)', () => {
  it('raises immediately, because a pool that is too small is checks queueing', () => {
    const decision = nextCeiling({ current: 64, derived: 96, belowStreak: 0 });
    assert.equal(decision.ceiling, 96);
    assert.equal(decision.belowStreak, 0);
  });

  it('holds inside the deadband, so a twitch is not a change', () => {
    // 64 → 60 is under both 10% and the four-worker floor.
    const decision = nextCeiling({ current: 64, derived: 60, belowStreak: 0 });
    assert.equal(decision.ceiling, 64, 'held');
  });

  it('does not let a wobble inside the band accumulate into a drop', () => {
    // **The property that matters, and the reason the streak resets rather than decays.** A
    // network sitting just below the band for an hour must not eventually trip a drop it never
    // earned; only a reading that leaves the band counts towards one.
    let streak = 0;
    for (let i = 0; i < 20; i += 1) {
      const decision = nextCeiling({ current: 64, derived: 61, belowStreak: streak });
      streak = decision.belowStreak;
      assert.equal(decision.ceiling, 64, `held at sample ${String(i)}`);
    }
    assert.equal(streak, 0, 'and nothing accumulated');
  });

  it('waits for a lower answer to persist before acting on it', () => {
    const first = nextCeiling({ current: 128, derived: 64, belowStreak: 0 });
    assert.equal(first.ceiling, 128, 'not on the first reading');
    assert.equal(first.belowStreak, 1);

    const second = nextCeiling({ current: 128, derived: 64, belowStreak: first.belowStreak });
    assert.equal(second.ceiling, 64, 'on the second');
    assert.equal(second.belowStreak, 0, 'and the streak is spent');
  });

  it('forgets a downward streak the moment demand goes back up', () => {
    // The workload just said the earlier low readings were not the trend. Carrying the streak
    // would mean one late sample could drop a ceiling the current demand needs.
    const falling = nextCeiling({ current: 128, derived: 64, belowStreak: 0 });
    assert.equal(falling.belowStreak, 1);

    const recovered = nextCeiling({ current: 128, derived: 130, belowStreak: falling.belowStreak });
    assert.equal(recovered.ceiling, 130);
    assert.equal(recovered.belowStreak, 0);
  });

  it('does not thrash on the wobble that motivated it', () => {
    // The measured case: 600 ± 40 ms at the v1 target derives 64..73. Replayed as a sawtooth,
    // the ceiling must not chase it. Without the band this sets a new ceiling on most samples.
    const wobble = [64, 68, 73, 66, 64, 70, 73, 64, 66, 68, 64, 73];
    let current = 73;
    let streak = 0;
    let changes = 0;
    for (const derived of wobble) {
      const decision = nextCeiling({ current, derived, belowStreak: streak });
      if (decision.ceiling !== current) changes += 1;
      current = decision.ceiling;
      streak = decision.belowStreak;
    }
    assert.ok(changes <= 2, `the ceiling moved ${String(changes)} times across a 12-sample wobble`);
  });
});

/**
 * The pass asks each sensor type for its duration once, not once per assignment (`P-48`).
 *
 * `typicalDurationMs` slices, maps and sorts a window of up to 1,024 samples on every call, and
 * this loop used to call it once per assignment: 5,000 times at the v1 target for perhaps twenty
 * types. One pass measured **427 ms**, against 0.146 ms for the same pass with a constant, so
 * essentially all of it was re-deriving medians already in hand — on the probe's own thread, every
 * thirty seconds, against a rule that nothing blocks the scheduler.
 */
describe('one duration lookup per type (P-48)', () => {
  const spread = (count: number, types: readonly string[]): DemandInput[] =>
    Array.from({ length: count }, (_, i) => ({
      sensorType: types[i % types.length] ?? 'a',
      intervalSeconds: 60,
    }));

  it('asks once per distinct type however many assignments carry it', () => {
    const asked: string[] = [];
    const types = ['icmp.ping', 'port.tcp', 'http.request'];
    poolDemand(
      spread(5_000, types),
      (type) => {
        asked.push(type);
        return 200;
      },
      { fallbackMs: 600, min: 4, max: 256, margin: 1.3 },
    );

    assert.equal(asked.length, types.length, `asked ${String(asked.length)} times`);
    assert.deepEqual([...asked].sort(), [...types].sort());
  });

  it('caches "nothing measured yet" too, which is every type on a fresh probe', () => {
    // `undefined` is an answer, and the one a probe gives for every type until its first check
    // finishes. Caching only defined values would leave the fresh-probe case — the one where the
    // sizing loop runs most often — paying the full cost.
    let asked = 0;
    const demand = poolDemand(
      spread(1_000, ['never.run']),
      () => {
        asked += 1;
        return undefined;
      },
      { fallbackMs: 600, min: 4, max: 256, margin: 1.3 },
    );

    assert.equal(asked, 1);
    assert.equal(demand.assumed, 1_000, 'and every assignment still counts as assumed');
    assert.equal(demand.measured, 0);
  });

  it('gives the same answer it gave before the cache', () => {
    // 1,000 sensors of one type at 600 ms on a 60 s interval: 1000/60 x 0.6 = 10 workers, x1.3 =13.
    const demand = poolDemand(spread(1_000, ['icmp.ping']), () => 600, {
      fallbackMs: 600,
      min: 4,
      max: 256,
      margin: 1.3,
    });
    assert.equal(demand.ceiling, 13);
    assert.equal(demand.measured, 1_000);
  });
});

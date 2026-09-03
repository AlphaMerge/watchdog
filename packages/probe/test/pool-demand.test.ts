import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { poolDemand, type DemandInput, type DemandOptions } from '../src/runner/demand.js';

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

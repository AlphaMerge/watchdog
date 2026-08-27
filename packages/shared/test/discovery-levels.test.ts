import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DISCOVERY_LEVELS,
  estimateSeconds,
  levelDefinition,
  type DiscoveryLevel,
} from '../src/net/discovery-levels.js';
import { IDENTIFY_PORTS } from '../src/net/fingerprint.js';

/**
 * How hard a run looks, and what that costs (`D-06`).
 *
 * The estimate is the reason this is here rather than in the core: an operator picks a level
 * from what it says it will cost, and a "twenty minutes" that turns into four hours is how they
 * learn not to trust it. Every number below is arithmetic over the level table, which is also
 * what the probe is told — so the estimate cannot be about a different run from the one that
 * happens.
 */

const estimate = (level: DiscoveryLevel, addresses: number, over = {}) =>
  estimateSeconds({
    level,
    addresses,
    sweepTimeoutMs: 1_000,
    sweepConcurrency: 32,
    identifyConcurrency: 8,
    ...over,
  });

describe('the levels', () => {
  it('offers three, from ping-only to detailed', () => {
    assert.deepEqual(
      DISCOVERY_LEVELS.map((one) => one.id),
      ['ping', 'standard', 'detailed'],
    );
    for (const level of DISCOVERY_LEVELS) {
      assert.ok(level.name.length > 0, level.id);
      assert.ok(level.description.length > 40, `${level.id} needs to say what it costs`);
    }
  });

  it('asks nothing of a host at ping level', () => {
    const ping = levelDefinition('ping');
    assert.equal(ping.identify, false);
    assert.deepEqual(ping.ports, []);
  });

  it('asks the standard set at standard, and more at detailed', () => {
    const standard = levelDefinition('standard');
    const detailed = levelDefinition('detailed');
    assert.deepEqual(
      standard.ports,
      IDENTIFY_PORTS.map((one) => one.port),
    );
    assert.ok(detailed.ports.length > standard.ports.length * 2, 'detailed is meaningfully more');
    for (const port of standard.ports) {
      assert.ok(detailed.ports.includes(port), `detailed dropped ${String(port)}`);
    }
  });

  it('names no port twice', () => {
    // A duplicate is a connection per host that tells nobody anything, which is the difference
    // between a discovery level and a port scan.
    for (const level of DISCOVERY_LEVELS) {
      assert.equal(new Set(level.ports).size, level.ports.length, level.id);
    }
  });

  it('gives a level that does not identify no identification budget', () => {
    // **What the estimate rests on.** It charges `addresses × identifyTimeoutMs` unconditionally,
    // because a level that does not identify has a timeout of zero — one statement rather than
    // an `if` that says the same thing again and can drift from it. This is the assertion that
    // keeps that true.
    for (const level of DISCOVERY_LEVELS) {
      if (level.identify) {
        assert.ok(level.identifyTimeoutMs > 0, `${level.id} identifies with no budget`);
        assert.ok(level.ports.length > 0, `${level.id} identifies and asks about nothing`);
      } else {
        assert.equal(level.identifyTimeoutMs, 0, `${level.id} does not identify`);
        assert.deepEqual(level.ports, [], level.id);
      }
    }
  });

  it('is more patient the harder it looks', () => {
    assert.ok(
      levelDefinition('detailed').identifyTimeoutMs > levelDefinition('standard').identifyTimeoutMs,
    );
  });

  it('falls back to standard for a level it does not know', () => {
    // A newer core telling an older one about a level it does not have. Doing the sensible
    // thing beats refusing to discover anything at all.
    assert.equal(levelDefinition('nonsense' as DiscoveryLevel).id, 'standard');
  });
});

describe('the estimate', () => {
  it('is a range, because the answer depends on how many hosts are alive', () => {
    // Reporting one number would mean picking a hit rate and being wrong about it in the
    // direction that matters.
    const range = estimate('standard', 254);
    assert.ok(range.min < range.max, `${String(range.min)} … ${String(range.max)}`);
  });

  it('brackets every outcome, not just the two extremes it computes', () => {
    // **The defect the first version had.** It added the two halves' worst cases together and
    // reported 33–33 for a /24 at standard — a range that does not contain the answer for a
    // half-alive network, which is 20. The cost is linear in the fraction alive, so the
    // endpoints bracket everything between them; this asserts that against the model directly.
    const addresses = 254;
    const range = estimate('standard', addresses);
    const level = levelDefinition('standard');
    for (const alive of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const actual =
        ((1 - alive) * addresses * 1_000) / 32 / 1_000 +
        (alive * addresses * level.identifyTimeoutMs) / 8 / 1_000;
      assert.ok(
        actual >= range.min - 1 && actual <= range.max + 1,
        `${String(alive)} alive costs ${actual.toFixed(1)} s, outside ${String(range.min)}–${String(range.max)}`,
      );
    }
  });

  it('makes the sweep’s worst case an empty range', () => {
    // Every address that answers returns in a moment; every one that does not costs a full
    // timeout. So nothing alive is the sweep's most expensive outcome, not its cheapest.
    const ping = estimate('ping', 254);
    // 254 addresses × 1 s ÷ 32 at a time ≈ 8 s.
    assert.equal(ping.max, 8);
    assert.ok(ping.min < ping.max);
  });

  it('charges identification per host rather than per port', () => {
    // Every source is asked at once, which is the whole reason `D-02` does it that way — an
    // estimate that multiplied by the port count would be wrong by a factor of twelve.
    const standard = estimate('standard', 800);
    const detailed = estimate('detailed', 800);
    const portRatio =
      levelDefinition('detailed').ports.length / levelDefinition('standard').ports.length;
    assert.ok(portRatio > 2.5, 'detailed really does ask about far more ports');
    assert.ok(
      detailed.max < standard.max * portRatio,
      `${String(detailed.max)} should be well under ${String(standard.max * portRatio)}`,
    );
  });

  it('makes detailed cost more than standard, and standard more than ping', () => {
    // On the *alive* end, which is where identification's cost lives. The empty-range end is
    // the same for all three, because an address that never answers is never identified.
    assert.ok(estimate('standard', 254).max > estimate('ping', 254).max);
    assert.ok(estimate('detailed', 254).max > estimate('standard', 254).max);
  });

  it('scales with the range and inversely with the concurrency', () => {
    assert.ok(estimate('ping', 1_000).max > estimate('ping', 100).max);
    assert.ok(estimate('ping', 254, { sweepConcurrency: 128 }).max < estimate('ping', 254).max);
  });

  it('never divides by zero, whatever it is handed', () => {
    assert.ok(Number.isFinite(estimate('standard', 254, { sweepConcurrency: 0 }).max));
    assert.ok(Number.isFinite(estimate('standard', 254, { identifyConcurrency: 0 }).min));
    assert.deepEqual(estimate('ping', 0), { min: 0, max: 0 });
  });

  it('answers in whole seconds, rounded up', () => {
    // A range of "0 to 0 seconds" for something that takes a moment is worse than saying one.
    const tiny = estimate('standard', 1);
    assert.ok(Number.isInteger(tiny.min) && Number.isInteger(tiny.max));
    assert.ok(tiny.min >= 1);
  });
});

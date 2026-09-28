import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  FormulaError,
  evaluate,
  parseFormula,
  referencedSensors,
  type FormulaInputs,
} from '../src/support/formula.js';

/**
 * The Sensor Factory formula language (`T-21`), on its own.
 *
 * Pure and separate from anything that reads a database, because this is the half where a
 * mistake is silent: a formula that parses to the wrong tree reports a *number*, and a number is
 * indistinguishable from data until somebody checks it by hand.
 */

const inputs = (
  channels: Record<string, number> = {},
  up: Record<number, boolean> = {},
  options: { ages?: Record<string, number>; maxAgeSeconds?: number } = {},
): FormulaInputs => ({
  channels: new Map(
    Object.entries(channels).map(([key, value]) => [
      key,
      { value, ageSeconds: options.ages?.[key] ?? 0 },
    ]),
  ),
  up: new Map(Object.entries(up).map(([id, value]) => [Number(id), value])),
  maxAgeSeconds: options.maxAgeSeconds ?? 600,
});

const value = (formula: string, given: FormulaInputs = inputs()): number | null =>
  evaluate(parseFormula(formula), given);

describe('arithmetic', () => {
  it('respects precedence and brackets', () => {
    assert.equal(value('2 + 3 * 4'), 14);
    assert.equal(value('(2 + 3) * 4'), 20);
    assert.equal(value('10 - 2 - 3'), 5, 'subtraction is left-associative');
    assert.equal(value('100 / 5 / 2'), 10);
    assert.equal(value('7 % 3'), 1);
  });

  it('reads unary minus, including twice', () => {
    assert.equal(value('-5'), -5);
    assert.equal(value('- -5'), 5);
    assert.equal(value('3 * -2'), -6);
  });

  it('reads a digit separator, because 1_000_000 is checkable and 1000000 is not', () => {
    assert.equal(value('1_000_000 / 1_000'), 1000);
  });

  it('gaps a division by zero rather than reporting Infinity or failing', () => {
    // Dividing by a channel that happens to be zero is an ordinary transient, and a factory
    // going Down because a denominator was briefly zero would be an alarm about arithmetic.
    assert.equal(value('5 / 0'), null);
    assert.equal(value('5 % 0'), null);
  });
});

describe('channels and status', () => {
  it('reads a channel by sensor and key', () => {
    assert.equal(value("channel(42, 'traffic.in')", inputs({ '42:traffic.in': 120 })), 120);
    assert.equal(value('channel(42, "traffic.in")', inputs({ '42:traffic.in': 120 })), 120);
  });

  it('makes a missing channel a gap, and lets it propagate through the whole formula', () => {
    // The rule the whole system is built on. A total that quietly lost a term is a number that
    // looks like data and is wrong — the failure mode a factory is most likely to produce.
    const given = inputs({ '1:in': 100 });
    assert.equal(value("channel(1, 'in')", given), 100);
    assert.equal(value("channel(1, 'in') + channel(2, 'in')", given), null);
    assert.equal(value("max(channel(1, 'in'), channel(2, 'in'))", given), null);
  });

  it('lets an operator say what absence means, in the formula where it can be seen', () => {
    const given = inputs({ '1:in': 100 });
    assert.equal(value("channel(1, 'in') + default(channel(2, 'in'), 0)", given), 100);
    assert.equal(value("default(channel(1, 'in'), 0)", given), 100);
  });

  it('reads status as one or zero, and unknown as not up', () => {
    // A sensor the core has never heard from is not evidence of health.
    const given = inputs({}, { 11: true, 12: false });
    assert.equal(value('status(11) + status(12) + status(13)', given), 1);
  });

  it('counts a cluster, which is what status() is for', () => {
    const given = inputs({}, { 1: true, 2: true, 3: false });
    assert.equal(value('status(1) + status(2) + status(3)', given), 2);
  });
});

describe('staleness', () => {
  /**
   * `P-59`. The cut-off lives on the inputs rather than on the reading because it is the
   * *reading sensor's* setting: two factories over the same channel can disagree about how old
   * is too old, and each is entitled to its own answer.
   */
  const aged = (ageSeconds: number, maxAgeSeconds = 600): FormulaInputs =>
    inputs({ '1:v': 42, '2:v': 100 }, {}, { ages: { '1:v': ageSeconds }, maxAgeSeconds });

  it('reads a channel inside the cut-off and gaps one past it', () => {
    assert.equal(value("channel(1, 'v')", aged(500)), 42);
    assert.equal(value("channel(1, 'v')", aged(700)), null);
  });

  it('counts a reading exactly at the cut-off as still current', () => {
    // `>` and not `>=`: “older than” is what the parameter promises, and a boundary the other
    // way would gap a source that reports at exactly the period it was configured for.
    assert.equal(value("channel(1, 'v')", aged(600)), 42);
  });

  it('propagates a stale channel as a gap through arithmetic', () => {
    // The whole point. A total that quietly lost a term is a number that looks like data.
    assert.equal(value("channel(1, 'v') + channel(2, 'v')", aged(4_000)), null);
  });

  it('lets default() stand in for a stale reading, the same as for a missing one', () => {
    assert.equal(value("default(channel(1, 'v'), 0)", aged(4_000)), 0);
  });

  it('answers the same question differently for two cut-offs over one reading', () => {
    assert.equal(value("channel(1, 'v')", aged(3_000, 86_400)), 42);
    assert.equal(value("channel(1, 'v')", aged(3_000, 60)), null);
  });
});

describe('functions', () => {
  const given = inputs({ '1:v': 10, '2:v': 30, '3:v': 20 });

  it('does the arithmetic ones', () => {
    assert.equal(value("min(channel(1,'v'), channel(2,'v'), channel(3,'v'))", given), 10);
    assert.equal(value("max(channel(1,'v'), channel(2,'v'), channel(3,'v'))", given), 30);
    assert.equal(value("avg(channel(1,'v'), channel(2,'v'), channel(3,'v'))", given), 20);
    assert.equal(value("sum(channel(1,'v'), channel(2,'v'), channel(3,'v'))", given), 60);
    assert.equal(value('abs(0 - 7)'), 7);
    assert.equal(value('floor(7.9)'), 7);
    assert.equal(value('ceil(7.1)'), 8);
    assert.equal(value('round(7.456, 2)'), 7.46);
    assert.equal(value('round(7.456)'), 7);
  });

  it('does percent, which is the single most common thing anybody writes', () => {
    assert.equal(value('percent(25, 200)'), 12.5);
    assert.equal(value('percent(5, 0)'), null, 'a zero total is a gap, not a division by zero');
  });

  it('refuses a function it does not have', () => {
    assert.throws(() => parseFormula('sqrt(4)'), /there is no function called "sqrt"/);
  });

  it('refuses the wrong number of arguments', () => {
    assert.throws(() => parseFormula('abs(1, 2)'), /abs\(\) takes 1 argument and was given 2/);
    assert.throws(() => parseFormula('percent(1)'), /percent\(\) takes 2 arguments/);
  });
});

describe('what it refuses to parse', () => {
  it('is not an expression language, and says so', () => {
    // The obvious shortcut — `new Function(formula)` — would let anybody with sensor-create
    // rights run code in the core, which holds the vault key and the database.
    for (const attempt of [
      'process.exit(1)',
      "require('fs')",
      '1; drop',
      'a[0]',
      '{}',
      '1 && 2',
      'channel(1, `x`)',
    ]) {
      assert.throws(() => parseFormula(attempt), FormulaError, attempt);
    }
  });

  it('refuses a sensor id that is not a whole number', () => {
    assert.throws(() => parseFormula("channel(x, 'k')"), /sensor id, which is a whole number/);
    assert.throws(() => parseFormula("channel(1.5, 'k')"), FormulaError);
  });

  it('refuses a channel key that is not a quoted string', () => {
    assert.throws(() => parseFormula('channel(1, k)'), /channel key in quotes/);
    assert.throws(() => parseFormula("channel(1, '')"), /empty channel key/);
  });

  it('refuses an unclosed bracket or quote', () => {
    assert.throws(() => parseFormula('(1 + 2'), /expected a closing bracket/);
    assert.throws(() => parseFormula("channel(1, 'k"), /is never closed/);
  });

  it('refuses trailing rubbish rather than reading the first half', () => {
    // Reading `1 + 2 nonsense` as 3 would be a formula quietly meaning something other than
    // what it says.
    assert.throws(() => parseFormula('1 + 2 nonsense'), /continues after it should have ended/);
  });

  it('refuses an empty formula and one longer than the bound', () => {
    assert.throws(() => parseFormula('   '), /is empty/);
    assert.throws(() => parseFormula(`1 + ${'1 + '.repeat(600)}1`), /the limit is 2000/);
  });
});

describe('referencedSensors', () => {
  it('finds every sensor a formula reads, however deeply nested', () => {
    const node = parseFormula(
      "percent(channel(7, 'used') + channel(8, 'used'), max(channel(9, 't'), status(10)))",
    );
    assert.deepEqual(
      [...referencedSensors(node)].sort((a, b) => a - b),
      [7, 8, 9, 10],
    );
  });

  it('finds nothing in a formula that reads nothing', () => {
    assert.equal(referencedSensors(parseFormula('1 + 2')).size, 0);
  });
});

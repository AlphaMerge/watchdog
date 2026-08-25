import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  evaluateChannel,
  format,
  mergeLimits,
  parseLimits,
  rollUp,
  validateLimits,
  NO_LIMITS,
  type ChannelLimits,
  type ChannelReadingFacts,
} from '../src/state/limits.js';

function limits(over: Partial<ChannelLimits> = {}): ChannelLimits {
  return { ...NO_LIMITS, ...over };
}

function reading(
  value: number,
  over: Partial<ChannelLimits> = {},
  channel: Partial<ChannelReadingFacts> = {},
): ChannelReadingFacts {
  return {
    key: 'rtt',
    name: 'Response time',
    unit: 'ms',
    decimals: null,
    value,
    limits: limits(over),
    ...channel,
  };
}

// -------------------------------------------------------------------------------------------
// One channel, one reading.
// -------------------------------------------------------------------------------------------

describe('channel limits', () => {
  it('says nothing when nothing is configured', () => {
    assert.equal(evaluateChannel(reading(999_999)), null);
  });

  it('goes Down above an upper error limit and Warning above an upper warning limit', () => {
    const configured = { upperError: 500, upperWarning: 200 };
    assert.equal(evaluateChannel(reading(812, configured))?.state, 'down');
    assert.equal(evaluateChannel(reading(300, configured))?.state, 'warning');
    assert.equal(evaluateChannel(reading(100, configured)), null);
  });

  it('goes Down below a lower error limit and Warning below a lower warning limit', () => {
    // The case an upper-limit-only implementation quietly gets wrong: free disk space and
    // battery charge are alarming when they *fall*.
    const configured = { lowerError: 5, lowerWarning: 15 };
    assert.equal(evaluateChannel(reading(2, configured))?.state, 'down');
    assert.equal(evaluateChannel(reading(10, configured))?.state, 'warning');
    assert.equal(evaluateChannel(reading(50, configured)), null);
  });

  it('compares strictly, so a reading exactly at the limit has not exceeded it', () => {
    // An upper error limit of 100 on a percentage has to be reachable. One that fired at 100
    // would make "at most 100%" impossible to express, and every full disk would be Down at
    // 99.99%.
    assert.equal(evaluateChannel(reading(100, { upperError: 100 })), null);
    assert.equal(evaluateChannel(reading(100.000_1, { upperError: 100 }))?.state, 'down');
    assert.equal(evaluateChannel(reading(0, { lowerError: 0 })), null);
    assert.equal(evaluateChannel(reading(-0.1, { lowerError: 0 }))?.state, 'down');
  });

  it('treats zero as a limit, not as an absence', () => {
    // `lowerError: 0` and "no lower limit" must not be the same configuration — a channel that
    // must never be negative is an ordinary thing to want.
    assert.equal(evaluateChannel(reading(-1, { lowerError: 0 }))?.state, 'down');
    assert.equal(evaluateChannel(reading(-1, {})), null);
  });

  it('reports the error limit when both are breached', () => {
    const breach = evaluateChannel(reading(900, { upperError: 500, upperWarning: 200 }));
    assert.equal(breach?.state, 'down');
    assert.ok(breach.message.includes('error limit'));
  });

  it('can be switched off without losing the thresholds', () => {
    const off = reading(900, { upperError: 500, enabled: false });
    assert.equal(evaluateChannel(off), null);
    assert.equal(off.limits.upperError, 500, 'the number is still there to switch back on');
  });

  // -----------------------------------------------------------------------------------------
  // What an operator reads.
  // -----------------------------------------------------------------------------------------

  it('says what the value was and which limit it crossed', () => {
    assert.equal(
      evaluateChannel(reading(812, { upperError: 500 }))?.message,
      'Response time is 812 ms, above the error limit of 500 ms',
    );
    assert.equal(
      evaluateChannel(reading(3, { lowerWarning: 10 }, { name: 'Free space', unit: '%' }))?.message,
      'Free space is 3 %, below the warning limit of 10 %',
    );
  });

  it('appends the operator’s own message after the numbers, not instead of them', () => {
    const breach = evaluateChannel(
      reading(812, { upperError: 500, errorMessage: 'page the network team' }),
    );
    assert.equal(
      breach?.message,
      'Response time is 812 ms, above the error limit of 500 ms — page the network team',
    );
  });

  it('uses the custom message that matches the severity that fired', () => {
    const configured = {
      upperError: 500,
      upperWarning: 200,
      errorMessage: 'critical',
      warningMessage: 'keep an eye on it',
    };
    assert.ok(evaluateChannel(reading(300, configured))?.message.endsWith('keep an eye on it'));
    assert.ok(evaluateChannel(reading(900, configured))?.message.endsWith('critical'));
  });

  it('formats a number the way the channel declares, and never by locale', () => {
    assert.equal(format(0.1 + 0.2, 'ms', null), '0.3 ms', 'not 0.30000000000000004 ms');
    assert.equal(format(812.456, 'ms', 1), '812.5 ms');
    assert.equal(format(1234, '', null), '1234', 'no thousands separator, on any host');
    assert.equal(format(5, '%', 0), '5 %');
  });
});

// -------------------------------------------------------------------------------------------
// Configuration that cannot mean anything.
// -------------------------------------------------------------------------------------------

describe('limit validation', () => {
  it('accepts an ordinary band', () => {
    assert.deepEqual(
      validateLimits(limits({ lowerError: 0, lowerWarning: 10, upperWarning: 80, upperError: 95 })),
      [],
    );
  });

  it('accepts limits on one side only', () => {
    assert.deepEqual(validateLimits(limits({ upperError: 500 })), []);
    assert.deepEqual(validateLimits(limits({ lowerWarning: 10 })), []);
  });

  it('refuses a warning limit past its error limit, which could never fire', () => {
    assert.equal(validateLimits(limits({ upperError: 100, upperWarning: 200 })).length, 1);
    assert.equal(validateLimits(limits({ lowerError: 100, lowerWarning: 50 })).length, 1);
  });

  it('refuses a band that is inside out, where every reading breaches both ends', () => {
    assert.equal(validateLimits(limits({ lowerWarning: 90, upperWarning: 10 })).length, 1);
  });

  it('says what is wrong in words, with the numbers in them', () => {
    const [problem] = validateLimits(limits({ upperError: 100, upperWarning: 200 }));
    assert.ok(problem !== undefined);
    assert.ok(problem.includes('200'));
    assert.ok(problem.includes('100'));
    assert.ok(problem.includes('never'));
  });
});

// -------------------------------------------------------------------------------------------
// Editing.
// -------------------------------------------------------------------------------------------

describe('limit patching', () => {
  const current = limits({ upperError: 500, upperWarning: 200, warningMessage: 'slow' });

  it('leaves an absent field alone', () => {
    assert.deepEqual(mergeLimits(current, { upperError: 900 }), {
      ...current,
      upperError: 900,
    });
  });

  it('clears a threshold with null, which is the only way to say it', () => {
    assert.equal(mergeLimits(current, { upperWarning: null }).upperWarning, null);
    assert.equal(mergeLimits(current, { upperWarning: null }).upperError, 500, 'and only that one');
  });

  it('reads a stored blob tolerantly, so one bad row is not one failing sensor', () => {
    assert.deepEqual(parseLimits({}), NO_LIMITS);
    assert.deepEqual(parseLimits(null), NO_LIMITS);
    assert.deepEqual(parseLimits('nonsense'), NO_LIMITS);
    assert.equal(parseLimits({ upperError: 'five hundred' }).upperError, null);
    assert.equal(parseLimits({ upperError: Number.NaN }).upperError, null, 'NaN is not a limit');
    assert.equal(parseLimits({ upperError: 500 }).upperError, 500);
    assert.equal(parseLimits({ enabled: false }).enabled, false);
    assert.equal(parseLimits({}).enabled, true, 'configured limits act unless switched off');
  });
});

// -------------------------------------------------------------------------------------------
// Several channels at once — the sensor is the worst of them (M-05).
// -------------------------------------------------------------------------------------------

describe('channel rollup', () => {
  const rtt = (value: number): ChannelReadingFacts => reading(value, { upperError: 500 });
  const loss = (value: number): ChannelReadingFacts =>
    reading(value, { upperWarning: 1 }, { key: 'loss', name: 'Packet loss', unit: '%' });

  it('is clear when every channel is inside its limits', () => {
    const outcome = rollUp([rtt(10), loss(0)]);
    assert.deepEqual(outcome.verdict, { state: 'up', cause: 'scan' });
    assert.equal(outcome.message, '');
    assert.equal(outcome.breaches.length, 0);
  });

  it('takes the worst channel, and attributes it to the limit', () => {
    const outcome = rollUp([rtt(900), loss(5)]);
    assert.deepEqual(outcome.verdict, { state: 'down', cause: 'limit' });
    assert.equal(outcome.breaches.length, 2);
    assert.equal(outcome.breaches[0]?.state, 'down', 'worst first');
  });

  it('does not let a healthy channel outvote a broken one', () => {
    assert.equal(rollUp([rtt(10), loss(5)]).verdict.state, 'warning');
    assert.equal(rollUp([loss(0), rtt(900)]).verdict.state, 'down', 'whatever the order');
  });

  it('names every breach, worst first', () => {
    const outcome = rollUp([loss(5), rtt(900)]);
    assert.equal(
      outcome.message,
      'Response time is 900 ms, above the error limit of 500 ms; ' +
        'Packet loss is 5 %, above the warning limit of 1 %',
    );
  });

  it('stops listing after three and says how many it did not name', () => {
    // A sensor may have fifty channels. A message that lists all fifty is one nobody reads and
    // a notification body that gets truncated somewhere downstream.
    const many = Array.from({ length: 6 }, (_, index) =>
      reading(
        900,
        { upperError: 500 },
        { key: `c${String(index)}`, name: `Channel ${String(index)}` },
      ),
    );
    const outcome = rollUp(many);
    assert.ok(outcome.message.endsWith('(and 3 more channels)'));
    assert.equal(outcome.breaches.length, 6, 'but every one is still reported');
  });

  it('says "1 more channel", not "1 more channels"', () => {
    const four = Array.from({ length: 4 }, (_, index) =>
      reading(900, { upperError: 500 }, { key: `c${String(index)}` }),
    );
    assert.ok(rollUp(four).message.endsWith('(and 1 more channel)'));
  });
});

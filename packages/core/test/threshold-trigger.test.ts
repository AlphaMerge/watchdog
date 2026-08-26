import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  breaches,
  fireThreshold,
  readingsAreCurrent,
  reconcileThreshold,
  thresholdDueAt,
  type ThresholdAlarm,
  type ThresholdCondition,
  type ThresholdTriggerSettings,
} from '../src/notifications/threshold.js';

const T0 = new Date('2026-08-26T11:00:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const CONDITIONS: readonly ThresholdCondition[] = ['above', 'below', 'equal', 'notEqual'];

function settings(overrides: Partial<ThresholdTriggerSettings> = {}): ThresholdTriggerSettings {
  return {
    channelKey: 'load',
    condition: 'above',
    value: 80,
    latencySeconds: 0,
    triggerTemplateId: 11,
    clearTemplateId: 12,
    ...overrides,
  };
}

function alarm(overrides: Partial<ThresholdAlarm> = {}): ThresholdAlarm {
  return { channelKey: 'load', since: T0, phase: 'pending', observed: 90, ...overrides };
}

// -------------------------------------------------------------------------------------------
// The comparison.
// -------------------------------------------------------------------------------------------

describe('a threshold comparison', () => {
  it('is strict on both sides, so the threshold itself is not a breach', () => {
    assert.equal(breaches('above', 80, 80), false);
    assert.equal(breaches('above', 80.000_001, 80), true);
    assert.equal(breaches('below', 80, 80), false);
    assert.equal(breaches('below', 79.999_999, 80), true);
  });

  it('compares equality exactly', () => {
    // Right for the channels anybody sets `equal` on — status codes, counts, enumerated values —
    // and treacherous for a computed float, which is the operator's choice to make.
    assert.equal(breaches('equal', 3, 3), true);
    assert.equal(breaches('equal', 0.1 + 0.2, 0.3), false);
    assert.equal(breaches('notEqual', 0.1 + 0.2, 0.3), true);
  });

  it('never says both a condition and its opposite', () => {
    for (const [condition, opposite] of [
      ['above', 'below'],
      ['equal', 'notEqual'],
    ] as const) {
      for (const observed of [-1, 0, 79, 80, 81, 1e9]) {
        assert.ok(
          !(breaches(condition, observed, 80) && breaches(opposite, observed, 80)),
          `${String(observed)} cannot be both ${condition} and ${opposite} 80`,
        );
      }
    }
  });

  it('handles a negative threshold, which is a real configuration', () => {
    assert.equal(breaches('below', -10, -5), true);
    assert.equal(breaches('above', -1, -5), true);
  });
});

// -------------------------------------------------------------------------------------------
// When the notification falls due.
// -------------------------------------------------------------------------------------------

describe('a threshold’s latency', () => {
  it('runs from the first breaching reading', () => {
    assert.deepEqual(thresholdDueAt(T0, settings({ latencySeconds: 120 })), at(120));
  });

  it('is immediate at zero', () => {
    assert.deepEqual(thresholdDueAt(T0, settings()), T0);
  });
});

// -------------------------------------------------------------------------------------------
// Reconciliation.
// -------------------------------------------------------------------------------------------

describe('reconciling a threshold alarm', () => {
  it('does nothing for a channel inside its threshold', () => {
    assert.deepEqual(reconcileThreshold(null, 40, settings(), T0), { kind: 'idle' });
  });

  it('does nothing for a channel with no reading at all', () => {
    // No-data is not zero. A `below 80` trigger firing because a sensor stopped reporting would
    // be an alarm about nothing, raised by the absence of evidence.
    assert.deepEqual(reconcileThreshold(null, null, settings({ condition: 'below' }), T0), {
      kind: 'idle',
    });
  });

  it('arms from now, not from the sensor’s state', () => {
    // A threshold's clock starts at the first reading that breached it, which is the only moment
    // the reconciliation knows about — the sensor may have been Up for a week.
    const decision = reconcileThreshold(null, 95, settings({ latencySeconds: 120 }), at(600));
    assert.deepEqual(decision, { kind: 'arm', nextDueAt: at(720) });
  });

  it('holds while the channel is still over', () => {
    assert.deepEqual(reconcileThreshold(alarm(), 95, settings(), at(60)), { kind: 'hold' });
  });

  it('notifies nobody about a breach that clears before its latency', () => {
    // The same rule as a state trigger's blip, for the same reason: nothing was sent, so a clear
    // notification would be the first anyone heard of it.
    const pending = alarm({ phase: 'pending' });
    assert.deepEqual(reconcileThreshold(pending, 40, settings({ latencySeconds: 300 }), at(30)), {
      kind: 'cancel',
    });
  });

  it('clears once somebody has been told', () => {
    const notified = alarm({ phase: 'notified' });
    assert.deepEqual(reconcileThreshold(notified, 40, settings(), at(600)), { kind: 'recover' });
  });

  it('does not call losing the reading a clear', () => {
    // A disk that was 95% full when its sensor went Down is not a disk that emptied. The alarm
    // is stood down — we no longer know — but silently: "back under 80%" would be a false
    // all-clear, and somebody stops looking.
    const notified = alarm({ phase: 'notified' });
    assert.deepEqual(reconcileThreshold(notified, null, settings(), at(600)), { kind: 'cancel' });
  });

  it('stands an alarm down when the trigger is pointed at another channel', () => {
    const notified = alarm({ channelKey: 'load', phase: 'notified' });
    assert.deepEqual(
      reconcileThreshold(notified, 95, settings({ channelKey: 'rtt' }), at(60)),
      { kind: 'cancel' },
      'nothing cleared, so nothing is said',
    );
  });

  it('never suppresses or resumes', () => {
    // Acknowledgement belongs to the state chain. A threshold trigger is about a value, and a
    // sensor can be over its threshold while perfectly Up — there is no Down to acknowledge.
    const decisions = new Set<string>();
    for (const condition of CONDITIONS) {
      for (const reading of [null, 0, 80, 95]) {
        for (const phase of ['pending', 'notified'] as const) {
          for (const existing of [null, alarm({ phase })]) {
            decisions.add(
              reconcileThreshold(existing, reading, settings({ condition }), at(1)).kind,
            );
          }
        }
      }
    }
    assert.ok(!decisions.has('suppress'));
    assert.ok(!decisions.has('resume'));
  });

  it('is total: every combination of reading and alarm decides something', () => {
    for (const condition of CONDITIONS) {
      for (const reading of [null, -1, 0, 79.999, 80, 80.001, 1e9]) {
        for (const existing of [null, alarm({ phase: 'pending' }), alarm({ phase: 'notified' })]) {
          const decision = reconcileThreshold(existing, reading, settings({ condition }), at(1));
          assert.ok(
            ['idle', 'arm', 'hold', 'recover', 'cancel'].includes(decision.kind),
            `${condition}/${String(reading)} produced ${decision.kind}`,
          );
          // An arm or a hold means the reading breached; the rest mean it did not, or there was
          // none. Stated as an invariant rather than case by case, because it is the property
          // the whole subsystem rests on.
          const standing = decision.kind === 'arm' || decision.kind === 'hold';
          assert.equal(
            standing,
            reading !== null && breaches(condition, reading, 80),
            `${condition}/${String(reading)}`,
          );
        }
      }
    }
  });
});

// -------------------------------------------------------------------------------------------
// Whether stored readings are current at all.
// -------------------------------------------------------------------------------------------

describe('whether a sensor’s readings are current', () => {
  it('accepts a sensor whose last check succeeded', () => {
    for (const state of ['up', 'warning', 'down', 'down_acknowledged']) {
      assert.equal(readingsAreCurrent({ state, consecutiveFailures: 0 }), true, state);
    }
  });

  it('accepts a Down sensor with no failures, because a limit breach is a successful check', () => {
    // M-04: a response time of 812 ms is a successful check *and* a problem. Its readings are as
    // current as any, and a threshold trigger on the same channel must still see them.
    assert.equal(readingsAreCurrent({ state: 'down', consecutiveFailures: 0 }), true);
  });

  it('refuses a sensor whose last check failed', () => {
    // The readings still in the table belong to an earlier result. Thirty seconds old and
    // completely stale — which no time window can tell apart from thirty seconds old and fresh.
    assert.equal(readingsAreCurrent({ state: 'warning', consecutiveFailures: 1 }), false);
    assert.equal(readingsAreCurrent({ state: 'down', consecutiveFailures: 3 }), false);
  });

  it('refuses a sensor nobody is scanning', () => {
    for (const state of ['paused', 'unknown']) {
      assert.equal(readingsAreCurrent({ state, consecutiveFailures: 0 }), false, state);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Firing.
// -------------------------------------------------------------------------------------------

describe('firing a threshold alarm', () => {
  it('sends the trigger notification once and schedules nothing further', () => {
    // CAPABILITIES.MD §5.1 gives a threshold trigger a trigger notification and a clear
    // notification and nothing between them: escalation and repeat belong to the state trigger,
    // where the thing being escalated is an outage.
    assert.deepEqual(fireThreshold(settings()), {
      reason: 'threshold',
      templateId: 11,
      phase: 'notified',
      nextDueAt: null,
    });
  });

  it('reports no template rather than inventing one', () => {
    assert.equal(fireThreshold(settings({ triggerTemplateId: null })).templateId, null);
  });
});

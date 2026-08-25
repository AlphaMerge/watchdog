import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyResult,
  clearedByResume,
  evaluate,
  isPaused,
  pauseCause,
  queryState,
  CHANNELS_CLEAR,
  DEFAULT_FAILURE_POLICY,
  INITIAL_SENSOR_FACTS,
  NO_PAUSE,
  type ChannelVerdict,
  type Decision,
  type FailurePolicy,
  type PauseFlags,
  type SensorFacts,
  type StateFacts,
} from '../src/state/machine.js';
import {
  PAUSE_PRECEDENCE,
  PAUSE_SOURCES,
  TRANSITIONS,
  V1_STATES,
  V2_STATES,
  type PauseSource,
  type SensorState,
} from '../src/state/tables.js';

const BASE: StateFacts = {
  pause: NO_PAUSE,
  simulatedError: false,
  probeReachable: true,
  acknowledged: false,
  scan: { kind: 'none' },
  channel: null,
};

function facts(overrides: Partial<StateFacts> = {}): StateFacts {
  return { ...BASE, ...overrides };
}

function flags(active: readonly PauseSource[]): PauseFlags {
  return {
    parent: active.includes('parent'),
    dependency: active.includes('dependency'),
    schedule: active.includes('schedule'),
    manual: active.includes('manual'),
  };
}

const AT = new Date('2026-08-25T09:00:00.000Z');
const later = (minutes: number): Date => new Date(AT.getTime() + minutes * 60_000);

const ok = { at: AT, outcome: 'ok', message: '' } as const;
const failed = { at: AT, outcome: 'error', message: 'ETIMEDOUT' } as const;

const BREACH_ERROR: ChannelVerdict = { state: 'down', cause: 'limit' };
const BREACH_WARNING: ChannelVerdict = { state: 'warning', cause: 'limit' };

/** Drives a sensor through a sequence of outcomes and reports where it lands each time. */
function run(
  outcomes: readonly ('ok' | 'error')[],
  policy: FailurePolicy = DEFAULT_FAILURE_POLICY,
  start: SensorFacts = INITIAL_SENSOR_FACTS,
): { states: SensorState[]; facts: SensorFacts } {
  let current = start;
  const states: SensorState[] = [];
  outcomes.forEach((outcome, index) => {
    const applied = applyResult(current, { at: later(index), outcome, message: '' }, policy);
    current = applied.facts;
    states.push(applied.decision.state);
  });
  return { states, facts: current };
}

// -------------------------------------------------------------------------------------------
// §3 — pause precedence. The risk PLAN.md names for the whole phase.
// -------------------------------------------------------------------------------------------

describe('pause precedence', () => {
  it('agrees with the table for every combination of the four sources', () => {
    // M-01 wrote the sixteen rows out by hand; this is the code deriving them independently.
    // Two derivations that must agree catches a mistake in either.
    assert.equal(PAUSE_PRECEDENCE.length, 2 ** PAUSE_SOURCES.length);
    for (const expected of PAUSE_PRECEDENCE) {
      const pause = flags(expected.active);
      const decision = evaluate(facts({ pause }));
      const where = `[${expected.active.join(', ') || 'none'}]`;

      assert.equal(isPaused(pause), expected.paused, where);
      assert.equal(pauseCause(pause), expected.cause, where);
      assert.equal(decision.state, expected.paused ? 'paused' : 'unknown', where);
      if (expected.cause !== null) assert.equal(decision.cause, expected.cause, where);
    }
  });

  it('stays paused when the reported source clears but another still holds it', () => {
    // The bug the four independent flags exist to make unreachable. As a priority chain,
    // resuming the highest-precedence source would resume the sensor.
    const held = flags(['parent', 'manual']);
    assert.equal(evaluate(facts({ pause: held })).cause, 'parent');

    const parentResumed: PauseFlags = { ...held, parent: false };
    const after = evaluate(facts({ pause: parentResumed }));
    assert.equal(after.state, 'paused', 'the manual pause is still set');
    assert.equal(after.cause, 'user', 'and it is now what the operator is told');
  });

  it('beats a simulated error, a lost probe and an acknowledgement', () => {
    const decision = evaluate(
      facts({
        pause: flags(['manual']),
        simulatedError: true,
        probeReachable: false,
        acknowledged: true,
        scan: { kind: 'failed', consecutiveFailures: 9 },
      }),
    );
    assert.deepEqual(decision, { state: 'paused', cause: 'user' });
  });

  it('resumes to unknown, never to the state it had before', () => {
    const { facts: down } = run(['error', 'error']);
    assert.equal(evaluate(down).state, 'down');

    const resumed = clearedByResume(down);
    assert.deepEqual(evaluate(resumed), { state: 'unknown', cause: 'scan' });
    assert.equal(resumed.lastResultAt, null, 'it awaits its next scan');
  });
});

// -------------------------------------------------------------------------------------------
// §2 — the layered model, in the order the layers are evaluated.
// -------------------------------------------------------------------------------------------

describe('layered evaluation', () => {
  const cases: { name: string; facts: StateFacts; expect: Decision }[] = [
    {
      name: 'nothing has happened yet',
      facts: facts(),
      expect: { state: 'unknown', cause: 'scan' },
    },
    {
      name: 'a simulated error forces down',
      facts: facts({ simulatedError: true, scan: { kind: 'ok' }, channel: CHANNELS_CLEAR }),
      expect: { state: 'down', cause: 'simulated' },
    },
    {
      name: 'a lost probe is unknown, not down',
      facts: facts({ probeReachable: false, scan: { kind: 'ok' } }),
      expect: { state: 'unknown', cause: 'probe' },
    },
    {
      name: 'a simulated error still beats a lost probe',
      facts: facts({ simulatedError: true, probeReachable: false }),
      expect: { state: 'down', cause: 'simulated' },
    },
    {
      name: 'a successful scan within limits is up',
      facts: facts({ scan: { kind: 'ok' }, channel: CHANNELS_CLEAR }),
      expect: { state: 'up', cause: 'scan' },
    },
    {
      name: 'a warning limit on a successful scan',
      facts: facts({ scan: { kind: 'ok' }, channel: BREACH_WARNING }),
      expect: { state: 'warning', cause: 'limit' },
    },
    {
      name: 'an error limit is down on the first reading, with no two-step',
      facts: facts({ scan: { kind: 'ok' }, channel: BREACH_ERROR }),
      expect: { state: 'down', cause: 'limit' },
    },
    {
      name: 'the channel cause wins a tie, because it says more',
      facts: facts({ scan: { kind: 'failed', consecutiveFailures: 2 }, channel: BREACH_ERROR }),
      // ...but only if the scan produced readings at all — see the next case.
      expect: { state: 'down', cause: 'scan' },
    },
    {
      name: 'an acknowledged down',
      facts: facts({
        acknowledged: true,
        scan: { kind: 'failed', consecutiveFailures: 2 },
      }),
      expect: { state: 'down_acknowledged', cause: 'user' },
    },
    {
      name: 'an acknowledgement does not touch a warning',
      facts: facts({ acknowledged: true, scan: { kind: 'failed', consecutiveFailures: 1 } }),
      expect: { state: 'warning', cause: 'scan' },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.deepEqual(evaluate(testCase.facts), testCase.expect);
    });
  }

  it('ignores a channel verdict when the scan failed, because there were no readings', () => {
    // Invariant 9. A failed check records no channel values at all, so a verdict carried over
    // from before the outage would keep a stale limit breach alive and blame a threshold for
    // something that is a connectivity failure.
    const stale = facts({
      scan: { kind: 'failed', consecutiveFailures: 1 },
      channel: BREACH_ERROR,
    });
    assert.deepEqual(evaluate(stale), { state: 'warning', cause: 'scan' });
  });

  it('is deterministic — the same facts always give the same answer', () => {
    const sample = facts({ scan: { kind: 'ok' }, channel: BREACH_WARNING, acknowledged: true });
    const first = evaluate(sample);
    for (let index = 0; index < 50; index += 1) assert.deepEqual(evaluate(sample), first);
  });
});

// -------------------------------------------------------------------------------------------
// §2.1 — the two-step rule.
// -------------------------------------------------------------------------------------------

describe('failure policy', () => {
  it('warns on the first failure and goes down on the second', () => {
    assert.deepEqual(run(['ok', 'error', 'error', 'error']).states, [
      'up',
      'warning',
      'down',
      'down',
    ]);
  });

  it('goes down on the first failure under the immediate policy', () => {
    assert.deepEqual(run(['ok', 'error'], { warnFor: 0 }).states, ['up', 'down']);
  });

  it('holds warning for N failures under a longer policy', () => {
    assert.deepEqual(run(['error', 'error', 'error', 'error'], { warnFor: 3 }).states, [
      'warning',
      'warning',
      'warning',
      'down',
    ]);
  });

  it('resets the count on a success, so a flapping target does not accumulate', () => {
    assert.deepEqual(run(['error', 'ok', 'error']).states, ['warning', 'up', 'warning']);
  });

  it('counts scans, not elapsed time', () => {
    // docs/state-machine.md §6 records the assumption; this is the test that pins it.
    const one = queryState({ kind: 'failed', consecutiveFailures: 1 }, DEFAULT_FAILURE_POLICY);
    const two = queryState({ kind: 'failed', consecutiveFailures: 2 }, DEFAULT_FAILURE_POLICY);
    assert.equal(one?.state, 'warning');
    assert.equal(two?.state, 'down');
  });
});

// -------------------------------------------------------------------------------------------
// §2.4 — acknowledgement.
// -------------------------------------------------------------------------------------------

describe('acknowledgement', () => {
  const acknowledgedDown = (until: Date | null): SensorFacts => {
    const { facts: down } = run(['error', 'error']);
    return { ...down, acknowledged: true, acknowledgedUntil: until };
  };

  it('suppresses a down without stopping the scanning', () => {
    const acknowledged = acknowledgedDown(null);
    const applied = applyResult(acknowledged, { ...failed, at: later(10) });
    assert.equal(applied.decision.state, 'down_acknowledged');
    assert.equal(applied.decision.cause, 'user');
    assert.equal(applied.facts.lastResultAt?.toISOString(), later(10).toISOString());
  });

  it('is cleared by recovery, in the same result that recovers', () => {
    const applied = applyResult(acknowledgedDown(null), { ...ok, at: later(10) });
    assert.deepEqual(applied.decision, { state: 'up', cause: 'scan' });
    assert.equal(applied.facts.acknowledged, false, 'the next outage alarms again');
  });

  it('is cleared by recovery to a warning, not only to up', () => {
    // The edge §4.1 records as missing from WORKFLOW.MD's diagram.
    const applied = applyResult(acknowledgedDown(null), {
      at: later(10),
      outcome: 'ok',
      message: '',
      channel: BREACH_WARNING,
    });
    assert.equal(applied.decision.state, 'warning');
    assert.equal(applied.facts.acknowledged, false);
  });

  it('expires back to down while still failing', () => {
    const applied = applyResult(acknowledgedDown(later(5)), { ...failed, at: later(6) });
    assert.deepEqual(applied.decision, { state: 'down', cause: 'user' });
    assert.equal(applied.facts.acknowledged, false);
  });

  it('expires against the result clock, so a replay writes the history it would have live', () => {
    const acknowledged = acknowledgedDown(later(5));
    const before = applyResult(acknowledged, { ...failed, at: later(4) });
    assert.equal(before.decision.state, 'down_acknowledged', 'still inside the window');
    const at = applyResult(acknowledged, { ...failed, at: later(5) });
    assert.equal(at.decision.state, 'down', 'and lapsed exactly on it');
  });

  it('is not cleared by a lost probe, which is not recovery', () => {
    const lost: SensorFacts = { ...acknowledgedDown(null), probeReachable: false };
    const applied = applyResult(lost, { ...failed, at: later(10) });
    assert.equal(applied.decision.state, 'unknown');
    assert.equal(
      applied.facts.acknowledged,
      true,
      'un-suppressing an outage because a probe restarted would alarm for something unfixed',
    );
  });

  it('is cleared by a resume', () => {
    assert.equal(clearedByResume(acknowledgedDown(null)).acknowledged, false);
  });
});

// -------------------------------------------------------------------------------------------
// §5 — the invariants, as invariants.
// -------------------------------------------------------------------------------------------

describe('invariants', () => {
  /** Every combination of the layered inputs, which is what "totality" has to be checked over. */
  function* everyFacts(): Generator<StateFacts> {
    const scans = [
      { kind: 'none' },
      { kind: 'ok' },
      { kind: 'failed', consecutiveFailures: 1 },
      { kind: 'failed', consecutiveFailures: 2 },
      { kind: 'failed', consecutiveFailures: 7 },
    ] as const;
    const channels = [null, CHANNELS_CLEAR, BREACH_WARNING, BREACH_ERROR];
    for (const pauseCase of PAUSE_PRECEDENCE) {
      for (const simulatedError of [false, true]) {
        for (const probeReachable of [true, false]) {
          for (const acknowledged of [false, true]) {
            for (const scan of scans) {
              for (const channel of channels) {
                yield {
                  pause: flags(pauseCase.active),
                  simulatedError,
                  probeReachable,
                  acknowledged,
                  scan,
                  channel,
                };
              }
            }
          }
        }
      }
    }
  }

  it('produces exactly one defined v1 state for every combination of inputs', () => {
    // Phase 3's exit criterion, over the whole input space rather than a sample of it.
    let checked = 0;
    for (const input of everyFacts()) {
      const decision = evaluate(input);
      assert.ok(
        (V1_STATES as readonly SensorState[]).includes(decision.state),
        `${decision.state} is not a v1 state`,
      );
      assert.ok(
        !(V2_STATES as readonly SensorState[]).includes(decision.state),
        'invariant 3: no v1 path reaches unusual or down_partial',
      );
      checked += 1;
    }
    assert.equal(checked, 16 * 2 * 2 * 2 * 5 * 4, 'the whole space, not a corner of it');
  });

  it('names a cause an operator can act on, every time', () => {
    for (const input of everyFacts()) {
      const decision = evaluate(input);
      assert.ok(decision.cause.length > 0);
    }
  });

  it('pauses whenever any source is active, whatever else is true', () => {
    for (const input of everyFacts()) {
      if (!isPaused(input.pause)) continue;
      assert.equal(evaluate(input).state, 'paused');
    }
  });

  it('reaches down_acknowledged only from a computed down', () => {
    for (const input of everyFacts()) {
      if (evaluate(input).state !== 'down_acknowledged') continue;
      assert.equal(input.acknowledged, true);
      const withoutAck = evaluate({ ...input, acknowledged: false });
      assert.equal(withoutAck.state, 'down', 'invariant 7');
    }
  });

  it('makes no move the transition table did not anticipate', () => {
    // Every state reachable from every other, driven through the reducer, and checked against
    // the table M-01 wrote. A transition the tables did not anticipate is either a bug or a
    // specification gap, and both are worth stopping for.
    const allowed = new Set(
      TRANSITIONS.flatMap((transition) =>
        transition.causes.map((cause) => `${transition.from}->${transition.to}:${cause}`),
      ),
    );

    const seeds: { name: string; facts: SensorFacts }[] = [
      { name: 'fresh', facts: INITIAL_SENSOR_FACTS },
      { name: 'up', facts: run(['ok']).facts },
      { name: 'warning', facts: run(['error']).facts },
      { name: 'down', facts: run(['error', 'error']).facts },
      {
        name: 'acknowledged',
        facts: { ...run(['error', 'error']).facts, acknowledged: true, acknowledgedUntil: null },
      },
      { name: 'paused', facts: { ...run(['ok']).facts, pause: flags(['manual']) } },
    ];

    // `when` rules out an event that cannot happen from a state, rather than letting the test
    // invent one: only a paused sensor can be resumed, and asserting on the answer to a
    // question the system never asks would be checking the test's imagination.
    const events: {
      name: string;
      apply: (from: SensorFacts) => Decision;
      when?: (from: SensorState) => boolean;
    }[] = [
      { name: 'ok', apply: (from) => applyResult(from, { ...ok, at: later(99) }).decision },
      { name: 'error', apply: (from) => applyResult(from, { ...failed, at: later(99) }).decision },
      {
        name: 'error limit',
        apply: (from) =>
          applyResult(from, { ...ok, at: later(99), channel: BREACH_ERROR }).decision,
      },
      {
        name: 'warning limit',
        apply: (from) =>
          applyResult(from, { ...ok, at: later(99), channel: BREACH_WARNING }).decision,
      },
      { name: 'paused', apply: (from) => evaluate({ ...from, pause: flags(['dependency']) }) },
      {
        name: 'resumed',
        apply: (from) => evaluate(clearedByResume(from)),
        when: (from) => from === 'paused',
      },
      { name: 'probe lost', apply: (from) => evaluate({ ...from, probeReachable: false }) },
      { name: 'simulated', apply: (from) => evaluate({ ...from, simulatedError: true }) },
    ];

    for (const seed of seeds) {
      const from = evaluate(seed.facts).state;
      for (const event of events) {
        if (event.when !== undefined && !event.when(from)) continue;
        const to = event.apply(seed.facts);
        if (to.state === from && to.cause === evaluate(seed.facts).cause) continue;
        assert.ok(
          allowed.has(`${from}->${to.state}:${to.cause}`),
          `${seed.name} (${from}) --${event.name}--> ${to.state} (${to.cause}) is not in TRANSITIONS`,
        );
      }
    }
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  applyResult,
  clearedByRecovery,
  clearedByResume,
  evaluate,
  CHANNELS_CLEAR,
  isPaused,
  isStaleResult,
  pauseCause,
  DEFAULT_FAILURE_POLICY,
  INITIAL_SENSOR_FACTS,
  type ChannelVerdict,
  type Decision,
  type FailurePolicy,
  type SensorFacts,
} from '../src/state/machine.js';
import { canAcknowledge } from '../src/state/acknowledgement.js';
import {
  PAUSE_SOURCES,
  TRANSITIONS,
  V1_STATES,
  V2_STATES,
  type PauseSource,
  type SensorState,
  type SensorStateCause,
} from '../src/state/tables.js';

/**
 * `M-16`: the state machine over *sequences*, not snapshots.
 *
 * `state-machine.test.ts` already drives `evaluate` over the entire static input space — all
 * sixteen pause combinations × simulated × probe × acknowledged × five scan facts × four channel
 * verdicts — and that is exhaustive, not sampled. What it cannot reach is anything that depends
 * on *history*: the two-step failure policy counts consecutive scans, an acknowledgement expires
 * against the result clock, a resume forgets what was measured before it, and a duplicate
 * delivery must not advance any of them. Those are properties of a fold, and a fold has no
 * finite input space to enumerate.
 *
 * So this generates sequences and checks the invariants after every step. `PLAN.md`'s Phase 3
 * exit criterion is the first property below; the rest are §5 written as code.
 */

// -------------------------------------------------------------------------------------------
// The model: exactly what production does to a sensor, and nothing else.
// -------------------------------------------------------------------------------------------

type Event =
  | {
      readonly kind: 'result';
      readonly minute: number;
      readonly ok: boolean;
      readonly channel: ChannelVerdict | null;
    }
  | { readonly kind: 'pause'; readonly source: PauseSource; readonly on: boolean }
  | { readonly kind: 'acknowledge'; readonly untilMinute: number | null }
  | { readonly kind: 'clearAcknowledgement' }
  | { readonly kind: 'simulate'; readonly on: boolean }
  | { readonly kind: 'probe'; readonly reachable: boolean };

interface Step {
  readonly event: Event;
  readonly before: SensorFacts;
  readonly after: SensorFacts;
  readonly previousState: SensorState;
  readonly previousCause: SensorStateCause;
  readonly decision: Decision;
  /** False when a result was discarded as stale — nothing moved, nothing was recorded. */
  readonly applied: boolean;
}

const T0 = Date.UTC(2026, 7, 25, 12, 0, 0);

function at(minute: number): Date {
  return new Date(T0 + minute * 60_000);
}

/**
 * One event applied, mirroring the production paths.
 *
 * A result goes through `SensorStateService.decide`'s stale guard and `applyResult`; everything
 * else goes through `reevaluate`'s shape — change the fact, clear what a resume clears, then
 * `evaluate`. Both use the real functions; nothing here reimplements a rule.
 */
function step(
  facts: SensorFacts,
  state: SensorState,
  cause: SensorStateCause,
  event: Event,
  policy: FailurePolicy,
): Step {
  const base = { event, before: facts, previousState: state, previousCause: cause } as const;

  if (event.kind === 'result') {
    if (isStaleResult(facts, at(event.minute))) {
      return { ...base, after: facts, decision: { state, cause }, applied: false };
    }
    const applied = applyResult(
      facts,
      {
        at: at(event.minute),
        outcome: event.ok ? 'ok' : 'error',
        message: '',
        channel: event.ok ? event.channel : null,
      },
      policy,
    );
    return { ...base, after: applied.facts, decision: applied.decision, applied: true };
  }

  // §2.4 applies only to `down`, and `M-13` refuses an acknowledgement on anything else — so a
  // sequence that acknowledges an Up sensor is one the system cannot produce. Modelled with the
  // production predicate rather than a copy of the rule: the table property found this by
  // reaching `unknown -> down : user`, which is what an acknowledgement expiring on a sensor
  // that was never Down would look like, and which nothing can reach.
  if (event.kind === 'acknowledge' && !canAcknowledge(state)) {
    return { ...base, after: facts, decision: { state, cause }, applied: false };
  }

  const changed = withEvent(facts, event);
  // §3: when the last pause source clears, the sensor forgets what it measured before the
  // pause — reporting a state nothing has checked since would be worse than saying Unknown.
  const resuming = !isPaused(changed.pause) && state === 'paused';
  const resumed = resuming ? clearedByResume(changed) : changed;
  const decision = evaluate(resumed, policy);
  // §2.4's recovery clearing, which `reevaluate` applies on this path too.
  return { ...base, after: clearedByRecovery(resumed, decision), decision, applied: true };
}

function withEvent(facts: SensorFacts, event: Event): SensorFacts {
  switch (event.kind) {
    case 'pause':
      return { ...facts, pause: { ...facts.pause, [event.source]: event.on } };
    case 'acknowledge':
      return {
        ...facts,
        acknowledged: true,
        acknowledgedUntil: event.untilMinute === null ? null : at(event.untilMinute),
      };
    case 'clearAcknowledgement':
      return { ...facts, acknowledged: false, acknowledgedUntil: null };
    case 'simulate':
      return { ...facts, simulatedError: event.on };
    case 'probe':
      return { ...facts, probeReachable: event.reachable };
    case 'result':
      return facts;
  }
}

/** The whole run, so a property can look at every step rather than only the last. */
function run(events: readonly Event[], policy = DEFAULT_FAILURE_POLICY): Step[] {
  let facts = INITIAL_SENSOR_FACTS;
  let state: SensorState = 'unknown';
  let cause: SensorStateCause = 'scan';
  const steps: Step[] = [];

  for (const event of events) {
    const result = step(facts, state, cause, event, policy);
    steps.push(result);
    facts = result.after;
    state = result.decision.state;
    cause = result.decision.cause;
  }
  return steps;
}

// -------------------------------------------------------------------------------------------
// Generators.
// -------------------------------------------------------------------------------------------

/**
 * Only the verdicts `rollUp` can actually return.
 *
 * A clear channel is `CHANNELS_CLEAR` — `up` with cause **`scan`**, because "within limits" is
 * not a fact about a limit — and only a breach carries `limit` or `lookup`. The first draft of
 * this generator invented `up` with cause `limit`, and the table property caught it immediately:
 * `unknown -> up : limit` is a transition `M-01` does not describe, and rightly, because nothing
 * can produce it. A generator that can build inputs the system cannot is a generator that
 * reports bugs in itself.
 */
const channelVerdict = fc.constantFrom<ChannelVerdict | null>(
  null,
  CHANNELS_CLEAR,
  { state: 'warning', cause: 'limit' },
  { state: 'down', cause: 'limit' },
  { state: 'warning', cause: 'lookup' },
  { state: 'down', cause: 'lookup' },
);

/**
 * Minutes are small and repeat on purpose.
 *
 * A generator with a wide clock would almost never produce two results at the same instant, and
 * the equal-timestamp case is exactly where the at-least-once protocol lives. A range this
 * narrow makes duplicates and out-of-order deliveries common rather than rare.
 */
const minute = fc.integer({ min: 0, max: 12 });

const resultEvent = fc.record({
  kind: fc.constant('result' as const),
  minute,
  ok: fc.boolean(),
  channel: channelVerdict,
});

const anyEvent: fc.Arbitrary<Event> = fc.oneof(
  { arbitrary: resultEvent, weight: 6 },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('pause' as const),
      source: fc.constantFrom(...PAUSE_SOURCES),
      on: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('acknowledge' as const),
      untilMinute: fc.option(minute, { nil: null }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'clearAcknowledgement' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('simulate' as const), on: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('probe' as const), reachable: fc.boolean() }),
  },
);

const sequence = fc.array(anyEvent, { minLength: 1, maxLength: 40 });
const policy: fc.Arbitrary<FailurePolicy> = fc.record({
  warnFor: fc.integer({ min: 0, max: 4 }),
});

/**
 * What `SensorStateService.decide` does to one batch before folding it: sort by time.
 *
 * The sort is the reason intra-batch order does not matter. It is deliberately *not* a
 * cross-batch guarantee — a result that arrives in a later batch than one newer than it is
 * discarded, and that is the documented behaviour rather than a gap. The first version of the
 * property below asserted the stronger thing and was wrong: delivering minute 1 and then minute
 * 0 leaves one failure counted, while the sorted sequence counts two, and the machine is right
 * both times.
 */
function asBatch(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) =>
    a.kind === 'result' && b.kind === 'result' ? a.minute - b.minute : 0,
  );
}

function factsKey(facts: SensorFacts): string {
  return JSON.stringify({
    pause: facts.pause,
    simulatedError: facts.simulatedError,
    probeReachable: facts.probeReachable,
    acknowledged: facts.acknowledged,
    acknowledgedUntil: facts.acknowledgedUntil?.toISOString() ?? null,
    scan: facts.scan,
    channel: facts.channel,
    lastResultAt: facts.lastResultAt?.toISOString() ?? null,
  });
}

// -------------------------------------------------------------------------------------------
// The properties.
// -------------------------------------------------------------------------------------------

describe('the state machine over event sequences', () => {
  /**
   * Enough to find things in a normal run, and turnable up when it matters.
   *
   * Every counterexample this suite has produced so far shrank to three or four events, so the
   * default is not about depth — it is about how many *shapes* get tried. `MS_PROPERTY_RUNS`
   * exists for the deeper sweep worth running when the machine changes, and for CI if the
   * schedule ever allows it; a 20,000-run pass takes a few seconds because the machine is pure.
   */
  const RUNS = Number(process.env['MS_PROPERTY_RUNS'] ?? '500');

  it('never reaches an undefined state, whatever happens in what order', () => {
    // `PLAN.md` Phase 3's exit criterion, over sequences rather than over one snapshot.
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          assert.ok(
            (V1_STATES as readonly SensorState[]).includes(taken.decision.state),
            `${taken.decision.state} is not a v1 state`,
          );
          assert.ok(
            !(V2_STATES as readonly SensorState[]).includes(taken.decision.state),
            'no v1 path reaches unusual or down_partial',
          );
          assert.ok(taken.decision.cause.length > 0, 'every state names a cause');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('makes no move the M-01 tables do not describe', () => {
    // `M-02` asserted this over hand-written scenarios and found two gaps in the tables.
    // Sequences reach transitions nobody thought to write down, which is the point.
    const allowed = new Set(
      TRANSITIONS.flatMap((transition) =>
        transition.causes.map((cause) => `${transition.from}->${transition.to}:${cause}`),
      ),
    );
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (!taken.applied) continue;
          // A re-entry with the same cause is not an event at all (§5 invariant 10 is about
          // the ones where the cause *did* change, and those must be in the tables).
          const same =
            taken.decision.state === taken.previousState &&
            taken.decision.cause === taken.previousCause;
          if (same) continue;
          const key = `${taken.previousState}->${taken.decision.state}:${taken.decision.cause}`;
          assert.ok(allowed.has(key), `the tables do not describe ${key}`);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('is paused exactly when a source holds it, and reports the first one', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          const held = isPaused(taken.after.pause);
          assert.equal(
            taken.decision.state === 'paused',
            held,
            'invariant 4: pause beats everything, and nothing else produces paused',
          );
          if (held) assert.equal(taken.decision.cause, pauseCause(taken.after.pause));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('acknowledges only what is otherwise Down', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (taken.decision.state !== 'down_acknowledged') continue;
          // Invariant 7: reachable only from a computed `down`. Asking the machine again with
          // the acknowledgement removed is the only honest way to check "otherwise".
          const withoutAck = evaluate({ ...taken.after, acknowledged: false }, failurePolicy);
          assert.equal(withoutAck.state, 'down');
          assert.equal(taken.decision.cause, 'user');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('yields Unknown on a resume, never the state from before the pause', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          const resumed =
            taken.previousState === 'paused' &&
            taken.decision.state !== 'paused' &&
            taken.event.kind === 'pause';
          if (!resumed) continue;
          // Invariant 8. A simulated error still outranks it, and that is layer 2 doing its job.
          if (taken.after.simulatedError) {
            assert.equal(taken.decision.state, 'down');
            continue;
          }
          assert.equal(taken.decision.state, 'unknown');
          assert.equal(taken.after.lastResultAt, null, 'and it forgot what it measured');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('produces no channel-derived state from a failed scan', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (taken.event.kind !== 'result' || taken.event.ok || !taken.applied) continue;
          // Invariant 9: a failed check produced no channel values, so nothing may be judged
          // from them — whatever the previous reading's verdict was.
          assert.equal(taken.after.channel, null);
          assert.notEqual(taken.decision.cause, 'limit');
          assert.notEqual(taken.decision.cause, 'lookup');
        }
      }),
      { numRuns: RUNS },
    );
  });

  // -----------------------------------------------------------------------------------------
  // The at-least-once protocol, which is where a fold can be wrong in a way a snapshot cannot.
  // -----------------------------------------------------------------------------------------

  it('does not care what order a batch arrived in', () => {
    // The safety property behind `R-02`: a spool replays whatever order it was written in, and a
    // probe may batch several intervals together. `decide` sorts before folding, so the outcome
    // must depend on the *set* of results and not on their arrival order.
    fc.assert(
      fc.property(
        fc
          .uniqueArray(resultEvent, { selector: (event) => event.minute, maxLength: 20 })
          .chain((events) =>
            fc.tuple(
              fc.constant(events),
              fc.shuffledSubarray(events, {
                minLength: events.length,
                maxLength: events.length,
              }),
            ),
          ),
        policy,
        ([ordered, shuffled], failurePolicy) => {
          const a = run(asBatch(ordered), failurePolicy).at(-1);
          const b = run(asBatch(shuffled), failurePolicy).at(-1);
          assert.equal(
            factsKey(b?.after ?? INITIAL_SENSOR_FACTS),
            factsKey(a?.after ?? INITIAL_SENSOR_FACTS),
          );
          assert.equal(b?.decision.state, a?.decision.state);
          assert.equal(b?.decision.cause, a?.decision.cause);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('applies one result per instant, whatever a batch claims', () => {
    // A sensor scans once per instant, and the storage agrees — `sample` has
    // `ON CONFLICT (channel_id, time) DO NOTHING` and `sensor_state` a unique `(sensor_id,
    // time)`. So a batch carrying two results for one timestamp must advance the machine once.
    fc.assert(
      fc.property(fc.array(resultEvent, { minLength: 1, maxLength: 20 }), (events) => {
        const batch = asBatch(events);
        const distinct = new Set(
          batch.map((event) => (event.kind === 'result' ? event.minute : -1)),
        ).size;
        assert.equal(run(batch).filter((taken) => taken.applied).length, distinct);
      }),
      { numRuns: RUNS },
    );
  });

  it('discards a redelivery without moving anything at all', () => {
    fc.assert(
      fc.property(fc.array(resultEvent, { minLength: 1, maxLength: 20 }), (events) => {
        // Every result, then every result again, in the same order. The second pass is entirely
        // stale by construction, so nothing may move — not the failure count, not the clock.
        const once = run(events);
        const twice = run([...events, ...events]);
        const settled = once.filter((taken) => taken.applied).at(-1);
        const later = twice.filter((taken) => taken.applied).at(-1);
        assert.equal(
          factsKey(later?.after ?? INITIAL_SENSOR_FACTS),
          factsKey(settled?.after ?? INITIAL_SENSOR_FACTS),
        );
        assert.equal(
          twice.filter((taken) => taken.applied).length,
          once.filter((taken) => taken.applied).length,
          'the redelivered half applied nothing',
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('never advances a failure count on a result it discarded', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (taken.applied) continue;
          assert.equal(factsKey(taken.after), factsKey(taken.before), 'a discard is a no-op');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('counts consecutive failures, and only consecutive ones', () => {
    fc.assert(
      fc.property(fc.array(resultEvent, { maxLength: 25 }), policy, (events, failurePolicy) => {
        let expected = 0;
        for (const taken of run(events, failurePolicy)) {
          if (!taken.applied || taken.event.kind !== 'result') continue;
          expected = taken.event.ok ? 0 : expected + 1;
          const counted =
            taken.after.scan.kind === 'failed' ? taken.after.scan.consecutiveFailures : 0;
          // §2.1: N counts *scans*, so one success resets it however long the run was.
          assert.equal(counted, expected);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('honours the failure policy: warning for the first N, Down after', () => {
    fc.assert(
      fc.property(fc.array(resultEvent, { maxLength: 25 }), policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (!taken.applied || taken.event.kind !== 'result' || taken.event.ok) continue;
          // Only when the reading is what decided it: layers 1 to 3 short-circuit above.
          if (isPaused(taken.after.pause) || taken.after.simulatedError) continue;
          if (!taken.after.probeReachable) continue;
          const failures =
            taken.after.scan.kind === 'failed' ? taken.after.scan.consecutiveFailures : 0;
          const expected = failures > failurePolicy.warnFor ? 'down' : 'warning';
          const actual =
            taken.decision.state === 'down_acknowledged' ? 'down' : taken.decision.state;
          assert.equal(actual, expected, `after ${String(failures)} failures`);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('clears an acknowledgement only on a genuine recovery, however it arrived', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (!taken.before.acknowledged || taken.after.acknowledged) continue;

          // The three §2.4 names — withdrawn, resumed, expired — and then the general rule.
          if (taken.event.kind === 'clearAcknowledgement') continue;
          if (taken.event.kind === 'pause' && taken.previousState === 'paused') continue;
          if (taken.event.kind === 'result') {
            const expired =
              taken.before.acknowledgedUntil !== null &&
              taken.before.acknowledgedUntil.getTime() <= at(taken.event.minute).getTime();
            if (expired) continue;
          }

          // Everything else must be a recovery the *reading* decided, whatever event exposed
          // it — lifting a simulated error is one, and before `M-16` it did not clear. What
          // must never clear it is a layer that short-circuited above the reading: a lost probe
          // is not a recovery, and clearing there would un-suppress an outage nobody has fixed.
          assert.ok(
            !isPaused(taken.after.pause) &&
              !taken.after.simulatedError &&
              taken.after.probeReachable,
            `${taken.event.kind} cleared an acknowledgement without a reading deciding it`,
          );
          assert.notEqual(taken.decision.state, 'down');
          assert.notEqual(taken.decision.state, 'down_acknowledged');
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('never leaves an acknowledgement on a sensor that is not Down', () => {
    // The bug `M-16` found, stated as the invariant that would have caught it: an
    // acknowledgement silences notifications, so one sitting on a healthy sensor is a silencer
    // waiting for an outage nobody has seen yet.
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        for (const taken of run(events, failurePolicy)) {
          if (!taken.after.acknowledged) continue;
          // Only while a layer above the reading is hiding the outage may it be carried on a
          // state that is not Down — the outage is still there, and still acknowledged.
          const hidden =
            isPaused(taken.after.pause) ||
            taken.after.simulatedError ||
            !taken.after.probeReachable;
          if (hidden) continue;
          assert.ok(
            taken.decision.state === 'down' || taken.decision.state === 'down_acknowledged',
            `an acknowledgement survived onto ${taken.decision.state}`,
          );
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('is deterministic: the same sequence gives the same run twice', () => {
    fc.assert(
      fc.property(sequence, policy, (events, failurePolicy) => {
        const first = run(events, failurePolicy).map(
          (taken) => `${taken.decision.state}:${taken.decision.cause}`,
        );
        const second = run(events, failurePolicy).map(
          (taken) => `${taken.decision.state}:${taken.decision.cause}`,
        );
        assert.deepEqual(first, second);
      }),
      { numRuns: 100 },
    );
  });
});

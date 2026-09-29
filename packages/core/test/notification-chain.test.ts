import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  chainStopped,
  escalationDueAt,
  fire,
  initialDueAt,
  isRecovery,
  nextDueAfter,
  reconcile,
  recoveryConfirmAt,
  stillStanding,
  templateFor,
  type Alarm,
  type StateTriggerSettings,
} from '../src/notifications/chain.js';
import { V1_STATES, type SensorState } from '../src/state/tables.js';

const T0 = new Date('2026-08-26T10:00:00Z');
const at = (secondsFromT0: number): Date => new Date(T0.getTime() + secondsFromT0 * 1000);

function settings(overrides: Partial<StateTriggerSettings> = {}): StateTriggerSettings {
  return {
    state: 'down',
    initialLatencySeconds: 0,
    initialTemplateId: 1,
    escalationLatencySeconds: 0,
    escalationTemplateId: null,
    repeatMinutes: 0,
    recoveryTemplateId: null,
    recoveryHoldSeconds: 0,
    ...overrides,
  };
}

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    state: 'down',
    since: T0,
    phase: 'pending',
    nextDueAt: T0,
    repeats: 0,
    suppressed: false,
    recoveringSince: null,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// Which states keep an alarm standing.
// -------------------------------------------------------------------------------------------

describe('an alarm standing', () => {
  it('stands while the sensor is in the state that armed it', () => {
    for (const state of V1_STATES) {
      assert.equal(stillStanding(state, state), true, state);
    }
  });

  it('treats an acknowledged Down as still Down', () => {
    // The subtle one. `down_acknowledged` is a different state, so the naive comparison ends the
    // alarm and fires a recovery — telling everybody the sensor came back at the exact moment an
    // operator said "I know, I am on it".
    assert.equal(stillStanding('down', 'down_acknowledged'), true);
  });

  it('does not stand for any other state', () => {
    const others = V1_STATES.filter(
      (state) => state !== 'down' && state !== 'down_acknowledged',
    ) as SensorState[];
    for (const state of others) {
      assert.equal(stillStanding('down', state), false, `down should not stand while ${state}`);
    }
    // And the reverse of the acknowledgement rule is not true: a trigger armed on
    // `down_acknowledged` is not held up by a plain Down.
    assert.equal(stillStanding('down_acknowledged', 'down'), false);
  });

  it('stops the chain only for an acknowledgement', () => {
    for (const state of V1_STATES) {
      assert.equal(chainStopped(state), state === 'down_acknowledged', state);
    }
  });

  it('calls only a return to Up a recovery', () => {
    // CAPABILITIES.MD §5.1: "recovery notification on return to Up". A Down sensor that goes
    // Unknown because its probe died has not recovered, and a paused one has not either. A false
    // all-clear is worse than silence, because somebody stops looking.
    for (const state of V1_STATES) {
      assert.equal(isRecovery(state), state === 'up', state);
    }
  });
});

// -------------------------------------------------------------------------------------------
// When each step falls due.
// -------------------------------------------------------------------------------------------

describe('due times', () => {
  it('measures the initial latency from the state’s own beginning', () => {
    // Not from when the engine noticed. Otherwise a five-minute latency becomes "five minutes
    // after whenever ms-core was last deployed".
    assert.deepEqual(initialDueAt(T0, settings({ initialLatencySeconds: 300 })), at(300));
  });

  it('fires immediately at zero latency', () => {
    assert.deepEqual(initialDueAt(T0, settings()), T0);
  });

  it('measures the escalation from the same beginning, not from the initial notification', () => {
    // WORKFLOW.MD §6 starts both timers at the state change: "notify after 5 minutes, escalate
    // after 30" means thirty minutes of outage, not thirty-five.
    const config = settings({ initialLatencySeconds: 300, escalationLatencySeconds: 1800 });
    assert.deepEqual(escalationDueAt(T0, config), at(1800));
  });

  it('treats a zero escalation latency as no escalation', () => {
    assert.equal(escalationDueAt(T0, settings({ escalationLatencySeconds: 0 })), null);
  });

  it('goes to the escalation after the initial notification, then to repeats', () => {
    const config = settings({
      initialLatencySeconds: 60,
      escalationLatencySeconds: 600,
      repeatMinutes: 30,
    });
    assert.deepEqual(nextDueAfter('notified', T0, at(60), config), at(600));
    assert.deepEqual(nextDueAfter('escalated', T0, at(600), config), at(600 + 1800));
  });

  it('never schedules an escalation into the past', () => {
    // An escalation latency shorter than the initial one is a misconfiguration, not an
    // instruction to fire in a loop.
    const config = settings({ initialLatencySeconds: 600, escalationLatencySeconds: 60 });
    assert.deepEqual(nextDueAfter('notified', T0, at(600), config), at(600));
  });

  it('stops when there is no escalation and no repeat', () => {
    assert.equal(nextDueAfter('notified', T0, at(0), settings()), null);
  });

  it('measures a repeat from the send, not from the outage', () => {
    // "Tell me again every hour", not "at fixed points relative to an outage that started at
    // 03:47".
    const config = settings({ repeatMinutes: 60 });
    assert.deepEqual(nextDueAfter('notified', T0, at(3_600), config), at(7_200));
  });
});

// -------------------------------------------------------------------------------------------
// Which template each step uses.
// -------------------------------------------------------------------------------------------

describe('templates', () => {
  const config = settings({
    initialTemplateId: 1,
    escalationTemplateId: 2,
    recoveryTemplateId: 3,
  });

  it('uses the template named for each step', () => {
    assert.equal(templateFor('initial', 'notified', config), 1);
    assert.equal(templateFor('escalation', 'escalated', config), 2);
    assert.equal(templateFor('recovery', 'notified', config), 3);
  });

  it('repeats whatever the chain last said', () => {
    assert.equal(templateFor('repeat', 'escalated', config), 2);
    assert.equal(templateFor('repeat', 'notified', config), 1);
  });

  it('falls back to the initial template for a repeat with no escalation template', () => {
    // A trigger with a repeat and no escalation is an ordinary "keep reminding me"; silently
    // sending nothing would be the wrong reading of it.
    assert.equal(templateFor('repeat', 'escalated', settings({ initialTemplateId: 7 })), 7);
  });

  it('reports no template rather than inventing one', () => {
    assert.equal(templateFor('initial', 'notified', settings({ initialTemplateId: null })), null);
  });
});

// -------------------------------------------------------------------------------------------
// Reconciliation: the state of the world against the alarm standing for it.
// -------------------------------------------------------------------------------------------

describe('reconciling an alarm', () => {
  it('does nothing at all for a sensor that is not in the state', () => {
    // The answer for almost every sensor, almost always.
    assert.deepEqual(reconcile(null, 'up', T0, settings(), T0), { kind: 'idle' });
  });

  it('arms from the state’s own beginning', () => {
    const decision = reconcile(null, 'down', T0, settings({ initialLatencySeconds: 300 }), at(60));
    assert.deepEqual(decision, { kind: 'arm', nextDueAt: at(300) });
  });

  it('arms a sensor that was already down when the trigger appeared', () => {
    // An operator who adds "tell me about outages" during an outage means this one. Down for an
    // hour under a five-minute latency is already past it.
    const decision = reconcile(
      null,
      'down',
      T0,
      settings({ initialLatencySeconds: 300 }),
      at(3_600),
    );
    assert.deepEqual(decision, { kind: 'arm', nextDueAt: at(300) });
    assert.ok(at(300) < at(3_600), 'and is therefore due immediately');
  });

  it('holds while the state holds', () => {
    assert.deepEqual(reconcile(alarm(), 'down', T0, settings(), at(60)), { kind: 'hold' });
  });

  it('produces no notification at all for a blip under its latency', () => {
    // WORKFLOW.MD §6, named exactly: a 30-second blip on a 5-minute latency. Nothing has been
    // sent, so nobody knows there was an alarm, and a recovery notification would be the first
    // anyone heard of it.
    const config = settings({ initialLatencySeconds: 300, recoveryTemplateId: 9 });
    const pending = alarm({ phase: 'pending', nextDueAt: at(300) });
    assert.deepEqual(reconcile(pending, 'up', at(30), config, at(30)), { kind: 'cancel' });
  });

  it('sends a recovery once somebody has been told', () => {
    const notified = alarm({ phase: 'notified', nextDueAt: null });
    assert.deepEqual(reconcile(notified, 'up', at(600), settings(), at(600)), { kind: 'recover' });
  });

  it('never calls a state that is not Up a recovery', () => {
    // The invariant, unchanged: "recovery notification on return to Up" (`CAPABILITIES.MD
    // §5.1`), and a sensor that is Unknown or flaky has not returned to anything.
    for (const state of ['unknown', 'paused', 'warning'] as const) {
      const notified = alarm({ phase: 'notified', nextDueAt: null });
      const decided = reconcile(notified, state, at(600), settings(), at(600));
      assert.notEqual(decided.kind, 'recover', `${state} is not a recovery`);
    }
  });

  it('ends the alarm when an operator pauses the sensor, and only then', () => {
    // **`P-105`.** Leaving the armed state used to delete the alarm whatever it left for, which
    // is right for exactly one case: a pause is a decision that the outage is not being watched
    // any more, so there is nothing to escalate and nothing to announce when it returns.
    const notified = alarm({ phase: 'notified', nextDueAt: null });
    assert.deepEqual(reconcile(notified, 'paused', at(600), settings(), at(600)), {
      kind: 'cancel',
    });
  });

  it('suspends rather than deletes when the sensor is neither recovered nor paused', () => {
    // The other half, and two separate holes. Deleting on `down -> warning` meant the later
    // `warning -> up` found no alarm and the operator who was paged "is down" was never told it
    // came back. Deleting on `down -> unknown` meant a probe blip armed a *fresh* chain on
    // reconnect: a second initial page for an outage that never ended.
    for (const state of ['warning', 'unknown'] as const) {
      const notified = alarm({ phase: 'notified', nextDueAt: at(1800) });
      assert.deepEqual(
        reconcile(notified, state, at(600), settings(), at(600)),
        { kind: 'suppress' },
        `${state} is limbo, not an ending`,
      );
    }
  });

  it('owes a recovery notification after coming back through Warning', () => {
    // `down -> warning -> up`, which `docs/state-machine.md §4` lists as an ordinary transition.
    // Walked as a sequence rather than started from a hand-built suppressed alarm: the point is
    // that production *reaches* that state, and a test beginning there would still pass with the
    // suspension removed — entry 7's defect, a subject that cannot express the property.
    const notified = alarm({ phase: 'notified', nextDueAt: at(1800) });

    // The link comes back flaky. Nobody is paged, and the alarm is kept.
    const flaky = reconcile(notified, 'warning', at(600), settings(), at(600));
    assert.deepEqual(flaky, { kind: 'suppress' });

    // What `suppress` stores: the chain stopped, the alarm standing (engine.ts:432).
    const suspended = alarm({ ...notified, nextDueAt: null, suppressed: true });

    // Then it clears entirely, and the operator who was paged "is down" is told it came back.
    assert.deepEqual(reconcile(suspended, 'up', at(660), settings(), at(660)), {
      kind: 'recover',
    });
  });

  it('picks the chain up where a probe blip interrupted it, rather than paging again', () => {
    // **One outage, one alarm** (`CLAUDE.md`). The sensor was Down at T0 and paged; its probe
    // dropped at T+600 and came back at T+660 with the sensor still Down. The escalation was due
    // at T+1800 and must still be — arming afresh would page "is down" a second time for an
    // outage that never ended, and a probe flapping every twenty minutes would never escalate at
    // all while paging once per flap per sensor.
    //
    // Walked as a sequence, for the reason the case above gives.
    const chain = settings({ escalationLatencySeconds: 1800 });
    const notified = alarm({ phase: 'notified', nextDueAt: at(1800), since: T0 });

    // `ProbeReachability.lost` turns the sensor Unknown. The alarm is kept, not deleted.
    assert.deepEqual(reconcile(notified, 'unknown', at(600), chain, at(600)), { kind: 'suppress' });
    const suspended = alarm({ ...notified, nextDueAt: null, suppressed: true });

    // The probe returns and the sensor reads Down again, because it never stopped being down.
    const resumed = reconcile(suspended, 'down', at(660), chain, at(660));
    assert.equal(resumed.kind, 'resume', 'not a second arm');
    assert.deepEqual(resumed.nextDueAt, at(1800), 'the original escalation, not a new latency');
  });

  it('suppresses the chain on acknowledgement and keeps the alarm', () => {
    // PLAN.md's exit criterion is a pair, and the two halves pull in opposite directions:
    // deleting the alarm would lose the recovery, leaving it armed would keep escalating.
    const notified = alarm({ phase: 'notified', nextDueAt: at(1800) });
    assert.deepEqual(reconcile(notified, 'down_acknowledged', T0, settings(), at(60)), {
      kind: 'suppress',
    });
  });

  it('holds a suppressed alarm rather than suppressing it again', () => {
    const suppressed = alarm({ phase: 'notified', nextDueAt: null, suppressed: true });
    assert.deepEqual(reconcile(suppressed, 'down_acknowledged', T0, settings(), at(60)), {
      kind: 'hold',
    });
  });

  it('still fires the recovery for a sensor that recovers while acknowledged', () => {
    const suppressed = alarm({ phase: 'notified', nextDueAt: null, suppressed: true });
    assert.deepEqual(reconcile(suppressed, 'up', at(900), settings(), at(900)), {
      kind: 'recover',
    });
  });

  it('picks the chain up where it stopped when an acknowledgement lapses', () => {
    // Not a second initial notification: the outage did not restart, and an operator whose
    // acknowledgement expired should get the escalation they were putting off.
    const config = settings({ escalationLatencySeconds: 1800 });
    const suppressed = alarm({ phase: 'notified', nextDueAt: null, suppressed: true });
    assert.deepEqual(reconcile(suppressed, 'down', T0, config, at(600)), {
      kind: 'resume',
      nextDueAt: at(1800),
    });
  });

  it('resumes a still-pending alarm at its original initial time', () => {
    const config = settings({ initialLatencySeconds: 300 });
    const suppressed = alarm({ phase: 'pending', nextDueAt: null, suppressed: true });
    assert.deepEqual(reconcile(suppressed, 'down', T0, config, at(120)), {
      kind: 'resume',
      nextDueAt: at(300),
    });
  });

  it('stands an alarm down when its trigger is edited to watch a different state', () => {
    // The old alarm is about something nobody is watching any more. Silently, because nothing
    // recovered.
    const standing = alarm({ state: 'down', phase: 'notified' });
    assert.deepEqual(reconcile(standing, 'down', T0, settings({ state: 'warning' }), at(60)), {
      kind: 'cancel',
    });
  });
});

// -------------------------------------------------------------------------------------------
// Firing: what a due alarm owes, and where it goes next.
// -------------------------------------------------------------------------------------------

describe('firing a due alarm', () => {
  it('sends the initial notification and stops when nothing follows', () => {
    const firing = fire(alarm(), T0, settings());
    assert.deepEqual(firing, {
      reason: 'initial',
      templateId: 1,
      phase: 'notified',
      nextDueAt: null,
      repeats: 0,
    });
  });

  it('lines the escalation up behind the initial notification', () => {
    const config = settings({ initialLatencySeconds: 60, escalationLatencySeconds: 600 });
    const firing = fire(alarm({ nextDueAt: at(60) }), at(60), config);
    assert.equal(firing.reason, 'initial');
    assert.equal(firing.phase, 'notified');
    assert.deepEqual(firing.nextDueAt, at(600));
  });

  it('escalates, then repeats', () => {
    const config = settings({
      escalationLatencySeconds: 600,
      escalationTemplateId: 2,
      repeatMinutes: 15,
    });
    const escalation = fire(alarm({ phase: 'notified', nextDueAt: at(600) }), at(600), config);
    assert.equal(escalation.reason, 'escalation');
    assert.equal(escalation.templateId, 2);
    assert.equal(escalation.phase, 'escalated');
    assert.deepEqual(escalation.nextDueAt, at(600 + 900));

    const repeat = fire(
      alarm({ phase: 'escalated', nextDueAt: at(1500), repeats: 0 }),
      at(1500),
      config,
    );
    assert.equal(repeat.reason, 'repeat');
    assert.equal(repeat.templateId, 2);
    assert.equal(repeat.phase, 'escalated');
    assert.equal(repeat.repeats, 1);
    assert.deepEqual(repeat.nextDueAt, at(1500 + 900));
  });

  it('repeats without an escalation configured', () => {
    const config = settings({ repeatMinutes: 5 });
    const firing = fire(alarm({ phase: 'notified', nextDueAt: at(300) }), at(300), config);
    assert.equal(firing.reason, 'repeat');
    assert.equal(firing.templateId, 1);
    assert.equal(firing.phase, 'notified');
    assert.equal(firing.repeats, 1);
  });

  it('runs the chain even when a step names no template', () => {
    // "Do not tell me when it goes down, tell me if it is still down in half an hour" — a real
    // configuration, and one the chain has to run through `initial` to reach.
    const config = settings({
      initialTemplateId: null,
      escalationLatencySeconds: 1800,
      escalationTemplateId: 4,
    });
    const initial = fire(alarm(), T0, config);
    assert.equal(initial.templateId, null, 'nothing is sent');
    assert.equal(initial.phase, 'notified', 'but the chain advances');
    assert.deepEqual(initial.nextDueAt, at(1800));

    const escalation = fire(alarm({ phase: 'notified' }), at(1800), config);
    assert.equal(escalation.templateId, 4);
  });

  it('never stalls: a repeat always schedules the next one', () => {
    const config = settings({ repeatMinutes: 1 });
    let current = alarm({ phase: 'notified', nextDueAt: at(0) });
    let clock = T0;
    for (let round = 0; round < 5; round += 1) {
      const firing = fire(current, clock, config);
      assert.notEqual(firing.nextDueAt, null, `round ${String(round)} should schedule another`);
      assert.ok(firing.nextDueAt !== null && firing.nextDueAt > clock, 'and always in the future');
      clock = firing.nextDueAt;
      current = {
        ...current,
        phase: firing.phase,
        nextDueAt: firing.nextDueAt,
        repeats: firing.repeats,
      };
    }
    assert.equal(current.repeats, 5);
  });
});

// -------------------------------------------------------------------------------------------
// The three holes the notifications panel found in this file (`P-112`, `P-113`).
// -------------------------------------------------------------------------------------------

describe('an alarm that has not notified yet', () => {
  const latency = settings({ initialLatencySeconds: 300 });

  it('survives the sensor going Unknown, rather than restarting its latency', () => {
    // **The probe blip.** A pending alarm used to be deleted whenever the sensor left the armed
    // state, whatever it left for — so a WAN link that drops for a minute destroyed the alarm,
    // and the reconnect armed a *fresh* one from the sensor's new `since`. A target down
    // continuously behind a link that flaps every three minutes never reached its five-minute
    // latency, so nobody was ever paged and the queue looked clean throughout.
    const pending = alarm({ phase: 'pending', nextDueAt: at(300) });
    assert.deepEqual(reconcile(pending, 'unknown', at(180), latency, at(180)), {
      kind: 'suppress',
    });
  });

  it('survives the sensor going to Warning as well', () => {
    const pending = alarm({ phase: 'pending', nextDueAt: at(300) });
    assert.deepEqual(reconcile(pending, 'warning', at(180), latency, at(180)), {
      kind: 'suppress',
    });
  });

  it('picks its latency up where it stopped when the state comes back', () => {
    // The point of surviving: the chain resumes against the *alarm's* since, so the five minutes
    // the outage has already served still count.
    const suppressed = alarm({ phase: 'pending', nextDueAt: null, suppressed: true });
    assert.deepEqual(reconcile(suppressed, 'down', at(240), latency, at(240)), {
      kind: 'resume',
      nextDueAt: at(300),
    });
  });

  it('still says nothing when the sensor simply recovers', () => {
    // The half that was right: nobody was told there was a problem, so "it is fixed" would be
    // the first anybody heard of it.
    const pending = alarm({ phase: 'pending', nextDueAt: at(300) });
    assert.deepEqual(reconcile(pending, 'up', at(120), latency, at(120)), { kind: 'cancel' });
  });

  it('still ends outright when an operator pauses the sensor', () => {
    const pending = alarm({ phase: 'pending', nextDueAt: at(300) });
    assert.deepEqual(reconcile(pending, 'paused', at(120), latency, at(120)), { kind: 'cancel' });
  });
});

describe('a trigger configured for Up', () => {
  const up = settings({ state: 'up' });

  it('ends its alarm when the sensor stops being Up', () => {
    // **Otherwise it notifies once per sensor, ever.** `isRecovery` is true only for `up`, so an
    // up-alarm can never take the `recover` branch; suspending it instead meant the return to Up
    // matched `stillStanding` and took `resume`, and a resumed `notified` phase with no
    // escalation and no repeat has nothing left to send. The operator who asked to be told when
    // things come back was told once and then never again, with nothing in the UI to say why.
    const standing = alarm({ state: 'up', phase: 'notified', nextDueAt: null });
    assert.deepEqual(reconcile(standing, 'down', at(60), up, at(60)), { kind: 'cancel' });
  });

  it('so the next return to Up arms and notifies again', () => {
    assert.deepEqual(reconcile(null, 'up', at(600), up, at(600)), {
      kind: 'arm',
      nextDueAt: at(600),
    });
  });

  it('does not change how an alarm about a problem behaves', () => {
    // The rule is about the state the alarm is *about*, not the state the sensor is in. A Down
    // alarm going Unknown still suspends, which is `P-105`.
    const standing = alarm({ state: 'down', phase: 'notified' });
    assert.deepEqual(reconcile(standing, 'unknown', at(60), settings(), at(60)), {
      kind: 'suppress',
    });
  });
});

describe('a trigger retargeted onto another state', () => {
  it('arms straight away when the sensor is already in the new state', () => {
    // **Cancelling and stopping there leaves the trigger inert.** Reactions are driven by state
    // transitions, and a sensor that has been Down for a week has none coming — so an operator
    // who points a trigger at the state in front of them gets silence, indistinguishable from a
    // trigger that is working.
    const standing = alarm({ state: 'warning', phase: 'notified' });
    assert.deepEqual(reconcile(standing, 'down', at(60), settings(), at(60)), {
      kind: 'retarget',
      nextDueAt: at(60),
    });
  });

  it('still just cancels when the sensor is in neither state', () => {
    const standing = alarm({ state: 'warning', phase: 'notified' });
    assert.deepEqual(reconcile(standing, 'up', at(60), settings(), at(60)), { kind: 'cancel' });
  });
});

// -------------------------------------------------------------------------------------------
// A sensor held behind its probe's own alarm (`M-22`).
// -------------------------------------------------------------------------------------------

describe('a sensor held behind its probe’s own alarm (`M-22`)', () => {
  // Every state a trigger can watch, every phase, suppressed or not, and the states a carried
  // sensor can be read in. Held, the answer never depends on the sensor's state: nothing arms,
  // and a standing alarm is suspended. It is never cancelled and never recovered, which is what
  // keeps the probe's return from paging once per sensor.
  const phases = ['pending', 'notified', 'escalated'] as const;

  for (const watched of V1_STATES) {
    const config = settings({ state: watched, initialLatencySeconds: 300 });
    for (const current of V1_STATES) {
      it(`arms nothing for a trigger on ${watched} while the sensor reads ${current}`, () => {
        assert.deepEqual(reconcile(null, current, at(60), config, at(60), true), {
          kind: 'idle',
        });
      });
      for (const phase of phases) {
        for (const suppressed of [false, true]) {
          const standing = alarm({ state: watched, phase, suppressed });
          it(`suspends a ${phase}${suppressed ? ', suppressed,' : ''} ${watched} alarm while the sensor reads ${current}`, () => {
            assert.deepEqual(
              reconcile(standing, current, at(60), config, at(60), true),
              suppressed ? { kind: 'hold' } : { kind: 'suppress' },
            );
          });
        }
      }
    }
  }

  it('stands down an alarm about a state the trigger no longer watches, and arms no other', () => {
    const standing = alarm({ state: 'warning', phase: 'notified' });
    assert.deepEqual(
      reconcile(standing, 'unknown', at(60), settings({ state: 'unknown' }), at(60), true),
      {
        kind: 'cancel',
      },
    );
  });

  it('suspends an Up alarm that unheld would be cancelled, so the return is one alarm', () => {
    // The row this exists for: unheld, leaving Up ends an Up alarm (`P-113`) and the return arms
    // a fresh one per sensor. Held, it is suspended, and the return resumes it.
    const up = settings({ state: 'up' });
    const standing = alarm({ state: 'up', phase: 'notified', nextDueAt: null });
    assert.deepEqual(reconcile(standing, 'unknown', at(60), up, at(60)), { kind: 'cancel' });
    assert.deepEqual(reconcile(standing, 'unknown', at(60), up, at(60), true), {
      kind: 'suppress',
    });
    const suspended = alarm({ state: 'up', phase: 'notified', nextDueAt: null, suppressed: true });
    assert.deepEqual(reconcile(suspended, 'up', at(120), up, at(120)), {
      kind: 'resume',
      nextDueAt: null,
    });
  });

  it('leaves an unheld decision exactly as it was', () => {
    for (const watched of V1_STATES) {
      for (const current of V1_STATES) {
        const config = settings({ state: watched });
        const standing = alarm({ state: watched, phase: 'notified' });
        assert.deepEqual(
          reconcile(standing, current, at(60), config, at(60), false),
          reconcile(standing, current, at(60), config, at(60)),
        );
      }
    }
  });
});

// -------------------------------------------------------------------------------------------
// A return held before the alarm is over (`M-18`).
// -------------------------------------------------------------------------------------------

describe('a return to Up held before the alarm is over (`M-18`)', () => {
  const HOLD = 300;
  const held = settings({ recoveryHoldSeconds: HOLD, escalationLatencySeconds: 1800 });
  const phases = ['pending', 'notified', 'escalated'] as const;

  it('confirms a return once it has lasted the hold, measured from the return', () => {
    assert.deepEqual(recoveryConfirmAt(at(600), held), at(900));
    assert.deepEqual(recoveryConfirmAt(at(600), settings()), at(600), 'no hold is no wait');
  });

  for (const phase of phases) {
    it(`holds a ${phase} alarm's return, from when the sensor came back, and sends nothing`, () => {
      const standing = alarm({ phase, nextDueAt: at(1800) });
      // The reaction runs ten seconds after the return: the hold is the return's, not the
      // reaction's.
      assert.deepEqual(reconcile(standing, 'up', at(600), held, at(610)), {
        kind: 'recovering',
        since: at(600),
        confirmAt: at(900),
      });
    });

    it(`ends a ${phase} alarm whose return is already older than the hold`, () => {
      // A reaction that comes late, after a release from a probe's hold or at boot, finds a return
      // that has lasted: it is over, as it would have been at the sweep.
      const standing = alarm({ phase, nextDueAt: at(1800) });
      assert.deepEqual(
        reconcile(standing, 'up', at(600), held, at(900)),
        phase === 'pending' ? { kind: 'cancel' } : { kind: 'recover' },
      );
    });
  }

  it('ends the alarm at the return when the type has no hold, as before', () => {
    const notified = alarm({ phase: 'notified', nextDueAt: null });
    assert.deepEqual(reconcile(notified, 'up', at(600), settings(), at(600)), {
      kind: 'recover',
    });
    const pending = alarm({ phase: 'pending', nextDueAt: at(300) });
    assert.deepEqual(reconcile(pending, 'up', at(30), settings(), at(30)), { kind: 'cancel' });
  });

  /**
   * Every state a sensor can read while a return is held, before and after the hold ends, for a
   * trigger on Down. Written out rather than derived: a table computed by the rule it tests
   * checks the rule against itself.
   */
  const table: readonly {
    readonly current: (typeof V1_STATES)[number];
    readonly before: 'resume' | 'suppress' | 'hold' | 'over';
    readonly after: 'resume' | 'suppress' | 'over';
  }[] = [
    // A relapse, before or after: the same outage. After the hold the sweep would have ended it,
    // and a reaction that gets there first still reads the relapse as what it is.
    { current: 'down', before: 'resume', after: 'resume' },
    { current: 'down_acknowledged', before: 'suppress', after: 'suppress' },
    // Neither a relapse nor an ending: the hold runs on, and the return is owed at its end.
    { current: 'up', before: 'hold', after: 'over' },
    { current: 'warning', before: 'hold', after: 'over' },
    { current: 'unknown', before: 'hold', after: 'over' },
    // A pause ends the watch, and the return it had made is owed now rather than never.
    { current: 'paused', before: 'over', after: 'over' },
  ];
  it('covers every state a sensor can read', () => {
    assert.deepEqual(table.map((row) => row.current).sort(), [...V1_STATES].sort());
  });

  for (const { current, before, after } of table) {
    for (const phase of phases) {
      for (const [when, now, expected] of [
        ['before', at(899), before],
        ['after', at(900), after],
      ] as const) {
        it(`reads ${current} ${when} a ${phase} alarm's hold ends as ${expected}`, () => {
          const recovering = alarm({ phase, nextDueAt: at(900), recoveringSince: at(600) });
          const decided = reconcile(recovering, current, at(600), held, now);
          switch (expected) {
            case 'resume':
              assert.deepEqual(decided, {
                kind: 'resume',
                // From the outage's beginning, never from the relapse: a pending alarm keeps its
                // initial time and a notified one its escalation.
                nextDueAt: phase === 'pending' ? T0 : phase === 'notified' ? at(1800) : null,
              });
              break;
            case 'over':
              assert.deepEqual(
                decided,
                phase === 'pending' ? { kind: 'cancel' } : { kind: 'recover' },
              );
              break;
            default:
              assert.deepEqual(decided, { kind: expected });
          }
        });
      }
    }
  }

  it('ends a held return at once when the hold is edited away', () => {
    const recovering = alarm({ phase: 'notified', nextDueAt: at(900), recoveringSince: at(600) });
    assert.deepEqual(reconcile(recovering, 'up', at(600), settings(), at(601)), {
      kind: 'recover',
    });
  });

  it('holds no return for an alarm about Up, which ends when the sensor leaves Up', () => {
    // `P-113`: every return to Up is its own event for a trigger on Up, and a hold on it would
    // swallow the next one.
    const up = settings({ state: 'up', recoveryHoldSeconds: HOLD });
    const standing = alarm({ state: 'up', phase: 'notified', nextDueAt: null });
    assert.deepEqual(reconcile(standing, 'down', at(60), up, at(60)), { kind: 'cancel' });
  });

  it('lets a probe’s hold win over a held return (`M-22`)', () => {
    const recovering = alarm({ phase: 'notified', nextDueAt: at(900), recoveringSince: at(600) });
    assert.deepEqual(reconcile(recovering, 'unknown', at(650), held, at(650), true), {
      kind: 'suppress',
    });
  });

  it('stands a held return down with the rest when the trigger is retargeted', () => {
    const recovering = alarm({ phase: 'notified', nextDueAt: at(900), recoveringSince: at(600) });
    assert.deepEqual(reconcile(recovering, 'up', at(600), { ...held, state: 'warning' }, at(650)), {
      kind: 'cancel',
    });
  });

  it('turns a probe that flaps for five minutes into one alarm and one recovery', () => {
    // `P-215`'s loop as the chain sees it: Down, a few seconds of Up, Down again, and so on, then
    // Up for good. Walked as a sequence, the rows written back as the engine writes them: the
    // point is that production reaches each state, not that each can be started from.
    const config = settings({ recoveryHoldSeconds: HOLD, recoveryTemplateId: 9 });
    let standing: Alarm | null = null;
    const kinds: string[] = [];
    const react = (current: SensorState, since: number, now: number): void => {
      const decided = reconcile(standing, current, at(since), config, at(now));
      kinds.push(decided.kind);
      switch (decided.kind) {
        case 'arm':
          standing = alarm({ since: at(since), nextDueAt: decided.nextDueAt });
          // Latency zero: the scheduler fires the initial notification straight away.
          standing = { ...standing, phase: 'notified', nextDueAt: null };
          break;
        case 'recovering':
          standing = alarm({
            ...(standing ?? assert.fail('no alarm')),
            nextDueAt: decided.confirmAt,
            recoveringSince: decided.since,
          });
          break;
        case 'resume':
          standing = alarm({
            ...(standing ?? assert.fail('no alarm')),
            nextDueAt: decided.nextDueAt,
            recoveringSince: null,
          });
          break;
        case 'recover':
        case 'cancel':
          standing = null;
          break;
        default:
          break;
      }
    };
    react('down', 0, 0);
    for (let round = 1; round <= 5; round += 1) {
      react('up', round * 60 - 50, round * 60 - 50);
      react('down', round * 60, round * 60);
    }
    react('up', 310, 310);
    // The sweep at the end of the hold: nothing changed, and the return has lasted.
    react('up', 310, 610);

    assert.equal(kinds.filter((kind) => kind === 'arm').length, 1, kinds.join(', '));
    assert.equal(kinds.filter((kind) => kind === 'resume').length, 5, kinds.join(', '));
    assert.deepEqual(kinds.at(-1), 'recover');
    assert.equal(standing, null);

    // And the next Down after a return that lasted is a new outage: a new alarm.
    react('down', 4_000, 4_000);
    assert.deepEqual(kinds.at(-1), 'arm');
  });
});

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

  it('stands an alarm down without a recovery when the sensor goes anywhere but Up', () => {
    for (const state of ['unknown', 'paused', 'warning'] as const) {
      const notified = alarm({ phase: 'notified', nextDueAt: null });
      assert.deepEqual(
        reconcile(notified, state, at(600), settings(), at(600)),
        { kind: 'cancel' },
        `${state} is not a recovery`,
      );
    }
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

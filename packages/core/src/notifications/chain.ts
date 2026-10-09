import type { SensorState } from '../state/tables.js';

/**
 * The state trigger's chain, as a decision and nothing else (`N-02`).
 *
 * No database, no clock of its own, no logging: everything here is a function of the trigger's
 * settings, the sensor's current state and the alarm currently standing. That is deliberate —
 * this is where the subtle bugs live (`CLAUDE.md`), and a rule that can only be exercised by
 * standing up a tree and waiting five minutes is a rule nobody exercises.
 *
 * `WORKFLOW.MD §6` names the behaviours; this file is them:
 *
 * - a 30-second blip under a 5-minute latency produces no notification at all;
 * - acknowledgement stops the chain, and the recovery notification still fires;
 * - a repeat keeps saying the same thing while the state holds;
 * - a return to Up is held for the sensor type's hold, and a relapse inside it is the same alarm
 *   (`M-18`).
 */

/** How far along the chain an alarm is. */
export type AlarmPhase = 'pending' | 'notified' | 'escalated';

/**
 * Why a notification is owed.
 *
 * The first four are the state trigger's chain; `threshold` and `clear` are `N-03`'s pair. Two
 * more names rather than reusing `initial` and `recovery`, because a threshold breach is not an
 * outage and a clear is not a recovery — the sensor may have been Up throughout, which is the
 * whole distinction between a threshold trigger and a channel limit (`M-04`).
 */
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

/** The four steps of a state trigger's chain. */
export const STATE_REASONS = ['initial', 'escalation', 'repeat', 'recovery'] as const;

export type StateReason = (typeof STATE_REASONS)[number];

/**
 * Every reason, as `notification_request_reason_check` (migration 017) allows: the type above and
 * `ms:notificationRequest`'s enum are both this list, and `fixed-value-fields.test.ts` holds it to
 * the constraint (`P-342`).
 */
export const NOTIFICATION_REASONS = [...STATE_REASONS, 'threshold', 'clear'] as const;

/** A state trigger's settings, after `triggerKinds.validate` has filled the defaults in. */
export interface StateTriggerSettings {
  readonly state: SensorState;
  readonly initialLatencySeconds: number;
  readonly initialTemplateId: number | null;
  readonly escalationLatencySeconds: number;
  readonly escalationTemplateId: number | null;
  readonly repeatMinutes: number;
  readonly recoveryTemplateId: number | null;
  /**
   * How long a return to Up must last before the alarm is over, in seconds (`M-18`). Resolved
   * for the sensor: the trigger's own when it sets one, the sensor type's otherwise. Zero ends the
   * alarm at the return, which is every type but Probe Health.
   */
  readonly recoveryHoldSeconds: number;
}

/** The alarm standing for one (sensor, trigger), as the decisions here read it. */
export interface Alarm {
  readonly state: SensorState;
  /** When the alarm began. Not `sensor_runtime.since`, which moves — see the migration. */
  readonly since: Date;
  readonly phase: AlarmPhase;
  readonly nextDueAt: Date | null;
  readonly repeats: number;
  readonly suppressed: boolean;
  /**
   * When the sensor returned, while that return is held (`M-18`), or null. The alarm is not over
   * until the return has lasted the hold, and a relapse before then is the same outage.
   */
  readonly recoveringSince: Date | null;
}

/** What a reconciliation decided to do with the alarm row. */
export type Reconciliation =
  /** Nothing standing and nothing to stand: the answer for almost every sensor, almost always. */
  | { readonly kind: 'idle' }
  /** Nothing standing, and the state matches: start the chain. */
  | { readonly kind: 'arm'; readonly nextDueAt: Date | null }
  /** The alarm is standing and correct. The commonest outcome by far. */
  | { readonly kind: 'hold' }
  /** Acknowledged: stop the chain, keep the alarm, so the recovery still fires. */
  | { readonly kind: 'suppress' }
  /** The acknowledgement lapsed and the state is back. Pick the chain up where it stopped. */
  | { readonly kind: 'resume'; readonly nextDueAt: Date | null }
  /** Returned to Up: the alarm is over, and somebody who was told should be told that. */
  | { readonly kind: 'recover' }
  /**
   * Returned to Up, and held (`M-18`): the chain stops and nothing is sent. The alarm is over at
   * `confirmAt` if the return lasts, and a relapse before then resumes it.
   */
  | { readonly kind: 'recovering'; readonly since: Date; readonly confirmAt: Date }
  /** The alarm is over and nobody is owed a word about it. */
  | { readonly kind: 'cancel' }
  /**
   * The trigger was retargeted onto the state the sensor is already in.
   *
   * One verdict rather than a cancel that the next reaction happens to follow with an arm,
   * because there may not be a next reaction: reactions are driven by state transitions, and a
   * sensor that has been Down for a week has none coming.
   */
  | { readonly kind: 'retarget'; readonly nextDueAt: Date | null };

/** What falling due decided: the message owed, and where the chain goes next. */
export interface Firing {
  readonly reason: StateReason;
  /** Null when the trigger names no template for this step — see `notificationOwed`. */
  readonly templateId: number | null;
  readonly phase: AlarmPhase;
  readonly nextDueAt: Date | null;
  readonly repeats: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * Whether an alarm armed for `armed` is still standing while the sensor reads `current`.
 *
 * The one non-obvious row is acknowledgement. `down_acknowledged` is a different state from
 * `down` (`docs/state-machine.md §2.4`), so the naive comparison says the alarm has ended and
 * fires a recovery notification — which would tell everybody the sensor came back at the exact
 * moment an operator said "I know, I am on it". An acknowledged Down is still Down.
 */
export function stillStanding(armed: SensorState, current: SensorState): boolean {
  if (armed === current) return true;
  return armed === 'down' && current === 'down_acknowledged';
}

/**
 * Whether the chain is stopped while the sensor reads `current`.
 *
 * Acknowledgement only. A paused sensor is handled a layer up, by ending the alarm outright:
 * see `reconcile`.
 */
export function chainStopped(current: SensorState): boolean {
  return current === 'down_acknowledged';
}

/**
 * Whether leaving the armed state owes anybody a recovery notification.
 *
 * `CAPABILITIES.MD §5.1` defines it as "recovery notification on return to Up", and the
 * narrowness is the point. A Down sensor that goes Unknown because its probe died has not
 * recovered; a Down sensor an operator paused for maintenance has not recovered either. Sending
 * "back to normal" for either is a false all-clear, which is worse than silence because somebody
 * stops looking.
 */
export function isRecovery(current: SensorState): boolean {
  return current === 'up';
}

/**
 * Whether leaving the armed state ends the alarm outright, rather than suspending it.
 *
 * A pause (`P-105`), or an alarm that was about the sensor being Up (`P-113`). An operator
 * switching monitoring off is a decision that the outage is not being watched any more —
 * `docs/state-machine.md` §3 — so there is nothing left to escalate and nothing to say when it
 * comes back; the sensor resumes to Unknown and awaits a fresh scan.
 *
 * **Everything else suspends instead**, which is the fix for two separate holes. Leaving `down`
 * for `warning` used to delete the alarm, so the later `warning -> up` found nothing to recover
 * from and the operator who was paged "is down" was never told it came back — while
 * `CAPABILITIES.MD §5.1` promises a recovery notification on return to Up, and the sensor did
 * return to Up. And leaving `down` for `unknown` on a probe blip deleted it too, so the reconnect
 * armed a *fresh* chain: a second initial page for an outage that never ended, with the
 * escalation deadline reset, so a probe flapping every twenty minutes never escalated at all and
 * paged once per flap per sensor. `CLAUDE.md`: one outage, one alarm.
 */
export function endsAlarm(current: SensorState, armed: SensorState): boolean {
  if (current === 'paused') return true;
  // **An alarm about the sensor being Up ends when it stops being Up** (`P-113`). Suspending is
  // right for an alarm about a *problem*: the escalation chain of an ongoing outage must survive
  // a probe blip. There is no ongoing problem to escalate about a healthy sensor, and every
  // return to Up is its own event — so suspending one turns "tell me when it comes back" into
  // "tell me the first time it ever comes back". Traced: the alarm suppresses on the way down,
  // and the return matches `stillStanding`, so it takes `resume` rather than `arm` — and a
  // resumed `notified` phase with no escalation and no repeat has `nextDueAt: null` and queues
  // nothing. The trigger notifies once per sensor and then never again, silently, for ever.
  return isRecovery(armed);
}

/**
 * When the initial notification falls due, measured from the state's own beginning.
 *
 * From `since`, not from now: an engine that started counting when it *noticed* would restart
 * the latency after every restart, and a five-minute latency would become "five minutes after
 * whenever ms-core was last deployed".
 */
export function initialDueAt(since: Date, settings: StateTriggerSettings): Date {
  return new Date(since.getTime() + settings.initialLatencySeconds * SECOND);
}

/**
 * When the escalation falls due, or null when the trigger has none.
 *
 * Also measured from `since`, which is what `WORKFLOW.MD §6`'s diagram shows: both timers start
 * at the state change, so "notify after 5 minutes, escalate after 30" means thirty minutes of
 * outage, not thirty-five. A zero escalation latency means no escalation — it is a duration, and
 * a duration of zero is "immediately", which for an escalation would mean "at the same instant
 * as the initial notification" and is not a thing anybody wants.
 */
export function escalationDueAt(since: Date, settings: StateTriggerSettings): Date | null {
  if (settings.escalationLatencySeconds <= 0) return null;
  return new Date(since.getTime() + settings.escalationLatencySeconds * SECOND);
}

/**
 * When a return that began at `returnedAt` has lasted the hold, and the alarm is over (`M-18`).
 *
 * **Why a return is held at all.** A probe killed at its memory ceiling and restarted connects
 * for a few seconds a round, and the thirty-second Probe Health sweep sees it Up between outages
 * (`P-215`). Ended at the return, every Down after it armed a fresh chain, and with the default
 * latency of zero, a fresh page: 36–45 an hour for the measured loop, and one or two per loop
 * under the start limit and each of `H-23`'s retries. Held, a relapse is the outage it always
 * was. **A return is genuine when it lasts the hold**, and only then is the next Down a new one.
 */
export function recoveryConfirmAt(returnedAt: Date, settings: StateTriggerSettings): Date {
  return new Date(returnedAt.getTime() + settings.recoveryHoldSeconds * SECOND);
}

/**
 * Where a stopped chain picks up (`P-105`, `M-18`): at its original initial time if nothing was
 * sent, otherwise where it would have gone next, all measured from the outage's own beginning.
 */
function resumeAt(alarm: Alarm, settings: StateTriggerSettings, now: Date): Date | null {
  return alarm.phase === 'pending'
    ? initialDueAt(alarm.since, settings)
    : nextDueAfter(alarm.phase, alarm.since, now, settings);
}

/**
 * Where the chain goes after something has just been sent at `at`.
 *
 * Escalation first if one is configured and has not happened; then repeats; then nothing. A
 * repeat is measured from the send, not from `since`, because a repeat interval means "tell me
 * again every hour", not "at fixed points relative to an outage that started at 03:47".
 */
export function nextDueAfter(
  phase: AlarmPhase,
  since: Date,
  at: Date,
  settings: StateTriggerSettings,
): Date | null {
  if (phase === 'notified') {
    const escalation = escalationDueAt(since, settings);
    // Never in the past relative to the send that just happened: an escalation latency shorter
    // than the initial one is a misconfiguration, not an instruction to fire in a loop.
    if (escalation !== null) return escalation > at ? escalation : at;
  }
  if (settings.repeatMinutes > 0) return new Date(at.getTime() + settings.repeatMinutes * MINUTE);
  return null;
}

/**
 * The template a step should use, or null when the trigger names none.
 *
 * A null is a real configuration, not a gap: "do not tell me when it goes down, tell me if it is
 * still down in half an hour" is a trigger with no initial template and an escalation one, and
 * the chain still has to run to reach the escalation. So a step with no template advances the
 * alarm and queues nothing.
 *
 * A repeat resends whatever the chain last said — the escalation if it escalated, the initial
 * notification otherwise. `WORKFLOW.MD §6` draws the repeat loop under the escalation, but a
 * trigger with a repeat and no escalation is a perfectly ordinary "keep reminding me", and
 * silently sending nothing would be the wrong reading of it.
 */
export function templateFor(
  reason: StateReason,
  phase: AlarmPhase,
  settings: StateTriggerSettings,
): number | null {
  switch (reason) {
    case 'initial':
      return settings.initialTemplateId;
    case 'escalation':
      return settings.escalationTemplateId;
    case 'repeat':
      return phase === 'escalated'
        ? (settings.escalationTemplateId ?? settings.initialTemplateId)
        : settings.initialTemplateId;
    case 'recovery':
      return settings.recoveryTemplateId;
  }
}

/**
 * What to do about one (sensor, trigger) pair, given where both currently are.
 *
 * Reconciliation rather than event handling: the answer depends only on the present, so a missed
 * reaction is corrected by the next one and a restart needs no replay.
 *
 * **`held`: the sensor's state is its probe's, and this trigger hears about the probe from the
 * probe's own alarm** (`M-22`). The engine decides it per trigger, so a trigger that cannot see
 * the probe's alarm is never held. While it holds, nothing arms and a standing alarm is suspended.
 * It is never cancelled or recovered, whatever state it was about. That includes an alarm about
 * being Up, which `endsAlarm` would otherwise cancel on the way into Unknown and arm afresh on the
 * way back, once per sensor the probe carries. Suspended, the return takes `resume`, which is one
 * outage and one alarm.
 */
export function reconcile(
  alarm: Alarm | null,
  current: SensorState,
  since: Date,
  settings: StateTriggerSettings,
  now: Date,
  held = false,
): Reconciliation {
  if (held) {
    if (alarm === null) return { kind: 'idle' };
    // Retargeted while held: the old alarm is about a state nobody is watching, and the new one
    // is not armed, because the probe's alarm is saying it.
    if (alarm.state !== settings.state) return { kind: 'cancel' };
    return alarm.suppressed ? { kind: 'hold' } : { kind: 'suppress' };
  }

  if (alarm === null) {
    if (current !== settings.state) return { kind: 'idle' };
    // Armed from the state's own beginning, so a sensor that has been Down for an hour when the
    // trigger is created is already past its latency rather than starting a fresh five minutes.
    return { kind: 'arm', nextDueAt: initialDueAt(since, settings) };
  }

  // The trigger was edited to watch a different state. The old alarm is about something nobody
  // is watching any more; standing it down silently is right, because nothing has recovered.
  //
  // **But the retarget arms in the same breath when the sensor is already in the new state**
  // (`P-112`). Cancelling and stopping there leaves the trigger inert until the sensor next
  // changes state — which for a sensor that has been Down for a week is never, so an operator
  // who retargets a trigger onto the state in front of them gets silence and no way to tell it
  // from a working one.
  if (alarm.state !== settings.state) {
    return current === settings.state
      ? { kind: 'retarget', nextDueAt: initialDueAt(since, settings) }
      : { kind: 'cancel' };
  }

  // **A return being held** (`M-18`). Back in the armed state before it was confirmed: a relapse,
  // and the same outage, so the chain picks up where it stopped. No second initial page, and the
  // escalation still measured from the outage's beginning, so a probe that flaps for longer than
  // the escalation latency escalates. Anything else leaves the hold running. Warning and Unknown
  // do not undo a return, and a return is not taken back by leaving Up, as it never was before
  // the hold. The alarm is over once the return has lasted the hold, or at once if an operator
  // pauses the sensor. The pause ends the watch, and the return it had made is still owed.
  if (alarm.recoveringSince !== null) {
    if (stillStanding(alarm.state, current)) {
      return chainStopped(current)
        ? { kind: 'suppress' }
        : { kind: 'resume', nextDueAt: resumeAt(alarm, settings, now) };
    }
    const over = current === 'paused' || now >= recoveryConfirmAt(alarm.recoveringSince, settings);
    if (!over) return { kind: 'hold' };
    return alarm.phase === 'pending' ? { kind: 'cancel' } : { kind: 'recover' };
  }

  if (!stillStanding(alarm.state, current)) {
    // An operator switched monitoring off, or the alarm was about being Up and it no longer is.
    // Nothing to escalate, nothing to announce.
    if (endsAlarm(current, alarm.state)) return { kind: 'cancel' };
    if (isRecovery(current)) {
      // Sent nothing yet? Then nobody knows there was an alarm, and a recovery notification
      // would be the first anyone heard of it. This is the blip: no notification at all.
      //
      // **And this is the only place `pending` may cancel** (`P-112`). It used to short-circuit
      // the whole branch, so a pending alarm was destroyed by `down -> unknown` on a probe blip
      // and by `down -> warning` — and the return to Down re-armed from the sensor's *new*
      // `since`, starting a brand-new initial latency. A target down continuously for hours
      // behind a link that flaps every three minutes never reached its five-minute latency and
      // never produced a single notification. The comment above justifies sending nothing; it
      // never justified re-reading `since`. P-105 fixed the same shape for `notified` only.
      //
      // **Both wait out the hold first** (`M-18`), where the type has one. A pending alarm waits
      // too. A return that lapses into a relapse must resume from the original `since`, or a
      // target flapping behind a restarting probe never reaches its latency, the hole P-112
      // closed for Unknown and Warning, here for Up.
      const confirmAt = recoveryConfirmAt(since, settings);
      if (settings.recoveryHoldSeconds > 0 && confirmAt > now) {
        return { kind: 'recovering', since, confirmAt };
      }
      return alarm.phase === 'pending' ? { kind: 'cancel' } : { kind: 'recover' };
    }
    // **Neither recovered nor stood down, so the obligation survives** (`P-105`). The sensor has
    // left the state that was paged about without coming back to normal — flaky rather than
    // fixed, or Unknown because its probe went. Suspending keeps three things true: nobody is
    // paged while it is in limbo, the eventual return to Up still owes a recovery notification,
    // and a return to the armed state picks the chain up where it stopped instead of starting a
    // second one. That last is the `resume` branch below, already written for an acknowledgement
    // lapsing, which is the same question asked about a different interruption.
    return alarm.suppressed ? { kind: 'hold' } : { kind: 'suppress' };
  }

  if (chainStopped(current)) {
    return alarm.suppressed ? { kind: 'hold' } : { kind: 'suppress' };
  }

  if (alarm.suppressed) {
    // The acknowledgement lapsed or was lifted and the sensor is still in the state. Pick the
    // chain up where it stopped rather than starting it again: the outage did not restart, and
    // an operator whose acknowledgement expired should get the escalation they were putting off,
    // not a second initial notification about something they already know.
    return { kind: 'resume', nextDueAt: resumeAt(alarm, settings, now) };
  }

  return { kind: 'hold' };
}

/**
 * What an alarm that has fallen due owes, and where it goes next.
 *
 * Called only for alarms whose `nextDueAt` has passed, which is what makes the sweep cheap: the
 * decision is a handful of arithmetic on a row the index already found. Never for a held return
 * (`M-18`), whose due time is its confirmation, which `reconcile` decides.
 */
export function fire(
  alarm: Pick<Alarm, 'state' | 'phase' | 'since' | 'repeats'>,
  at: Date,
  settings: StateTriggerSettings,
): Firing {
  if (alarm.phase === 'pending') {
    return {
      reason: 'initial',
      templateId: templateFor('initial', 'notified', settings),
      phase: 'notified',
      nextDueAt: nextDueAfter('notified', alarm.since, at, settings),
      repeats: 0,
    };
  }

  // Due, already notified, and an escalation is configured and has not happened yet.
  if (alarm.phase === 'notified' && escalationDueAt(alarm.since, settings) !== null) {
    return {
      reason: 'escalation',
      templateId: templateFor('escalation', 'escalated', settings),
      phase: 'escalated',
      nextDueAt: nextDueAfter('escalated', alarm.since, at, settings),
      repeats: alarm.repeats,
    };
  }

  return {
    reason: 'repeat',
    templateId: templateFor('repeat', alarm.phase, settings),
    phase: alarm.phase,
    nextDueAt: nextDueAfter(alarm.phase, alarm.since, at, settings),
    repeats: alarm.repeats + 1,
  };
}

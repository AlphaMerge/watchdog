/**
 * What an operator means when they pause something (`M-08`).
 *
 * The rules of §3 of `docs/state-machine.md` that are neither a table nor a database write: how
 * a request turns into a deadline, and which object a resume is allowed to touch. Pure, so the
 * awkward cases — an "until" already in the past, a resume aimed at a cascade — are checked
 * without a tree.
 */

import type { PauseSource } from './tables.js';

/**
 * How long, and — for a maintenance window — from when.
 *
 * The first three start the moment they are asked for; `window` is the one that does not, and
 * it is the whole of `M-10`. A window is not a fifth pause source: it is a manual pause with a
 * start, set on one object, cascading to everything beneath it, lifted by the same resume.
 */
export type PauseRequest =
  | { readonly kind: 'indefinite' }
  | { readonly kind: 'duration'; readonly minutes: number }
  | { readonly kind: 'until'; readonly until: Date }
  | { readonly kind: 'window'; readonly from: Date; readonly until: Date };

/**
 * The presets a UI offers (`CAPABILITIES.MD §4`).
 *
 * Offered, not enforced: the API takes any duration, because a preset list is a convenience for
 * the common case and an operator who needs 45 minutes should not have to pick 1 hour and
 * remember to come back.
 */
export const PAUSE_PRESET_MINUTES = [5, 15, 60, 180, 1440] as const;

/** Longest a timed pause may run. Beyond this, say indefinite and mean it. */
export const MAX_PAUSE_MINUTES = 365 * 24 * 60;

export interface ResolvedPause {
  /** When the row was written. Who-did-what-when, not when monitoring stops. */
  readonly pausedAt: Date;
  /** When it takes effect. Equal to `pausedAt` for everything but a maintenance window. */
  readonly startsAt: Date;
  /** `null` is indefinite. */
  readonly pausedUntil: Date | null;
  readonly message: string;
}

/**
 * How far ahead a window may be scheduled.
 *
 * The same year as `MAX_PAUSE_MINUTES`, and for the same reason: a window scheduled for 2031 is
 * a typo in a date field far more often than it is a plan, and the row would sit in the table
 * being nothing until then.
 */
export const MAX_WINDOW_LEAD_MINUTES = MAX_PAUSE_MINUTES;

/**
 * Turns a request into the row to store, or says why it cannot.
 *
 * `now` is a parameter rather than a call to the clock: a pause and the state change it causes
 * are written in one transaction and must agree about when they happened, and a function that
 * reads the clock itself cannot be tested against a deadline.
 */
export function resolvePause(
  request: PauseRequest,
  message: string,
  now: Date,
): { pause: ResolvedPause } | { problems: string[] } {
  if (request.kind === 'indefinite') {
    return { pause: { pausedAt: now, startsAt: now, pausedUntil: null, message } };
  }

  if (request.kind === 'window') {
    return resolveWindow(request.from, request.until, message, now);
  }

  if (request.kind === 'duration') {
    if (!Number.isFinite(request.minutes) || request.minutes <= 0) {
      return { problems: ['a pause must last a positive number of minutes'] };
    }
    if (request.minutes > MAX_PAUSE_MINUTES) {
      return {
        problems: [
          `a timed pause may not exceed ${String(MAX_PAUSE_MINUTES)} minutes; pause it ` +
            'indefinitely instead, so that it shows as something a person has to undo',
        ],
      };
    }
    return {
      pause: {
        pausedAt: now,
        startsAt: now,
        pausedUntil: new Date(now.getTime() + request.minutes * 60_000),
        message,
      },
    };
  }

  const until = request.until;
  if (Number.isNaN(until.getTime())) {
    return { problems: ['the pause deadline is not a date'] };
  }
  if (until.getTime() <= now.getTime()) {
    // Accepting it would create a pause that expires before anything can act on it — a sensor
    // that flickers Paused and back for no reason an operator could explain. Ending one early
    // is a resume, which is one action rather than two ways to spell it.
    return {
      problems: ['the pause deadline is already in the past; to end a pause now, resume it'],
    };
  }
  if (until.getTime() - now.getTime() > MAX_PAUSE_MINUTES * 60_000) {
    return {
      problems: [
        `a pause may not run more than ${String(MAX_PAUSE_MINUTES / (24 * 60))} days; pause it ` +
          'indefinitely instead',
      ],
    };
  }
  return { pause: { pausedAt: now, startsAt: now, pausedUntil: until, message } };
}

/**
 * A maintenance window: a pause that begins later and ends on its own (`M-10`).
 *
 * The three refusals are the three ways a date field goes wrong. A window that has already
 * finished would be written and swept away without ever pausing anything; one with no length
 * is a typo; and one scheduled years out is a mistyped year far more often than a plan. A start
 * in the *past* is accepted — that is simply a pause that is already in force, which is what an
 * operator who is late means.
 */
function resolveWindow(
  from: Date,
  until: Date,
  message: string,
  now: Date,
): { pause: ResolvedPause } | { problems: string[] } {
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime())) {
    return { problems: ['a maintenance window needs two dates'] };
  }
  if (until.getTime() <= from.getTime()) {
    return { problems: ['a maintenance window must end after it starts'] };
  }
  if (until.getTime() <= now.getTime()) {
    return { problems: ['this maintenance window is already over'] };
  }
  if (from.getTime() - now.getTime() > MAX_WINDOW_LEAD_MINUTES * 60_000) {
    return {
      problems: [
        `a maintenance window may not start more than ` +
          `${String(MAX_WINDOW_LEAD_MINUTES / (24 * 60))} days from now`,
      ],
    };
  }
  if (until.getTime() - from.getTime() > MAX_PAUSE_MINUTES * 60_000) {
    return {
      problems: [
        `a maintenance window may not run more than ` +
          `${String(MAX_PAUSE_MINUTES / (24 * 60))} days; pause it indefinitely instead`,
      ],
    };
  }
  return { pause: { pausedAt: now, startsAt: from, pausedUntil: until, message } };
}

/**
 * True while the pause is in force: started, and not yet over.
 *
 * Both ends, since `M-10`. A window scheduled for Saturday is a row in the table all week and
 * pauses nothing until Saturday, and every read of a pause goes through here so that no caller
 * has to remember the start exists.
 */
export function pauseIsActive(
  pause: { startsAt: Date; pausedUntil: Date | null },
  now: Date,
): boolean {
  if (pause.startsAt.getTime() > now.getTime()) return false;
  return pause.pausedUntil === null || pause.pausedUntil.getTime() > now.getTime();
}

/** True for a maintenance window that has been scheduled and has not begun (`M-10`). */
export function pauseIsPending(pause: { startsAt: Date }, now: Date): boolean {
  return pause.startsAt.getTime() > now.getTime();
}

/**
 * Why a resume is refused, or `null` if it is allowed.
 *
 * `WORKFLOW.MD §5`: only the object that was *directly* paused can be resumed. A sensor paused
 * because its device is paused has nothing of its own to clear, and a resume that silently did
 * nothing — or worse, that lifted the cascade for one child — would be an operator believing
 * monitoring is back when it is not.
 *
 * The refusal names the object to resume instead, because "you cannot do that" without "here is
 * what you can do" is the least useful error a UI can render.
 */
export function refuseResume(
  own: boolean,
  cascadedFrom: { objectId: number; name: string } | null,
  heldBy: HeldBy = {},
): { reason: string; details: Record<string, unknown> } | null {
  // `own` includes a maintenance window that has not started (`M-10`): cancelling one before it
  // begins is the same action as ending one that has, and an operator who scheduled the wrong
  // weekend should not have to wait for it to start before they can call it off.
  if (own) return null;

  // In the order §5 evaluates the sources, so the refusal names the one that would still be
  // holding the object even if every source below it were lifted.
  if (cascadedFrom !== null) {
    return {
      reason:
        `this object is paused because #${String(cascadedFrom.objectId)} ` +
        `("${cascadedFrom.name}") is paused; resume that instead`,
      details: {
        source: 'parent',
        pausedBy: cascadedFrom.objectId,
        pausedByName: cascadedFrom.name,
      },
    };
  }
  if (heldBy.dependency != null) {
    const master = heldBy.dependency;
    return {
      reason:
        `this object is paused because its master #${String(master.masterId)} ` +
        `("${master.masterName}") is Down; it resumes when the master recovers`,
      details: {
        source: 'dependency',
        masterId: master.masterId,
        masterName: master.masterName,
        definedOn: master.definedOn,
      },
    };
  }
  if (heldBy.schedule != null) {
    const schedule = heldBy.schedule;
    return {
      reason:
        `this object is outside the "${schedule.name}" schedule; it resumes when the window ` +
        `opens${schedule.nextChangeAt === null ? '' : ` at ${schedule.nextChangeAt}`}`,
      details: {
        source: 'schedule',
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        definedOn: schedule.definedOn,
        nextChangeAt: schedule.nextChangeAt,
      },
    };
  }
  return { reason: 'this object is not paused', details: { source: null } };
}

/**
 * The sources a resume cannot lift, for the refusal to name (`M-12`).
 *
 * Without these, an object held by a schedule or a dependency would be told "this object is not
 * paused" — which is both wrong and the least useful thing to say to somebody looking at a blue
 * sensor. `WORKFLOW.MD §5` requires the UI to make a cascade legible rather than silently
 * ignoring clicks, and only two of the four sources are a cascade *of pauses*.
 */
export interface HeldBy {
  readonly schedule?: {
    readonly scheduleId: number;
    readonly name: string;
    readonly nextChangeAt: string | null;
    readonly definedOn: number;
  } | null;
  readonly dependency?: {
    readonly masterId: number;
    readonly masterName: string;
    readonly definedOn: number;
  } | null;
}

/** The four flags, as stored on `sensor_runtime`. */
export interface PauseFlagRow {
  readonly paused_by_parent: boolean;
  readonly paused_by_dependency: boolean;
  readonly paused_by_schedule: boolean;
  readonly paused_manually: boolean;
}

/** Which sources hold a sensor, in the order §3 reports them. */
export function activeSources(flags: PauseFlagRow): PauseSource[] {
  const active: PauseSource[] = [];
  if (flags.paused_by_parent) active.push('parent');
  if (flags.paused_by_dependency) active.push('dependency');
  if (flags.paused_by_schedule) active.push('schedule');
  if (flags.paused_manually) active.push('manual');
  return active;
}

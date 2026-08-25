/**
 * What an operator means when they pause something (`M-08`).
 *
 * The rules of §3 of `docs/state-machine.md` that are neither a table nor a database write: how
 * a request turns into a deadline, and which object a resume is allowed to touch. Pure, so the
 * awkward cases — an "until" already in the past, a resume aimed at a cascade — are checked
 * without a tree.
 */

import type { PauseSource } from './tables.js';

/** How long. Exactly one of these, and nothing is indefinite. */
export type PauseRequest =
  | { readonly kind: 'indefinite' }
  | { readonly kind: 'duration'; readonly minutes: number }
  | { readonly kind: 'until'; readonly until: Date };

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
  readonly pausedAt: Date;
  /** `null` is indefinite. */
  readonly pausedUntil: Date | null;
  readonly message: string;
}

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
    return { pause: { pausedAt: now, pausedUntil: null, message } };
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
    // that flickers Paused and back for no reason an operator could explain.
    return { problems: ['the pause deadline is already in the past'] };
  }
  if (until.getTime() - now.getTime() > MAX_PAUSE_MINUTES * 60_000) {
    return {
      problems: [
        `a pause may not run more than ${String(MAX_PAUSE_MINUTES / (24 * 60))} days; pause it ` +
          'indefinitely instead',
      ],
    };
  }
  return { pause: { pausedAt: now, pausedUntil: until, message } };
}

/** True while the pause is still in force. */
export function pauseIsActive(pause: { pausedUntil: Date | null }, now: Date): boolean {
  return pause.pausedUntil === null || pause.pausedUntil.getTime() > now.getTime();
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
): { reason: string; details: Record<string, unknown> } | null {
  if (own) return null;
  if (cascadedFrom !== null) {
    return {
      reason:
        `this object is paused because #${String(cascadedFrom.objectId)} ` +
        `("${cascadedFrom.name}") is paused; resume that instead`,
      details: { pausedBy: cascadedFrom.objectId, pausedByName: cascadedFrom.name },
    };
  }
  return { reason: 'this object is not paused', details: {} };
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

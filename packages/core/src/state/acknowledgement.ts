/**
 * What an operator means when they acknowledge an alarm (`M-13`).
 *
 * The rules of §2.4 that are neither a table nor a database write. Pure, so the awkward cases —
 * an "until" already in the past, a deadline a year out — are checked without a sensor.
 *
 * Deliberately the same shape as `resolvePause`, because it is the same question asked about a
 * different verb: for how long, and what should a UI offer. Sharing the *shape* rather than the
 * code, because the two differ in what they refuse and why, and a single function with a mode
 * flag would hide that.
 */

/** How long the acknowledgement lasts. Exactly one of these. */
export type AcknowledgeRequest =
  | { readonly kind: 'indefinite' }
  | { readonly kind: 'duration'; readonly minutes: number }
  | { readonly kind: 'until'; readonly until: Date };

/**
 * The presets `CAPABILITIES.MD §5.3` names: 5m / 15m / 1h / 3h / 1d.
 *
 * The same list as a pause offers, which is not a coincidence — both answer "how long until
 * somebody should look at this again" — but they are separate constants because they are
 * separate promises to the operator, and one changing should not silently change the other.
 */
export const ACK_PRESET_MINUTES = [5, 15, 60, 180, 1440] as const;

/**
 * Longest a timed acknowledgement may run.
 *
 * A year, matching a pause. Beyond that, say indefinite and mean it: an acknowledgement that
 * expires in 2031 is a mistyped year far more often than a plan, and it would silence an alarm
 * for the whole of that time with nothing to notice.
 */
export const MAX_ACK_MINUTES = 365 * 24 * 60;

export interface ResolvedAcknowledgement {
  readonly acknowledgedAt: Date;
  /** `null` is indefinite: until the sensor recovers, or somebody clears it. */
  readonly acknowledgedUntil: Date | null;
  readonly message: string;
}

/**
 * Turns a request into the columns to store, or says why it cannot.
 *
 * `now` is a parameter rather than a call to the clock, for the reason `resolvePause` gives: the
 * acknowledgement and the state change it causes are written in one transaction and must agree
 * about when they happened.
 */
export function resolveAcknowledgement(
  request: AcknowledgeRequest,
  message: string,
  now: Date,
): { acknowledgement: ResolvedAcknowledgement } | { problems: string[] } {
  if (request.kind === 'indefinite') {
    return { acknowledgement: { acknowledgedAt: now, acknowledgedUntil: null, message } };
  }

  if (request.kind === 'duration') {
    if (!Number.isFinite(request.minutes) || request.minutes <= 0) {
      return { problems: ['an acknowledgement must last a positive number of minutes'] };
    }
    if (request.minutes > MAX_ACK_MINUTES) {
      return {
        problems: [
          `an acknowledgement may not run more than ${String(MAX_ACK_MINUTES / (24 * 60))} ` +
            'days; acknowledge it indefinitely instead, so that it shows as something a person ' +
            'has to undo',
        ],
      };
    }
    return {
      acknowledgement: {
        acknowledgedAt: now,
        acknowledgedUntil: new Date(now.getTime() + request.minutes * 60_000),
        message,
      },
    };
  }

  const until = request.until;
  if (Number.isNaN(until.getTime())) {
    return { problems: ['the acknowledgement deadline is not a date'] };
  }
  if (until.getTime() <= now.getTime()) {
    // It would lapse before the next scan could notice it, so the alarm would never actually be
    // silenced — an operator would click acknowledge and watch nothing happen.
    return {
      problems: [
        'the acknowledgement deadline is already in the past; to remove one, clear it instead',
      ],
    };
  }
  if (until.getTime() - now.getTime() > MAX_ACK_MINUTES * 60_000) {
    return {
      problems: [
        `an acknowledgement may not run more than ${String(MAX_ACK_MINUTES / (24 * 60))} days; ` +
          'acknowledge it indefinitely instead',
      ],
    };
  }
  return { acknowledgement: { acknowledgedAt: now, acknowledgedUntil: until, message } };
}

/**
 * Whether a state can be acknowledged at all.
 *
 * Only `down` and `down_acknowledged` — the second so that extending or re-wording an existing
 * acknowledgement is the same call. Anything else is refused rather than stored: §2.4 applies
 * the layer only to `down`, so an acknowledgement written on an Up sensor would sit there
 * silently and suppress the *next* outage, which is the opposite of what the operator meant.
 */
export function canAcknowledge(state: string): boolean {
  return state === 'down' || state === 'down_acknowledged';
}

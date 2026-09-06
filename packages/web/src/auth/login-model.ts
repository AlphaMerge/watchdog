import type { ApiError } from '../api/client';

/**
 * What a login refusal means for the form (`U-17`).
 *
 * Pure, and separate from the view, because logging in is a small state machine wearing a
 * two-field form: the password step can answer "now a code", the code step can answer "that
 * password is stale", and one of the answers means nothing typed here will ever work. Deciding
 * that inside a component is deciding it somewhere a test has to render to reach.
 */

export type LoginStage = 'credentials' | 'code';

export interface LoginFeedback {
  /** Which fields the form shows next. */
  readonly stage: LoginStage;
  readonly message: string;
  /** Which field the operator has to fix. */
  readonly focus: 'login' | 'code';
  /** What the throttle asked for, in seconds; zero when it was not the throttle. */
  readonly retryAfterSeconds: number;
  /**
   * Nothing typed into this form can get this account in.
   *
   * One case: a group the account belongs to requires a second factor, and the account has
   * never enrolled. Enrolment needs a session, and a session is what is being refused — so the
   * form says who can break the loop instead of inviting another attempt.
   */
  readonly stuck: boolean;
}

/**
 * A context value the core sends as a number, read back defensively — it crosses JSON.
 *
 * `context`, not `details`: `toHttpError` gives an `AuthError`'s values to the envelope's
 * `context` and leaves `details` empty. Reading the wrong one is not a type error and not a
 * crash — the lookup is `undefined`, the branch it guards is never taken, and the form is
 * quietly wrong for ever. It shipped that way once; `auth-envelope.test.ts` pins the wire shape
 * on the core side now, because no test in this package can see it.
 */
function secondsFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.ceil(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  }
  return 0;
}

/** "in 45 seconds" / "in 3 minutes" — a countdown nobody watches is worse than a rounding. */
export function waitFor(seconds: number): string {
  if (seconds <= 0) return 'shortly';
  if (seconds < 90) return `in ${String(seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${String(minutes)} minutes`;
}

export function feedbackFor(error: ApiError, stage: LoginStage): LoginFeedback {
  const base = { retryAfterSeconds: 0, stuck: false } as const;

  switch (error.code) {
    case 'MFA_REQUIRED': {
      // **`enrolled` is what separates a step from a lockout.** Both arrive as `MFA_REQUIRED`
      // because both are "the second factor stopped this", and a client that read only the code
      // would send somebody to a field they have nothing to type into, for ever.
      if (error.context['enrolled'] === 'true') {
        return {
          ...base,
          stage: 'code',
          focus: 'code',
          // Saying the password was accepted is not a leak: the core checks the second factor
          // only after the password verifies, so reaching this answer already says so. Not
          // saying it leaves a form that appears to have rejected a correct password.
          message:
            'That password was accepted. This account also needs a code from its authenticator ' +
            'app, or one of its recovery codes.',
        };
      }
      return {
        ...base,
        stage: 'credentials',
        focus: 'login',
        stuck: true,
        message:
          `${error.message}. Enrolling needs a session, which is what is being refused — an ` +
          'administrator has to enrol this account or take it out of the group that requires ' +
          'a second factor.',
      };
    }

    case 'MFA_CODE_INVALID':
      return {
        ...base,
        stage: 'code',
        focus: 'code',
        message:
          'That code was not accepted. An authenticator code is only good for about a minute; ' +
          'a recovery code works once.',
      };

    case 'AUTH_THROTTLED': {
      const seconds = secondsFrom(error.context['retryAfterSeconds']);
      return {
        // The stage is kept, so a throttle that lands mid-way through a second factor does not
        // throw away the step already passed.
        stage,
        focus: 'login',
        stuck: false,
        retryAfterSeconds: seconds,
        message: `Too many failed logins from this address. Try again ${waitFor(seconds)}.`,
      };
    }

    case 'UNREACHABLE':
      return { ...base, stage, focus: 'login', message: 'The core is not reachable.' };

    case 'AUTH_REJECTED':
      // The core's one sentence for every reason a login failed, on purpose: which of them it
      // was is a login enumerator, so it goes to the core's log and not to this form.
      return { ...base, stage: 'credentials', focus: 'login', message: error.message };

    default:
      return { ...base, stage, focus: 'login', message: error.message };
  }
}

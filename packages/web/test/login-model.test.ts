import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { feedbackFor, waitFor } from '../src/auth/login-model';

/**
 * What a login refusal means for the form (`U-17`).
 *
 * The claims worth holding are the ones where two different situations arrive as the same code:
 * `MFA_REQUIRED` is both "now type a code" and "nothing you type here will work", and reading
 * only the code turns the second into a form somebody retries for ever.
 */
describe('reading a login refusal', () => {
  it('steps to the code field when the account has a second factor enrolled', () => {
    const feedback = feedbackFor(
      // The sixth argument is `context` — where the core actually puts this. Passing it as
      // `details` is what shipped, and every case in this file passed anyway.
      new ApiError(
        401,
        'MFA_REQUIRED',
        'this account needs a second factor',
        undefined,
        {},
        { enrolled: 'true' },
      ),
      'credentials',
    );

    expect(feedback.stage).toBe('code');
    expect(feedback.focus).toBe('code');
    expect(feedback.stuck).toBe(false);
    // The password verified — the core checks the factor only after it does — and a form that
    // did not say so looks like it rejected a correct password.
    expect(feedback.message).toContain('accepted');
  });

  it('does not step to a code field the account cannot fill, and says who can help', () => {
    const feedback = feedbackFor(
      new ApiError(
        401,
        'MFA_REQUIRED',
        'a group this account belongs to requires multi-factor authentication, and it has not ' +
          'been set up yet',
        undefined,
        {},
        { enrolled: 'false' },
      ),
      'credentials',
    );

    expect(feedback.stage).toBe('credentials');
    expect(feedback.stuck).toBe(true);
    expect(feedback.message).toContain('administrator');
  });

  it('keeps the code step when a bad code is refused', () => {
    const feedback = feedbackFor(new ApiError(401, 'MFA_CODE_INVALID', 'nope'), 'code');
    expect(feedback.stage).toBe('code');
    expect(feedback.focus).toBe('code');
  });

  it('keeps whichever step the throttle interrupted', () => {
    // A throttle that dropped somebody back to the password field would make them re-pass a step
    // they had already passed, and the delay is per address — retrying costs another one.
    const refused = new ApiError(
      429,
      'AUTH_THROTTLED',
      'too many',
      undefined,
      {},
      {
        retryAfterSeconds: 45,
      },
    );
    expect(feedbackFor(refused, 'code').stage).toBe('code');
    expect(feedbackFor(refused, 'credentials').stage).toBe('credentials');
    expect(feedbackFor(refused, 'code').retryAfterSeconds).toBe(45);
    expect(feedbackFor(refused, 'code').message).toContain('45 seconds');
  });

  it('reads a retry delay that crossed JSON as a string', () => {
    const refused = new ApiError(
      429,
      'AUTH_THROTTLED',
      'too many',
      undefined,
      {},
      {
        retryAfterSeconds: '90',
      },
    );
    expect(feedbackFor(refused, 'credentials').retryAfterSeconds).toBe(90);
  });

  it('survives a throttle refusal that names no delay', () => {
    const refused = new ApiError(429, 'AUTH_THROTTLED', 'too many');
    expect(feedbackFor(refused, 'credentials').retryAfterSeconds).toBe(0);
    expect(feedbackFor(refused, 'credentials').message).toContain('shortly');
  });

  it('passes the core one sentence for a rejected login through unchanged', () => {
    // Which of "no such account", "wrong password" and "disabled" it was is a login enumerator.
    // A client that embroidered this would be reintroducing the distinction the core removed.
    const feedback = feedbackFor(
      new ApiError(401, 'AUTH_REJECTED', 'that login and password were not accepted'),
      'credentials',
    );
    expect(feedback.message).toBe('that login and password were not accepted');
    expect(feedback.stage).toBe('credentials');
  });

  it('carries the core’s correlation id for every answer it gave, and none for one it did not (U-59)', () => {
    const cases: readonly [string, Record<string, string>][] = [
      ['AUTH_REJECTED', {}],
      ['MFA_REQUIRED', { enrolled: 'true' }],
      ['MFA_REQUIRED', {}],
      ['MFA_CODE_INVALID', {}],
      ['AUTH_THROTTLED', { retryAfterSeconds: '30' }],
      ['SOMETHING_ELSE', {}],
    ];
    for (const [code, context] of cases) {
      const refused = new ApiError(401, code, 'refused', 'req-59', {}, context);
      expect(feedbackFor(refused, 'credentials').correlationId, code).toBe('req-59');
    }
    const unreachable = new ApiError(0, 'UNREACHABLE', 'the core is not reachable', undefined);
    expect(feedbackFor(unreachable, 'credentials').correlationId).toBeUndefined();
  });

  it('rounds a wait rather than pretending to count it down', () => {
    expect(waitFor(0)).toBe('shortly');
    expect(waitFor(1)).toBe('in 1 second');
    expect(waitFor(45)).toBe('in 45 seconds');
    expect(waitFor(120)).toBe('in 2 minutes');
  });
});

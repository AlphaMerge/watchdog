import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_RETRY,
  exhausted,
  retryDelayMs,
  retryWindowMs,
  type RetryPolicy,
} from '../src/notifications/retry.js';

/** No jitter, so the shape of the backoff is visible. */
const PLAIN: RetryPolicy = {
  firstDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 8_000,
  jitter: 0,
  maxAttempts: 5,
};

describe('the retry backoff', () => {
  it('waits longer after each failure', () => {
    // A relay that refused one message will refuse the next one a second later, and hammering it
    // is how a delivery problem becomes a delivery problem *and* a rate-limit problem.
    assert.deepEqual(
      [1, 2, 3, 4].map((attempts) => retryDelayMs(PLAIN, attempts)),
      [1_000, 2_000, 4_000, 8_000],
    );
  });

  it('stops growing at the cap', () => {
    assert.deepEqual(
      [5, 6, 20].map((attempts) => retryDelayMs(PLAIN, attempts)),
      [8_000, 8_000, 8_000],
    );
  });

  it('does not overflow into a timestamp nobody can store', () => {
    // `2 ** 400` is Infinity, and Infinity times anything is not a number a `timestamptz` will
    // take. The exponent is capped before the multiplication rather than after.
    const delay = retryDelayMs(PLAIN, 4_000);
    assert.ok(Number.isFinite(delay));
    assert.equal(delay, PLAIN.maxDelayMs);
  });

  it('spreads the return with jitter, within the wait it computed', () => {
    // The failure this prevents: a relay that was down for an hour comes back to a queue whose
    // waits all started at the same failure, so they all expire at the same instant — a
    // thundering herd aimed at a service that has just proved it is fragile.
    const jittered: RetryPolicy = { ...PLAIN, jitter: 0.5 };
    assert.equal(
      retryDelayMs(jittered, 3, () => 0),
      2_000,
      'half the wait at the low end',
    );
    assert.equal(
      retryDelayMs(jittered, 3, () => 1),
      4_000,
      'the whole wait at the high end',
    );
    for (const random of [0.1, 0.37, 0.9]) {
      const delay = retryDelayMs(jittered, 3, () => random);
      assert.ok(delay >= 2_000 && delay <= 4_000, `${String(delay)} is outside the band`);
    }
  });

  it('gives up after the attempts it was given', () => {
    assert.equal(exhausted(PLAIN, 4), false);
    assert.equal(exhausted(PLAIN, 5), true);
    assert.equal(exhausted(PLAIN, 6), true);
  });

  it('keeps trying for about an hour and a half by default', () => {
    // The number an operator is really choosing when they set `maxAttempts`, so it is worth
    // being able to state it. Long enough for a relay restart or a certificate renewal; short
    // enough that a permanently wrong address does not sit in the queue for a week.
    const window = retryWindowMs(DEFAULT_RETRY);
    assert.ok(window > 60 * 60 * 1_000, `${String(window)} ms is under an hour`);
    assert.ok(window < 3 * 60 * 60 * 1_000, `${String(window)} ms is over three hours`);
  });
});

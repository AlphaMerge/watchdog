/**
 * How long to wait before trying a failed delivery again (`N-13`).
 *
 * `N-07` shipped a flat delay and said so — an honest placeholder rather than a policy pretending
 * to be one. This is the policy.
 */
export interface RetryPolicy {
  /** The wait after the first failure. Everything else grows from it. */
  readonly firstDelayMs: number;
  /** What each failure multiplies the wait by. */
  readonly factor: number;
  /** The longest wait, however many failures there have been. */
  readonly maxDelayMs: number;
  /**
   * How much of each wait is randomised, 0 to 1.
   *
   * **Not decoration.** A relay that was down for an hour comes back to a queue of deferred
   * messages whose waits all started at the same failure and therefore all expire at the same
   * instant — which is a thundering herd aimed at a service that has just proved it is fragile.
   * Half the wait randomised keeps the shape of the backoff and spreads the return.
   */
  readonly jitter: number;
  /** How many attempts a message gets before it is given up on and reported. */
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  firstDelayMs: 60_000,
  factor: 2,
  maxDelayMs: 900_000,
  jitter: 0.5,
  maxAttempts: 10,
};

/**
 * The wait after `attempts` failures, jittered.
 *
 * `attempts` is how many have happened, so the first failure asks with 1 and gets
 * `firstDelayMs`. The exponent is capped before the multiplication rather than after, because
 * `2 ** 400` is `Infinity` and `Infinity * 0.5` is not a number anybody can put in a timestamp.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  attempts: number,
  random: () => number = Math.random,
): number {
  const steps = Math.max(0, Math.min(attempts - 1, 32));
  const raw = Math.min(policy.firstDelayMs * policy.factor ** steps, policy.maxDelayMs);
  const jittered = raw * (1 - policy.jitter) + raw * policy.jitter * random();
  return Math.max(0, Math.round(jittered));
}

/** Whether this many attempts is the end of the road. */
export function exhausted(policy: RetryPolicy, attempts: number): boolean {
  return attempts >= policy.maxAttempts;
}

/**
 * Roughly how long a message keeps being tried before it is given up on.
 *
 * For the log line that says so, and for an operator deciding what `maxAttempts` should be. The
 * un-jittered sum, because "about ninety minutes" is the useful answer and "between forty-seven
 * and ninety-four" is not.
 */
export function retryWindowMs(policy: RetryPolicy): number {
  let total = 0;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    total += retryDelayMs(policy, attempt, () => 0.5);
  }
  return total;
}

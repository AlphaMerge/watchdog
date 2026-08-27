import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';

/**
 * Login throttling (`A-01`).
 *
 * **Counting per account alone is a denial of service, and counting per address alone is no
 * defence.** Lock an account after five bad passwords and anybody who knows an operator's login
 * can lock them out of their own monitoring system by failing to log in as them — during the
 * outage they are trying to investigate, which is exactly when it would be done. Count only per
 * address and a spray from a botnet never trips anything, because no single address tries twice.
 *
 * So both, with different consequences:
 *
 *   - **Per address**, a hard limit. An address that has failed repeatedly is refused outright,
 *     including for accounts that do not exist — an attacker enumerating logins is failing
 *     against nothing, and that is the traffic worth stopping first.
 *   - **Per account**, a *delay* rather than a lock. Failures make each attempt slower, so a
 *     guessing run collapses while a legitimate operator who has mistyped their password twice
 *     waits a second and gets in. Nobody is ever locked out by somebody else's failures.
 *
 * **Recorded in the database, not in memory**, so restarting the core is not a way to clear the
 * count — an attacker who can crash a service should not be handed a fresh allowance by it.
 */

export interface LoginThrottleConfig {
  /** Failures from one address within the window before it is refused outright. */
  maxPerAddress: number;
  /** How far back failures are counted. */
  windowMs: number;
  /** Delay added per recent failure against the same login. */
  perAccountDelayMs: number;
  /** The longest that delay grows to, so an attacker cannot make a login hang for ever. */
  maxAccountDelayMs: number;
  /** How long a refused address stays refused after its last failure. */
  addressBlockMs: number;
}

export const DEFAULT_THROTTLE: LoginThrottleConfig = {
  maxPerAddress: 20,
  windowMs: 15 * 60_000,
  perAccountDelayMs: 500,
  maxAccountDelayMs: 5_000,
  addressBlockMs: 15 * 60_000,
};

export interface ThrottleVerdict {
  /** Refuse before even looking at the password. */
  refused: boolean;
  /** How long to wait before answering, when not refused. */
  delayMs: number;
  /** For the `Retry-After` header, when refused. */
  retryAfterSeconds: number;
}

export interface LoginThrottleOptions {
  db: Database;
  logger: Logger;
  config?: Partial<LoginThrottleConfig>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class LoginThrottle {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #config: LoginThrottleConfig;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: LoginThrottleOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'login-throttle' });
    this.#config = { ...DEFAULT_THROTTLE, ...options.config };
    this.#now = options.now ?? ((): Date => new Date());
    this.#sleep =
      options.sleep ?? ((ms): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * What to do about this attempt, before the password is checked.
   *
   * Both counts come from one query: a login attempt is on the critical path of every session
   * this system issues, and two round trips to answer "may I try" is one too many.
   */
  async check(login: string, remoteAddress: string): Promise<ThrottleVerdict> {
    const since = new Date(this.#now().getTime() - this.#config.windowMs);
    const rows = await this.#db.query<{ by_address: string; by_login: string; last_fail: Date }>(
      `SELECT
         count(*) FILTER (WHERE remote_address = $2)          AS by_address,
         count(*) FILTER (WHERE lower(login) = lower($1))     AS by_login,
         max(at)  FILTER (WHERE remote_address = $2)          AS last_fail
       FROM login_attempt
       WHERE succeeded = false AND at >= $3`,
      [login, remoteAddress, since],
    );

    const row = rows[0];
    const byAddress = Number(row?.by_address ?? 0);
    const byLogin = Number(row?.by_login ?? 0);

    if (byAddress >= this.#config.maxPerAddress) {
      const lastFail = row?.last_fail ?? this.#now();
      const until = new Date(lastFail.getTime() + this.#config.addressBlockMs);
      const remainingMs = Math.max(0, until.getTime() - this.#now().getTime());
      this.#logger.warn(
        { remoteAddress, failures: byAddress, remainingMs },
        'refusing logins from an address that keeps failing',
      );
      return {
        refused: true,
        delayMs: 0,
        retryAfterSeconds: Math.ceil(remainingMs / 1000),
      };
    }

    return {
      refused: false,
      delayMs: Math.min(byLogin * this.#config.perAccountDelayMs, this.#config.maxAccountDelayMs),
      retryAfterSeconds: 0,
    };
  }

  /**
   * Waits out a verdict's delay.
   *
   * **Before the answer, not before the check.** Delaying the *response* is what costs a guessing
   * run its throughput; delaying before verifying would leave the same number of verifications
   * running concurrently and slow nothing down but the honest user.
   */
  async waitOut(verdict: ThrottleVerdict): Promise<void> {
    if (verdict.delayMs > 0) await this.#sleep(verdict.delayMs);
  }

  /** Records the outcome. Successes are recorded too — they are what an audit of a breach reads. */
  async record(login: string, remoteAddress: string, succeeded: boolean): Promise<void> {
    await this.#db.query(
      `INSERT INTO login_attempt (login, remote_address, succeeded, at) VALUES ($1, $2, $3, $4)`,
      [login.slice(0, 64), remoteAddress.slice(0, 64), succeeded, this.#now()],
    );
  }

  /**
   * Drops attempts older than the window.
   *
   * Called from housekeeping. Unbounded growth here would be slow rather than dramatic: the
   * counting query is windowed, so an un-pruned table costs an index scan that gets longer for
   * ever and nothing else — which is precisely the kind of decay nobody notices until it is a
   * production incident.
   */
  async prune(): Promise<number> {
    const keepSince = new Date(this.#now().getTime() - this.#config.windowMs * 4);
    const rows = await this.#db.query<{ removed: string }>(
      `WITH gone AS (DELETE FROM login_attempt WHERE at < $1 RETURNING 1)
       SELECT count(*)::text AS removed FROM gone`,
      [keepSince],
    );
    return Number(rows[0]?.removed ?? 0);
  }
}

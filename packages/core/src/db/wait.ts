import { AppError, describeError, type Logger } from '@ms/shared';

/**
 * Waiting for PostgreSQL at start-up, inside the process (`P-215`).
 *
 * **The one start-time failure of the core that waiting fixes.** Every other way `serve()` can fail
 * before it is ready — a schema it refuses, a certificate that is missing, a port already bound —
 * is still wrong five seconds later (`docs/findings/2026-09-28-start-exits.md`). A database in
 * crash recovery, or one that simply started a moment after us, is not. Until this existed the
 * first query threw, the process exited 1, and `Restart=on-failure` five seconds later was the
 * whole mechanism for waiting. That is also what made a start limit unsafe: `StartLimitBurst`
 * counts every restart, so a limit that stops a core killed at its memory ceiling would equally
 * stop a core whose database was a minute slow, and leave it down until a person noticed.
 *
 * **Bounded, and loud on every attempt.** A core still silently retrying at minute twenty is
 * `P-209` again under another name, so each attempt logs its reason and names the host, and
 * `systemctl status` shows the same sentence. Past the bound the error is thrown as it was before,
 * the process exits, and systemd starts it again — so a database that stays down is still waited
 * for, in rounds of `DATABASE_WAIT_MS`, and never looks like a service that cannot start.
 *
 * **The bound is what keeps a start limit away from this case, by construction.** systemd refuses
 * a start once `StartLimitBurst` starts have already happened inside `StartLimitIntervalSec` — the
 * sixth, for a burst of five. Each round of this wait lasts at least `DATABASE_WAIT_MS` plus
 * `RestartSec`, so against the units' ten-minute window a database that stays down puts at most
 * two starts in any window, and never six. The loop the limit exists for — killed at `MemoryMax`
 * — measured 10–14 s a round; the window stops any loop shorter than two minutes a round.
 */
export const DATABASE_WAIT_MS = 5 * 60_000;

/** First retry after a second, doubling, never more than this apart. */
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5_000;

/**
 * Headroom asked of systemd beyond the next attempt's own worst case, so a deadline never lands
 * between the sleep ending and the connection timing out.
 */
const EXTEND_MARGIN_MS = 5_000;

/** Whether waiting could fix a failure to reach the database, and why, in words for a log. */
export interface DatabaseFailure {
  readonly transient: boolean;
  /** Node's `code` or PostgreSQL's SQLSTATE, whichever the failure carried. */
  readonly code: string | undefined;
  readonly reason: string;
}

/**
 * Errors that describe a database that is not there *yet*.
 *
 * Node's socket and resolver codes and PostgreSQL's SQLSTATEs share one namespace here, because
 * `pg` puts either on `.code` and callers have no other way to tell them apart.
 */
const TRANSIENT_CODES: ReadonlyMap<string, string> = new Map([
  ['ECONNREFUSED', 'nothing is listening yet'],
  ['ECONNRESET', 'the connection was reset'],
  ['ETIMEDOUT', 'the connection timed out'],
  ['EHOSTUNREACH', 'the host is unreachable'],
  ['ENETUNREACH', 'the network is unreachable'],
  // The resolver is not up yet, which at boot is ordinary.
  ['EAI_AGAIN', 'the name could not be resolved yet'],
  // **Ambiguous, and retried anyway** (`P-209` died on exactly this: `getaddrinfo ENOTFOUND
  // postgres`). A typo in the host name is permanent; a name not yet published — a container, a
  // DNS record behind a slow DHCP lease — is not. Neither can be told from the other here, so the
  // bound decides, and the log line names the host so that a typo is readable as one.
  ['ENOTFOUND', 'the name does not resolve'],
  // `cannot_connect_now`: starting up, shutting down, or in crash recovery.
  ['57P03', 'PostgreSQL is starting up or recovering'],
  ['53300', 'PostgreSQL has no connection slots free'],
]);

/**
 * Every `.code` along an error's `cause` chain, outermost first.
 *
 * `Database` wraps what `pg` throws in a `DatabaseError` whose `cause` is the driver's error, and
 * `pg` sometimes wraps a socket error in turn. The code that means something is rarely the outer
 * one.
 *
 * **Our own errors are skipped.** `AppError.code` is this codebase's label for the kind of error —
 * `DATABASE_ERROR` on every wrapper — not anything the driver or the kernel said. Counting it made
 * pg-pool's code-less timeout look coded, so it was never retried, and reported a wrong password
 * as `DATABASE_ERROR` rather than `28P01`.
 */
function codes(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const code = current instanceof AppError ? undefined : (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') found.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

function messages(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') found.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

/**
 * Decides whether waiting could fix this.
 *
 * **Permanent unless shown otherwise.** Bad credentials (`28P01`), a database that does not exist
 * (`3D000`), a permission refused — retrying those for five minutes only postpones the sentence an
 * operator needs, so anything not recognised fails at once, as every start failure did before.
 */
export function classifyDatabaseFailure(error: unknown): DatabaseFailure {
  const all = codes(error);
  for (const code of all) {
    const reason = TRANSIENT_CODES.get(code);
    if (reason !== undefined) return { transient: true, code, reason };
  }
  // `pg-pool` rejects a connection that outlasts `connectTimeoutMs` with a bare `Error` and no
  // code at all, so this one is recognised by its text — the only place here that does that, and
  // only because the library leaves nothing else to switch on.
  if (
    all.length === 0 &&
    messages(error).some((text) => /timeout exceeded when trying to connect/i.test(text))
  ) {
    return { transient: true, code: undefined, reason: 'the connection timed out' };
  }
  return {
    transient: false,
    code: all[0],
    reason: describeError(error).message,
  };
}

export interface DatabaseWaitOptions {
  /** One attempt: `Database.check()`. */
  readonly check: () => Promise<{ serverVersion: string }>;
  readonly logger: Logger;
  /** `host:port/database`, so every line names what it is waiting for. */
  readonly target: string;
  /** The worst case of one attempt: the pool's `connectTimeoutMs`. */
  readonly attemptTimeoutMs: number;
  /** `Lifecycle.starting`, when there is a supervisor to keep informed. */
  readonly starting?: (status: string, ms: number) => void;
  readonly maxWaitMs?: number;
  /** Injectable so a test does not wait five minutes. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. Injectable for the same reason. */
  readonly now?: () => number;
}

/**
 * `check()`, repeated while the failure is one that waiting fixes and the bound allows.
 *
 * Returns what `check()` returns. Throws the last error unchanged once the bound is reached or the
 * failure is permanent, so what reaches `main().catch` — and the journal — is the same diagnosis
 * the core gave before this existed.
 */
export async function waitForDatabase(
  options: DatabaseWaitOptions,
): Promise<{ serverVersion: string }> {
  const maxWaitMs = options.maxWaitMs ?? DATABASE_WAIT_MS;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const now = options.now ?? ((): number => Number(process.hrtime.bigint() / 1_000_000n));
  const logger = options.logger.child({ component: 'database-wait', database: options.target });

  const started = now();
  let delay = FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await options.check();
      if (attempt > 1) {
        logger.info(
          { attempts: attempt, waitedMs: now() - started },
          'the database is reachable; continuing start-up',
        );
      }
      return result;
    } catch (error) {
      const failure = classifyDatabaseFailure(error);
      const waitedMs = now() - started;
      if (!failure.transient) throw error;
      if (waitedMs + delay > maxWaitMs) {
        logger.error(
          { attempts: attempt, waitedMs, code: failure.code, reason: failure.reason },
          `gave up waiting for the database at ${options.target} after ${String(
            Math.round(waitedMs / 1000),
          )} s; exiting so the service manager can start the core again`,
        );
        throw error;
      }

      const status =
        `waiting for PostgreSQL at ${options.target}: ${failure.reason}` +
        ` (attempt ${String(attempt)}, ${String(Math.round(waitedMs / 1000))} s)`;
      // **Every attempt, at warn.** The whole failure this replaces was a core that said nothing
      // useful while it was down; one line per attempt is at most a few hundred over the bound.
      logger.warn(
        {
          attempt,
          waitedMs,
          nextAttemptMs: delay,
          code: failure.code,
          reason: failure.reason,
          err: describeError(error),
        },
        status,
      );
      options.starting?.(status, delay + options.attemptTimeoutMs + EXTEND_MARGIN_MS);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}

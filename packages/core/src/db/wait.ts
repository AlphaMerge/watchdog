import { AppError, ConfigError, describeError, type Logger } from '@ms/shared';

/**
 * Waiting for PostgreSQL at start-up, inside the process (`P-215`).
 *
 * **The start-time failure of the core that waiting fixes most often.** A database in crash
 * recovery, one that started a moment after us, or one behind a network that is not up yet is
 * still there five minutes later; a schema the core refuses or a password the database refuses is
 * still wrong. `docs/administration.md`, *What a start failure does*, has every case and what the
 * core does with it (`P-215`, `P-222`). Until this existed the
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

/**
 * What a failure to reach the database means for start-up (`P-222`; the table is in
 * `docs/administration.md`, *What a start failure does*).
 *
 * - `transient`: the database is not there *yet*, or not reachable *yet*. Waited for, in rounds.
 * - `configuration`: the database answered and refused what this core was configured with — a
 *   password, a user, a database name, TLS. Restarting reads the same file and is refused again,
 *   so the core exits 78 (`EX_CONFIG`) and systemd does not restart it.
 * - `unknown`: nothing recognised it. Exits 1, and systemd restarts it, as every failure did before.
 */
export type DatabaseFailureKind = 'transient' | 'configuration' | 'unknown';

/** Whether waiting could fix a failure to reach the database, and why, in words for a log. */
export interface DatabaseFailure {
  readonly kind: DatabaseFailureKind;
  readonly transient: boolean;
  /** Node's `code`, PostgreSQL's SQLSTATE or TLS's reason, whichever the failure carried. */
  readonly code: string | undefined;
  readonly reason: string;
}

/**
 * Codes that describe a database that is not there, or not reachable, *yet*.
 *
 * Node's socket and resolver codes and PostgreSQL's SQLSTATEs share one namespace here, because
 * `pg` puts either on `.code` and callers have no other way to tell them apart.
 */
const TRANSIENT_CODES: ReadonlyMap<string, string> = new Map([
  ['ECONNREFUSED', 'nothing is listening yet'],
  ['ECONNRESET', 'the connection was reset'],
  ['ECONNABORTED', 'the connection was aborted'],
  ['EPIPE', 'the connection was closed while starting'],
  ['ETIMEDOUT', 'the connection timed out'],
  ['EHOSTUNREACH', 'the host is unreachable'],
  ['EHOSTDOWN', 'the host is down'],
  ['ENETUNREACH', 'the network is unreachable'],
  ['ENETDOWN', 'the network is down'],
  // A unix-socket host (`/var/run/postgresql`): PostgreSQL removes its socket file when it stops,
  // so "not running" is ENOENT there where it is ECONNREFUSED over TCP.
  ['ENOENT', 'the socket file is not there: PostgreSQL is not running yet'],
  // The resolver is not up yet, which at boot is ordinary.
  ['EAI_AGAIN', 'the name could not be resolved yet'],
  // **Ambiguous, and retried anyway** (`P-209` died on exactly this: `getaddrinfo ENOTFOUND
  // postgres`). A typo in the host name is permanent; a name not yet published — a container, a
  // DNS record behind a slow DHCP lease — is not. Neither can be told from the other here, so the
  // bound decides, and the log line names the host so that a typo is readable as one.
  ['ENOTFOUND', 'the name does not resolve'],
  // A clock not yet set at boot makes every certificate look issued in the future.
  ['CERT_NOT_YET_VALID', "the server's certificate is not valid yet: is this host's clock set?"],
  // `cannot_connect_now`: starting up, shutting down, or in crash recovery.
  ['57P03', 'PostgreSQL is starting up or recovering'],
  // A connection PostgreSQL ended as it shut down or crashed.
  ['57P01', 'PostgreSQL was shut down by an administrator'],
  ['57P02', 'PostgreSQL crashed and is restarting'],
  ['53300', 'PostgreSQL has no connection slots free'],
  ['08006', 'the connection to PostgreSQL failed'],
  ['08001', 'PostgreSQL could not be reached'],
]);

/**
 * Codes that say the database answered and refused what this core was configured with.
 *
 * Nothing here gets better by waiting, and a core that restarted into them five times used up
 * the units' start limit, so that the operator's own restart after fixing the file was refused.
 */
const CONFIGURATION_CODES: ReadonlyMap<string, string> = new Map([
  ['28P01', 'refused the password'],
  ['28000', 'refused this user (pg_hba.conf, or a role that may not log in)'],
  ['3D000', 'has no such database'],
  ['42501', 'refused this user permission to connect'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'presented a self-signed certificate this core does not trust'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'presented a certificate chain this core does not trust'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'presented a certificate this core cannot verify'],
  [
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'presented a certificate whose issuer this core does not trust',
  ],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'presented a certificate for a different host name'],
  ['CERT_HAS_EXPIRED', 'presented an expired certificate'],
]);

/**
 * Failures `pg` and `pg-pool` raise with no code at all, recognised by their text — the only
 * place here that reads messages, and only because the libraries leave nothing else to switch on.
 * Each is the library's own wording (`pg-pool` 3, `pg` 8), and each has a test that provokes it
 * from the real driver rather than building the error by hand.
 */
const TRANSIENT_MESSAGES: readonly [RegExp, string][] = [
  // `pg-pool`'s own timer on a *new* connection — every attempt at start-up, when the pool has
  // no clients. A host that drops packets rather than refusing them gives exactly this.
  [/Connection terminated due to connection timeout/i, 'the connection timed out'],
  // The same timer, for a caller queued behind a full pool.
  [/timeout exceeded when trying to connect/i, 'the connection timed out'],
  // `pg`'s own `connectionTimeoutMillis`, when it fires before the pool's.
  [/^timeout expired$/i, 'the connection timed out'],
  // The server, or something in front of it, closed the socket before answering.
  [/Connection terminated unexpectedly/i, 'the connection was closed before PostgreSQL answered'],
];

const CONFIGURATION_MESSAGES: readonly [RegExp, string][] = [
  // `database.password` empty or absent while the server asks for SCRAM: every fresh install
  // before step 3 of `installation.md`.
  [
    /client password must be a (non-empty )?string/i,
    'asked for a password, and none is configured',
  ],
  [/The server does not support SSL connections/i, 'does not accept TLS, and `database.ssl` is on'],
];

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

function verdict(
  kind: DatabaseFailureKind,
  code: string | undefined,
  reason: string,
): DatabaseFailure {
  return { kind, transient: kind === 'transient', code, reason };
}

/**
 * Decides what a failure to reach the database means: wait, refuse, or neither known.
 *
 * **By what the error says happened, not by which codes someone thought of** (`P-222`). The first
 * version recognised one code-less timeout — the one `pg-pool` raises for a caller queued behind a
 * full pool, which start-up never is — so a database behind a firewall that drops packets was
 * classed permanent, and under the units' start limit the core was `failed` in eighty seconds and
 * stayed there after the database came back. Codes are read first, down the whole chain; the
 * libraries' code-less failures are read by their text after that.
 */
export function classifyDatabaseFailure(error: unknown): DatabaseFailure {
  const all = codes(error);
  for (const code of all) {
    const transient = TRANSIENT_CODES.get(code);
    if (transient !== undefined) return verdict('transient', code, transient);
    const configuration = CONFIGURATION_CODES.get(code);
    if (configuration !== undefined) return verdict('configuration', code, configuration);
  }
  const texts = messages(error);
  for (const [pattern, reason] of CONFIGURATION_MESSAGES) {
    if (texts.some((text) => pattern.test(text))) return verdict('configuration', all[0], reason);
  }
  if (all.length === 0) {
    for (const [pattern, reason] of TRANSIENT_MESSAGES) {
      if (texts.some((text) => pattern.test(text))) return verdict('transient', undefined, reason);
    }
  }
  return verdict('unknown', all[0], describeError(error).message);
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
 * How long the rest of start-up is given once the database answers. `EXTEND_TIMEOUT_USEC` only
 * ever moves systemd's deadline later, so without this a wait that ran past `TimeoutStartSec` left
 * everything after it — schema, sweeps, listeners — only what the last attempt's extension had
 * over (`P-222`).
 */
export const AFTER_DATABASE_MS = 60_000;

/**
 * `check()`, repeated while the failure is one that waiting fixes and the bound allows.
 *
 * Returns what `check()` returns. A failure waiting fixes is thrown unchanged once the bound is
 * reached, and the process exits 1 so that systemd starts it again. A failure that only a changed
 * configuration fixes is thrown at once as a `ConfigError`, which exits 78 so that systemd does
 * not (`P-222`). Anything unrecognised is thrown unchanged at once, as before this existed.
 *
 * **Every attempt is inside an extension**, the first included: a `connectTimeoutMs` longer than
 * `TimeoutStartSec` would otherwise have its first attempt killed, five times, before it could fail
 * and be retried.
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
  options.starting?.(
    `connecting to PostgreSQL at ${options.target}`,
    options.attemptTimeoutMs + EXTEND_MARGIN_MS,
  );
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await options.check();
      if (attempt > 1) {
        logger.info(
          { attempts: attempt, waitedMs: now() - started },
          'the database is reachable; continuing start-up',
        );
      }
      options.starting?.(
        `PostgreSQL at ${options.target} is reachable; starting`,
        AFTER_DATABASE_MS,
      );
      return result;
    } catch (error) {
      const failure = classifyDatabaseFailure(error);
      const waitedMs = now() - started;
      if (failure.kind === 'configuration') {
        throw new ConfigError(
          `PostgreSQL at ${options.target} ${failure.reason}` +
            (failure.code === undefined ? '' : ` (${failure.code})`) +
            `: ${describeError(error).message}`,
          {
            context: {
              database: options.target,
              ...(failure.code === undefined ? {} : { code: failure.code }),
            },
            cause: error,
          },
        );
      }
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

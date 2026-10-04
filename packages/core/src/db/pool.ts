import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { AppError, describeError, type DatabaseConfig, type Logger } from '@ms/shared';

export interface DatabaseOptions {
  config: DatabaseConfig;
  logger: Logger;
  /** Overrides the database name — the integration tests point at a scratch database. */
  databaseOverride?: string;
  /**
   * What this pool's sessions are called in `pg_stat_activity`: `ms-core`, or `ms-core:<work>`
   * for a pool built for one kind of work (`withLimits`). Core Health's oldest-statement channel
   * reads `ms-core` alone, so work given a longer limit on purpose is not what it warns about.
   */
  work?: string;
}

/** The SQLSTATEs `P-229` answers, named once. Callers switch on these, never on the text. */
export const SQLSTATE = {
  /** `lock_timeout` fired, or a `NOWAIT` found the lock taken. The same request can succeed. */
  lockNotAvailable: '55P03',
  /**
   * `statement_timeout` fired, or somebody ran `pg_cancel_backend`. Only the server's message
   * tells the two apart, and it is translated, so the log carries it and nothing parses it.
   */
  queryCanceled: '57014',
  /** `idle_in_transaction_session_timeout` ended the session. The connection is gone. */
  idleInTransactionTimeout: '25P03',
} as const;

/**
 * Limits for one transaction, over the pool's (`P-229`).
 *
 * Set with `set_config(..., true)` straight after `BEGIN`, so they end with the transaction and
 * never reach the next caller of that connection. **Nothing in the core `SET`s or `RESET`s a
 * pooled session**: a `RESET` that fails hands the pool a connection with no limits at all, and
 * nothing would say so.
 */
export interface TxLimits {
  /** `statement_timeout` for this transaction, in milliseconds; 0 is no limit. */
  readonly statementTimeoutMs?: number;
  /** `lock_timeout` for this transaction, in milliseconds; 0 is no limit. */
  readonly lockTimeoutMs?: number;
  /**
   * Names the transaction `ms-core:<work>` in `pg_stat_activity`. Work that has a longer
   * statement limit is named, so the oldest-statement channel does not warn about it.
   */
  readonly work?: string;
  /**
   * The caller catches this transaction's lock timeouts and counts them itself — housekeeping
   * skipping a chunk it could not lock in two seconds — so they are not `dbLockTimeouts`.
   */
  readonly ownLockTimeouts?: boolean;
  /**
   * The same for this transaction's cancelled statements: the late-refusal record's write, which
   * gives way for time as well as for a lock and is counted on Core Health as a write given up
   * (`A-61`, `A-68`), so the pool's count would be a second channel warning for the same one.
   */
  readonly ownStatementTimeouts?: boolean;
}

/**
 * A pool of its own, with other limits, for work that cannot live inside one transaction. A limit
 * left out is the configured one.
 */
export interface PoolLimits {
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly poolSize: number;
  /** Its sessions are `ms-core:<work>` in `pg_stat_activity`. */
  readonly work: string;
}

/** The pool's statements that PostgreSQL cancelled or that waited too long for a lock. */
export interface TimeoutCounts {
  /** 57014 (`statement_timeout`, or a hand's `pg_cancel_backend`), apart from those owned. */
  readonly statements: number;
  /** 55P03, apart from the ones a caller said it counts itself. */
  readonly locks: number;
}

/** The fields `pg` puts on a driver error. Not exported by `pg`'s types in a usable shape. */
interface PostgresErrorFields {
  message?: string;
  /** SQLSTATE, e.g. 23505 for unique_violation. */
  code?: string;
  detail?: string;
  /** PostgreSQL's own suggestion. Frequently the entire fix, so it must not be dropped. */
  hint?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

function postgresFields(cause: unknown): PostgresErrorFields {
  if (typeof cause !== 'object' || cause === null) return {};
  const e = cause as PostgresErrorFields;
  return {
    ...(typeof e.message === 'string' ? { message: e.message } : {}),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
    ...(typeof e.hint === 'string' ? { hint: e.hint } : {}),
    ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}),
    ...(typeof e.table === 'string' ? { table: e.table } : {}),
    ...(typeof e.column === 'string' ? { column: e.column } : {}),
  };
}

/**
 * Anything that can run a statement and report failures as `DatabaseError`.
 *
 * Repositories are typed against this and never against a raw `PoolClient`, so the same code
 * runs on the pool or inside a caller's transaction. That is what lets a service compose
 * several repository calls into one atomic unit — which bulk operations (D-09) and discovery
 * provisioning (D-04) both need — instead of every method owning its own transaction.
 */
export interface Queryable {
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
  /**
   * Runs `fn` once this work has committed, and not at all if it rolls back (`U-02`).
   *
   * **For telling the outside world.** Everything inside a transaction is provisional: a
   * WebSocket frame announcing a state change, sent from inside the transaction that decided it,
   * is an outage on an operator's screen that may never have happened. Reacting *inside* the
   * transaction is still the rule for anything that writes — a dependency pause and an alarm
   * chain must commit with the state that caused them (`M-11`, `N-02`) — and this is the
   * complement for the things that only publish.
   *
   * Absent on a plain pool query, where there is no transaction to wait for: the caller runs its
   * own callback, because the statement has already committed by the time it returns.
   */
  afterCommit?(fn: () => void): void;
}

export class DatabaseError extends AppError {
  constructor(
    message: string,
    options: { context?: Record<string, string | number>; cause?: unknown },
  ) {
    // "query failed" is not a diagnosis (CLAUDE.md). Carry PostgreSQL's own message, its
    // SQLSTATE and the constraint it tripped, so the log line names the actual problem.
    const pg = postgresFields(options.cause);
    const detail = pg.message === undefined ? '' : `: ${pg.message}`;
    // PostgreSQL's HINT is often the whole answer — "add the extension to
    // shared_preload_libraries and restart" — so it travels with the message rather than
    // sitting in a context field nobody prints.
    const hint = pg.hint === undefined ? '' : `\n  hint: ${pg.hint}`;

    super('DATABASE_ERROR', `${message}${detail}${hint}`, {
      context: {
        ...options.context,
        ...(pg.code === undefined ? {} : { sqlstate: pg.code }),
        ...(pg.constraint === undefined ? {} : { constraint: pg.constraint }),
        ...(pg.table === undefined ? {} : { table: pg.table }),
        ...(pg.column === undefined ? {} : { column: pg.column }),
        ...(pg.detail === undefined ? {} : { pgDetail: pg.detail }),
        ...(pg.hint === undefined ? {} : { pgHint: pg.hint }),
      },
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'DatabaseError';
  }

  /** SQLSTATE, when the failure came from PostgreSQL. Callers switch on this, never on text. */
  get sqlstate(): string | undefined {
    const value = this.context['sqlstate'];
    return typeof value === 'string' ? value : undefined;
  }

  get constraint(): string | undefined {
    const value = this.context['constraint'];
    return typeof value === 'string' ? value : undefined;
  }
}

/**
 * The connection pool, plus the few helpers everything else builds on.
 *
 * Deliberately thin: this is not a query builder. Repositories own their SQL, and time-series
 * access sits behind its own interface (S-12) so the storage engine stays swappable.
 *
 * **Every session carries three limits from the moment it connects** (`P-229`):
 * `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`, from
 * `database.*` in the configuration, passed as startup options so no statement can run before
 * them. PostgreSQL's default for each is none, and before they were set one lock held outside
 * the core could take every connection in the pool and keep them.
 */
export class Database implements Queryable {
  readonly #pool: Pool;
  readonly #logger: Logger;
  readonly #describe: string;
  readonly #config: DatabaseConfig;
  readonly #database: string;
  readonly #application: string;
  readonly #counted = new WeakSet<object>();
  #statementTimeouts = 0;
  #lockTimeouts = 0;

  constructor(options: DatabaseOptions) {
    const { config } = options;
    const database = options.databaseOverride ?? config.database;
    this.#config = config;
    this.#database = database;
    this.#application = options.work === undefined ? 'ms-core' : `ms-core:${options.work}`;
    this.#logger = options.logger.child({ component: 'database' });
    this.#describe = `${config.host}:${String(config.port)}/${database}`;

    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      max: config.poolSize,
      connectionTimeoutMillis: config.connectTimeoutMs,
      application_name: this.#application,
      // Always all three, 0 included: 0 is this configuration's "no limit", and leaving one out
      // would let a role's or a database's own default decide instead.
      options:
        `-c statement_timeout=${String(config.statementTimeoutMs)} ` +
        `-c lock_timeout=${String(config.lockTimeoutMs)} ` +
        `-c idle_in_transaction_session_timeout=${String(config.idleInTransactionTimeoutMs)}`,
      // A statement limit is enforced by the server, so it cannot end a wait on a server that has
      // gone. Keepalive is what notices a connection to a host that vanished without a reset.
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    };

    this.#pool = new Pool(poolConfig);

    // An idle-client error is how a dropped connection or a server restart shows up. It must
    // not become an uncaught exception; the pool discards the client and carries on.
    this.#pool.on('error', (error) => {
      this.#logger.error({ err: describeError(error) }, 'idle database client failed');
    });
  }

  get description(): string {
    return this.#describe;
  }

  /** Pool statistics, surfaced on Core Health (P-12). */
  stats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.#pool.totalCount,
      idle: this.#pool.idleCount,
      waiting: this.#pool.waitingCount,
    };
  }

  /** Statements cancelled and lock waits given up, since this pool was built (`P-229`). */
  timeouts(): TimeoutCounts {
    return { statements: this.#statementTimeouts, locks: this.#lockTimeouts };
  }

  /**
   * A pool of its own, with other limits, for work that spans transactions or holds a session
   * (`P-229`): migrations, which run with none, and report rendering, which may take minutes.
   *
   * **A second pool rather than a changed session**, because the only way to give a pooled
   * session other limits for longer than one transaction is to `SET` them and `RESET` them
   * afterwards, and a `RESET` that fails returns the session to the pool with the wrong ones.
   * The caller closes it. Its counts are its own; Core Health reads this pool's.
   */
  withLimits(limits: PoolLimits): Database {
    return new Database({
      config: {
        ...this.#config,
        poolSize: limits.poolSize,
        statementTimeoutMs: limits.statementTimeoutMs ?? this.#config.statementTimeoutMs,
        lockTimeoutMs: limits.lockTimeoutMs ?? this.#config.lockTimeoutMs,
        idleInTransactionTimeoutMs:
          limits.idleInTransactionTimeoutMs ?? this.#config.idleInTransactionTimeoutMs,
      },
      logger: this.#logger,
      databaseOverride: this.#database,
      work: limits.work,
    });
  }

  async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]> {
    try {
      const result = await this.#pool.query<T>(text, values as unknown[] | undefined);
      return result.rows;
    } catch (cause) {
      this.#note(cause, undefined);
      throw new DatabaseError('query failed', {
        context: { statement: firstLine(text), database: this.#describe },
        cause,
      });
    }
  }

  /** Checks out one client for the duration of `fn`, with no implicit transaction. */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const { client, release } = await this.#checkout();
    try {
      return await fn(client);
    } catch (error) {
      this.#note(error, undefined);
      throw error;
    } finally {
      release();
    }
  }

  /** Runs `fn` inside a transaction, rolling back on any throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#transaction(fn, undefined);
  }

  /**
   * Runs `fn` inside a transaction, handing it a `Queryable` rather than a raw client.
   *
   * Prefer this over `transaction()`: everything reached through the executor keeps the
   * `DatabaseError` wrapping that callers switch on, and repositories stay unaware of whether
   * they are inside a transaction.
   *
   * `limits` apply to this transaction alone (`P-229`).
   */
  async tx<T>(fn: (q: Queryable) => Promise<T>, limits?: TxLimits): Promise<T> {
    const committed: (() => void)[] = [];
    const result = await this.#transaction(async (client) => {
      const q = new ClientQueryable(
        client,
        this.#describe,
        (hook) => committed.push(hook),
        (cause) => {
          this.#note(cause, limits);
        },
      );
      return fn(q);
    }, limits);
    // After the COMMIT returned, so nothing here can be undone by a rollback. Each hook is
    // isolated: one that throws must not stop the next, and must not turn a committed
    // transaction into a failed call — the work is already durable.
    for (const hook of committed) {
      try {
        hook();
      } catch (error: unknown) {
        this.#logger.error({ err: describeError(error) }, 'an after-commit hook threw');
      }
    }
    return result;
  }

  /**
   * Verifies the database is reachable and reports its version.
   *
   * Deliberately says nothing about extensions. Which storage engine is in use is the
   * time-series store's question, not the connection pool's (S-12) — asking it here would put a
   * TimescaleDB dependency in the one class every part of the system touches.
   */
  async check(): Promise<{ serverVersion: string }> {
    const [version] = await this.query<{ version: string }>('SELECT version() AS version');
    return { serverVersion: version?.version ?? 'unknown' };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    limits: TxLimits | undefined,
  ): Promise<T> {
    const { client, release } = await this.#checkout();
    let broken: unknown;
    try {
      await client.query('BEGIN');
      if (limits !== undefined) await this.#limit(client, limits);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      this.#note(error, limits);
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The original error is the interesting one; note the rollback failure and move on.
        this.#logger.error({ err: describeError(rollbackError) }, 'rollback failed');
        // A session whose rollback failed is in a state nobody knows, so it is not reused.
        broken = rollbackError;
      }
      throw error;
    } finally {
      release(broken);
    }
  }

  /** One statement, straight after `BEGIN`, so the limits cover everything `fn` sends. */
  async #limit(client: PoolClient, limits: TxLimits): Promise<void> {
    const settings: [string, string][] = [];
    if (limits.statementTimeoutMs !== undefined) {
      settings.push(['statement_timeout', String(limits.statementTimeoutMs)]);
    }
    if (limits.lockTimeoutMs !== undefined) {
      settings.push(['lock_timeout', String(limits.lockTimeoutMs)]);
    }
    if (limits.work !== undefined) {
      settings.push(['application_name', `${this.#application}:${limits.work}`]);
    }
    if (settings.length === 0) return;
    const values = settings.flat();
    const calls = settings.map(
      (_, index) => `set_config($${String(index * 2 + 1)}, $${String(index * 2 + 2)}, true)`,
    );
    await client.query(`SELECT ${calls.join(', ')}`, values);
  }

  /**
   * Counts a cancelled statement or a lock not granted, once however many layers it passes
   * through: the same failure reaches here from the statement and again from its transaction.
   */
  #note(error: unknown, limits: TxLimits | undefined): void {
    const found = postgresErrorIn(error);
    if (found === undefined || this.#counted.has(found.error)) return;
    this.#counted.add(found.error);
    if (found.sqlstate === SQLSTATE.queryCanceled && limits?.ownStatementTimeouts !== true) {
      this.#statementTimeouts += 1;
    } else if (found.sqlstate === SQLSTATE.lockNotAvailable && limits?.ownLockTimeouts !== true) {
      this.#lockTimeouts += 1;
    }
  }

  /**
   * A client from the pool, listened to until it is returned (`P-229`).
   *
   * pg-pool listens for a client's `error` only while the client is idle in the pool. A session
   * PostgreSQL ends while the client is checked out (`idle_in_transaction_session_timeout`, an
   * administrator's `pg_terminate_backend`, a server restart) emits `error` with nobody
   * listening, which Node makes an uncaught exception, and the core exits. So every client
   * handed out here has a listener while it is out, and one that failed goes back with its
   * error, which makes the pool discard it rather than hand it to the next caller.
   */
  async #checkout(): Promise<{ client: PoolClient; release: (failure?: unknown) => void }> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (cause) {
      throw new DatabaseError('cannot connect to the database', {
        context: { database: this.#describe },
        cause,
      });
    }
    let lost: Error | undefined;
    const onError = (error: Error): void => {
      lost = error;
      this.#logger.warn(
        { err: describeError(error) },
        'a database session in use ended; it will be discarded, not reused',
      );
    };
    client.on('error', onError);
    return {
      client,
      release: (failure?: unknown) => {
        client.off('error', onError);
        const discard = lost ?? failure;
        client.release(discard === undefined ? undefined : errorOf(discard));
      },
    };
  }
}

/** A checked-out client wearing the same error-wrapping as `Database`. */
export class ClientQueryable implements Queryable {
  readonly #client: PoolClient;
  readonly #description: string;
  readonly #onCommit: ((fn: () => void) => void) | undefined;
  readonly #onFailure: ((cause: unknown) => void) | undefined;

  constructor(
    client: PoolClient,
    description: string,
    onCommit?: (fn: () => void) => void,
    /** Told of every failed statement before it is wrapped, so the pool can count timeouts. */
    onFailure?: (cause: unknown) => void,
  ) {
    this.#client = client;
    this.#description = description;
    this.#onCommit = onCommit;
    this.#onFailure = onFailure;
  }

  afterCommit(fn: () => void): void {
    // Absent when this executor was built around a raw client rather than by `tx`, which is the
    // honest answer: without a transaction to wait for there is nothing to defer to.
    this.#onCommit?.(fn);
  }

  async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]> {
    try {
      const result = await this.#client.query<T>(text, values as unknown[] | undefined);
      return result.rows;
    } catch (cause) {
      this.#onFailure?.(cause);
      throw new DatabaseError('query failed', {
        context: { statement: firstLine(text), database: this.#description },
        cause,
      });
    }
  }
}

/**
 * The PostgreSQL error inside `error`, and its SQLSTATE: the error itself, or one it was caused
 * by, however many layers wrap it (a `DatabaseError`, then an `ObjectError` that names it).
 */
export function postgresErrorIn(error: unknown): { error: object; sqlstate: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { error: current, sqlstate: code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const newline = trimmed.indexOf('\n');
  const line = newline === -1 ? trimmed : trimmed.slice(0, newline);
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

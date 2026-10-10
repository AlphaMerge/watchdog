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
  /**
   * `in_failed_sql_transaction`: a statement failed earlier in this transaction, so nothing after
   * it runs and nothing in it commits. PostgreSQL answers every statement but the end of the
   * transaction with it, and answers that end, a `COMMIT`, with no error at all (`P-249`), so
   * `Database` raises it at the `COMMIT` itself.
   */
  inFailedTransaction: '25P02',
  /**
   * `unique_violation`. Which rule was broken is the constraint's name, never the text: see
   * `uniqueViolation` and `db/unique-constraints.ts` (`P-391`).
   */
  uniqueViolation: '23505',
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
  /**
   * Runs `fn` if this work does not commit: the transaction rolled back, or the savepoint it was
   * asked for in was rolled back to (`P-249`). Hooks run newest first, each isolated.
   *
   * **For undoing what was changed in memory alongside the transaction**, where that memory has
   * to be right while the transaction runs and so cannot wait for `afterCommit`: the probe
   * reachability overlay, which the state service and the alarm engine read inside the same
   * transaction. Without it a rolled-back mutation left the overlay describing a tree that was
   * never written.
   *
   * Absent on a plain pool query, as `afterCommit` is.
   */
  afterRollback?(fn: () => void): void;
  /**
   * Runs `fn` inside a savepoint of this transaction (`P-249`). Called through `savepoint()`,
   * which runs `fn` straight on a `Queryable` without this.
   *
   * **For code that must catch a database error inside someone else's transaction.** A failed
   * statement aborts the whole transaction, and PostgreSQL answers its `COMMIT` with `ROLLBACK`
   * and no error, so a catch that carries on loses every write the transaction made, the
   * caller's included. Inside a savepoint, a throw rolls back to it and the transaction goes on.
   *
   * Absent on a plain pool query, where each statement is a transaction of its own and a failed
   * one aborts nothing else.
   */
  savepoint?<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` so that a database error it throws can be caught without aborting the transaction `q`
 * belongs to (`P-249`).
 *
 * Inside a transaction, `fn` runs in a savepoint. If it throws, the savepoint is rolled back,
 * anything `fn` asked to run after the commit is dropped, and the error is rethrown for the caller
 * to catch; the transaction carries on as it was before `fn` began. If `fn` returns after catching
 * a failure of its own, the savepoint is rolled back all the same, and this throws a
 * `DatabaseError` (`25P02`) rather than answer for work that was not done. On a plain pool `fn`
 * simply runs: there is no transaction for a failure to abort.
 *
 * **Every catch of a database error inside a transaction goes through this, or rethrows.** The
 * list is `P-249`'s outcome in `docs/TASKS.md`.
 */
export function savepoint<T>(q: Queryable, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return q.savepoint === undefined ? fn(q) : q.savepoint(fn);
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

  /**
   * Runs `fn` inside a transaction, rolling back on any throw.
   *
   * **And throws if the transaction did not commit** (`P-249`): a statement in it failed and the
   * failure was caught, so PostgreSQL answered the `COMMIT` with `ROLLBACK`. The error is a
   * `DatabaseError` with SQLSTATE `25P02`.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#transaction(fn, undefined, undefined);
  }

  /**
   * Runs `fn` inside a transaction, handing it a `Queryable` rather than a raw client.
   *
   * Prefer this over `transaction()`: everything reached through the executor keeps the
   * `DatabaseError` wrapping that callers switch on, and repositories stay unaware of whether
   * they are inside a transaction.
   *
   * `limits` apply to this transaction alone (`P-229`).
   *
   * **A transaction that did not commit throws, and runs no `afterCommit` hook** (`P-249`). A
   * statement that fails aborts the transaction, and PostgreSQL then answers the `COMMIT` with
   * command tag `ROLLBACK` and no error. Before this read the tag, a failure caught inside `fn`
   * (by a sink, say) was answered as success, the hooks announced a commit that had not happened,
   * and nothing had been written. Code that must catch a database error inside a transaction
   * catches it around `savepoint()`.
   */
  async tx<T>(fn: (q: Queryable) => Promise<T>, limits?: TxLimits): Promise<T> {
    const committed: (() => void)[] = [];
    const undone: (() => void)[] = [];
    const state: TxState = {
      savepoints: 0,
      failed: undefined,
      hookThrew: (error) => {
        this.#logger.error({ err: describeError(error) }, 'an after-rollback hook threw');
      },
    };
    let result: T;
    try {
      result = await this.#transaction(
        async (client) => {
          const q = new ClientQueryable(
            client,
            this.#describe,
            (hook) => committed.push(hook),
            (cause) => {
              this.#note(cause, limits);
            },
            state,
            (hook) => undone.push(hook),
          );
          return fn(q);
        },
        limits,
        state,
      );
    } catch (error) {
      // Nothing committed, a COMMIT answered ROLLBACK included: what was changed in memory beside
      // it is put back, newest first.
      runHooks(undone.reverse(), state.hookThrew);
      throw error;
    }
    // After the COMMIT returned, and said COMMIT, so nothing here can be undone by a rollback. Each
    // hook is isolated: one that throws must not stop the next, and must not turn a committed
    // transaction into a failed call — the work is already durable.
    runHooks(committed, (error) => {
      this.#logger.error({ err: describeError(error) }, 'an after-commit hook threw');
    });
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
    state: TxState | undefined,
  ): Promise<T> {
    const { client, release } = await this.#checkout();
    let broken: unknown;
    let ended = false;
    try {
      await client.query('BEGIN');
      if (limits !== undefined) await this.#limit(client, limits);
      const result = await fn(client);
      const commit = await client.query('COMMIT');
      // **PostgreSQL rolls back a transaction an error aborted, and says so only here** (`P-249`):
      // the `COMMIT` succeeds, with command tag `ROLLBACK`. Answering `result` would be answering
      // for writes that are gone.
      if (commit.command === 'ROLLBACK') {
        ended = true;
        throw rolledBackAtCommit(this.#describe, state?.failed);
      }
      return result;
    } catch (error) {
      this.#note(error, limits);
      // Over already when the COMMIT rolled it back; a ROLLBACK now would only draw a warning.
      if (!ended) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The original error is the interesting one; note the rollback failure and move on.
          this.#logger.error({ err: describeError(rollbackError) }, 'rollback failed');
          // A session whose rollback failed is in a state nobody knows, so it is not reused.
          broken = rollbackError;
        }
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
  readonly #state: TxState | undefined;
  readonly #onRollback: ((fn: () => void) => void) | undefined;

  constructor(
    client: PoolClient,
    description: string,
    onCommit?: (fn: () => void) => void,
    /** Told of every failed statement before it is wrapped, so the pool can count timeouts. */
    onFailure?: (cause: unknown) => void,
    /**
     * The transaction this executor is inside, which `tx` passes and which makes `savepoint`
     * available. Built around a raw client without it, there may be no transaction to save in.
     */
    state?: TxState,
    /** Where `afterRollback` hooks go: the transaction's, or the savepoint's they were taken in. */
    onRollback?: (fn: () => void) => void,
  ) {
    this.#client = client;
    this.#description = description;
    this.#onCommit = onCommit;
    this.#onFailure = onFailure;
    this.#state = state;
    this.#onRollback = onRollback;
  }

  afterCommit(fn: () => void): void {
    // Absent when this executor was built around a raw client rather than by `tx`, which is the
    // honest answer: without a transaction to wait for there is nothing to defer to.
    this.#onCommit?.(fn);
  }

  afterRollback(fn: () => void): void {
    this.#onRollback?.(fn);
  }

  async savepoint<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const state = this.#state;
    // Built around a raw client rather than by `tx`, there is no transaction this knows of, and
    // outside one `SAVEPOINT` is itself an error.
    if (state === undefined) return fn(this);
    state.savepoints += 1;
    const name = `ms_savepoint_${String(state.savepoints)}`;
    // What had failed before this began. A failure inside that this rolls back aborted nothing,
    // so the transaction's account of what aborted it goes back to this.
    const failedBefore = state.failed;
    // **Held until the savepoint is released, and dropped if it is rolled back.** A hook is an
    // announcement of what this work did, and work rolled back to here did nothing.
    const hooks: (() => void)[] = [];
    // And the undoing of what it changed in memory: run when it is rolled back to, and handed to
    // the transaction (or the savepoint around this one) when it is released, since that can
    // still roll back.
    const undone: (() => void)[] = [];
    const inner = new ClientQueryable(
      this.#client,
      this.#description,
      (hook) => hooks.push(hook),
      this.#onFailure,
      state,
      (hook) => undone.push(hook),
    );
    await this.query(`SAVEPOINT ${name}`);
    let result: T;
    try {
      result = await fn(inner);
    } catch (error) {
      // The undoing runs even if the rollback to here fails: then the transaction is lost too.
      try {
        await this.#rollBackTo(name, failedBefore);
      } finally {
        runHooks(undone.reverse(), state.hookThrew);
      }
      throw error;
    }
    try {
      await this.query(`RELEASE SAVEPOINT ${name}`);
    } catch (released) {
      // `fn` caught a failure of its own and returned, so the savepoint is aborted and refuses to
      // be released. Its work is gone; answering `result` would be answering for it.
      try {
        await this.#rollBackTo(name, failedBefore);
      } finally {
        runHooks(undone.reverse(), state.hookThrew);
      }
      throw new DatabaseError(
        'a savepoint was rolled back: a statement in it failed and the failure was caught there',
        {
          context: {
            phase: 'savepoint',
            database: this.#description,
            sqlstate: SQLSTATE.inFailedTransaction,
            released: (released instanceof Error ? released.message : String(released)).slice(
              0,
              200,
            ),
          },
        },
      );
    }
    for (const hook of hooks) this.#onCommit?.(hook);
    for (const hook of undone) this.#onRollback?.(hook);
    return result;
  }

  async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]> {
    try {
      const result = await this.#client.query<T>(text, values as unknown[] | undefined);
      return result.rows;
    } catch (cause) {
      this.#onFailure?.(cause);
      const error = new DatabaseError('query failed', {
        context: { statement: firstLine(text), database: this.#description },
        cause,
      });
      // The first failure is what aborted the transaction; anything after it is `25P02`.
      if (this.#state !== undefined) this.#state.failed ??= error;
      throw error;
    }
  }

  /** Back to the savepoint, and forget it: its work, and its failures, are undone. */
  async #rollBackTo(name: string, failedBefore: DatabaseError | undefined): Promise<void> {
    // If this fails the session is in a state nobody knows; the error goes up, and the
    // transaction's own rollback discards the connection.
    await this.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await this.query(`RELEASE SAVEPOINT ${name}`);
    if (this.#state !== undefined) this.#state.failed = failedBefore;
  }
}

/** What one `tx` shares with every executor and savepoint inside it (`P-249`). */
interface TxState {
  /** Savepoints begun, so that each is named apart from the ones around it. */
  savepoints: number;
  /** The failure that aborted the transaction, if one has and no savepoint undid it. */
  failed: DatabaseError | undefined;
  /** Where an `afterRollback` hook that threw is reported. */
  readonly hookThrew: (error: unknown) => void;
}

/** Runs each hook, so that one that throws neither stops the rest nor escapes. */
function runHooks(hooks: readonly (() => void)[], threw: (error: unknown) => void): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch (error: unknown) {
      threw(error);
    }
  }
}

/** A `COMMIT` that PostgreSQL answered with `ROLLBACK` (`P-249`). */
function rolledBackAtCommit(database: string, failed: DatabaseError | undefined): DatabaseError {
  const first = failed?.message.slice(0, 200);
  return new DatabaseError(
    'the transaction was rolled back, not committed: a statement in it failed and the failure ' +
      'was caught inside it, so nothing it wrote was kept',
    {
      context: {
        phase: 'commit',
        commandTag: 'ROLLBACK',
        database,
        sqlstate: SQLSTATE.inFailedTransaction,
        ...(first === undefined ? {} : { abortedBy: first }),
        ...(failed?.sqlstate === undefined ? {} : { abortedBySqlstate: failed.sqlstate }),
      },
    },
  );
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

/**
 * The unique constraint or index `error` broke (`P-391`), through however many layers wrap the
 * driver's error; `''` for a unique violation that names none; null for anything else. A caller
 * that refuses a duplicate switches on the name, so a second unique rule on the same table is
 * never reported as the first.
 */
export function uniqueViolation(error: unknown): string | null {
  const found = postgresErrorIn(error);
  if (found?.sqlstate !== SQLSTATE.uniqueViolation) return null;
  const { constraint } = found.error as { constraint?: unknown };
  return typeof constraint === 'string' ? constraint : '';
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

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { AppError, describeError, type DatabaseConfig, type Logger } from '@ms/shared';

export interface DatabaseOptions {
  config: DatabaseConfig;
  logger: Logger;
  /** Overrides the database name — the integration tests point at a scratch database. */
  databaseOverride?: string;
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
 */
export class Database implements Queryable {
  readonly #pool: Pool;
  readonly #logger: Logger;
  readonly #describe: string;

  constructor(options: DatabaseOptions) {
    const { config } = options;
    const database = options.databaseOverride ?? config.database;
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
      application_name: 'ms-core',
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

  async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]> {
    try {
      const result = await this.#pool.query<T>(text, values as unknown[] | undefined);
      return result.rows;
    } catch (cause) {
      throw new DatabaseError('query failed', {
        context: { statement: firstLine(text), database: this.#describe },
        cause,
      });
    }
  }

  /** Checks out one client for the duration of `fn`, with no implicit transaction. */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /** Runs `fn` inside a transaction, rolling back on any throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The original error is the interesting one; note the rollback failure and move on.
        this.#logger.error({ err: describeError(rollbackError) }, 'rollback failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` inside a transaction, handing it a `Queryable` rather than a raw client.
   *
   * Prefer this over `transaction()`: everything reached through the executor keeps the
   * `DatabaseError` wrapping that callers switch on, and repositories stay unaware of whether
   * they are inside a transaction.
   */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const committed: (() => void)[] = [];
    const result = await this.transaction(async (client) => {
      const q = new ClientQueryable(client, this.#describe, (hook) => committed.push(hook));
      return fn(q);
    });
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

  async #connect(): Promise<PoolClient> {
    try {
      return await this.#pool.connect();
    } catch (cause) {
      throw new DatabaseError('cannot connect to the database', {
        context: { database: this.#describe },
        cause,
      });
    }
  }
}

/** A checked-out client wearing the same error-wrapping as `Database`. */
export class ClientQueryable implements Queryable {
  readonly #client: PoolClient;
  readonly #description: string;
  readonly #onCommit: ((fn: () => void) => void) | undefined;

  constructor(client: PoolClient, description: string, onCommit?: (fn: () => void) => void) {
    this.#client = client;
    this.#description = description;
    this.#onCommit = onCommit;
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
      throw new DatabaseError('query failed', {
        context: { statement: firstLine(text), database: this.#description },
        cause,
      });
    }
  }
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const newline = trimmed.indexOf('\n');
  const line = newline === -1 ? trimmed : trimmed.slice(0, newline);
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

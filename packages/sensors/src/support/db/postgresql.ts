import pg from 'pg';
import {
  codeOf,
  DbError,
  describeDbError,
  type DbConnectOptions,
  type DbConnection,
  type DbDriver,
  type DbResult,
} from './driver.js';
import { connectBudgetMs, unconnectedSocket } from './socket.js';

/**
 * PostgreSQL, through `pg` — the one driver this installation already has (`T-18`).
 *
 * `packages/core` uses it for the configuration and metrics database, so a PostgreSQL sensor adds
 * nothing an operator has to install. The library is imported here and nowhere else.
 *
 * **`statement_timeout` is set on the session, not enforced by the client.** A client-side
 * deadline that closes the socket leaves the backend running the query — `pg_cancel_backend` is
 * the only other way to stop it, and a monitoring check should not be issuing those. Setting the
 * server's own limit means the query stops when the sensor gives up.
 */
export const postgresqlDriver: DbDriver = {
  id: 'postgresql',
  name: 'PostgreSQL',
  defaultPort: 5432,

  async connect(options: DbConnectOptions, signal: AbortSignal): Promise<DbConnection> {
    // `prefer` is what `psql` does and what almost every deployment is actually running: try
    // TLS, accept plain text if the server has none. `require` refuses the downgrade.
    const client = clientFor(
      options,
      options.encrypt === 'disable' ? false : { rejectUnauthorized: options.verifyTls },
    );

    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      if (options.encrypt === 'prefer' && isTlsRefusal(error)) {
        // The server has no TLS at all. `prefer` means exactly this: try, and carry on without.
        return connectPlain(options, signal);
      }
      throw describeDbError(error, options, 'PostgreSQL');
    }

    return wrap(client, options);
  },
};

/**
 * **Handed its socket when the device's name was checked** (`A-62`): `pg` takes no `lookup`, and
 * takes a `stream`. The host stays the name, so `pg` names it in TLS and checks the certificate
 * against it.
 */
function clientFor(
  options: DbConnectOptions,
  ssl: false | { rejectUnauthorized: boolean },
): pg.Client {
  const stream = unconnectedSocket(options);
  return new pg.Client({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.username,
    password: options.password,
    connectionTimeoutMillis: connectBudgetMs(options),
    ssl,
    ...(stream === undefined ? {} : { stream }),
    // The application name lands in `pg_stat_activity`, which is where a DBA looks when asking
    // who is running this query every sixty seconds.
    application_name: 'monitoring-system',
    statement_timeout: options.statementTimeoutMs,
  });
}

async function connectPlain(
  options: DbConnectOptions,
  _signal: AbortSignal,
): Promise<DbConnection> {
  // A second connection of the same check: the same checked addresses, and no second lookup.
  const client = clientFor(options, false);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw describeDbError(error, options, 'PostgreSQL');
  }
  return wrap(client, options);
}

function wrap(client: pg.Client, options: DbConnectOptions): DbConnection {
  return {
    async query(sql: string, signal: AbortSignal): Promise<DbResult> {
      // PostgreSQL terminates a running query when its client disconnects, so ending the
      // connection is both how the check honours `ctx.signal` and how the work actually stops.
      const onAbort = (): void => {
        void client.end().catch(() => undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        // Several statements in one string come back as an array of results. The last one is
        // what the sensor asked about — a `SET` followed by a `SELECT` is a real thing to write.
        const result = (await client.query(sql)) as unknown as
          pg.QueryResult<Record<string, unknown>> | pg.QueryResult<Record<string, unknown>>[];
        const one = Array.isArray(result) ? result[result.length - 1] : result;
        return {
          rows: one?.rows ?? [],
          columns: (one?.fields ?? []).map((field) => field.name),
        };
      } catch (error) {
        const code = codeOf(error);
        if (code === '57014') {
          // The server stopped it, which is the point of setting `statement_timeout`.
          throw new DbError(
            `the query was still running after ${String(options.statementTimeoutMs)} ms and ` +
              'PostgreSQL cancelled it — the statement timeout is server-side, so nothing was ' +
              'left running',
          );
        }
        if (signal.aborted) throw new DbError('the check was cancelled while querying');
        throw describeDbError(error, options, 'PostgreSQL');
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    async close(): Promise<void> {
      await client.end().catch(() => undefined);
    },
  };
}

/** A server built without TLS answers the SSL request with a refusal rather than an error code. */
function isTlsRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not support SSL|server does not support SSL/i.test(message);
}

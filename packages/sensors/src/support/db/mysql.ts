import { createConnection, type Connection, type FieldPacket } from 'mysql2/promise';
import {
  codeOf,
  DbError,
  describeDbError,
  type DbConnectOptions,
  type DbConnection,
  type DbDriver,
  type DbResult,
} from './driver.js';
import { connectBudgetMs, connectingSocket } from './socket.js';

/**
 * MySQL and MariaDB, through `mysql2` (`T-18`).
 *
 * **A dependency rather than a hand-written protocol**, and that is the project's own rule read
 * the right way round: CLAUDE.md says syslog, NetFlow and WMI are written here *because npm has
 * no maintained option*. MySQL has one — and the part that would have to be written is
 * `caching_sha2_password`, the default since 8.0, which is an RSA key exchange against the server
 * where getting it subtly wrong means a sensor that authenticates until somebody rotates a
 * password.
 *
 * **`max_execution_time` is the server-side limit and it only applies to `SELECT`.** MySQL has no
 * general statement timeout: the session variable covers read-only `SELECT` statements and
 * nothing else. A monitoring query that is not a `SELECT` therefore has only the client's
 * deadline behind it, which is stated rather than hidden — a check whose timeout leaves work
 * running is worth knowing about.
 */
export const mysqlDriver: DbDriver = {
  id: 'mysql',
  name: 'MySQL',
  defaultPort: 3306,

  async connect(options: DbConnectOptions, _signal: AbortSignal): Promise<DbConnection> {
    let connection: Connection;
    // **Handed its socket when the device's name was checked** (`A-62`): `mysql2` takes no
    // `lookup`, and takes a `stream`. The host stays the name, which is what it names in TLS.
    // And when a certificate is verified for a device given as an address (`A-70`): the
    // socket is what tells Node which address that is.
    const stream = connectingSocket(options);
    try {
      connection = await createConnection({
        host: options.host,
        port: options.port,
        ...(stream === undefined ? {} : { stream }),
        ...(options.database === '' ? {} : { database: options.database }),
        user: options.username,
        password: options.password,
        connectTimeout: connectBudgetMs(options),
        ...(options.encrypt === 'disable'
          ? {}
          : {
              // **The name too, where the certificate is verified at all** (`A-70`). `mysql2`
              // checks the chain under `rejectUnauthorized` and who the certificate is for
              // only under `verifyIdentity` (`lib/base/connection.js` `startTLS`: without it
              // the `checkServerIdentity` it hands Node is a function that returns nothing).
              // So "Verify the certificate" accepted any trusted certificate, for any name.
              ssl: { rejectUnauthorized: options.verifyTls, verifyIdentity: options.verifyTls },
            }),
        // Multiple statements stay off. A monitoring query is one question, and turning this on
        // would make a mistyped parameter able to run two.
        multipleStatements: false,
        dateStrings: true,
      });
    } catch (error) {
      throw describeDbError(error, options, 'MySQL');
    }

    // **Two variables, because MySQL and MariaDB do not share one.** MySQL 5.7.8+ has
    // `max_execution_time`, in milliseconds, and applies it to read-only `SELECT` statements.
    // MariaDB has `max_statement_time`, in *seconds* as a float, and applies it to everything.
    // Setting only MySQL's is what this did first, and a live MariaDB let a ten-second query run
    // to completion with a three-second timeout configured — a check that gave up and hung up
    // would have left that query running once a minute for ever.
    //
    // Neither is an error worth failing on: anything from MySQL 5.7.8 or MariaDB 10.1 has one
    // of them, and a server older than 2015 still runs the check.
    for (const statement of [
      `SET SESSION max_execution_time = ${String(Math.round(options.statementTimeoutMs))}`,
      `SET SESSION max_statement_time = ${String(options.statementTimeoutMs / 1_000)}`,
    ]) {
      try {
        await connection.query(statement);
      } catch {
        // This engine does not have this one. The other may still have applied.
      }
    }

    return {
      async query(sql: string, querySignal: AbortSignal): Promise<DbResult> {
        // CLAUDE.md requires every check to honour its signal, and a query in flight is exactly
        // where that matters: destroying the connection is what makes the server notice.
        const onAbort = (): void => {
          connection.destroy();
        };
        querySignal.addEventListener('abort', onAbort, { once: true });
        try {
          const [rows, fields] = await connection.query(sql);
          const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
          return {
            rows: list,
            columns: (fields as FieldPacket[] | undefined)?.map((field) => field.name) ?? [],
          };
        } catch (error) {
          const code = codeOf(error);
          if (
            code === 'ER_QUERY_TIMEOUT' ||
            code === 'ER_STATEMENT_TIMEOUT' ||
            /max_execution_time|maximum statement|query execution was interrupted/i.test(
              String(error),
            )
          ) {
            throw new DbError(
              `the query was still running after ${String(options.statementTimeoutMs)} ms and ` +
                'the server stopped it',
              'query',
              options.host,
            );
          }
          if (querySignal.aborted) {
            throw new DbError('the check was cancelled while querying', 'query', options.host);
          }
          throw describeDbError(error, options, 'MySQL', 'query');
        } finally {
          querySignal.removeEventListener('abort', onAbort);
        }
      },
      async close(): Promise<void> {
        await connection.end().catch(() => undefined);
      },
    };
  },
};

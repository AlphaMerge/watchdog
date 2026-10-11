import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { serverIdentity } from '@ms/shared';
import { Connection as CoreConnection, createConnection } from 'mysql2';
import type { Connection, FieldPacket } from 'mysql2/promise';
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

/** What `mysql2` hands the callback of its TLS upgrade: an error, or nothing when it is secure. */
type OnSecure = (error?: Error) => void;

/**
 * Checks the certificate against a device given as an address, of either family, before
 * `mysql2` can send the login (`A-74`).
 *
 * **`mysql2` takes no identity check of ours**, and Node's own cannot be made to do this one.
 * `startTLS` hands Node `tls.checkServerIdentity` and no server name for an address
 * (`lib/base/connection.js` 380-445), so Node checks against the socket's record of its host,
 * and failing that `localhost`. An IPv6 address it cannot check at all: it reads it as a name
 * (`serverIdentity` in `@ms/shared`). So a device given as `::1` was refused under every
 * certificate, and one given as `10.0.0.5` was checked only because the socket was given a
 * `_host`, which Node reads and does not document.
 *
 * **Checked in the callback `startTLS` is handed, which is the only way to the login.** Node
 * verifies the chain, under `rejectUnauthorized`, and destroys the socket before it calls back
 * if the chain fails. `mysql2` then calls this callback with no error, and the one it wraps,
 * `ClientHandshake`'s, is what sends the credentials (`lib/commands/client_handshake.js`
 * 318-329). Here the certificate is checked against the device's address first, by the check
 * every other TLS client here uses, and the socket destroyed and the callback handed the error
 * if it fails. That callback reports the error and sends nothing. It does not depend on a
 * handler of ours running before one of theirs: theirs is the one this calls.
 *
 * **What it leans on is `mysql2`'s, which the lockfile pins and the tests drive**:
 * `startTLS(onSecure)` on the connection, and `stream` the TLS socket by the time `onSecure` is
 * called. The method is looked for before a connection is made (`upgradeToCheck`), and **a
 * driver without it is refused**: its identity check would be the one returning nothing, so
 * connecting would be verifying the chain and not the name.
 */
function checkAddressOnSecure(connection: object, host: string): void {
  const seam = connection as { startTLS?: unknown; stream?: unknown };
  if (typeof seam.startTLS !== 'function') throw noUpgradeToCheck(host);
  const startTLS = (seam.startTLS as (onSecure: OnSecure) => void).bind(connection);
  seam.startTLS = (onSecure: OnSecure): void => {
    startTLS((error?: Error) => {
      if (error !== undefined) {
        onSecure(error);
        return;
      }
      const socket = seam.stream;
      const refusal =
        socket instanceof TLSSocket
          ? serverIdentity(host, socket.getPeerCertificate(true))
          : new Error('the MySQL driver upgraded to TLS on no TLS socket this can check');
      if (refusal !== undefined) {
        if (socket instanceof TLSSocket) socket.destroy();
        onSecure(refusal);
        return;
      }
      onSecure();
    });
  };
}

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
/** Whether `mysql2`'s connections have the TLS upgrade `checkAddressOnSecure` checks in. */
function upgradeToCheck(): boolean {
  return typeof (CoreConnection.prototype as { startTLS?: unknown }).startTLS === 'function';
}

function noUpgradeToCheck(host: string): DbError {
  return new DbError(
    `MySQL at ${host}: this build of the MySQL driver has no TLS upgrade to check the ` +
      'certificate in, so nothing was sent. Give the device a name the certificate is for, ' +
      'or turn verification off.',
    'connect',
  );
}

export const mysqlDriver: DbDriver = {
  id: 'mysql',
  name: 'MySQL',
  defaultPort: 3306,

  async connect(options: DbConnectOptions, _signal: AbortSignal): Promise<DbConnection> {
    let connection: Connection;
    // **Handed its socket when the device's name was checked** (`A-62`): `mysql2` takes no
    // `lookup`, and takes a `stream`. The host stays the name, which is what it names in TLS.
    const stream = connectingSocket(options);
    // **A device given as an address is checked by us, in `mysql2`'s TLS upgrade** (`A-74`): the
    // driver is told to check the chain and not the name, which it would check against
    // `localhost`. See `checkAddressOnSecure`.
    const address = options.verifyTls && options.encrypt !== 'disable' && isIP(options.host) !== 0;
    // Before a connection is made, so that refusing it leaves nothing connecting.
    if (address && !upgradeToCheck()) throw noUpgradeToCheck(options.host);
    try {
      const core = createConnection({
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
              ssl: {
                rejectUnauthorized: options.verifyTls,
                verifyIdentity: options.verifyTls && !address,
              },
            }),
        // Multiple statements stay off. A monitoring query is one question, and turning this on
        // would make a mistyped parameter able to run two.
        multipleStatements: false,
        dateStrings: true,
      });
      // In the same turn it was made: the socket may be connecting, and nothing is sent on it
      // until the server has spoken, so a refusal here has sent nothing.
      if (address) {
        try {
          checkAddressOnSecure(core, options.host);
        } catch (error) {
          // Its own socket is connecting: what it says after this has nobody to hear it.
          core.on('error', () => undefined);
          core.destroy();
          throw error;
        }
      }
      // What `mysql2/promise`'s `createConnection` does with the connection it makes, which is
      // made here so that its upgrade can be reached before it runs.
      await new Promise<void>((resolve, reject) => {
        core.once('connect', () => {
          resolve();
        });
        core.once('error', reject);
      });
      connection = core.promise();
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

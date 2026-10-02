import { Connection, Request, TYPES } from 'tedious';
import {
  DbError,
  describeDbError,
  type DbConnectOptions,
  type DbConnection,
  type DbDriver,
  type DbResult,
} from './driver.js';
import { connectBudgetMs, tdsConnector } from './socket.js';

/**
 * Microsoft SQL Server, through `tedious` (`T-18`).
 *
 * **Microsoft's own TDS implementation for Node, and the reason not to write one.** TDS is a
 * binary protocol with a login negotiation, a pre-login handshake and its own TLS-inside-the-
 * protocol arrangement; the part that would have to be reimplemented is exactly the part where a
 * mistake looks like an intermittent authentication failure.
 *
 * **`SET LOCK_TIMEOUT` and a client request timeout together**, because SQL Server has no
 * statement timeout of its own. What it has is a *lock* timeout, which covers the case that
 * actually hangs a monitoring query — waiting behind somebody else's transaction — and `tedious`
 * cancels the request properly at the protocol level rather than dropping the socket, which is
 * the closest a client can get to stopping the work.
 *
 * **Its TLS is checked by Node's own identity check and no other** (`A-70`). `tedious` wraps
 * the TLS it runs inside TDS itself (`lib/message-io.js` `startTls`: `tls.connect` with
 * `servername`, a secure context and `rejectUnauthorized`, and nothing else of ours), so there
 * is nowhere to hand it `serverIdentity`. A device given as an IPv4 address is checked against
 * the addresses its certificate lists, because `tedious` names the address as the server name
 * and Node checks an IPv4 one as an address. A device given as an IPv6 address is refused under
 * any certificate: Node reads it as a name. The one way round is to turn the driver's own
 * rejection off and check afterwards, which is verification that holds only while our own
 * handler runs, and is not done.
 */
export const mssqlDriver: DbDriver = {
  id: 'mssql',
  name: 'Microsoft SQL Server',
  defaultPort: 1433,

  async connect(options: DbConnectOptions, signal: AbortSignal): Promise<DbConnection> {
    // **Handed its socket when the device's name was checked** (`A-62`): `tedious` takes no
    // `lookup`, and takes a `connector`. The server stays the name, which is what it names in
    // the TLS it runs inside TDS.
    const connector = tdsConnector(options);
    const connection = new Connection({
      server: options.host,
      options: {
        port: options.port,
        ...(connector === undefined ? {} : { connector }),
        ...(options.database === '' ? {} : { database: options.database }),
        encrypt: options.encrypt !== 'disable',
        trustServerCertificate: !options.verifyTls,
        connectTimeout: connectBudgetMs(options),
        requestTimeout: options.statementTimeoutMs,
        rowCollectionOnRequestCompletion: true,
        // A monitoring account should never be able to change anything, but a query that opened
        // a transaction and left it would hold locks until the connection closed.
        useColumnNames: false,
        appName: 'monitoring-system',
      },
      authentication: {
        type: 'default',
        options: { userName: options.username, password: options.password },
      },
    });

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        connection.close();
        reject(new DbError('the check was cancelled while connecting'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      connection.on('connect', (error?: Error) => {
        signal.removeEventListener('abort', onAbort);
        if (error) reject(describeDbError(error, options, 'Microsoft SQL Server'));
        else resolve();
      });
      // Swallowed rather than crashing the worker: `tedious` emits errors after a failed connect
      // too, and the `connect` callback above is the one that decides.
      connection.on('error', () => undefined);
      connection.connect();
    });

    const run = (sql: string, querySignal?: AbortSignal): Promise<DbResult> =>
      new Promise<DbResult>((resolve, reject) => {
        const columns: string[] = [];
        const rows: Record<string, unknown>[] = [];
        const request = new Request(sql, (error) => {
          if (error) {
            if (/timeout|canceled|cancelled/i.test(error.message)) {
              reject(
                new DbError(
                  `the query was still running after ${String(options.statementTimeoutMs)} ms ` +
                    'and was cancelled',
                ),
              );
              return;
            }
            reject(describeDbError(error, options, 'Microsoft SQL Server', 'query'));
            return;
          }
          resolve({ rows, columns });
        });
        // `tedious`'s own event typings only cover the stream events it inherits, so these two
        // are attached through the EventEmitter surface. The shapes are from its documented
        // `columnMetadata` and `row` events and are asserted by the tests against a real server.
        const events = request as unknown as {
          on(event: 'columnMetadata', handler: (metadata: { colName: string }[]) => void): void;
          on(
            event: 'row',
            handler: (row: { value: unknown; metadata: { colName: string } }[]) => void,
          ): void;
        };
        events.on('columnMetadata', (metadata) => {
          for (const column of metadata) columns.push(column.colName);
        });
        events.on('row', (row) => {
          const record: Record<string, unknown> = {};
          for (const cell of row) record[cell.metadata.colName] = cell.value;
          rows.push(record);
        });
        // `tedious` cancels at the protocol level — an attention packet — rather than by
        // dropping the socket, which is the closest a client can get to actually stopping work
        // on a server that has no statement timeout of its own.
        const onAbort = (): void => {
          connection.cancel();
        };
        querySignal?.addEventListener('abort', onAbort, { once: true });
        request.on('requestCompleted', () => {
          querySignal?.removeEventListener('abort', onAbort);
        });
        connection.execSql(request);
      });

    // Not the same thing as a statement timeout, and the one that matters: the usual reason a
    // monitoring query hangs on SQL Server is waiting behind somebody else's transaction.
    await run(`SET LOCK_TIMEOUT ${String(Math.round(options.statementTimeoutMs))}`).catch(
      () => undefined,
    );
    void TYPES;

    return {
      query(sql: string, querySignal: AbortSignal): Promise<DbResult> {
        return run(sql, querySignal);
      },
      close(): Promise<void> {
        connection.close();
        return Promise.resolve();
      },
    };
  },
};

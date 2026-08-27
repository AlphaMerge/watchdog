import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { runDbCheck } from '../src/types/db-shared.js';
import { mssqlDriver } from '../src/support/db/mssql.js';
import { mysqlDriver } from '../src/support/db/mysql.js';
import { postgresqlDriver } from '../src/support/db/postgresql.js';
import type { DbConnectOptions, DbDriver } from '../src/support/db/driver.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';

/**
 * The three drivers against three real servers.
 *
 * There is no simulating a database: what has to be right here is the driver's own handshake,
 * how each engine reports a wrong password, and — the part with real consequences — whether the
 * statement timeout is enforced by the *server* or by a client that hangs up and leaves the query
 * running. None of that can be faked, and all of it is what `db-shared.test.ts` deliberately does
 * not cover.
 *
 * Each engine skips itself when it is not there: PostgreSQL comes up with `npm run dev`, and
 * MariaDB and SQL Server are behind the `db` compose profile because SQL Server alone is 1.5 GB.
 */

interface Engine {
  readonly name: string;
  readonly driver: DbDriver;
  readonly options: Omit<
    DbConnectOptions,
    'connectTimeoutMs' | 'statementTimeoutMs' | 'encrypt' | 'verifyTls'
  >;
  /** A query that sleeps for longer than the statement timeout, in this engine's dialect. */
  readonly sleep: string;
  /** `select 1 as n` in this engine's dialect, which is the same everywhere but MSSQL is fussy. */
  readonly one: string;
  available: boolean;
}

const ENGINES: Engine[] = [
  {
    name: 'PostgreSQL',
    driver: postgresqlDriver,
    options: {
      host: process.env['MS_TEST_DB_HOST'] ?? '127.0.0.1',
      port: 5432,
      database: 'monitoring',
      username: 'monitoring',
      password: 'monitoring',
    },
    sleep: 'select pg_sleep(10)',
    one: 'select 1 as n',
    available: false,
  },
  {
    name: 'MySQL',
    driver: mysqlDriver,
    options: {
      host: process.env['MS_TEST_MYSQL_HOST'] ?? '127.0.0.1',
      port: 3306,
      database: 'monitoring',
      username: 'monitoring',
      password: 'monitoring',
    },
    sleep: 'select sleep(10)',
    one: 'select 1 as n',
    available: false,
  },
  {
    name: 'Microsoft SQL Server',
    driver: mssqlDriver,
    options: {
      host: process.env['MS_TEST_MSSQL_HOST'] ?? '127.0.0.1',
      port: 1433,
      database: 'master',
      username: 'sa',
      password: 'Monitoring-dev-1',
    },
    sleep: "waitfor delay '00:00:10'",
    one: 'select 1 as n',
    available: false,
  },
];

const settings = (
  over: Partial<DbConnectOptions> = {},
): Omit<DbConnectOptions, keyof Engine['options']> => ({
  encrypt: 'prefer',
  verifyTls: false,
  connectTimeoutMs: 8_000,
  statementTimeoutMs: 3_000,
  ...over,
});

before(async () => {
  for (const engine of ENGINES) {
    try {
      const connection = await engine.driver.connect(
        { ...engine.options, ...settings() },
        new AbortController().signal,
      );
      await connection.close();
      engine.available = true;
    } catch {
      engine.available = false;
    }
  }
});

function context(
  engine: Engine,
  params: Record<string, unknown>,
  credentials = {
    database: { username: engine.options.username, password: engine.options.password },
  },
): CheckContext {
  return {
    sensorId: 1,
    target: { host: engine.options.host, ipVersion: 'auto' },
    params: {
      port: engine.options.port,
      database: engine.options.database,
      encrypt: 'prefer',
      verifyTls: false,
      connectTimeoutMs: 8_000,
      statementTimeoutMs: 3_000,
      ...params,
    },
    credentials,
    signal: new AbortController().signal,
  };
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

for (const engine of ENGINES) {
  describe(engine.name, () => {
    it('connects, runs a query and reports the connect and query times apart', async (t) => {
      if (!engine.available) {
        t.skip(`${engine.name} is not running`);
        return;
      }
      const execution = await runDbCheck(engine.driver, context(engine, { query: engine.one }));
      assert.equal(valueOf(execution, 'value'), 1);
      assert.equal(valueOf(execution, 'rows'), 1);
      // Two numbers rather than one: an exhausted connection pool moves the first and leaves the
      // second exactly where it was, which is the only way to tell it from a slow query.
      assert.ok((valueOf(execution, 'connectTime') ?? -1) >= 0);
      assert.ok((valueOf(execution, 'queryTime') ?? -1) >= 0);
    });

    it('reads a count as a number, whatever the driver hands back', async (t) => {
      if (!engine.available) {
        t.skip(`${engine.name} is not running`);
        return;
      }
      // Every one of these returns `count(*)` as a string or a bigint rather than a number.
      const execution = await runDbCheck(
        engine.driver,
        context(engine, { query: 'select count(*) as n from (select 1 as a) t' }),
      );
      assert.equal(valueOf(execution, 'value'), 1);
    });

    it('stops a query that runs past the statement timeout', async (t) => {
      if (!engine.available) {
        t.skip(`${engine.name} is not running`);
        return;
      }
      // The one behaviour that cannot be faked and matters most: a check that gave up by closing
      // its socket would leave a ten-second query running on the server, once a minute, for ever.
      const started = Date.now();
      await assert.rejects(
        () => runDbCheck(engine.driver, context(engine, { query: engine.sleep })),
        /still running after 3000 ms|cancelled|timeout/i,
      );
      assert.ok(
        Date.now() - started < 9_000,
        `it waited ${String(Date.now() - started)} ms, so the timeout did not apply`,
      );
    });

    it('names a refused credential as a refused credential', async (t) => {
      if (!engine.available) {
        t.skip(`${engine.name} is not running`);
        return;
      }
      await assert.rejects(
        () =>
          runDbCheck(
            engine.driver,
            context(
              engine,
              { query: engine.one },
              {
                database: { username: engine.options.username, password: 'definitely-wrong' },
              },
            ),
          ),
        /refused the credential|password|login/i,
      );
    });

    it('says nothing is listening rather than reporting a timeout', async (t) => {
      if (!engine.available) {
        t.skip(`${engine.name} is not running`);
        return;
      }
      await assert.rejects(
        () => runDbCheck(engine.driver, context(engine, { query: engine.one, port: 1 })),
        /nothing is listening|connect/i,
      );
    });
  });
}

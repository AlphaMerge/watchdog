import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { standardCatalogue } from '../src/index.js';
import {
  DB_OWN_KEYS,
  dbChannels,
  numberFromCell,
  readDbMappings,
  rowsAccepted,
  runDbCheck,
} from '../src/types/db-shared.js';
import type { DbConnection, DbDriver, DbResult } from '../src/support/db/driver.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';

/**
 * The device is a name, and a name is resolved once and checked before the driver is asked
 * (`A-62`). Nothing resolves `.invalid`, so the check is handed a resolver, as a probe's
 * catalogue hands one in.
 */
const LOOPBACK = (): Promise<{ address: string; family: number }[]> =>
  Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

/**
 * Everything a database sensor does with an answer, without a database.
 *
 * The drivers have their own file and their own live servers. What is here is the half that
 * decides what becomes a channel, what becomes a gap and what becomes a failure — and that half
 * is identical for all three engines, so testing it once against a fake driver is testing it
 * three times.
 */

function driverReturning(result: DbResult, seen: { sql?: string } = {}): DbDriver {
  return {
    id: 'postgresql',
    name: 'PostgreSQL',
    defaultPort: 5432,
    connect(): Promise<DbConnection> {
      return Promise.resolve({
        query(sql: string): Promise<DbResult> {
          seen.sql = sql;
          return Promise.resolve(result);
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      });
    },
  };
}

const CREDENTIAL = { database: { username: 'monitor', password: 'secret' } };

function run(
  result: DbResult,
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return runDbCheck(driverReturning(result), {
    sensorId: 1,
    target: { host: 'db.example.invalid', ipVersion: 'auto', resolve: LOOPBACK },
    params: { query: 'select 1', ...params },
    credentials: CREDENTIAL,
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('numberFromCell', () => {
  it('reads the text every driver returns numeric and bigint as', () => {
    // pg, mysql2 and tedious all hand back `numeric`, `bigint` and `decimal` as strings rather
    // than lose precision. A sensor that only accepted `number` would gap every count(*).
    assert.equal(numberFromCell('42'), 42);
    assert.equal(numberFromCell('3.5'), 3.5);
    assert.equal(numberFromCell(7n), 7);
    assert.equal(numberFromCell(true), 1);
    assert.equal(numberFromCell(false), 0);
  });

  it('gaps rather than zeroing anything that is not a number', () => {
    // No-data is not zero, which is the rule the whole system is built on.
    assert.equal(numberFromCell(null), null);
    assert.equal(numberFromCell(undefined), null);
    assert.equal(numberFromCell('healthy'), null);
    assert.equal(numberFromCell(''), null);
    assert.equal(numberFromCell('   '), null);
    assert.equal(numberFromCell(Number.NaN), null);
  });

  it('reads a timestamp as milliseconds, so "oldest unprocessed row" is a channel', () => {
    assert.equal(numberFromCell(new Date('2026-08-27T00:00:00Z')), 1787788800000);
  });
});

describe('rowsAccepted', () => {
  it('accepts anything when nothing was asked for', () => {
    assert.ok(rowsAccepted(0, ''));
    assert.ok(rowsAccepted(9_000, ''));
  });

  it('reads an exact count, a floor and a range', () => {
    assert.ok(rowsAccepted(1, '1'));
    assert.ok(!rowsAccepted(2, '1'));
    assert.ok(rowsAccepted(4, '1+'));
    assert.ok(!rowsAccepted(0, '1+'));
    assert.ok(rowsAccepted(5, '1-10'));
    assert.ok(!rowsAccepted(11, '1-10'));
    assert.ok(rowsAccepted(0, '0'), 'a query that must return nothing is a real check');
  });
});

describe('readDbMappings', () => {
  it('drops a duplicate key rather than declaring the channel twice', () => {
    const mappings = readDbMappings({
      extract: [
        { key: 'a', column: 'x' },
        { key: 'a', column: 'y' },
      ],
    });
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.column, 'x');
  });

  it('names a channel after its key when it was given no name', () => {
    assert.equal(readDbMappings({ extract: [{ key: 'lag' }] })[0]?.name, 'lag');
  });

  it('refuses a scale of zero, which would report every reading as none', () => {
    assert.equal(readDbMappings({ extract: [{ key: 'a', scale: 0 }] })[0]?.scale, 1);
  });
});

describe('a database check', () => {
  const ONE_ROW: DbResult = { rows: [{ count: '12' }], columns: ['count'] };

  it('makes the first cell the channel the sensor is judged by', async () => {
    const execution = await run(ONE_ROW, {});
    assert.equal(valueOf(execution, 'value'), 12);
    assert.equal(valueOf(execution, 'rows'), 1);
    assert.ok((valueOf(execution, 'queryTime') ?? -1) >= 0);
    assert.ok((valueOf(execution, 'connectTime') ?? -1) >= 0);
    assert.match(execution.message ?? '', /1 row in [\d.]+ ms; value=12/);
  });

  it('reads more columns of one query rather than opening five connections', async () => {
    const execution = await run(
      {
        rows: [{ waiting: 3, oldest_seconds: '95.5', workers: 4 }],
        columns: ['waiting', 'oldest_seconds', 'workers'],
      },
      {
        extract: [
          { key: 'oldest', name: 'Oldest job', unit: 's', column: 'oldest_seconds' },
          { key: 'workers', column: 'workers' },
        ],
      },
    );
    assert.equal(valueOf(execution, 'value'), 3);
    assert.equal(valueOf(execution, 'oldest'), 95.5);
    assert.equal(valueOf(execution, 'workers'), 4);
  });

  it('scales a column the database reports in the wrong unit', async () => {
    const execution = await run(
      { rows: [{ bytes: 5_242_880 }], columns: ['bytes'] },
      { extract: [{ key: 'mb', column: 'bytes', scale: 0.000001 }] },
    );
    assert.equal(valueOf(execution, 'mb'), 5.24288);
  });

  it('reaches a later row when told to', async () => {
    const execution = await run(
      { rows: [{ n: 1 }, { n: 2 }, { n: 3 }], columns: ['n'] },
      { extract: [{ key: 'third', column: 'n', row: 2 }] },
    );
    assert.equal(valueOf(execution, 'third'), 3);
  });

  it('gaps a cell that is not a number, and says which', async () => {
    const execution = await run(
      { rows: [{ n: 4, state: 'streaming' }], columns: ['n', 'state'] },
      { extract: [{ key: 'state', column: 'state' }] },
    );
    assert.equal(valueOf(execution, 'n'), undefined);
    assert.equal(valueOf(execution, 'state'), undefined);
    assert.equal(valueOf(execution, 'value'), 4);
    assert.match(execution.message ?? '', /state was not a number/);
  });

  it('reports no rows as a gap on the value, not as zero', async () => {
    // A query that returned nothing has no value to report. Zero would be a reading.
    const execution = await run({ rows: [], columns: ['count'] }, {});
    assert.equal(valueOf(execution, 'value'), undefined);
    assert.equal(valueOf(execution, 'rows'), 0);
  });

  it('fails when the row count is not what it was told to expect', async () => {
    // A query that quietly started returning nothing looks perfectly healthy by response time.
    await assert.rejects(
      () => run({ rows: [], columns: ['count'] }, { expectRows: '1+' }),
      /returned 0 rows and this sensor expects 1\+/,
    );
    await assert.rejects(
      () => run({ rows: [{ a: 1 }, { a: 2 }], columns: ['a'] }, { expectRows: '1' }),
      /returned 2 rows and this sensor expects 1/,
    );
  });

  it('accepts a row count inside the range it was given', async () => {
    const execution = await run(
      { rows: [{ a: 1 }, { a: 2 }], columns: ['a'] },
      { expectRows: '1-5' },
    );
    assert.equal(valueOf(execution, 'rows'), 2);
  });

  it('names the missing credential rather than failing to authenticate later', async () => {
    await assert.rejects(
      () => run(ONE_ROW, {}, { credentials: {} }),
      /no database credential is configured on this device or anything above it/,
    );
  });

  it('refuses an empty query before connecting to anything', async () => {
    await assert.rejects(() => run(ONE_ROW, { query: '   ' }), /has no query to run/);
  });

  it('closes the connection even when the query failed', async () => {
    // A monitoring system that leaked a connection per failed scan would exhaust the server's
    // slots exactly when the database is already in trouble.
    let closed = false;
    const driver: DbDriver = {
      id: 'mysql',
      name: 'MySQL',
      defaultPort: 3306,
      connect: () =>
        Promise.resolve({
          query: () => Promise.reject(new Error('boom')),
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        }),
    };
    await assert.rejects(() =>
      runDbCheck(driver, {
        sensorId: 1,
        target: { host: 'db.example.invalid', ipVersion: 'auto', resolve: LOOPBACK },
        params: { query: 'select 1' },
        credentials: CREDENTIAL,
        signal: new AbortController().signal,
      }),
    );
    assert.ok(closed, 'the connection was left open after a failed query');
  });

  it('sends the query exactly as written', async () => {
    const seen: { sql?: string } = {};
    await runDbCheck(driverReturning({ rows: [{ a: 1 }], columns: ['a'] }, seen), {
      sensorId: 1,
      target: { host: 'db.example.invalid', ipVersion: 'auto', resolve: LOOPBACK },
      params: { query: '  select pg_is_in_recovery()  ' },
      credentials: CREDENTIAL,
      signal: new AbortController().signal,
    });
    assert.equal(seen.sql, 'select pg_is_in_recovery()');
  });
});

describe('an extract key (P-348)', () => {
  const ENGINES = ['db.postgresql', 'db.mysql', 'db.mssql'] as const;
  const catalogue = standardCatalogue();
  const withKey = (key: string): Record<string, unknown> => ({
    query: 'select 1, 2',
    extract: [{ key }],
  });

  it('names exactly the keys the sensor reports of its own', () => {
    const own = dbChannels({}).map((channel) => channel.key);
    assert.deepEqual([...own].sort(), [...DB_OWN_KEYS].sort());
  });

  for (const engine of ENGINES) {
    for (const key of DB_OWN_KEYS) {
      it(`${engine} refuses "${key}", one of the sensor's own channels`, () => {
        const outcome = catalogue.validate(engine, withKey(key));
        assert.ok(!outcome.valid, key);
        assert.deepEqual(
          outcome.problems.map((problem) => problem.path),
          ['/extract/0/key'],
        );
      });
    }

    it(`${engine} still takes a key that only resembles one`, () => {
      for (const key of ['lag', 'values', 'Value', 'rows2', 'queryTime.p95', 'my_value']) {
        const outcome = catalogue.validate(engine, withKey(key));
        assert.ok(outcome.valid, key);
        const declared = dbChannels(outcome.params).filter((channel) => channel.key === key);
        assert.equal(declared.length, 1, key);
      }
    });
  }
});

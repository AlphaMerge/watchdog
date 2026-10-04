import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import { Database, DatabaseError, SQLSTATE, type Queryable } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

interface Settings {
  readonly statement: string;
  readonly lock: string;
  readonly idle: string;
  readonly app: string;
}

/** The three limits as one session sees them, and what it is called. */
async function settingsOf(q: Queryable): Promise<Settings> {
  const rows = await q.query<{ statement: string; lock: string; idle: string; app: string }>(
    `SELECT current_setting('statement_timeout') AS statement,
            current_setting('lock_timeout') AS lock,
            current_setting('idle_in_transaction_session_timeout') AS idle,
            current_setting('application_name') AS app`,
  );
  const row = rows[0];
  assert.ok(row !== undefined);
  return { statement: row.statement, lock: row.lock, idle: row.idle, app: row.app };
}

/**
 * `P-229`: the pool's limits, set where they cannot be missed and taken off where they must not
 * reach. `pool-starvation.test.ts` is the acceptance test; this is everything around it.
 */
describe('P-229: the database pool’s limits', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  /** One session, so "the next caller" is always the same connection. */
  let db: Database;

  before(async () => {
    scratch = await createScratchDatabase('dblimits');
    db = new Database({
      config: {
        ...testDatabaseConfig(),
        poolSize: 1,
        statementTimeoutMs: 60_000,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 60_000,
      },
      logger: silentLogger,
      databaseOverride: scratch.name,
    });
    await scratch.db.query('CREATE TABLE hot (id int PRIMARY KEY, n int NOT NULL)');
    await scratch.db.query('INSERT INTO hot VALUES (1, 0)');
  });

  after(async () => {
    await db.close();
    await scratch.drop();
  });

  it('sets all three on every session from the moment it connects, and names it ms-core', async () => {
    assert.deepEqual(await settingsOf(db), {
      statement: '1min',
      lock: '5s',
      idle: '1min',
      app: 'ms-core',
    });
  });

  it('leaves a test’s own pool unlimited, so a perf harness is not cut by the core’s minute', async () => {
    // Every `Database` sets the three at connect now, a test's as well as the core's. The perf
    // harnesses build 5,000 objects in one request and fill a database for an hour, so the pool
    // they get from `testDatabaseConfig()` must carry none.
    assert.deepEqual(await settingsOf(scratch.db), {
      statement: '0',
      lock: '0',
      idle: '0',
      app: 'ms-core',
    });
  });

  it('gives one transaction its own limits and name, and the next caller the pool’s', async () => {
    const inside = await db.tx((q) => settingsOf(q), {
      statementTimeoutMs: 600_000,
      lockTimeoutMs: 2_000,
      work: 'housekeeping',
    });
    assert.deepEqual(inside, {
      statement: '10min',
      lock: '2s',
      idle: '1min',
      app: 'ms-core:housekeeping',
    });
    // The same connection (the pool has one), after the transaction: nothing was left behind.
    assert.deepEqual(await settingsOf(db), {
      statement: '1min',
      lock: '5s',
      idle: '1min',
      app: 'ms-core',
    });
    // And after one that failed, which is when a `RESET` would have been skipped.
    await assert.rejects(
      db.tx(
        async (q) => {
          await q.query('SELECT 1/0');
        },
        { statementTimeoutMs: 1_000, work: 'failing' },
      ),
    );
    assert.equal((await settingsOf(db)).statement, '1min');
    assert.equal((await settingsOf(db)).app, 'ms-core');
  });

  it('cancels a statement past its limit as 57014, and counts it once however it is reached', async () => {
    const before = db.timeouts().statements;
    const direct = await db
      .query('SELECT pg_sleep(2)')
      .then(() => null)
      .catch((error: unknown) => error);
    assert.equal(direct, null, 'two seconds is inside the pool’s minute');

    const inTx = await db
      .tx(
        async (q) => {
          await q.query('SELECT pg_sleep(2)');
        },
        { statementTimeoutMs: 300 },
      )
      .catch((error: unknown) => error);
    assert.ok(inTx instanceof DatabaseError);
    assert.equal(inTx.sqlstate, SQLSTATE.queryCanceled);
    // Seen by the statement and again by its transaction: one count.
    assert.equal(db.timeouts().statements, before + 1);

    // A caller that counts its own (the late-refusal record's write, `A-68`) is not counted here.
    const owned = await db
      .tx(
        async (q) => {
          await q.query('SELECT pg_sleep(2)');
        },
        { statementTimeoutMs: 300, ownStatementTimeouts: true },
      )
      .catch((error: unknown) => error);
    assert.ok(owned instanceof DatabaseError);
    assert.equal(owned.sqlstate, SQLSTATE.queryCanceled);
    assert.equal(db.timeouts().statements, before + 1, 'the caller counts that one');
  });

  it('counts a lock not granted, but not one a caller said it counts itself', async () => {
    const holder = new Client({ ...testDatabaseConfig(), database: scratch.name });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE hot SET n = n + 1 WHERE id = 1');
      const before = db.timeouts().locks;
      const update = (q: Queryable): Promise<unknown> =>
        q.query('UPDATE hot SET n = n + 1 WHERE id = 1');

      // Each bounded: without the limit the wait is as long as the holder's, which is for ever.
      const counted = await within(
        3_000,
        'the update to give up on the held row',
        db.tx(update, { lockTimeoutMs: 200 }).catch((error: unknown) => error),
      );
      assert.ok(counted instanceof DatabaseError);
      assert.equal(counted.sqlstate, SQLSTATE.lockNotAvailable);
      assert.equal(db.timeouts().locks, before + 1);

      const owned = await within(
        3_000,
        'the update to give up on the held row',
        db
          .tx(update, { lockTimeoutMs: 200, ownLockTimeouts: true })
          .catch((error: unknown) => error),
      );
      assert.ok(owned instanceof DatabaseError);
      assert.equal(owned.sqlstate, SQLSTATE.lockNotAvailable);
      assert.equal(db.timeouts().locks, before + 1, 'the caller counts that one');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });

  it('builds a pool of its own for other work, named for it, with the limits it was given', async () => {
    const reports = db.withLimits({ statementTimeoutMs: 600_000, poolSize: 1, work: 'reports' });
    try {
      assert.deepEqual(await settingsOf(reports), {
        statement: '10min',
        lock: '5s',
        idle: '1min',
        app: 'ms-core:reports',
      });
      const migrate = db.withLimits({
        statementTimeoutMs: 0,
        lockTimeoutMs: 0,
        idleInTransactionTimeoutMs: 0,
        poolSize: 1,
        work: 'migrate',
      });
      try {
        assert.deepEqual(await settingsOf(migrate), {
          statement: '0',
          lock: '0',
          idle: '0',
          app: 'ms-core:migrate',
        });
      } finally {
        await migrate.close();
      }
    } finally {
      await reports.close();
    }
    // The core pool is untouched by either.
    assert.equal((await settingsOf(db)).app, 'ms-core');
  });

  describe('a session PostgreSQL ends while the core holds it (25P03)', () => {
    /** A pool of one whose transactions may sit idle for 300 ms. */
    let impatient: Database;

    before(() => {
      impatient = new Database({
        config: { ...testDatabaseConfig(), poolSize: 1, idleInTransactionTimeoutMs: 300 },
        logger: silentLogger,
        databaseOverride: scratch.name,
      });
    });

    after(async () => {
      await impatient.close();
    });

    async function pid(q: Queryable): Promise<number> {
      const rows = await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return rows[0]?.pid ?? 0;
    }

    it('fails the transaction that was using it, discards it, and keeps the process', async () => {
      // node:test fails a test on an uncaught exception, which is what the `error` a checked-out
      // client emits with nobody listening becomes. So the process surviving is asserted by this
      // test finishing at all, and the listener is checked directly below as well.
      let first = 0;
      const outcome = await impatient
        .tx(async (q) => {
          first = await pid(q);
          // Idle in the transaction, holding the client, past the limit.
          await sleep(1_000);
          await q.query('SELECT 1');
        })
        .catch((error: unknown) => error);
      assert.ok(outcome instanceof Error, 'the statement after the timeout failed');
      assert.ok(first > 0);

      // The only connection the pool had is gone; the next checkout is a new one, and it works.
      const next = await pid(impatient);
      assert.ok(
        next > 0 && next !== first,
        `the next session is ${String(next)}, not ${String(first)}`,
      );
    });

    it('survives a session ended under a client that is checked out and not in a transaction', async () => {
      const killer = new Client({ ...testDatabaseConfig(), database: scratch.name });
      await killer.connect();
      try {
        let first = 0;
        const outcome = await impatient
          .withClient(async (client) => {
            first =
              (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
                ?.pid ?? 0;
            await killer.query('SELECT pg_terminate_backend($1)', [first]);
            // Give the socket time to close and the client to emit its `error`.
            await sleep(300);
            await client.query('SELECT 1');
          })
          .catch((error: unknown) => error);
        assert.ok(outcome instanceof Error, 'the ended session could not be used');
        const next = await pid(impatient);
        assert.ok(next > 0 && next !== first);
      } finally {
        await killer.end();
      }
    });
  });
});

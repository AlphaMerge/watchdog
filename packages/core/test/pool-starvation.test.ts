import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { Client } from 'pg';
import { Database, DatabaseError, SQLSTATE } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/**
 * `P-229`'s acceptance test: one lock held outside the core, and a pool of five.
 *
 * The holder is a session the core does not own, an operator's `psql` left in a transaction,
 * holding one row the core writes. Five writes of that row take the whole pool and wait. What
 * the test asks is whether a read of a table nobody has locked still gets a connection.
 *
 * **Both halves, so the second is not vacuous.** With the limits off, as every core ran before
 * this ticket, the read waits `connectTimeoutMs` for a connection and fails, and the five wait
 * for as long as the lock is held. With `lockTimeoutMs` set, each write gives up with 55P03, its
 * connection goes back to the pool, and the read answers.
 */
describe('P-229: a lock held outside the core', { skip: available ? false : 'no database' }, () => {
  /** Five writes of the held row, and what became of each. */
  async function starve(
    scratch: ScratchDatabase,
    db: Database,
  ): Promise<{ holder: Client; outcomes: Promise<string>[] }> {
    const holder = new Client({ ...testDatabaseConfig(), database: scratch.name });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('UPDATE hot SET n = n + 1 WHERE id = 1');
    const outcomes: Promise<string>[] = [];
    // What ingestion does to a sensor's runtime row: the same update, five times over.
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(
        db.query('UPDATE hot SET n = n + 1 WHERE id = 1').then(
          () => 'done',
          (error: unknown) =>
            error instanceof DatabaseError ? `failed ${error.sqlstate ?? '?'}` : 'failed',
        ),
      );
    }
    return { holder, outcomes };
  }

  /** A read of a table nobody has locked, and how long it waited. */
  async function unrelatedRead(db: Database): Promise<{ answer: string; waitedMs: number }> {
    const started = process.hrtime.bigint();
    const answer = await db.query('SELECT count(*) FROM cold').then(
      () => 'answered',
      (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { answer, waitedMs: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  async function scratchWithTables(): Promise<ScratchDatabase> {
    const scratch = await createScratchDatabase('poolstarve');
    await scratch.db.query('CREATE TABLE hot (id int PRIMARY KEY, n int NOT NULL)');
    await scratch.db.query('CREATE TABLE cold (id int PRIMARY KEY)');
    await scratch.db.query('INSERT INTO hot VALUES (1, 0)');
    return scratch;
  }

  it('with no limits, as before: five waiting writes starve a read of nothing they touch', async () => {
    const scratch = await scratchWithTables();
    const config = testDatabaseConfig();
    const { holder, outcomes } = await starve(scratch, scratch.db);
    try {
      await sleep(500);
      assert.deepEqual(scratch.db.stats(), { total: 5, idle: 0, waiting: 0 }, 'all five taken');
      const waiting = await holder.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = 'ms-core'
           AND wait_event_type = 'Lock'`,
      );
      assert.equal(waiting.rows[0]?.n, 5, 'each is a session waiting on the lock');

      const read = await unrelatedRead(scratch.db);
      assert.match(read.answer, /^failed/, 'the read could not get a connection');
      assert.ok(
        read.waitedMs >= config.connectTimeoutMs - 50,
        `gave up after ${read.waitedMs.toFixed(0)} ms`,
      );
      const still = await Promise.race([
        Promise.all(outcomes).then(() => 'finished'),
        sleep(100).then(() => 'still waiting'),
      ]);
      assert.equal(still, 'still waiting', 'nothing on the server ends the wait');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await Promise.all(outcomes);
      await scratch.drop();
    }
  });

  it('with a lock limit: each write gives up, its connection returns, and the read answers', async () => {
    const scratch = await scratchWithTables();
    const limited = new Database({
      config: { ...testDatabaseConfig(), lockTimeoutMs: 500 },
      logger: silentLogger,
      databaseOverride: scratch.name,
    });
    const { holder, outcomes } = await starve(scratch, limited);
    try {
      // Bounded, so a pool without the limit fails here instead of holding the file open.
      const settled = await within(5_000, 'the five writes to give up', Promise.all(outcomes));
      assert.deepEqual(settled, Array(5).fill(`failed ${SQLSTATE.lockNotAvailable}`));
      assert.deepEqual(limited.timeouts(), { statements: 0, locks: 5 }, 'each counted once');

      // The holder has not let go: the connections came back because the writes gave up.
      const read = await unrelatedRead(limited);
      assert.equal(read.answer, 'answered');
      assert.ok(read.waitedMs < 1_000, `the read waited ${read.waitedMs.toFixed(0)} ms`);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await limited.close();
      await scratch.drop();
    }
  });
});

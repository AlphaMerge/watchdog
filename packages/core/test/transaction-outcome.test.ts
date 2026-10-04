import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import { DatabaseError, SQLSTATE, savepoint, type Queryable } from '../src/db/pool.js';
import type { Actor, AuditSink, Mutation } from '../src/objects/audit.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** What `Database` throws for a COMMIT that PostgreSQL answered with ROLLBACK. */
function rolledBack(error: unknown): boolean {
  return (
    error instanceof DatabaseError &&
    error.sqlstate === SQLSTATE.inFailedTransaction &&
    error.context['phase'] === 'commit' &&
    error.context['commandTag'] === 'ROLLBACK'
  );
}

/**
 * `P-249`: a transaction an error aborted is not answered as committed.
 *
 * PostgreSQL rolls back a transaction a failed statement aborted, and says so only in the
 * command tag of the `COMMIT`, which otherwise succeeds. `Database` never read it, so a failure
 * caught inside a transaction — by an audit sink, say — answered success for writes that were
 * gone, and the after-commit hooks announced them. These run against PostgreSQL, because the
 * whole defect is in what PostgreSQL answers.
 */
describe(
  'P-249: a transaction that did not commit',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;

    before(async () => {
      scratch = await createScratchDatabase('txoutcome');
      await scratch.db.query('CREATE TABLE kept (id int PRIMARY KEY, what text NOT NULL)');
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await scratch.db.query('DELETE FROM kept');
    });

    const kept = async (): Promise<string[]> =>
      (await scratch.db.query<{ what: string }>('SELECT what FROM kept ORDER BY id')).map(
        (row) => row.what,
      );

    it('throws from tx, keeps nothing, and runs no after-commit hook', async () => {
      const ran: string[] = [];
      let caught: unknown;
      await assert.rejects(
        () =>
          scratch.db.tx(async (q) => {
            q.afterCommit?.(() => ran.push('hook'));
            await q.query(`INSERT INTO kept VALUES (1, 'the caller''s write')`);
            try {
              await q.query('SELECT 1/0');
            } catch (error) {
              caught = error;
            }
            return 'answered';
          }),
        (error: unknown) => {
          assert.ok(rolledBack(error), String(error));
          assert.ok(error instanceof DatabaseError);
          // Named, so the log line says what aborted it rather than only that something did.
          assert.equal(error.context['abortedBySqlstate'], '22012');
          return true;
        },
      );
      assert.ok(caught instanceof DatabaseError, 'the failure was caught inside');
      assert.deepEqual(await kept(), [], 'and PostgreSQL kept nothing');
      assert.deepEqual(ran, [], 'and nothing announced a commit that did not happen');
    });

    it('throws from transaction() as well, which hands out a raw client', async () => {
      await assert.rejects(
        () =>
          scratch.db.transaction(async (client) => {
            await client.query(`INSERT INTO kept VALUES (1, 'raw')`);
            await client.query('SELECT 1/0').catch(() => undefined);
            return 'answered';
          }),
        rolledBack,
      );
      assert.deepEqual(await kept(), []);
    });

    it('still answers a transaction that committed, and runs its hooks after it', async () => {
      const ran: string[] = [];
      const answer = await scratch.db.tx(async (q) => {
        q.afterCommit?.(() => ran.push('hook'));
        await q.query(`INSERT INTO kept VALUES (1, 'fine')`);
        assert.deepEqual(ran, [], 'not before the commit');
        return 'answered';
      });
      assert.equal(answer, 'answered');
      assert.deepEqual(ran, ['hook']);
      assert.deepEqual(await kept(), ['fine']);
    });

    it('commits around a savepoint whose failure was caught, and drops what it asked for', async () => {
      const ran: string[] = [];
      const answer = await scratch.db.tx(async (q) => {
        await q.query(`INSERT INTO kept VALUES (1, 'before')`);
        await assert.rejects(() =>
          savepoint(q, async (inner) => {
            inner.afterCommit?.(() => ran.push('rolled back'));
            await inner.query(`INSERT INTO kept VALUES (2, 'inside')`);
            await inner.query('SELECT 1/0');
          }),
        );
        await savepoint(q, async (inner) => {
          inner.afterCommit?.(() => ran.push('released'));
          await inner.query(`INSERT INTO kept VALUES (3, 'released')`);
        });
        assert.deepEqual(ran, [], 'a released savepoint is not a commit either');
        await q.query(`INSERT INTO kept VALUES (4, 'after')`);
        return 'answered';
      });
      assert.equal(answer, 'answered');
      assert.deepEqual(await kept(), ['before', 'released', 'after']);
      assert.deepEqual(ran, ['released'], 'only what was kept is announced');
    });

    it('rolls back a savepoint whose own work caught a failure, and says so', async () => {
      // `fn` returned, but a statement in it failed: its work is gone, and answering what it
      // returned would be answering for it.
      await scratch.db.tx(async (q) => {
        await q.query(`INSERT INTO kept VALUES (1, 'before')`);
        await assert.rejects(
          () =>
            savepoint(q, async (inner) => {
              await inner.query(`INSERT INTO kept VALUES (2, 'inside')`);
              await inner.query('SELECT 1/0').catch(() => undefined);
              return 'answered';
            }),
          (error: unknown) =>
            error instanceof DatabaseError &&
            error.sqlstate === SQLSTATE.inFailedTransaction &&
            error.context['phase'] === 'savepoint',
        );
        await q.query(`INSERT INTO kept VALUES (3, 'after')`);
      });
      assert.deepEqual(await kept(), ['before', 'after']);
    });

    it('nests: an inner savepoint rolled back leaves the outer one to be released', async () => {
      const ran: string[] = [];
      await scratch.db.tx(async (q) => {
        await savepoint(q, async (outer) => {
          outer.afterCommit?.(() => ran.push('outer'));
          await outer.query(`INSERT INTO kept VALUES (1, 'outer')`);
          await savepoint(outer, async (inner) => {
            inner.afterCommit?.(() => ran.push('inner'));
            await inner.query(`INSERT INTO kept VALUES (2, 'inner')`);
            await inner.query('SELECT 1/0');
          }).catch(() => undefined);
          await outer.query(`INSERT INTO kept VALUES (3, 'outer again')`);
        });
      });
      assert.deepEqual(await kept(), ['outer', 'outer again']);
      assert.deepEqual(ran, ['outer']);
    });

    it('names what aborted the transaction, not a failure a savepoint already undid', async () => {
      await assert.rejects(
        () =>
          scratch.db.tx(async (q) => {
            await savepoint(q, (inner) => inner.query('SELECT 1/0')).catch(() => undefined);
            await q.query(`INSERT INTO kept VALUES (1, 'one')`);
            await q.query(`INSERT INTO kept VALUES (1, 'one again')`).catch(() => undefined);
          }),
        (error: unknown) => {
          assert.ok(rolledBack(error));
          assert.ok(error instanceof DatabaseError);
          assert.equal(error.context['abortedBySqlstate'], '23505', 'the duplicate, not the 1/0');
          return true;
        },
      );
      assert.deepEqual(await kept(), []);
    });

    it('runs straight on the pool, where a failed statement aborts nothing else', async () => {
      // No transaction to save in: a `SAVEPOINT` outside one is itself an error.
      await scratch.db.query(`INSERT INTO kept VALUES (1, 'pool')`);
      await assert.rejects(() => savepoint(scratch.db, (q) => q.query('SELECT 1/0')));
      assert.equal(
        await savepoint(
          scratch.db,
          async (q) => (await q.query<{ n: number }>('SELECT 2 AS n'))[0]?.n,
        ),
        2,
      );
      assert.deepEqual(await kept(), ['pool']);
    });
  },
);

/**
 * The sinks as production composes them, reduced to two: an audit row written through the
 * mutation's transaction, then a sink that fails a statement and catches it, in that transaction
 * or around a savepoint. Last, as `ReachabilitySync` is nearly last, so that nothing after it
 * queries and the failure reaches the COMMIT unnoticed: the case `P-249` measured.
 */
class CatchingSink implements AuditSink {
  inSavepoint = false;
  caught = 0;

  async record(
    q: Queryable,
    _actor: Actor,
    mutations: readonly Mutation[],
    _at: Date,
  ): Promise<void> {
    for (const mutation of mutations) {
      await q.query('INSERT INTO audit_probe (action, object_id) VALUES ($1, $2)', [
        mutation.action,
        mutation.objectId,
      ]);
    }
    const fail = (on: Queryable): Promise<unknown> => on.query('SELECT 1/0');
    try {
      await (this.inSavepoint ? savepoint(q, fail) : fail(q));
    } catch {
      this.caught += 1;
    }
  }
}

describe(
  'P-249: a sink that catches inside the mutation, through the API',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let app: FastifyInstance;
    const sink = new CatchingSink();

    before(async () => {
      scratch = await createScratchDatabase('txoutcome_api');
      h = await buildHarness(scratch.db);
      await scratch.db.query(`
        CREATE TABLE audit_probe (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          action text NOT NULL,
          object_id bigint NOT NULL
        )
      `);
      h.audit.also = sink;
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: false,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db: scratch.db, logger: silent }),
        db: scratch.db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    const named = async (name: string): Promise<number> =>
      Number(
        (
          await scratch.db.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM object WHERE name = $1',
            [name],
          )
        )[0]?.n,
      );

    const create = (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/objects',
        payload: { kind: 'probe', parentId: h.rootId, name },
      });

    it('answers an error, not success, when the sink caught without a savepoint', async () => {
      sink.inSavepoint = false;
      const caughtBefore = sink.caught;
      const auditBefore = (await scratch.db.query('SELECT 1 FROM audit_probe')).length;

      const answer = await create('lost without a savepoint');

      assert.equal(sink.caught, caughtBefore + 1, 'the sink did catch its failure');
      assert.equal(answer.statusCode, 500, answer.body);
      assert.equal(answer.json<{ error: { code: string } }>().error.code, 'DATABASE_ERROR');
      assert.equal(await named('lost without a savepoint'), 0, 'nothing was created');
      assert.equal(
        (await scratch.db.query('SELECT 1 FROM audit_probe')).length,
        auditBefore,
        'and no audit row survived',
      );
    });

    it('commits the mutation when the sink caught around a savepoint', async () => {
      sink.inSavepoint = true;
      const caughtBefore = sink.caught;

      const answer = await create('kept with a savepoint');

      assert.equal(sink.caught, caughtBefore + 1, 'the sink did catch its failure');
      assert.equal(answer.statusCode, 201, answer.body);
      assert.equal(await named('kept with a savepoint'), 1);
      const id = answer.json<{ id: number }>().id;
      assert.equal(
        (await scratch.db.query('SELECT 1 FROM audit_probe WHERE object_id = $1', [id])).length,
        1,
        'with its audit row',
      );
    });
  },
);

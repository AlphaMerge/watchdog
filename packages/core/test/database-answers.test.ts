import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Client } from 'pg';
import { pino } from 'pino';
import { logIfUnexpected, toHttpError } from '../src/api/errors.js';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import { Database, DatabaseError, SQLSTATE } from '../src/db/pool.js';
import { ObjectError } from '../src/objects/errors.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** A failure as `Database` builds one around what `pg` threw. */
function failed(sqlstate: string, message: string): DatabaseError {
  return new DatabaseError('query failed', {
    context: { statement: 'UPDATE object SET name = $1 WHERE id = $2' },
    cause: Object.assign(new Error(message), { code: sqlstate }),
  });
}

/**
 * `P-229`: what a caller is told when the database gave up on its request.
 *
 * Two answers that look alike and must not be treated alike. A lock not granted in time is 503
 * with `Retry-After`: the request was fine, and the same one succeeds once whatever held the
 * lock lets go. A statement cancelled is 503 without it: the same query takes as long again, so
 * a client that retried by itself would only queue more of the same work.
 */
describe('P-229: a database that gave up, answered', () => {
  it('answers a lock not granted as 503 with Retry-After, and names nothing of the holder', () => {
    const answer = toHttpError(
      failed(SQLSTATE.lockNotAvailable, 'canceling statement due to lock timeout'),
      'req-1',
    );
    assert.equal(answer.status, 503);
    assert.equal(answer.body.error.code, 'DATABASE_LOCK_TIMEOUT');
    assert.deepEqual(answer.headers, { 'retry-after': '5' });
    assert.doesNotMatch(JSON.stringify(answer.body), /UPDATE|lock timeout|object/);
  });

  it('answers a cancelled statement as 503 without Retry-After, naming the setting', () => {
    for (const reason of [
      'canceling statement due to statement timeout',
      'canceling statement due to user request',
    ]) {
      const answer = toHttpError(failed(SQLSTATE.queryCanceled, reason), 'req-2');
      assert.equal(answer.status, 503);
      assert.equal(answer.body.error.code, 'DATABASE_STATEMENT_TIMEOUT');
      assert.equal(answer.headers, undefined, 'the same query would take as long again');
      assert.match(answer.body.error.message, /database\.statementTimeoutMs/);
    }
  });

  it('answers a tree that stayed busy as 503, with the tree’s longer Retry-After', () => {
    const answer = toHttpError(
      new ObjectError('OBJECT_TREE_BUSY', 'another change to the object tree has held it', {
        context: { phase: 'tree-lock' },
        cause: failed(SQLSTATE.lockNotAvailable, 'canceling statement due to lock timeout'),
      }),
    );
    assert.equal(answer.status, 503);
    assert.equal(answer.body.error.code, 'OBJECT_TREE_BUSY');
    assert.deepEqual(answer.headers, { 'retry-after': '30' });
  });

  it('still masks any other database failure as a 500 with no headers', () => {
    const answer = toHttpError(failed('53300', 'sorry, too many clients already'));
    assert.equal(answer.status, 500);
    assert.equal(answer.headers, undefined);
  });

  it('logs each with the server’s own reason, at warn, since the limits exist to cause them', () => {
    const lines: { level: number; msg: string; err?: { message?: string } }[] = [];
    const logger = pino(
      { level: 'debug' },
      { write: (line: string) => lines.push(JSON.parse(line) as (typeof lines)[number]) },
    );
    logIfUnexpected(
      logger,
      failed(SQLSTATE.queryCanceled, 'canceling statement due to user request'),
      503,
    );
    logIfUnexpected(logger, failed('53300', 'sorry, too many clients already'), 500);
    const [warned, errored] = lines;
    assert.ok(warned !== undefined && errored !== undefined, `${String(lines.length)} lines`);
    assert.equal(warned.level, 40, 'warn');
    assert.match(warned.err?.message ?? '', /due to user request/, 'which cancel it was');
    assert.equal(errored.level, 50, 'anything else is still an error');
  });
});

describe(
  'P-229: a request blocked by a lock held outside the core',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;

    before(async () => {
      scratch = await createScratchDatabase('dbanswers');
      db = new Database({
        config: { ...testDatabaseConfig(), lockTimeoutMs: 300 },
        logger: silentLogger,
        databaseOverride: scratch.name,
      });
      h = await buildHarness(db);
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
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await app.close();
      await db.close();
      await scratch.drop();
    });

    it('answers 503 with Retry-After on the wire, and the same request succeeds once it is let go', async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'p',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'd',
        host: '192.0.2.10',
      });
      const read = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(device.id)}` });
      const etag = read.headers.etag;
      assert.equal(typeof etag, 'string');
      const patch = (): Promise<LightMyRequestResponse> =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/objects/${String(device.id)}`,
          headers: { 'if-match': String(etag) },
          payload: { kind: 'device', name: 'renamed' },
        });

      const holder = new Client({ ...testDatabaseConfig(), database: scratch.name });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM object WHERE id = $1 FOR UPDATE', [device.id]);
        const refused = await within(3_000, 'the PATCH to give up on the held row', patch());
        assert.equal(refused.statusCode, 503, refused.body);
        assert.equal(refused.headers['retry-after'], '5');
        assert.equal(
          refused.json<{ error: { code: string } }>().error.code,
          'DATABASE_LOCK_TIMEOUT',
        );
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      assert.equal((await patch()).statusCode, 200, 'the same request, once the lock is gone');
      assert.equal(db.timeouts().locks, 1);
    });
  },
);

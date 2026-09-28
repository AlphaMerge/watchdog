import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { GroupService } from '../src/auth/groups.js';
import { AccessService } from '../src/auth/access.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService } from '../src/libraries/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * The libraries API over the wire (`L-01`).
 *
 * **Written with the routes, not after them** — catalogue entry 41 is the reason. `MapError` had no
 * branch in `api/errors.ts`, so every map error reached the client as a 500 while the service
 * suite asserted the right codes, and nothing noticed until the first HTTP test. The claims here
 * are the ones that only exist on the wire: that an unreadable library is a 404 *response*, that
 * `If-Match` is 428 when missing, that a refused document says which node, and that the response
 * schema does not strip a node's children on the way out.
 */

const available = await databaseAvailable();

describe('the libraries API', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let author = '';
  let stranger = '';
  /** A read-only account, and a read-scoped token `author` holds (`A-14`). */
  let watcher = '';
  let authorReadToken = '';
  let strangerGroupId = 0;

  before(async () => {
    scratch = await createScratchDatabase('libapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    const accounts = new AccountService({ db, logger: silent });
    const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });

    const server = new ApiServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        webRoot: '',
        allowedOrigins: [],
        requireAuthentication: true,
      },
      logger: silent,
      version: '9.9.9',
      service: harness.service,
      history: new HistoryService({ db, logger: silent }),
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
      libraries: new LibraryService({
        db,
        repository: new LibraryRepository(),
        audit: new DatabaseAuditSink(),
        logger: silent,
      }),
      auth: {
        accounts,
        sessions: new SessionService({ db, logger: silent }),
        throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
        groups: new GroupService({ db, logger: silent }),
        access,
        tokens: new TokenService({ db, logger: silent }),
        totp: new TotpService({ db, logger: silent }),
        required: true,
      },
    });
    await server.build('9.9.9', harness.service);
    app = server.app;

    // `readwrite`, not administrators: an administrator short-circuits every grant and would make
    // the access half of this file assert nothing.
    for (const [login, role] of [
      ['author', 'readwrite'],
      ['stranger', 'readwrite'],
      ['watcher', 'readonly'],
    ] as const) {
      await accounts.create({ login, password: 'correct-horse-battery', role });
      const group = await db.query<{ id: string }>(
        `INSERT INTO user_group (name) VALUES ($1) RETURNING id`,
        [`${login}s`],
      );
      if (login === 'stranger') strangerGroupId = Number(group[0]?.id);
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary)
         SELECT $1, id, true FROM user_account WHERE login = $2`,
        [Number(group[0]?.id), login],
      );
    }
    const authorId = await db.query<{ id: string }>(
      `SELECT id FROM user_account WHERE login = 'author'`,
    );
    authorReadToken = (
      await new TokenService({ db, logger: silent }).issue(
        { userId: Number(authorId[0]?.id), role: 'readwrite' },
        { name: 'libraries-read', scope: 'read' },
      )
    ).secret;

    author = await sessionFor('author');
    stranger = await sessionFor('stranger');
    watcher = await sessionFor('watcher');
  });

  after(async () => {
    await scratch.drop();
  });

  const sessionFor = async (login: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: 'correct-horse-battery' },
    });
    assert.equal(response.statusCode, 200, `${login} could not log in`);
    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
    return header.split(';')[0] ?? '';
  };

  const as = (cookie: string) => ({ cookie });

  const make = async (name: string, nodes: unknown[] = []) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: as(author),
      payload: { name, nodes },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ id: number; version: number }>();
  };

  const errorOf = (body: string) =>
    (JSON.parse(body) as { error: { code: string; details?: Record<string, unknown> } }).error;

  it('serves the routes, and a created library is in its author’s list', async () => {
    const { id } = await make('mounted');
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: as(author),
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json<{ items: { id: number }[] }>().items.some((one) => one.id === id));
  });

  it('hands back every level of the document, not what the response schema happened to name', async () => {
    const nodes = [
      {
        id: 'a',
        name: 'Customer A',
        rule: null,
        children: [
          {
            id: 'r',
            name: 'Routers',
            rule: { roots: [1], types: ['snmp.traffic'], tags: ['Core'], states: ['down'] },
            children: [{ id: 'deep', name: 'Deep', rule: null, children: [] }],
          },
        ],
      },
    ];
    const { id } = await make('round-trip', nodes);
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/libraries/${String(id)}`,
      headers: as(author),
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json<{ nodes: unknown }>().nodes, nodes);
  });

  it('answers 404 to an account that may not read it, on every route, and never 403 or 500', async () => {
    const { id, version } = await make('hidden');
    const url = `/api/v1/libraries/${String(id)}`;
    for (const request of [
      { method: 'GET' as const, url },
      { method: 'PATCH' as const, url, headers: { 'if-match': String(version) }, payload: {} },
      { method: 'DELETE' as const, url },
      { method: 'GET' as const, url: `${url}/access` },
      {
        method: 'PUT' as const,
        url: `${url}/access/${String(strangerGroupId)}`,
        payload: { right: 'full' },
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { ...as(stranger), ...request.headers },
      });
      assert.equal(response.statusCode, 404, `${request.method} ${request.url}: ${response.body}`);
      assert.equal(errorOf(response.body).code, 'LIBRARY_NOT_FOUND');
    }
  });

  it('asks for If-Match, and refuses one that has moved on', async () => {
    const { id, version } = await make('versioned');
    const patch = (ifMatch: string | undefined, priority: number) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/libraries/${String(id)}`,
        headers: { ...as(author), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
        payload: { priority },
      });

    const missing = await patch(undefined, 4);
    assert.equal(missing.statusCode, 428);
    assert.equal(errorOf(missing.body).code, 'LIBRARY_PRECONDITION_REQUIRED');

    assert.equal((await patch('not-a-version', 4)).statusCode, 400);

    const saved = await patch(`W/"${String(version)}"`, 4);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json<{ version: number }>().version, version + 1);

    const stale = await patch(String(version), 2);
    assert.equal(stale.statusCode, 409);
    assert.equal(errorOf(stale.body).code, 'LIBRARY_CHANGED');
  });

  it('refuses a document that does not fit, naming the node, as a 400 rather than a 500', async () => {
    // An id used twice in different branches: the schema cannot say it, so this is the
    // validator's refusal reaching the wire through `api/errors.ts`.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: as(author),
      payload: {
        name: 'twice',
        nodes: [
          { id: 'a', name: 'A', children: [{ id: 'x', name: 'X' }] },
          { id: 'b', name: 'B', children: [{ id: 'x', name: 'X' }] },
        ],
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    const error = errorOf(response.body);
    assert.equal(error.code, 'LIBRARY_INVALID');
    assert.equal(error.details?.['path'], 'nodes[1].children[0].id');

    // And what the schema can say, it says first: a node with a field nodes do not have.
    const misspelt = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: as(author),
      payload: { name: 'misspelt', nodes: [{ id: 'a', name: 'A', rules: { tags: ['x'] } }] },
    });
    assert.equal(misspelt.statusCode, 400, misspelt.body);
  });

  it('refuses every change to a read-only account and a read-scoped token (`A-14`)', async () => {
    const { id, version } = await make('guarded');
    const url = `/api/v1/libraries/${String(id)}`;
    for (const [who, headers] of [
      ['read-only', as(watcher)],
      ['read-token', { authorization: `Bearer ${authorReadToken}` }],
    ] as const) {
      for (const request of [
        { method: 'POST' as const, url: '/api/v1/libraries', payload: { name: `by-${who}` } },
        { method: 'PATCH' as const, url, payload: { priority: 1 } },
        { method: 'DELETE' as const, url },
        {
          method: 'PUT' as const,
          url: `${url}/access/${String(strangerGroupId)}`,
          payload: { right: 'read' },
        },
        { method: 'DELETE' as const, url: `${url}/access/${String(strangerGroupId)}` },
      ]) {
        const response = await app.inject({
          ...request,
          headers: { ...headers, 'if-match': String(version) },
        });
        assert.equal(response.statusCode, 403, `${who} ${request.method} ${request.url}`);
      }
    }
    // The token still reads, so the refusals above were about writing.
    const read = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${authorReadToken}` },
    });
    assert.equal(read.statusCode, 200);
  });

  it('grants and revokes a group’s access through the access routes', async () => {
    const { id } = await make('shared');
    const url = `/api/v1/libraries/${String(id)}`;
    const strangerReads = async () =>
      (await app.inject({ method: 'GET', url, headers: as(stranger) })).statusCode;

    assert.equal(await strangerReads(), 404);
    const granted = await app.inject({
      method: 'PUT',
      url: `${url}/access/${String(strangerGroupId)}`,
      headers: as(author),
      payload: { right: 'read' },
    });
    assert.equal(granted.statusCode, 204, granted.body);
    assert.equal(await strangerReads(), 200);

    const listed = await app.inject({ method: 'GET', url: `${url}/access`, headers: as(author) });
    assert.equal(listed.statusCode, 200);
    assert.ok(
      listed
        .json<{ items: { groupId: number; right: string; grantedBy: string }[] }>()
        .items.some(
          (one) =>
            one.groupId === strangerGroupId && one.right === 'read' && one.grantedBy === 'author',
        ),
    );

    const revoked = await app.inject({
      method: 'DELETE',
      url: `${url}/access/${String(strangerGroupId)}`,
      headers: as(author),
    });
    assert.equal(revoked.statusCode, 204);
    assert.equal(await strangerReads(), 404);
  });

  it('files what it records under its own category in the audit log', async () => {
    const { id } = await make('filed');
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/libraries/${String(id)}`,
      headers: as(author),
    });
    const entries = await db.tx((q) =>
      new AuditRepository().list(q, { categories: ['library'], limit: 100 }),
    );
    const mine = entries.filter(
      (entry) => (entry.summary as { libraryId?: number }).libraryId === id,
    );
    assert.deepEqual(mine.map((entry) => entry.action).sort(), [
      'library.created',
      'library.deleted',
    ]);
  });
});

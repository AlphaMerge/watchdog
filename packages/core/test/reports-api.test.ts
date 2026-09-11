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
import { AuditRepository } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService } from '../src/reports/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * The reports API over the wire (`E-01`).
 *
 * **Written at the same time as the routes, because the maps API was not.** `G-01` shipped nine
 * routes that nothing mounted, and they answered 404 in the binary an operator runs for months —
 * the service was an option and `main.ts` passed none. The first claim below is the cheap one
 * that would have caught it.
 *
 * The rest is what only exists on the wire: the status codes, `If-Match`, and the two shapes a
 * client has to act on — a report it may not read reading as absent, and a lost security context
 * arriving as an understood-but-unrunnable 422 rather than as "the request could not be
 * completed".
 */

const available = await databaseAvailable();

describe('the reports API', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let app: FastifyInstance;
  let author = '';
  let reader = '';
  let readerGroupId: number;

  before(async () => {
    scratch = await createScratchDatabase('reportsapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    const accounts = new AccountService({ db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const groups = new GroupService({ db, logger: silent });
    const access = new AccessService({ db, logger: silent });
    const history = new HistoryService({ db, logger: silent });

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
      history,
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
      reports: new ReportService({ db, repository: new ReportRepository(), logger: silent }),
      auth: {
        accounts,
        sessions,
        throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
        groups,
        access,
        tokens: new TokenService({ db, logger: silent }),
        totp: new TotpService({ db, logger: silent }),
        required: true,
      },
    });
    await server.build('9.9.9', harness.service);
    app = server.app;

    // Both `readwrite`: an administrator short-circuits every grant and would make the access
    // half of this file assert nothing.
    for (const login of ['author', 'reader', 'temp']) {
      await accounts.create({ login, password: 'correct-horse-battery', role: 'readwrite' });
    }
    const authorGroup = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('authors') RETURNING id`,
    );
    const readerGroup = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('readers') RETURNING id`,
    );
    readerGroupId = Number(readerGroup[0]?.id);
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login = 'author'`,
      [Number(authorGroup[0]?.id)],
    );
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login IN ('reader', 'temp')`,
      [readerGroupId],
    );

    author = await sessionFor('author');
    reader = await sessionFor('reader');
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

  interface Wire {
    id: number;
    name: string;
    kind: string;
    version: number;
    subjects: { objectIds: number[] };
    span: { kind: string; offset?: number; timezone?: string };
    resolved?: {
      from: string;
      to: string;
      label: string;
      timezone: string;
      bucketSeconds: number;
      source: string;
      adjustments: { kind: string; reason: string }[];
    };
    unresolvable?: { code: string; message: string };
    runAs: { login: string; available: boolean };
  }

  const makeReport = async (name: string, extra: Record<string, unknown> = {}): Promise<Wire> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: as(author),
      payload: { name, kind: 'table_only', ...extra },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Wire>();
  };

  it('serves the routes at all, which is what the maps API was missing for months', async () => {
    const made = await makeReport('mounted');
    const listed = await app.inject({ method: 'GET', url: '/api/v1/reports', headers: as(author) });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json<{ items: { id: number }[] }>().items.some((one) => one.id === made.id));
  });

  it('answers the creator’s own login as the security context, and calls it available', async () => {
    const made = await makeReport('whose-eyes');
    assert.deepEqual(made.runAs, { login: 'author', available: true });
  });

  it('reads a report the caller may not see as absent, not forbidden', async () => {
    const made = await makeReport('not-yours');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${String(made.id)}`,
      headers: as(reader),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'REPORT_NOT_FOUND');
  });

  it('leaves a report out of a list the caller may not see it in', async () => {
    const made = await makeReport('invisible-in-the-list');
    const listed = await app.inject({ method: 'GET', url: '/api/v1/reports', headers: as(reader) });
    assert.equal(listed.statusCode, 200);
    assert.ok(!listed.json<{ items: { id: number }[] }>().items.some((one) => one.id === made.id));
  });

  describe('If-Match, because a report is edited by hand and read by a scheduler', () => {
    it('refuses an edit that carries no version at all', async () => {
      const made = await makeReport('unversioned');
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: as(author),
        payload: { description: 'no header' },
      });
      assert.equal(response.statusCode, 401);
      assert.match(response.json<{ error: { message: string } }>().error.message, /If-Match/);
    });

    it('accepts a weak entity tag, and answers 409 once the version has moved on', async () => {
      const made = await makeReport('versioned');
      const first = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: { ...as(author), 'if-match': `W/"${String(made.version)}"` },
        payload: { description: 'edited' },
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json<Wire>().version, made.version + 1);

      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: { ...as(author), 'if-match': String(made.version) },
        payload: { description: 'too late' },
      });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json<{ error: { code: string } }>().error.code, 'REPORT_CHANGED');
    });
  });

  describe('the error envelope, which every one of these codes depends on', () => {
    // **`G-10` found that every `MapError` reached the wire as a 500**, because `api/errors.ts`
    // had no branch for it and `AppError` fell through to the catch-all with its message
    // replaced. These cases exist so the same omission cannot happen here quietly: each asserts
    // a status the service chose deliberately, and a 500 fails all of them.
    it('carries a refusal out with the status the service chose, not a 500', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: { name: 'ghost-context', kind: 'table_only', runAs: 'nobody-at-all' },
      });
      assert.equal(response.statusCode, 404);
      const body = response.json<{ error: { code: string; details: { runAs: string } } }>();
      assert.equal(body.error.code, 'REPORT_USER_NOT_FOUND');
      assert.equal(body.error.details.runAs, 'nobody-at-all');
    });

    it('answers 409 for a duplicate name whatever its case', async () => {
      await makeReport('Monthly Uptime');
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: { name: 'monthly uptime', kind: 'table_only' },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REPORT_NAME_TAKEN');
    });

    it('refuses a template that is not one of the seven at the schema', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: { name: 'bad-template', kind: 'graph_and_tabel' },
      });
      assert.equal(response.statusCode, 400);
    });
  });

  it('says a security context is gone rather than pretending the report can run', async () => {
    // The wire half of migration 047's claim. A client reading `available: false` can offer to
    // repoint the report; a client reading a 500, or a login and nothing else, cannot.
    const made = await makeReport('orphaned', { runAs: 'temp' });
    assert.deepEqual(made.runAs, { login: 'temp', available: true });

    await db.query(`DELETE FROM user_account WHERE login = 'temp'`);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${String(made.id)}`,
      headers: as(author),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<Wire>().runAs, { login: 'temp', available: false });
  });

  describe('the access routes', () => {
    it('grants with 204, lists the grant, and revokes it again', async () => {
      const made = await makeReport('shared');
      const granted = await app.inject({
        method: 'PUT',
        url: `/api/v1/reports/${String(made.id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'read' },
      });
      assert.equal(granted.statusCode, 204, granted.body);
      assert.equal(granted.body, '');

      const seen = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: as(reader),
      });
      assert.equal(seen.statusCode, 200, 'the grant reached the reader');

      const grants = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/access`,
        headers: as(author),
      });
      assert.equal(grants.statusCode, 200);
      const items = grants.json<{ items: { groupId: number; right: string }[] }>().items;
      assert.equal(items.find((one) => one.groupId === readerGroupId)?.right, 'read');

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/reports/${String(made.id)}/access/${String(readerGroupId)}`,
        headers: as(author),
      });
      assert.equal(revoked.statusCode, 204);

      const gone = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: as(reader),
      });
      assert.equal(gone.statusCode, 404, 'and taking it away puts the report out of sight again');
    });

    it('will not let a read holder see who else has access', async () => {
      const made = await makeReport('who-else');
      await app.inject({
        method: 'PUT',
        url: `/api/v1/reports/${String(made.id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'read' },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/access`,
        headers: as(reader),
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REPORT_FORBIDDEN');
    });
  });

  describe('the span, resolved where the author can still see it (E-02)', () => {
    it('defaults to last month, and says which month that is', async () => {
      const made = await makeReport('default-span');
      assert.deepEqual(made.span, { kind: 'month', offset: 1 });
      assert.ok(made.resolved, 'the response carries the window the span works out to');
      assert.match(made.resolved.label, /^\d{4}-\d{2} \(/);
      assert.ok(new Date(made.resolved.to) <= new Date(), 'the last complete month is in the past');
    });

    it('tells the author their pinned averaging will be overruled, before they save again', async () => {
      // **The whole reason `resolved` is on the response.** `§6`'s averaging rule is not cosmetic
      // — it decides which rollup tier answers. An author who pinned five-minute buckets over a
      // quarter has to learn that here, not from a PDF a month later.
      const made = await makeReport('coarsened', {
        span: { kind: 'quarter', offset: 1, timezone: 'UTC', resolutionSeconds: 300 },
      });
      assert.ok(made.resolved);
      assert.equal(made.resolved.bucketSeconds, 3_600);
      assert.notEqual(made.resolved.source, 'sample');
      assert.ok(
        made.resolved.adjustments.some((one) => one.kind === 'resolution-coarsened'),
        'and the reason travels with it',
      );
    });

    it('refuses a span it cannot act on at the schema, before the service sees it', async () => {
      for (const span of [
        { kind: 'fortnight' },
        { kind: 'month', offset: -1 },
        { kind: 'month', weekStartsOn: 'sunday' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/reports',
          headers: as(author),
          payload: { name: `bad-span-${JSON.stringify(span)}`, kind: 'table_only', span },
        });
        assert.equal(response.statusCode, 400, JSON.stringify(span));
      }
    });

    it('refuses a span the schema cannot judge, as a 400 from the service', async () => {
      // `timezone` is a string either way; only the zone database can say it is not one.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: {
          name: 'bad-zone',
          kind: 'table_only',
          span: { kind: 'month', timezone: 'Europe/Berlim' },
        },
      });
      assert.equal(response.statusCode, 400);
      const body = response.json<{ error: { code: string; message: string } }>();
      assert.equal(body.error.code, 'REPORT_INVALID');
      assert.match(body.error.message, /not a time zone/);
    });

    it('reports an unresolvable span as a field rather than failing the read', async () => {
      // A month-to-date report is unresolvable for the first instant of every month. Answering
      // 500 for the whole listing because one report is a millisecond early would be the worse
      // bug — so the refusal travels as a field on the report it belongs to.
      const made = await makeReport('to-date', { span: { kind: 'month', offset: 0 } });
      assert.ok(made.resolved, 'ordinarily it resolves');

      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/reports',
        headers: as(author),
      });
      assert.equal(listed.statusCode, 200);
      const mine = listed.json<{ items: Wire[] }>().items.find((one) => one.id === made.id);
      assert.ok(mine?.resolved ?? mine?.unresolvable, 'and always says which');
    });
  });

  it('deletes a report, and stops serving it', async () => {
    const made = await makeReport('temporary');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/reports/${String(made.id)}`,
      headers: as(author),
    });
    assert.equal(removed.statusCode, 204);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${String(made.id)}`,
      headers: as(author),
    });
    assert.equal(response.statusCode, 404);
  });

  it('needs a session, like every other read', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reports' });
    assert.equal(response.statusCode, 401);
  });
});

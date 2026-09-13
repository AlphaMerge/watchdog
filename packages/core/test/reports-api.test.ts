import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { assertWellFormed } from './support/xml.js';
import { readPdf } from './support/pdf.js';
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
import { ReportContext } from '../src/reports/context.js';
import { ReportRenderer } from '../src/reports/render.js';
import { ReportRunner, ReportRunRepository, type ReportRanEvent } from '../src/reports/runs.js';
import { ReportFormatter } from '../src/reports/formatter.js';
import { ReportDelivery, ReportOutputRepository } from '../src/reports/delivery.js';
import type { DocumentMessage } from '../src/notifications/delivery/email.js';
import type { DeliveryResult } from '../src/notifications/delivery/transport.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
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
  let reportRunner: ReportRunner;
  let reportRuns: ReportRunRepository;
  let reportRepositoryRef: ReportRepository;
  let reportOutputs: ReportOutputRepository;
  let reportDelivery: ReportDelivery;
  let formatter: ReportFormatter;
  const sentMail: DocumentMessage[] = [];
  /** Mutable so a case can make the relay fail, and read back by the stub below. */
  const relay: { answer: DeliveryResult } = { answer: { ok: true, detail: 'test relay' } };
  const auditedRuns: ReportRanEvent[] = [];
  let authorGroupId: number;
  let sensorId: number;
  let hiddenSensorId: number;
  let deletedId: number;

  before(async () => {
    scratch = await createScratchDatabase('reportsapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    const accounts = new AccountService({ db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const groups = new GroupService({ db, logger: silent });
    const access = new AccessService({ db, logger: silent });
    const history = new HistoryService({ db, logger: silent });
    const reportRepository = new ReportRepository();
    reportRepositoryRef = reportRepository;
    const reportContext = new ReportContext({
      db,
      repository: reportRepository,
      access,
      logger: silent,
    });
    const reportRenderer = new ReportRenderer({ context: reportContext, history, logger: silent });
    reportRuns = new ReportRunRepository();
    reportOutputs = new ReportOutputRepository();
    formatter = new ReportFormatter({ logger: silent });
    reportDelivery = new ReportDelivery({
      formatter,
      db,
      outputs: reportOutputs,
      // A relay that records rather than sends, so the delivery cases assert what went out
      // without standing up SMTP.
      email: {
        sendDocument: (message: DocumentMessage): Promise<DeliveryResult> => {
          sentMail.push(message);
          return Promise.resolve(relay.answer);
        },
      },
      logger: silent,
    });
    reportRunner = new ReportRunner({
      db,
      reports: reportRepository,
      runs: reportRuns,
      renderer: reportRenderer,
      delivery: reportDelivery,
      logger: silent,
      audit: (event) => {
        auditedRuns.push(event);
        return Promise.resolve();
      },
    });

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
      reports: {
        service: new ReportService({ db, repository: reportRepository, logger: silent }),
        context: reportContext,
        renderer: reportRenderer,
        runner: reportRunner,
        runs: reportRuns,
        outputStore: reportOutputs,
        formatter,
      },
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
    for (const login of ['author', 'reader', 'temp', 'temp2', 'temp3']) {
      await accounts.create({ login, password: 'correct-horse-battery', role: 'readwrite' });
    }
    const authorGroup = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('authors') RETURNING id`,
    );
    const readerGroup = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('readers') RETURNING id`,
    );
    readerGroupId = Number(readerGroup[0]?.id);
    authorGroupId = Number(authorGroup[0]?.id);
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login = 'author'`,
      [Number(authorGroup[0]?.id)],
    );
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, true FROM user_account WHERE login IN ('reader', 'temp', 'temp2', 'temp3')`,
      [readerGroupId],
    );

    // **Only the author's group may see the tree.** `reader` gets access to some *reports* below
    // and never to an object, which is what makes the act-as cases mean anything: if everybody
    // could read the tree, a report that returned the caller's view would pass too.
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'read')`,
      [harness.rootId, authorGroupId],
    );
    // `temp2` is the account a report runs as while it is being disabled; it needs the same view
    // so the "while the account is enabled" half of that case asserts something.
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary)
       SELECT $1, id, false FROM user_account WHERE login IN ('temp2', 'temp3')`,
      [authorGroupId],
    );

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      name: 'reports-probe',
      parentId: harness.rootId,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      name: 'reports-device',
      parentId: probe.id,
      host: '10.0.0.2',
    });
    sensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'reports-sensor',
        parentId: device.id,
        sensorType: 'icmp.ping',
      })
    ).id;
    // **A device the author's group explicitly may not see**, which is `A-03`'s third rule: an
    // explicit grant beats an inherited one, and `none` carves a hole in a branch. Without this
    // the read grant on the root makes every subject visible, and an API case asserting "only
    // what the context can read" would pass just as well with no access check at all.
    const walled = await harness.service.create(testActor, {
      kind: 'device',
      name: 'reports-walled',
      parentId: probe.id,
      host: '10.0.0.3',
    });
    hiddenSensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'reports-hidden',
        parentId: walled.id,
        sensorType: 'icmp.ping',
      })
    ).id;
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'none')`,
      [walled.id, authorGroupId],
    );

    const doomed = await harness.service.create(testActor, {
      kind: 'sensor',
      name: 'reports-doomed',
      parentId: device.id,
      sensorType: 'icmp.ping',
    });
    deletedId = doomed.id;
    await db.query('DELETE FROM object WHERE id = $1', [deletedId]);

    author = await sessionFor('author');
    reader = await sessionFor('reader');
  });

  after(async () => {
    await formatter.close();
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
    scheduleSummary: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
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

  describe('the security context over the wire (E-03)', () => {
    it('answers the subjects its runAs account can read, not the caller’s', async () => {
      // `author` and `reader` are in different groups and `reader` has no grant on the tree, yet
      // reading a report that runs as `author` returns author's view. That is the act-as grant,
      // and it is the reason a report's ACL has to be treated as the account it runs as.
      const made = await makeReport('scoped', {
        subjects: { objectIds: [sensorId, hiddenSensorId, deletedId] },
      });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/reports/${String(made.id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'read' },
      });

      for (const [who, cookie] of [
        ['author', author],
        ['reader', reader],
      ] as const) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/reports/${String(made.id)}/subjects`,
          headers: as(cookie),
        });
        assert.equal(response.statusCode, 200, `${who}: ${response.body}`);
        const body = response.json<{
          runAs: { login: string; role: string };
          visible: { id: number; kind: string; name: string }[];
          unavailable: number[];
        }>();
        assert.equal(body.runAs.login, 'author', `${who} sees the report's own context`);
        assert.deepEqual(
          body.visible.map((one) => one.id),
          [sensorId],
        );
        assert.deepEqual(
          [...body.unavailable].sort((a, b) => a - b),
          [hiddenSensorId, deletedId].sort((a, b) => a - b),
          'the out-of-scope one and the deleted one are both counted, and not told apart',
        );
      }
    });

    it('projects identity only, with no field a credential could ride out on', async () => {
      const made = await makeReport('no-params', { subjects: { objectIds: [sensorId] } });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/subjects`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 200);
      const subject = response.json<{ visible: Record<string, unknown>[] }>().visible[0];
      assert.ok(subject);
      assert.deepEqual(Object.keys(subject).sort(), ['id', 'kind', 'name']);
    });

    it('answers 422 once the account is disabled, and stops calling it available', async () => {
      const made = await makeReport('disabled-context', {
        runAs: 'temp2',
        subjects: { objectIds: [sensorId] },
      });
      assert.deepEqual(made.runAs, { login: 'temp2', available: true });
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/reports/${String(made.id)}/subjects`,
            headers: as(author),
          })
        ).statusCode,
        200,
        'while the account is enabled',
      );

      await db.query(`UPDATE user_account SET disabled = true WHERE login = 'temp2'`);

      const refused = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/subjects`,
        headers: as(author),
      });
      assert.equal(refused.statusCode, 422);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'REPORT_NO_CONTEXT');

      // And the report itself now reports the context as unusable, without being asked twice.
      const reread = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: as(author),
      });
      assert.deepEqual(reread.json<Wire>().runAs, { login: 'temp2', available: false });
    });

    it('hides the subjects route behind read on the report, like every other read', async () => {
      const made = await makeReport('private-subjects', { subjects: { objectIds: [sensorId] } });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/subjects`,
        headers: as(reader),
      });
      assert.equal(response.statusCode, 404, 'absent rather than forbidden, as everywhere else');
    });
  });

  describe('rendering over the wire (E-04)', () => {
    it('answers HTML by default and CSV when asked, with the right content type', async () => {
      const made = await makeReport('rendered', { subjects: { objectIds: [sensorId] } });

      const html = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render`,
        headers: as(author),
      });
      assert.equal(html.statusCode, 200, html.body);
      assert.match(html.headers['content-type'] ?? '', /^text\/html; charset=utf-8$/u);
      assert.ok(html.body.startsWith('<!doctype html>'));
      assert.match(html.headers['content-disposition'] ?? '', /inline; filename="rendered.html"/u);

      const csv = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render?format=csv`,
        headers: as(author),
      });
      assert.equal(csv.statusCode, 200, csv.body);
      assert.match(csv.headers['content-type'] ?? '', /^text\/csv; charset=utf-8$/u);
      assert.ok(csv.body.startsWith('Report,rendered'), csv.body.slice(0, 80));
    });

    it('answers XML with a gap a script cannot read as a zero (E-07)', async () => {
      const made = await makeReport('rendered-xml', { subjects: { objectIds: [sensorId] } });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render?format=xml`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.headers['content-type'] ?? '', /^application\/xml; charset=utf-8$/u);
      assert.match(
        response.headers['content-disposition'] ?? '',
        /inline; filename="rendered-xml.xml"/u,
      );
      assert.ok(response.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), response.body);
      // Over the wire as it is in the unit tests: the document parses, it names the sensor, and a
      // bucket with no reading says so in XML's own spelling rather than with an empty element.
      assertWellFormed(response.body);
      assert.ok(response.body.includes('reports-sensor'));
      assert.ok(!response.body.includes('></value>'), 'never an empty value element');
    });

    it('answers a PDF, laid out by this service rather than by a browser (E-06)', async () => {
      const made = await makeReport('rendered-pdf', { subjects: { objectIds: [sensorId] } });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render?format=pdf`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.headers['content-type'] ?? '', /^application\/pdf$/u);
      assert.match(
        response.headers['content-disposition'] ?? '',
        /inline; filename="rendered-pdf.pdf"/u,
      );
      const pdf = response.rawPayload;
      assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'it is a PDF');
      // Read back through its own font map, which is how a reader gets the text out: the report’s
      // name and the sensor it covers are in the document, not merely in its metadata.
      const readout = readPdf(pdf);
      const drawn = readout.pages.flat();
      assert.ok(drawn.includes('rendered-pdf'), JSON.stringify(drawn.slice(0, 10)));
      assert.ok(
        drawn.some((text) => text.includes('reports-sensor')),
        'and the sensor',
      );
      assert.ok(
        readout.fonts.some((font) => font.endsWith('+DejaVuSans')),
        readout.fonts.join(','),
      );
    });

    it('refuses a format it does not have, rather than guessing', async () => {
      const made = await makeReport('bad-format', { subjects: { objectIds: [sensorId] } });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render?format=docx`,
        headers: as(author),
      });
      // Saying so beats an HTML document served under a name that promises otherwise — which is
      // what a renderer with a default branch would have answered.
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REPORT_INVALID');
    });

    it('renders through the report’s account, not the caller’s', async () => {
      // `reader` has no access to the tree at all. Reading a report that runs as `author` still
      // produces author's data — the act-as grant, reaching the rendered document.
      const made = await makeReport('act-as', { subjects: { objectIds: [sensorId] } });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/reports/${String(made.id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'read' },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render?format=csv`,
        headers: as(reader),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.body.includes('Renders as,author'));
      assert.ok(response.body.includes('reports-sensor'), 'and contains what author can see');
    });

    it('answers 422 once the account it renders through is disabled', async () => {
      const made = await makeReport('render-nocontext', {
        runAs: 'temp3',
        subjects: { objectIds: [sensorId] },
      });
      await db.query(`UPDATE user_account SET disabled = true WHERE login = 'temp3'`);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 422);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        'REPORT_NO_CONTEXT',
        'and as JSON, because the error envelope is the same whatever the route usually answers',
      );
    });

    it('is hidden behind read on the report, like every other read', async () => {
      const made = await makeReport('private-render', { subjects: { objectIds: [sensorId] } });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/render`,
        headers: as(reader),
      });
      assert.equal(response.statusCode, 404);
    });
  });

  describe('scheduling and running over the wire (E-08)', () => {
    it('defaults to manual, and says so in words rather than only in a document', async () => {
      // Creating a report must not schedule one: `§6` offers six frequencies and choosing any of
      // them for somebody is this system deciding on its own to send email.
      const made = await makeReport('unscheduled');
      assert.deepEqual(made.span.kind, 'month');
      assert.equal(made.scheduleSummary, 'only when somebody runs it');
      assert.equal(made.nextRunAt, null, 'null is not an error — it is "does not run on its own"');
    });

    it('describes a schedule an operator set, and books it', async () => {
      const made = await makeReport('scheduled', {
        subjects: { objectIds: [sensorId] },
        schedule: { kind: 'weekly', weekday: 0, minute: 180, timezone: 'UTC' },
      });
      assert.equal(made.scheduleSummary, 'every Monday at 03:00');
    });

    it('refuses a schedule field the frequency will not honour', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: {
          name: 'bad-schedule',
          kind: 'table_only',
          schedule: { kind: 'monthly', weekday: 2 },
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REPORT_INVALID');
    });

    it('runs on demand, records the run, and lists it', async () => {
      const made = await makeReport('run-me', { subjects: { objectIds: [sensorId] } });
      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(author),
      });
      assert.equal(started.statusCode, 201, started.body);
      const run = started.json<{
        id: number;
        state: string;
        spanLabel: string;
        sections: number;
      }>();
      assert.equal(run.state, 'succeeded');
      assert.ok(run.spanLabel.length > 0, 'and says which period it covered');

      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(author),
      });
      assert.equal(listed.statusCode, 200);
      assert.ok(listed.json<{ items: { id: number }[] }>().items.some((one) => one.id === run.id));
    });

    it('needs write to start one, because a render is minutes of work', async () => {
      // Read is enough to look at a report; starting one is a long sequence of reads against the
      // database serving live checks, so it is a write even though it changes nothing.
      const made = await makeReport('write-to-run', { subjects: { objectIds: [sensorId] } });
      await app.inject({
        method: 'PUT',
        url: `/api/v1/reports/${String(made.id)}/access/${String(readerGroupId)}`,
        headers: as(author),
        payload: { right: 'read' },
      });
      const refused = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(reader),
      });
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'REPORT_FORBIDDEN');

      // Reading the history needs only read, which is the asymmetry that makes it useful.
      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(reader),
      });
      assert.equal(listed.statusCode, 200);
    });

    it('answers 409 rather than queueing a second run of the same report', async () => {
      const made = await makeReport('busy', { subjects: { objectIds: [sensorId] } });
      const report = await reportRepositoryRef.find(db, made.id);
      assert.ok(report);
      // Hold the slot the way an in-flight render does.
      assert.ok(await reportRuns.claim(db, made.id, 'manual', 'holder'));

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'REPORT_BUSY');
    });

    it('records the audit event, naming who asked and whose eyes it used', async () => {
      const before = auditedRuns.length;
      // `reader` rather than `temp`: the E-03 cases above delete one account and disable
      // another, and a fixture that quietly depends on test order is a flake waiting to happen.
      const made = await makeReport('audited', {
        runAs: 'reader',
        subjects: { objectIds: [sensorId] },
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(author),
      });
      const event = auditedRuns[before];
      assert.ok(event);
      assert.equal(event.requestedBy, 'author');
      assert.equal(event.runAs, 'reader', 'the act-as, which is the auditable fact');
      assert.equal(event.trigger, 'manual');
    });
  });

  describe('storing and delivering over the wire (E-09)', () => {
    it('defaults to storing HTML and sending nothing', async () => {
      const made = await makeReport('default-outputs');
      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}`,
        headers: as(author),
      });
      assert.deepEqual(listed.json<{ outputs: unknown }>().outputs, {
        formats: ['html'],
        delivery: 'store',
        recipients: [],
        zip: false,
      });
    });

    it('refuses an email delivery with nowhere to send it, at the write', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: {
          name: 'nowhere',
          kind: 'table_only',
          outputs: { formats: ['csv'], delivery: 'email' },
        },
      });
      assert.equal(response.statusCode, 400);
      assert.match(
        response.json<{ error: { message: string } }>().error.message,
        /needs at least one recipient/u,
      );
    });

    it('refuses a format nothing renders, at the schema', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: as(author),
        payload: { name: 'docx-please', kind: 'table_only', outputs: { formats: ['docx'] } },
      });
      assert.equal(response.statusCode, 400);
    });

    it('lists what a run produced, and downloads it with a strong ETag', async () => {
      const made = await makeReport('downloadable', {
        subjects: { objectIds: [sensorId] },
        outputs: { formats: ['html', 'csv', 'xml', 'pdf'], delivery: 'store' },
      });
      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(author),
      });
      assert.equal(started.statusCode, 201, started.body);
      const run = started.json<{
        id: number;
        outputs: { format: string; filename: string; sha256: string }[];
        delivery: { state: string };
      }>();
      // In the enum's declaration order, which migration 050 put `xml` inside rather than after:
      // the renderings together, the container that wraps them last.
      assert.deepEqual(
        run.outputs.map((one) => one.format),
        ['html', 'csv', 'xml', 'pdf'],
      );
      assert.equal(run.delivery.state, 'none', 'nothing to deliver for a stored-only report');

      const xml = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs/${String(run.id)}/xml`,
        headers: as(author),
      });
      assert.equal(xml.statusCode, 200, xml.body);
      assert.match(xml.headers['content-type'] ?? '', /^application\/xml; charset=utf-8$/u);
      assertWellFormed(xml.body);

      const pdf = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs/${String(run.id)}/pdf`,
        headers: as(author),
      });
      assert.equal(pdf.statusCode, 200);
      assert.match(pdf.headers['content-type'] ?? '', /^application\/pdf$/u);
      assert.equal(pdf.rawPayload.subarray(0, 5).toString('latin1'), '%PDF-');

      const csv = run.outputs.find((one) => one.format === 'csv');
      assert.ok(csv);
      const download = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs/${String(run.id)}/csv`,
        headers: as(author),
      });
      assert.equal(download.statusCode, 200, download.body);
      assert.match(download.headers['content-type'] ?? '', /^text\/csv/u);
      assert.equal(download.headers.etag, `"${csv.sha256}"`);
      assert.match(
        download.headers['content-disposition'] ?? '',
        new RegExp(`filename="${csv.filename}"`, 'u'),
      );
      assert.equal(download.headers['x-content-type-options'], 'nosniff');
      assert.ok(download.body.startsWith('Report,downloadable'), download.body.slice(0, 40));

      // A stored report never changes, so the second download is a 304.
      const again = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs/${String(run.id)}/csv`,
        headers: { ...as(author), 'if-none-match': `"${csv.sha256}"` },
      });
      assert.equal(again.statusCode, 304);
      assert.equal(again.body, '');
    });

    it('will not hand a run of one report to a reader of another', async () => {
      // Without checking that the run belongs to the report, a caller who may read one report
      // could download any run by guessing an id.
      const mine = await makeReport('mine-to-read', { subjects: { objectIds: [sensorId] } });
      const theirs = await makeReport('not-yours-to-read', { subjects: { objectIds: [sensorId] } });
      const run = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/reports/${String(theirs.id)}/runs`,
          headers: as(author),
        })
      ).json<{ id: number }>();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(mine.id)}/runs/${String(run.id)}/html`,
        headers: as(author),
      });
      assert.equal(response.statusCode, 404);
    });

    it('arms a delivery on the run, and records it once it has gone', async () => {
      const before = sentMail.length;
      const made = await makeReport('mailed', {
        subjects: { objectIds: [sensorId] },
        outputs: {
          formats: ['csv'],
          delivery: 'store-and-email',
          recipients: ['ops@example.test'],
          zip: true,
        },
      });
      const run = (
        await app.inject({
          method: 'POST',
          url: `/api/v1/reports/${String(made.id)}/runs`,
          headers: as(author),
        })
      ).json<{ id: number; delivery: { state: string }; outputs: { format: string }[] }>();
      assert.equal(run.delivery.state, 'pending');
      assert.deepEqual(
        run.outputs.map((one) => one.format),
        ['zip'],
        'one archive rather than the parts',
      );

      await reportDelivery.tick();
      assert.equal(sentMail.length, before + 1);
      assert.deepEqual(sentMail[before]?.recipients, ['ops@example.test']);

      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/reports/${String(made.id)}/runs`,
        headers: as(author),
      });
      const row = listed.json<{ items: { id: number; delivery: { state: string } }[] }>().items[0];
      assert.equal(row?.id, run.id);
      assert.equal(row.delivery.state, 'sent');
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

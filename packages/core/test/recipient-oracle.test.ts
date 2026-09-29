import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccessService } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { EmailTransport } from '../src/notifications/delivery/email.js';
import { DeliveryHealthReader } from '../src/notifications/health.js';
import { RecipientResolver } from '../src/notifications/recipients.js';
import { NotificationTester } from '../src/notifications/test-send.js';
import { TemplateService, type Recipient } from '../src/notifications/templates.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { actorNamed, buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/** An id no account and no group has, which is what somebody asking about ids would try. */
const NOBODY = '999999';

/**
 * Who a notification did not reach, and who may be told (`A-44`).
 *
 * **The oracle.** A template's users and groups are ids, resolved when it is sent, and `M-19`
 * named everybody it missed and why — in the test-send report and in the notification log. `M-20`
 * made the accounts and groups an administrator's to list, in the web editor; the server took any
 * id from any writer. So a writer could save a template naming ids 1 to 200, press Test, and read
 * back which ids are accounts, their logins, the groups, who is in them, who has no address and
 * who may not see which sensor; and every reader of a sensor read the same in its log.
 *
 * Over HTTP, because the rule is the caller's role and only a route knows it: the service's
 * default is the restrictive answer, so a test against the service would pass on a route that
 * forgot to ask.
 */
describe(
  'who a notification missed, by who is asking (A-44)',
  {
    skip: available ? false : 'no database',
  },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let app: FastifyInstance;
    let templates: TemplateService;
    let sensorId = 0;
    let readerId = 0;
    let nocId = 0;
    const cookies = new Map<string, string>();
    const as = (login: string) => ({ cookie: cookies.get(login) ?? '' });

    before(async () => {
      scratch = await createScratchDatabase('recipientoracle');
      db = scratch.db;
      const harness = await buildHarness(db);

      const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const contexts = new MessageContextLoader({
        settings: harness.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'oracle',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
      // The real transport and the real resolver, with only the relay left out: what a test send
      // reports is what they produce, not what a stub was told to say.
      const email = new EmailTransport({
        config: {
          sender: 'monitoring@example.test',
          primary: {
            host: 'relay.example.test',
            port: 25,
            security: 'none',
            verifyCertificate: true,
            auth: 'none',
            user: '',
            password: '',
            heloName: 'ms-core.test',
            timeoutMs: 5_000,
          },
          fallback: {
            host: '',
            port: 25,
            security: 'none',
            verifyCertificate: true,
            auth: 'none',
            user: '',
            password: '',
            heloName: 'ms-core.test',
            timeoutMs: 5_000,
          },
        },
        logger: silent,
        recipients: new RecipientResolver({ db, access }),
        build: (): never =>
          ({
            sendMail: () => Promise.resolve({ messageId: '<relay>', rejected: [] }),
            close: () => undefined,
          }) as never,
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
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        templates,
        tester: new NotificationTester({
          db,
          logger: silent,
          contexts,
          transports: [email],
          audit: new DatabaseAuditSink(),
        }),
        deliveryHealth: new DeliveryHealthReader(),
        auth: {
          accounts,
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          required: true,
        },
      });
      await server.build('9.9.9', harness.service);
      app = server.app;

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'oracle-probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'edge-router',
        host: '192.0.2.7',
      });
      sensorId = (
        await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;

      // `operator` writes the branch and `reader` reads it; neither may list the accounts.
      const team = await groups.create({ name: 'Team' }, testActor);
      await access.grant(probe.id, team.id, 'write', actorNamed('oracle'));
      for (const [login, role] of [
        ['admin', 'admin'],
        ['operator', 'readwrite'],
        ['reader', 'readonly'],
        ['leaver', 'readonly'],
      ] as const) {
        const account = await accounts.create(
          { login, password: 'correct-horse-battery', role },
          testActor,
        );
        if (role === 'admin') {
          const admins = (await groups.list()).find((g) => g.isAdmin);
          assert.ok(admins);
          await groups.addMember(admins.id, account.id, testActor);
        } else {
          await groups.addMember(team.id, account.id, testActor);
        }
        if (login === 'reader') readerId = account.id;
        if (login === 'leaver') continue;
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login, password: 'correct-horse-battery' },
        });
        assert.equal(response.statusCode, 200, `${login} could not log in`);
        const setCookie = response.headers['set-cookie'];
        const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
        cookies.set(login, header.split(';')[0] ?? '');
      }
      // `reader` has no address, `leaver` is disabled, and both are in the NOC.
      await db.query(`UPDATE user_account SET disabled = true WHERE login = 'leaver'`);
      const noc = await groups.create({ name: 'NOC' }, testActor);
      nocId = noc.id;
      for (const account of await accounts.list()) {
        if (account.login === 'reader' || account.login === 'leaver') {
          await groups.addMember(noc.id, account.id, testActor);
        }
      }
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_template');
    });

    const user = (value: string): Recipient => ({ kind: 'user', value });
    const group = (value: string): Recipient => ({ kind: 'userGroup', value });
    const ops: Recipient = { kind: 'address', value: 'ops@example.test' };

    /** A template an administrator wrote, which is the only way one names people. */
    async function adminTemplate(recipients: readonly Recipient[]): Promise<number> {
      const created = await templates.create(
        testActor,
        {
          name: `On-call ${String(process.hrtime.bigint())}`,
          method: 'email',
          settings: {},
          subject: '%sensor is %status',
          recipients: [...recipients],
        },
        { namesAccounts: true },
      );
      return created.id;
    }

    const write = (
      login: string,
      method: 'POST' | 'PUT',
      recipients: readonly Recipient[],
      id?: number,
    ) =>
      app.inject({
        method,
        url: id === undefined ? '/api/v1/templates' : `/api/v1/templates/${String(id)}`,
        headers: { ...as(login), 'content-type': 'application/json' },
        payload: {
          name: `Written by ${login}`,
          method: 'email',
          settings: {},
          subject: 'edited',
          recipients,
        },
      });

    describe('a template’s recipients (M-20, now on the server)', () => {
      it('lets an administrator name an account and a group, and nobody else', async () => {
        const refused = await write('operator', 'POST', [ops, user(String(readerId))]);
        assert.equal(refused.statusCode, 403, refused.body);
        assert.equal(refused.json<{ error: { code: string } }>().error.code, 'AUTH_FORBIDDEN');
        const grouped = await write('operator', 'POST', [ops, group(String(nocId))]);
        assert.equal(grouped.statusCode, 403, grouped.body);
        // An id that is nothing at all is refused the same way, or the refusal is the oracle.
        const guessed = await write('operator', 'POST', [user(NOBODY)]);
        assert.equal(guessed.statusCode, 403, guessed.body);
        assert.equal((await templates.list()).length, 0, 'and nothing was written');

        const addressed = await write('operator', 'POST', [ops]);
        assert.equal(addressed.statusCode, 201, addressed.body);
        const admin = await write('admin', 'POST', [
          ops,
          user(String(readerId)),
          group(String(nocId)),
        ]);
        assert.equal(admin.statusCode, 201, admin.body);
      });

      it('lets anybody who may edit it keep or remove the ones it has, and add none', async () => {
        const id = await adminTemplate([ops, user(String(readerId)), group(String(nocId))]);

        // The editor echoes what it read, so an edit to the subject carries the people too.
        const kept = await write(
          'operator',
          'PUT',
          [ops, user(String(readerId)), group(String(nocId))],
          id,
        );
        assert.equal(kept.statusCode, 200, kept.body);
        const removed = await write('operator', 'PUT', [ops, user(String(readerId))], id);
        assert.equal(removed.statusCode, 200, removed.body);

        // Removed is gone: putting it back is adding it.
        const restored = await write(
          'operator',
          'PUT',
          [ops, user(String(readerId)), group(String(nocId))],
          id,
        );
        assert.equal(restored.statusCode, 403, restored.body);
        // So is pointing a row it has at another id.
        const moved = await write('operator', 'PUT', [ops, user(NOBODY)], id);
        assert.equal(moved.statusCode, 403, moved.body);
        // Or the same number as the other kind: group 7 is not user 7.
        const recast = await write('operator', 'PUT', [ops, group(String(readerId))], id);
        assert.equal(recast.statusCode, 403, recast.body);
        assert.deepEqual(
          (await templates.get(id)).recipients,
          [ops, user(String(readerId))],
          'a refused edit changed nothing',
        );

        const admin = await write(
          'admin',
          'PUT',
          [ops, user(String(readerId)), group(String(nocId))],
          id,
        );
        assert.equal(admin.statusCode, 200, admin.body);
      });
    });

    describe('a test send', () => {
      const test = (login: string, id: number) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/templates/${String(id)}/test`,
          headers: { ...as(login), 'content-type': 'application/json' },
          payload: { sensorId },
        });

      it('names who it missed to an administrator, and counts them for anybody else', async () => {
        const id = await adminTemplate([
          ops,
          user(String(readerId)),
          group(String(nocId)),
          user(NOBODY),
        ]);

        const admin = await test('admin', id);
        assert.equal(admin.statusCode, 200, admin.body);
        const named = admin.json<{ delivered: boolean; detail: string }>();
        assert.equal(named.delivered, true);
        assert.match(
          named.detail,
          /; not sent to user "reader" \(no email address\), "leaver" in group "NOC" \(disabled\), "reader" in group "NOC" \(no email address\), user 999999 \(no such account\)$/u,
        );

        const operator = await test('operator', id);
        assert.equal(operator.statusCode, 200, operator.body);
        const counted = operator.json<{ delivered: boolean; detail: string }>();
        assert.equal(counted.delivered, true);
        assert.match(
          counted.detail,
          /; not sent to 4 recipients \(1 no such account, 1 disabled, 2 no email address\)$/u,
        );
        // The raw body, so a name that escaped through any field is found. The ids are the
        // template's own, which this caller reads anyway; what they resolve to is not.
        assert.doesNotMatch(operator.body, /leaver|NOC|"reader"|user 999999/u);
      });

      it('says a message nobody could receive failed, and why, by count', async () => {
        const id = await adminTemplate([user(NOBODY), group(String(nocId))]);

        const admin = await test('admin', id);
        const named = admin.json<{ delivered: boolean; error: string }>();
        assert.equal(named.delivered, false);
        assert.equal(
          named.error,
          'nobody to send to: user 999999 (no such account), ' +
            '"leaver" in group "NOC" (disabled), "reader" in group "NOC" (no email address)',
        );

        const operator = await test('operator', id);
        const counted = operator.json<{ delivered: boolean; error: string }>();
        assert.equal(counted.delivered, false);
        assert.equal(
          counted.error,
          'nobody to send to: 3 recipients (1 no such account, 1 disabled, 1 no email address)',
        );
        assert.doesNotMatch(operator.body, /leaver|NOC|reader/u);
      });
    });

    describe('the notification log', () => {
      it('names who a message missed to an administrator, and counts them for its other readers', async () => {
        // The rows as the dispatcher writes them from here on: the error names nobody, and who is
        // beside it twice, by name and by count.
        const names = '"leaver" in group "NOC" (disabled), user 999999 (no such account)';
        const counts = JSON.stringify({ disabled: 1, 'no such account': 1 });
        for (const [status, error] of [
          ['failed', 'nobody to send to'],
          ['sent', null],
        ] as const) {
          await db.query(
            `INSERT INTO notification_request
             (at, sensor_id, trigger_kind, reason, state, status, last_error,
              skipped_recipients, skipped_counts)
           VALUES (now(), $1, 'state', 'initial', 'down', $2, $3, $4, $5::jsonb)`,
            [sensorId, status, error, names, counts],
          );
        }
        const read = async (login: string) => {
          const response = await app.inject({
            method: 'GET',
            url: `/api/v1/notification-requests?sensorId=${String(sensorId)}`,
            headers: as(login),
          });
          assert.equal(response.statusCode, 200, `${login}: ${response.body}`);
          return response;
        };
        const entries = (body: string) =>
          (
            JSON.parse(body) as {
              items: { status: string; lastError: string | null; skippedRecipients: string }[];
            }
          ).items
            .map((item) => [item.status, item.lastError, item.skippedRecipients])
            .sort();

        assert.deepEqual(entries((await read('admin')).body), [
          ['failed', 'nobody to send to', names],
          ['sent', null, names],
        ]);
        for (const login of ['operator', 'reader']) {
          const response = await read(login);
          const summary = '2 recipients (1 no such account, 1 disabled)';
          assert.deepEqual(entries(response.body), [
            ['failed', 'nobody to send to', summary],
            ['sent', null, summary],
          ]);
          assert.doesNotMatch(response.body, /leaver|NOC|999999/u, login);
        }
      });
    });
  },
);

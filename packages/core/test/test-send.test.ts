import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationTester } from '../src/notifications/test-send.js';
import { TemplateService } from '../src/notifications/templates.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { ScheduleService } from '../src/schedules/service.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

describe(
  'send test notification',
  { skip: available ? false : 'no PostgreSQL on MS_TEST_DB_HOST' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let templates: TemplateService;
    let schedules: ScheduleService;
    let contexts: MessageContextLoader;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('testsend');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      contexts = new MessageContextLoader({
        settings: h.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'Acme production',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
      schedules = new ScheduleService({ db, audit: new DatabaseAuditSink(), logger: silent });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_template');
      await db.query('DELETE FROM schedule WHERE built_in_id IS NULL');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Local probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'edge-router',
        host: '192.0.2.7',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;

      const states = h.states;
      assert.ok(states !== undefined);
      const base = new Date(Date.now() - 600_000);
      for (const offset of [0, 60_000]) {
        const when = new Date(base.getTime() + offset);
        const results: SensorResult[] = [
          { sensorId, at: when, outcome: 'error', message: 'no ICMP reply from 192.0.2.7' },
        ];
        const decisions = await states.decide(results);
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
        });
      }
    });

    async function template(overrides: Record<string, unknown> = {}): Promise<number> {
      const created = await templates.create(testActor, {
        name: `On-call-${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sitename: %sensor on %device is %status',
        body: '%lastmessage — %linksensor',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        summarisation: 'always-immediate',
        ...overrides,
      });
      return created.id;
    }

    function recorder(answer: () => { ok: boolean; retryable?: boolean } = () => ({ ok: true })) {
      const seen: OutgoingMessage[] = [];
      return {
        seen,
        transport: {
          method: 'email',
          send: (outgoing: OutgoingMessage) => {
            seen.push(outgoing);
            const decided = answer();
            return Promise.resolve(
              decided.ok
                ? ({ ok: true, detail: 'accepted by relay.example.test' } as const)
                : ({
                    ok: false,
                    retryable: decided.retryable ?? true,
                    error: 'the relay refused it',
                  } as const),
            );
          },
        },
      };
    }

    function testerWith(transport: object): NotificationTester {
      return new NotificationTester({
        db,
        logger: silent,
        contexts,
        transports: [transport as never],
        audit: new DatabaseAuditSink(),
        publicUrl: 'https://monitoring.example.test',
        siteName: 'Acme production',
      });
    }

    // ---------------------------------------------------------------------------------------
    // It really sends, through the real thing.
    // ---------------------------------------------------------------------------------------

    it('renders against a real sensor and sends it through the real transport', async () => {
      // A test that stubbed the rendering or the transport would prove the stub works.
      const templateId = await template();
      const { seen, transport } = recorder();
      const report = await testerWith(transport).send(testActor, { templateId, sensorId });

      assert.equal(report.delivered, true);
      assert.equal(report.detail, 'accepted by relay.example.test');
      assert.equal(report.error, null);
      assert.equal(report.subject, 'Acme production: Ping on edge-router is down');
      assert.match(report.body, /no ICMP reply from 192\.0\.2\.7/);
      assert.deepEqual(report.recipients, [{ kind: 'address', value: 'ops@example.test' }]);
      assert.equal(seen.length, 1, 'and it actually went');
      assert.equal(seen[0]?.subject, report.subject);
    });

    it('leaves nothing in the queue behind it', async () => {
      // No `notification_request` row, so nothing is retried, summarised or suppressed — each of
      // which would turn "did my relay work" into "wait fifteen minutes and find out".
      const templateId = await template();
      await testerWith(recorder().transport).send(testActor, { templateId, sensorId });
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      assert.equal(rows[0]?.n, '0');
    });

    it('makes up a sensor when none is named, and says so', async () => {
      // The first thing an operator does with a new installation is check the relay, and at that
      // point there may be no sensors at all.
      const templateId = await template();
      const report = await testerWith(recorder().transport).send(testActor, { templateId });
      assert.equal(report.delivered, true);
      assert.equal(report.sensorId, null);
      assert.equal(report.sensorName, 'Example sensor');
      assert.match(report.subject, /Example sensor on example-device is down/);
      assert.match(report.notes.join(' '), /example sensor/);
    });

    // ---------------------------------------------------------------------------------------
    // The report, which is the point of the ticket.
    // ---------------------------------------------------------------------------------------

    it('reports a refusal with the reason rather than throwing', async () => {
      const templateId = await template();
      const report = await testerWith(recorder(() => ({ ok: false, retryable: false })).transport)
        .send(testActor, { templateId, sensorId });
      assert.equal(report.delivered, false);
      assert.equal(report.error, 'the relay refused it');
      assert.equal(report.retryable, false);
      assert.equal(report.detail, null);
    });

    it('reports a transport that throws, because a 500 explains nothing', async () => {
      const throwing = {
        method: 'email',
        send: () => {
          throw new Error('DNS is on fire');
        },
      };
      const templateId = await template();
      const report = await testerWith(throwing).send(testActor, { templateId, sensorId });
      assert.equal(report.delivered, false);
      assert.match(String(report.error), /DNS is on fire/);
    });

    it('says plainly when this build cannot deliver the method at all', async () => {
      const templateId = await template({
        method: 'slack',
        settings: { webhookUrl: 'https://hooks.example.test/x' },
        recipients: [],
      });
      const report = await testerWith(recorder().transport).send(testActor, {
        templateId,
        sensorId,
      });
      assert.equal(report.delivered, false);
      assert.match(String(report.error), /no transport for delivery method "slack"/);
    });

    it('warns that a green test on a switched-off template is not a working alarm', async () => {
      const templateId = await template({ enabled: false });
      const report = await testerWith(recorder().transport).send(testActor, {
        templateId,
        sensorId,
      });
      assert.equal(report.delivered, true, 'the relay works');
      assert.match(report.notes.join(' '), /switched off/);
    });

    it('warns that a real notification could be folded into a digest', async () => {
      const templateId = await template({
        summarisation: 'always-summarise',
        summaryWindowSeconds: 600,
      });
      const report = await testerWith(recorder().transport).send(testActor, {
        templateId,
        sensorId,
      });
      assert.match(report.notes.join(' '), /folded into a digest/);
      assert.match(report.notes.join(' '), /10 minutes/);
    });

    it('warns when the template is outside its activation schedule, and says what would happen', async () => {
      const schedule = await schedules.create(testActor, {
        name: `Weekends-${String(process.hrtime.bigint())}`,
        description: '',
        polarity: 'active',
        timezone: 'UTC',
        // Active for one minute a week, so it is inactive whenever this test runs — bar a
        // one-in-ten-thousand Monday. A schedule that is *never* active is refused outright:
        // that is a permanent pause with a name, not a schedule.
        periods: 'mo:00:00-mo:00:01',
      });
      const templateId = await template({ scheduleId: schedule.id, whenInactive: 'discard' });
      const report = await testerWith(recorder().transport).send(testActor, {
        templateId,
        sensorId,
      });
      assert.equal(report.delivered, true);
      assert.match(report.notes.join(' '), /outside its "Weekends/);
      assert.match(report.notes.join(' '), /thrown away/);
    });

    // ---------------------------------------------------------------------------------------
    // The audit entry.
    // ---------------------------------------------------------------------------------------

    it('records who sent it and whether it arrived', async () => {
      // It changes nothing and it still belongs in the log: somebody testing an on-call template
      // at three in the morning has paged whoever is on call.
      const templateId = await template();
      await testerWith(recorder(() => ({ ok: false })).transport).send(testActor, {
        templateId,
        sensorId,
      });
      const rows = await db.query<{ action: string; summary: Record<string, unknown> }>(
        `SELECT action, summary FROM audit_log WHERE action = 'template.tested' ORDER BY id DESC`,
      );
      const [entry] = rows;
      assert.ok(entry !== undefined, 'nothing was audited');
      assert.equal(entry.summary['templateId'], templateId);
      assert.equal(entry.summary['delivered'], false);
    });

    it('refuses a template that is not there', async () => {
      await assert.rejects(
        testerWith(recorder().transport).send(testActor, { templateId: 999_999 }),
        (error: unknown) => /no template 999999/.test((error as Error).message),
      );
    });
  },
);

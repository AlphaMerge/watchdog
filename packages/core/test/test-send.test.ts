import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRUBBED } from '@ms/shared';
import { ProgramTransport } from '../src/notifications/delivery/program.js';
import { WebhookTransport } from '../src/notifications/delivery/webhook.js';
import { EmailTransport } from '../src/notifications/delivery/email.js';
import { addressesOnly } from './support/recipients.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationTester } from '../src/notifications/test-send.js';
import { TemplateService } from '../src/notifications/templates.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { Visibility } from '../src/auth/access.js';
import { ScheduleService } from '../src/schedules/service.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';

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
      const report = await testerWith(transport).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });

      assert.equal(report.delivered, true);
      assert.equal(report.detail, 'accepted by relay.example.test');
      assert.equal(report.error, null);
      assert.equal(report.subject, 'Acme production: Ping on edge-router is down');
      assert.match(report.body, /no ICMP reply from 192\.0\.2\.7/);
      assert.deepEqual(report.recipients, [{ kind: 'address', value: 'ops@example.test' }]);
      assert.equal(seen.length, 1, 'and it actually went');
      assert.equal(seen[0]?.subject, report.subject);
    });

    it('echoes the message as its sender may read it, and sends the real one (A-16)', async () => {
      // A sender granted the device alone: the probe above it is outside their view, and the
      // answer they are given leaves it unnamed, as a preview does. Whoever the template names
      // gets the message a real alarm would carry.
      const templateId = await template({ body: 'via %probe, %device at %host' });
      const { seen, transport } = recorder();
      const parent = await db.query<{ parent_id: string }>(
        'SELECT parent_id::text AS parent_id FROM object WHERE id = $1',
        [sensorId],
      );
      const deviceOnly = Visibility.of(
        new Map([[Number(parent[0]?.parent_id), true]]),
        false,
        null,
      );
      const report = await testerWith(transport).send(testActor, {
        seenBy: deviceOnly,
        templateId,
        sensorId,
      });
      assert.equal(report.body, 'via (outside your view), edge-router at 192.0.2.7');
      assert.equal(seen[0]?.body, 'via Local probe, edge-router at 192.0.2.7');
      assert.ok(
        report.notes.some((note) => note.startsWith('Containers outside your view')),
        report.notes.join(' | '),
      );
    });

    it('leaves nothing in the queue behind it', async () => {
      // No `notification_request` row, so nothing is retried, summarised or suppressed — each of
      // which would turn "did my relay work" into "wait fifteen minutes and find out".
      const templateId = await template();
      await testerWith(recorder().transport).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      assert.equal(rows[0]?.n, '0');
    });

    it('makes up a sensor when none is named, and says so', async () => {
      // The first thing an operator does with a new installation is check the relay, and at that
      // point there may be no sensors at all.
      const templateId = await template();
      const report = await testerWith(recorder().transport).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
      });
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
      const report = await testerWith(
        recorder(() => ({ ok: false, retryable: false })).transport,
      ).send(testActor, { seenBy: Visibility.EVERYTHING, templateId, sensorId });
      assert.equal(report.delivered, false);
      assert.equal(report.error, 'the relay refused it');
      assert.equal(report.retryable, false);
      assert.equal(report.detail, null);
    });

    it('shows what the far end said legibly, as a stored delivery error is (N-27)', async () => {
      // A relay's or an endpoint's words, quoting what can rewrite a terminal (ESC), write over
      // the text before it (a lone CR), reorder it (an override), or hide in it (a zero-width
      // space, a tag character). The form and the log get the same escapes `last_error` does.
      const far = 'denied\u001b[2J\rOK \u202eevil re\u200bfused\u{e0041}\r\nline two\tend';
      const shown = 'denied\\u001b[2J\\u000dOK \\u202eevil re\\u200bfused\\u{e0041}\nline two\tend';
      const said = (ok: boolean) => ({
        method: 'email',
        send: () =>
          Promise.resolve(
            ok
              ? ({ ok: true, detail: `queued as ${far}` } as const)
              : ({ ok: false, retryable: false, error: far } as const),
          ),
      });
      const lines: string[] = [];
      const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
      const tester = (transport: object): NotificationTester =>
        new NotificationTester({
          db,
          logger,
          contexts,
          transports: [transport as never],
          audit: new DatabaseAuditSink(),
        });
      const templateId = await template();

      const refused = await tester(said(false)).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      assert.equal(refused.delivered, false);
      assert.equal(refused.error, shown);
      const sent = await tester(said(true)).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      assert.equal(sent.delivered, true);
      assert.equal(sent.detail, `queued as ${shown}`);

      // And in the journal, where pino's JSON would have left the override and the rest as sent.
      const logged = lines.map((line) => JSON.parse(line) as { msg: string; said?: string });
      const told = logged.filter((entry) => entry.msg === 'test notification sent');
      assert.deepEqual(
        told.map((entry) => entry.said),
        [shown, `queued as ${shown}`],
      );
    });

    it('counts who it missed unless the caller may be told who (A-44)', async () => {
      // The restrictive answer is the default, so a caller that forgets to ask tells nobody.
      const skipped = [
        { who: 'user "alice"', reason: 'disabled' },
        { who: '"bob" in group "NOC"', reason: 'may not see this sensor' },
      ] as const;
      const partly = {
        method: 'email',
        send: () => Promise.resolve({ ok: true, detail: 'accepted', skipped } as const),
      };
      const templateId = await template();
      const counted = await testerWith(partly).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      assert.equal(
        counted.detail,
        'accepted; not sent to 2 recipients (1 disabled, 1 may not see this sensor)',
      );
      const named = await testerWith(partly).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
        namesAccounts: true,
      });
      assert.equal(
        named.detail,
        'accepted; not sent to user "alice" (disabled), "bob" in group "NOC" (may not see this sensor)',
      );

      const nobody = {
        method: 'email',
        send: () =>
          Promise.resolve({
            ok: false,
            retryable: false,
            error: 'nobody to send to',
            skipped,
          } as const),
      };
      const failed = await testerWith(nobody).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      assert.equal(
        failed.error,
        'nobody to send to: 2 recipients (1 disabled, 1 may not see this sensor)',
      );
      assert.equal(failed.detail, null);
    });

    it('reports a program’s refusal without the secret argument it was given (A-44)', async () => {
      // The report goes to whoever pressed Test, who may edit the template and never reads its
      // secret arguments. The error is the transport's, so this is the same scrub the log gets.
      const root = await mkdtemp(join(tmpdir(), 'ms-testsend-'));
      try {
        await writeFile(
          join(root, 'refuse.sh'),
          '#!/bin/sh\necho "token $1 refused" >&2\nexit 1\n',
          'utf8',
        );
        await chmod(join(root, 'refuse.sh'), 0o755);
        const program = new ProgramTransport({
          config: { directory: root, maxOutputBytes: 4096, killGraceMs: 500, uid: -1, gid: -1 },
          logger: silent,
        });
        const templateId = await template({
          method: 'program',
          settings: { path: 'refuse.sh', secretArgs: ['hunter2-%sensor'] },
          recipients: [],
        });
        const report = await testerWith(program).send(testActor, {
          seenBy: Visibility.EVERYTHING,
          templateId,
          sensorId,
        });
        assert.equal(report.delivered, false);
        assert.equal(report.error, `refuse.sh exited 1 — token ${SCRUBBED} refused`);
        assert.ok(!JSON.stringify(report).includes('hunter2'), 'the report carried the secret');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('withholds what a program said when the echo hid a container from its sender (A-16)', async () => {
      // The program is handed the real rendering, so it can print the probe's name straight
      // back. The exit code is the sender's to read; the line it printed is not.
      const root = await mkdtemp(join(tmpdir(), 'ms-testsend-'));
      try {
        await writeFile(
          join(root, 'echo.sh'),
          '#!/bin/sh\necho "paged via $1" >&2\nexit "$2"\n',
          'utf8',
        );
        await chmod(join(root, 'echo.sh'), 0o755);
        const program = new ProgramTransport({
          config: { directory: root, maxOutputBytes: 4096, killGraceMs: 500, uid: -1, gid: -1 },
          logger: silent,
        });
        const parent = await db.query<{ parent_id: string }>(
          'SELECT parent_id::text AS parent_id FROM object WHERE id = $1',
          [sensorId],
        );
        const deviceOnly = Visibility.of(
          new Map([[Number(parent[0]?.parent_id), true]]),
          false,
          null,
        );
        const withheld =
          ' (its output is withheld here, because what was sent can name containers outside ' +
          "your view; the full output is in the core's log)";
        for (const [code, expected] of [
          ['3', `echo.sh exited 3${withheld}`],
          ['0', /^echo\.sh exited 0 in \d+ ms$/],
        ] as const) {
          const templateId = await template({
            method: 'program',
            settings: { path: 'echo.sh', args: ['%probe', code] },
            recipients: [],
          });
          const hidden = await testerWith(program).send(testActor, {
            seenBy: deviceOnly,
            templateId,
            sensorId,
          });
          assert.ok(!JSON.stringify(hidden).includes('Local probe'), JSON.stringify(hidden));
          const answer = code === '0' ? hidden.detail : hidden.error;
          if (typeof expected === 'string') assert.equal(answer, expected);
          else assert.match(answer ?? '', expected);

          // Nothing was hidden from an administrator, so they read what the program said.
          const whole = await testerWith(program).send(testActor, {
            seenBy: Visibility.EVERYTHING,
            templateId,
            sensorId,
          });
          if (code === '3') assert.equal(whole.error, 'echo.sh exited 3 — paged via Local probe');
          else assert.match(whole.detail ?? '', /^echo\.sh exited 0 in \d+ ms$/);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('withholds what a mail relay said when the echo hid a container from its sender (A-77)', async () => {
      // A relay's rejection can quote what it was sent, which names the probe. The reply code is
      // the sender's to read; the relay's words are not.
      const relay = {
        host: 'relay.example.test',
        port: 25,
        security: 'none' as const,
        verifyCertificate: true,
        auth: 'none' as const,
        user: '',
        password: '',
        heloName: 'ms-core.test',
        timeoutMs: 1_000,
      };
      const email = new EmailTransport({
        config: {
          sender: 'monitoring@example.test',
          primary: relay,
          fallback: { ...relay, host: '' },
        },
        logger: silent,
        recipients: addressesOnly,
        build: () =>
          ({
            sendMail: (mail: { text?: string }) =>
              Promise.reject(
                Object.assign(new Error(`554 rejected: ${String(mail.text)}`), {
                  responseCode: 554,
                  command: 'DATA',
                }),
              ),
            close: () => undefined,
          }) as never,
      });
      const parent = await db.query<{ parent_id: string }>(
        'SELECT parent_id::text AS parent_id FROM object WHERE id = $1',
        [sensorId],
      );
      const deviceOnly = Visibility.of(
        new Map([[Number(parent[0]?.parent_id), true]]),
        false,
        null,
      );
      const templateId = await template({ body: 'via %probe' });
      const hidden = await testerWith(email).send(testActor, {
        seenBy: deviceOnly,
        templateId,
        sensorId,
      });
      assert.ok(!JSON.stringify(hidden).includes('Local probe'), JSON.stringify(hidden));
      assert.equal(
        hidden.error,
        'primary: the relay answered 554 during DATA (its output is withheld here, because what ' +
          "was sent can name containers outside your view; the full output is in the core's log)",
      );
      // Nothing was hidden from an administrator, so they read what the relay said.
      const whole = await testerWith(email).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      assert.match(whole.error ?? '', /^primary: 554 during DATA: 554 rejected: via Local probe/);
    });

    it('reports a transport that throws, because a 500 explains nothing', async () => {
      const throwing = {
        method: 'email',
        send: () => {
          throw new Error('DNS is on fire');
        },
      };
      const templateId = await template();
      const report = await testerWith(throwing).send(testActor, {
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
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
        seenBy: Visibility.EVERYTHING,
        templateId,
        sensorId,
      });
      assert.equal(report.delivered, false);
      assert.match(String(report.error), /no transport for delivery method "slack"/);
    });

    it('warns that a green test on a switched-off template is not a working alarm', async () => {
      const templateId = await template({ enabled: false });
      const report = await testerWith(recorder().transport).send(testActor, {
        seenBy: Visibility.EVERYTHING,
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
        seenBy: Visibility.EVERYTHING,
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
        seenBy: Visibility.EVERYTHING,
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
        seenBy: Visibility.EVERYTHING,
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
        testerWith(recorder().transport).send(testActor, {
          seenBy: Visibility.EVERYTHING,
          templateId: 999_999,
        }),
        (error: unknown) => /no template 999999/.test((error as Error).message),
      );
    });

    // ---------------------------------------------------------------------------------------
    // Previewing a draft (U-10). The editor has to answer for the text in the box.
    // ---------------------------------------------------------------------------------------

    describe('previewing an unsaved draft', () => {
      const draft = {
        name: 'draft',
        method: 'email',
        settings: {},
        subject: '%sensor on %device is %status',
        body: '%lastmessage',
      };

      it('renders text that has never been saved, against the sensor as it stands', async () => {
        // A preview that only ever showed the last saved version would answer a question nobody
        // asked: the operator is looking at the edit they just made.
        const preview = await templates.previewDraft(draft, sensorId, Visibility.EVERYTHING);
        assert.equal(preview.templateId, null, 'there is no template to name');
        assert.equal(preview.sensorId, sensorId);
        assert.match(preview.subject, /on .* is /);
        assert.ok(!preview.subject.includes('%'), 'every placeholder was substituted');
      });

      it('creates nothing', async () => {
        const before = (await templates.list()).length;
        await templates.previewDraft(draft, sensorId, Visibility.EVERYTHING);
        assert.equal((await templates.list()).length, before);
      });

      it('refuses a draft that could not be saved, with the same message', async () => {
        // Previewing something the operator cannot keep would be a preview of a lie.
        await assert.rejects(
          templates.previewDraft(
            { ...draft, subject: 'hello %sensorr' },
            sensorId,
            Visibility.EVERYTHING,
          ),
          (error: unknown) =>
            /placeholders this build does not know/.test((error as Error).message),
        );
      });

      it('refuses an unknown placeholder in a program argument too', async () => {
        // **`P-121`.** A program template's arguments carry placeholders like any other content
        // and were substituted at send with the result of `substitute` thrown away — so an
        // unknown name was neither refused here nor reported there, and the program was handed
        // the literal text `%lastvlaue` as an argument. Refused at the one moment somebody is
        // looking at it, which is the same rule the subject and body already had.
        await assert.rejects(
          templates.create(testActor, {
            name: 'program-with-a-typo',
            method: 'program',
            settings: { path: 'notify.sh', args: ['--message', '%lastvlaue'] },
            subject: 'x',
            body: 'y',
          }),
          (error: unknown) =>
            /placeholders this build does not know/.test((error as Error).message),
        );
      });

      it('accepts a webhook URL that merely looks like one', async () => {
        // The reason the fields are declared rather than swept: a percent-encoded path segment is
        // indistinguishable from a placeholder, and refusing a correct template would be worse
        // than the hole this closed.
        const created = await templates.create(testActor, {
          name: 'encoded-url',
          method: 'webhook',
          settings: { url: 'https://hooks.example.test/a%AFb', verb: 'POST' },
          subject: 'x',
          body: 'y',
        });
        assert.ok(created.id > 0);
      });

      it('previews a draft whose secret list or object was cleared (U-23 review round 2)', async () => {
        // The editor previews the draft it holds, and after a Clear that holds the secret as
        // `null`, the API's unset. Refused before, as the save was: the schemas take a list and
        // an object there, and a draft merges over nothing stored.
        const plain = await templates.previewDraft(draft, sensorId, Visibility.EVERYTHING);
        const program = await templates.previewDraft(
          {
            ...draft,
            method: 'program',
            settings: { path: 'notify.sh', args: ['--to', '%device'], secretArgs: null },
          },
          sensorId,
          Visibility.EVERYTHING,
        );
        assert.equal(program.subject, plain.subject);
        const webhook = await templates.previewDraft(
          {
            ...draft,
            method: 'webhook',
            settings: { url: 'https://hooks.example.test/pager', secretHeaders: null },
          },
          sensorId,
          Visibility.EVERYTHING,
        );
        assert.equal(webhook.subject, plain.subject);
      });

      it('refuses a sensor that is not there', async () => {
        await assert.rejects(
          templates.previewDraft(draft, 999_999, Visibility.EVERYTHING),
          (error: unknown) => /no sensor 999999/.test((error as Error).message),
        );
      });

      it('renders the same text a saved template would', async () => {
        // The two paths must not drift: one loads from the row and one takes the input, and both
        // go through the same `render`.
        const id = await template({ subject: draft.subject, body: draft.body });
        const saved = await templates.preview(id, sensorId, Visibility.EVERYTHING);
        const unsaved = await templates.previewDraft(draft, sensorId, Visibility.EVERYTHING);
        assert.equal(unsaved.subject, saved.subject);
        assert.equal(unsaved.body, saved.body);
      });
    });

    /**
     * A template re-pointed by somebody who may edit it (`A-40`), through the real webhook
     * transport to a real receiver. Editing a template needs `write`, and a writer never sees the
     * secret headers an administrator set. Before this ticket they could still send them anywhere:
     * change the URL, leave the headers out, press "test".
     */
    describe('a webhook template re-pointed by its editor (A-40)', () => {
      let receiver: Server;
      let port = 0;
      let arrived: { path: string; authorization: string | undefined }[] = [];

      before(async () => {
        receiver = createServer((request, response) => {
          arrived.push({ path: request.url ?? '', authorization: request.headers.authorization });
          // `/echo` refuses with what it was sent, as an endpoint's error page often does.
          const body: Buffer[] = [];
          request.on('data', (chunk: Buffer) => body.push(chunk));
          request.on('end', () => {
            if (request.url === '/echo') response.writeHead(400).end(Buffer.concat(body));
            else response.writeHead(204).end();
          });
        });
        await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
        port = (receiver.address() as AddressInfo).port;
      });

      after(async () => {
        await new Promise<void>((resolve) => {
          receiver.close(() => {
            resolve();
          });
        });
      });

      beforeEach(() => {
        arrived = [];
      });

      // Every name resolves to the receiver above, so "another host" is another name and path.
      const webhook = new WebhookTransport({
        config: { targetPolicy: 'link-local', maxRedirects: 0, userAgent: 'ms-core-test' },
        logger: silent,
        resolve: () => Promise.resolve(['127.0.0.1']),
      });
      const at = (host: string, path: string): string => `http://${host}:${String(port)}${path}`;
      const editor = actorNamed('writer');

      async function pager(): Promise<number> {
        return (
          await templates.create(testActor, {
            name: `Pager-${String(process.hrtime.bigint())}`,
            method: 'webhook',
            settings: {
              url: at('pager.example.test', '/hook'),
              secretHeaders: { authorization: 'Bearer set-by-an-admin' },
            },
            summarisation: 'always-immediate',
          })
        ).id;
      }

      it('sends the secret where it was set to go', async () => {
        // The control: without it, a receiver that saw no secret could mean none was ever sent.
        const templateId = await pager();
        await templates.update(editor, templateId, {
          name: 'Pager, renamed',
          method: 'webhook',
          settings: { url: at('pager.example.test', '/hook') },
          summarisation: 'always-immediate',
        });
        const report = await testerWith(webhook).send(editor, {
          seenBy: Visibility.EVERYTHING,
          templateId,
          sensorId,
        });
        assert.equal(report.delivered, true, report.error ?? '');
        assert.deepEqual(arrived, [{ path: '/hook', authorization: 'Bearer set-by-an-admin' }]);
      });

      it('sends no secret to where an editor re-pointed it', async () => {
        const templateId = await pager();
        await templates.update(editor, templateId, {
          name: 'Pager',
          method: 'webhook',
          settings: { url: at('collector.attacker.test', '/steal') },
          summarisation: 'always-immediate',
        });
        const report = await testerWith(webhook).send(editor, {
          seenBy: Visibility.EVERYTHING,
          templateId,
          sensorId,
        });
        assert.equal(report.delivered, true, report.error ?? '');
        assert.deepEqual(arrived, [{ path: '/steal', authorization: undefined }]);
      });

      it('withholds what an endpoint answered when the echo hid a container (A-16)', async () => {
        const { id: templateId } = await templates.create(testActor, {
          name: `Echo-${String(process.hrtime.bigint())}`,
          method: 'webhook',
          settings: { url: at('pager.example.test', '/echo') },
          body: 'paged via %probe',
          summarisation: 'always-immediate',
        });
        const parent = await db.query<{ parent_id: string }>(
          'SELECT parent_id::text AS parent_id FROM object WHERE id = $1',
          [sensorId],
        );
        const deviceOnly = Visibility.of(
          new Map([[Number(parent[0]?.parent_id), true]]),
          false,
          null,
        );
        const hidden = await testerWith(webhook).send(editor, {
          seenBy: deviceOnly,
          templateId,
          sensorId,
        });
        assert.ok(!JSON.stringify(hidden).includes('Local probe'), JSON.stringify(hidden));
        assert.equal(
          hidden.error,
          `400 from pager.example.test:${String(port)} (its output is withheld here, because ` +
            'what was sent can name containers outside your view; the full output is in the ' +
            "core's log)",
        );
        const whole = await testerWith(webhook).send(testActor, {
          seenBy: Visibility.EVERYTHING,
          templateId,
          sensorId,
        });
        assert.match(whole.error ?? '', /^400 from pager\.example\.test:\d+ — .*Local probe/);
      });

      it('says the policy refused a URL that gives a metadata address in brackets', async () => {
        // `A-58`, through the system's resolver as the shipped transport has it. The template
        // saves, and the test send answers with the refusal instead of a name that did not
        // resolve.
        const shipped = new WebhookTransport({
          config: { targetPolicy: 'link-local', maxRedirects: 0, userAgent: 'ms-core-test' },
          logger: silent,
        });
        const { id: templateId } = await templates.create(testActor, {
          name: `Literal-${String(process.hrtime.bigint())}`,
          method: 'webhook',
          settings: { url: at('[fd00:ec2::254]', '/hook') },
          summarisation: 'always-immediate',
        });
        const report = await testerWith(shipped).send(testActor, {
          seenBy: Visibility.EVERYTHING,
          templateId,
          sensorId,
        });
        assert.equal(report.delivered, false);
        assert.match(report.error ?? '', /fd00:ec2::254 refused by the target policy/);
        assert.deepEqual(arrived, []);
      });
    });
  },
);

import { strict as assert } from 'node:assert';
import { assertWellFormed } from './support/xml.js';
import { readPdf } from './support/pdf.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { AccessService } from '../src/auth/access.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ReportContext } from '../src/reports/context.js';
import { ReportRenderer } from '../src/reports/render.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService, type ReportViewer } from '../src/reports/service.js';
import { ReportRunRepository, ReportRunner } from '../src/reports/runs.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  ReportDelivery,
  ReportOutputRepository,
  backoffMs,
  filenameFor,
} from '../src/reports/delivery.js';
import { validateOutputs } from '../src/reports/outputs.js';
import { ReportFormatter } from '../src/reports/formatter.js';
import type { DocumentMessage } from '../src/notifications/delivery/email.js';
import type { DeliveryResult } from '../src/notifications/delivery/transport.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, actorNamed } from './support/tree.js';
import { DatabaseAuditSink } from '../src/audit/store.js';

const available = await databaseAvailable();

/**
 * Storing a report and getting it to somebody (`E-09`, `ADR-005`).
 *
 * The rule under test is `CLAUDE.md`'s, not a new one: **a scheduled report that cannot deliver
 * must not retry into a storm, and must not fail silently either**. Every case below is one half
 * of that — bounded attempts, a permanent rejection that is not retried at all, one row holding
 * one state, and a terminal failure that stays terminal.
 */
describe('delivering a report', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let reports: ReportService;
  let repository: ReportRepository;
  let runs: ReportRunRepository;
  let outputs: ReportOutputRepository;
  let delivery: ReportDelivery;
  let formatter: ReportFormatter;
  let runner: ReportRunner;
  let clock: Date;

  const sent: DocumentMessage[] = [];
  const relay: { answer: DeliveryResult } = { answer: { ok: true, detail: 'test relay' } };

  let sensorId: number;
  let author: { id: number; login: string };

  before(async () => {
    scratch = await createScratchDatabase('reportdelivery');
    db = scratch.db;
    const harness = await buildHarness(db);
    repository = new ReportRepository();
    runs = new ReportRunRepository();
    outputs = new ReportOutputRepository();
    reports = new ReportService({
      db,
      repository,
      audit: new DatabaseAuditSink(),
      logger: silent,
    });
    clock = new Date('2026-09-11T05:00:00.000Z');
    formatter = new ReportFormatter({ logger: silent });
    delivery = new ReportDelivery({
      db,
      outputs,
      formatter,
      email: {
        sendDocument: (message) => {
          sent.push(message);
          return Promise.resolve(relay.answer);
        },
      },
      logger: silent,
      now: () => clock,
    });
    runner = new ReportRunner({
      db,
      reports: repository,
      runs,
      renderer: new ReportRenderer({
        context: new ReportContext({
          db,
          repository,
          access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          logger: silent,
        }),
        history: new HistoryService({ db, logger: silent }),
        logger: silent,
      }),
      delivery,
      logger: silent,
      now: () => clock,
    });

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      name: 'deliver-probe',
      parentId: harness.rootId,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      name: 'deliver-device',
      parentId: probe.id,
      host: '10.0.0.12',
    });
    sensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'deliver-sensor',
        parentId: device.id,
        sensorType: 'icmp.ping',
      })
    ).id;

    const group = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('deliverers') RETURNING id`,
    );
    const account = await db.query<{ id: string }>(
      `INSERT INTO user_account (login, display_name, password_hash, role)
       VALUES ('deliverer', 'deliverer', 'x', 'readwrite') RETURNING id`,
    );
    author = { id: Number(account[0]?.id), login: 'deliverer' };
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
      [Number(group[0]?.id), author.id],
    );
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'read')`,
      [harness.rootId, Number(group[0]?.id)],
    );
  });

  after(async () => {
    await formatter.close();
    await scratch.drop();
  });

  beforeEach(() => {
    sent.length = 0;
    relay.answer = { ok: true, detail: 'test relay' };
  });

  const viewer = (userId: number): ReportViewer => ({ userId, role: 'readwrite' });

  let seq = 0;
  const runWith = async (outputsDocument: Record<string, unknown>) => {
    seq += 1;
    const report = await reports.create(
      viewer(author.id),
      {
        name: `deliver ${String(seq)}`,
        kind: 'table_only',
        subjects: { objectIds: [sensorId] },
        span: { kind: 'day', offset: 1, timezone: 'UTC' },
        outputs: outputsDocument,
      },
      actorNamed(author.login),
    );
    return runner.runNow(report, author.login);
  };

  describe('stores what it rendered', () => {
    it('keeps one row per format, named after the report and the period', () => {
      // A filename is the two facts somebody reading a directory listing needs, and neither is
      // recoverable from the other.
      assert.equal(
        filenameFor({ name: 'Monthly Uptime: EU' }, '2026-08 (Europe/Berlin)', 'csv'),
        'Monthly-Uptime-EU_2026-08-Europe-Berlin.csv',
      );
    });

    it('stores both formats when both were asked for', async () => {
      const run = await runWith({ formats: ['html', 'csv'], delivery: 'store' });
      const stored = await outputs.list(db, run.id);
      // `html` first, and that is the enum's declaration order rather than the alphabet:
      // PostgreSQL orders an enum column by how the type was declared, which is stable and puts
      // the primary format first.
      assert.deepEqual(
        stored.map((one) => one.format),
        ['html', 'csv'],
      );
      for (const file of stored) {
        assert.ok(file.byteSize > 0);
        assert.match(file.sha256, /^[0-9a-f]{64}$/u);
      }
      const html = await outputs.read(db, run.id, 'html');
      assert.ok(html?.body.toString('utf8').startsWith('<!doctype html>'));
      assert.equal(run.delivery.state, 'none', 'a stored-only report is not waiting on anything');
    });

    it('stores an XML rendering beside the others, in the declared order (E-07)', async () => {
      const run = await runWith({ formats: ['html', 'csv', 'xml'], delivery: 'store' });
      const stored = await outputs.list(db, run.id);
      // Migration 050 put `xml` before `zip` rather than after it, so the renderings stay together
      // and the container that wraps them stays last.
      assert.deepEqual(
        stored.map((one) => one.format),
        ['html', 'csv', 'xml'],
      );
      const xml = await outputs.read(db, run.id, 'xml');
      assert.ok(xml);
      const body = xml.body.toString('utf8');
      assert.ok(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), body.slice(0, 60));
      assertWellFormed(body);
      assert.match(xml.filename, /\.xml$/u);
    });

    it('stores a PDF laid out by us, with the font embedded (E-06)', async () => {
      const run = await runWith({ formats: ['html', 'pdf'], delivery: 'store' });
      const stored = await outputs.list(db, run.id);
      assert.deepEqual(
        stored.map((one) => one.format),
        ['html', 'pdf'],
      );
      const pdf = await outputs.read(db, run.id, 'pdf');
      assert.ok(pdf);
      assert.equal(pdf.body.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.match(pdf.filename, /\.pdf$/u);
      const readout = readPdf(pdf.body);
      assert.ok(readout.pageCount >= 1);
      // The font travels inside the document, so the reader needs nothing installed — which is
      // what `ADR-006` Decision 2 bought, and what a system font would not have.
      assert.ok(
        readout.fonts.some((font) => font.endsWith('+DejaVuSans')),
        readout.fonts.join(','),
      );
    });

    it('replaces the parts with one archive when zip is on', async () => {
      // `§6` calls this "optional ZIP", singular. An email carrying both the archive and the files
      // in it is twice the size and asks the recipient which one to open.
      const run = await runWith({ formats: ['html', 'csv'], delivery: 'store', zip: true });
      const stored = await outputs.list(db, run.id);
      assert.deepEqual(
        stored.map((one) => one.format),
        ['zip'],
      );
      const zip = await outputs.read(db, run.id, 'zip');
      assert.ok(zip);
      assert.equal(zip.body.readUInt32LE(0), 0x04_03_4b_50, 'a local file header');
      assert.equal(zip.body.readUInt16LE(zip.body.length - 22 + 10), 2, 'holding both files');
    });
  });

  describe('gets it to somebody, and says so when it cannot', () => {
    it('sends the stored files as attachments, through N-07’s transport', async () => {
      const run = await runWith({
        formats: ['csv'],
        delivery: 'store-and-email',
        recipients: ['ops@example.test'],
      });
      assert.equal(run.delivery.state, 'pending', 'armed by the render, not sent by it');

      assert.equal(await delivery.tick(), 1);
      const message = sent[0];
      assert.ok(message);
      assert.deepEqual(message.recipients, ['ops@example.test']);
      assert.equal(message.attachments.length, 1);
      assert.equal(message.attachments[0]?.contentType, 'text/csv; charset=utf-8');
      assert.ok(message.subject.includes('deliver'), message.subject);

      const after_ = await runs.find(db, run.id);
      assert.ok(after_);
      assert.equal(after_.delivery.state, 'sent');
      assert.ok(after_.delivery.deliveredAt);
      assert.equal(after_.delivery.nextAttemptAt, null, 'and is out of the sweep’s query');
    });

    it('keeps the stored copy for store-and-email and discards it for email-only', async () => {
      // `ADR-005` Decision 4: email-only stores briefly because a retry needs the bytes, and a
      // re-render months later is a different document. It keeps nothing afterwards.
      const kept = await runWith({
        formats: ['html'],
        delivery: 'store-and-email',
        recipients: ['ops@example.test'],
      });
      const transient = await runWith({
        formats: ['html'],
        delivery: 'email',
        recipients: ['ops@example.test'],
      });
      assert.equal((await outputs.list(db, transient.id)).length, 1, 'stored while it waits');

      await delivery.tick();
      assert.equal((await outputs.list(db, kept.id)).length, 1, 'store-and-email keeps it');
      assert.equal((await outputs.list(db, transient.id)).length, 0, 'email-only does not');
    });

    it('retries a relay that might work later, with a growing delay', async () => {
      relay.answer = { ok: false, error: '451 try again', retryable: true };
      const run = await runWith({
        formats: ['csv'],
        delivery: 'email',
        recipients: ['ops@example.test'],
      });

      await delivery.tick();
      const first = await runs.find(db, run.id);
      assert.ok(first);
      assert.equal(first.delivery.state, 'pending', 'still pending, not failed');
      assert.equal(first.delivery.attempts, 1);
      assert.match(first.delivery.error, /451/u);
      assert.equal(
        first.delivery.nextAttemptAt?.getTime(),
        clock.getTime() + backoffMs(0),
        'and is not tried again immediately',
      );

      // Not due yet: the whole point of a delay is that the next sweep leaves it alone.
      assert.equal(await delivery.tick(), 0);
      assert.equal((await runs.find(db, run.id))?.delivery.attempts, 1, 'and did not count again');
    });

    it('stops after a bounded number of attempts, and stays stopped', async () => {
      // **The storm this rule exists to prevent.** A relay down for a day must not be a report
      // retrying every minute for a day, and must not be a report that quietly gave up either.
      relay.answer = { ok: false, error: '451 try again', retryable: true };
      const address = 'bounded@example.test';
      const run = await runWith({ formats: ['csv'], delivery: 'email', recipients: [address] });

      for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS + 3; attempt += 1) {
        await delivery.tick();
        clock = new Date(clock.getTime() + 2 * 60 * 60_000);
      }
      const after_ = await runs.find(db, run.id);
      assert.ok(after_);
      assert.equal(after_.delivery.state, 'failed');
      assert.equal(after_.delivery.attempts, MAX_DELIVERY_ATTEMPTS);
      // Counted by recipient rather than by the length of `sent`: an earlier case leaves its own
      // report pending on purpose, and the sweep is global. A test that assumed it was the only
      // thing in the queue would pass today and fail whenever a case is added above it.
      assert.equal(
        sent.filter((one) => one.recipients.includes(address)).length,
        MAX_DELIVERY_ATTEMPTS,
        'and tried exactly that many times',
      );
      assert.equal(after_.delivery.nextAttemptAt, null, 'nothing re-arms it on a timer');

      // And the output is kept: deleting the evidence of a failure is the opposite of what
      // somebody investigating one needs (`ADR-005` Decision 4).
      assert.equal((await outputs.list(db, run.id)).length, 1);
    });

    it('does not retry a rejection no amount of waiting will fix', async () => {
      // `N-07`'s transport already tells a refused address from a relay that timed out, which is
      // exactly the distinction that decides whether waiting can help. Retrying the first is how
      // a queue fills with mail nobody will ever receive.
      relay.answer = { ok: false, error: '550 no such mailbox', retryable: false };
      const run = await runWith({
        formats: ['csv'],
        delivery: 'email',
        recipients: ['nobody@example.test'],
      });

      await delivery.tick();
      const after_ = await runs.find(db, run.id);
      assert.ok(after_);
      assert.equal(after_.delivery.state, 'failed');
      assert.equal(after_.delivery.attempts, 1, 'once, not five times');
      assert.match(after_.delivery.error, /550/u);
    });

    it('counts what is still waiting, so a backlog is visible while it is one', async () => {
      // `CLAUDE.md`: backpressure is visible, never silent. A gauge rather than a counter — the
      // question is how many are stuck *now*.
      relay.answer = { ok: false, error: '451 try again', retryable: true };
      await runWith({ formats: ['csv'], delivery: 'email', recipients: ['a@example.test'] });
      await runWith({ formats: ['csv'], delivery: 'email', recipients: ['b@example.test'] });

      await delivery.tick();
      assert.equal(delivery.stats().pending, 2);

      relay.answer = { ok: true, detail: 'back up' };
      clock = new Date(clock.getTime() + 2 * 60 * 60_000);
      await delivery.tick();
      assert.equal(delivery.stats().pending, 0, 'and falls when the relay recovers');
    });

    it('gives up permanently when the bytes are gone', async () => {
      // Reachable only if retention or a hand-edit removed the output underneath a pending
      // delivery. There is nothing to send and nothing to wait for.
      const run = await runWith({
        formats: ['csv'],
        delivery: 'email',
        recipients: ['ops@example.test'],
      });
      await outputs.discard(db, run.id);

      await delivery.tick();
      const after_ = await runs.find(db, run.id);
      assert.ok(after_);
      assert.equal(after_.delivery.state, 'failed');
      assert.match(after_.delivery.error, /no longer stored/u);
      assert.equal(sent.length, 0, 'and did not send an empty email');
    });
  });

  describe('is checked on the write', () => {
    it('refuses an email delivery with nowhere to send it', () => {
      // Refused at the write rather than at 03:00: a report set to email with no recipients
      // renders every month, fails, and is found by somebody asking where the report is.
      assert.throws(
        () => validateOutputs({ formats: ['csv'], delivery: 'email' }),
        /needs at least one recipient/u,
      );
      assert.throws(
        () => validateOutputs({ formats: ['csv'], delivery: 'store', recipients: ['a@b.test'] }),
        /a stored report has no recipients/u,
      );
    });

    it('refuses an address a header could be injected through', () => {
      for (const bad of ['ops@example.test\nBcc: evil@x', 'no-at-sign', 'a b@example.test', '']) {
        assert.throws(
          () => validateOutputs({ delivery: 'email', recipients: [bad] }),
          /is not an email address/u,
          JSON.stringify(bad),
        );
      }
    });

    it('refuses a format nothing renders, and deduplicates one asked for twice', () => {
      assert.throws(() => validateOutputs({ formats: ['docx'] }), /no report format called/u);
      assert.throws(() => validateOutputs({ formats: [] }), /at least one format/u);
      assert.deepEqual(validateOutputs({ formats: ['html', 'html', 'csv'] }).formats, [
        'html',
        'csv',
      ]);
    });

    it('defaults to storing HTML and sending nothing', () => {
      // Creating a report must not arrange for this system to send mail, which is the same reason
      // `E-08`'s schedule defaults to manual.
      assert.deepEqual(validateOutputs({}), {
        formats: ['html'],
        delivery: 'store',
        recipients: [],
        zip: false,
      });
    });
  });
});

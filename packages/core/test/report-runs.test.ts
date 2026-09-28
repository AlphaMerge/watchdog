import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { AccessService } from '../src/auth/access.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ReportContext } from '../src/reports/context.js';
import { ReportRenderer } from '../src/reports/render.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService, type ReportViewer } from '../src/reports/service.js';
import { ReportRunRepository, ReportRunner, type ReportRanEvent } from '../src/reports/runs.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, actorNamed } from './support/tree.js';
import { DatabaseAuditSink } from '../src/audit/store.js';

const available = await databaseAvailable();
const MINUTE = 60_000;

/**
 * Running a report (`E-08`).
 *
 * The claims here are the ones only a database can settle: that two attempts to run the same
 * report cannot both win, that a booking is written before the render so a failure does not leave
 * a report due for ever, that a core killed mid-render does not leave a report permanently
 * unrunnable, and that a run that fails says why in a row somebody can query.
 */
describe('running a report', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let reports: ReportService;
  let repository: ReportRepository;
  let runs: ReportRunRepository;
  let runner: ReportRunner;
  let audited: ReportRanEvent[];
  let clock: Date;

  let sensorId: number;
  let author: { id: number; login: string };

  before(async () => {
    scratch = await createScratchDatabase('reportruns');
    db = scratch.db;
    const harness = await buildHarness(db);
    repository = new ReportRepository();
    const context = new ReportContext({
      db,
      repository,
      access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
      logger: silent,
    });
    reports = new ReportService({
      db,
      repository,
      audit: new DatabaseAuditSink(),
      logger: silent,
    });
    runs = new ReportRunRepository();
    audited = [];
    clock = new Date('2026-09-11T05:00:00.000Z');
    runner = new ReportRunner({
      db,
      reports: repository,
      runs,
      renderer: new ReportRenderer({
        context,
        history: new HistoryService({ db, logger: silent }),
        logger: silent,
      }),
      logger: silent,
      now: () => clock,
      audit: (event) => {
        audited.push(event);
        return Promise.resolve();
      },
    });

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      name: 'run-probe',
      parentId: harness.rootId,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      name: 'run-device',
      parentId: probe.id,
      host: '10.0.0.11',
    });
    sensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'run-sensor',
        parentId: device.id,
        sensorType: 'icmp.ping',
      })
    ).id;

    const group = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('runners') RETURNING id`,
    );
    const account = await db.query<{ id: string }>(
      `INSERT INTO user_account (login, display_name, password_hash, role)
       VALUES ('runner', 'runner', 'x', 'readwrite') RETURNING id`,
    );
    author = { id: Number(account[0]?.id), login: 'runner' };
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
    await scratch.drop();
  });

  beforeEach(() => {
    audited.length = 0;
  });

  const viewer = (userId: number): ReportViewer => ({ userId, role: 'readwrite' });

  let seq = 0;
  const make = async (schedule?: Record<string, unknown>, subjects = [sensorId]) => {
    seq += 1;
    return reports.create(
      viewer(author.id),
      {
        name: `run-${String(seq)}`,
        kind: 'table_only',
        subjects: { objectIds: subjects },
        span: { kind: 'day', offset: 1, timezone: 'UTC' },
        ...(schedule === undefined ? {} : { schedule }),
      },
      actorNamed(author.login),
    );
  };

  describe('records what happened, in a row somebody can query', () => {
    it('succeeds, and says what period it covered and how big it was', async () => {
      // A run row that said only "succeeded at 03:00" cannot answer "do we have August", which
      // is the question somebody actually asks.
      const report = await make();
      const run = await runner.runNow(report, author.login);

      assert.equal(run.state, 'succeeded');
      assert.equal(run.trigger, 'manual');
      assert.equal(run.requestedBy, author.login);
      assert.match(run.spanLabel, /^\d{4}-\d{2}-\d{2} \(UTC\)$/u, run.spanLabel);
      assert.equal(run.sections, 1);
      assert.equal(run.unavailable, 0);
      assert.ok((run.durationMs ?? -1) >= 0);
      assert.equal((await runs.list(db, report.id, 10)).at(0)?.id, run.id);
    });

    it('records a failure with the code the API would have answered', async () => {
      // So an operator reading this row and an operator reading a 422 are told the same thing.
      const report = await make();
      await db.query(`UPDATE user_account SET disabled = true WHERE id = $1`, [author.id]);
      try {
        const run = await runner.runNow(
          await reports.get(viewer(author.id), report.id),
          author.login,
        );
        assert.equal(run.state, 'failed');
        assert.equal(run.errorCode, 'REPORT_NO_CONTEXT');
        assert.match(run.errorMessage, /disabled/u);
      } finally {
        await db.query(`UPDATE user_account SET disabled = false WHERE id = $1`, [author.id]);
      }
    });

    it('writes the audit row E-03 deferred, naming both accounts', async () => {
      // **The auditable fact is the act-as.** Who asked and whose visibility it used are
      // different questions, and the second decides what left the building.
      const report = await make();
      await runner.runNow(report, 'someone-else');

      const event = audited[0];
      assert.ok(event);
      assert.equal(event.requestedBy, 'someone-else');
      assert.equal(event.runAs, author.login);
      assert.equal(event.outcome, 'succeeded');
      assert.equal(event.reportId, report.id);
    });

    it('still records the run when the audit sink is broken', async () => {
      // An audit sink that is briefly unavailable must not turn a successful report into a
      // failed one: the run row is the operational record and is already written.
      const broken = new ReportRunner({
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
        logger: silent,
        now: () => clock,
        audit: () => Promise.reject(new Error('the sink is down')),
      });
      const report = await make();
      const run = await broken.runNow(report, author.login);
      assert.equal(run.state, 'succeeded');
    });
  });

  describe('runs one at a time, and the database is what says so', () => {
    it('refuses a second run while one is in flight', async () => {
      // A button pressed six times must not become six renders competing for the same pool. The
      // guard is a partial unique index, so two requests racing lose at the database rather than
      // in a window between a check and an insert.
      const report = await make();
      const claimed = await runs.claim(db, report.id, 'manual', 'first');
      assert.ok(claimed);

      await assert.rejects(
        () => runner.runNow(report, 'second'),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_BUSY');
          assert.equal((error as { status: number }).status, 409);
          return true;
        },
      );
      assert.equal(runner.stats().rejectedBusy, 1);

      // And once that run finishes, the next one is allowed — the constraint is over the
      // unfinished states, not over the report.
      await runs.finish(db, claimed.id, {
        state: 'succeeded',
        spanLabel: 'x',
        sections: 0,
        unavailable: 0,
        cells: 0,
      });
      assert.equal((await runner.runNow(report, 'third')).state, 'succeeded');
    });

    it('clears a run the core abandoned, rather than leaving the report stuck', async () => {
      // **A `kill -9` in the middle of a render.** `running` is a claim about a process that no
      // longer exists, and the partial unique index would otherwise keep that report unrunnable
      // for ever: every later attempt collides with a row nothing will finish.
      const report = await make();
      const orphan = await runs.claim(db, report.id, 'scheduled', '');
      assert.ok(orphan);

      assert.equal(await runner.recover(), 1);
      const reaped = await runs.find(db, orphan.id);
      assert.ok(reaped);
      assert.equal(reaped.state, 'failed');
      assert.equal(reaped.errorCode, 'REPORT_INTERRUPTED');
      assert.equal((await runner.runNow(report, author.login)).state, 'succeeded');
    });
  });

  describe('books the next run before it renders', () => {
    it('moves the booking forward even when the render fails', async () => {
      // **The failure `D-07` arrived at the same way.** Booking afterwards means a render that
      // throws leaves the report due for ever, and the sweep retries the same failing report
      // every minute instead of once a day.
      const report = await make({ kind: 'daily', minute: 180, timezone: 'UTC' });
      const due = new Date(clock.getTime() - MINUTE);
      await db.query(`UPDATE report SET next_run_at = $2 WHERE id = $1`, [report.id, due]);

      await db.query(`UPDATE user_account SET disabled = true WHERE id = $1`, [author.id]);
      try {
        assert.equal(await runner.tick(), 1);
      } finally {
        await db.query(`UPDATE user_account SET disabled = false WHERE id = $1`, [author.id]);
      }

      const after_ = await repository.find(db, report.id);
      assert.ok(after_?.nextRunAt);
      assert.ok(after_.nextRunAt.getTime() > clock.getTime(), 'the booking moved past now');
      assert.equal((await runs.list(db, report.id, 1))[0]?.state, 'failed');
    });

    it('gives a manual report no next run at all', async () => {
      // Not an error and not "now": a client has to be able to show "this does not run on its
      // own" rather than a missing date.
      const report = await make({ kind: 'manual' });
      assert.equal(await runner.reschedule(report), null);
      assert.equal((await repository.find(db, report.id))?.nextRunAt, null);
    });

    it('books a schedule the moment it is set, without waiting for a sweep', async () => {
      const report = await make({ kind: 'hourly', minute: 30, timezone: 'UTC' });
      const next = await runner.reschedule(report);
      assert.ok(next);
      assert.equal(next.toISOString(), '2026-09-11T05:30:00.000Z');
      assert.equal((await repository.find(db, report.id))?.nextRunAt?.getTime(), next.getTime());
    });

    it('does not book the instant it was called at, which would loop for ever', async () => {
      // The sweep books from a clock that can land exactly on a firing minute. A booking equal to
      // now is found due on the next tick, and the report runs every minute.
      const report = await make({ kind: 'hourly', minute: 0, timezone: 'UTC' });
      const onTheHour = new Date('2026-09-11T05:00:00.000Z');
      const next = await runner.reschedule(report, onTheHour);
      assert.ok(next);
      assert.ok(next.getTime() > onTheHour.getTime(), next.toISOString());
    });
  });

  describe('is a queue, and says when it is full', () => {
    it('starts what is due and counts what it deferred', async () => {
      // `CLAUDE.md`: backpressure is visible, never silent. A backlog of due reports is the shape
      // of an installation that has scheduled more than it can render, and nothing else says so.
      const bounded = new ReportRunner({
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
        logger: silent,
        now: () => clock,
        maxConcurrent: 1,
      });

      const due = new Date(clock.getTime() - MINUTE);
      const made = [await make({ kind: 'daily' }), await make({ kind: 'daily' })];
      for (const report of made) {
        await db.query(`UPDATE report SET next_run_at = $2 WHERE id = $1`, [report.id, due]);
      }

      assert.equal(await bounded.tick(), 1, 'one at a time');
      assert.equal(bounded.stats().deferred, 1, 'and the other is counted');
      assert.equal(await bounded.tick(), 1, 'the next sweep takes it');
    });

    it('skips a report that is hours behind rather than running a burst of them', async () => {
      // A core that was down for two days would otherwise run every missed occurrence at once,
      // each covering a period the next one also covers. The booking has already moved on, so
      // the next run is on time — and the skip is said out loud rather than being a gap.
      const report = await make({ kind: 'hourly', minute: 0, timezone: 'UTC' });
      const ancient = new Date(clock.getTime() - 48 * 60 * MINUTE);
      await db.query(`UPDATE report SET next_run_at = $2 WHERE id = $1`, [report.id, ancient]);

      assert.equal(await runner.tick(), 0, 'nothing ran');
      const booked = await repository.find(db, report.id);
      assert.ok(booked?.nextRunAt);
      assert.ok(booked.nextRunAt.getTime() > clock.getTime(), 'but the booking is current again');
      assert.equal((await runs.list(db, report.id, 1)).length, 0, 'and no run was recorded');
    });

    it('leaves a report that is not due alone', async () => {
      const report = await make({ kind: 'daily' });
      await db.query(`UPDATE report SET next_run_at = $2 WHERE id = $1`, [
        report.id,
        new Date(clock.getTime() + 60 * MINUTE),
      ]);
      assert.equal(await runner.tick(), 0);
      assert.equal((await runs.list(db, report.id, 1)).length, 0);
    });
  });
});

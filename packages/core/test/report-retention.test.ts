import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { HousekeepingConfig } from '@ms/shared';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import type { Database } from '../src/db/pool.js';
import { ReportOutputRepository } from '../src/reports/delivery.js';
import { ReportRunRepository } from '../src/reports/runs.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';

/**
 * Retention for stored reports (`E-10`, `ADR-005`).
 *
 * **`ADR-005` accepted a cost and this is where it is paid.** Putting report documents in the
 * database was decided on the strength of one backup rather than two; the price is that backups
 * grow with what is kept, and the ADR says plainly that the default cannot be "forever".
 *
 * Two horizons, because the two things are not the same size: a document is kilobytes and is what
 * fills a disk, a run row is a few hundred bytes and answers "has this been failing since August".
 *
 * The cases that matter most are the two refusals. Retention must not delete the bytes under a
 * delivery that is still queued — `E-09` treats missing bytes as a *permanent* failure, so that
 * would be this system manufacturing the one failure it cannot recover from — and it must not
 * delete a run that is still rendering, which would free the partial unique index and let a second
 * render start beside the first.
 */

const available = await databaseAvailable();
const DAY_MS = 86_400_000;

function housekeeping(reportDays: number, reportRunDays: number): HousekeepingConfig {
  return {
    enabled: false,
    intervalSeconds: 300,
    rollupLagSeconds: 0,
    retention: {
      rawDays: 40,
      fiveMinuteDays: 365,
      hourlyDays: 730,
      dailyDays: 3_650,
      auditDays: 730,
      stateDays: 3_650,
      reportDays,
      reportRunDays,
    },
    compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
    disk: { path: '', evictBelowPercent: 10, recoverAbovePercent: 15, minimumRetainedHours: 48 },
  };
}

describe('report retention', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let outputs: ReportOutputRepository;
  let runs: ReportRunRepository;
  let reportId: number;

  before(async () => {
    scratch = await createScratchDatabase('reportretention');
    db = scratch.db;
    await buildHarness(db);
    outputs = new ReportOutputRepository();
    runs = new ReportRunRepository();

    const account = await db.query<{ id: string }>(
      `INSERT INTO user_account (login, display_name, password_hash, role)
       VALUES ('keeper', 'keeper', 'x', 'readwrite') RETURNING id`,
    );
    const rows = await db.query<{ id: string }>(
      `INSERT INTO report (name, kind, run_as_user_id, run_as_login)
       VALUES ('kept', 'table_only', $1, 'keeper') RETURNING id`,
      [Number(account[0]?.id)],
    );
    reportId = Number(rows[0]?.id);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM report_run WHERE report_id = $1`, [reportId]);
  });

  /**
   * A finished run, aged by moving its timestamps back.
   *
   * Written straight to the table rather than through `ReportRunner`: what is under test is the
   * `DELETE`, and rendering a real report to get a row would make every case depend on the
   * renderer as well.
   */
  const makeRun = async (
    ageDays: number,
    options: {
      state?: 'running' | 'succeeded' | 'failed';
      delivery?: 'none' | 'pending' | 'sent' | 'failed';
      withOutput?: boolean;
      outputAgeDays?: number;
    } = {},
  ): Promise<number> => {
    const at = new Date(Date.now() - ageDays * DAY_MS);
    const rows = await db.query<{ id: string }>(
      `INSERT INTO report_run (report_id, trigger, state, queued_at, started_at, delivery_state)
       VALUES ($1, 'scheduled', $2, $3, $3, $4) RETURNING id`,
      [reportId, options.state ?? 'succeeded', at, options.delivery ?? 'none'],
    );
    const runId = Number(rows[0]?.id);
    if (options.withOutput !== false) {
      await outputs.store(db, runId, {
        format: 'html',
        filename: 'kept.html',
        body: Buffer.from('<table></table>'),
      });
      await db.query(`UPDATE report_output SET created_at = $2 WHERE run_id = $1`, [
        runId,
        new Date(Date.now() - (options.outputAgeDays ?? ageDays) * DAY_MS),
      ]);
    }
    return runId;
  };

  const sweep = async (reportDays: number, reportRunDays: number) =>
    new Housekeeper({
      db,
      logger: silent,
      config: housekeeping(reportDays, reportRunDays),
    }).runOnce();

  const outputCount = async (runId: number): Promise<number> =>
    (await outputs.list(db, runId)).length;

  it('deletes a document past its horizon and keeps the run that produced it', async () => {
    // The two horizons doing what they are for: the kilobytes go, the record stays.
    const old = await makeRun(120);
    const recent = await makeRun(10);

    const report = await sweep(90, 730);
    assert.equal(report.prunedReportOutputs, 1);
    assert.equal(report.prunedReportRuns, 0);
    assert.equal(await outputCount(old), 0);
    assert.equal(await outputCount(recent), 1, 'and left the one inside the horizon alone');
    assert.ok(await runs.find(db, old), 'the run row survived its document');
  });

  it('does not run in a build that has no reporting (`H-12`)', async () => {
    // The v1 profile constructs no reporting, and its housekeeper does not reach for the tables.
    // Rows left by a full build are kept, not pruned by a subsystem that is not running.
    const old = await makeRun(800);
    const report = await new Housekeeper({
      db,
      logger: silent,
      config: housekeeping(90, 730),
      reports: false,
    }).runOnce();
    assert.equal(report.prunedReportOutputs, 0);
    assert.equal(report.prunedReportRuns, 0);
    assert.ok(await runs.find(db, old), 'the run is still there');
    assert.equal(await outputCount(old), 1);
  });

  it('deletes a run past its own horizon, taking any document with it', async () => {
    const ancient = await makeRun(800);
    const report = await sweep(90, 730);
    assert.equal(report.prunedReportRuns, 1);
    assert.equal(await runs.find(db, ancient), undefined);
    assert.equal(await outputCount(ancient), 0, 'the cascade took the document');
  });

  it('lets the shorter horizon win when the run’s is set below the document’s', async () => {
    // A coherent configuration rather than a contradiction, and it needs no cross-field
    // validation to be safe: deleting the run cascades.
    const run = await makeRun(60);
    const report = await sweep(90, 30);
    assert.equal(report.prunedReportRuns, 1);
    assert.equal(await runs.find(db, run), undefined);
  });

  describe('refuses to break something that is still working', () => {
    it('never prunes the bytes under a delivery that is still queued', async () => {
      // **The one that would be self-inflicted.** `E-09` treats missing bytes as a permanent
      // delivery failure — correctly, since there is nothing left to send — so retention taking
      // them would manufacture the failure it cannot recover from.
      const pending = await makeRun(500, { delivery: 'pending' });
      const sent = await makeRun(500, { delivery: 'sent' });

      const report = await sweep(90, 730);
      assert.equal(await outputCount(pending), 1, 'the queued one kept its bytes');
      assert.equal(await outputCount(sent), 0, 'the delivered one did not');
      assert.equal(report.prunedReportOutputs, 1);
    });

    it('never prunes a run that is still rendering', async () => {
      // Deleting a running row frees the partial unique index and lets a second render start
      // beside the first — for a bound that had all the time in the world to wait one more pass.
      const running = await makeRun(800, { state: 'running' });
      const finished = await makeRun(800, { state: 'succeeded' });

      await sweep(90, 730);
      assert.ok(await runs.find(db, running), 'still there');
      assert.equal(await runs.find(db, finished), undefined);
    });

    it('never prunes a run whose delivery is still queued', async () => {
      const pending = await makeRun(800, { delivery: 'pending' });
      await sweep(90, 730);
      assert.ok(await runs.find(db, pending));
    });
  });

  describe('is bounded, so the first pass after a change does not hold a lock', () => {
    it('clears a backlog over several passes rather than in one statement', async () => {
      // A report document is kilobytes of TOASTed bytea, not the few hundred bytes an audit row
      // is, so the per-statement bound is much smaller than the audit prune's — and the backlog
      // has to drain across passes rather than stall.
      for (let index = 0; index < 12; index += 1) await makeRun(400);

      const first = await sweep(90, 730);
      assert.equal(first.prunedReportOutputs, 12, 'a small backlog clears in one pass');

      const second = await sweep(90, 730);
      assert.equal(second.prunedReportOutputs, 0, 'and the next pass finds nothing to do');
    });

    it('reports zero rather than nothing when there is nothing to prune', async () => {
      const report = await sweep(90, 730);
      assert.equal(report.prunedReportOutputs, 0);
      assert.equal(report.prunedReportRuns, 0);
      assert.deepEqual(report.failures, [], 'and the step did not fail its way to zero');
    });
  });
});

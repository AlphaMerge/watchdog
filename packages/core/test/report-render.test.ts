import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { AccessService } from '../src/auth/access.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ReportContext } from '../src/reports/context.js';
import { ReportRenderer } from '../src/reports/render.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService, type ReportViewer } from '../src/reports/service.js';
import { ReportError } from '../src/reports/errors.js';
import { countCells, renderCsv, renderHtml } from '../src/reports/table.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, actorNamed } from './support/tree.js';
import { DatabaseAuditSink } from '../src/audit/store.js';

const available = await databaseAvailable();
const HOUR = 3_600_000;

/**
 * A report rendered against real readings (`E-04`).
 *
 * `report-table.test.ts` asserts the formatting rules on a document built by hand. This asserts
 * the half that only a database can: that the document a renderer builds out of `E-02`'s window,
 * `E-03`'s subjects and `HistoryService`'s readings really does carry a gap where there is no
 * data — the rule is worth nothing if the assembly quietly fills one in before the formatter sees
 * it.
 *
 * The fixture is one sensor with **a deliberate hole in the middle of the span**, which is the
 * ordinary case: a sensor that was Down, or paused, for an hour.
 */
describe('rendering a report', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let reports: ReportService;
  let renderer: ReportRenderer;
  let history: HistoryService;
  /** How many times the renderer asked for a sensor's history. */
  let historyReads = 0;
  const extraSensorIds: number[] = [];

  let sensorId: number;
  let hiddenSensorId: number;
  let deviceId: number;
  let deletedId: number;
  let author: { id: number; login: string };
  let base: Date;

  before(async () => {
    scratch = await createScratchDatabase('reportrender');
    db = scratch.db;
    const harness = await buildHarness(db);
    const repository = new ReportRepository();
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
    history = new HistoryService({ db, logger: silent });
    // Counted, so a test can say whether the renderer read anything before it refused (`P-203`).
    const read = history.forSensor.bind(history);
    history.forSensor = (...args) => {
      historyReads += 1;
      return read(...args);
    };
    renderer = new ReportRenderer({ context, history, logger: silent });

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      name: 'render-probe',
      parentId: harness.rootId,
    });
    const device = await harness.service.create(testActor, {
      kind: 'device',
      name: 'render-device',
      parentId: probe.id,
      host: '10.0.0.9',
    });
    deviceId = device.id;
    sensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        // A name that is a formula and markup at once, so every rendering path meets one.
        name: '=cmd|<b>edge</b>',
        parentId: device.id,
        sensorType: 'icmp.ping',
      })
    ).id;

    const walled = await harness.service.create(testActor, {
      kind: 'device',
      name: 'render-walled',
      parentId: probe.id,
      host: '10.0.0.10',
    });
    hiddenSensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'render-hidden',
        parentId: walled.id,
        sensorType: 'icmp.ping',
      })
    ).id;
    const doomed = await harness.service.create(testActor, {
      kind: 'sensor',
      name: 'render-doomed',
      parentId: device.id,
      sensorType: 'icmp.ping',
    });
    deletedId = doomed.id;
    await db.query('DELETE FROM object WHERE id = $1', [deletedId]);

    // Six more two-channel sensors, with no readings at all: enough, over a long enough span at a
    // fine enough resolution, to put a report over the value limit without writing a row.
    for (let index = 0; index < 6; index += 1) {
      const extra = await harness.service.create(testActor, {
        kind: 'sensor',
        name: `render-bulk-${String(index)}`,
        parentId: device.id,
        sensorType: 'icmp.ping',
      });
      extraSensorIds.push(extra.id);
    }

    const group = await db.query<{ id: string }>(
      `INSERT INTO user_group (name) VALUES ('renderers') RETURNING id`,
    );
    const groupId = Number(group[0]?.id);
    const account = await db.query<{ id: string }>(
      `INSERT INTO user_account (login, display_name, password_hash, role)
       VALUES ('renderer', 'renderer', 'x', 'readwrite') RETURNING id`,
    );
    author = { id: Number(account[0]?.id), login: 'renderer' };
    await db.query(
      `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
      [groupId, author.id],
    );
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'read'), ($3, $2, 'none')`,
      [harness.rootId, groupId, walled.id],
    );

    // Four hours of readings with **the third hour missing**. The hole is the fixture.
    const rows = await db.query<{ at: Date }>(
      "SELECT time_bucket('1 hour', now() - interval '2 days') AS at",
    );
    base = rows[0]?.at ?? new Date();
    const channels = await db.query<{ id: number; key: string }>(
      'SELECT id, key FROM channel WHERE sensor_id = $1',
      [sensorId],
    );
    const rtt = channels.find((one) => one.key === 'rtt')?.id ?? 0;
    const loss = channels.find((one) => one.key === 'loss')?.id ?? 0;
    assert.ok(rtt > 0 && loss > 0);

    for (const [index, value] of [12.5, 13.5, null, 15.5].entries()) {
      if (value === null) continue;
      await db.query(`INSERT INTO sample (time, channel_id, value) VALUES ($1, $2, $3)`, [
        new Date(base.getTime() + index * HOUR + 60_000),
        rtt,
        value,
      ]);
      // A measured **zero** on the other channel, in every hour that has data — so the document
      // has to distinguish "no reading" from "a reading of zero" rather than having only one.
      await db.query(`INSERT INTO sample (time, channel_id, value) VALUES ($1, $2, 0)`, [
        new Date(base.getTime() + index * HOUR + 60_000),
        loss,
      ]);
    }
  });

  after(async () => {
    await scratch.drop();
  });

  const viewer = (userId: number): ReportViewer => ({ userId, role: 'readwrite' });

  let seq = 0;
  const build = async (
    subjects: number[],
    span?: Record<string, unknown>,
    kind: 'table_only' | 'graph_and_table' | 'graph_only' = 'table_only',
  ) => {
    seq += 1;
    const report = await reports.create(
      viewer(author.id),
      {
        name: `render-${String(seq)}`,
        kind,
        subjects: { objectIds: subjects },
        span: span ?? {
          kind: 'custom',
          from: base.toISOString(),
          to: new Date(base.getTime() + 4 * HOUR).toISOString(),
          timezone: 'UTC',
          resolutionSeconds: 3_600,
        },
      },
      actorNamed(author.login),
    );
    return renderer.build(report, new Date(base.getTime() + 5 * HOUR));
  };

  it('carries the hour with no readings through as a gap, not as a zero', async () => {
    // **The end-to-end form of the rule.** The formatter is already proved; this proves the
    // assembly does not quietly fill the hole in before the formatter sees it.
    const document = await build([sensorId]);
    const section = document.sections[0];
    assert.ok(section);
    assert.equal(section.rows.length, 4, 'four hours, including the one with nothing in it');

    const rtt = section.columns.findIndex((one) => one.key === 'rtt');
    const loss = section.columns.findIndex((one) => one.key === 'loss');
    assert.deepEqual(
      section.rows.map((row) => row.values[rtt]),
      [12.5, 13.5, null, 15.5],
    );
    // And the measured zeroes are zeroes, in the same rows — the distinction survives the whole
    // pipeline, which is the thing that would be silently lost.
    assert.deepEqual(
      section.rows.map((row) => row.values[loss]),
      [0, 0, null, 0],
    );
  });

  it('renders that gap as an empty field and a dash, and the zero as a zero', async () => {
    const document = await build([sensorId]);
    const csv = renderCsv(document);
    const rows = csv.split('\r\n').filter((line) => /^\d{4}-\d{2}-\d{2}T/u.test(line));
    assert.equal(rows.length, 4);
    assert.equal(rows[2]?.split(',').slice(1).join(','), ',', 'both channels empty, neither zero');
    assert.ok(rows[0]?.includes(',0'), 'and the measured zero is still there');

    const html = renderHtml(document);
    assert.equal([...html.matchAll(/class="gap"/gu)].length, 2, 'one dash per missing channel');
  });

  it('defuses a sensor name that is a formula, and escapes it into HTML', async () => {
    const document = await build([sensorId]);
    const csv = renderCsv(document);
    assert.ok(csv.includes(`"'=cmd|<b>edge</b>"`), csv.split('\r\n').slice(0, 12).join('\n'));

    const html = renderHtml(document);
    assert.ok(!html.includes('<b>edge</b>'), 'the name did not become markup');
    assert.match(html, /&lt;b&gt;edge&lt;\/b&gt;/u);
  });

  it('names the account it rendered through, in the document', async () => {
    const document = await build([sensorId]);
    assert.equal(document.runAs, author.login);
    assert.ok(renderHtml(document).includes(author.login));
    assert.ok(renderCsv(document).includes(author.login));
  });

  it('counts a subject its context cannot read, without saying which kind of missing it is', async () => {
    const document = await build([sensorId, hiddenSensorId, deletedId]);
    assert.equal(document.sections.length, 1, 'only the one it may render');
    assert.deepEqual(
      [...document.unavailable].sort((a, b) => a - b),
      [hiddenSensorId, deletedId].sort((a, b) => a - b),
    );
    assert.match(renderHtml(document), /2 of this report’s objects could not be rendered/u);
  });

  it('says so when a subject is not a sensor, rather than printing an empty table', async () => {
    const document = await build([deviceId]);
    const section = document.sections[0];
    assert.ok(section);
    assert.equal(section.rows.length, 0);
    assert.match(section.note ?? '', /a data table is per sensor/u);
    assert.ok(!renderHtml(document).includes('<table>'));
  });

  it('refuses to render at all once the security context is gone', async () => {
    // `E-03`'s refusal, reaching the renderer: a report whose account was disabled stops rather
    // than rendering with no scope — and stops *before* any reading is fetched.
    seq += 1;
    const report = await reports.create(
      viewer(author.id),
      {
        name: `render-nocontext-${String(seq)}`,
        kind: 'table_only',
        subjects: { objectIds: [sensorId] },
      },
      actorNamed(author.login),
    );
    // Read it back *before* disabling, so the row the renderer is handed is the ordinary one and
    // the refusal has to come from resolving the context rather than from a stale flag.
    const stored = await reports.get(viewer(author.id), report.id);
    await db.query(`UPDATE user_account SET disabled = true WHERE id = $1`, [author.id]);
    try {
      await assert.rejects(
        () => renderer.build(stored),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_NO_CONTEXT');
          return true;
        },
      );
    } finally {
      await db.query(`UPDATE user_account SET disabled = false WHERE id = $1`, [author.id]);
    }
  });

  it('carries each bucket’s spread for a template that draws graphs, and only for one (E-05)', async () => {
    // The band on a report's graph comes from the same history read as the line — so the two
    // cannot be two different readings of the period — and a table-only report does not carry
    // three times the data it will never draw.
    const graphed = await build([sensorId], undefined, 'graph_and_table');
    const section = graphed.sections[0];
    assert.ok(section?.spread !== undefined, 'a graph template carries the spread');
    const rtt = section.columns.findIndex((one) => one.key === 'rtt');
    assert.equal(section.spread.length, section.columns.length, 'one per column');
    assert.deepEqual(
      section.spread[rtt]?.min.map((value, index) => [
        value === null,
        section.rows[index]?.values[rtt] === null,
      ]),
      section.rows.map((row) => [row.values[rtt] === null, row.values[rtt] === null]),
      'and a gap in the line is a gap in the band, bucket for bucket',
    );

    const plain = await build([sensorId]);
    assert.equal(plain.sections[0]?.spread, undefined, 'a table-only report carries none');
  });

  it('refuses a report over the value limit before reading any history (P-203)', async () => {
    // **The measurement that asked for this.** Before the check existed, a report over 500
    // sensors read for ten seconds against the live database and was then refused — on every
    // scheduled run. Seven two-channel sensors over 39 days at the finest averaging the rules
    // allow is 7 × 2 × 18,720 = 262,080 values: over the limit, and knowable without a read.
    const before = historyReads;
    await assert.rejects(
      () =>
        build([sensorId, ...extraSensorIds], {
          kind: 'custom',
          from: new Date(base.getTime() - 39 * 24 * HOUR).toISOString(),
          to: base.toISOString(),
          timezone: 'UTC',
          resolutionSeconds: 120,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReportError);
        assert.equal(error.code, 'REPORT_TOO_LARGE');
        assert.equal((error.details as { cells: number }).cells, 262_080, 'with the exact count');
        assert.match(error.message, /cover fewer sensors/u, 'and the same advice as after reading');
        return true;
      },
    );
    assert.equal(historyReads, before, 'and not one sensor’s history was read to find that out');
  });

  it('estimates exactly what the finished document counts, so it never refuses one that fits', async () => {
    // The early check is only safe if it cannot disagree with the authoritative one. Same report,
    // counted both ways.
    const document = await build([sensorId, deviceId, ...extraSensorIds]);
    const counts = await history.channelCounts([sensorId, ...extraSensorIds]);
    let expected = 0;
    for (const channels of counts.values())
      expected += channels * (document.sections[0]?.rows.length ?? 0);
    assert.equal(expected, countCells(document.sections));
    assert.ok(historyReads > 0);
  });

  it('uses the same bucketing the span planned, so a report and a graph agree', async () => {
    // Not a second opinion about which rollup tier answers: the renderer passes `E-02`'s planned
    // width straight to the same `HistoryService` the sensor page uses.
    const document = await build([sensorId]);
    assert.equal(document.resolution.bucketSeconds, 3_600);
    assert.equal(document.sections[0]?.rows.length, 4);
    assert.equal(
      document.window.to.getTime() - document.window.from.getTime(),
      4 * HOUR,
      'and the window is the one the span named',
    );
  });
});

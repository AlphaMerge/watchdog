import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { ReportError } from '../src/reports/errors.js';
import { renderOutputs } from '../src/reports/formats.js';
import { ReportFormatter } from '../src/reports/formatter.js';
import type { ReportOutputs } from '../src/reports/outputs.js';
import { MAX_CELLS, renderHtml, type ReportDocument } from '../src/reports/table.js';
import { silent } from './support/tree.js';

/**
 * Formatting a report off the event loop (`P-204`).
 *
 * `P-203` measured every format synchronous for its whole duration and two reports at once making
 * a concurrent request wait 2.6 s. This file proves the half of the fix a unit test can: that the
 * worker produces the same bytes the main thread would have, that the main thread stays free while
 * it does, and that a worker which refuses, crashes or hangs costs one job and says why. The other
 * half — a real request's latency while real reports render — is `report-render-performance.test.ts`.
 */

const HOUR = 3_600_000;
const misbehaving = new URL('./support/misbehaving-format-worker.js', import.meta.url);

function document(name: string, sensors: number, hours: number): ReportDocument {
  const from = new Date('2026-08-01T00:00:00Z');
  return {
    report: { id: 1, name, kind: 'graph_and_table' },
    window: {
      from,
      to: new Date(from.getTime() + hours * HOUR),
      label: '2026-08 (UTC)',
      timezone: 'UTC',
    },
    runAs: 'alice',
    generatedAt: new Date('2026-09-01T03:00:00Z'),
    resolution: { bucketSeconds: 3_600, source: 'sample_1h' },
    adjustments: [],
    unavailable: [],
    sections: Array.from({ length: sensors }, (_, index) => {
      const rows = Array.from({ length: hours }, (_, hour) => ({
        at: new Date(from.getTime() + hour * HOUR),
        values: [hour % 29 === 3 ? null : 20 + Math.sin(hour / 5) * 8, 0],
      }));
      return {
        subject: { id: index, kind: 'sensor', name: `sensor ${String(index)}` },
        columns: [
          { key: 'rtt', name: 'Response time', unit: 'ms', decimals: 1 },
          { key: 'loss', name: 'Packet loss', unit: '%', decimals: 0 },
        ],
        rows,
        spread: [0, 1].map((column) => ({
          min: rows.map((row) =>
            (row.values[column] ?? null) === null ? null : (row.values[column] ?? 0) - 2,
          ),
          max: rows.map((row) =>
            (row.values[column] ?? null) === null ? null : (row.values[column] ?? 0) + 3,
          ),
        })),
      };
    }),
  };
}

const EVERYTHING: ReportOutputs = {
  formats: ['html', 'csv', 'xml', 'pdf'],
  delivery: 'store',
  recipients: [],
  zip: false,
};
const AT = new Date('2026-09-01T03:00:00Z');

const formatters: ReportFormatter[] = [];
const formatter = (
  options: ConstructorParameters<typeof ReportFormatter>[0] = { logger: silent },
): ReportFormatter => {
  const made = new ReportFormatter(options);
  formatters.push(made);
  return made;
};

after(async () => {
  await Promise.all(formatters.map((one) => one.close()));
});

describe('the report formatter', () => {
  it('produces exactly the bytes formatting on the main thread would have', async () => {
    // The worker is a place, not a second renderer: any difference at all would mean a download and
    // the same report rendered by a test were two different documents.
    const doc = document('Monthly', 3, 48);
    const inThread = await renderOutputs({ name: 'Monthly' }, doc, EVERYTHING, AT);
    const inWorker = await formatter().outputs({ name: 'Monthly' }, doc, EVERYTHING, AT);
    assert.deepEqual(
      inWorker.map((part) => [part.format, part.filename]),
      inThread.map((part) => [part.format, part.filename]),
    );
    for (const [index, part] of inWorker.entries()) {
      assert.ok(
        part.body.equals(inThread[index]?.body ?? Buffer.alloc(0)),
        `${part.format} differs`,
      );
    }
    const zipped = await formatter().outputs(
      { name: 'Monthly' },
      doc,
      { ...EVERYTHING, zip: true },
      AT,
    );
    const zippedInThread = await renderOutputs(
      { name: 'Monthly' },
      doc,
      { ...EVERYTHING, zip: true },
      AT,
    );
    const archive = zipped[0];
    assert.ok(archive !== undefined);
    assert.equal(archive.format, 'zip');
    assert.ok(
      archive.body.equals(zippedInThread[0]?.body ?? Buffer.alloc(0)),
      'and so is the archive',
    );
  });

  it('leaves the event loop free while it works', async () => {
    // **The measurement this ticket exists for, as a test.** The same document, formatted twice:
    // on the main thread the loop cannot tick until it is done; through the formatter a timer keeps
    // ticking the whole time. The margin is wide on purpose — this asserts where the work happens,
    // not how fast a machine is.
    const doc = document('Large', 40, 720);
    const started = performance.now();
    renderHtml(doc);
    const inThreadMs = performance.now() - started;
    assert.ok(
      inThreadMs > 80,
      `the fixture is big enough to see: ${inThreadMs.toFixed(0)} ms in-thread`,
    );

    const pool = formatter();
    await pool.format('csv', document('warm-up', 1, 2));
    let longestGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 5);
    try {
      await pool.format('html', doc);
    } finally {
      clearInterval(ticker);
    }
    // The structured clone of the document still happens on this thread, and is the one cost left.
    assert.ok(
      longestGap < inThreadMs / 2,
      `the loop was held for ${longestGap.toFixed(0)} ms, against ${inThreadMs.toFixed(0)} ms formatting in-thread`,
    );
  });

  it('brings a refusal back as the same refusal, so it stays a 422', async () => {
    const huge: ReportDocument = {
      ...document('Huge', 1, 2),
      sections: [
        {
          subject: { id: 1, kind: 'sensor', name: 'big' },
          columns: [
            { key: 'a', name: 'A', unit: '', decimals: null },
            { key: 'b', name: 'B', unit: '', decimals: null },
          ],
          rows: Array.from({ length: MAX_CELLS }, () => ({ at: new Date(0), values: [1, 2] })),
        },
      ],
    };
    await assert.rejects(
      () => formatter().format('csv', huge),
      (error: unknown) => {
        assert.ok(error instanceof ReportError, `a ${String(error)}`);
        assert.equal(error.code, 'REPORT_TOO_LARGE');
        assert.equal(error.status, 422);
        assert.equal((error.details as { cells: number }).cells, MAX_CELLS * 2);
        assert.match(error.message, /cover fewer sensors/u);
        return true;
      },
    );
  });

  it('refuses work past its queue rather than queueing without limit, and counts it', async () => {
    const pool = formatter({
      logger: silent,
      size: 1,
      maxQueued: 1,
      workerUrl: misbehaving,
      timeoutMs: 60_000,
    });
    const hung = pool.format('csv', document('hang', 1, 2));
    const waiting = pool.format('csv', document('queued', 1, 2));
    await assert.rejects(
      () => pool.format('csv', document('one too many', 1, 2)),
      (error: unknown) =>
        error instanceof ReportError && error.code === 'REPORT_BUSY' && error.status === 409,
    );
    const stats = pool.stats();
    assert.equal(stats.refused, 1);
    assert.equal(stats.queued, 1);
    assert.equal(stats.busy, 1);
    // Handlers attached before closing: `close` rejects both at once, and a rejection with nobody
    // listening yet is an unhandled one.
    const outcomes = [assert.rejects(hung, /closed/u), assert.rejects(waiting, /closed/u)];
    await pool.close();
    await Promise.all(outcomes);
    await assert.rejects(() => pool.format('csv', document('after', 1, 2)), /closed/u);
  });

  it('ends a job that runs out of time, with its worker, and carries on', async () => {
    // A second and a half, not less: the clock starts when a job is handed to a worker, and a fresh
    // worker spends a few hundred milliseconds loading `pdfkit` before it can start. A 300 ms limit
    // timed out the healthy job after the hung one, one run in six.
    const pool = formatter({ logger: silent, size: 1, workerUrl: misbehaving, timeoutMs: 1_500 });
    await assert.rejects(
      () => pool.format('csv', document('hang', 1, 2)),
      /took longer than 1.5 s/u,
    );
    assert.equal(pool.stats().timedOut, 1);
    const next = await pool.format('csv', document('fine', 1, 2));
    assert.ok(next.length > 0, 'the next report is formatted by a new worker');
  });

  it('fails the one job a crashed worker had, and carries on', async () => {
    const pool = formatter({ logger: silent, size: 1, workerUrl: misbehaving });
    // In this order: the crash takes the only worker, so the second job is genuinely waiting behind
    // it. The first version submitted them the other way round, and passed with the queue's
    // recovery deleted — the job it said was queued had been formatted before the crash.
    const crashed = assert.rejects(
      () => pool.format('csv', document('crash', 1, 2)),
      /exit code 3/u,
    );
    const queued = pool.format('csv', document('behind the crash', 1, 2));
    assert.equal(
      pool.stats().queued,
      1,
      'the second job is waiting for the worker that will crash',
    );
    await crashed;
    // Still formatted: the queue gets a new worker rather than waiting for ever.
    assert.ok((await queued).length > 0);
    const stats = pool.stats();
    assert.equal(stats.crashed, 1);
    assert.equal(stats.failed, 1);
  });

  it('gives an idle worker back, so an installation that rendered once is not holding pdfkit for ever', async () => {
    const pool = formatter({ logger: silent, idleMs: 100 });
    await pool.format('csv', document('once', 1, 2));
    assert.equal(pool.stats().workers, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pool.stats().workers, 0);
  });
});

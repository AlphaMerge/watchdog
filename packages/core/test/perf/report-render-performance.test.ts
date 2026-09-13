import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Database, Queryable } from '../../src/db/pool.js';
import { AccessService } from '../../src/auth/access.js';
import { HistoryService } from '../../src/timeseries/history.js';
import { ReportContext } from '../../src/reports/context.js';
import { ReportError } from '../../src/reports/errors.js';
import { renderPdf } from '../../src/reports/pdf.js';
import { ReportRenderer } from '../../src/reports/render.js';
import { ReportRepository } from '../../src/reports/repository.js';
import { ReportService, type ReportViewer } from '../../src/reports/service.js';
import { renderCsv, renderHtml, renderXml, type ReportDocument } from '../../src/reports/table.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * What a report costs the database and the event loop (`P-203`).
 *
 * `ReportRenderer` reads history one sensor at a time through `HistoryService.forSensor`, which is
 * the sensor page's own read — deliberately, so a report and the graph beside it cannot disagree
 * about an hour. Nobody had measured what that costs, and `E-06` added a second question: the
 * formatting is CPU on the one event loop the core serves every request from.
 *
 * Measured against real rollup tiers, because a report never reads raw: the planner answers a
 * month from `sample_5m` and a year from `sample_1h`, about a thousand buckets either way. The
 * fixture fills exactly those tiers for **500 `icmp.ping` sensors, two channels each** — 8.9 million
 * five-minute rows for the month and 8.8 million hourly rows for the year — and marks both
 * watermarks past the window, so every read is one segment from one tier, which is the shape of a
 * report run at 03:00 over last month.
 *
 * Nothing here is a budget in the sense of a promise to an operator. The assertions are set at
 * several times the measured value, so a change that makes this materially worse fails rather than
 * drifts; the numbers themselves live in `docs/findings/2026-09-13-report-render-cost.md`.
 *
 * **One of them guards a number that is not acceptable, and says so.** Two reports formatting at
 * once hold the event loop for over a second, so a request arriving meanwhile waits that long; the
 * assertion below stops it getting worse and is not a claim that it is fine. `P-204` moves the
 * formatting off the loop, and should replace that assertion with a budget worth having.
 */

const SENSORS = 500;
const DEVICES = 10;
const COUNTS = [1, 10, 100, 500] as const;
const SAMPLES = 3;
/** "Now", fixed, so "last month" and "last year" are the same windows every run. */
const NOW = new Date('2026-09-13T10:00:00Z');

interface Counted {
  transactions: number;
  statements: number;
  /** Wall time per kind of transaction, classified by what its statement reads. */
  byKind: Map<string, { count: number; ms: number }>;
}

const fresh = (): Counted => ({ transactions: 0, statements: 0, byKind: new Map() });

/** What a transaction was for, from the first statement it ran. */
function kindOf(sql: string): string {
  if (/rollup_watermark/u.test(sql)) return 'watermarks';
  if (/\bFROM\s+sample/u.test(sql) || /sample_(5m|1h|1d)/u.test(sql)) return 'series';
  if (/\bchannel\b/u.test(sql)) return 'channels';
  return 'other';
}

/**
 * A `Database` that counts what passes through it.
 *
 * A proxy rather than a subclass, because `Database` keeps its pool in a private field and a
 * subclass constructed by a test would be a second pool. Methods are bound to the real instance
 * for the same reason — a private field read through a proxy's `this` throws.
 */
function counting(db: Database, counts: Counted): Database {
  const wrapQueryable = (q: Queryable, seen: { kind: string }): Queryable =>
    new Proxy(q, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query' && typeof value === 'function') {
          return (...args: unknown[]) => {
            counts.statements += 1;
            if (seen.kind === '') seen.kind = kindOf(String(args[0]));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'tx' && typeof value === 'function') {
        return async <T>(fn: (q: Queryable) => Promise<T>) => {
          counts.transactions += 1;
          const seen = { kind: '' };
          const started = process.hrtime.bigint();
          try {
            return await (value as (f: (q: Queryable) => Promise<T>) => Promise<T>).call(
              target,
              (q) => fn(wrapQueryable(q, seen)),
            );
          } finally {
            const entry = counts.byKind.get(seen.kind) ?? { count: 0, ms: 0 };
            entry.count += 1;
            entry.ms += ms(started);
            counts.byKind.set(seen.kind, entry);
          }
        };
      }
      if (property === 'query' && typeof value === 'function') {
        return (...args: unknown[]) => {
          counts.statements += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const ms = (started: bigint): number => Number(process.hrtime.bigint() - started) / 1e6;

/** Wall time and the longest the event loop was held, for one synchronous or async piece of work. */
async function held<T>(
  work: () => T | Promise<T>,
): Promise<{ value: T; ms: number; loopMaxMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  // **Primed before the work starts, and not reset afterwards.** The histogram measures each tick
  // against the one before, so the first interval after `enable()` — or after `reset()`, which
  // forgets the previous tick too — is never recorded, and a render that begins at once blocks
  // inside exactly that interval. Three versions of this harness reported an 800 ms synchronous
  // render as holding the loop for 0 ms, then 6, then 6 again. The priming ticks record the
  // loop's ordinary jitter, a few milliseconds, which any real block dwarfs.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = process.hrtime.bigint();
  const value = await work();
  const took = ms(started);
  // A timer, not `setImmediate`: the histogram records a block when its own timer finally fires,
  // and an immediate runs before timers do — the first version of this harness disabled the
  // histogram first and reported every format as holding the loop for 0 ms.
  await new Promise((resolve) => setTimeout(resolve, 25));
  histogram.disable();
  return { value, ms: took, loopMaxMs: histogram.max / 1e6 };
}

describe(
  'report render cost',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let reports: ReportService;
    let context: ReportContext;
    let author: { id: number; login: string };
    const sensorIds: number[] = [];
    let pageSensorId = 0;

    before(async () => {
      scratch = await createScratchDatabase('reportperf');
      db = scratch.db;
      const harness = await buildHarness(db);
      const repository = new ReportRepository();
      context = new ReportContext({
        db,
        repository,
        access: new AccessService({ db, logger: silent }),
        logger: silent,
      });
      reports = new ReportService({ db, repository, logger: silent });

      const started = Date.now();
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        name: 'report-probe',
        parentId: harness.rootId,
      });
      for (let d = 0; d < DEVICES; d += 1) {
        const device = await harness.service.create(testActor, {
          kind: 'device',
          name: `report-device-${String(d)}`,
          parentId: probe.id,
          host: `10.9.${String(d)}.1`,
        });
        for (let s = 0; s < SENSORS / DEVICES; s += 1) {
          const sensor = await harness.service.create(testActor, {
            kind: 'sensor',
            name: `sensor-${String(d)}-${String(s)}`,
            parentId: device.id,
            sensorType: 'icmp.ping',
          });
          sensorIds.push(sensor.id);
        }
      }
      pageSensorId = sensorIds[0] ?? 0;

      const group = await db.query<{ id: string }>(
        `INSERT INTO user_group (name) VALUES ('report-perf') RETURNING id`,
      );
      const account = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ('report-perf', 'report-perf', 'x', 'readwrite') RETURNING id`,
      );
      author = { id: Number(account[0]?.id), login: 'report-perf' };
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
        [Number(group[0]?.id), author.id],
      );
      await db.query(
        `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'read')`,
        [harness.rootId, Number(group[0]?.id)],
      );

      const channels = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM channel WHERE sensor_id = ANY($1::int[])',
        [sensorIds],
      );
      assert.equal(Number(channels[0]?.n), SENSORS * 2, 'icmp.ping declares two channels');

      // The tiers the planner reads, and only those. A bucket is missing about one time in 97,
      // so every series has real gaps in it, as a real one does.
      const fill = async (
        table: 'sample_5m' | 'sample_1h',
        from: string,
        to: string,
        step: string,
        count: number,
      ) => {
        for (let offset = 0; offset < sensorIds.length; offset += 50) {
          await db.query(
            `INSERT INTO ${table} (bucket, channel_id, sample_count, value_sum, value_min, value_max)
             SELECT b, c.id, $4::int, v.value * $4::int, v.value - v.spread, v.value + v.spread * 1.5
             FROM generate_series($1::timestamptz, $2::timestamptz, $3::interval) b
             CROSS JOIN (SELECT id, key FROM channel WHERE sensor_id = ANY($5::int[])) c
             CROSS JOIN LATERAL (
               SELECT CASE WHEN c.key = 'loss' THEN 0.0 ELSE 20 + 10 * sin(extract(epoch FROM b) / 25200.0 + c.id) END AS value,
                      CASE WHEN c.key = 'loss' THEN 0.0 ELSE 3.0 END AS spread
             ) v
             WHERE b < $2::timestamptz
               AND ((extract(epoch FROM b)::bigint / 300) + c.id) % 97 <> 0`,
            [from, to, step, count, sensorIds.slice(offset, offset + 50)],
          );
        }
      };
      await fill('sample_5m', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '5 minutes', 5);
      await fill('sample_1h', '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '1 hour', 60);
      for (const tier of ['sample_5m', 'sample_1h']) {
        await db.query(
          `INSERT INTO rollup_watermark (tier, watermark) VALUES ($1, '2026-09-13T00:00:00Z')
           ON CONFLICT (tier) DO UPDATE SET watermark = EXCLUDED.watermark`,
          [tier],
        );
      }
      await db.query('ANALYZE sample_5m');
      await db.query('ANALYZE sample_1h');
      const rows = await db.query<{ five: string; hour: string }>(
        `SELECT (SELECT count(*) FROM sample_5m)::text AS five, (SELECT count(*) FROM sample_1h)::text AS hour`,
      );
      process.stdout.write(
        `\n    built ${String(SENSORS)} sensors and filled ${Number(rows[0]?.five).toLocaleString('en-GB')} ` +
          `five-minute and ${Number(rows[0]?.hour).toLocaleString('en-GB')} hourly rows in ` +
          `${((Date.now() - started) / 1_000).toFixed(0)} s (setup, not measured)\n`,
      );
    });

    after(async () => {
      await scratch.drop();
    });

    const viewer: () => ReportViewer = () => ({ userId: author.id, role: 'readwrite' });
    let seq = 0;
    const reportFor = async (
      count: number,
      span: 'month' | 'year',
      kind: 'graph_and_table' | 'graph_only',
    ) => {
      seq += 1;
      return reports.create(
        viewer(),
        {
          name: `perf-${String(seq)}`,
          kind,
          subjects: { objectIds: sensorIds.slice(0, count) },
          span: { kind: span, offset: 1, timezone: 'UTC' },
        },
        author.login,
      );
    };

    const rendererCounting = (counts: Counted): ReportRenderer =>
      new ReportRenderer({
        context,
        history: new HistoryService({ db: counting(db, counts), logger: silent }),
        logger: silent,
      });

    it('reads a report one sensor at a time, and says what that costs', async () => {
      const lines: string[] = [];
      const breakdown: string[] = [];
      const results: {
        span: string;
        count: number;
        buildMs: number;
        perSensorMs: number;
        refused: boolean;
      }[] = [];

      // The floor under every transaction: check out a client, BEGIN, one trivial statement, COMMIT.
      // What a report pays per sensor above three of these is the work of reading the series.
      const floor: number[] = [];
      for (let index = 0; index < 200; index += 1) {
        const started = process.hrtime.bigint();
        await db.tx((q) => q.query('SELECT 1'));
        floor.push(ms(started));
      }

      for (const span of ['month', 'year'] as const) {
        lines.push(
          `      ${span === 'month' ? 'last month, 45-minute buckets from sample_5m' : 'last year, 9-hour buckets from sample_1h'}:`,
        );
        lines.push(
          '        sensors   build (median of 3)   per sensor   transactions   statements   outcome',
        );
        for (const count of COUNTS) {
          const report = await reportFor(count, span, 'graph_and_table');
          const timings: number[] = [];
          let outcome = '';
          let counts: Counted = fresh();
          let document: ReportDocument | null = null;
          for (let sample = 0; sample < SAMPLES; sample += 1) {
            counts = fresh();
            const renderer = rendererCounting(counts);
            const started = process.hrtime.bigint();
            try {
              document = await renderer.build(report, NOW);
              outcome = `rendered, ${document.sections.reduce((n, s) => n + s.rows.length * s.columns.length, 0).toLocaleString('en-GB')} values`;
            } catch (error) {
              assert.ok(
                error instanceof ReportError && error.code === 'REPORT_TOO_LARGE',
                String(error),
              );
              outcome = `refused: ${(error.details as { cells: number }).cells.toLocaleString('en-GB')} values`;
              document = null;
            }
            timings.push(ms(started));
          }
          const build = median(timings);
          results.push({
            span,
            count,
            buildMs: build,
            perSensorMs: build / count,
            refused: document === null,
          });
          if (count === 100) {
            const parts = [...counts.byKind]
              .map(
                ([kind, entry]) =>
                  `${kind} ${(entry.ms / entry.count).toFixed(1)} ms × ${String(entry.count)}`,
              )
              .join(', ');
            breakdown.push(`        ${span}, 100 sensors, last sample — per transaction: ${parts}`);
          }
          lines.push(
            `        ${String(count).padStart(7)}   ${build.toFixed(0).padStart(8)} ms` +
              ` (${timings.map((t) => t.toFixed(0)).join(', ')})`.padEnd(14) +
              `${(build / count).toFixed(1).padStart(8)} ms   ${String(counts.transactions).padStart(12)}   ` +
              `${String(counts.statements).padStart(10)}   ${outcome}`,
          );
        }
      }
      process.stdout.write(
        `\n    measured, database reads:\n${lines.join('\n')}\n` +
          `      where the time goes:\n${breakdown.join('\n')}\n` +
          `        an empty transaction (BEGIN, SELECT 1, COMMIT) — median ${median(floor).toFixed(2)} ms of 200\n`,
      );

      // Loose, on purpose: see the header. A sensor's history read measured in single-digit
      // milliseconds here; forty is a regression, not a slow machine.
      for (const result of results) {
        assert.ok(
          result.perSensorMs < 40,
          `${result.span} over ${String(result.count)} sensors took ${result.perSensorMs.toFixed(1)} ms a sensor`,
        );
      }
      const over = results.filter((result) => result.count === 500);
      assert.ok(
        over.length > 0 && over.every((result) => result.refused),
        'a default report over 500 two-channel sensors is over the value limit',
      );
      // **And it says so without reading them** (`P-203`): before the early check, this was 10.4 s.
      for (const result of over) {
        assert.ok(
          result.buildMs < 500,
          `refusing ${result.span} over 500 sensors took ${result.buildMs.toFixed(0)} ms`,
        );
      }
    });

    it('formats a document on the event loop, and says for how long', async () => {
      const lines: string[] = [];
      for (const [span, count] of [
        ['month', 100],
        ['year', 100],
        ['month', 10],
      ] as const) {
        const report = await reportFor(count, span, 'graph_and_table');
        const document = await rendererCounting(fresh()).build(report, NOW);
        const graphsOnly: ReportDocument = {
          ...document,
          report: { ...document.report, kind: 'graph_only' },
        };
        lines.push(`      last ${span}, ${String(count)} sensors, graph_and_table:`);
        lines.push('        format                 wall      event loop held   size');
        const formats: [string, () => unknown][] = [
          ['HTML', () => renderHtml(document)],
          ['CSV', () => renderCsv(document)],
          ['XML', () => renderXml(document)],
          ['PDF', () => renderPdf(document)],
          ['PDF, graph_only', () => renderPdf(graphsOnly)],
        ];
        for (const [name, work] of formats) {
          let size = '';
          let measured: { ms: number; loopMaxMs: number };
          try {
            const result = await held(work);
            const value = result.value;
            size =
              typeof value === 'string'
                ? `${(Buffer.byteLength(value) / 1_048_576).toFixed(2)} MiB`
                : Buffer.isBuffer(value)
                  ? `${(value.length / 1_048_576).toFixed(2)} MiB`
                  : '';
            measured = result;
          } catch (error) {
            const started = process.hrtime.bigint();
            size =
              error instanceof ReportError
                ? `refused: ${error.message.slice(0, 40)}…`
                : String(error);
            measured = { ms: ms(started), loopMaxMs: 0 };
            // The refusal is measured on its own: how long the loop was held before it said no.
            const refusal = await held(async () => {
              try {
                await work();
              } catch {
                /* expected */
              }
            });
            measured = refusal;
          }
          lines.push(
            `        ${name.padEnd(20)} ${measured.ms.toFixed(0).padStart(6)} ms   ${measured.loopMaxMs.toFixed(0).padStart(8)} ms      ${size}`,
          );
          assert.ok(measured.ms < 15_000, `${name} took ${measured.ms.toFixed(0)} ms`);
        }
      }
      process.stdout.write(`\n    measured, formatting:\n${lines.join('\n')}\n`);
    });

    it('shows what two reports running at once do to a request the core is serving', async () => {
      // `ReportRunner` renders at most two at once. The request is the sensor page's own history
      // read — a day of one sensor — issued every 25 ms from the same process and the same pool,
      // which is exactly how the core serves one while it renders.
      const page = new HistoryService({ db, logger: silent });
      const pageRead = async (): Promise<number> => {
        const started = process.hrtime.bigint();
        await page.forSensor(pageSensorId, {
          from: new Date('2026-08-20T00:00:00Z'),
          to: new Date('2026-08-21T00:00:00Z'),
        });
        return ms(started);
      };
      /**
       * Requests on a fixed cadence, each timed from when it was **due**.
       *
       * Not from when it was sent: the sampler shares the event loop it is measuring, so while a
       * render holds the loop the sampler is frozen too and never sends a request into the stall.
       * Timing from the send hides every stall — the second run of this test reported a 30 ms
       * worst case where the first, by luck, had caught 2.8 s. This is coordinated omission, and
       * the fix is the standard one: a request due at 10:00:00.000 that completes at
       * 10:00:02.800 waited 2.8 s, whenever the frozen loop got round to sending it.
       */
      const sampleWhile = async (running: () => boolean, minimum: number): Promise<number[]> => {
        const latencies: number[] = [];
        const origin = performance.now();
        for (let index = 0; running() || latencies.length < minimum; index += 1) {
          const due = origin + index * 25;
          const wait = due - performance.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          await pageRead();
          latencies.push(performance.now() - due);
        }
        return latencies;
      };
      const percentile = (values: number[], p: number): number => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
      };

      const idleUntil = Date.now() + 4_000;
      const idle = await sampleWhile(() => Date.now() < idleUntil, 40);

      const reportsToRun = await Promise.all([
        reportFor(100, 'month', 'graph_and_table'),
        reportFor(100, 'year', 'graph_and_table'),
      ]);
      let busy = true;
      const loop = monitorEventLoopDelay({ resolution: 5 });
      loop.enable();
      await new Promise((resolve) => setTimeout(resolve, 30));
      loop.reset();
      const started = process.hrtime.bigint();
      const running = Promise.all(
        reportsToRun.map(async (report) => {
          const document = await new ReportRenderer({
            context,
            history: new HistoryService({ db, logger: silent }),
            logger: silent,
          }).build(report, NOW);
          renderHtml(document);
          await renderPdf({ ...document, report: { ...document.report, kind: 'graph_only' } });
        }),
      ).finally(() => {
        busy = false;
      });
      const during = await sampleWhile(() => busy, 1);
      await running;
      const reportsMs = ms(started);
      await new Promise((resolve) => setTimeout(resolve, 25));
      loop.disable();

      const row = (label: string, values: number[]) =>
        `      ${label.padEnd(34)} n=${String(values.length).padStart(4)}   p50 ${percentile(values, 50).toFixed(1).padStart(6)} ms` +
        `   p95 ${percentile(values, 95).toFixed(1).padStart(6)} ms   max ${Math.max(...values)
          .toFixed(1)
          .padStart(7)} ms`;
      process.stdout.write(
        `\n    measured, a sensor-page read while two 100-sensor reports render (HTML + PDF) — ${(reportsMs / 1_000).toFixed(1)} s of rendering:\n` +
          `${row('idle', idle)}\n${row('during two reports', during)}\n` +
          `      the event loop, meanwhile: longest block ${(loop.max / 1e6).toFixed(0)} ms, ` +
          `p99 ${(loop.percentile(99) / 1e6).toFixed(0)} ms\n`,
      );
      assert.ok(during.length > 0);
      // Measured at 1.27 s p95 and 2.6 s worst: a regression guard at four times that, **not** an
      // acceptable level. See the header, and `P-204`.
      assert.ok(
        percentile(during, 95) < 5_000,
        `a request waited ${percentile(during, 95).toFixed(0)} ms at p95 while two reports rendered`,
      );
    });
  },
);

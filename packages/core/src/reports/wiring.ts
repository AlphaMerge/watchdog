import type { CoreConfig, Lifecycle, Logger } from '@ms/shared';
import type { ApiServerOptions } from '../api/server.js';
import { CompositeAuditSink } from '../audit/store.js';
import type { AccessService } from '../auth/access.js';
import type { Database } from '../db/pool.js';
import type { CoreHealthSources } from '../health/core-health.js';
import type { EmailTransport } from '../notifications/delivery/email.js';
import { reportAuditSinks, type AuditSinkSet } from '../objects/audit-composition.js';
import { PeriodicSweep } from '../support/periodic-sweep.js';
import { HistoryService } from '../timeseries/history.js';
import { ReportContext } from './context.js';
import { ReportDelivery, ReportOutputRepository } from './delivery.js';
import { checkReportFonts, configureReportFonts } from './fonts.js';
import { ReportFormatter } from './formatter.js';
import { ReportRenderer } from './render.js';
import { ReportRepository } from './repository.js';
import { ReportRunner, ReportRunRepository } from './runs.js';
import { ReportService } from './service.js';

export interface ReportingOptions {
  db: Database;
  logger: Logger;
  lifecycle: Lifecycle;
  config: CoreConfig['reports'];
  access: AccessService;
  history: HistoryService;
  auditSinks: AuditSinkSet;
  email: EmailTransport;
}

/** The reporting subsystem, started: what the API mounts, and what Core Health reads. */
export interface Reporting {
  api: NonNullable<ApiServerOptions['reports']>;
  stats: NonNullable<CoreHealthSources['reports']>;
}

/** How long one statement of a report's may run: ten minutes, where the core pool's is 60 s. */
const REPORT_RENDER_LIMITS = {
  statementTimeoutMs: 600_000,
  poolSize: 4,
  work: 'reports',
} as const;

/**
 * Reports (`E-01`…`E-12`), constructed and started — in the full build profile only (`H-12`).
 *
 * **One function so that "not constructed" is one decision in `main.ts`.** The v1 build calls
 * none of it: no routes, no formatter pool, no `recover()` writing to the run table, no sweep
 * waking every minute. Everything here was in `main.ts` and moved unchanged.
 */
export async function startReporting(options: ReportingOptions): Promise<Reporting> {
  const { db, logger, lifecycle, access, auditSinks, email } = options;

  // **Rendering reads through a pool of its own** (`P-229`). A year of hourly buckets for a few
  // hundred sensors is minutes of reading, which the core pool's 60 s statement limit would cut,
  // and a longer limit on the core pool would let any request run that long. Four sessions: the
  // sweep's two concurrent renders, and room for a preview beside them. Closed after the sweep,
  // since hooks run last-registered first.
  const renderDb = db.withLimits(REPORT_RENDER_LIMITS);
  lifecycle.onShutdown({
    name: 'report database',
    timeoutMs: 5_000,
    run: () => renderDb.close(),
  });
  const history = new HistoryService({ db: renderDb, logger });

  // Mounted here at the same time the routes were written, rather than a phase later: the maps
  // note in `main.ts` is the record of what happens otherwise.
  const reportRepository = new ReportRepository();
  // Reads through the same `AccessService` the object API uses, for the reason the map resolver
  // does: a report must not become a second, more permissive way to read a sensor (`E-03`).
  const reportContext = new ReportContext({
    db: renderDb,
    repository: reportRepository,
    access,
    logger,
  });
  const reportRenderer = new ReportRenderer({ context: reportContext, history, logger });
  const reportAudit = new CompositeAuditSink(reportAuditSinks(auditSinks));
  const reportRuns = new ReportRunRepository();
  const reportOutputs = new ReportOutputRepository();
  // `N-07`'s transport, not a second one — a report is an attachment, not a new channel (`E-09`).
  // Formatting runs in worker threads, not on the loop every request waits on (`P-204`): `P-203`
  // measured two reports formatting at once making a concurrent request wait 2.6 s. Started on first
  // use, so an installation that never renders a report never starts a worker.
  // The fonts a PDF draws with beyond the bundled two (`E-12`). Checked once here so a path that
  // is wrong is said at startup, by name, rather than as a worse-looking PDF weeks later — and
  // configured on this thread too, for anything that renders a PDF without the pool.
  for (const { source, problem } of checkReportFonts(options.config.pdfFonts)) {
    logger.error(
      { path: source.path, face: source.face, problem },
      'a configured report font cannot be used; PDFs will draw with the next font that can',
    );
  }
  configureReportFonts(options.config.pdfFonts);
  const reportFormatter = new ReportFormatter({ logger, fonts: options.config.pdfFonts });
  lifecycle.onShutdown({
    name: 'report formatter',
    timeoutMs: 5_000,
    run: () => reportFormatter.close(),
  });
  const reportDelivery = new ReportDelivery({
    db,
    outputs: reportOutputs,
    email,
    formatter: reportFormatter,
    logger,
  });
  const reportRunner = new ReportRunner({
    db,
    reports: reportRepository,
    runs: reportRuns,
    renderer: reportRenderer,
    delivery: reportDelivery,
    logger,
    // The act-as `E-03` deferred: an audit row for a report that actually ran, naming both who
    // asked and whose visibility it used.
    audit: async (event) => {
      await reportAudit.record(
        db,
        event.requestedBy === ''
          ? { kind: 'system', component: 'report-scheduler' }
          : { kind: 'user', userId: 0, login: event.requestedBy },
        [
          {
            action: 'report.ran',
            objectId: null,
            reportId: event.reportId,
            runId: event.runId,
            reportName: event.reportName,
            trigger: event.trigger,
            requestedBy: event.requestedBy,
            runAs: event.runAs,
            spanLabel: event.spanLabel,
            outcome: event.outcome,
            errorCode: event.errorCode,
          },
        ],
        new Date(),
      );
    },
  });
  const api = {
    service: new ReportService({ db, repository: reportRepository, audit: reportAudit, logger }),
    context: reportContext,
    // And through the same `HistoryService` the sensor pages use, so a report and the graph an
    // operator checks it against cannot disagree about an hour (`E-04`).
    renderer: reportRenderer,
    runner: reportRunner,
    runs: reportRuns,
    outputStore: reportOutputs,
    formatter: reportFormatter,
  };

  // **Runs abandoned by a core that stopped mid-render are cleared once, here.** `running` is a
  // claim about a process that no longer exists, and the partial unique index would otherwise keep
  // that report unrunnable for ever (`E-08`).
  await reportRunner.recover();

  // A report is the longest-running thing this system does, so it runs on its own sweep and never
  // anywhere near the timing wheel — `CLAUDE.md`: nothing blocks the scheduler. A minute, because
  // that is the resolution a cadence has, and the same period the rediscovery sweep uses.
  const reportSweep = new PeriodicSweep({
    logger,
    component: 'report-sweep',
    what: 'a report sweep failed',
    run: async () => {
      // Rendering first, then delivering: a report that just rendered goes out on this same pass
      // rather than waiting a minute, and a delivery backlog cannot starve the renders because
      // each half is separately bounded.
      await reportRunner.tick();
      await reportDelivery.tick();
    },
    intervalMs: 60_000,
  });
  reportSweep.start();
  lifecycle.onShutdown({
    name: 'report-sweep',
    timeoutMs: 2_000,
    run: () => {
      reportSweep.stop();
      return Promise.resolve();
    },
  });

  return {
    api,
    stats: () => {
      const stats = reportRunner.stats();
      return {
        deferred: stats.deferred,
        failed: stats.failed,
        undelivered: reportDelivery.stats().pending,
        formatsWaiting: reportFormatter.stats().queued,
        formatsRefused: reportFormatter.stats().refused,
      };
    },
  };
}

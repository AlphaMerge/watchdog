import type { Logger } from '@ms/shared';
import type { HistoryService } from '../timeseries/history.js';
import type { ReportContext } from './context.js';
import type { ReportRow } from './repository.js';
import { planReportSpan } from './span.js';
import {
  refuseIfTooLarge,
  type ReportColumn,
  type ReportDocument,
  type ReportSection,
  type ReportTableRow,
} from './table.js';

/**
 * Assembling a report out of the three tickets before it (`E-04`).
 *
 * `E-02` turns the span into a window and a bucket width; `E-03` turns the security context into
 * the subjects it may read; this asks `HistoryService` for each of those and hands the result to
 * `table.ts`. **Nothing here decides anything** — that is the whole shape of it. The moment this
 * file resolves a right, bounds a range, or works out which rollup tier answers, there are two
 * copies of a rule that has to be one.
 *
 * ## Why `HistoryService.forSensor`, once per sensor, and not a batched query
 *
 * A rollup tier is only authoritative up to its watermark, so a series has to be stitched from the
 * tier plus everything newer, down to raw — `segmentsFor` does that, and it is the hardest correct
 * thing in the storage layer. A batched query written here would be a second implementation of it,
 * and the first sign of a disagreement would be a report and the sensor page beside it showing
 * different numbers for the same hour.
 *
 * **The cost is real and is not hidden**: one call per subject, sequentially, so a report over
 * hundreds of sensors is hundreds of round trips. That is acceptable for something that runs on a
 * schedule and not on a request, and `MAX_CELLS` refuses the sizes where it would stop being
 * acceptable. Batching it belongs with `E-08`, where the scheduler decides what a long render is
 * allowed to do to the database — and with a measurement, which `CLAUDE.md` requires before any
 * claim about it.
 */

export interface ReportRendererOptions {
  readonly context: ReportContext;
  readonly history: HistoryService;
  readonly logger: Logger;
}

export class ReportRenderer {
  readonly #context: ReportContext;
  readonly #history: HistoryService;
  readonly #logger: Logger;

  constructor(options: ReportRendererOptions) {
    this.#context = options.context;
    this.#history = options.history;
    this.#logger = options.logger.child({ component: 'report-render' });
  }

  /**
   * Everything a rendering needs, resolved as of `now`.
   *
   * The order matters: the security context is resolved **before** any reading is fetched, so a
   * report whose account is gone refuses without having touched a sensor's data.
   */
  async build(report: ReportRow, now: Date = new Date()): Promise<ReportDocument> {
    const { window, plan } = planReportSpan(report.span, now);
    const subjects = await this.#context.subjectsFor(report);

    const sections: ReportSection[] = [];
    for (const subject of subjects.visible) {
      if (subject.kind !== 'sensor') {
        // A report may name a device or a group; a *data table* is per sensor, and saying so is
        // better than an empty table or a silent omission. `E-06` is the ticket that expands a
        // branch into the sensors under it.
        sections.push({
          subject,
          columns: [],
          rows: [],
          note: `a data table is per sensor, and this is a ${subject.kind}`,
        });
        continue;
      }

      const history = await this.#history.forSensor(subject.id, {
        from: window.from,
        to: window.to,
        ...(plan.bucketSeconds === 0 ? {} : { resolutionSeconds: plan.bucketSeconds }),
      });

      if (history.channels.length === 0) {
        sections.push({
          subject,
          columns: [],
          rows: [],
          note: 'this sensor has no channels yet — it has not produced a reading',
        });
        continue;
      }

      const columns: ReportColumn[] = history.channels.map((channel) => ({
        key: channel.key,
        name: channel.name,
        unit: channel.unit,
        decimals: channel.decimals,
      }));

      // **Every bucket, including the ones with nothing in them.** `HistoryService` returns dense
      // arrays aligned to `buckets` precisely so this cannot be written as "the buckets that have
      // data"; dropping the empty ones here would put the rule back.
      const rows: ReportTableRow[] = history.buckets.map((bucket, index) => ({
        at: new Date(bucket),
        values: history.channels.map((channel) => channel.avg[index] ?? null),
      }));

      sections.push({ subject, columns, rows });
    }

    const document: ReportDocument = {
      report: { id: report.id, name: report.name, kind: report.kind },
      window: {
        from: window.from,
        to: window.to,
        label: window.label,
        timezone: window.timezone,
      },
      runAs: subjects.principal.login,
      generatedAt: now,
      resolution: { bucketSeconds: plan.bucketSeconds, source: plan.source },
      adjustments: window.adjustments,
      sections,
      unavailable: subjects.unavailable,
    };

    // Before anything is formatted, so the refusal costs a message rather than a string the size
    // of the document it is refusing to build.
    refuseIfTooLarge(document);

    this.#logger.info(
      {
        reportId: report.id,
        runAs: subjects.principal.login,
        span: window.label,
        sections: sections.length,
        unavailable: subjects.unavailable.length,
        bucketSeconds: plan.bucketSeconds,
        source: plan.source,
      },
      'report rendered',
    );
    return document;
  }
}

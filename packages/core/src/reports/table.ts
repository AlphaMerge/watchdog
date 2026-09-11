import type { QueryAdjustment } from '../timeseries/query.js';
import type { ReportSubject } from './context.js';
import { ReportError } from './errors.js';
import type { ReportKind } from './repository.js';

/**
 * A rendered data table, in HTML and in CSV (`E-04`, `CAPABILITIES.MD §6`).
 *
 * **One document, two renderings**, rather than two renderers reading the database. The two
 * formats have to agree about every number and every gap, and the only way to guarantee that is
 * for them to be the same values formatted twice — `report-table.test.ts` asserts it as a
 * property. This module is pure: it takes a document and returns a string, so every rule below is
 * testable without a database.
 *
 * ## The rule this ticket exists to keep
 *
 * **A gap is a gap in CSV as much as in a graph.** `CLAUDE.md` says no-data is not zero, and a
 * report is the most durable thing this system emits — an empty bucket rendered as `0` is a
 * measurement somebody will act on, filed, months later, with nobody left who remembers. So:
 *
 * - `null` renders as an **empty CSV field** and as `—` in HTML. Never `0`, never `NaN`, never
 *   the last known value carried forward.
 * - **A row whose channels are all gaps is still emitted.** Dropping it would compress time and
 *   make the table claim the period was shorter than it was. It is a timestamp with nothing
 *   beside it, which is the truth.
 * - A genuine zero is `0`. `HistoryService` distinguishes them at the source — `avg` is `null`
 *   for a bucket with no readings and `0` for one that measured zero — and nothing here may
 *   collapse the two.
 *
 * ## The rule this ticket nearly broke
 *
 * **A sensor's name reaches a spreadsheet, and a spreadsheet executes formulas.** Device and
 * sensor names are typed by users; a report is emailed to somebody who opens it in Excel. A name
 * beginning `=`, `+`, `-`, `@`, tab or carriage return is evaluated on open — `=cmd|'/C calc'!A0`
 * is the classic — so every *text* field is prefixed with an apostrophe and quoted.
 *
 * **Numbers are deliberately exempt**, and that is the half that is easy to get wrong: `-5` begins
 * with `-`, and a guard applied to every field would write `'-5` and turn a measurement into text
 * in every spreadsheet that opened it. Numbers here are produced by `formatValue` from a `number`,
 * never by a user, so there is nothing to escape.
 */

export interface ReportColumn {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  /** The channel's display precision, or `null` for automatic. */
  readonly decimals: number | null;
}

export interface ReportTableRow {
  /** The bucket's start. Rendered in the span's zone, with its offset. */
  readonly at: Date;
  /** Aligned to `columns`; `null` is a gap. */
  readonly values: readonly (number | null)[];
}

export interface ReportSection {
  readonly subject: ReportSubject;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly ReportTableRow[];
  /**
   * Why this section has no columns, when it has none.
   *
   * A sensor with no channels yet — never scanned, or paused since it was created — is a real
   * state and renders as a section that says so. An empty table with no explanation reads as a
   * rendering bug.
   */
  readonly note?: string;
}

export interface ReportDocument {
  readonly report: { readonly id: number; readonly name: string; readonly kind: ReportKind };
  readonly window: {
    readonly from: Date;
    readonly to: Date;
    readonly label: string;
    readonly timezone: string;
  };
  /** The account this was rendered through (`E-03`), named in the output so it can be checked. */
  readonly runAs: string;
  readonly generatedAt: Date;
  readonly resolution: { readonly bucketSeconds: number; readonly source: string };
  /** What `§6`'s rules changed about the request. Printed, not swallowed. */
  readonly adjustments: readonly QueryAdjustment[];
  readonly sections: readonly ReportSection[];
  /**
   * Subjects this report names and did not render (`E-03`).
   *
   * Ids only, and deliberately not told apart — see `context.ts` on the existence oracle. They
   * are printed rather than omitted for the same reason an all-gap row is: a report that covers
   * seven of the ten sensors it names, silently, is the worst thing this system can produce.
   */
  readonly unavailable: readonly number[];
}

/**
 * The most cells one document may hold, across every section.
 *
 * `planSeries` bounds the buckets *per sensor*; nothing bounds the product of sensors, buckets and
 * channels, and a year of hourly data over five hundred sensors is tens of millions of cells built
 * in memory as a string. **Refused rather than truncated**, and refused with the numbers: a report
 * silently missing its last four hundred sensors is the failure this whole file is about, and
 * `CLAUDE.md`'s "backpressure is visible, never silent" says which way to go. The author is told
 * what to narrow.
 *
 * Two hundred thousand is roughly a five-megabyte CSV — large enough that no ordinary report meets
 * it, small enough to build and email.
 */
export const MAX_CELLS = 200_000;

export function countCells(sections: readonly ReportSection[]): number {
  let cells = 0;
  for (const section of sections) cells += section.rows.length * section.columns.length;
  return cells;
}

export function refuseIfTooLarge(document: ReportDocument): void {
  const cells = countCells(document.sections);
  if (cells <= MAX_CELLS) return;
  throw new ReportError(
    'REPORT_TOO_LARGE',
    `this report would render ${String(cells)} values, and the limit is ${String(MAX_CELLS)}; ` +
      'cover fewer sensors, choose a shorter span, or pin a coarser averaging interval',
    {
      context: { reportId: document.report.id, phase: 'render' },
      details: { cells, limit: MAX_CELLS, sections: document.sections.length },
    },
  );
}

/* ------------------------------------------------------------------- formatting */

/**
 * One value, or the absence of one.
 *
 * `null` returns the empty string and every caller renders that as a gap. A finite number honours
 * the channel's declared precision; `decimals: null` means automatic, and `String(value)` is what
 * the rest of the system already shows.
 */
export function formatValue(value: number | null, decimals: number | null): string {
  if (value === null) return '';
  // A non-finite number reaching here would print `Infinity` or `NaN` into a spreadsheet, where
  // it is neither a number nor a gap. It is data we do not have.
  if (!Number.isFinite(value)) return '';
  return decimals === null ? String(value) : value.toFixed(decimals);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * An instant on the wall clock of the span's zone, with its offset.
 *
 * ISO 8601 with the offset attached rather than plain local time, because a report is read later
 * and often elsewhere: `2026-09-01T00:00:00+02:00` says what `2026-09-01 00:00` cannot, and it
 * still sorts. The offset is taken from the zone database per row, so the hour that repeats in
 * October is two distinct, correctly-labelled rows rather than one ambiguous pair.
 */
export function formatInstant(at: Date, timezone: string): string {
  const parts = formatterFor(timezone).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  // `longOffset` renders "GMT+02:00", and UTC as either "GMT" or "GMT+00:00" depending on the ICU
  // build — so both are normalised to `Z`, which is what every reader expects and what makes two
  // installations on different Node versions produce byte-identical reports.
  const zone = get('timeZoneName').replace('GMT', '');
  const offset = zone === '' || zone === '+00:00' || zone === '-00:00' ? 'Z' : zone;
  return (
    `${get('year')}-${get('month')}-${get('day')}` +
    `T${get('hour')}:${get('minute')}:${get('second')}${offset}`
  );
}

/* ------------------------------------------------------------------------- CSV */

/**
 * Characters a spreadsheet treats as the start of a formula.
 *
 * Tab and carriage return are here because Excel strips leading whitespace before deciding, so
 * `\t=cmd…` is evaluated exactly as `=cmd…` is.
 */
const FORMULA_START = /^[=+\-@\t\r]/u;

/**
 * One CSV field, RFC 4180, with the formula guard for text.
 *
 * `numeric: true` is the escape hatch for values this module produced itself — see the note at the
 * top of the file about why applying the guard to a negative number would be worse than not
 * applying it at all.
 */
export function csvField(raw: string, options: { numeric?: boolean } = {}): string {
  const guarded =
    options.numeric !== true && FORMULA_START.test(raw)
      ? // An apostrophe is what a spreadsheet reads as "this is text". Quoting alone is not
        // enough: Excel evaluates a quoted formula too.
        `'${raw}`
      : raw;
  if (!/[",\r\n]/u.test(guarded) && guarded === raw) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export function renderCsv(document: ReportDocument): string {
  refuseIfTooLarge(document);
  const lines: string[] = [];
  const row = (...fields: string[]): void => {
    lines.push(fields.join(','));
  };
  const text = (value: string): string => csvField(value);
  const number = (value: string): string => csvField(value, { numeric: true });

  // A preamble rather than a bare table, because a CSV that has been forwarded twice has lost
  // whatever the email said. The period, the account and the averaging are part of the finding.
  row(text('Report'), text(document.report.name));
  row(text('Period'), text(document.window.label));
  row(text('From'), text(formatInstant(document.window.from, document.window.timezone)));
  row(text('To'), text(formatInstant(document.window.to, document.window.timezone)));
  row(text('Renders as'), text(document.runAs));
  row(text('Averaging'), text(`${String(document.resolution.bucketSeconds)} s`));
  row(text('Generated'), text(document.generatedAt.toISOString()));
  for (const adjustment of document.adjustments) row(text('Adjusted'), text(adjustment.reason));
  if (document.unavailable.length > 0) {
    row(
      text('Not rendered'),
      text(`${String(document.unavailable.length)} of this report’s objects are unavailable`),
      text(document.unavailable.join(' ')),
    );
  }
  lines.push('');

  for (const section of document.sections) {
    row(text('Sensor'), text(section.subject.name), number(String(section.subject.id)));
    if (section.note !== undefined) {
      row(text('Note'), text(section.note));
      lines.push('');
      continue;
    }
    row(
      text('Time'),
      ...section.columns.map((column) =>
        text(column.unit === '' ? column.name : `${column.name} (${column.unit})`),
      ),
    );
    for (const entry of section.rows) {
      row(
        text(formatInstant(entry.at, document.window.timezone)),
        // **An empty field, and nothing else.** See the top of this file.
        ...entry.values.map((value, index) =>
          number(formatValue(value, section.columns[index]?.decimals ?? null)),
        ),
      );
    }
    lines.push('');
  }

  // A trailing newline, so `cat`ing two of these does not join a row to a header.
  return `${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------------ HTML */

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Inline, because a report is stored and emailed.
 *
 * Nothing may be fetched from anywhere: a stylesheet on a CDN would fail in an air-gapped NOC,
 * and a remote asset in an emailed document is a read receipt the recipient did not agree to.
 */
const STYLE = `
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: 0 0 1.5rem; }
  dl.meta dt { color: #555; }
  dl.meta dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid #e3e3e3; padding: .3rem .6rem; text-align: right; }
  th:first-child, td:first-child { text-align: left; white-space: nowrap; }
  thead th { border-bottom: 2px solid #999; font-weight: 600; }
  td.gap { color: #999; }
  p.note, p.unavailable { color: #555; background: #f6f6f6; padding: .5rem .75rem; border-left: 3px solid #bbb; }
  footer { margin-top: 2rem; color: #777; font-size: .85rem; }
`;

export function renderHtml(document: ReportDocument): string {
  refuseIfTooLarge(document);
  const out: string[] = [];
  const e = escapeHtml;

  out.push('<!doctype html>');
  out.push('<html lang="en"><head><meta charset="utf-8">');
  out.push(`<title>${e(document.report.name)} — ${e(document.window.label)}</title>`);
  out.push(`<style>${STYLE}</style>`);
  out.push('</head><body>');
  out.push(`<h1>${e(document.report.name)}</h1>`);
  out.push('<dl class="meta">');
  out.push(`<dt>Period</dt><dd>${e(document.window.label)}</dd>`);
  out.push(
    `<dt>From</dt><dd>${e(formatInstant(document.window.from, document.window.timezone))}</dd>`,
  );
  out.push(`<dt>To</dt><dd>${e(formatInstant(document.window.to, document.window.timezone))}</dd>`);
  out.push(`<dt>Renders as</dt><dd>${e(document.runAs)}</dd>`);
  out.push(`<dt>Averaging</dt><dd>${String(document.resolution.bucketSeconds)} s</dd>`);
  for (const adjustment of document.adjustments) {
    out.push(`<dt>Adjusted</dt><dd>${e(adjustment.reason)}</dd>`);
  }
  out.push('</dl>');

  if (document.unavailable.length > 0) {
    out.push(
      `<p class="unavailable">${String(document.unavailable.length)} of this report’s objects ` +
        `could not be rendered and are not included: ${e(document.unavailable.join(', '))}.</p>`,
    );
  }

  for (const section of document.sections) {
    out.push(`<h2>${e(section.subject.name)}</h2>`);
    if (section.note !== undefined) {
      out.push(`<p class="note">${e(section.note)}</p>`);
      continue;
    }
    out.push('<table><thead><tr><th>Time</th>');
    for (const column of section.columns) {
      const heading = column.unit === '' ? column.name : `${column.name} (${column.unit})`;
      out.push(`<th>${e(heading)}</th>`);
    }
    out.push('</tr></thead><tbody>');
    for (const entry of section.rows) {
      out.push(`<tr><td>${e(formatInstant(entry.at, document.window.timezone))}</td>`);
      for (const [index, value] of entry.values.entries()) {
        const rendered = formatValue(value, section.columns[index]?.decimals ?? null);
        // **The gap, made visible rather than blank.** A blank cell in a printed table reads as
        // an oversight; `—` with a title reads as an answer, and the class lets a reader's
        // stylesheet or a screen reader treat it as one.
        out.push(
          rendered === ''
            ? '<td class="gap" title="no data was recorded in this interval">—</td>'
            : `<td>${e(rendered)}</td>`,
        );
      }
      out.push('</tr>');
    }
    out.push('</tbody></table>');
  }

  out.push(
    `<footer>Generated ${e(document.generatedAt.toISOString())}. ` +
      'An empty interval is shown as — and means no reading was recorded, not a reading of zero.' +
      '</footer>',
  );
  out.push('</body></html>');
  return out.join('\n');
}

import type { QueryAdjustment } from '../timeseries/query.js';
import type { ReportSubject } from './context.js';
import { ReportError } from './errors.js';
import { escapeHtml } from './escape.js';
import { chartsFor, showsGraph, showsTable, timeTicksFor } from './graph.js';
import { approximateWidth, renderChartSvg } from './graph-svg.js';
import type { ReportKind } from './repository.js';

/**
 * A rendered data table, in HTML, CSV and XML (`E-04`, `E-07`, `CAPABILITIES.MD §6`).
 *
 * **One document, three renderings**, rather than three renderers reading the database. The
 * formats have to agree about every number and every gap, and the only way to guarantee that is
 * for them to be the same values formatted three times — `report-table.test.ts` asserts it as a
 * property across all of them. This module is pure: it takes a document and returns a string, so
 * every rule below is testable without a database.
 *
 * ## The rule this ticket exists to keep
 *
 * **A gap is a gap in CSV as much as in a graph.** `CLAUDE.md` says no-data is not zero, and a
 * report is the most durable thing this system emits — an empty bucket rendered as `0` is a
 * measurement somebody will act on, filed, months later, with nobody left who remembers. So:
 *
 * - `null` renders as an **empty CSV field**, as `—` in HTML and as `xsi:nil` in XML. Never `0`,
 *   never `NaN`, never the last known value carried forward.
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
   * Per column, aligned to `rows`: each bucket's lowest and highest reading (`E-05`).
   *
   * What a graph draws as its band. Only filled for a template that draws graphs, and optional so
   * that a document without it is still a document — a graph then draws the averages alone. No
   * table, CSV or XML reads it: they print the averages, and a spread nobody asked for would be
   * three times the data in every export.
   */
  readonly spread?: readonly {
    readonly min: readonly (number | null)[];
    readonly max: readonly (number | null)[];
  }[];
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

/**
 * The refusal, with the numbers and what to narrow — raised in two places, worded in one.
 *
 * `ReportRenderer` raises it **before** reading any history, from the channel count and the planned
 * bucket count (`P-203`); `refuseIfTooLarge` raises it again on the finished document, which is the
 * authoritative count. The two must never disagree about what a reader is told.
 */
export function tooLarge(cells: number, reportId: number, sections: number): ReportError {
  return new ReportError(
    'REPORT_TOO_LARGE',
    `this report would render ${String(cells)} values, and the limit is ${String(MAX_CELLS)}; ` +
      'cover fewer sensors, choose a shorter span, or pin a coarser averaging interval',
    {
      context: { reportId, phase: 'render' },
      details: { cells, limit: MAX_CELLS, sections },
    },
  );
}

export function refuseIfTooLarge(document: ReportDocument): void {
  const cells = countCells(document.sections);
  if (cells <= MAX_CELLS) return;
  throw tooLarge(cells, document.report.id, document.sections.length);
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

export { escapeHtml } from './escape.js';

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
  figure.chart { margin: .75rem 0 1.25rem; }
  figure.chart svg { display: block; max-width: 100%; height: auto; }
`;

/** A chart's drawing width in the HTML report, in CSS pixels before it scales to the page. */
const CHART_WIDTH = 760;
const CHART_PLOT_HEIGHT = 180;
const CHART_FONT = 11;

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

  // The template decides what a reader sees (`E-05`): `graph_only` has no table, `table_only` no
  // graph. Ticks are worked out once, because every chart in a report covers the same window.
  const graphed = showsGraph(document.report.kind);
  const tabled = showsTable(document.report.kind);
  const ticks = graphed
    ? timeTicksFor(document.window.from, document.window.to, document.window.timezone)
    : [];

  for (const [sectionIndex, section] of document.sections.entries()) {
    out.push(`<h2>${e(section.subject.name)}</h2>`);
    if (section.note !== undefined) {
      out.push(`<p class="note">${e(section.note)}</p>`);
      continue;
    }
    if (graphed) {
      const charts = chartsFor(section, document.window, ticks, {
        width: CHART_WIDTH,
        plotHeight: CHART_PLOT_HEIGHT,
        fontSize: CHART_FONT,
        measure: approximateWidth,
      });
      for (const [chartIndex, layout] of charts.entries()) {
        // **A channel that recorded nothing is said, not drawn.** An empty rectangle with axes is
        // a picture the reader has to interpret, and the obvious interpretation — a flat line
        // they cannot see — is wrong.
        out.push(
          layout.empty
            ? `<p class="note">No readings were recorded for ${e(layout.title)} in this period.</p>`
            : `<figure class="chart">${renderChartSvg(layout, {
                id: `chart-${String(sectionIndex)}-${String(chartIndex)}`,
                subject: section.subject.name,
                period: document.window.label,
                fontSize: CHART_FONT,
              })}</figure>`,
        );
      }
    }
    if (!tabled) continue;
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
      (graphed && tabled
        ? 'An empty interval is shown as — in a table and as a break in a line on a graph, and '
        : graphed
          ? 'An empty interval is shown as a break in a line, and '
          : 'An empty interval is shown as — and ') +
      'means no reading was recorded, not a reading of zero.' +
      '</footer>',
  );
  out.push('</body></html>');
  return out.join('\n');
}

/* ------------------------------------------------------------------------- XML */

/**
 * The third formatting of the same document (`E-07`, `CAPABILITIES.MD §6`).
 *
 * **For a reader that is a program**, which is the whole difference from the two above. HTML is
 * read by a person and CSV by a spreadsheet; XML is opened by a script that wants the numbers
 * without reconstructing them from a table — so every fact the other two render as a label is an
 * attribute here, and the structure says what the CSV preamble only spells out.
 *
 * ## The decisions in it
 *
 * **A gap is `xsi:nil`, not an empty element.** This is the ticket's version of the rule the rest
 * of this file is about, and an empty element is not good enough for it: `Number(node.textContent)`
 * on `<value/>` is `0`, which is exactly the reading that must be impossible. `xsi:nil="true"` is
 * XML Schema's own spelling of "this element has no value", every parser and every XPath can see
 * it, and no arithmetic on the text can produce a number from it. **And the element is still
 * emitted** — one per declared channel, per row — so a consumer indexing by position never has to
 * ask whether a missing child is a gap or a channel the report does not cover.
 *
 * **Names are camelCase, matching the JSON API.** `bucketSeconds` is `bucketSeconds` in both, so
 * somebody who has read one has read the other. XML convention would suggest hyphens; agreeing
 * with the rest of this system is worth more than agreeing with a convention.
 *
 * **No target namespace, and a `version` attribute instead.** The consumer of a report is a script
 * writing `//sensor/rows/row`, and a default namespace makes that XPath silently match nothing
 * until the author binds a prefix — a cost paid by everybody for a benefit (mixing documents)
 * nobody here has. The `xsi` namespace is declared because `nil` lives in it, and a version
 * attribute is what a future shape change is detected by.
 *
 * **`<adjustments>` and `<unavailable>` are always present, with a count.** Absent when empty
 * would mean a consumer's "did anything go unrendered" check depends on the difference between an
 * empty node-set and a zero, and those are the same node-set when the element is missing for a
 * different reason. An always-present count is one thing to read.
 *
 * **XML is the most verbose of the three**, and `MAX_CELLS` bounds cells rather than bytes.
 * Measured at the limit, over two channels of ordinary values: **CSV 3.2 MiB, HTML 6.7 MiB, XML
 * 10.9 MiB**. That is why a row's values are written on one line rather than indented one per
 * line — the file stays greppable and stays a size a mail relay accepts — and it is why
 * `report-table.test.ts` renders a document at the limit and checks the size rather than trusting
 * this paragraph.
 */

/**
 * Characters XML 1.0 cannot carry, dropped rather than escaped.
 *
 * **There is no escape for them.** `&#1;` is as illegal as the raw byte in XML 1.0, so a name
 * holding a control character cannot be represented at all, and a document containing one is not
 * XML — every parser refuses the whole file, which for a scheduled report means an empty folder
 * and nothing that failed. This is not hypothetical: device names arrive from SNMP `sysName` and
 * from WMI, where a stray control byte is ordinary. Lone surrogates go for the same reason.
 */
function xmlSafe(raw: string): string {
  let out = '';
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    const legal =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7_ff) ||
      (code >= 0xe0_00 && code <= 0xff_fd) ||
      code >= 0x1_00_00;
    if (legal) out += character;
  }
  return out;
}

export function xmlText(raw: string): string {
  // `>` needs escaping only inside `]]>`, and is escaped everywhere anyway: the rule with one
  // exception is the one a later edit forgets.
  return xmlSafe(raw).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * One attribute value, quoted with `"`.
 *
 * **Tab, newline and carriage return are escaped numerically**, which text does not need to do.
 * Attribute-value normalisation replaces a literal one with a space before the application ever
 * sees it, so a sensor name spanning two lines would come back as one line with a space and no
 * parser would have done anything wrong. The numeric form survives it.
 */
export function xmlAttribute(raw: string): string {
  return xmlText(raw)
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;');
}

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

export function renderXml(document: ReportDocument): string {
  refuseIfTooLarge(document);
  const a = xmlAttribute;
  const t = xmlText;
  const n = (value: number): string => String(value);
  const out: string[] = [];

  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<report xmlns:xsi="${XSI}" version="1" id="${n(document.report.id)}" ` +
      `kind="${a(document.report.kind)}" name="${a(document.report.name)}">`,
  );
  out.push(
    `  <period label="${a(document.window.label)}" timezone="${a(document.window.timezone)}" ` +
      `from="${a(formatInstant(document.window.from, document.window.timezone))}" ` +
      `to="${a(formatInstant(document.window.to, document.window.timezone))}"/>`,
  );
  // The account it rendered through, named in the output so it can be checked — the same fact
  // `E-03` puts in the CSV preamble, for the same reason.
  out.push(
    `  <rendering runAs="${a(document.runAs)}" ` +
      `generatedAt="${a(document.generatedAt.toISOString())}"/>`,
  );
  out.push(
    `  <resolution bucketSeconds="${n(document.resolution.bucketSeconds)}" ` +
      `source="${a(document.resolution.source)}"/>`,
  );

  out.push(`  <adjustments count="${n(document.adjustments.length)}">`);
  for (const adjustment of document.adjustments) {
    const requested =
      adjustment.kind === 'range-shortened'
        ? adjustment.requestedDays
        : adjustment.requestedSeconds;
    const effective =
      adjustment.kind === 'range-shortened'
        ? adjustment.effectiveDays
        : adjustment.effectiveSeconds;
    const unit = adjustment.kind === 'range-shortened' ? 'days' : 'seconds';
    out.push(
      `    <adjustment kind="${a(adjustment.kind)}" unit="${unit}" ` +
        `requested="${n(requested)}" effective="${n(effective)}">${t(adjustment.reason)}` +
        '</adjustment>',
    );
  }
  out.push('  </adjustments>');

  // Ids only, and deliberately not told apart — see `context.ts` on the existence oracle.
  out.push(`  <unavailable count="${n(document.unavailable.length)}">`);
  for (const id of document.unavailable) out.push(`    <object id="${n(id)}"/>`);
  out.push('  </unavailable>');

  out.push(`  <sensors count="${n(document.sections.length)}">`);
  for (const section of document.sections) {
    out.push(
      `    <sensor id="${n(section.subject.id)}" kind="${a(section.subject.kind)}" ` +
        `name="${a(section.subject.name)}">`,
    );
    if (section.note !== undefined) {
      out.push(`      <note>${t(section.note)}</note>`);
      out.push('    </sensor>');
      continue;
    }
    out.push(`      <channels count="${n(section.columns.length)}">`);
    for (const column of section.columns) {
      // **`decimals` is omitted when it is automatic**, which is the one place this document says
      // something by absence — and it is metadata about how to print a number rather than a
      // number, so the rule above does not reach it.
      const decimals = column.decimals === null ? '' : ` decimals="${n(column.decimals)}"`;
      out.push(
        `        <channel key="${a(column.key)}" name="${a(column.name)}" ` +
          `unit="${a(column.unit)}"${decimals}/>`,
      );
    }
    out.push('      </channels>');
    out.push(`      <rows count="${n(section.rows.length)}">`);
    for (const entry of section.rows) {
      const cells = entry.values.map((value, index) => {
        const column = section.columns[index];
        const key = a(column?.key ?? String(index));
        const rendered = formatValue(value, column?.decimals ?? null);
        // **The rule this ticket exists to keep, in XML's own spelling.** An empty element would
        // read as zero to `Number(node.textContent)`; `xsi:nil` cannot.
        return rendered === ''
          ? `<value channel="${key}" xsi:nil="true"/>`
          : `<value channel="${key}">${t(rendered)}</value>`;
      });
      out.push(
        `        <row at="${a(formatInstant(entry.at, document.window.timezone))}">` +
          `${cells.join('')}</row>`,
      );
    }
    out.push('      </rows>');
    out.push('    </sensor>');
  }
  out.push('  </sensors>');
  out.push('</report>');
  return `${out.join('\n')}\n`;
}

import PDFDocument from 'pdfkit';
import { LIGHT_CHART_THEME, seriesColour, type ChartLayout } from '@ms/shared/charts';
import { ReportError } from './errors.js';
import { reportFonts, type FontChain } from './fonts.js';
import { chartsFor, showsGraph, showsTable, timeTicksFor } from './graph.js';
import type { ReportSubject } from './context.js';
import {
  formatInstant,
  formatValue,
  refuseIfTooLarge,
  type ReportDocument,
  type ReportSection,
} from './table.js';
import { MAX_PDF_PAGES } from './media.js';

/**
 * A report as a PDF, laid out by us (`E-06`, `ADR-006` Decisions 1 and 2, `CAPABILITIES.MD §6`).
 *
 * **A fourth formatting of `E-04`'s document, not a second reader of the database.** The numbers
 * here are the same numbers the HTML shows, formatted by the same two functions — a gap is `—`, a
 * measured zero is `0`, and a row whose channels are all empty still gets its timestamp.
 *
 * ## What this file owns, and why it owns it
 *
 * `ADR-006` Decision 1 refused headless Chromium — 195 MB for `linux64` and 205 MB for `win64`,
 * per platform, to lay out a table we generated ourselves — and said plainly what that costs:
 * **we own pagination.** That is this file, and it is deliberately two halves:
 *
 * - **`paginate` is pure.** It takes the document, a `Typesetter` — how wide a string is and
 *   whether the font can draw a character — and a page geometry, and returns the pages. No
 *   `pdfkit`, no file, no clock, and a test supplies its own typesetter, so every rule below is a
 *   unit test with a string in and a layout out. That is exactly what a Chromium-rendered PDF
 *   could never have been: one can only be checked by looking at it.
 * - **`draw` is dumb.** It walks the pages `paginate` produced and issues `pdfkit` calls. There is
 *   no decision left in it, so there is nothing there to get wrong that a test cannot see.
 *
 * ## The layout rules, and the failure each one prevents
 *
 * - **Column headings repeat on every page.** A page of numbers whose headings are forty pages
 *   back is a page of numbers nobody can read, and a printed report is read out of order.
 * - **A row is never split across a page break.** Rows are a uniform height and are placed whole,
 *   so a timestamp can never end up on a different page from its own values.
 * - **A section that does not fit the remaining space starts a new page** — unless it does not fit
 *   a whole page either, in which case it flows with `(continued)` in the heading. Small sections
 *   pack together; a large one is never orphaned three rows above a break.
 * - **Columns too wide for the page are carried to a following page group**, with the time column
 *   repeated, rather than clipped. A clipped column is a measurement that silently left the
 *   report, which is the failure this whole surface exists to avoid.
 * - **Every character is drawn by the first font that has it** — DejaVu Sans, then any font the
 *   operator configured, then WenQuanYi Micro Hei (`E-12`, `fonts.ts`) — and **a character no
 *   font has is written as `U+20B9F`**, not left as the empty box a font silently substitutes.
 *   See `drawable`: this is the failure `ADR-006` Decision 2 embedded a font to prevent.
 * - **A page count that a mail relay would refuse is refused here**, with the number and what to
 *   narrow, for the same reason `MAX_CELLS` is refused rather than truncated.
 */

const BODY_FONT = 'body';

/* --------------------------------------------------------------------- geometry */

export interface PageGeometry {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  readonly titleSize: number;
  readonly metaSize: number;
  readonly headingSize: number;
  readonly bodySize: number;
  /** One table row, and the reason a row is atomic: every row is exactly this tall. */
  readonly rowHeight: number;
  /** One line of a heading, a meta entry or a note. */
  readonly lineHeight: number;
  readonly cellPadding: number;
  /** Beyond this a column wraps its heading rather than growing. */
  readonly maxColumnWidth: number;
  /** A graph's plotting area; its title, axis labels and legend are added around it (`E-05`). */
  readonly chartPlotHeight: number;
}

/** A4 upright, which is what a report is printed on and attached to an email as. */
export const A4_PORTRAIT: PageGeometry = {
  width: 595.28,
  height: 841.89,
  margin: 42,
  titleSize: 16,
  metaSize: 9,
  headingSize: 8,
  bodySize: 9,
  rowHeight: 13,
  lineHeight: 11,
  cellPadding: 6,
  maxColumnWidth: 150,
  chartPlotHeight: 130,
};

// In `media.ts`, where the report routes can read it without loading `pdfkit` (`H-19`).
export { MAX_PDF_PAGES };

/** Measures a string at a size, in points. Supplied by `pdfkit` in production, faked in tests. */
export type Measure = (text: string, size: number) => number;

/**
 * What the layout needs to know about the font: how wide a string is, and whether it can draw a
 * character at all.
 *
 * The second half is not a detail. **A font without a glyph draws `.notdef`**, which is a blank
 * box or nothing at all, and `pdfkit` does not complain — so a sensor called `東京ルーター` would
 * reach a filed PDF as six empty boxes with every layer of this system reporting success. That is
 * the exact failure `ADR-006` Decision 2 embedded a font to prevent, one alphabet further out
 * than the decision looked: DejaVu Sans covers Latin, Greek, Cyrillic and a good deal more, and
 * it has no CJK at all. In production this asks the whole font chain (`fonts.ts`, `E-12`).
 */
export interface Typesetter {
  readonly measure: Measure;
  /** Whether any font the document draws with has a glyph for this code point. */
  readonly has: (codePoint: number) => boolean;
}

/**
 * Replaces characters the font cannot draw with their Unicode notation.
 *
 * **Visible rather than silent, and lossless rather than approximate.** A blank box tells a reader
 * nothing; `U+6771 U+4EAC` tells them which characters were lost and lets them find the sensor.
 * `?` or `�` would be neither — they would say something went wrong without saying what, and two
 * different names would render identically. The document says once, in its header, that this
 * happened.
 */
export function drawable(text: string, has: (codePoint: number) => boolean): string {
  let out = '';
  let changed = false;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // The three that are not glyphs anywhere and are handled by the layout, not the font.
    if (code === 0x09 || code === 0x0a || code === 0x0d || has(code)) {
      out += character;
      continue;
    }
    changed = true;
    out += `${out === '' || out.endsWith(' ') ? '' : ' '}U+${code.toString(16).toUpperCase().padStart(4, '0')} `;
  }
  return changed ? out.replaceAll(/ {2,}/gu, ' ').trim() : text;
}

/** Whether anything an operator typed into this report is outside every font (see `drawable`). */
function anyUndrawable(document: ReportDocument, has: (codePoint: number) => boolean): boolean {
  const texts = [document.report.name, document.window.label, document.runAs];
  for (const section of document.sections) {
    texts.push(section.subject.name);
    if (section.note !== undefined) texts.push(section.note);
    for (const column of section.columns) texts.push(column.name, column.unit);
  }
  for (const adjustment of document.adjustments) texts.push(adjustment.reason);
  // Values and timestamps are not here on purpose: they are produced by `formatValue` and
  // `formatInstant` out of numbers, so they are digits, punctuation and an em dash — every one of
  // which the font has. Checking two hundred thousand of them would cost a great deal to learn
  // something this file already knows.
  return texts.some((text) => drawable(text, has) !== text);
}

/* ------------------------------------------------------------------ laid out */

export interface LaidOutColumn {
  readonly key: string;
  /** The heading, already wrapped to the column's width. */
  readonly heading: readonly string[];
  readonly width: number;
  /** Numbers are set to the right; a timestamp is not a number. */
  readonly numeric: boolean;
}

export interface LaidOutRow {
  readonly cells: readonly string[];
}

export interface PageBlock {
  readonly subject: ReportSubject;
  /**
   * The heading as it is drawn: the sensor's name, whether this carries on from the page before,
   * and which group of columns it holds.
   *
   * Composed here rather than in the drawing loop, so that what a page says is decided in the pure
   * half and asserted by a test, and the drawing loop has nothing left to decide.
   */
  readonly title: string;
  readonly columns: readonly LaidOutColumn[];
  readonly rows: readonly LaidOutRow[];
  /** Wrapped lines, drawn instead of a table when the section has no channels to show. */
  readonly note: readonly string[] | null;
  /**
   * A graph, drawn instead of a table (`E-05`). **Atomic**: a chart is never split across a page
   * break, because half an axis is not an axis.
   */
  readonly chart: ChartLayout | null;
  /** This block carries on a table the previous page started. */
  readonly continued: boolean;
  /** Which slice of a too-wide table this is, when there is more than one. */
  readonly group: { readonly index: number; readonly of: number } | null;
}

export interface LaidOutPage {
  readonly blocks: readonly PageBlock[];
  /** The report's own header block, on the first page only. */
  readonly header: readonly string[] | null;
}

/* -------------------------------------------------------------------- wrapping */

/**
 * Breaks text to a width, and breaks a word that is wider than the column.
 *
 * The hard break matters: a channel named by a discovery run can be one unbroken sixty-character
 * string, and a wrapper that only breaks at spaces would draw it straight through the next column.
 */
export function wrapText(text: string, width: number, size: number, measure: Measure): string[] {
  if (text === '') return [''];
  const lines: string[] = [];
  let line = '';
  const push = (): void => {
    if (line !== '') lines.push(line);
    line = '';
  };
  for (const word of text.split(/\s+/u)) {
    if (word === '') continue;
    const candidate = line === '' ? word : `${line} ${word}`;
    if (measure(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    push();
    if (measure(word, size) <= width) {
      line = word;
      continue;
    }
    // A single word wider than the column: broken by character rather than allowed to overflow.
    let piece = '';
    for (const character of word) {
      if (piece !== '' && measure(piece + character, size) > width) {
        lines.push(piece);
        piece = '';
      }
      piece += character;
    }
    line = piece;
  }
  push();
  return lines.length === 0 ? [''] : lines;
}

/* ------------------------------------------------------------------ pagination */

const TIME_HEADING = 'Time';

function headingOf(name: string, unit: string): string {
  return unit === '' ? name : `${name} (${unit})`;
}

/** The cells of one section, formatted exactly as the HTML renderer formats them. */
function cellsOf(section: ReportSection, timezone: string): LaidOutRow[] {
  return section.rows.map((entry) => ({
    cells: [
      formatInstant(entry.at, timezone),
      ...entry.values.map((value, index) => {
        const rendered = formatValue(value, section.columns[index]?.decimals ?? null);
        // **The gap, drawn rather than left blank**, and the footer on every page says what it
        // means. A blank cell in a printed table reads as an oversight.
        return rendered === '' ? '—' : rendered;
      }),
    ],
  }));
}

/** A column, before its width is stretched to the page and its heading is wrapped. */
interface NaturalColumn {
  readonly key: string;
  readonly heading: string;
  readonly width: number;
  readonly numeric: boolean;
}

/** A column wide enough for its widest cell, and no wider than `maxColumnWidth`. */
function columnsOf(
  section: ReportSection,
  rows: readonly LaidOutRow[],
  type: Typesetter,
  geometry: PageGeometry,
): NaturalColumn[] {
  const measure = type.measure;
  const headings = [
    TIME_HEADING,
    ...section.columns.map((c) => drawable(headingOf(c.name, c.unit), type.has)),
  ];
  const keys = ['time', ...section.columns.map((c) => c.key)];
  return headings.map((heading, index) => {
    let widest = 0;
    for (const row of rows) {
      widest = Math.max(widest, measure(row.cells[index] ?? '', geometry.bodySize));
    }
    // A heading may wrap, so a column need only be as wide as the heading's longest *word* — but
    // never narrower than its widest value, which cannot wrap without becoming unreadable.
    let headingWord = 0;
    for (const word of heading.split(/\s+/u)) {
      headingWord = Math.max(headingWord, measure(word, geometry.headingSize));
    }
    return {
      key: keys[index] ?? String(index),
      heading,
      width: Math.min(
        geometry.maxColumnWidth,
        Math.max(widest, headingWord) + geometry.cellPadding * 2,
      ),
      numeric: index > 0,
    };
  });
}

/**
 * Spreads the leftover width over the columns, and wraps each heading to what it ends up with.
 *
 * **A table of three narrow columns against the left edge of A4 reads as a fragment of a page
 * rather than a document**, and the rule under the headings then runs three times the length of
 * the table it belongs to. The slack is shared out in proportion to what each column already
 * needed, so the timestamps keep their share and the numbers keep theirs — and the headings are
 * wrapped *after* the stretch, because a heading that fits the widened column should not be split
 * across two lines for a width the column no longer has.
 */
function stretch(
  columns: readonly NaturalColumn[],
  available: number,
  type: Typesetter,
  geometry: PageGeometry,
): LaidOutColumn[] {
  let natural = 0;
  for (const column of columns) natural += column.width;
  const scale = natural > 0 && natural < available ? available / natural : 1;
  return columns.map((column) => {
    const width = column.width * scale;
    return {
      key: column.key,
      heading: wrapText(
        column.heading,
        width - geometry.cellPadding * 2,
        geometry.headingSize,
        type.measure,
      ),
      width,
      numeric: column.numeric,
    };
  });
}

/**
 * Splits columns that do not fit the page into groups, repeating the time column.
 *
 * A report over a sensor with twenty channels is a wide table, and the alternatives to splitting
 * it are both unacceptable: clipping loses a measurement silently, and shrinking the type until it
 * fits produces a document nobody can read and no rule about when to stop.
 */
function groupColumns(columns: readonly NaturalColumn[], available: number): NaturalColumn[][] {
  const time = columns[0];
  if (time === undefined) return [];
  const groups: NaturalColumn[][] = [];
  let current: NaturalColumn[] = [time];
  let used = time.width;
  for (const column of columns.slice(1)) {
    if (current.length > 1 && used + column.width > available) {
      groups.push(current);
      current = [time];
      used = time.width;
    }
    current.push(column);
    used += column.width;
  }
  groups.push(current);
  return groups;
}

/** The report's own header, as lines, wrapped to the page. */
function headerLines(document: ReportDocument, type: Typesetter, geometry: PageGeometry): string[] {
  const width = geometry.width - geometry.margin * 2;
  const zone = document.window.timezone;
  const lines = [
    `Period: ${document.window.label}`,
    `From: ${formatInstant(document.window.from, zone)}`,
    `To: ${formatInstant(document.window.to, zone)}`,
    `Renders as: ${document.runAs}`,
    `Averaging: ${String(document.resolution.bucketSeconds)} s`,
  ];
  for (const adjustment of document.adjustments) lines.push(`Adjusted: ${adjustment.reason}`);
  if (document.unavailable.length > 0) {
    lines.push(
      `${String(document.unavailable.length)} of this report’s objects could not be rendered ` +
        `and are not included: ${document.unavailable.join(', ')}.`,
    );
  }
  if (anyUndrawable(document, type.has)) {
    // Said once, where the reader of the document will see it — rather than in a log nobody
    // reading the PDF has access to.
    lines.push(
      'Some characters in this report are outside every font it is drawn with and appear as ' +
        'their Unicode notation, like U+20B9F.',
    );
  }
  return lines.flatMap((line) =>
    wrapText(drawable(line, type.has), width, geometry.metaSize, type.measure),
  );
}

const BLOCK_GAP = 14;
/** Fewer rows than this at the foot of a page is an orphan; the block starts on the next one. */
const MIN_ROWS_ON_A_PAGE = 3;

function headingHeight(columns: readonly LaidOutColumn[], geometry: PageGeometry): number {
  let lines = 1;
  for (const column of columns) lines = Math.max(lines, column.heading.length);
  return lines * geometry.lineHeight + 4;
}

function titleHeight(geometry: PageGeometry): number {
  return geometry.lineHeight + 4;
}

/**
 * The document, as pages. Pure — no `pdfkit`, no font, no clock.
 */
export function paginate(
  document: ReportDocument,
  type: Typesetter,
  geometry: PageGeometry = A4_PORTRAIT,
): LaidOutPage[] {
  const available = geometry.width - geometry.margin * 2;
  // The footer sits inside the bottom margin's neighbourhood; the table stops above it.
  const bottom = geometry.height - geometry.margin - geometry.lineHeight * 2;
  const header = headerLines(document, type, geometry);
  const headerHeight = geometry.titleSize + 8 + header.length * geometry.lineHeight + BLOCK_GAP;

  const pages: LaidOutPage[] = [];
  let blocks: PageBlock[] = [];
  let y = geometry.margin + headerHeight;
  let first = true;

  const flush = (): void => {
    pages.push({ blocks, header: first ? header : null });
    blocks = [];
    first = false;
    y = geometry.margin;
  };

  /** The heading a block is drawn with — the name, whether it carries on, and which group. */
  const titleOf = (
    name: string,
    continued: boolean,
    group: { index: number; of: number } | null,
  ): string =>
    drawable(name, type.has) +
    (continued ? ' (continued)' : '') +
    (group === null ? '' : ` — columns ${String(group.index)} of ${String(group.of)}`);

  // What the template shows (`E-05`), and the time axis every chart in the document shares.
  const graphed = showsGraph(document.report.kind);
  const tabled = showsTable(document.report.kind);
  const ticks = graphed
    ? timeTicksFor(document.window.from, document.window.to, document.window.timezone)
    : [];

  for (const section of document.sections) {
    if (section.note !== undefined) {
      const note = wrapText(
        drawable(section.note, type.has),
        available,
        geometry.metaSize,
        type.measure,
      );
      const height = titleHeight(geometry) + note.length * geometry.lineHeight + BLOCK_GAP;
      if (y + height > bottom && blocks.length > 0) flush();
      blocks.push({
        subject: section.subject,
        title: titleOf(section.subject.name, false, null),
        columns: [],
        rows: [],
        note,
        chart: null,
        continued: false,
        group: null,
      });
      y += height;
      continue;
    }

    if (graphed) {
      const charts = chartsFor(section, document.window, ticks, {
        width: available,
        plotHeight: geometry.chartPlotHeight,
        fontSize: geometry.headingSize,
        measure: type.measure,
        // A legend entry is operator text like any other, and gets the same treatment as the
        // table's heading: a character the font cannot draw is written as what it is.
        text: (raw) => drawable(raw, type.has),
      });
      for (const layout of charts) {
        if (layout.empty) {
          // Said in words, as in the HTML — see `renderHtml`.
          const note = wrapText(
            `No readings were recorded for ${layout.title} in this period.`,
            available,
            geometry.metaSize,
            type.measure,
          );
          const height = titleHeight(geometry) + note.length * geometry.lineHeight + BLOCK_GAP;
          if (y + height > bottom && blocks.length > 0) flush();
          blocks.push({
            subject: section.subject,
            title: titleOf(section.subject.name, false, null),
            columns: [],
            rows: [],
            note,
            chart: null,
            continued: false,
            group: null,
          });
          y += height;
          continue;
        }
        const height = titleHeight(geometry) + layout.height + BLOCK_GAP;
        if (y + height > bottom && blocks.length > 0) flush();
        blocks.push({
          subject: section.subject,
          title: titleOf(section.subject.name, false, null),
          columns: [],
          rows: [],
          note: null,
          chart: layout,
          continued: false,
          group: null,
        });
        y += height;
      }
    }
    if (!tabled) continue;

    const rows = cellsOf(section, document.window.timezone);
    const groups = groupColumns(columnsOf(section, rows, type, geometry), available).map((group) =>
      stretch(group, available, type, geometry),
    );
    for (const [index, columns] of groups.entries()) {
      const group = groups.length > 1 ? { index: index + 1, of: groups.length } : null;
      // The cells this group of columns holds, in the order the group has them.
      const picked = rows.map((row) => ({
        cells: columns.map((column) => {
          const at =
            column.key === 'time'
              ? 0
              : section.columns.findIndex((one) => one.key === column.key) + 1;
          return row.cells[at] ?? '';
        }),
      }));
      const fixed = titleHeight(geometry) + headingHeight(columns, geometry);
      let placed = 0;
      let continued = false;
      do {
        const room = bottom - y - fixed;
        const fits = Math.max(0, Math.floor(room / geometry.rowHeight));
        const left = picked.length - placed;
        const take = Math.min(fits, left);
        // Start on the next page rather than leave a heading with an orphan under it — unless
        // nothing is on this page yet, in which case the next page is no better.
        if (take < Math.min(MIN_ROWS_ON_A_PAGE, left) && blocks.length > 0) {
          flush();
          continue;
        }
        blocks.push({
          subject: section.subject,
          title: titleOf(section.subject.name, continued, group),
          columns,
          rows: picked.slice(placed, placed + take),
          note: null,
          chart: null,
          continued,
          group,
        });
        placed += take;
        continued = true;
        y += fixed + take * geometry.rowHeight + BLOCK_GAP;
        if (placed < picked.length) flush();
      } while (placed < picked.length);
    }
  }

  if (blocks.length > 0 || pages.length === 0) flush();
  return pages;
}

/**
 * The fewest pages this document could possibly take (`P-204`).
 *
 * **For refusing before the expensive part.** `P-203` measured a PDF refused for its page count
 * spending a second and a half getting there, because the count is only known once every cell has
 * been measured. A lower bound needs no measuring at all: every table row is one row high, and a
 * page can hold no more rows than fit under one title and a one-line heading. So the total rows,
 * divided by that, is a number the real count can never be under.
 *
 * **The total, not a sum per section.** Per-section page counts would over-count — small sections
 * share pages — and a bound that can over-count would refuse a report that fits. Everything this
 * ignores (headings that wrap, column groups, charts, the report's own header) only ever adds
 * pages, so ignoring it keeps the bound a bound. `report-pdf.test.ts` asserts that it is one.
 */
export function minimumPages(
  document: ReportDocument,
  geometry: PageGeometry = A4_PORTRAIT,
): number {
  if (!showsTable(document.report.kind)) return 1;
  let rows = 0;
  for (const section of document.sections) {
    if (section.note === undefined && section.columns.length > 0) rows += section.rows.length;
  }
  const bottom = geometry.height - geometry.margin - geometry.lineHeight * 2;
  const room = bottom - geometry.margin - titleHeight(geometry) - (geometry.lineHeight + 4);
  const perPage = Math.max(1, Math.floor(room / geometry.rowHeight));
  return Math.max(1, Math.ceil(rows / perPage));
}

function refuseIfTooLong(
  pages: number,
  document: ReportDocument,
  estimate: 'counted' | 'at least' = 'counted',
): void {
  if (pages <= MAX_PDF_PAGES) return;
  throw new ReportError(
    'REPORT_TOO_LARGE',
    `this report is ${estimate === 'at least' ? 'at least ' : ''}${String(pages)} pages as a PDF, ` +
      `and the limit is ${String(MAX_PDF_PAGES)}; ` +
      'cover fewer sensors, choose a shorter span, pin a coarser averaging interval, or render ' +
      'it as CSV, which has no page count',
    {
      context: { reportId: document.report.id, phase: 'render' },
      details: { pages, limit: MAX_PDF_PAGES, estimate },
    },
  );
}

/* --------------------------------------------------------------------- drawing */

/**
 * Text, measured and drawn through the font chain (`E-12`).
 *
 * Every string the drawing code writes goes through here, because a sensor name can be three fonts
 * long: `Маршрут 東京 core` is DejaVu, WenQuanYi and DejaVu again. **Text one font draws is written
 * with one `pdfkit` call, exactly as before this existed**, so a report with nothing outside DejaVu
 * is the document it always was. Text that needs more than one is written run by run, each placed
 * after the width of the last and lowered by the difference in the two fonts' ascents — `pdfkit`
 * sets text by the top of its font, and two fonts have two tops, but one line has one baseline.
 */
interface Pen {
  measure(text: string, size: number): number;
  write(
    text: string,
    x: number,
    y: number,
    size: number,
    options?: { readonly width?: number; readonly align?: 'left' | 'right' },
  ): void;
}

function penFor(doc: PDFKit.PDFDocument, fonts: FontChain): Pen {
  const primary = fonts.primary;
  doc.registerFont(BODY_FONT, primary.bytes);
  const registered = new Set<string>([BODY_FONT]);
  /** Sets the document in the font a run is drawn with, registering it the first time. */
  const use = (index: number, size: number): { ascender: number } => {
    const font = fonts.font(index) ?? primary;
    if (!registered.has(font.key)) {
      doc.registerFont(
        font.key,
        font.bytes,
        ...(font.source.face === '' ? [] : [font.source.face]),
      );
      registered.add(font.key);
    }
    doc.font(font.key).fontSize(size);
    return font;
  };
  const onlyPrimary = (runs: readonly { font: number }[]): boolean =>
    runs.length === 1 && runs[0]?.font === 0;

  return {
    measure(text, size) {
      const runs = fonts.runs(text);
      if (onlyPrimary(runs)) return doc.font(BODY_FONT).fontSize(size).widthOfString(text);
      let width = 0;
      for (const run of runs) {
        use(run.font, size);
        width += doc.widthOfString(run.text);
      }
      doc.font(BODY_FONT);
      return width;
    },
    write(text, x, y, size, options = {}) {
      const runs = fonts.runs(text);
      if (onlyPrimary(runs)) {
        doc
          .font(BODY_FONT)
          .fontSize(size)
          .text(text, x, y, {
            ...(options.width === undefined ? {} : { width: options.width }),
            ...(options.align === undefined ? {} : { align: options.align }),
            lineBreak: false,
          });
        return;
      }
      const total = this.measure(text, size);
      let at =
        options.align === 'right' && options.width !== undefined ? x + options.width - total : x;
      for (const run of runs) {
        const font = use(run.font, size);
        doc.text(run.text, at, y + ((primary.ascender - font.ascender) * size) / 1_000, {
          lineBreak: false,
        });
        at += doc.widthOfString(run.text);
      }
      doc.font(BODY_FONT);
    },
  };
}

const RULE = '#999999';
const HAIRLINE = '#dddddd';
const INK = '#1a1a1a';
const QUIET = '#555555';

/**
 * A chart, drawn where `layoutChart` put everything (`E-05`, `ADR-006` Decision 3).
 *
 * The same layout the HTML report draws as SVG, drawn as `pdfkit` primitives — no conversion
 * between the two, which is why `svg-to-pdfkit` was refused. Nothing here decides a position.
 */
function drawChart(
  doc: PDFKit.PDFDocument,
  pen: Pen,
  layout: ChartLayout,
  originX: number,
  originY: number,
  size: number,
): void {
  const theme = LIGHT_CHART_THEME;
  const x = (value: number): number => originX + value;
  const y = (value: number): number => originY + value;
  const { plot } = layout;

  doc.fillColor(theme.ink);
  pen.write(layout.title, x(0), y(0), size, { width: layout.width });

  for (const tick of layout.yTicks) {
    doc
      .moveTo(x(plot.left), y(tick.y))
      .lineTo(x(plot.right), y(tick.y))
      .lineWidth(0.5)
      .strokeColor(theme.grid)
      .stroke();
    doc.fillColor(theme.inkMuted);
    pen.write(tick.label, x(0), y(tick.y) - size * 0.6, size, {
      width: plot.left - 6,
      align: 'right',
    });
  }
  doc
    .moveTo(x(plot.left), y(plot.bottom))
    .lineTo(x(plot.right), y(plot.bottom))
    .lineWidth(0.8)
    .strokeColor(theme.axis)
    .stroke();
  for (const tick of layout.xTicks) {
    const width = pen.measure(tick.label, size);
    // `pdfkit` places text by its top, the layout by its baseline — 0.8 em between them.
    pen.write(tick.label, x(tick.x) - width / 2, y(layout.xLabelY) - size * 0.8, size, {
      width: width + 1,
    });
  }

  // Bands under lines, so a line is never hidden by its own spread.
  for (const series of layout.series) {
    const colour = seriesColour(theme, series.slot);
    for (const band of series.bands) {
      doc.save();
      doc.polygon(...band.map((point): [number, number] => [x(point.x), y(point.y)]));
      doc.fillOpacity(0.14).fill(colour);
      doc.restore();
    }
  }
  for (const series of layout.series) {
    const colour = seriesColour(theme, series.slot);
    // One `moveTo` per run: a gap is a subpath that was never drawn to, as in the SVG.
    for (const line of series.lines) {
      const [first, ...rest] = line;
      if (first === undefined) continue;
      doc.moveTo(x(first.x), y(first.y));
      for (const point of rest) doc.lineTo(x(point.x), y(point.y));
    }
    if (series.lines.length > 0) {
      doc.lineWidth(1.4).lineJoin('round').lineCap('round').strokeColor(colour).stroke();
    }
    for (const dot of series.dots) doc.circle(x(dot.x), y(dot.y), 1.8).fill(colour);
  }

  for (const entry of layout.legend) {
    doc.rect(x(entry.x), y(entry.y) - size * 0.8, 8, 8).fill(seriesColour(theme, entry.slot));
    doc.fillColor(theme.ink);
    pen.write(entry.label, x(entry.x + 12), y(entry.y) - size * 0.85, size);
  }
}

function draw(
  doc: PDFKit.PDFDocument,
  pen: Pen,
  pages: readonly LaidOutPage[],
  document: ReportDocument,
  geometry: PageGeometry,
  title: string,
): void {
  const left = geometry.margin;
  const available = geometry.width - geometry.margin * 2;

  for (const [index, page] of pages.entries()) {
    doc.addPage();
    let y = geometry.margin;

    if (page.header !== null) {
      doc.fillColor(INK);
      // The title is the one string the header block does not carry, and it is operator text.
      pen.write(title, left, y, geometry.titleSize, { width: available });
      y += geometry.titleSize + 8;
      doc.fillColor(QUIET);
      for (const line of page.header) {
        pen.write(line, left, y, geometry.metaSize, { width: available });
        y += geometry.lineHeight;
      }
      y += BLOCK_GAP;
    }

    for (const block of page.blocks) {
      doc.fillColor(INK);
      pen.write(block.title, left, y, geometry.bodySize, { width: available });
      y += titleHeight(geometry);

      if (block.chart !== null) {
        drawChart(doc, pen, block.chart, left, y, geometry.headingSize);
        y += block.chart.height + BLOCK_GAP;
        continue;
      }

      if (block.note !== null) {
        doc.fillColor(QUIET);
        for (const line of block.note) {
          pen.write(line, left, y, geometry.metaSize, { width: available });
          y += geometry.lineHeight;
        }
        y += BLOCK_GAP;
        continue;
      }

      const heading = headingHeight(block.columns, geometry);
      doc.fillColor(QUIET);
      let x = left;
      for (const column of block.columns) {
        let line = y;
        for (const part of column.heading) {
          pen.write(part, x + geometry.cellPadding, line, geometry.headingSize, {
            width: column.width - geometry.cellPadding * 2,
            align: column.numeric ? 'right' : 'left',
          });
          line += geometry.lineHeight;
        }
        x += column.width;
      }
      y += heading;
      doc
        .moveTo(left, y - 3)
        .lineTo(left + available, y - 3)
        .lineWidth(0.8)
        .strokeColor(RULE)
        .stroke();

      doc.fillColor(INK);
      for (const row of block.rows) {
        x = left;
        for (const [cell, column] of row.cells.map((c, i) => [c, block.columns[i]] as const)) {
          if (column === undefined) continue;
          pen.write(cell, x + geometry.cellPadding, y + 3, geometry.bodySize, {
            width: column.width - geometry.cellPadding * 2,
            align: column.numeric ? 'right' : 'left',
          });
          x += column.width;
        }
        y += geometry.rowHeight;
        doc
          .moveTo(left, y)
          .lineTo(left + available, y)
          .lineWidth(0.3)
          .strokeColor(HAIRLINE)
          .stroke();
      }
      y += BLOCK_GAP;
    }

    // The footer, on every page: what a dash means, and where this page is in the document.
    //
    // **The bottom margin is lifted while it is drawn.** `pdfkit` starts a new page when text
    // would cross the bottom margin, and a footer is by definition text below where the content
    // stops — so drawing it with the margin in place produced a document of empty pages, each
    // carrying nothing but the previous page's footer. Found by reading the pages back.
    const footer = geometry.height - geometry.margin - geometry.lineHeight * 2;
    const margins = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor(QUIET);
    // Two deliberate lines rather than one that wraps: a wrapped line puts its second half below
    // the page, where the margin that would have caught it has just been lifted.
    pen.write(
      'An empty interval is shown as — and means no reading was recorded, not a reading of zero.',
      left,
      footer,
      geometry.headingSize,
      { width: available },
    );
    pen.write(
      `Generated ${document.generatedAt.toISOString()}`,
      left,
      footer + geometry.lineHeight,
      geometry.headingSize,
      { width: available },
    );
    pen.write(
      `Page ${String(index + 1)} of ${String(pages.length)}`,
      left,
      footer + geometry.lineHeight,
      geometry.headingSize,
      { width: available, align: 'right' },
    );
    doc.page.margins.bottom = margins;
  }
}

/* ---------------------------------------------------------------------- render */

export async function renderPdf(
  document: ReportDocument,
  geometry: PageGeometry = A4_PORTRAIT,
): Promise<Buffer> {
  refuseIfTooLarge(document);
  // Before a font is loaded or a cell is measured (`P-204`): see `minimumPages`.
  refuseIfTooLong(minimumPages(document, geometry), document, 'at least');
  const doc = new PDFDocument({
    size: [geometry.width, geometry.height],
    margin: geometry.margin,
    // Pages are added by the drawing loop, so an empty report is one page rather than two.
    autoFirstPage: false,
    info: {
      Title: document.report.name,
      Author: 'ms-core',
      // From the document rather than the clock: a render is a function of its input, and two
      // renders of the same document differing only in a timestamp is a difference nobody wants
      // to have to explain.
      CreationDate: document.generatedAt,
    },
  });
  const pen = penFor(doc, reportFonts());

  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  const fonts = reportFonts();
  const type: Typesetter = {
    measure: (text, size) => pen.measure(text, size),
    has: (codePoint) => fonts.has(codePoint),
  };
  const pages = paginate(document, type, geometry);
  refuseIfTooLong(pages.length, document);
  draw(doc, pen, pages, document, geometry, drawable(document.report.name, type.has));
  doc.end();
  return await collected;
}

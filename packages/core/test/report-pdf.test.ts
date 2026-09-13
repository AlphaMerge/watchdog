import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  A4_PORTRAIT,
  MAX_PDF_PAGES,
  drawable,
  minimumPages,
  paginate,
  renderPdf,
  wrapText,
  type Measure,
  type PageGeometry,
  type Typesetter,
} from '../src/reports/pdf.js';
import { MAX_CELLS, type ReportDocument, type ReportSection } from '../src/reports/table.js';
import { readPdf } from './support/pdf.js';

/**
 * A report as a PDF (`E-06`, `ADR-006` Decisions 1 and 2).
 *
 * **This file is the argument `ADR-006` Decision 1 made.** It refused headless Chromium partly
 * because a Chromium-rendered PDF "can only be checked by looking at it", and promised that laying
 * the document out ourselves would be assertable instead. So the layout is tested twice over: once
 * as pure pagination, with a measuring function a test controls, and once by reading the finished
 * PDF back through its own `ToUnicode` map — which is how a reader gets the text out, and
 * therefore the only honest way to ask whether a Cyrillic sensor name survived.
 */

/** A monospace-ish measurer, so a layout assertion is arithmetic rather than a font's opinion. */
const measure: Measure = (text, size) => text.length * size * 0.5;

/** A font that can draw anything, which is what these layout tests are about. */
const type: Typesetter = { measure, has: () => true };

/** And one that stops at the end of Cyrillic, which is roughly where DejaVu Sans stops. */
const narrow: Typesetter = { measure, has: (codePoint) => codePoint < 0x05_00 };

const columns = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `c${String(index)}`,
    name: `Channel ${String(index)}`,
    unit: 'ms',
    decimals: 2,
  }));

const section = (
  rows: (number | null)[][],
  name = 'edge-router',
  channels = 2,
  id = 42,
): ReportSection => ({
  subject: { id, kind: 'sensor', name },
  columns: columns(channels),
  rows: rows.map((values, index) => ({
    at: new Date(Date.UTC(2026, 8, 1) + index * 3_600_000),
    values,
  })),
});

const straight = (count: number, channels = 2): (number | null)[][] =>
  Array.from({ length: count }, (_, index) => Array.from({ length: channels }, () => index + 0.5));

const doc = (sections: ReportSection[], extra: Partial<ReportDocument> = {}): ReportDocument => ({
  report: { id: 7, name: 'Monthly uptime', kind: 'table_only' },
  window: {
    from: new Date('2026-08-31T22:00:00Z'),
    to: new Date('2026-09-30T22:00:00Z'),
    label: '2026-09 (Europe/Berlin)',
    timezone: 'Europe/Berlin',
  },
  runAs: 'alice',
  generatedAt: new Date('2026-10-01T03:00:00Z'),
  resolution: { bucketSeconds: 3_600, source: 'sample_1h' },
  adjustments: [],
  unavailable: [],
  sections,
  ...extra,
});

/** Every string drawn anywhere in the document. */
const everything = (pages: readonly (readonly string[])[]): string[] => pages.flat();

describe('a report as a PDF', () => {
  describe('lays out text without letting any of it escape its column', () => {
    it('breaks at spaces, and breaks a word that is wider than the column', () => {
      assert.deepEqual(wrapText('Traffic in octets', 60, 8, measure), ['Traffic in', 'octets']);
      // **The case a space-only wrapper draws straight through the next column.** A channel named
      // by a discovery run is routinely one unbroken string.
      assert.deepEqual(wrapText('abcdefghij', 20, 8, measure), ['abcde', 'fghij']);
      assert.deepEqual(wrapText('', 100, 8, measure), ['']);
    });
  });

  describe('paginates a table the way a table has to be paginated', () => {
    it('repeats the column headings on every page', () => {
      // A page of numbers whose headings are forty pages back is a page nobody can read, and a
      // printed report is read out of order.
      const pages = paginate(doc([section(straight(400))]), type);
      assert.ok(pages.length > 3, `${String(pages.length)} pages`);
      for (const page of pages) {
        for (const block of page.blocks) {
          assert.deepEqual(
            block.columns.map((column) => column.heading.join(' ')),
            ['Time', 'Channel 0 (ms)', 'Channel 1 (ms)'],
          );
        }
      }
    });

    it('places every row exactly once, in order', () => {
      // The property that says no page break lost a row or drew one twice — which is the failure a
      // reader of a 300-page report would never notice.
      const rows = straight(400);
      const pages = paginate(doc([section(rows)]), type);
      const seen = pages.flatMap((page) => page.blocks.flatMap((block) => block.rows));
      assert.equal(seen.length, rows.length);
      assert.deepEqual(
        seen.map((row) => row.cells[0]),
        paginate(doc([section(rows)]), type)
          .flatMap((page) => page.blocks.flatMap((block) => block.rows))
          .map((row) => row.cells[0]),
      );
      assert.equal(new Set(seen.map((row) => row.cells[0])).size, rows.length, 'no row twice');
    });

    it('says which blocks are a continuation, and which are the start of a table', () => {
      const pages = paginate(doc([section(straight(400))]), type);
      const blocks = pages.flatMap((page) => page.blocks);
      const first = blocks[0];
      assert.ok(first !== undefined);
      assert.equal(first.continued, false, 'the first block starts the table');
      assert.equal(first.title, 'edge-router', 'and its heading is just the sensor');
      for (const block of blocks.slice(1)) {
        assert.equal(block.continued, true, 'and every later one says it carries on');
        assert.equal(block.title, 'edge-router (continued)', 'in the heading a reader sees');
      }
    });

    it('puts the report’s own header on the first page and nowhere else', () => {
      const pages = paginate(doc([section(straight(400))]), type);
      assert.ok(pages[0]?.header !== null && (pages[0]?.header?.length ?? 0) > 0);
      for (const page of pages.slice(1)) assert.equal(page.header, null);
    });

    it('packs small sections onto one page and gives a big one its own', () => {
      const small = paginate(
        doc([section(straight(3), 'a', 2, 1), section(straight(3), 'b', 2, 2)]),
        type,
      );
      assert.equal(small.length, 1, 'two short tables share a page');
      assert.deepEqual(
        small[0]?.blocks.map((block) => block.subject.name),
        ['a', 'b'],
      );
    });

    it('starts a section on the next page rather than orphaning two rows at the foot', () => {
      // A heading with one row under it at the bottom of a page is the thing pagination exists to
      // prevent; the rest of the table being overleaf makes it worse than a page break would be.
      const geometry: PageGeometry = { ...A4_PORTRAIT, height: 300 };
      const pages = paginate(
        doc([section(straight(9), 'first', 2, 1), section(straight(9), 'second', 2, 2)]),
        type,
        geometry,
      );
      for (const page of pages) {
        for (const block of page.blocks) {
          if (block.rows.length === 0) continue;
          assert.ok(
            block.rows.length >= 3 || block.rows.length === 9,
            `a block of ${String(block.rows.length)} rows is an orphan`,
          );
        }
      }
    });

    it('carries columns that do not fit to a following page, rather than clipping them', () => {
      // **The only silent failure this layout could have had.** A column drawn past the page edge
      // is a measurement that left the report without anything saying so.
      const pages = paginate(doc([section(straight(5, 24), 'wide', 24)]), type);
      const blocks = pages.flatMap((page) => page.blocks);
      assert.ok(blocks.length > 1, 'the table was split');
      for (const block of blocks) {
        assert.equal(block.columns[0]?.key, 'time', 'every group repeats the time column');
        assert.ok(block.group !== null && block.group.of > 1, 'and says which group it is');
        let width = 0;
        for (const column of block.columns) width += column.width;
        assert.ok(
          width <= A4_PORTRAIT.width - A4_PORTRAIT.margin * 2 + 0.5,
          `a group is ${String(width)} points wide`,
        );
      }
      const channels = blocks.flatMap((block) =>
        block.columns.filter((column) => column.key !== 'time').map((column) => column.key),
      );
      assert.equal(new Set(channels).size, 24, 'every channel is somewhere');
      assert.equal(channels.length, 24, 'and none of them twice');
    });

    it('draws a gap as a dash and a measured zero as a zero', () => {
      const pages = paginate(
        doc([
          section([
            [1.5, 0],
            [null, null],
            [0, 2.5],
          ]),
        ]),
        type,
      );
      const rows = pages[0]?.blocks[0]?.rows ?? [];
      assert.deepEqual(
        rows.map((row) => row.cells.slice(1)),
        [
          ['1.50', '0.00'],
          ['—', '—'],
          ['0.00', '2.50'],
        ],
      );
    });

    it('shows a character the font cannot draw, rather than drawing nothing', () => {
      // **`ADR-006` Decision 2 stopped one alphabet short.** DejaVu Sans covers Latin, Greek and
      // Cyrillic; it has no CJK, and a font with no glyph draws `.notdef` — a blank box — without
      // anything failing. That is the same silent-mojibake failure the decision embedded a font to
      // prevent, so the characters it cannot draw are shown as what they are.
      const page = paginate(doc([section(straight(2), '東京 router')]), narrow)[0];
      assert.ok(page !== undefined);
      assert.equal(page.blocks[0]?.title, 'U+6771 U+4EAC router');
      assert.ok(
        (page.header ?? []).some((line) => line.includes('outside the font')),
        'and the document says once that it happened',
      );
      // A name the font *can* draw is left exactly alone, header included.
      const plain = paginate(doc([section(straight(2), 'Маршрут')]), narrow)[0];
      assert.ok(plain !== undefined);
      assert.equal(plain.blocks[0]?.title, 'Маршрут');
      assert.ok(!(plain.header ?? []).some((line) => line.includes('outside the font')));
      assert.equal(
        drawable('ok', () => true),
        'ok',
      );
    });

    it('renders a section with no channels as its note, and no table', () => {
      const pages = paginate(
        doc([
          {
            subject: { id: 9, kind: 'device', name: 'a device' },
            columns: [],
            rows: [],
            note: 'this device has no channels yet',
          },
        ]),
        type,
      );
      const block = pages[0]?.blocks[0];
      assert.ok(block !== undefined);
      assert.deepEqual(block.note, ['this device has no channels yet']);
      assert.equal(block.rows.length, 0);
      assert.equal(block.columns.length, 0);
    });
  });

  describe('produces a document a reader can actually read', () => {
    it('embeds the font we reviewed, and not one the operating system happened to have', () => {
      // `ADR-006` Decision 2, and the supply chain behind it: the bytes in the tarball are the
      // bytes `assets/fonts/README.md` records, or this assertion is the first thing to say so.
      const path = new URL('../../assets/fonts/DejaVuSans.ttf', import.meta.url);
      const bytes = readFileSync(path);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        'abdc775b21b1bc470d50c97e790d276f2054b7504e56e5bd3e64f48d68582322',
      );
      assert.equal(bytes.length, 759_720);
    });

    it('writes a Cyrillic sensor name as text, not as mojibake', async () => {
      // **The measurement that decided Decision 2.** `pdfkit`'s standard fonts encode WinAnsi;
      // asked for `Маршрут` one of them emits truncated code points *without throwing*. This
      // reads the text back out through the document's own `ToUnicode` map — the way a reader
      // copies it — so it fails if the embedded font or its mapping is ever lost.
      const pdf = await renderPdf(doc([section(straight(2), 'Маршрут — Bürorouter 東京')]));
      const readout = readPdf(pdf);
      const drawn = everything(readout.pages);
      // Cyrillic, an umlaut and an em dash come back as themselves; the two CJK characters the
      // font has no glyph for come back as what they are rather than as two empty boxes, which is
      // what this test caught the first version of this renderer doing.
      assert.ok(
        drawn.includes('Маршрут — Bürorouter U+6771 U+4EAC'),
        JSON.stringify(readout.pages[0]?.slice(0, 12)),
      );
      assert.ok(
        drawn.some((line) => line.includes('outside the font it is drawn with')),
        'and the document says so where its reader will see it',
      );
      assert.ok(
        readout.fonts.some((font) => font.endsWith('+DejaVuSans')),
        readout.fonts.join(','),
      );
    });

    it('says the same things the other three formats say', async () => {
      const document = doc([section(straight(2))], { unavailable: [11, 12] });
      const drawn = everything(readPdf(await renderPdf(document)).pages);
      assert.ok(drawn.includes('Monthly uptime'), 'the report’s name');
      assert.ok(drawn.includes('Period: 2026-09 (Europe/Berlin)'), 'the period');
      assert.ok(drawn.includes('Renders as: alice'), 'the account it rendered through');
      assert.ok(drawn.includes('Averaging: 3600 s'), 'the averaging interval');
      assert.ok(
        drawn.some((line) => line.includes('could not be rendered') && line.includes('11, 12')),
        'and what it did not render',
      );
    });

    it('draws a gap as a dash, and says on every page what a dash means', async () => {
      const pdf = await renderPdf(
        doc([
          section([
            [1.5, 0],
            [null, null],
          ]),
        ]),
      );
      const readout = readPdf(pdf);
      const drawn = everything(readout.pages);
      assert.equal(drawn.filter((text) => text === '—').length, 2, 'both empty cells');
      assert.ok(drawn.includes('0.00'), 'and a measured zero is still a zero');
      for (const page of readout.pages) {
        assert.ok(
          page.some((text) => text.includes('not a reading of zero')),
          'every page explains the dash',
        );
      }
    });

    it('numbers its pages, and repeats the heading with the sensor when a table carries on', async () => {
      const pdf = await renderPdf(doc([section(straight(120))]));
      const readout = readPdf(pdf);
      assert.ok(readout.pages.length >= 2, `${String(readout.pages.length)} pages`);
      assert.equal(readout.pageCount, readout.pages.length, 'the page tree agrees with the pages');
      const last = readout.pages.length;
      assert.ok(readout.pages[0]?.includes(`Page 1 of ${String(last)}`));
      assert.ok(readout.pages[last - 1]?.includes(`Page ${String(last)} of ${String(last)}`));
      assert.ok(readout.pages[1]?.includes('edge-router (continued)'));
      assert.ok(readout.pages[1]?.includes('Channel 0 (ms)'), 'with its headings again');
    });

    it('renders the same document to the same bytes', async () => {
      // Which is what makes the stored SHA-256 and the download’s `ETag` mean anything, and is
      // why the creation date comes from the document rather than from the clock.
      const document = doc([section(straight(30))]);
      const first = await renderPdf(document);
      const second = await renderPdf(document);
      assert.ok(first.equals(second), 'two renders of one document differ');
    });
  });

  describe('refuses what it cannot sensibly produce', () => {
    // Measured rather than asserted: 10,000 rows over two channels is 185 pages and 1.5 s, so the
    // bound is roughly three seconds of work and under a megabyte. A small page keeps these tests
    // to a fraction of that while exercising the same arithmetic.
    const short: PageGeometry = { ...A4_PORTRAIT, height: 160 };

    it('refuses a report that is too many pages before measuring a single cell', async () => {
      const document = doc([section(straight(1_400))]);
      assert.ok(minimumPages(document, short) > MAX_PDF_PAGES);
      await assert.rejects(
        () => renderPdf(document, short),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_TOO_LARGE');
          assert.equal((error as { status: number }).status, 422);
          assert.equal((error as { details: { estimate: string } }).details.estimate, 'at least');
          assert.match((error as { message: string }).message, /at least \d+ pages as a PDF/u);
          assert.match((error as { message: string }).message, /render it as CSV/u);
          return true;
        },
      );
    });

    it('still refuses by the real count when the bound was not enough to tell', async () => {
      // Column groups print every row once per group, which the bound deliberately ignores.
      const document = doc([section(straight(300, 14), 'edge-router', 14)]);
      assert.ok(minimumPages(document, short) <= MAX_PDF_PAGES);
      assert.ok(paginate(document, type, short).length > MAX_PDF_PAGES);
      await assert.rejects(
        () => renderPdf(document, short),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_TOO_LARGE');
          assert.equal((error as { details: { estimate: string } }).details.estimate, 'counted');
          assert.doesNotMatch((error as { message: string }).message, /at least/u);
          return true;
        },
      );
    });

    it('does not count a page per section when sections share pages', () => {
      // The easy wrong bound, and the one a random document rarely reaches: twelve short tables fit
      // on two pages, and a bound summed per section would say twelve.
      const document = doc(
        Array.from({ length: 12 }, (_, index) =>
          section(straight(4), `s${String(index)}`, 2, index),
        ),
      );
      const pages = paginate(document, type).length;
      assert.ok(pages < 12, `twelve short tables took ${String(pages)} pages`);
      assert.ok(minimumPages(document) <= pages);
    });

    it('never puts its lower bound above the pages a document really takes', () => {
      // A bound that can over-count refuses a report that fits — the one mistake it must not make.
      const arbitrarySection = fc.record({
        rows: fc.integer({ min: 0, max: 120 }),
        channels: fc.integer({ min: 1, max: 16 }),
        name: fc.string({ minLength: 1, maxLength: 60 }),
        note: fc.option(fc.string({ minLength: 1, maxLength: 300 }), { nil: undefined }),
      });
      fc.assert(
        fc.property(
          fc.array(arbitrarySection, { minLength: 0, maxLength: 8 }),
          fc.constantFrom('table_only', 'graph_only', 'graph_and_table'),
          fc.integer({ min: 160, max: 900 }),
          (sections, kind, height) => {
            const geometry: PageGeometry = { ...A4_PORTRAIT, height };
            const document = doc(
              sections.map((one, index) => {
                const base = section(
                  straight(one.rows, one.channels),
                  one.name,
                  one.channels,
                  index,
                );
                return one.note === undefined
                  ? base
                  : { ...base, columns: [], rows: [], note: one.note };
              }),
              { report: { id: 7, name: 'Monthly uptime', kind } },
            );
            const pages = paginate(document, type, geometry).length;
            assert.ok(
              minimumPages(document, geometry) <= pages,
              `bound ${String(minimumPages(document, geometry))} over ${String(pages)} pages`,
            );
          },
        ),
        { numRuns: 200 },
      );
    });

    it('refuses a document over the cell limit before it tries to draw it', async () => {
      const huge: ReportSection = {
        subject: { id: 1, kind: 'sensor', name: 'big' },
        columns: columns(2),
        rows: Array.from({ length: MAX_CELLS }, () => ({ at: new Date(0), values: [1, 2] })),
      };
      await assert.rejects(
        () => renderPdf(doc([huge])),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_TOO_LARGE');
          assert.match((error as { message: string }).message, /cover fewer sensors/u);
          return true;
        },
      );
    });
  });
});

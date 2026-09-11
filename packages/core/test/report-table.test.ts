import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MAX_CELLS,
  countCells,
  csvField,
  escapeHtml,
  formatInstant,
  formatValue,
  renderCsv,
  renderHtml,
  type ReportDocument,
  type ReportSection,
} from '../src/reports/table.js';

/**
 * Rendering a data table (`E-04`).
 *
 * Two rules carry this file. **A gap is a gap in CSV as much as in a graph** — `CLAUDE.md`'s
 * no-data-is-not-zero applied to the most durable thing this system emits, a document read months
 * later by somebody who cannot check. And **a sensor's name reaches a spreadsheet**, which
 * executes formulas.
 *
 * Pure, so every case here is a string in and a string out.
 */

const BASE: Omit<ReportDocument, 'sections'> = {
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
};

const section = (rows: (number | null)[][], name = 'edge-router'): ReportSection => ({
  subject: { id: 42, kind: 'sensor', name },
  columns: [
    { key: 'in', name: 'Traffic in', unit: 'octets/s', decimals: 0 },
    { key: 'loss', name: 'Packet loss', unit: '%', decimals: 2 },
  ],
  rows: rows.map((values, index) => ({
    at: new Date(Date.UTC(2026, 8, 1, index)),
    values,
  })),
});

const doc = (sections: ReportSection[], extra: Partial<ReportDocument> = {}): ReportDocument => ({
  ...BASE,
  sections,
  ...extra,
});

describe('a rendered data table', () => {
  describe('keeps a gap a gap, which is the whole point of the ticket', () => {
    it('writes an empty CSV field for a missing reading, never a zero', () => {
      const csv = renderCsv(
        doc([
          section([
            [100, 0],
            [null, null],
            [0, 0],
          ]),
        ]),
      );
      const rows = csv.split('\r\n').filter((line) => line.startsWith('2026-09-01T'));
      assert.equal(rows.length, 3);
      assert.ok(rows[0]?.endsWith(',100,0.00'), rows[0]);
      // **The case this file exists for.** Two empty fields, not two zeroes.
      assert.ok(rows[1]?.endsWith(',,'), rows[1]);
      // And a measured zero is still a zero, so the two are distinguishable in the output.
      assert.ok(rows[2]?.endsWith(',0,0.00'), rows[2]);
    });

    it('prints a row whose channels are all missing, rather than dropping it', () => {
      // Dropping it would compress time: a reader counting rows would conclude the sensor was
      // only monitored for two hours of the three the report claims to cover.
      const csv = renderCsv(
        doc([
          section([
            [1, 1],
            [null, null],
            [3, 3],
          ]),
        ]),
      );
      const stamps = csv.split('\r\n').filter((line) => line.startsWith('2026-09-01T'));
      assert.equal(stamps.length, 3);
      // 01:00Z is 03:00 in Berlin — the hour with nothing in it, still carrying its timestamp.
      assert.ok(stamps[1]?.startsWith('2026-09-01T03:00:00+02:00'), stamps[1]);
      assert.equal(stamps[1], '2026-09-01T03:00:00+02:00,,');
    });

    it('shows a gap in HTML as a marked cell rather than a blank one', () => {
      const html = renderHtml(doc([section([[null, null]])]));
      assert.match(html, /<td class="gap" title="no data was recorded in this interval">—<\/td>/u);
      assert.ok(!html.includes('<td>0</td>'), 'and nothing rendered a zero');
      // Said in the document itself, because the reader of a printed table was not told anywhere
      // else what a dash means.
      assert.match(html, /means no reading was recorded, not a reading of zero/u);
    });

    it('refuses to invent a number for a value that is not one', () => {
      // `Infinity` or `NaN` reaching a spreadsheet is neither a measurement nor a gap. It is data
      // we do not have, and it renders as one.
      assert.equal(formatValue(Number.NaN, 2), '');
      assert.equal(formatValue(Number.POSITIVE_INFINITY, null), '');
      assert.equal(formatValue(null, 2), '');
      assert.equal(formatValue(0, 2), '0.00');
      assert.equal(formatValue(1.5, null), '1.5');
    });

    it('renders the same values in both formats, gaps included', () => {
      // The two formats have to agree about every cell, and the way that is guaranteed is that
      // they are the same document formatted twice. This is the assertion that says so.
      const rows = [
        [1, 2],
        [null, 2],
        [0, null],
        [null, null],
        [-3, 99.999],
      ];
      const document = doc([section(rows)]);
      const csvCells = renderCsv(document)
        .split('\r\n')
        .filter((line) => line.startsWith('2026-09-01T'))
        .map((line) => line.split(',').slice(1));
      const htmlCells = [...renderHtml(document).matchAll(/<tr><td>2026[^<]*<\/td>(.*?)<\/tr>/gsu)]
        .map(([, cells]) => [...(cells ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/gu)])
        .map((cells) => cells.map(([, value]) => (value === '—' ? '' : value)));
      assert.ok(htmlCells.length > 0, 'the HTML rows were found at all');

      assert.equal(csvCells.length, rows.length);
      assert.deepEqual(htmlCells, csvCells);
    });
  });

  describe('does not let a sensor name run as a formula', () => {
    it('defuses every character a spreadsheet treats as the start of one', () => {
      // `=cmd|'/C calc'!A0` is the classic, and a report is precisely the document somebody opens
      // in Excel without thinking about it. Tab and carriage return are here because Excel strips
      // leading whitespace before deciding.
      for (const name of ["=cmd|'/C calc'!A0", '+1+1', '-2+3', '@SUM(A1)', '\tSUM', '\rSUM']) {
        const csv = renderCsv(doc([section([[1, 1]], name)]));
        const line = csv.split('\r\n').find((one) => one.startsWith('Sensor,'));
        assert.ok(line, name);
        assert.match(line, /^Sensor,"'/u, `"${name}" was not defused`);
      }
    });

    it('leaves a negative number alone, which a blanket guard would not', () => {
      // **The half that is easy to get wrong.** `-5` starts with `-`; prefixing it would write
      // `'-5` and turn a measurement into text in every spreadsheet that opened the file.
      const csv = renderCsv(doc([section([[-5, -0.25]])]));
      const row = csv.split('\r\n').find((line) => line.startsWith('2026-09-01T'));
      assert.ok(row !== undefined && row.endsWith(',-5,-0.25'), row);
      assert.ok(!row.includes("'-"), 'no apostrophe anywhere near the numbers');
    });

    it('quotes and escapes to RFC 4180, so a comma in a name is not a column', () => {
      assert.equal(csvField('plain'), 'plain');
      assert.equal(csvField('a,b'), '"a,b"');
      assert.equal(csvField('say "hi"'), '"say ""hi"""');
      assert.equal(csvField('two\r\nlines'), '"two\r\nlines"');
      assert.equal(csvField('=danger'), `"'=danger"`);
      assert.equal(csvField('-5', { numeric: true }), '-5');
    });

    it('escapes a name into HTML rather than into the document’s markup', () => {
      // The same names reach an emailed HTML document, where the failure is script rather than
      // formula.
      const html = renderHtml(doc([section([[1, 1]], '<script>alert(1)</script>')]));
      assert.ok(!html.includes('<script>alert(1)</script>'));
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
      assert.equal(
        escapeHtml(`<a href="x" & 'y'>`),
        '&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;',
      );
    });

    it('fetches nothing from anywhere, so an emailed report is not a read receipt', () => {
      const html = renderHtml(doc([section([[1, 1]])]));
      assert.ok(!/https?:\/\//u.test(html), 'no absolute URL anywhere in the document');
      assert.ok(!/<(?:img|script|link)\b/u.test(html), 'and nothing that would fetch one');
    });
  });

  describe('says what it did not render', () => {
    it('names the period, the account and the averaging in both formats', () => {
      // A CSV that has been forwarded twice has lost whatever the email said. The period and the
      // account it was rendered through are part of the finding, not metadata.
      const document = doc([section([[1, 1]])]);
      for (const rendered of [renderCsv(document), renderHtml(document)]) {
        assert.ok(rendered.includes('2026-09 (Europe/Berlin)'), 'the period');
        assert.ok(rendered.includes('alice'), 'the account it rendered through');
        assert.ok(rendered.includes('3600'), 'the averaging interval');
      }
    });

    it('prints what the span rules changed, rather than swallowing it', () => {
      const document = doc([section([[1, 1]])], {
        adjustments: [
          {
            kind: 'resolution-coarsened',
            reason: 'ranges of 40 days or more are averaged over at least 60 minutes',
            requestedSeconds: 300,
            effectiveSeconds: 3_600,
          },
        ],
      });
      assert.ok(renderCsv(document).includes('averaged over at least 60 minutes'));
      assert.ok(renderHtml(document).includes('averaged over at least 60 minutes'));
    });

    it('counts the subjects it could not render, in the document itself', () => {
      // `E-03` hands these over as bare ids. A report that simply omitted them would cover seven
      // of the ten sensors it names and say nothing — the failure this whole surface is about.
      const document = doc([section([[1, 1]])], { unavailable: [11, 12, 13] });
      assert.match(renderCsv(document), /Not rendered.*3 of this report/u);
      assert.match(renderHtml(document), /3 of this report’s objects could not be rendered/u);
      assert.ok(renderHtml(document).includes('11, 12, 13'));
    });

    it('explains an empty section rather than printing an empty table', () => {
      const document = doc([
        {
          subject: { id: 9, kind: 'device', name: 'a device' },
          columns: [],
          rows: [],
          note: 'nope',
        },
      ]);
      assert.match(renderHtml(document), /<p class="note">nope<\/p>/u);
      assert.match(renderCsv(document), /^Note,nope$/mu);
      assert.ok(!renderHtml(document).includes('<table>'), 'and no empty table beside it');
    });
  });

  describe('stamps every row with a time that survives being read elsewhere', () => {
    it('writes the wall clock of the span’s zone, with its offset', () => {
      assert.equal(
        formatInstant(new Date('2026-08-31T22:00:00Z'), 'Europe/Berlin'),
        '2026-09-01T00:00:00+02:00',
      );
      assert.equal(formatInstant(new Date('2026-01-01T00:00:00Z'), 'UTC'), '2026-01-01T00:00:00Z');
      assert.equal(
        formatInstant(new Date('2026-09-01T00:00:00Z'), 'Asia/Kathmandu'),
        '2026-09-01T05:45:00+05:45',
      );
    });

    it('tells the two halves of a repeated hour apart', () => {
      // Berlin falls back at 2026-10-25 03:00 local. Both 02:30s exist; a local time alone cannot
      // say which, and a report with two identical timestamps and different numbers is unreadable.
      const first = formatInstant(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin');
      const second = formatInstant(new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin');
      assert.equal(first, '2026-10-25T02:30:00+02:00');
      assert.equal(second, '2026-10-25T02:30:00+01:00');
      assert.notEqual(first, second);
    });
  });

  describe('refuses a document it cannot build rather than truncating one', () => {
    it('answers with the count and what to narrow', () => {
      const huge: ReportSection = {
        subject: { id: 1, kind: 'sensor', name: 'big' },
        columns: [
          { key: 'a', name: 'A', unit: '', decimals: null },
          { key: 'b', name: 'B', unit: '', decimals: null },
        ],
        rows: Array.from({ length: MAX_CELLS }, () => ({ at: new Date(0), values: [1, 2] })),
      };
      assert.ok(countCells([huge]) > MAX_CELLS);
      for (const render of [renderCsv, renderHtml]) {
        assert.throws(
          () => render(doc([huge])),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'REPORT_TOO_LARGE');
            assert.equal((error as { status: number }).status, 422);
            assert.match((error as { message: string }).message, /cover fewer sensors/u);
            assert.equal((error as { details: { cells: number } }).details.cells, MAX_CELLS * 2);
            return true;
          },
        );
      }
    });

    it('renders a document exactly at the limit', () => {
      // A bound that refused the size it names would be a different bound.
      const atLimit: ReportSection = {
        subject: { id: 1, kind: 'sensor', name: 'edge' },
        columns: [{ key: 'a', name: 'A', unit: '', decimals: null }],
        rows: Array.from({ length: MAX_CELLS }, () => ({ at: new Date(0), values: [1] })),
      };
      assert.equal(countCells([atLimit]), MAX_CELLS);
      assert.ok(renderCsv(doc([atLimit])).length > 0);
    });
  });
});

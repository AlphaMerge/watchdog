import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { approximateWidth, renderChartSvg } from '../src/reports/graph-svg.js';
import { chartsFor, showsGraph, showsTable, timeTicksFor } from '../src/reports/graph.js';
import { REPORT_KINDS } from '../src/reports/repository.js';
import { paginate, renderPdf, type Typesetter } from '../src/reports/pdf.js';
import {
  MAX_CELLS,
  renderHtml,
  type ReportDocument,
  type ReportSection,
} from '../src/reports/table.js';
import { readPdf } from './support/pdf.js';
import { assertWellFormed } from './support/xml.js';

/**
 * A report's graphs (`E-05`, `ADR-006` Decision 3).
 *
 * The geometry is proved in `@ms/shared`'s own tests. This file proves the three things the core
 * adds: the time axis is the report's calendar and not UTC's, the templates draw what they say,
 * and the two drawings — SVG in the HTML, primitives in the PDF — say what the layout said.
 */

const HOUR = 3_600_000;

const at = (iso: string): Date => new Date(iso);

function section(
  columns: { key: string; name: string; unit: string }[],
  values: (number | null)[][],
  from: Date,
  spread = true,
): ReportSection {
  const rows = values.map((row, index) => ({
    at: new Date(from.getTime() + index * HOUR),
    values: row,
  }));
  return {
    subject: { id: 42, kind: 'sensor', name: 'edge-router' },
    columns: columns.map((column) => ({ ...column, decimals: 1 })),
    rows,
    ...(spread
      ? {
          spread: columns.map((_, index) => ({
            min: rows.map((row) =>
              row.values[index] === null ? null : (row.values[index] ?? 0) - 1,
            ),
            max: rows.map((row) =>
              row.values[index] === null ? null : (row.values[index] ?? 0) + 1,
            ),
          })),
        }
      : {}),
  };
}

const PING = [
  { key: 'rtt', name: 'Response time', unit: 'ms' },
  { key: 'loss', name: 'Packet loss', unit: '%' },
];

function doc(
  kind: ReportDocument['report']['kind'],
  sections: ReportSection[],
  from = at('2026-08-31T22:00:00Z'),
  hours = 6,
): ReportDocument {
  return {
    report: { id: 7, name: 'Graphs', kind },
    window: {
      from,
      to: new Date(from.getTime() + hours * HOUR),
      label: '2026-09-01 (Europe/Berlin)',
      timezone: 'Europe/Berlin',
    },
    runAs: 'alice',
    generatedAt: at('2026-10-01T03:00:00Z'),
    resolution: { bucketSeconds: 3_600, source: 'sample_1h' },
    adjustments: [],
    unavailable: [],
    sections,
  };
}

const sixHours = (): (number | null)[][] => [
  [10, 0],
  [12, 0],
  [null, null],
  [14, 1],
  [null, null],
  [15, 0],
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

describe('a report’s graphs', () => {
  describe('draw what the template says', () => {
    it('shows a graph for the graph templates and a table for every template but one', () => {
      assert.deepEqual(
        REPORT_KINDS.filter((kind) => showsGraph(kind)),
        ['graph_and_table', 'graph_only'],
      );
      assert.deepEqual(
        REPORT_KINDS.filter((kind) => !showsTable(kind)),
        ['graph_only'],
      );
    });

    it('puts graphs and a table in graph_and_table, and graphs alone in graph_only', () => {
      const both = renderHtml(
        doc('graph_and_table', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))]),
      );
      assert.equal([...both.matchAll(/<svg\b/gu)].length, 2, 'one chart per unit, so two');
      assert.ok(both.includes('<table>'));

      const graphs = renderHtml(
        doc('graph_only', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))]),
      );
      assert.equal([...graphs.matchAll(/<svg\b/gu)].length, 2);
      assert.ok(!graphs.includes('<table>'), 'and no table');

      const table = renderHtml(
        doc('table_only', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))]),
      );
      assert.ok(!table.includes('<svg'), 'and table_only draws no graph');
    });

    it('says a channel recorded nothing, rather than drawing an empty chart for it', () => {
      const html = renderHtml(
        doc('graph_only', [
          section(
            [{ key: 'rtt', name: 'Response time', unit: 'ms' }],
            [[null], [null], [null]],
            at('2026-08-31T22:00:00Z'),
          ),
        ]),
      );
      assert.ok(!html.includes('<svg'), 'no chart to interpret');
      assert.match(html, /No readings were recorded for Response time \(ms\) in this period\./u);
    });

    it('explains a break in a line in the footer, because a printed graph has no tooltip', () => {
      const html = renderHtml(
        doc('graph_and_table', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))]),
      );
      assert.match(
        html,
        /as a break in a line on a graph, and means no reading was recorded, not a reading of zero/u,
      );
    });
  });

  describe('as SVG in the HTML report', () => {
    const svgOf = (html: string, index = 0): string => {
      const match = [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/gu)][index];
      assert.ok(match !== undefined, 'a chart was drawn');
      return match[0];
    };

    it('is well-formed, and fetches nothing', () => {
      const html = renderHtml(
        doc('graph_only', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))]),
      );
      for (const match of html.matchAll(/<svg\b[\s\S]*?<\/svg>/gu)) assertWellFormed(match[0]);
      // The report's own rule, still true with charts in it: no URL anywhere, not even a namespace.
      assert.ok(!/https?:\/\//u.test(html));
    });

    it('breaks the line at a gap with a new subpath, and draws a lone reading as a dot', () => {
      // Two runs long enough to be lines, a gap between them, and a reading alone at the end.
      const values: (number | null)[][] = [[10], [12], [null], [14], [15], [null], [16]];
      const svg = svgOf(
        renderHtml(
          doc(
            'graph_only',
            [
              section(
                [{ key: 'rtt', name: 'Response time', unit: 'ms' }],
                values,
                at('2026-08-31T22:00:00Z'),
              ),
            ],
            at('2026-08-31T22:00:00Z'),
            7,
          ),
        ),
      );
      const line = /<path class="line" data-series="rtt" d="([^"]+)"/u.exec(svg)?.[1] ?? '';
      // **The gap is in the geometry.** Each run starts with its own `M`; a path that joined them
      // would have one `M` and an `L` straight across the missing hour.
      assert.equal([...line.matchAll(/M/gu)].length, 2, line);
      assert.equal(
        [...line.matchAll(/L/gu)].length,
        2,
        'one segment inside each run, none between',
      );
      assert.equal(
        [...svg.matchAll(/<circle class="dot" data-series="rtt"/gu)].length,
        1,
        'and the lone reading',
      );
    });

    it('draws the spread as a band where the document carries one, and none where it does not', () => {
      const withSpread = svgOf(
        renderHtml(doc('graph_only', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))])),
      );
      assert.ok(/<path class="band" d="M[^"]+Z"/u.test(withSpread), 'a closed band polygon');
      const without = svgOf(
        renderHtml(
          doc('graph_only', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'), false)]),
        ),
      );
      assert.ok(!without.includes('class="band"'), 'a document without a spread claims none');
      assert.ok(without.includes('class="line"'), 'and still draws the averages');
    });

    it('names itself for a reader who cannot see it, and says what a break means', () => {
      const svg = svgOf(
        renderHtml(doc('graph_only', [section(PING, sixHours(), at('2026-08-31T22:00:00Z'))])),
      );
      const parsed = parser.parse(svg) as {
        svg: { '@role': string; title: { '#text': string }; desc: { '#text': string } };
      };
      assert.equal(parsed.svg['@role'], 'img');
      assert.equal(parsed.svg.title['#text'], 'edge-router: Response time (ms)');
      assert.match(parsed.svg.desc['#text'], /A break in a line is an interval with no reading/u);
    });

    it('gives every chart in a document its own ids', () => {
      const html = renderHtml(
        doc('graph_only', [
          section(PING, sixHours(), at('2026-08-31T22:00:00Z')),
          {
            ...section(PING, sixHours(), at('2026-08-31T22:00:00Z')),
            subject: { id: 43, kind: 'sensor', name: 'core' },
          },
        ]),
      );
      const ids = [...html.matchAll(/ id="([^"]+)"/gu)].map((match) => match[1]);
      assert.equal(ids.length, 8, 'a title and a description for each of four charts');
      assert.equal(new Set(ids).size, ids.length, 'and none of them twice');
    });

    it('escapes a channel named like markup, in the title and the legend', () => {
      const html = renderHtml(
        doc('graph_only', [
          section(
            [
              { key: 'a', name: '<script>alert(1)</script>', unit: 'ms' },
              { key: 'b', name: 'b & c', unit: 'ms' },
            ],
            [
              [1, 2],
              [2, 3],
            ],
            at('2026-08-31T22:00:00Z'),
          ),
        ]),
      );
      assert.ok(!html.includes('<script>'));
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assertWellFormed(svgOf(html));
    });

    it('draws the same layout the core computed, with nothing decided on the way', () => {
      const [layout] = chartsFor(
        section(PING, sixHours(), at('2026-08-31T22:00:00Z')),
        { from: at('2026-08-31T22:00:00Z'), to: at('2026-09-01T04:00:00Z') },
        timeTicksFor(at('2026-08-31T22:00:00Z'), at('2026-09-01T04:00:00Z'), 'Europe/Berlin'),
        { width: 400, plotHeight: 120, fontSize: 10, measure: approximateWidth },
      );
      assert.ok(layout !== undefined);
      const svg = renderChartSvg(layout, { id: 'x', subject: 's', period: 'p', fontSize: 10 });
      for (const tick of layout.yTicks)
        assert.ok(svg.includes(`>${tick.label}</text>`), tick.label);
      for (const tick of layout.xTicks)
        assert.ok(svg.includes(`x="${String(tick.x)}"`), tick.label);
    });
  });

  describe('stay a size somebody can be sent', () => {
    it('keeps an HTML report with graphs at the cell limit under the size a mail relay carries', () => {
      // **Measured, then bounded.** At the cell limit — 100 sensors, 1,000 hours, two channels —
      // the HTML is 7.3 MiB as a table, 13.9 MiB with graphs and 6.5 MiB as graphs alone: every
      // graph roughly doubles what it draws. The bound is loose on purpose; it is here to catch a
      // change that doubles it again, not to pin a number that moves with the data.
      const columns = [
        { key: 'rtt', name: 'Response time', unit: 'ms' },
        { key: 'loss', name: 'Packet loss', unit: '%' },
      ];
      const hours = 1_000;
      const sections = Array.from({ length: MAX_CELLS / (hours * columns.length) }, (_, index) => ({
        ...section(
          columns,
          Array.from({ length: hours }, (_, hour) => [
            20 + Math.sin(hour / 7) * 10,
            hour % 97 === 5 ? null : 1,
          ]),
          at('2025-09-01T00:00:00Z'),
        ),
        subject: { id: index, kind: 'sensor', name: `sensor ${String(index)}` },
      }));
      const html = renderHtml(doc('graph_and_table', sections, at('2025-09-01T00:00:00Z'), hours));
      const megabytes = Buffer.byteLength(html, 'utf8') / 1_048_576;
      assert.ok(
        megabytes < 20,
        `an HTML report with graphs at the cell limit is ${megabytes.toFixed(1)} MiB`,
      );
      assert.equal(
        [...html.matchAll(/<svg\b/gu)].length,
        sections.length * 2,
        'and every chart was drawn',
      );
    });
  });

  describe('keep the report’s calendar on the time axis', () => {
    it('ticks at local round hours and labels midnight with the date', () => {
      // Berlin is two hours ahead in September: local midnight is 22:00 UTC the evening before.
      const [hourly] = timeTicksFor(
        at('2026-08-31T20:00:00Z'),
        at('2026-09-01T02:00:00Z'),
        'Europe/Berlin',
      );
      assert.deepEqual(
        hourly?.map((tick) => [new Date(tick.at).toISOString(), tick.label]),
        [
          ['2026-08-31T20:00:00.000Z', '22:00'],
          ['2026-08-31T21:00:00.000Z', '23:00'],
          ['2026-08-31T22:00:00.000Z', '09-01'],
          ['2026-08-31T23:00:00.000Z', '01:00'],
          ['2026-09-01T00:00:00.000Z', '02:00'],
          ['2026-09-01T01:00:00.000Z', '03:00'],
          ['2026-09-01T02:00:00.000Z', '04:00'],
        ],
      );
    });

    it('does not tick an hour the clocks skipped', () => {
      // Berlin springs forward at 02:00 on 2026-03-29. `instantOf` resolves the missing 02:00 to
      // 03:00 — and labelling that instant "02:00" would put a time on the axis that never happened.
      const [hourly] = timeTicksFor(
        at('2026-03-28T23:00:00Z'),
        at('2026-03-29T03:00:00Z'),
        'Europe/Berlin',
      );
      const labels = hourly?.map((tick) => tick.label) ?? [];
      assert.ok(!labels.includes('02:00'), labels.join(' '));
      assert.ok(labels.includes('03:00'));
      const instants = hourly?.map((tick) => tick.at) ?? [];
      assert.equal(new Set(instants).size, instants.length, 'and no instant twice');
    });

    it('follows a zone whose offset is not a whole hour', () => {
      // Kathmandu is +05:45, so its round hours are a quarter past the hour in UTC.
      const [hourly] = timeTicksFor(
        at('2026-09-01T00:00:00Z'),
        at('2026-09-01T03:00:00Z'),
        'Asia/Kathmandu',
      );
      for (const tick of hourly ?? [])
        assert.equal(new Date(tick.at).getUTCMinutes(), 15, tick.label);
    });

    it('offers months at the first, weeks on Mondays, and nothing it would have to generate thousands of', () => {
      const sets = timeTicksFor(
        at('2025-12-31T23:00:00Z'),
        at('2026-12-31T23:00:00Z'),
        'Europe/Berlin',
      );
      const labels = sets.map((set) => set[0]?.label ?? '');
      assert.ok(!labels.some((label) => /^\d\d:00$/u.test(label)), 'no hourly set over a year');
      const months = sets.find((set) => set.some((tick) => /^\d{4}-\d{2}$/u.test(tick.label)));
      assert.ok(months !== undefined);
      const [january] = months;
      assert.ok(january !== undefined);
      assert.equal(january.label, '2026-01');
      assert.equal(
        new Date(january.at).toISOString(),
        '2025-12-31T23:00:00.000Z',
        'local, not UTC, New Year',
      );
      const weekly = timeTicksFor(
        at('2026-08-31T22:00:00Z'),
        at('2026-09-30T22:00:00Z'),
        'Europe/Berlin',
      ).find((set) => set.length >= 4 && set.length <= 5);
      for (const tick of weekly ?? []) {
        // 22:00 UTC on a Sunday is Monday's local midnight in Berlin.
        assert.equal(new Date(tick.at + 2 * HOUR).getUTCDay(), 1, tick.label);
      }
    });

    it('still says when a window is, when it is too short to hold a round hour', () => {
      const sets = timeTicksFor(at('2026-09-01T10:05:00Z'), at('2026-09-01T10:25:00Z'), 'UTC');
      assert.deepEqual(sets, [[{ at: at('2026-09-01T10:05:00Z').getTime(), label: '10:05' }]]);
    });
  });

  describe('as primitives in the PDF', () => {
    const type: Typesetter = { measure: (text, size) => text.length * size * 0.5, has: () => true };

    it('keeps a chart whole on one page, and puts no table in graph_only', () => {
      const sections = Array.from({ length: 6 }, (_, index) => ({
        ...section(PING, sixHours(), at('2026-08-31T22:00:00Z')),
        subject: { id: index, kind: 'sensor', name: `sensor ${String(index)}` },
      }));
      const pages = paginate(doc('graph_only', sections), type);
      const charts = pages.flatMap((page) => page.blocks).filter((block) => block.chart !== null);
      assert.equal(charts.length, 12, 'two charts for each of six sensors, none lost');
      assert.ok(pages.length > 1, 'which takes more than one page');
      assert.ok(
        pages
          .flatMap((page) => page.blocks)
          .every((block) => block.rows.length === 0 && block.columns.length === 0),
        'and graph_only draws no table',
      );
      for (const page of pages) {
        let height = 0;
        for (const block of page.blocks) height += block.chart?.height ?? 0;
        assert.ok(height < 842, 'the charts on a page fit on it');
      }
    });

    it('draws its axis labels and legend as text a reader can copy', async () => {
      const traffic = [
        { key: 'in', name: 'Traffic in', unit: 'kbit/s' },
        { key: 'out', name: 'Трафик out', unit: 'kbit/s' },
      ];
      const pdf = await renderPdf(
        doc('graph_only', [
          section(
            traffic,
            [
              [100, 50],
              [300, 80],
              [200, 60],
            ],
            at('2026-08-31T22:00:00Z'),
          ),
        ]),
      );
      const drawn = readPdf(pdf).pages.flat();
      assert.ok(drawn.includes('kbit/s'), 'the chart title');
      assert.ok(
        drawn.includes('Traffic in') && drawn.includes('Трафик out'),
        'the legend, Cyrillic included',
      );
      assert.ok(
        drawn.includes('0') && drawn.some((text) => /^\d{3}$/u.test(text)),
        'the value axis',
      );
      assert.ok(drawn.includes('09-01'), 'and the time axis, in the report’s own zone');
      assert.ok(!drawn.includes('Time'), 'with no table under it');
    });
  });
});

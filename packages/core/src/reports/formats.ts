import { renderPdf } from './pdf.js';
import { renderCsv, renderHtml, renderXml, type ReportDocument } from './table.js';
import type { ReportFormat, ReportOutputs } from './outputs.js';
import type { ReportRow } from './repository.js';
import { buildZip } from './zip.js';

/**
 * One document, four formattings, and one place that knows which is which (`E-06`).
 *
 * **The render route and the stored-output renderer both come here.** The two answering the same
 * question separately is how a download arrives as the right content type around the wrong bytes,
 * and a `Record<ReportFormat, …>` is exhaustive, so a fifth format added to `REPORT_FORMATS` and
 * not added here is a type error rather than a silent fall-through to HTML.
 *
 * **Everything returns bytes, and everything is awaited**, which the three text formats do not
 * need and pay nothing for. `pdfkit` is a stream: a PDF is finished when its `end` event says so,
 * and pretending otherwise here would mean either a synchronous API that cannot hold a PDF or two
 * dispatch tables that must agree. UTF-8 is the encoding for the text three, which is what their
 * own documents declare — `<meta charset>`, the XML declaration, and CSV's convention.
 */
const RENDERERS: Readonly<Record<ReportFormat, (document: ReportDocument) => Promise<Buffer>>> = {
  html: (document) => Promise.resolve(Buffer.from(renderHtml(document), 'utf8')),
  csv: (document) => Promise.resolve(Buffer.from(renderCsv(document), 'utf8')),
  xml: (document) => Promise.resolve(Buffer.from(renderXml(document), 'utf8')),
  pdf: renderPdf,
};

export async function renderDocument(
  format: ReportFormat,
  document: ReportDocument,
): Promise<Buffer> {
  return await RENDERERS[format](document);
}

/**
 * What `report_output_format` admits: every rendering, plus the archive that can hold them.
 *
 * Derived from `REPORT_FORMATS` rather than restated, so a format added there and not added to
 * the enum is a type error in the repository rather than a `22P02` at three in the morning. `zip`
 * is the one member that is a container rather than a rendering, which is why it is not in
 * `REPORT_FORMATS` — nobody asks for a report *in* zip, they ask for one zipped.
 */
export type StoredFormat = ReportFormat | 'zip';

/**
 * A filename a folder of these can be read and sorted by.
 *
 * The report's name and the period it covered, because those are the two facts somebody looking at
 * a directory listing needs and neither is recoverable from the other. Reduced to characters every
 * filesystem and every mail client agrees on: an operator's report title can hold anything, and a
 * colon alone makes a file unopenable on Windows.
 */
export function filenameFor(
  report: Pick<ReportRow, 'name'>,
  spanLabel: string,
  extension: string,
): string {
  const slug = (raw: string): string =>
    raw
      .replaceAll(/[^\w.-]+/gu, '-')
      .replaceAll(/-{2,}/gu, '-')
      .replace(/^-+|-+$/gu, '');
  const name = slug(report.name) || 'report';
  const period = slug(spanLabel);
  return `${[name, period].filter((part) => part !== '').join('_')}.${extension}`.slice(0, 200);
}

export interface RenderedOutput {
  readonly format: StoredFormat;
  readonly filename: string;
  readonly body: Buffer;
}

/**
 * Every file this report's outputs document asks for.
 *
 * **The ZIP replaces the parts rather than joining them.** An email carrying both an archive and
 * the files it contains is twice the size and asks the recipient which one to open; `§6` calls
 * this "optional ZIP", singular. The parts are what goes into it.
 */
export async function renderOutputs(
  report: Pick<ReportRow, 'name'>,
  document: ReportDocument,
  outputs: ReportOutputs,
  at: Date,
): Promise<RenderedOutput[]> {
  const parts: RenderedOutput[] = [];
  for (const format of outputs.formats) {
    parts.push({
      format,
      filename: filenameFor(report, document.window.label, format),
      // `renderDocument` rather than a branch here: the render route answers from the same table,
      // and the two disagreeing is how a download arrives as the right content type around the
      // wrong bytes. **One at a time**, deliberately: rendering three formats of a large report in
      // parallel would put three copies of it in memory at once to save nothing — the work is CPU
      // on one thread either way.
      body: await renderDocument(format, document),
    });
  }

  if (!outputs.zip) return parts;
  return [
    {
      format: 'zip',
      filename: filenameFor(report, document.window.label, 'zip'),
      body: buildZip(
        parts.map((part) => ({ name: part.filename, content: part.body })),
        at,
      ),
    },
  ];
}

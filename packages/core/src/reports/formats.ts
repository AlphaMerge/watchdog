import { renderPdf } from './pdf.js';
import { renderCsv, renderHtml, renderXml, type ReportDocument } from './table.js';
import type { ReportFormat } from './outputs.js';

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

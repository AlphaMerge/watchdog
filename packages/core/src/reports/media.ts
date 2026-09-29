/**
 * What the report routes need to know about an output, without the code that renders one (`H-19`).
 *
 * The routes load in every build, a v1 core included, which constructs no reports. Importing these
 * facts from `pdf.ts` loaded `pdfkit` and `fontkit` into that core at start-up. So they live here,
 * where importing them loads nothing, and `module-graph.test.ts` fails if a v1 core loads either.
 */

/**
 * How many pages one report may be.
 *
 * **Measured rather than guessed.** Over two channels of ordinary values: 1,000 rows is 19 pages,
 * 0.05 MiB and 0.26 s; 10,000 rows is 185 pages, 0.43 MiB and 1.5 s. So this bound is roughly
 * three seconds of work and under a megabyte — and `MAX_CELLS` alone would not have bounded it,
 * because cells become pages at a rate that depends on how many channels a sensor has: a document
 * inside the cell limit is 1,852 pages of A4 at two channels. That is not a report anybody reads;
 * it is a document nobody can open and a mail relay will not carry, produced by a render that held
 * the event loop for a minute. Refused with the number and what to narrow, like every other bound
 * here — `report-pdf.test.ts` exercises the refusal on a small page, which is the same arithmetic
 * at a fraction of the work.
 */
export const MAX_PDF_PAGES = 400;

const MEDIA: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  // `application/xml` rather than `text/xml`: RFC 7303 deprecated the latter's charset handling,
  // and a report is UTF-8 with the encoding declared in the document itself.
  xml: 'application/xml; charset=utf-8',
  zip: 'application/zip',
};

export function mediaTypeOf(format: string): string {
  return MEDIA[format] ?? 'application/octet-stream';
}

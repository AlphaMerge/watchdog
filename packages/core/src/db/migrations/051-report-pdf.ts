import type { Migration } from './types.js';

/**
 * `pdf` joins the stored report formats (`E-06`, `ADR-005` Decision 3, `ADR-006`).
 *
 * **This is the reopening `ADR-005` Decision 3 promised, and it is being done the way that
 * decision asked.** It admitted `html`, `csv` and the `zip` that wraps them, refused `pdf` because
 * nothing produced one, and said the expectation was that a PDF would join the enum under the same
 * reasoning — *"that is an expectation, not this decision: it gets checked against a real rendered
 * PDF before the enum changes."* `E-06` renders one, so the check was made rather than assumed:
 *
 * - **It is text and vector graphics, and it compresses.** A rendered report of 1,000 rows is
 *   0.05 MiB and the largest this system will produce is under a megabyte, because `MAX_PDF_PAGES`
 *   refuses beyond 400 pages. That is the same order as the HTML of the same document, and TOAST
 *   compresses it for the same reason.
 * - **No raster.** `ADR-005` worried about "a PDF with an embedded raster graph", which is the
 *   case that would not compress. `ADR-006` Decision 3 settled that a report's graph is drawn as
 *   `pdfkit` primitives rather than rasterised, so that case does not arise here — and if `E-05`
 *   ever changes its mind, this is the decision that gets looked at again.
 *
 * **`BEFORE 'zip'`**, like migration 050: the renderings stay together in declaration order and
 * the container that wraps them stays last, which is the order `listFor` returns them in.
 *
 * **The rollback deletes stored PDFs**, because PostgreSQL has no `DROP VALUE` and a column cannot
 * be cast to a type without the label its rows hold. The runs survive with their history intact —
 * the same trade migration 050 made, stated rather than hidden.
 */
export const migration051: Migration = {
  id: 51,
  name: 'report-pdf',

  up: `
    ALTER TYPE report_output_format ADD VALUE IF NOT EXISTS 'pdf' BEFORE 'zip';
  `,

  down: `
    -- Data loss, deliberately: see the comment above. Only the documents go; the runs stay.
    DELETE FROM report_output WHERE format = 'pdf';

    ALTER TYPE report_output_format RENAME TO report_output_format_old;
    CREATE TYPE report_output_format AS ENUM ('html', 'csv', 'xml', 'zip');
    ALTER TABLE report_output
      ALTER COLUMN format TYPE report_output_format USING format::text::report_output_format;
    DROP TYPE report_output_format_old;
  `,
};

import type { Migration } from './types.js';

/**
 * `xml` joins the stored report formats (`E-07`, `ADR-005` Decision 3).
 *
 * **A migration for one enum value, because the format is a column value.** `ADR-005` Decision 3
 * named the formats a stored report may hold — `html`, `csv` and the `zip` that wraps them — and
 * said the list is reopened when something produces another one. `E-07` produces another one:
 * `renderXml` is a third formatting of the document model `E-04` already built, and it lands under
 * exactly the reasoning that admitted the first two. It is text, so TOAST compresses it as well as
 * it compresses the HTML; it is bounded by the same `MAX_CELLS`; it has nowhere better to live.
 *
 * **`ALTER TYPE … ADD VALUE` is transactional on PostgreSQL 12 and later**, as long as the new
 * value is not *used* in the same transaction — migration 024 established this and it is not used
 * here either.
 *
 * **`BEFORE 'zip'`, because an enum sorts by declaration order and `listFor` orders by format.**
 * A run stores either the renderings or the archive that replaced them, never both, so this
 * changes no listing that exists today — it keeps the renderings together and the container last,
 * which is the order every other list of these formats is written in and the order a run that
 * someday held both would want.
 *
 * **The rollback recreates the type, and it deletes XML outputs on the way.** Postgres has no
 * `DROP VALUE`; taking a value out means building the enum again without it and casting the column
 * across, which cannot carry rows still holding the removed value. That is genuine data loss and
 * it is stated rather than hidden — a stored XML report cannot survive the removal of the value
 * that names its format, and a rollback that left the rows would collide on re-application. The
 * run that produced them survives, with its history intact and its output gone, which is the same
 * thing `E-10`'s expiry does to a run whose documents have aged out.
 */
export const migration050: Migration = {
  id: 50,
  name: 'report-xml',

  up: `
    ALTER TYPE report_output_format ADD VALUE IF NOT EXISTS 'xml' BEFORE 'zip';
  `,

  down: `
    -- Data loss, deliberately: see the comment above. The run rows stay; only the documents go.
    DELETE FROM report_output WHERE format = 'xml';

    ALTER TYPE report_output_format RENAME TO report_output_format_old;
    CREATE TYPE report_output_format AS ENUM ('html', 'csv', 'zip');
    ALTER TABLE report_output
      ALTER COLUMN format TYPE report_output_format USING format::text::report_output_format;
    DROP TYPE report_output_format_old;
  `,
};

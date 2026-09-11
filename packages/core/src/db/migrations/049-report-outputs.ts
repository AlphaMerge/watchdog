import type { Migration } from './types.js';

/**
 * Where a rendered report lives, and whether it has been delivered (`E-09`, `ADR-005`).
 *
 * `E-08` deliberately discarded the document because nothing had decided where it goes. `ADR-005`
 * decides: PostgreSQL, as bytea, for the reason ADR-003 gave about uploaded files and which is
 * stronger here — a report is the one artefact whose whole value is being readable months later,
 * so a restore that lists reports whose files are all missing is the worst version of that failure.
 *
 * **Compression is the database's.** A bytea column is EXTENDED storage, so anything over a couple
 * of kilobytes is compressed out of line before it is stored. Compressing in Node first would make
 * PostgreSQL try and fail to compress it again, hide the real size from pg_total_relation_size, and
 * put an inflate on the path of every download. An HTML data table is the most compressible thing
 * imaginable and the database is better placed to do it.
 *
 * ## Why delivery state is on the run and not on the output
 *
 * A run produces one or several outputs and is delivered once — one email with three attachments,
 * not three emails. Putting the state on the output would make "delivered" a thing that could be
 * half true, and the retry would have to decide what a partial send means. The run is the unit an
 * operator asks about and the unit that is retried.
 *
 * ## The failure rule this table exists to keep
 *
 * A scheduled report that cannot deliver must not retry into an alarm storm, and must not fail
 * silently. So: bounded attempts with a growing delay, one row holding one state, and a terminal
 * 'failed' that stays failed until somebody looks. A mail relay that is down for an hour produces
 * one visible failed report, not sixty log lines and no record.
 */
export const migration049: Migration = {
  id: 49,
  name: 'report-outputs',

  up: `
    -- 'zip' is a container around the others rather than a fourth rendering. No 'pdf': ADR-005
    -- Decision 3 excludes it until something produces one, and admits it will be reopened then.
    CREATE TYPE report_output_format AS ENUM ('html', 'csv', 'zip');

    CREATE TABLE report_output (
      id         bigserial PRIMARY KEY,
      run_id     bigint NOT NULL REFERENCES report_run(id) ON DELETE CASCADE,

      format     report_output_format NOT NULL,
      -- What a download is called. Derived from the report's name and the period it covered, so
      -- a folder of these sorts and reads without opening them.
      filename   text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),

      -- The uncompressed length, recorded rather than computed: octet_length() on a TOASTed value
      -- has to fetch and decompress it, which is a page read per row for a listing that only wants
      -- to say how big things are.
      byte_size  integer NOT NULL CHECK (byte_size >= 0),
      -- The bytes' own SHA-256, which the download route answers as a strong ETag exactly as
      -- ADR-003 Decision 4 does for a map background.
      sha256     text NOT NULL CHECK (length(sha256) = 64),

      body       bytea NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),

      -- One rendering per format per run. A second would be a bug, not a version.
      UNIQUE (run_id, format)
    );

    CREATE INDEX report_output_run_idx ON report_output (run_id);

    COMMENT ON COLUMN report_output.body IS
      'The rendered document (ADR-005 Decision 1). Compressed by TOAST, not by the application.';

    -- none:    this run was never going to be delivered anywhere
    -- pending: it has bytes and an address, and has not gone yet
    -- sent:    it went
    -- failed:  it will not be retried again without somebody acting
    CREATE TYPE report_delivery_state AS ENUM ('none', 'pending', 'sent', 'failed');

    ALTER TABLE report_run
      ADD COLUMN delivery_state report_delivery_state NOT NULL DEFAULT 'none',
      ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN delivery_error text NOT NULL DEFAULT '' CHECK (length(delivery_error) <= 1000),
      -- When the next attempt is allowed. Null once the state is terminal, which is also what
      -- keeps a finished run out of the sweep's query.
      ADD COLUMN delivery_next_at timestamptz,
      ADD COLUMN delivered_at timestamptz;

    -- The delivery sweep's query: a partial index over the only state it can act on, so an
    -- installation that emails nothing pays nothing for the sweep.
    CREATE INDEX report_delivery_due_idx ON report_run (delivery_next_at)
      WHERE delivery_state = 'pending';
  `,

  down: `
    DROP INDEX IF EXISTS report_delivery_due_idx;
    ALTER TABLE report_run
      DROP COLUMN IF EXISTS delivered_at,
      DROP COLUMN IF EXISTS delivery_next_at,
      DROP COLUMN IF EXISTS delivery_error,
      DROP COLUMN IF EXISTS delivery_attempts,
      DROP COLUMN IF EXISTS delivery_state;
    DROP TYPE IF EXISTS report_delivery_state;
    DROP TABLE IF EXISTS report_output;
    DROP TYPE IF EXISTS report_output_format;
  `,
};

import type { Migration } from './types.js';

/**
 * Reports, and whose eyes they are rendered through (`E-01`, `CAPABILITIES.MD §6`).
 *
 * **A report is not a tree object, for the reason `044` gives about maps** — `§9` grants access to
 * "tree, libraries, maps and reports" per group, which makes each of those a first-class thing
 * with its own storage rather than a `kind` on `object`. The access table below is deliberately
 * the same flat shape as `map_access`, sharing the `access_right` enum from `033` rather than
 * declaring a second one that would eventually disagree about what `write` means.
 *
 * **`subjects` is a document, and that is the same forced choice `map.layout` made.** A report
 * names the sensors it covers, and one of them can be deleted between the day it was scheduled
 * and the day it runs. Child rows with a foreign key would have to pick `ON DELETE CASCADE` — the
 * sensor silently leaves the report, so a monthly summary quietly stops mentioning the thing that
 * broke — or `RESTRICT`, which makes deleting a sensor fail because somebody once put it in a
 * report. A document keeps the reference, loses the object, and lets the renderer say so.
 *
 * **It matters more here than it did for a map.** A dashboard is read by somebody watching now,
 * who can see for themselves that a tile is missing. A report is read later, by somebody who was
 * not there, and it is the most durable thing this system emits — so "the sensor this row was
 * about no longer exists" has to survive into the output rather than being an empty row.
 *
 * ## The security context, which is the one genuinely new column
 *
 * `§6` says a report runs under a named user's visibility scope. That is a deliberate "act as"
 * path, and the failure to design against is a report that widens its own scope: if the account
 * it names is deleted and the column simply goes null, the obvious next behaviour is "run as
 * nobody", and "nobody" in a system whose scheduler has no session is one careless join away from
 * "everybody".
 *
 * So the reference is `ON DELETE SET NULL` **and** the login is snapshotted beside it:
 *
 * - The id is what `E-03` resolves visibility through while the account exists.
 * - `run_as_login` outlives the account, which is the same rule `map_access.granted_by` follows —
 *   the record of who should survive the row it points at.
 * - A null id with a login present is therefore a *readable* broken state: `E-03` refuses to run
 *   the report and can say whose scope it can no longer obtain. It is not a report that runs with
 *   more access than it had yesterday.
 *
 * Nothing enforces that refusal at this layer on purpose. A `CHECK` cannot express "and the
 * scheduler must decline", and putting half the rule in the schema would make the other half look
 * optional.
 *
 * ## What is deliberately a stub
 *
 * `span`, `outputs` and `schedule` exist now with defaults so that `E-02`, `E-08` and `E-09` are
 * shape changes inside a document rather than migrations that have to move live data — exactly
 * what `044` did for `map.layout` before `G-02` defined a widget. `kind` is a column rather than a
 * document field because it is the one thing a listing filters on.
 */
export const migration047: Migration = {
  id: 47,
  name: 'reports',

  up: `
    -- The seven templates §6 lists. An enum rather than free text: a report kind decides which
    -- renderer runs, and a typo should fail at the write rather than at 3am on a schedule.
    CREATE TYPE report_kind AS ENUM (
      'graph_and_table',
      'table_only',
      'graph_only',
      'sensor_list',
      'installation',
      'top_values',
      'top_uptime'
    );

    CREATE TABLE report (
      id           bigserial PRIMARY KEY,
      name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),

      kind         report_kind NOT NULL,

      -- What the report is about. See the note above: a document, not child rows.
      subjects     jsonb NOT NULL DEFAULT '{"objectIds": []}'::jsonb,

      -- The reporting period and its averaging (E-02). §6's rules — a span over 500 days is
      -- shortened to 365, and 40 to 500 days forces at least 60-minute averaging — are that
      -- ticket's, not this one's: they decide which rollup tier answers, which is arithmetic and
      -- belongs beside tiers.ts rather than in a CHECK constraint nobody can read.
      span         jsonb NOT NULL DEFAULT '{"kind": "month"}'::jsonb,

      -- Formats, delivery mode and recipients (E-09).
      outputs      jsonb NOT NULL DEFAULT '{"formats": ["html"], "delivery": "store"}'::jsonb,

      -- When it runs (E-08). A document because "monthly on the 1st at 02:00, in Europe/Berlin"
      -- is a shape that is still being decided, and the alternative is four columns that E-08
      -- would have to migrate.
      schedule     jsonb NOT NULL DEFAULT '{"kind": "manual"}'::jsonb,

      -- **The security context.** Set null if the account goes; the login stays so the refusal
      -- can name whose scope was lost. Read the block comment above before changing either half.
      run_as_user_id bigint REFERENCES user_account(id) ON DELETE SET NULL,
      run_as_login   text NOT NULL DEFAULT '' CHECK (length(run_as_login) <= 64),

      -- Optimistic concurrency, as map and object already answer If-Match with. A report is
      -- edited by hand and read by a scheduler, so last-write-wins is the wrong default here too.
      version      bigint NOT NULL DEFAULT 1,

      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Case-insensitive, like map and user_group: two reports called "Monthly Uptime" and
    -- "monthly uptime" are a support call, not a feature.
    CREATE UNIQUE INDEX report_name_idx ON report (lower(name));

    -- The listing filters by kind and shows recently-changed first.
    CREATE INDEX report_kind_idx ON report (kind, updated_at DESC);

    COMMENT ON COLUMN report.subjects IS
      'What the report covers (E-01). Deliberately not foreign-keyed to object: a deleted sensor '
      'must leave a row that says so rather than vanishing from a document somebody reads months '
      'later, or blocking the delete.';

    COMMENT ON COLUMN report.run_as_user_id IS
      'The visibility scope this report renders through (§6). Null with run_as_login set means '
      'the account is gone and the report must refuse to run (E-03) — never run unscoped.';

    CREATE TABLE report_access (
      report_id  bigint NOT NULL REFERENCES report(id) ON DELETE CASCADE,
      group_id   bigint NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
      right_     access_right NOT NULL,

      granted_at timestamptz NOT NULL DEFAULT now(),
      -- No foreign key to user_account, for the reason object_access and map_access both give.
      granted_by text NOT NULL DEFAULT '' CHECK (length(granted_by) <= 64),

      PRIMARY KEY (report_id, group_id)
    );

    -- What may this group see? The administrator's question, and the listing's.
    CREATE INDEX report_access_group_idx ON report_access (group_id);

    -- set_updated_at comes from migration 001, where the object tree declared it.
    CREATE TRIGGER report_set_updated_at
      BEFORE UPDATE ON report
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `,

  down: `
    DROP TRIGGER IF EXISTS report_set_updated_at ON report;
    -- report_access first: it points at report, and dropping the parent with a dependent table
    -- present would need a CASCADE that could take something else with it.
    DROP TABLE IF EXISTS report_access;
    DROP TABLE IF EXISTS report;
    -- The enum last, and only after the column using it is gone.
    DROP TYPE IF EXISTS report_kind;
  `,
};

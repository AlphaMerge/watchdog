import type { Migration } from './types.js';

/**
 * Scheduled rediscovery (D-07).
 *
 * **Off by default is a property of the schema, not of a setting somebody has to find.** There is
 * no row until an operator creates one, and a row is created disabled. WORKFLOW.MD §2 is explicit
 * about why: surprise objects are a support burden, and a monitoring system that started
 * inventing devices on its own would be one an operator stops trusting.
 *
 * **A schedule holds a run's parameters, not a run.** It is a stencil — the same range, level,
 * community and template filter, applied again — and each firing creates an ordinary
 * discovery_run that behaves exactly like one somebody started by hand. Nothing downstream has
 * to know a run was scheduled, which is what keeps D-01 through D-06 free of a second code path.
 *
 * `auto_provision` is PRTG's "automatically create new devices", and D-04's idempotency is what
 * makes it safe: provisioning a rediscovery creates only what is not already there, so the flag
 * genuinely means "the ones that have appeared since" rather than "everything, again".
 *
 * `schedule_id` is M-09's weekly calendar used as a *permission window* — "weekly, but not
 * during the change freeze". It answers a different question from the cadence (is it allowed
 * now, versus when is it next due), which is why both exist rather than one pretending to be
 * the other.
 */
export const migration029: Migration = {
  id: 29,
  name: 'rediscovery',

  up: `
    CREATE TABLE discovery_schedule (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      group_id        bigint NOT NULL REFERENCES object(id) ON DELETE CASCADE,
      probe_id        bigint NOT NULL REFERENCES object(id) ON DELETE CASCADE,
      name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      -- Created disabled. An operator turns it on once they have read what it will do.
      enabled         boolean NOT NULL DEFAULT false,

      range_text      text NOT NULL CHECK (length(range_text) BETWEEN 1 AND 4000),
      level           text NOT NULL DEFAULT 'standard'
                        CHECK (level IN ('ping', 'standard', 'detailed')),
      templates       text[] NOT NULL DEFAULT '{}',
      snmp_community  text NOT NULL DEFAULT '',
      timeout_ms      integer NOT NULL DEFAULT 1000 CHECK (timeout_ms BETWEEN 100 AND 60000),
      concurrency     integer NOT NULL DEFAULT 32 CHECK (concurrency BETWEEN 1 AND 512),
      rate_per_second numeric(10, 2) NOT NULL DEFAULT 0 CHECK (rate_per_second >= 0),

      cadence         text NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekly')),
      -- Minutes past the hour for hourly, past midnight otherwise. One column, because they are
      -- the same statement at three scales.
      cadence_minute  integer NOT NULL DEFAULT 0 CHECK (cadence_minute BETWEEN 0 AND 1439),
      -- 0 = Monday. Read only for a weekly cadence.
      cadence_weekday integer NOT NULL DEFAULT 0 CHECK (cadence_weekday BETWEEN 0 AND 6),
      timezone        text,

      -- Off by default, and the more consequential of the two flags: with it off a rediscovery
      -- sweeps and identifies, and an operator reviews the plan before anything is created.
      auto_provision  boolean NOT NULL DEFAULT false,

      -- M-09's calendar as a permission window. RESTRICT rather than SET NULL: a schedule
      -- quietly detaching would turn a constrained rediscovery into an unconstrained one, which
      -- is the loudest possible failure for a feature whose whole point is restraint.
      schedule_id     bigint REFERENCES schedule(id) ON DELETE RESTRICT,

      last_run_at     timestamptz,
      -- The last run this schedule started, so a summary can say what happened without a scan.
      last_run_id     bigint REFERENCES discovery_run(id) ON DELETE SET NULL,
      next_run_at     timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );

    -- The sweep's question, asked every minute: what is due. Partial, because most schedules are
    -- disabled and none of them is ever the answer.
    CREATE INDEX discovery_schedule_due_idx
      ON discovery_schedule (next_run_at)
      WHERE enabled;

    CREATE INDEX discovery_schedule_group_idx ON discovery_schedule (group_id);

    -- Which schedule started a run, so a summary can say "rediscovery" rather than leaving an
    -- operator to work out where a run they did not start came from.
    ALTER TABLE discovery_run ADD COLUMN schedule_id bigint
      REFERENCES discovery_schedule(id) ON DELETE SET NULL;
  `,

  down: `
    ALTER TABLE discovery_run DROP COLUMN schedule_id;
    DROP TABLE IF EXISTS discovery_schedule;
  `,
};

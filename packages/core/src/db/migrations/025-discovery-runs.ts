import type { Migration } from './types.js';

/**
 * Discovery runs and what they found (`D-01`).
 *
 * **The cursor is a column, and that is the whole of resumability.** A sweep's position is one
 * integer — how many addresses have been offered — and it lives here rather than on the probe
 * because the probe is the thing that restarts. A core failover, a probe crash and a reconnect
 * all resume the same way: read the cursor, send it back. Re-sweeping a few addresses after a
 * crash costs nothing, since a host found twice is the same host, so the cursor is advanced only
 * on progress the core has actually written.
 *
 * **Found hosts are rows rather than a JSON blob**, because `D-02` reads them one at a time to
 * identify each host and `D-04` marks which ones became devices. A blob would have to be
 * rewritten on every update, and two identification workers rewriting it would lose each other's
 * results.
 *
 * **The unique index on `(run_id, address)` is what makes a re-sweep free.** A resume that
 * replays a few addresses inserts nothing new, and that is what lets the cursor be a floor rather
 * than a promise — the alternative is a protocol where the probe must never repeat itself, which
 * no protocol survives a crash.
 *
 * `status` has no `paused`: a run that is not `running` is either finished or waiting for a
 * probe to pick it up again, and both are `queued` from the operator's point of view. A third
 * state would be a distinction nobody can act on.
 */
export const migration025: Migration = {
  id: 25,
  name: 'discovery-runs',

  up: `
    CREATE TABLE discovery_run (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      -- The group the run scans into. A group, never a device: a sweep creates devices, and a
      -- device has nowhere to put them (WORKFLOW.MD §2).
      group_id       bigint NOT NULL REFERENCES object(id) ON DELETE CASCADE,
      -- Which probe does the pinging. Discovery is a local-network job, so this is the probe
      -- that can reach the range rather than whichever one is idle.
      probe_id       bigint NOT NULL REFERENCES object(id) ON DELETE CASCADE,
      -- As the operator typed it. Parsed by the same code at both ends (@ms/shared).
      range_text     text NOT NULL CHECK (length(range_text) BETWEEN 1 AND 4000),
      -- Addresses in the range, computed at creation. Stored so progress means something even
      -- if a future release changes how a range is counted.
      total          integer NOT NULL CHECK (total >= 0),
      cursor         integer NOT NULL DEFAULT 0 CHECK (cursor >= 0),
      found          integer NOT NULL DEFAULT 0 CHECK (found >= 0),
      failed         integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
      status         text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'done', 'cancelled', 'failed')),
      -- Empty unless the run failed. What to tell the operator, not a stack trace.
      message        text NOT NULL DEFAULT '',
      timeout_ms     integer NOT NULL DEFAULT 1000 CHECK (timeout_ms BETWEEN 100 AND 60000),
      concurrency    integer NOT NULL DEFAULT 32 CHECK (concurrency BETWEEN 1 AND 512),
      rate_per_second numeric(10, 2) NOT NULL DEFAULT 0 CHECK (rate_per_second >= 0),
      -- Who started it. No foreign key yet: accounts arrive with A-01, and a column that
      -- referenced a table which does not exist would make this migration unapplyable. The
      -- reference is added there, where there is something to reference.
      created_by     bigint,
      created_at     timestamptz NOT NULL DEFAULT now(),
      started_at     timestamptz,
      finished_at    timestamptz
    );

    -- The dispatcher's question is "what should be running", asked every few seconds.
    CREATE INDEX discovery_run_pending_idx
      ON discovery_run (probe_id, id)
      WHERE status IN ('queued', 'running');

    -- The operator's question is "what has this group been doing", newest first.
    CREATE INDEX discovery_run_group_idx ON discovery_run (group_id, id DESC);

    CREATE TABLE discovery_host (
      run_id      bigint NOT NULL REFERENCES discovery_run(id) ON DELETE CASCADE,
      -- inet rather than text: it sorts as an address rather than as a string, so 10.0.0.9
      -- comes before 10.0.0.10, and it refuses to hold something that is not an address.
      address     inet NOT NULL,
      rtt_ms      numeric(10, 3),
      found_at    timestamptz NOT NULL DEFAULT now(),
      -- Filled in by D-02. Null means "not identified yet", which is what every row is today.
      fingerprint jsonb,
      -- Filled in by D-04 with the device it became, so a re-run can tell what it already made.
      device_id   bigint REFERENCES object(id) ON DELETE SET NULL,
      PRIMARY KEY (run_id, address)
    );

    CREATE INDEX discovery_host_device_idx
      ON discovery_host (device_id)
      WHERE device_id IS NOT NULL;
  `,

  down: `
    DROP TABLE IF EXISTS discovery_host;
    DROP TABLE IF EXISTS discovery_run;
  `,
};

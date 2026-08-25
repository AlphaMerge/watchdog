import type { Migration } from './types.js';

/**
 * Where a sensor's *current* state lives (`M-02`).
 *
 * `sensor_state` is history: an append-only hypertable of transitions, which is what uptime and
 * SLA are computed from (CLAUDE.md: "uptime comes from state history, not samples"). Answering
 * "what is this sensor right now" from it means a backwards index scan per sensor, and the
 * alarms view asks that question for every sensor at once. Worse, the state machine needs more
 * than the last state to decide the next one — the consecutive-failure count, the four pause
 * flags, whether an acknowledgement is live — and none of that is a transition.
 *
 * So: one row per sensor, holding the machine's working set. `docs/state-machine.md` §6 is
 * explicit that pause state is configuration rather than history and must survive a core
 * restart, and names the column as this task's to add.
 *
 * **No `object_touch_owner` trigger, deliberately.** Every other side table has one, so that
 * writing it invalidates the owning object's ETag. This one must not: a scan every 60 seconds
 * would bump `object.version` for every sensor in the system, invalidating every cached read
 * and — because `R-04` diffs a probe's subtree on exactly those versions — pushing a fresh
 * configuration to every probe once per interval. State is deliberately absent from the
 * ETag-carrying detail read for the same reason; it is served on listings, which are never
 * conditionally cached.
 */
export const migration008: Migration = {
  id: 8,
  name: 'sensor-runtime',

  up: `
    CREATE TABLE sensor_runtime (
      object_id            bigint PRIMARY KEY REFERENCES object (id) ON DELETE CASCADE,

      -- The current state and why, mirroring the last row written to sensor_state. Duplicated
      -- on purpose: this one is read constantly and the hypertable is not indexed for it.
      state                sensor_state_kind  NOT NULL DEFAULT 'unknown',
      cause                sensor_state_cause NOT NULL DEFAULT 'scan',
      -- The last message from the probe. "ETIMEDOUT" alone is not a diagnosis (CLAUDE.md), so
      -- whatever context the check carried is kept where an operator can read it.
      message              text               NOT NULL DEFAULT '',
      -- When the sensor entered this state. "Down for 2h 15m" without scanning history.
      since                timestamptz        NOT NULL DEFAULT now(),

      -- The two-step rule (docs/state-machine.md §2.1). Persisted rather than held in memory so
      -- a restart between the first and second failure does not restart the count — a deploy
      -- would otherwise silently hold a genuinely down sensor at Warning for another interval.
      consecutive_failures integer            NOT NULL DEFAULT 0
                             CHECK (consecutive_failures >= 0),

      -- NULL is §2 row 4: "no reading since creation or resume", which is Unknown. Also the
      -- guard against a replayed or duplicated result being applied twice: only a result newer
      -- than this one moves the machine.
      last_result_at       timestamptz,

      -- The four pause sources (§3) as independent flags, never one column.
      --
      -- This is the distinction PLAN.md names as Phase 3's principal risk. A sensor is paused
      -- while ANY source is set; precedence decides only which cause is reported. Collapsed
      -- into a single "paused_by" enum, resuming the reported source would resume a sensor that
      -- another source still holds — the bug the shape of this table makes unreachable.
      paused_by_parent     boolean NOT NULL DEFAULT false,
      paused_by_dependency boolean NOT NULL DEFAULT false,
      paused_by_schedule   boolean NOT NULL DEFAULT false,
      paused_manually      boolean NOT NULL DEFAULT false,

      -- Acknowledgement (§2.4). NULL in the first column means not acknowledged; NULL in the
      -- second means indefinite. Two facts, not one fact stored twice: a sentinel far-future
      -- timestamp would make "indefinite" and "until the year 9999" indistinguishable.
      -- M-13 adds the API, the presets and who did it.
      acknowledged_at      timestamptz,
      acknowledged_until   timestamptz,

      -- A forced Down, for testing a notification chain end to end. M-14 adds the API.
      simulated_error      boolean NOT NULL DEFAULT false
    );

    -- What the alarms view (U-06) reads: everything that is not Up, which in a healthy system
    -- is a handful of rows out of thousands. Partial, so the index stays that small.
    CREATE INDEX sensor_runtime_not_up_idx ON sensor_runtime (state) WHERE state <> 'up';

    -- Same guard sensor_config carries, and scoped the same way: INSERT and re-keying only,
    -- never the UPDATE that ingestion runs on every batch.
    CREATE FUNCTION sensor_runtime_check_kind() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF (SELECT kind FROM object WHERE id = NEW.object_id) <> 'sensor' THEN
          RAISE EXCEPTION 'sensor_runtime may only describe an object of kind sensor'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER sensor_runtime_kind_check
      BEFORE INSERT OR UPDATE OF object_id ON sensor_runtime
      FOR EACH ROW EXECUTE FUNCTION sensor_runtime_check_kind();

    -- Every sensor has exactly one runtime row, from the moment it exists.
    --
    -- A trigger rather than an insert next to the one in ObjectRepository.create: cloning a
    -- subtree, a discovery run and whatever provisions sensors in a later phase all write
    -- sensor_config, and the failure mode of one path forgetting is an UPDATE from M-08's pause
    -- code that silently matches nothing. Not suppressed under ms.bulk_load, unlike the ETag
    -- trigger: this row is data the system needs, not a cache invalidation it can skip.
    CREATE FUNCTION sensor_runtime_provision() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO sensor_runtime (object_id) VALUES (NEW.object_id)
        ON CONFLICT (object_id) DO NOTHING;
        RETURN NULL;
      END;
      $$;

    CREATE TRIGGER sensor_config_provision_runtime
      AFTER INSERT ON sensor_config
      FOR EACH ROW EXECUTE FUNCTION sensor_runtime_provision();

    -- Every sensor that already exists starts Unknown with no reading, which is exactly what it
    -- was before this table existed. Nothing is invented for them.
    INSERT INTO sensor_runtime (object_id)
    SELECT id FROM object WHERE kind = 'sensor';
  `,

  down: `
    DROP TRIGGER IF EXISTS sensor_config_provision_runtime ON sensor_config;
    DROP FUNCTION IF EXISTS sensor_runtime_provision();
    DROP TRIGGER IF EXISTS sensor_runtime_kind_check ON sensor_runtime;
    DROP FUNCTION IF EXISTS sensor_runtime_check_kind();
    DROP INDEX IF EXISTS sensor_runtime_not_up_idx;
    DROP TABLE IF EXISTS sensor_runtime;
  `,
};

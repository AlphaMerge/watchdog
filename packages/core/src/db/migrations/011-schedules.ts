import type { Migration } from './types.js';

/**
 * Reusable schedules (`M-09`).
 *
 * `M-08` left `sensor_runtime.paused_by_schedule` set by nothing. This is what sets it: a named
 * time pattern, assigned to any object through the ordinary inheritance chain, that says when
 * the things beneath it are monitored at all.
 *
 * **A library table, not a branch of the object tree.** A schedule is referenced by many
 * objects and belongs to none of them — "Weekdays 08:00–18:00" is not a child of anything, and
 * making it one would give it a parent whose settings it would inherit, a position among
 * siblings, and a pause of its own. It is what `CAPABILITIES.MD §5` calls a library object, and
 * `[V2]`'s device templates and report definitions will want the same shape.
 *
 * **The assignment lives in `object_setting`, not here.** One inheritance chain, resolved in one
 * place (`CLAUDE.md`): `schedule.id` is an ordinary inheritable setting, so a group sets it, a
 * device below overrides it, and a sensor reverts to inherit — with no second rule to write, no
 * second resolver to keep in step, and the settings UI rendering it for free. The cost is that
 * jsonb cannot carry a foreign key, so the delete path checks for references itself; that check
 * is one indexed query, and it is worth more than a duplicate inheritance mechanism.
 */
export const migration011: Migration = {
  id: 11,
  name: 'schedules',

  up: `
    CREATE TABLE schedule (
      id           bigserial PRIMARY KEY,
      name         text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
      description  text NOT NULL DEFAULT '' CHECK (length(description) <= 500),

      -- The canonical form: half-open [start, end) intervals in minutes from Monday 00:00
      -- local, sorted, disjoint and merged. Both authoring modes normalise into this, so two
      -- schedules that mean the same thing store the same array and the evaluator has no
      -- wraparound case — a period running from Friday evening to Monday morning is stored as
      -- the two intervals it really is.
      periods      jsonb NOT NULL CHECK (jsonb_typeof(periods) = 'array' AND periods <> '[]'::jsonb),

      -- What those intervals mean. CAPABILITIES.MD's grid marks the hours monitoring runs;
      -- WORKFLOW.MD's period-list example is a maintenance window, which is the complement.
      -- Storing which one was meant is one column and one negation, and it is the difference
      -- between honouring both documents and silently inverting somebody's schedule.
      polarity     text NOT NULL CHECK (polarity IN ('active', 'inactive')),

      -- Which editor wrote it last. A hint for the UI so it reopens the form the author used;
      -- nothing that evaluates a schedule reads this.
      authored_as  text NOT NULL CHECK (authored_as IN ('grid', 'periods')),

      -- IANA zone, or NULL for the one the core process runs in. A schedule is a statement
      -- about local time — office hours that do not move with daylight saving are not office
      -- hours — so it cannot be stored as an offset. NULL is right for a single-site
      -- installation; a name is what one watching another country needs.
      timezone     text CHECK (timezone IS NULL OR length(timezone) BETWEEN 1 AND 80),

      -- Set on the schedules this build ships. They are seeded once at startup and never
      -- updated afterwards, so an operator who edits one keeps their edit across restarts;
      -- what the flag buys is a delete that refuses, so the documented set always exists.
      built_in_id  text UNIQUE CHECK (built_in_id IS NULL OR length(built_in_id) BETWEEN 1 AND 80),

      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER schedule_set_updated_at
      BEFORE UPDATE ON schedule
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- The sweep's fast path: it recomputes nothing at all unless something is assigned, and
    -- "is anything assigned" is a LIMIT 1 over this index. Partial, because the answer is no in
    -- almost every installation and the index should cost that installation nothing.
    CREATE INDEX object_setting_schedule_idx ON object_setting (object_id)
      WHERE key = 'schedule.id';

    -- The other half of the same fast path. "Nothing is assigned" is not enough to skip the
    -- recompute: clearing the last assignment leaves flags set that nothing else will clear,
    -- so the guard also has to ask whether any sensor is currently held by a schedule. Partial,
    -- so it holds a row only while something actually is.
    CREATE INDEX sensor_runtime_schedule_paused_idx ON sensor_runtime (object_id)
      WHERE paused_by_schedule;
  `,

  down: `
    DROP INDEX IF EXISTS sensor_runtime_schedule_paused_idx;
    DROP INDEX IF EXISTS object_setting_schedule_idx;
    DROP TRIGGER IF EXISTS schedule_set_updated_at ON schedule;
    DROP TABLE IF EXISTS schedule;
    -- The assignments themselves are ordinary settings; a rollback that left them would leave
    -- rows pointing at a table that no longer exists, and the resolver would serve an id that
    -- resolves to nothing.
    DELETE FROM object_setting WHERE key = 'schedule.id';
  `,
};

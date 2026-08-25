import type { Migration } from './types.js';

/**
 * Dependencies (`M-11`).
 *
 * The last of the four pause sources `M-08` left set by nothing. A sensor whose *master* is Down
 * is paused, so one unreachable switch produces one alarm instead of forty — which is the whole
 * of `WORKFLOW.MD §5`'s "one outage, one alarm".
 *
 * **The assignment is an inheritable setting, like `M-09`'s schedule.** `dependency.masterId` on
 * a device covers every sensor beneath it, "use parent" is simply not defining it, and "select
 * object" is defining it. One inheritance chain, resolved in one place. Nothing here stores the
 * relationship.
 *
 * What *is* stored here is the one fact that has nowhere else to live: when a master's recovery
 * stops holding its dependents. `WORKFLOW.MD §5` calls it the delay after dependency ends, and
 * `docs/state-machine.md §6` asked `M-11` where the timer lives. It is not a timer — it is this
 * column, on the master. A deadline in a table survives a restart, cannot be lost by a process
 * that dies mid-flap, and is re-derived rather than remembered: every fresh failure clears it and
 * every fresh recovery sets a new one, which is the answer to "what restarts it if the master
 * flaps during the delay".
 */
export const migration013: Migration = {
  id: 13,
  name: 'dependencies',

  up: `
    ALTER TABLE sensor_runtime
      ADD COLUMN dependency_clear_at timestamptz;

    COMMENT ON COLUMN sensor_runtime.dependency_clear_at IS
      'While in the future, this sensor still holds its dependents paused even though it has '
      'recovered - the delay after dependency ends (M-11). NULL means it holds them only while '
      'it is actually Down.';

    -- What the sweep reads to find a delay that has run out. Partial, because the column is NULL
    -- on every sensor that is not a master and on every master that is not mid-recovery, which
    -- in a typical installation is all of them.
    CREATE INDEX sensor_runtime_dependency_clear_idx ON sensor_runtime (dependency_clear_at)
      WHERE dependency_clear_at IS NOT NULL;

    -- "Is this sensor the master of anything" is asked on every batch that changed a state, so
    -- it has to be an index lookup rather than a scan of the settings table. Partial and on the
    -- extracted value, because that is the shape of the question.
    CREATE INDEX object_setting_dependency_master_idx
      ON object_setting (((value #>> '{}')))
      WHERE key = 'dependency.masterId';

    -- The other direction: resolving which sensors inherit a master, which is the same downward
    -- walk M-09's schedules use.
    CREATE INDEX object_setting_dependency_idx ON object_setting (object_id)
      WHERE key = 'dependency.masterId';
  `,

  down: `
    DROP INDEX IF EXISTS object_setting_dependency_idx;
    DROP INDEX IF EXISTS object_setting_dependency_master_idx;
    DROP INDEX IF EXISTS sensor_runtime_dependency_clear_idx;
    ALTER TABLE sensor_runtime DROP COLUMN dependency_clear_at;
    -- The assignments are ordinary settings, and going backwards leaves nothing that reads them:
    -- rows that would silently do nothing are worse than rows that are gone.
    DELETE FROM object_setting WHERE key IN ('dependency.masterId', 'dependency.delaySeconds');
  `,
};

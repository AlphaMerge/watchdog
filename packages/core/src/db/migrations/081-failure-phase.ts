import type { Migration } from './types.js';

/**
 * Where a failed check failed, stored as fields beside its message (`P-285`).
 *
 * Until protocol 35 a probe sent a failure's phase and host only inside its message's prose
 * ("the connection to 192.0.2.7 was lost while running …"), because a check result had no field
 * for them. CLAUDE.md asks every failure to carry its phase and its target; the message did, but
 * nothing could read them from it. Now a result may carry `failure: { phase, target? }`, and the
 * core keeps it on the two rows that keep the message: `sensor_runtime`, the current state, and
 * `sensor_state`, each transition.
 *
 * **Beside the message, and by the same rule** (`state-machine.md` §2.2): set when the words are
 * the scan's own and the scan failed, NULL when a limit, a lookup, a pause, an acknowledgement or
 * a hold explains the state. **Descriptive, never a cause**: nothing decides on these, and a phase
 * that changes while the state and the cause do not records no transition (§4.2, invariant 10).
 *
 * **Nullable, and NULL is "not named"**: every row before this, every result from a probe below
 * 35, and every check that threw a plain error. Nothing is backfilled from the prose, which would
 * be a parse of words written for a person. The phase without a target is a failure that named no
 * plain host; a target without a phase is not one, and the constraint refuses it. The lengths
 * are the wire's (`FAILURE_PHASE`, `FAILURE_TARGET`).
 *
 * `sensor_state` is a hypertable and is not compressed (`059`), so the columns and the constraint
 * reach every chunk. The rollback drops both columns from both tables, and what they held with
 * them: the message still says it.
 */
export const migration081: Migration = {
  id: 81,
  name: 'failure-phase',

  up: `
    ALTER TABLE sensor_runtime
      ADD COLUMN failure_phase text,
      ADD COLUMN failure_target text,
      ADD CONSTRAINT sensor_runtime_failure_ck CHECK (
        (failure_phase IS NULL OR char_length(failure_phase) BETWEEN 1 AND 32)
        AND (failure_target IS NULL
             OR (failure_phase IS NOT NULL AND char_length(failure_target) BETWEEN 1 AND 255))
      );

    ALTER TABLE sensor_state
      ADD COLUMN failure_phase text,
      ADD COLUMN failure_target text,
      ADD CONSTRAINT sensor_state_failure_ck CHECK (
        (failure_phase IS NULL OR char_length(failure_phase) BETWEEN 1 AND 32)
        AND (failure_target IS NULL
             OR (failure_phase IS NOT NULL AND char_length(failure_target) BETWEEN 1 AND 255))
      );

    COMMENT ON COLUMN sensor_runtime.failure_phase IS
      'The phase the check that explains this state failed in (connect, exec, walk, timeout), '
      'or NULL when it was not named or the state is not the scan''s to explain (P-285).';
    COMMENT ON COLUMN sensor_runtime.failure_target IS
      'The plain host that phase was acting on, when the probe named one (P-285).';
    COMMENT ON COLUMN sensor_state.failure_phase IS
      'The phase the check behind this transition failed in, or NULL (P-285).';
    COMMENT ON COLUMN sensor_state.failure_target IS
      'The plain host that phase was acting on, when the probe named one (P-285).';
  `,

  down: `
    ALTER TABLE sensor_state
      DROP CONSTRAINT IF EXISTS sensor_state_failure_ck,
      DROP COLUMN IF EXISTS failure_target,
      DROP COLUMN IF EXISTS failure_phase;

    ALTER TABLE sensor_runtime
      DROP CONSTRAINT IF EXISTS sensor_runtime_failure_ck,
      DROP COLUMN IF EXISTS failure_target,
      DROP COLUMN IF EXISTS failure_phase;
  `,
};

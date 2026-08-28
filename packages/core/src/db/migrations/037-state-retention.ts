import type { Migration } from './types.js';

/**
 * State history that retention cannot empty (`S-15`).
 *
 * **`sensor_state` was excluded from `S-06`'s retention sweep, and the reason is a sentence worth
 * keeping.** A sensor that has sat Up for three years has exactly one row, three years old.
 * Dropping the chunk that holds it would take it, and the sensor would then have *no known state
 * at all* — which breaks uptime and SLA, the two things `CLAUDE.md` requires be computed from
 * state history rather than from samples. Excluding the table made the data safe and the growth
 * unbounded.
 *
 * The answer is an **anchor**: before a drop removes a sensor's last surviving row, the state it
 * was in is written forward to the retention horizon. `carried` is what marks such a row, and it
 * is a column rather than a new `sensor_state_cause` for two reasons. A cause says *why the state
 * changed*, and nothing changed here — the row exists so that the history has a floor. And
 * removing an enum value on rollback means rewriting the type and every row that used it, where
 * dropping a column is one statement that cannot fail halfway.
 *
 * It is not merely cosmetic: `M-02` writes a transition when the *cause* changes without the
 * state changing, so `previous_state = state` was already possible and could not have been used
 * to recognise an anchor.
 */
export const migration037: Migration = {
  id: 37,
  name: 'state-retention',

  up: `
    ALTER TABLE sensor_state
      ADD COLUMN carried boolean NOT NULL DEFAULT false;

    COMMENT ON COLUMN sensor_state.carried IS
      'True on a row written by retention to carry a state forward past the horizon, rather than '
      'by a transition. Nothing changed at this instant; the row exists so the sensor still has a '
      'known state after the chunk holding its last real transition was dropped (S-15).';
  `,

  down: `
    ALTER TABLE sensor_state DROP COLUMN IF EXISTS carried;
  `,
};

import type { Migration } from './types.js';

/**
 * A return to Up, held (`M-18`).
 *
 * **When the sensor returned, while the return is held.** A state alarm whose sensor comes back is
 * not over until the return has lasted its type's hold: a relapse before then is the same outage,
 * and resumes the chain rather than arming a second one. The alarm's `phase` has to survive the
 * hold for that, which is why this is a column and not a fourth phase. `next_due_at` carries the
 * moment the hold ends, so the sweep that already finds due alarms is what confirms the return.
 *
 * **The rollback drops what is being held.** A build without the column reads a held row as an
 * ordinary standing alarm due at the end of its hold, and its sweep would find it due for a state
 * the sensor has left and stand it down silently anyway. Deleting the rows says so plainly. The
 * cost is the recovery notifications of the returns in their last five minutes, on a rollback
 * taken with the service stopped.
 */
export const migration063: Migration = {
  id: 63,
  name: 'alarm-recovering',

  up: `
    ALTER TABLE notification_alarm
      ADD COLUMN recovering_since timestamptz,
      ADD CONSTRAINT notification_alarm_recovering_is_a_state_alarm
        CHECK (recovering_since IS NULL OR kind = 'state');

    COMMENT ON COLUMN notification_alarm.recovering_since IS
      'When the sensor returned, while the return is held (M-18); NULL otherwise.';
  `,

  down: `
    DELETE FROM notification_alarm WHERE recovering_since IS NOT NULL;
    ALTER TABLE notification_alarm
      DROP CONSTRAINT notification_alarm_recovering_is_a_state_alarm,
      DROP COLUMN recovering_since;
  `,
};

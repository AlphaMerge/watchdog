import type { Migration } from './types.js';

/**
 * Threshold triggers, sharing the alarm table with state triggers (`N-03`).
 *
 * **One table, not two.** A threshold alarm and a state alarm differ in what arms them and in
 * nothing else: both stand for as long as their condition holds, both have a latency measured
 * from when it began, both are reconciled against the present rather than driven by events. More
 * to the point, `N-04` sweeps *one* due-time index, and two tables would mean two sweeps, two
 * indexes and two chances for a notification to be sent twice.
 *
 * So `kind` discriminates, `state` becomes nullable, and the shape constraint below makes the
 * two variants exclusive at the database rather than by convention: a state alarm has a state
 * and no channel, a threshold alarm has a channel and no state.
 *
 * **The observed value is stored on both the alarm and the request.** On the alarm because
 * "what is this about to page somebody about" should be answerable without re-querying the
 * hypertable; on the request because by the time anything delivers it the channel has moved on,
 * and a message quoting the value *now* would describe a different breach.
 */
export const migration017: Migration = {
  id: 17,
  name: 'threshold-alarms',

  up: `
    ALTER TABLE notification_alarm
      ADD COLUMN kind        text NOT NULL DEFAULT 'state'
                               CHECK (kind IN ('state', 'threshold')),
      ADD COLUMN channel_key text CHECK (channel_key IS NULL OR length(channel_key) <= 100),
      -- What the channel read when the alarm was last reconciled. NULL only for a state alarm.
      ADD COLUMN observed    double precision,
      ALTER COLUMN state DROP NOT NULL;

    ALTER TABLE notification_alarm
      ADD CONSTRAINT notification_alarm_shape CHECK (
        (kind = 'state'     AND state IS NOT NULL AND channel_key IS NULL) OR
        (kind = 'threshold' AND state IS NULL     AND channel_key IS NOT NULL)
      );

    -- A threshold trigger names one channel, and the same trigger inherited by fifty sensors is
    -- fifty alarms on fifty different channels. This is what makes "is this channel already
    -- alarming" a seek rather than a scan of everything standing.
    CREATE INDEX notification_alarm_channel_idx
      ON notification_alarm (sensor_id, channel_key)
      WHERE channel_key IS NOT NULL;

    -- ---------------------------------------------------------------------------------------
    -- What the request says.
    --
    -- Two more reasons rather than reusing 'initial' and 'recovery'. A threshold breach is not
    -- an outage and a clear is not a recovery: the sensor may have been Up throughout, which is
    -- the entire distinction between a threshold trigger and a channel limit (M-04). A digest
    -- that called them the same thing would be describing a different system.
    -- ---------------------------------------------------------------------------------------
    ALTER TABLE notification_request
      DROP CONSTRAINT notification_request_reason_check;

    ALTER TABLE notification_request
      ADD CONSTRAINT notification_request_reason_check
        CHECK (reason IN ('initial', 'escalation', 'repeat', 'recovery', 'threshold', 'clear'));

    ALTER TABLE notification_request
      ADD COLUMN channel_key text CHECK (channel_key IS NULL OR length(channel_key) <= 100),
      -- N-06's %lastvalue, frozen at the moment the obligation fell due.
      ADD COLUMN observed    double precision;
  `,

  down: `
    ALTER TABLE notification_request
      DROP COLUMN IF EXISTS observed,
      DROP COLUMN IF EXISTS channel_key;

    ALTER TABLE notification_request
      DROP CONSTRAINT IF EXISTS notification_request_reason_check;

    -- Rows the forward migration made possible cannot survive the constraint coming back, and a
    -- rollback that fails halfway is worse than one that discards what only the new code wrote.
    DELETE FROM notification_request WHERE reason IN ('threshold', 'clear');

    ALTER TABLE notification_request
      ADD CONSTRAINT notification_request_reason_check
        CHECK (reason IN ('initial', 'escalation', 'repeat', 'recovery'));

    DELETE FROM notification_alarm WHERE kind = 'threshold';

    ALTER TABLE notification_alarm
      DROP CONSTRAINT IF EXISTS notification_alarm_shape;

    DROP INDEX IF EXISTS notification_alarm_channel_idx;

    ALTER TABLE notification_alarm
      ALTER COLUMN state SET NOT NULL,
      DROP COLUMN IF EXISTS observed,
      DROP COLUMN IF EXISTS channel_key,
      DROP COLUMN IF EXISTS kind;
  `,
};

import type { Migration } from './types.js';

/**
 * What a state trigger is currently doing about a sensor, and what it decided to send (`N-02`).
 *
 * **The engine tracks alarms, not events.** The obvious design is to react to each state change
 * as it arrives — arm a timer on Down, cancel it on Up. It does not survive a restart, it leaks
 * a timer whenever a cancellation is missed, and it cannot answer "why is this sensor about to
 * page somebody" without replaying history. So the engine keeps a row per (sensor, trigger) for
 * as long as that trigger's state is standing, and every reaction is a *reconciliation* of that
 * row against the sensor's current state rather than the consumption of an event. A restart
 * rebuilds nothing: the rows are already there and the due times are absolute. A missed reaction
 * self-corrects at the next one. `N-04` makes the firing prompt and cheap; the correctness is
 * here.
 *
 * **The alarm keeps its own clock.** `sensor_runtime.since` moves on every transition, and
 * acknowledging a Down *is* a transition — so a chain measured against the runtime's `since`
 * would silently restart its escalation the moment somebody acknowledged it. `notification_alarm.
 * since` is when the alarm began and does not move while it stands, which is also what makes
 * "down for three hours" still say three hours after an acknowledgement.
 */
export const migration016: Migration = {
  id: 16,
  name: 'notification-alarms',

  up: `
    -- What the engine is currently doing about one sensor for one trigger.
    CREATE TABLE notification_alarm (
      id          bigserial PRIMARY KEY,
      sensor_id   bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      trigger_id  bigint NOT NULL REFERENCES notification_trigger (id) ON DELETE CASCADE,

      -- The state that armed it. Kept even though the trigger carries it, because a trigger
      -- edited from 'down' to 'warning' must not silently reinterpret the alarm standing
      -- against it -- the reconciliation compares the two and stands the old one down.
      state       sensor_state_kind NOT NULL,
      -- When the sensor entered that state. The alarm's own clock: every due time in the chain
      -- is derived from it, and it does not move while the alarm stands.
      since       timestamptz NOT NULL,

      -- How far along the chain. 'pending' has sent nothing yet -- a sensor inside its initial
      -- latency is an alarm nobody has been told about, which is the entire point of latency.
      phase       text NOT NULL CHECK (phase IN ('pending', 'notified', 'escalated')),

      -- When the next thing in the chain falls due, or NULL when nothing does: no escalation
      -- and no repeat configured, or the alarm is suppressed. NULL is common and is why the
      -- index below is partial.
      next_due_at timestamptz,
      repeats     integer NOT NULL DEFAULT 0 CHECK (repeats >= 0),

      -- Acknowledged (M-13): the chain stops, the alarm stands. PLAN.md's exit criterion is
      -- exactly this pair -- "acknowledging cancels pending escalations; recovery notification
      -- still fires" -- and it is a pair because they pull in opposite directions. Deleting the
      -- alarm would lose the recovery; leaving it armed would keep escalating.
      suppressed  boolean NOT NULL DEFAULT false,

      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),

      -- One alarm per sensor per trigger. Two would mean two escalation chains for one outage,
      -- which is the failure this whole subsystem exists to prevent.
      UNIQUE (sensor_id, trigger_id)
    );

    -- What N-04 sweeps. Partial because most alarms are not waiting for anything: a sensor down
    -- for a week with no repeat configured has a row and no due time, and an index that carried
    -- it would grow with the outage rather than with the work.
    CREATE INDEX notification_alarm_due_idx
      ON notification_alarm (next_due_at)
      WHERE next_due_at IS NOT NULL;

    -- "What is about to notify anyone about this sensor", for the sensor's own page.
    CREATE INDEX notification_alarm_sensor_idx ON notification_alarm (sensor_id);

    CREATE TRIGGER notification_alarm_set_updated_at
      BEFORE UPDATE ON notification_alarm
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- What the chain decided to send.
    --
    -- A queue, not a log of deliveries: N-05 gives the template ids meaning, N-07 onwards
    -- deliver, and N-11 summarises what is waiting here. Writing it inside the same transaction
    -- that advanced the alarm is what makes "sent exactly once" achievable at all -- an engine
    -- that advanced its own state and then handed a message to a mailer could lose the message
    -- or send it twice, and neither is recoverable after the fact.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE notification_request (
      id           bigserial PRIMARY KEY,
      -- When the obligation fell due, not when the row was written. A digest assembled later
      -- has to say when the outage started, not when the mailer got around to it.
      at           timestamptz NOT NULL,
      sensor_id    bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,

      -- SET NULL, not CASCADE: deleting a trigger stops future alarms, but a message that was
      -- already owed is part of the record of what this system told people. The kind travels
      -- alongside so the row still reads after the trigger is gone.
      trigger_id   bigint REFERENCES notification_trigger (id) ON DELETE SET NULL,
      trigger_kind text NOT NULL,

      -- N-05 gives this a table and a foreign key. Until then it is an id the operator typed,
      -- which is honest: a trigger can reference a template that does not exist yet, and
      -- refusing to record the obligation would lose it rather than surface it.
      template_id  bigint,

      reason       text NOT NULL
                     CHECK (reason IN ('initial', 'escalation', 'repeat', 'recovery')),
      -- What the sensor was when the obligation fell due, and what it had to say. Copied rather
      -- than joined: by the time anything delivers this, the sensor may have moved on, and a
      -- message describing the sensor's state *now* would describe a different outage.
      state        sensor_state_kind NOT NULL,
      message      text NOT NULL DEFAULT '',

      created_at   timestamptz NOT NULL DEFAULT now()
    );

    -- The delivery sweep's only question: what is waiting. Ordered, because a digest that
    -- reorders an outage is a digest nobody trusts.
    CREATE INDEX notification_request_pending_idx ON notification_request (at, id);
    CREATE INDEX notification_request_sensor_idx ON notification_request (sensor_id, at DESC);
  `,

  down: `
    DROP INDEX IF EXISTS notification_request_sensor_idx;
    DROP INDEX IF EXISTS notification_request_pending_idx;
    DROP TABLE IF EXISTS notification_request;
    DROP TRIGGER IF EXISTS notification_alarm_set_updated_at ON notification_alarm;
    DROP INDEX IF EXISTS notification_alarm_sensor_idx;
    DROP INDEX IF EXISTS notification_alarm_due_idx;
    DROP TABLE IF EXISTS notification_alarm;
  `,
};

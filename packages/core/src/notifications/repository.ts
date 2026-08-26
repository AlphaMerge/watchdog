import type { Queryable } from '../db/pool.js';
import type { SensorState } from '../state/tables.js';
import type { AlarmPhase, NotificationReason } from './chain.js';

/** Where a sensor currently is, as the engine reads it. */
export interface SensorStanding {
  readonly sensorId: number;
  readonly state: SensorState;
  readonly since: Date;
  readonly message: string;
}

/** One standing alarm, with its row id so it can be advanced or removed. */
export interface AlarmRow {
  readonly id: number;
  readonly sensorId: number;
  readonly triggerId: number;
  readonly state: SensorState;
  readonly since: Date;
  readonly phase: AlarmPhase;
  readonly nextDueAt: Date | null;
  readonly repeats: number;
  readonly suppressed: boolean;
}

/** An alarm that has fallen due, with everything deciding what to send needs. */
export interface DueAlarm extends AlarmRow {
  readonly triggerSettings: Record<string, unknown>;
  /** The sensor's state *now* — which may no longer be the one that armed the alarm. */
  readonly currentState: SensorState;
  readonly message: string;
}

export interface AlarmInsert {
  readonly sensorId: number;
  readonly triggerId: number;
  readonly state: SensorState;
  readonly since: Date;
  readonly nextDueAt: Date | null;
}

export interface AlarmAdvance {
  readonly id: number;
  readonly phase: AlarmPhase;
  readonly nextDueAt: Date | null;
  readonly repeats: number;
  readonly suppressed: boolean;
}

/** A notification the chain decided is owed. Nothing here delivers it — `N-07` onwards do. */
export interface RequestInsert {
  readonly at: Date;
  readonly sensorId: number;
  readonly triggerId: number;
  readonly triggerKind: string;
  readonly templateId: number | null;
  readonly reason: NotificationReason;
  readonly state: SensorState;
  readonly message: string;
}

interface AlarmRowShape {
  id: string;
  sensor_id: string;
  trigger_id: string;
  state: SensorState;
  since: Date;
  phase: AlarmPhase;
  next_due_at: Date | null;
  repeats: number;
  suppressed: boolean;
}

function toAlarm(row: AlarmRowShape): AlarmRow {
  return {
    id: Number(row.id),
    sensorId: Number(row.sensor_id),
    triggerId: Number(row.trigger_id),
    state: row.state,
    since: row.since,
    phase: row.phase,
    nextDueAt: row.next_due_at,
    repeats: row.repeats,
    suppressed: row.suppressed,
  };
}

const ALARM_COLUMNS = `
  a.id::text AS id, a.sensor_id::text AS sensor_id, a.trigger_id::text AS trigger_id,
  a.state, a.since, a.phase, a.next_due_at, a.repeats, a.suppressed
`;

/**
 * Where alarms and the notifications they owe are kept (`N-02`).
 *
 * Every write is set-based and takes arrays, for the same reason `M-02`'s do: an ingestion batch
 * carries hundreds of sensors, and a statement per sensor would make the notification engine the
 * slowest thing in the write path.
 */
export class AlarmRepository {
  /**
   * Whether there is anything for the engine to do: a trigger that could arm, or an alarm
   * already standing.
   *
   * The guard in front of everything else, and it is a **union** for the reason `M-09` and
   * `M-11` learned the hard way. "Is any trigger enabled" alone looks equivalent and is not:
   * switching off the last trigger in an installation makes it false while alarms are still
   * standing against it, so the very reaction that should stand them down returns early and they
   * stay armed for ever. The second half asks the question the other way round, and costs a
   * second `LIMIT 1` on an empty index.
   */
  async anyWork(q: Queryable): Promise<boolean> {
    const rows = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM notification_trigger WHERE enabled
       UNION ALL
       SELECT 1 AS one FROM notification_alarm
       LIMIT 1`,
    );
    return rows.length > 0;
  }

  /** Where a batch of sensors currently stands. Missing ids are sensors that no longer exist. */
  async standingOf(
    q: Queryable,
    sensorIds: readonly number[],
  ): Promise<Map<number, SensorStanding>> {
    const out = new Map<number, SensorStanding>();
    if (sensorIds.length === 0) return out;
    const rows = await q.query<{
      object_id: string;
      state: SensorState;
      since: Date;
      message: string;
    }>(
      `SELECT r.object_id::text AS object_id, r.state, r.since, r.message
       FROM sensor_runtime r
       WHERE r.object_id = ANY($1::bigint[])`,
      [sensorIds],
    );
    for (const row of rows) {
      const sensorId = Number(row.object_id);
      out.set(sensorId, {
        sensorId,
        state: row.state,
        since: row.since,
        message: row.message,
      });
    }
    return out;
  }

  /** The alarms standing for a batch of sensors, keyed by sensor. */
  async alarmsFor(q: Queryable, sensorIds: readonly number[]): Promise<Map<number, AlarmRow[]>> {
    const out = new Map<number, AlarmRow[]>();
    if (sensorIds.length === 0) return out;
    const rows = await q.query<AlarmRowShape>(
      `SELECT ${ALARM_COLUMNS} FROM notification_alarm a
       WHERE a.sensor_id = ANY($1::bigint[])
       ORDER BY a.sensor_id, a.trigger_id`,
      [sensorIds],
    );
    for (const row of rows) {
      const alarm = toAlarm(row);
      const existing = out.get(alarm.sensorId);
      if (existing === undefined) out.set(alarm.sensorId, [alarm]);
      else existing.push(alarm);
    }
    return out;
  }

  /**
   * Every alarm whose next step has fallen due.
   *
   * The partial index answers this: most alarms have no due time, so the scan is over the ones
   * actually waiting rather than over every outage in progress. The trigger's settings and the
   * sensor's current state ride along, because deciding what to send needs both and a second
   * round trip per alarm is what turns a sweep into a stampede.
   */
  async due(q: Queryable, now: Date, limit: number): Promise<DueAlarm[]> {
    const rows = await q.query<
      AlarmRowShape & {
        settings: Record<string, unknown>;
        current_state: SensorState;
        message: string;
      }
    >(
      `SELECT ${ALARM_COLUMNS}, t.settings, r.state AS current_state, r.message
       FROM notification_alarm a
       JOIN notification_trigger t ON t.id = a.trigger_id AND t.enabled
       JOIN sensor_runtime r ON r.object_id = a.sensor_id
       WHERE a.next_due_at IS NOT NULL AND a.next_due_at <= $1
       ORDER BY a.next_due_at, a.id
       LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => ({
      ...toAlarm(row),
      triggerSettings: row.settings,
      currentState: row.current_state,
      message: row.message,
    }));
  }

  /** When the earliest waiting alarm falls due, so `N-04` can sleep until then instead of polling. */
  async nextDueAt(q: Queryable): Promise<Date | null> {
    const rows = await q.query<{ next_due_at: Date }>(
      `SELECT next_due_at FROM notification_alarm
       WHERE next_due_at IS NOT NULL
       ORDER BY next_due_at
       LIMIT 1`,
    );
    return rows[0]?.next_due_at ?? null;
  }

  /**
   * Arms alarms.
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert: the unique key is (sensor, trigger), and a
   * conflict means another reaction armed it first — in which case that one's `since` is the
   * right one and overwriting it would restart somebody's escalation.
   */
  async arm(q: Queryable, inserts: readonly AlarmInsert[]): Promise<number> {
    if (inserts.length === 0) return 0;
    const rows = await q.query<{ id: string }>(
      `INSERT INTO notification_alarm (sensor_id, trigger_id, state, since, phase, next_due_at)
       SELECT * FROM unnest(
         $1::bigint[], $2::bigint[], $3::sensor_state_kind[], $4::timestamptz[],
         $5::text[], $6::timestamptz[]
       )
       ON CONFLICT (sensor_id, trigger_id) DO NOTHING
       RETURNING id::text AS id`,
      [
        inserts.map((row) => row.sensorId),
        inserts.map((row) => row.triggerId),
        inserts.map((row) => row.state),
        inserts.map((row) => row.since),
        inserts.map(() => 'pending'),
        inserts.map((row) => row.nextDueAt),
      ],
    );
    return rows.length;
  }

  /** Moves alarms along the chain: a new phase, a new due time, a suppression lifted or applied. */
  async advance(q: Queryable, advances: readonly AlarmAdvance[]): Promise<number> {
    if (advances.length === 0) return 0;
    const rows = await q.query<{ id: string }>(
      `UPDATE notification_alarm a
       SET phase = w.phase, next_due_at = w.next_due_at, repeats = w.repeats,
           suppressed = w.suppressed
       FROM (
         SELECT * FROM unnest(
           $1::bigint[], $2::text[], $3::timestamptz[], $4::integer[], $5::boolean[]
         ) AS t(id, phase, next_due_at, repeats, suppressed)
       ) AS w
       WHERE a.id = w.id
       RETURNING a.id::text AS id`,
      [
        advances.map((row) => row.id),
        advances.map((row) => row.phase),
        advances.map((row) => row.nextDueAt),
        advances.map((row) => row.repeats),
        advances.map((row) => row.suppressed),
      ],
    );
    return rows.length;
  }

  /** Stands alarms down. The row is the alarm; there is nothing left to keep once it is over. */
  async clear(q: Queryable, ids: readonly number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await q.query<{ id: string }>(
      'DELETE FROM notification_alarm WHERE id = ANY($1::bigint[]) RETURNING id::text AS id',
      [ids],
    );
    return rows.length;
  }

  /**
   * Queues notifications.
   *
   * Rows with no template are dropped here rather than at the call site, so every caller can
   * decide "this step is owed" without also deciding "and there is somewhere to send it": a
   * trigger with no initial template still has to advance through `initial` to reach its
   * escalation.
   */
  async queue(q: Queryable, requests: readonly RequestInsert[]): Promise<number> {
    const sendable = requests.filter((request) => request.templateId !== null);
    if (sendable.length === 0) return 0;
    const rows = await q.query<{ id: string }>(
      `INSERT INTO notification_request
         (at, sensor_id, trigger_id, trigger_kind, template_id, reason, state, message)
       SELECT * FROM unnest(
         $1::timestamptz[], $2::bigint[], $3::bigint[], $4::text[], $5::bigint[],
         $6::text[], $7::sensor_state_kind[], $8::text[]
       )
       RETURNING id::text AS id`,
      [
        sendable.map((row) => row.at),
        sendable.map((row) => row.sensorId),
        sendable.map((row) => row.triggerId),
        sendable.map((row) => row.triggerKind),
        sendable.map((row) => row.templateId),
        sendable.map((row) => row.reason),
        sendable.map((row) => row.state),
        sendable.map((row) => row.message),
      ],
    );
    return rows.length;
  }

  /**
   * The sensors beneath an object, for the reconciliation a trigger edit forces (`N-02`).
   *
   * Creating a trigger on the root has to arm every sensor that is *already* Down — an operator
   * who adds "tell me about outages" during an outage means this one, and a chain that only ever
   * started on the next state change would stay silent until the sensor recovered and failed
   * again.
   */
  async sensorsUnder(q: Queryable, objectId: number, limit: number): Promise<number[]> {
    const rows = await q.query<{ id: string }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT o.id, o.kind FROM object o WHERE o.id = $1
        UNION ALL
        SELECT c.id, c.kind FROM object c JOIN subtree ON c.parent_id = subtree.id
      )
      SELECT id::text AS id FROM subtree WHERE kind = 'sensor' ORDER BY id LIMIT $2
      `,
      [objectId, limit],
    );
    return rows.map((row) => Number(row.id));
  }
}

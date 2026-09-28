import type { Queryable } from '../db/pool.js';
import type { Visibility } from '../auth/access.js';
import type { SensorState } from '../state/tables.js';
import type { NotificationReason } from './chain.js';

/** One notification, and everything that happened to it (`N-13`). */
export interface NotificationLogEntry {
  readonly id: number;
  readonly at: Date;
  readonly sensorId: number;
  readonly sensorName: string | null;
  readonly templateId: number | null;
  readonly templateName: string | null;
  readonly method: string | null;
  readonly triggerKind: string;
  readonly reason: NotificationReason;
  readonly state: SensorState | null;
  readonly message: string;
  readonly status: string;
  /** Whether it was sent on its own or folded into a digest (`N-11`). */
  readonly disposition: string;
  readonly attempts: number;
  readonly deliveredAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly lastError: string | null;
}

export interface NotificationLogQuery {
  /**
   * Whose log this is (`A-12`). A notification is about a sensor, and one about a sensor the
   * reader cannot see is absent — its message is that sensor's failure message. A deleted
   * sensor's notifications are an administrator's alone, as its state log is.
   */
  readonly visibility: Visibility;
  readonly status?: readonly string[];
  readonly sensorId?: number;
  readonly templateId?: number;
  /** Page backwards from this id, exclusive. */
  readonly before?: number;
  readonly limit?: number;
}

interface Row {
  id: string;
  at: Date;
  sensor_id: string;
  sensor_name: string | null;
  template_id: string | null;
  template_name: string | null;
  method: string | null;
  trigger_kind: string;
  reason: NotificationReason;
  state: SensorState | null;
  message: string;
  status: string;
  disposition: string;
  attempts: number;
  delivered_at: Date | null;
  next_attempt_at: Date | null;
  last_error: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * "Did my alarm actually go out?" (`N-13`).
 *
 * The table has recorded the answer since `N-07`; until now nothing could ask. The dispatcher's
 * only question is "what is owed", which a partial index on the pending rows answers; an
 * operator's question is about the rows that are *not* pending any more, and it is the question
 * `WORKFLOW.MD §6` means when it says a delivery failure must be surfaced rather than
 * disappearing into a log file. A failure nobody can query has disappeared into a log file
 * however carefully it was written.
 *
 * Paged by descending id rather than by offset: notifications arrive while somebody is reading,
 * and an offset page would show them a row twice or not at all.
 */
export class NotificationLogReader {
  async list(q: Queryable, query: NotificationLogQuery): Promise<NotificationLogEntry[]> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const values: unknown[] = [
      query.status === undefined || query.status.length === 0 ? null : [...query.status],
      query.sensorId ?? null,
      query.templateId ?? null,
      query.before ?? null,
      limit,
    ];
    const visible = query.visibility.where(
      'r.sensor_id',
      (value) => `$${String(values.push(value))}`,
      { mayBeDeleted: true },
    );
    const rows = await q.query<Row>(
      `
      SELECT r.id::text AS id, r.at, r.sensor_id::text AS sensor_id, o.name AS sensor_name,
             r.template_id::text AS template_id, t.name AS template_name, t.method,
             r.trigger_kind, r.reason, r.state, r.message, r.status, r.disposition, r.attempts,
             r.delivered_at, r.next_attempt_at, r.last_error
      FROM notification_request r
      LEFT JOIN object o ON o.id = r.sensor_id
      LEFT JOIN notification_template t ON t.id = r.template_id
      WHERE ($1::text[] IS NULL OR r.status = ANY($1))
        AND ($2::bigint IS NULL OR r.sensor_id = $2)
        AND ($3::bigint IS NULL OR r.template_id = $3)
        AND ($4::bigint IS NULL OR r.id < $4)
        AND ${visible}
      ORDER BY r.id DESC
      LIMIT $5
      `,
      values,
    );
    return rows.map(toEntry);
  }
}

function toEntry(row: Row): NotificationLogEntry {
  return {
    id: Number(row.id),
    at: row.at,
    sensorId: Number(row.sensor_id),
    sensorName: row.sensor_name,
    templateId: row.template_id === null ? null : Number(row.template_id),
    templateName: row.template_name,
    method: row.method,
    triggerKind: row.trigger_kind,
    reason: row.reason,
    state: row.state,
    message: row.message,
    status: row.status,
    disposition: row.disposition,
    attempts: row.attempts,
    deliveredAt: row.delivered_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  };
}

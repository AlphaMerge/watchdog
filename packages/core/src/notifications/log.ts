import type { Queryable } from '../db/pool.js';
import type { Visibility } from '../auth/access.js';
import type { SensorState } from '../state/tables.js';
import type { NotificationReason } from './chain.js';
import { describeCounts, type SkipCounts } from './recipients.js';
import type { RequestDisposition } from './summarisation.js';

/**
 * The statuses a request can be in, which are also the log's filter values, as
 * `notification_request_status_check` (migration 021) allows. `ms:notificationRequest` enumerates
 * them, and `fixed-value-fields.test.ts` checks them against the constraint (`P-335`). Here rather
 * than beside the route so the entry's type is derived from the same list (`P-352`).
 */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'discarded'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

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
  /** `notification_request.state`, which is NOT NULL (migration 016). */
  readonly state: SensorState;
  readonly message: string;
  /** `notification_request.status`, which its CHECK holds to `NOTIFICATION_STATUSES`. */
  readonly status: NotificationStatus;
  /** Whether it was sent on its own or folded into a digest (`N-11`). */
  readonly disposition: RequestDisposition;
  readonly attempts: number;
  readonly deliveredAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly lastError: string | null;
  /**
   * Who a message named and did not reach, and why; empty when it reached everybody. By name, or
   * by count and reason, as `namesAccounts` asked.
   */
  readonly skippedRecipients: string;
}

export interface NotificationLogQuery {
  /**
   * Whose log this is (`A-12`). A notification is about a sensor, and one about a sensor the
   * reader cannot see is absent — its message is that sensor's failure message. A deleted
   * sensor's notifications go with it: the rows cascade with the sensor (migration 016), unlike
   * its state log (`A-31`).
   */
  readonly visibility: Visibility;
  /**
   * Whether the reader may see who a message missed by name (`A-44`): an administrator, who may
   * list the accounts and groups anyway. Everybody else who can read the sensor is told how many
   * were missed and why — a name, a group's membership and whether an account may read this
   * sensor are `M-20`'s to give, and reading a sensor is not enough. Required, so a new reader of
   * the log decides rather than inherits.
   */
  readonly namesAccounts: boolean;
  readonly status?: readonly NotificationStatus[];
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
  state: SensorState;
  message: string;
  status: NotificationStatus;
  disposition: RequestDisposition;
  attempts: number;
  delivered_at: Date | null;
  next_attempt_at: Date | null;
  last_error: string | null;
  skipped_recipients: string;
  skipped_counts: SkipCounts;
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
    );
    const rows = await q.query<Row>(
      `
      SELECT r.id::text AS id, r.at, r.sensor_id::text AS sensor_id, o.name AS sensor_name,
             r.template_id::text AS template_id, t.name AS template_name, t.method,
             r.trigger_kind, r.reason, r.state, r.message, r.status, r.disposition, r.attempts,
             r.delivered_at, r.next_attempt_at, r.last_error, r.skipped_recipients,
             r.skipped_counts
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
    return rows.map((row) => toEntry(row, query.namesAccounts));
  }
}

function toEntry(row: Row, namesAccounts: boolean): NotificationLogEntry {
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
    skippedRecipients: namesAccounts ? row.skipped_recipients : describeCounts(row.skipped_counts),
  };
}

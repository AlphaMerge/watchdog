import type { Queryable } from '../db/pool.js';
import type { SensorState } from '../state/tables.js';
import type { NotificationReason } from './chain.js';
import type { Disposition, MessageKind } from './summarisation.js';

/** One queued notification that has not yet been told whether it is immediate or held. */
export interface UndecidedRequest {
  readonly id: number;
  readonly templateId: number | null;
  readonly reason: NotificationReason;
  readonly state: SensorState | null;
  /** Null when the template is gone, which the dispatcher turns into a failure with a reason. */
  readonly method: string | null;
  readonly summarisation: string | null;
  readonly windowSeconds: number | null;
  /**
   * For a recovery or a clear, the digest still holding the alarm it recovers from (`N-20`), or
   * null. When set, this request belongs in that digest beside its alarm and is decided no other
   * way.
   */
  readonly alarmHeldIn: HeldAlarm | null;
}

/** Where a recovery's alarm is waiting: its window, and when the alarm is next due a try. */
export interface HeldAlarm {
  readonly windowId: number;
  readonly nextAttemptAt: Date | null;
}

/** An open collection window, and what has already gone out immediately inside it. */
export interface OpenWindow {
  readonly id: number;
  readonly released: MessageKind[];
  readonly dueAt: Date;
}

/** A window whose time is up and whose contents are owed as a digest. */
export interface ClosedWindow {
  readonly id: number;
  readonly templateId: number;
}

/**
 * Where summarisation state lives (`N-11`).
 *
 * Only SQL. What the modes *mean* is `summarisation.ts`, which is pure and table-driven, and how
 * the two are put together is the dispatcher's.
 */
export class SummaryRepository {
  /**
   * Requests still waiting for a decision, oldest first.
   *
   * **A recovery is never told before its alarm** (`N-20`). The rehearsal's Probe Health went to
   * Warning, which the default mode holds for the digest, and recovered inside the window: its
   * recovery, the window's first Up, went out at once, and the Warning arrived eight minutes
   * later in the digest. So a recovery or a clear looks for the alarm it recovers from, the same
   * sensor, trigger and channel, still owed:
   *
   * - **held in a digest of its own template**: it is returned with that window, and joins it.
   *   The digest lists the alarm and then its recovery, and the outage is one message.
   * - **not decided yet, or held in another template's digest**: it is not returned at all, so
   *   it waits, and is decided once the alarm has been. Left out here rather than skipped by the
   *   caller, so a storm of waiting recoveries cannot fill the batch and hold up a new Down. The
   *   other template has to be one this build can send, or the recovery would wait for a message
   *   that is never coming.
   */
  async undecided(
    q: Queryable,
    limit: number,
    suppressed: readonly number[] = [],
    methods: readonly string[] = [],
  ): Promise<UndecidedRequest[]> {
    const rows = await q.query<{
      id: string;
      template_id: string | null;
      reason: NotificationReason;
      state: SensorState | null;
      method: string | null;
      summarisation: string | null;
      window_seconds: number | null;
      alarm_window_id: string | null;
      alarm_next_attempt_at: Date | null;
    }>(
      `
      SELECT r.id::text AS id, r.template_id::text AS template_id, r.reason, r.state,
             t.method, t.summarisation, t.summary_window_seconds AS window_seconds,
             alarm.summary_id::text AS alarm_window_id,
             alarm.next_attempt_at AS alarm_next_attempt_at
      FROM notification_request r
      -- LEFT, because a request whose template has been deleted still has to be decided: the
      -- dispatcher fails it with a reason an operator can act on rather than leaving it here
      -- undecided for ever.
      LEFT JOIN notification_template t ON t.id = r.template_id
      -- The alarm a recovery or a clear recovers from, while it is still owed and not yet sent
      -- (N-20). One that makes it wait sorts first, so a recovery joins a digest only when
      -- nothing else of its outage is still to come.
      LEFT JOIN LATERAL (
        SELECT a.summary_id, a.next_attempt_at,
               (a.disposition = 'undecided'
                 OR a.template_id IS DISTINCT FROM r.template_id) AS waits
        FROM notification_request a
        LEFT JOIN notification_template tpl ON tpl.id = a.template_id
        WHERE r.reason IN ('recovery', 'clear')
          AND a.sensor_id = r.sensor_id
          AND a.trigger_kind = r.trigger_kind
          AND a.trigger_id IS NOT DISTINCT FROM r.trigger_id
          AND a.channel_key IS NOT DISTINCT FROM r.channel_key
          AND a.id < r.id
          AND a.reason NOT IN ('recovery', 'clear')
          AND a.status = 'pending'
          AND (a.disposition = 'undecided'
               OR (a.disposition = 'held' AND a.summary_id IS NOT NULL
                   AND (a.template_id = r.template_id
                        OR (tpl.enabled AND tpl.method = ANY($3::text[])))))
        ORDER BY waits DESC, a.id DESC
        LIMIT 1
      ) alarm ON true
      WHERE r.disposition = 'undecided' AND r.status = 'pending'
        -- A template outside its activation schedule (N-12) is left undecided, so its backlog
        -- is summarised as one storm when the schedule reopens rather than in windows that
        -- opened and closed while nobody was listening.
        AND NOT (r.template_id = ANY($2::bigint[]))
        AND alarm.waits IS NOT TRUE
      ORDER BY r.id
      LIMIT $1
      FOR UPDATE OF r SKIP LOCKED
      `,
      [limit, [...suppressed], [...methods]],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      templateId: row.template_id === null ? null : Number(row.template_id),
      reason: row.reason,
      state: row.state,
      method: row.method,
      summarisation: row.summarisation,
      windowSeconds: row.window_seconds,
      alarmHeldIn:
        row.alarm_window_id === null
          ? null
          : { windowId: Number(row.alarm_window_id), nextAttemptAt: row.alarm_next_attempt_at },
    }));
  }

  /**
   * The template's open window, opening one if there is none.
   *
   * A no-op `DO UPDATE` rather than `DO NOTHING`, because the row is wanted either way and
   * `DO NOTHING` returns nothing when it conflicts. The conflict target names the partial index's
   * predicate, which is what makes "one open window per template" a rule the database keeps.
   */
  async openWindow(
    q: Queryable,
    templateId: number,
    now: Date,
    windowSeconds: number,
  ): Promise<OpenWindow> {
    const rows = await q.query<{ id: string; released: string[]; due_at: Date }>(
      `
      INSERT INTO notification_summary (template_id, opened_at, due_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (template_id) WHERE closed_at IS NULL
      DO UPDATE SET due_at = notification_summary.due_at
      RETURNING id::text AS id, released, due_at
      `,
      [templateId, now, new Date(now.getTime() + windowSeconds * 1000)],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('a summarisation window could not be opened');
    return {
      id: Number(row.id),
      released: row.released.filter(isKind),
      dueAt: row.due_at,
    };
  }

  /** Records that a kind has gone out immediately inside this window. */
  async release(q: Queryable, windowId: number, kind: MessageKind): Promise<void> {
    await q.query(
      `UPDATE notification_summary
       SET released = array_append(released, $2)
       WHERE id = $1 AND NOT ($2 = ANY(released))`,
      [windowId, kind],
    );
  }

  /** Writes one request's decision. */
  async decide(
    q: Queryable,
    requestId: number,
    decision: Disposition,
    windowId: number | null,
  ): Promise<void> {
    await q.query(
      `UPDATE notification_request SET disposition = $2, summary_id = $3 WHERE id = $1`,
      [requestId, decision, windowId],
    );
  }

  /**
   * Holds a recovery in the digest its alarm is waiting in (`N-20`).
   *
   * The window may already be closed, its digest refused and waiting out a retry. So the
   * recovery takes the alarm's next try as well: a digest claims only the members that are due,
   * and one due before its alarm would go out alone, ahead of it, which is the order this exists
   * to stop.
   */
  async holdBeside(q: Queryable, requestId: number, alarm: HeldAlarm): Promise<void> {
    await q.query(
      `UPDATE notification_request
       SET disposition = 'held', summary_id = $2, next_attempt_at = $3
       WHERE id = $1`,
      [requestId, alarm.windowId, alarm.nextAttemptAt],
    );
  }

  /** Closes every window whose time is up, and says which they were. */
  async closeDue(q: Queryable, now: Date): Promise<ClosedWindow[]> {
    const rows = await q.query<{ id: string; template_id: string }>(
      `UPDATE notification_summary
       SET closed_at = $1
       WHERE closed_at IS NULL AND due_at <= $1
       RETURNING id::text AS id, template_id::text AS template_id`,
      [now],
    );
    return rows.map((row) => ({ id: Number(row.id), templateId: Number(row.template_id) }));
  }

  /** When the earliest open window closes, so a caller can wait rather than poll. */
  async nextDueAt(q: Queryable): Promise<Date | null> {
    const rows = await q.query<{ due_at: Date }>(
      `SELECT due_at FROM notification_summary WHERE closed_at IS NULL ORDER BY due_at LIMIT 1`,
    );
    return rows[0]?.due_at ?? null;
  }

  /**
   * Closed windows that still owe a digest, oldest first.
   *
   * **Only windows this build could actually send** (`P-122`). A window whose template has since
   * been disabled, or whose method has no transport in this build, holds requests that the claim
   * will never take — so it came back from here on every pass, produced no members, and consumed
   * one of the caller's slots for ever. Enough of them and every other template's digests stopped
   * arriving: the batch was full of windows nothing could ever empty, and nothing anywhere said so
   * because each pass looked like an ordinary quiet one.
   *
   * Left in the table rather than failed: re-enabling the template, or a build that has the
   * transport, still owes those people the digest.
   */
  async owing(
    q: Queryable,
    now: Date,
    limit: number,
    suppressed: readonly number[] = [],
    methods: readonly string[] = [],
  ): Promise<ClosedWindow[]> {
    const rows = await q.query<{ id: string; template_id: string }>(
      `
      SELECT s.id::text AS id, s.template_id::text AS template_id
      FROM notification_summary s
      JOIN notification_template t ON t.id = s.template_id
      WHERE s.closed_at IS NOT NULL
        AND NOT (s.template_id = ANY($3::bigint[]))
        AND t.enabled
        AND t.method = ANY($4::text[])
        AND EXISTS (
          SELECT 1 FROM notification_request r
          WHERE r.summary_id = s.id
            AND r.status = 'pending'
            AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $1)
        )
      ORDER BY s.id
      LIMIT $2
      `,
      [now, limit, [...suppressed], [...methods]],
    );
    return rows.map((row) => ({ id: Number(row.id), templateId: Number(row.template_id) }));
  }

  /**
   * Removes windows nothing is waiting in.
   *
   * A window that opened, released its first Down immediately and then saw nothing else closes
   * empty — which is the *common* case for a template that mostly notifies about one sensor at a
   * time. Left alone they would accumulate one row per window per template for ever.
   */
  async prune(q: Queryable, before: Date): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `
      DELETE FROM notification_summary s
      WHERE s.closed_at IS NOT NULL
        AND s.closed_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM notification_request r
          WHERE r.summary_id = s.id AND r.status = 'pending'
        )
      RETURNING id::text AS id
      `,
      [before],
    );
    return rows.length;
  }
}

function isKind(value: string): value is MessageKind {
  return value === 'down' || value === 'up' || value === 'other';
}

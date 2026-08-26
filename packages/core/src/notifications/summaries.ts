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
  /** Requests still waiting for a decision, oldest first. */
  async undecided(q: Queryable, limit: number): Promise<UndecidedRequest[]> {
    const rows = await q.query<{
      id: string;
      template_id: string | null;
      reason: NotificationReason;
      state: SensorState | null;
      method: string | null;
      summarisation: string | null;
      window_seconds: number | null;
    }>(
      `
      SELECT r.id::text AS id, r.template_id::text AS template_id, r.reason, r.state,
             t.method, t.summarisation, t.summary_window_seconds AS window_seconds
      FROM notification_request r
      -- LEFT, because a request whose template has been deleted still has to be decided: the
      -- dispatcher fails it with a reason an operator can act on rather than leaving it here
      -- undecided for ever.
      LEFT JOIN notification_template t ON t.id = r.template_id
      WHERE r.disposition = 'undecided' AND r.status = 'pending'
      ORDER BY r.id
      LIMIT $1
      FOR UPDATE OF r SKIP LOCKED
      `,
      [limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      templateId: row.template_id === null ? null : Number(row.template_id),
      reason: row.reason,
      state: row.state,
      method: row.method,
      summarisation: row.summarisation,
      windowSeconds: row.window_seconds,
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
    await q.query(`UPDATE notification_request SET disposition = $2, summary_id = $3 WHERE id = $1`, [
      requestId,
      decision,
      windowId,
    ]);
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

  /** Closed windows that still owe a digest, oldest first. */
  async owing(q: Queryable, now: Date, limit: number): Promise<ClosedWindow[]> {
    const rows = await q.query<{ id: string; template_id: string }>(
      `
      SELECT s.id::text AS id, s.template_id::text AS template_id
      FROM notification_summary s
      WHERE s.closed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM notification_request r
          WHERE r.summary_id = s.id
            AND r.status = 'pending'
            AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $1)
        )
      ORDER BY s.id
      LIMIT $2
      `,
      [now, limit],
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

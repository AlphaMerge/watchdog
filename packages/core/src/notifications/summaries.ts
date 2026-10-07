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
   * The digest of this request's own template still holding the request it must follow, or
   * null: for a recovery or a clear, the alarm it recovers from (`N-20`); for an alarm, the
   * recovery or clear of the outage before it (`N-21`). When set, this request belongs in that
   * digest after it and is decided no other way. One whose predecessor is owed in any other way
   * is not returned at all (`N-21`).
   */
  readonly heldBehind: HeldAhead | null;
}

/** Where the request ahead is waiting: its window, and when it is next due a try. */
export interface HeldAhead {
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
   *   other template has to be one this build can send, enabled and inside its activation
   *   schedule, or the recovery would wait for a message that is never coming, or not coming
   *   until the schedule reopens.
   * - **sent at once and not delivered yet** (`N-21`): its first try was refused and it is
   *   waiting out the backoff, or a pass has it claimed. Not returned either, for the same reason:
   *   decided now, the recovery is claimed now, and an Up delivered inside the alarm's retry delay
   *   reaches the recipient before the Down. Any alarm of the trigger counts — an initial, an
   *   escalation or a repeat, on whichever template — so a recovery waits for every one of them.
   *
   * **And in the other direction, an alarm is never told before the recovery ahead of it**
   * (`N-21`). A sensor that goes Down again while its last recovery is still waiting behind a
   * refused Down queues a second Down, which nothing else orders: never tried, it would be
   * claimed first, and the last thing the recipient heard would be *up* about a sensor that is
   * Down. So an alarm looks for an owed recovery or clear of the same sensor, trigger and channel,
   * **on its own template only**, and waits for its retry, or joins its digest. Never another
   * template's, nor through a recovery of its own that is waiting for another template's alarm:
   * a late page is worse than one out of order, and another template has other recipients and
   * another transport, whose failure must not make this one's Downs late. Joining a digest never
   * delays a Down the mode would send at once either: the dispatcher sends that digest now
   * (`SummaryRepository.flush`). Alarms are not ordered among themselves here: an escalation
   * queued behind a refused initial is not this ordering's business.
   *
   * **Every wait is bounded by the retries of the request at its head.** A request only ever
   * waits for an earlier one, so the waits form a chain that starts at a request waiting for
   * nothing but its own delivery. Delivered, it releases the next to the following pass. Given
   * up on (`N-13`: refused permanently, or out of attempts, 45 to 90 minutes under the default
   * policy), it is no longer pending, and what was behind it is decided and sent on its own: a
   * recovery is never dropped because its alarm was, and the alarm given up on is what Core
   * Health goes Down for. None of this is held in memory — it is read from the queue — so a core
   * that restarts while an alarm is waiting for its retry keeps everything behind it.
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
      ahead_window_id: string | null;
      ahead_next_attempt_at: Date | null;
    }>(
      `
      SELECT r.id::text AS id, r.template_id::text AS template_id, r.reason, r.state,
             t.method, t.summarisation, t.summary_window_seconds AS window_seconds,
             ahead.summary_id::text AS ahead_window_id,
             ahead.next_attempt_at AS ahead_next_attempt_at
      FROM notification_request r
      -- LEFT, because a request whose template has been deleted still has to be decided: the
      -- dispatcher fails it with a reason an operator can act on rather than leaving it here
      -- undecided for ever.
      LEFT JOIN notification_template t ON t.id = r.template_id
      -- The earlier request of the other kind, while it is still owed and not yet sent: for a
      -- recovery or a clear, the alarm it recovers from (N-20, N-21); for an alarm, the recovery
      -- or clear of the outage before it (N-21). Undecided, held for a digest, or sent at once
      -- and waiting out a retry or a lease. Only joining that request's digest lets this one be
      -- decided beside it; every other owed one makes it wait, and one that does sorts first, so
      -- a request joins a digest only when nothing else ahead of it is still to come.
      LEFT JOIN LATERAL (
        SELECT a.summary_id, a.next_attempt_at,
               NOT (a.disposition = 'held' AND a.summary_id IS NOT NULL
                    AND a.template_id = r.template_id) AS waits
        FROM notification_request a
        LEFT JOIN notification_template tpl ON tpl.id = a.template_id
        WHERE a.sensor_id = r.sensor_id
          AND a.trigger_kind = r.trigger_kind
          AND a.trigger_id IS NOT DISTINCT FROM r.trigger_id
          AND a.channel_key IS NOT DISTINCT FROM r.channel_key
          AND a.id < r.id
          AND (a.reason IN ('recovery', 'clear')) <> (r.reason IN ('recovery', 'clear'))
          AND a.status = 'pending'
          -- A recovery waits for another template's alarm only while something will send it:
          -- enabled, with a transport in this build, and inside its activation schedule.
          -- Otherwise it would wait on a message that is not coming, or not until the morning.
          -- An alarm never waits on another template at all: a late page is worse than one out
          -- of order, and that template's recipients and transport are not this one's.
          AND (a.template_id = r.template_id
               OR (r.reason IN ('recovery', 'clear')
                   AND tpl.enabled AND tpl.method = ANY($3::text[])
                   AND NOT (a.template_id = ANY($2::bigint[]))))
          -- Nor through a recovery of its own template that is itself waiting for another
          -- template's alarm, an escalation say: that would be the same wait, one step removed.
          AND (r.reason IN ('recovery', 'clear') OR NOT EXISTS (
                SELECT 1
                FROM notification_request b
                JOIN notification_template bt ON bt.id = b.template_id
                WHERE b.sensor_id = a.sensor_id
                  AND b.trigger_kind = a.trigger_kind
                  AND b.trigger_id IS NOT DISTINCT FROM a.trigger_id
                  AND b.channel_key IS NOT DISTINCT FROM a.channel_key
                  AND b.id < a.id
                  AND b.reason NOT IN ('recovery', 'clear')
                  AND b.status = 'pending'
                  AND b.template_id <> a.template_id
                  AND bt.enabled AND bt.method = ANY($3::text[])
                  AND NOT (b.template_id = ANY($2::bigint[]))))
        ORDER BY waits DESC, a.id DESC
        LIMIT 1
      ) ahead ON true
      WHERE r.disposition = 'undecided' AND r.status = 'pending'
        -- A template outside its activation schedule (N-12) is left undecided, so its backlog
        -- is summarised as one storm when the schedule reopens rather than in windows that
        -- opened and closed while nobody was listening.
        AND NOT (r.template_id = ANY($2::bigint[]))
        AND ahead.waits IS NOT TRUE
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
      heldBehind:
        row.ahead_window_id === null
          ? null
          : { windowId: Number(row.ahead_window_id), nextAttemptAt: row.ahead_next_attempt_at },
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

  /** What an open window has released, or null when the window is closed or gone. */
  async releasedIfOpen(q: Queryable, windowId: number): Promise<MessageKind[] | null> {
    const rows = await q.query<{ released: string[] }>(
      `SELECT released FROM notification_summary WHERE id = $1 AND closed_at IS NULL FOR UPDATE`,
      [windowId],
    );
    const row = rows[0];
    return row === undefined ? null : row.released.filter(isKind);
  }

  /**
   * Sends an open window's digest now, for a message the mode says goes at once (`N-21`).
   *
   * An alarm whose last recovery is held in this window must not go ahead of it, and must not
   * wait for the window either: under `downs-immediate` that is a Down held for up to a day. So
   * the window closes now, the alarm joins it, and the digest goes on this pass, ending on the
   * alarm.
   *
   * **The rest of the window carries on as if it had not been cut short.** A successor opens
   * with the same due time and with what the window had released, plus this alarm's kind — it
   * did go at once. Without that, the next Down of another sensor would be the fresh window's
   * "first Down" and go at once as well: one more message than the mode allows.
   */
  async flush(q: Queryable, windowId: number, now: Date, kind: MessageKind): Promise<void> {
    const closed = await q.query<{ template_id: string; due_at: Date; released: string[] }>(
      `UPDATE notification_summary SET closed_at = $2
       WHERE id = $1 AND closed_at IS NULL
       RETURNING template_id::text AS template_id, due_at, released`,
      [windowId, now],
    );
    const window = closed[0];
    if (window === undefined) return;
    const released = window.released.includes(kind) ? window.released : [...window.released, kind];
    await q.query(
      `INSERT INTO notification_summary (template_id, opened_at, due_at, released)
       VALUES ($1, $2, $3, $4::text[])`,
      [window.template_id, now, window.due_at, released],
    );
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
   * Holds a request in the digest the request ahead of it is waiting in: a recovery beside its
   * alarm (`N-20`), or an alarm beside the recovery of the outage before it (`N-21`).
   *
   * The window may already be closed, its digest refused and waiting out a retry. So the
   * request takes the next try of the one ahead as well: a digest claims only the members that
   * are due, and one due before the request ahead would go out alone, ahead of it, which is the
   * order this exists to stop. Members are listed by id, so it is listed after it.
   */
  async holdBeside(q: Queryable, requestId: number, ahead: HeldAhead): Promise<void> {
    await q.query(
      `UPDATE notification_request
       SET disposition = 'held', summary_id = $2, next_attempt_at = $3
       WHERE id = $1`,
      [requestId, ahead.windowId, ahead.nextAttemptAt],
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

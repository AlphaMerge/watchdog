import type { Queryable } from '../db/pool.js';

/** What delivery looks like right now, per method and overall (`N-13`). */
export interface DeliveryMethodHealth {
  readonly method: string;
  /** Undelivered obligations. */
  readonly pending: number;
  /** Of those, the ones that have already failed at least once. */
  readonly retrying: number;
  /** Given up on inside the window. Each one is an alarm nobody received. */
  readonly failed: number;
  /** Thrown away by an activation schedule inside the window (`N-12`). Not a fault. */
  readonly discarded: number;
  readonly oldestPendingAt: Date | null;
  readonly lastDeliveredAt: Date | null;
  /** The most recent failure's reason, which is what an operator actually reads. */
  readonly lastError: string | null;
}

/**
 * How far back the health question is asked.
 *
 * Everything here is bounded by it, `lastDeliveredAt` included — which is deliberate. "Nothing
 * has been delivered in the last hour" is a health answer; "the last delivery was in March" is a
 * history question, and answering it would mean scanning the whole log every time a UI polls.
 */

export type DeliveryStatus = 'ok' | 'warning' | 'down';

export interface DeliveryHealth {
  readonly status: DeliveryStatus;
  /** Why it is not `ok`, in words. Empty when it is. */
  readonly problems: readonly string[];
  readonly pending: number;
  readonly retrying: number;
  readonly failed: number;
  readonly discarded: number;
  readonly oldestPendingAt: Date | null;
  /** How long the oldest undelivered obligation has been waiting. */
  readonly oldestPendingAgeMs: number;
  readonly lastDeliveredAt: Date | null;
  /** How far back `failed` and `discarded` were counted. */
  readonly windowMs: number;
  readonly methods: readonly DeliveryMethodHealth[];
}

export interface DeliveryHealthOptions {
  /** How far back to count failures. */
  windowMs?: number;
  /**
   * How long an attempted-and-still-undelivered message may wait before delivery is Down.
   *
   * Attempted, deliberately: a message queued a second ago has not waited, and a message that
   * has been tried five times over twenty minutes is a relay that is not coming back on its own.
   */
  staleAfterMs?: number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_STALE_MS = 15 * 60 * 1_000;

interface Row {
  method: string;
  pending: string;
  retrying: string;
  failed: string;
  discarded: string;
  oldest_pending: Date | null;
  oldest_retrying: Date | null;
  last_delivered: Date | null;
  last_error: string | null;
}

/**
 * What `WORKFLOW.MD §6` means by "a dead SMTP relay must surface on Core Health".
 *
 * **Read from the table rather than counted in memory.** `DispatchStats` counts what *this
 * process* has done since it started, which is the wrong answer twice over: a core that restarted
 * five minutes ago reports a clean sheet over a queue full of undelivered alarms, and a core that
 * has been up for a month reports failures from three weeks ago. The obligations are rows, so the
 * health of the subsystem is a query.
 *
 * `P-12` is what turns this into channels on the Core Health sensor. It exists now, and is served
 * at `GET /notification-health`, because an operator asking "did my alarm go out" needs an answer
 * before that ticket lands.
 */
export class DeliveryHealthReader {
  readonly #windowMs: number;
  readonly #staleAfterMs: number;

  constructor(options: DeliveryHealthOptions = {}) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  }

  get staleAfterMs(): number {
    return this.#staleAfterMs;
  }

  async read(q: Queryable, now = new Date()): Promise<DeliveryHealth> {
    const since = new Date(now.getTime() - this.#windowMs);
    const rows = await q.query<Row>(
      `
      SELECT coalesce(t.method, '(none)') AS method,
             count(*) FILTER (WHERE r.status = 'pending')::text AS pending,
             count(*) FILTER (WHERE r.status = 'pending' AND r.attempts > 0)::text AS retrying,
             count(*) FILTER (WHERE r.status = 'failed' AND r.at >= $1)::text AS failed,
             count(*) FILTER (WHERE r.status = 'discarded' AND r.at >= $1)::text AS discarded,
             min(r.at) FILTER (WHERE r.status = 'pending') AS oldest_pending,
             -- Attempted and still owed, which is the one that means delivery is broken rather
             -- than merely busy.
             min(r.at) FILTER (WHERE r.status = 'pending' AND r.attempts > 0) AS oldest_retrying,
             max(r.delivered_at) AS last_delivered,
             (array_agg(r.last_error ORDER BY r.id DESC)
                FILTER (WHERE r.last_error IS NOT NULL AND r.status <> 'discarded'))[1]
               AS last_error
      FROM notification_request r
      LEFT JOIN notification_template t ON t.id = r.template_id
      -- Two indexed reaches and nothing else: the partial index on the pending rows, and the
      -- (at, id) range for everything recent. Bounding it is what keeps a health check that a UI
      -- polls from scanning a year of delivered notifications.
      WHERE r.status = 'pending' OR r.at >= $1
      GROUP BY 1
      ORDER BY 1
      `,
      [since],
    );

    const methods: DeliveryMethodHealth[] = rows.map((row) => ({
      method: row.method,
      pending: Number(row.pending),
      retrying: Number(row.retrying),
      failed: Number(row.failed),
      discarded: Number(row.discarded),
      oldestPendingAt: row.oldest_pending,
      lastDeliveredAt: row.last_delivered,
      lastError: row.last_error,
    }));

    const total = (pick: (one: DeliveryMethodHealth) => number): number =>
      methods.reduce((sum, one) => sum + pick(one), 0);
    const oldestPendingAt = earliest(methods.map((one) => one.oldestPendingAt));
    const oldestRetryingAt = earliest(rows.map((row) => row.oldest_retrying));

    const problems: string[] = [];
    let status: DeliveryStatus = 'ok';

    const failed = total((one) => one.failed);
    if (failed > 0) {
      // The failure the whole subsystem exists to prevent: an alarm that was raised and never
      // reached anybody. It is Down whatever else is working.
      status = 'down';
      problems.push(
        `${String(failed)} notification(s) were given up on in the last ` +
          `${String(Math.round(this.#windowMs / 60_000))} minutes`,
      );
    }

    const stalledMs =
      oldestRetryingAt === null ? 0 : Math.max(0, now.getTime() - oldestRetryingAt.getTime());
    if (stalledMs > this.#staleAfterMs) {
      status = 'down';
      problems.push(
        `a notification has been undeliverable for ${String(Math.round(stalledMs / 60_000))} ` +
          'minutes',
      );
    }

    const retrying = total((one) => one.retrying);
    if (status === 'ok' && retrying > 0) {
      status = 'warning';
      problems.push(`${String(retrying)} notification(s) are being retried`);
    }

    for (const method of methods) {
      if (method.failed > 0 && method.lastError !== null) {
        problems.push(`${method.method}: ${method.lastError}`);
      }
    }

    return {
      status,
      problems,
      pending: total((one) => one.pending),
      retrying,
      failed,
      discarded: total((one) => one.discarded),
      oldestPendingAt,
      oldestPendingAgeMs:
        oldestPendingAt === null ? 0 : Math.max(0, now.getTime() - oldestPendingAt.getTime()),
      lastDeliveredAt: latest(methods.map((one) => one.lastDeliveredAt)),
      windowMs: this.#windowMs,
      methods,
    };
  }
}

function earliest(dates: readonly (Date | null)[]): Date | null {
  return dates.reduce<Date | null>(
    (best, one) => (one === null ? best : best === null || one < best ? one : best),
    null,
  );
}

function latest(dates: readonly (Date | null)[]): Date | null {
  return dates.reduce<Date | null>(
    (best, one) => (one === null ? best : best === null || one > best ? one : best),
    null,
  );
}

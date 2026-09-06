import type { Queryable } from '../db/pool.js';

/** What delivery looks like right now, per method and overall (`N-13`). */
export interface DeliveryMethodHealth {
  readonly method: string;
  /** Undelivered obligations this system is actually trying to deliver. */
  readonly pending: number;
  /**
   * Undelivered because an operator said so: collecting into an open digest window, or held by a
   * template's activation schedule (`P-125`).
   *
   * Reported rather than folded into `pending`, and separate rather than omitted: "forty messages
   * are waiting for the eight o'clock digest" is a fact worth showing, and it is not a fault.
   */
  readonly parked: number;
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
  /** Waiting because an operator configured it to: a digest window, or an activation schedule. */
  readonly parked: number;
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
  /**
   * Who knows which templates are outside their activation schedule right now (`R06`).
   *
   * The `TemplateActivation` the dispatcher uses, so health and delivery cannot disagree about
   * which messages are waiting on purpose. Absent in a test that has no schedules to evaluate,
   * and then nothing is parked — which is true, rather than merely convenient.
   */
  activation?: ParkedTemplates;
}

/** The half of `TemplateActivation` this reader needs, named so a test can stub it. */
export interface ParkedTemplates {
  suppressed(q: Queryable, now: Date): Promise<{ readonly templateIds: readonly number[] }>;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_STALE_MS = 15 * 60 * 1_000;

interface Row {
  method: string;
  pending: string;
  parked: string;
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
  readonly #activation: ParkedTemplates | undefined;

  constructor(options: DeliveryHealthOptions = {}) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
    this.#activation = options.activation;
  }

  get staleAfterMs(): number {
    return this.#staleAfterMs;
  }

  /**
   * @param parked Template ids currently outside their activation schedule, whose queued requests
   *   are waiting because an operator said so rather than because anything is broken (`P-125`).
   *
   *   **Defaulted from the activation service rather than from an empty array** (`R06`). It was
   *   an argument with a default of "none", passed by Core Health and not by the route — so the
   *   same fact had two answers depending on which of them you asked, and the one an operator
   *   reads when they want to know whether anything is queued was the wrong one. Still an
   *   argument, because a caller that has already evaluated the schedules this pass should not
   *   pay for it twice.
   */
  async read(q: Queryable, now = new Date(), parked?: readonly number[]): Promise<DeliveryHealth> {
    const held = parked ?? (await this.#activation?.suppressed(q, now))?.templateIds ?? [];
    const since = new Date(now.getTime() - this.#windowMs);
    const rows = await q.query<Row>(
      `
      SELECT coalesce(t.method, '(none)') AS method,
             -- **Waiting on purpose is not waiting** (P-125). A request collecting into an open
             -- digest window, or parked because its template is outside its activation schedule,
             -- is doing exactly what an operator configured. Counting those as pending drove
             -- notifyOldest up all night and put Core Health Down with "check the relay" for a
             -- digest due at eight in the morning.
             count(*) FILTER (WHERE r.status = 'pending' AND NOT deliberate)::text AS pending,
             count(*) FILTER (WHERE r.status = 'pending' AND deliberate)::text AS parked,
             -- **And the same exclusion, because a parked message can have been tried** (P-175).
             -- The deliberate filter was applied to pending and to oldest_pending and to neither
             -- of these, so a request that failed once and was then held by its activation
             -- schedule left pending, arrived in parked -- and went on counting here. retrying
             -- above zero forces warning on its own, and oldest_retrying drives stalledMs and
             -- therefore down: "a notification has been undeliverable for 400 minutes", all
             -- night, about a message an operator told the system to hold until morning. That is
             -- P-125's pathology exactly, surviving in the two columns its fix did not touch.
             count(*) FILTER (WHERE r.status = 'pending' AND r.attempts > 0
                                AND NOT deliberate)::text AS retrying,
             -- **By when they were given up on, not when they fell due** (P-124). settled_at is
             -- the moment the obligation ended; at is when it began, and the default retry policy
             -- puts 45 to 90 minutes between them against a 60 minute window. A notification that
             -- exhausted its retries usually fell outside and counted zero -- and stopped being
             -- pending at the same moment, so this flipped from down back to ok at the exact
             -- instant the alarm was abandoned.
             count(*) FILTER (WHERE r.status = 'failed' AND r.settled_at >= $1)::text AS failed,
             count(*) FILTER (WHERE r.status = 'discarded' AND r.settled_at >= $1)::text
               AS discarded,
             min(r.at) FILTER (WHERE r.status = 'pending' AND NOT deliberate) AS oldest_pending,
             -- Attempted and still owed, which is the one that means delivery is broken rather
             -- than merely busy.
             min(r.at) FILTER (WHERE r.status = 'pending' AND r.attempts > 0
                                 AND NOT deliberate) AS oldest_retrying,
             max(r.delivered_at) AS last_delivered,
             (array_agg(r.last_error ORDER BY r.id DESC)
                FILTER (WHERE r.last_error IS NOT NULL AND r.status <> 'discarded'))[1]
               AS last_error
      FROM (
        SELECT r.*,
               -- Two ways to be waiting because somebody said so: an open digest window, and a
               -- template outside its activation schedule that collects rather than discards.
               (s.id IS NOT NULL AND s.closed_at IS NULL)
                 OR r.template_id = ANY($2::bigint[]) AS deliberate
        FROM notification_request r
        LEFT JOIN notification_summary s ON s.id = r.summary_id
      ) r
      LEFT JOIN notification_template t ON t.id = r.template_id
      -- Two indexed reaches and nothing else: the partial index on the pending rows, and the
      -- settled_at range for everything recent. Bounding it is what keeps a health check that a
      -- UI polls from scanning a year of delivered notifications.
      WHERE r.status = 'pending' OR r.settled_at >= $1
      GROUP BY 1
      ORDER BY 1
      `,
      [since, [...held]],
    );

    const methods: DeliveryMethodHealth[] = rows.map((row) => ({
      method: row.method,
      pending: Number(row.pending),
      parked: Number(row.parked),
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
      parked: total((one) => one.parked),
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

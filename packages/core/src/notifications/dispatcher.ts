import { describeError, type Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { SensorState } from '../state/tables.js';
import type { MessageContextLoader, PendingNotification } from './context.js';
import { render } from './placeholders.js';
import type { StoredTemplate } from './templates.js';
import type { DeliveryResult, DeliveryTransport, OutgoingMessage } from './delivery/transport.js';

export interface NotificationDispatcherOptions {
  db: Database;
  logger: Logger;
  contexts: MessageContextLoader;
  transports: readonly DeliveryTransport[];
  /** How many messages one pass sends. */
  batchSize?: number;
  /**
   * How long to wait before trying a failed delivery again.
   *
   * A flat delay, and `N-13` is where it becomes a backoff. Flat is the honest placeholder: it
   * retries, it does not hammer, and it is one constant rather than a policy pretending to be
   * one.
   */
  retryDelayMs?: number;
  /**
   * How many times a delivery is attempted before it is given up on.
   *
   * `N-13` owns the real policy. This bound exists so a permanently undeliverable message —
   * an address the relay will never accept — cannot occupy the queue for ever.
   */
  maxAttempts?: number;
}

export interface DispatchStats {
  /** Messages that went out. */
  sent: number;
  /** Attempts that failed and will be tried again. */
  deferred: number;
  /** Messages given up on, either permanently rejected or out of attempts. */
  failed: number;
  /**
   * Requests waiting for something other than a retry.
   *
   * A template that is switched off, or one whose delivery method this build has no transport
   * for yet. Neither is an error and neither is progress, and an operator wondering why an
   * alarm never arrived needs to be able to tell them apart from a queue that is simply busy.
   */
  awaiting: number;
}

interface ClaimRow {
  id: string;
  sensor_id: string;
  at: Date;
  state: SensorState;
  message: string;
  observed: number | null;
  attempts: number;
  template_id: string | null;
  t_name: string | null;
  t_method: string | null;
  t_settings: Record<string, unknown> | null;
  t_subject: string | null;
  t_body: string | null;
  t_recipients: StoredTemplate['recipients'] | null;
  t_priority: number | null;
  t_enabled: boolean | null;
}

const DEFAULT_BATCH = 25;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * What turns a queued obligation into a message somebody receives (`N-07`).
 *
 * Four steps, and the order is the design: claim, render, send, record.
 *
 * **Claiming is a short transaction, sending is not.** The alternative — hold a transaction open
 * across the SMTP conversation — puts a relay's timeout in charge of a database connection, and a
 * relay that stops answering would hold a row lock for the length of it. So the claim increments
 * the attempt count and pushes the next attempt into the future *before* anything is sent.
 *
 * **That makes delivery at-least-once, deliberately.** A crash between the send and the record
 * sends the message again after the retry delay. For an alarm system that is the right way round:
 * a duplicate alarm is an annoyance and a lost one is the failure the whole subsystem exists to
 * prevent. The attempt count is on the row, so a duplicate is explainable rather than mysterious.
 */
export class NotificationDispatcher {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #contexts: MessageContextLoader;
  readonly #transports = new Map<string, DeliveryTransport>();
  readonly #batchSize: number;
  readonly #retryDelayMs: number;
  readonly #maxAttempts: number;
  readonly #stats: DispatchStats = { sent: 0, deferred: 0, failed: 0, awaiting: 0 };

  constructor(options: NotificationDispatcherOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'notifications' });
    this.#contexts = options.contexts;
    for (const transport of options.transports) this.#transports.set(transport.method, transport);
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  get stats(): DispatchStats {
    return { ...this.#stats };
  }

  /** The methods this build can actually deliver. `N-08` onwards add to it. */
  get methods(): string[] {
    return [...this.#transports.keys()];
  }

  /**
   * One pass. Returns how many messages it attempted, so a caller that filled a batch can come
   * straight back rather than waiting for the next tick.
   */
  async dispatch(now = new Date()): Promise<number> {
    const claimed = await this.#claim(now);
    if (claimed.length === 0) {
      this.#stats.awaiting = await this.#countAwaiting();
      return 0;
    }

    const contexts = await this.#contexts.loadFor(this.#db, claimed.map(toPending), now);

    for (const row of claimed) {
      const requestId = Number(row.id);
      const context = contexts.get(requestId);
      // The loader builds a context for every notification it is given, including one whose
      // sensor has been deleted. Missing means the row was not in the batch, which cannot happen.
      if (context === undefined) continue;

      const rendered = render({ subject: row.t_subject ?? '', body: row.t_body ?? '' }, context);
      if (rendered.unknown.length > 0) {
        // `N-06` refuses these when a template is saved, so reaching this means a template
        // written by a build that knew a name this one does not. The message still goes — with
        // the token visible, which is what an operator can act on — and the log says why.
        this.#logger.warn(
          { requestId, templateId: row.template_id, unknown: rendered.unknown },
          'a template uses placeholders this build does not know',
        );
      }

      const transport = this.#transports.get(row.t_method ?? '');
      const result =
        transport === undefined
          ? ({
              ok: false,
              retryable: false,
              error: `no transport for delivery method "${String(row.t_method)}"`,
            } as const)
          : await this.#attempt(transport, {
              requestId,
              sensorId: Number(row.sensor_id),
              subject: rendered.subject,
              body: rendered.body,
              recipients: row.t_recipients ?? [],
              priority: row.t_priority ?? 3,
              settings: row.t_settings ?? {},
            });

      await this.#record(requestId, row.attempts + 1, result, now);
    }

    this.#stats.awaiting = await this.#countAwaiting();
    return claimed.length;
  }

  async close(): Promise<void> {
    for (const transport of this.#transports.values()) await transport.close?.();
  }

  /** One send, with anything the transport throws turned into a failure rather than a crash. */
  async #attempt(transport: DeliveryTransport, message: OutgoingMessage): Promise<DeliveryResult> {
    try {
      return await transport.send(message);
    } catch (error: unknown) {
      // A transport that throws rather than returning is a bug in the transport, not a reason
      // to stop the dispatcher: the remaining messages in this batch are unrelated.
      this.#logger.error(
        { err: describeError(error), method: transport.method },
        'a delivery transport threw',
      );
      return { ok: false, retryable: true, error: describeError(error).message };
    }
  }

  /**
   * Takes a batch, marking it attempted before anything is sent.
   *
   * Only requests whose template this build can actually deliver: a method with no transport yet
   * is left alone rather than failed, because `N-08` to `N-10` are days away and marking them
   * undeliverable would throw away real obligations. The same for a template switched off —
   * `CAPABILITIES.MD §5.2`'s activation schedules make "collect and send when reactivated" a
   * first-class choice (`N-12`), and leaving the rows queued is that behaviour arrived at early.
   */
  async #claim(now: Date): Promise<ClaimRow[]> {
    return this.#db.tx(async (q) => {
      const rows = await q.query<ClaimRow>(
        `
        WITH claimed AS (
          SELECT r.id
          FROM notification_request r
          LEFT JOIN notification_template t ON t.id = r.template_id
          WHERE r.status = 'pending'
            AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $1)
            -- A template that is gone, or was never there, is claimed on purpose: it fails with
            -- a reason an operator can act on rather than sitting in the queue for ever.
            AND (t.id IS NULL OR (t.enabled AND t.method = ANY($2::text[])))
          ORDER BY r.next_attempt_at NULLS FIRST, r.id
          LIMIT $3
          FOR UPDATE OF r SKIP LOCKED
        )
        UPDATE notification_request r
        SET attempts = r.attempts + 1, next_attempt_at = $4
        FROM claimed
        WHERE r.id = claimed.id
        RETURNING
          r.id::text AS id, r.sensor_id::text AS sensor_id, r.at, r.state, r.message, r.observed,
          r.attempts - 1 AS attempts, r.template_id::text AS template_id,
          (SELECT name FROM notification_template WHERE id = r.template_id) AS t_name,
          (SELECT method FROM notification_template WHERE id = r.template_id) AS t_method,
          (SELECT settings FROM notification_template WHERE id = r.template_id) AS t_settings,
          (SELECT subject FROM notification_template WHERE id = r.template_id) AS t_subject,
          (SELECT body FROM notification_template WHERE id = r.template_id) AS t_body,
          (SELECT recipients FROM notification_template WHERE id = r.template_id) AS t_recipients,
          (SELECT priority FROM notification_template WHERE id = r.template_id) AS t_priority,
          (SELECT enabled FROM notification_template WHERE id = r.template_id) AS t_enabled
        `,
        [now, this.methods, this.#batchSize, new Date(now.getTime() + this.#retryDelayMs)],
      );
      return rows;
    });
  }

  async #record(
    requestId: number,
    attempts: number,
    result: DeliveryResult,
    now: Date,
  ): Promise<void> {
    if (result.ok) {
      this.#stats.sent += 1;
      await this.#db.query(
        `UPDATE notification_request
         SET status = 'sent', delivered_at = $2, next_attempt_at = NULL, last_error = NULL
         WHERE id = $1`,
        [requestId, now],
      );
      this.#logger.info({ requestId, detail: result.detail }, 'notification delivered');
      return;
    }

    // Out of attempts, or a failure no amount of waiting fixes.
    const givingUp = !result.retryable || attempts >= this.#maxAttempts;
    if (givingUp) this.#stats.failed += 1;
    else this.#stats.deferred += 1;

    await this.#db.query(
      `UPDATE notification_request
       SET status = $3, last_error = $2, next_attempt_at = CASE WHEN $3 = 'failed' THEN NULL
                                                               ELSE next_attempt_at END
       WHERE id = $1`,
      [requestId, result.error, givingUp ? 'failed' : 'pending'],
    );

    // A failed notification is itself an alarm (`WORKFLOW.MD §6`), so it is logged at the level
    // that says so. `N-13` is what puts it on Core Health.
    this.#logger[givingUp ? 'error' : 'warn'](
      { requestId, attempts, retryable: result.retryable },
      givingUp ? 'notification could not be delivered' : 'notification delivery failed; retrying',
    );
  }

  /** Pending requests this pass could not have claimed, and why they are not progress. */
  async #countAwaiting(): Promise<number> {
    const rows = await this.#db.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM notification_request r
       JOIN notification_template t ON t.id = r.template_id
       WHERE r.status = 'pending' AND (NOT t.enabled OR NOT (t.method = ANY($1::text[])))`,
      [this.methods],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

function toPending(row: ClaimRow): PendingNotification {
  return {
    id: Number(row.id),
    sensorId: Number(row.sensor_id),
    at: row.at,
    state: row.state,
    message: row.message,
    observed: row.observed,
  };
}

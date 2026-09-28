import { describeError, type Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { SensorState } from '../state/tables.js';
import { discardReason, TemplateActivation, type Suppression } from './activation.js';
import type { NotificationReason } from './chain.js';
import type { MessageContextLoader, PendingNotification } from './context.js';
import { notificationMethods } from './methods.js';
import { render, substitute, type MessageContext } from './placeholders.js';
import { DEFAULT_RETRY, exhausted, retryDelayMs, type RetryPolicy } from './retry.js';
import { SummaryRepository } from './summaries.js';
import {
  countKinds,
  DEFAULT_SUMMARISATION,
  digestSubject,
  disposition,
  isSummarisationMode,
  kindOf,
  splitDigest,
  summarises,
} from './summarisation.js';
import type { StoredTemplate } from './templates.js';
import type { DeliveryResult, DeliveryTransport, OutgoingMessage } from './delivery/transport.js';

export interface NotificationDispatcherOptions {
  db: Database;
  logger: Logger;
  contexts: MessageContextLoader;
  transports: readonly DeliveryTransport[];
  /** How many messages one pass sends. */
  batchSize?: number;
  /** How a failed delivery backs off before it is tried again (`N-13`). */
  retry?: Partial<RetryPolicy>;
  /**
   * How long a claimed message is left alone before somebody else may try it.
   *
   * A **lease**, not a retry delay, and the distinction is what `N-13` separated. The claim
   * happens before the send and the send happens outside the transaction, so a core that dies
   * mid-conversation leaves a row that looks claimed and is not being worked on. The lease is
   * how long that row waits before another pass picks it up, and it has to be longer than the
   * slowest transport's own timeout — `N-10`'s programs may run for five minutes — or a slow
   * send would be re-sent while it was still in flight.
   */
  leaseMs?: number;
  /** Overrides `retry.maxAttempts`, kept because it reads better at a call site. */
  maxAttempts?: number;
  /** Randomness for the backoff jitter. Swapped in tests. */
  random?: () => number;
  /** How many digests one pass sends. Each is one window, and may be several messages. */
  maxDigests?: number;
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
  /** Notifications folded into a digest rather than sent on their own (`N-11`). */
  held: number;
  /** Digest messages sent, which is not the same as windows: a large one splits. */
  digests: number;
  /** Notifications thrown away because their template was outside its schedule (`N-12`). */
  discarded: number;
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
  reason: NotificationReason;
}

const DEFAULT_BATCH = 25;
const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_MAX_DIGESTS = 5;
const DEFAULT_WINDOW_SECONDS = 900;
/** How many held requests one digest may cover. Above the split cap, so a big storm still splits. */
const MAX_DIGEST_MEMBERS = 500;
/** A window whose contents have all been sent, kept this long so it stays visible in a query. */
const PRUNE_AFTER_MS = 60 * 60 * 1_000;
/** How often the tidying runs. The idle loop ticks every thirty seconds; this need not. */
const PRUNE_EVERY_MS = 10 * 60 * 1_000;

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
  readonly #retry: RetryPolicy;
  readonly #leaseMs: number;
  readonly #random: () => number;
  readonly #maxDigests: number;
  readonly #summaries = new SummaryRepository();
  readonly #activation = new TemplateActivation();
  #prunedAt = 0;
  readonly #stats: DispatchStats = {
    sent: 0,
    deferred: 0,
    failed: 0,
    awaiting: 0,
    held: 0,
    digests: 0,
    discarded: 0,
  };

  constructor(options: NotificationDispatcherOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'notifications' });
    this.#contexts = options.contexts;
    for (const transport of options.transports) this.#transports.set(transport.method, transport);
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.#retry = {
      ...DEFAULT_RETRY,
      ...options.retry,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    };
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#random = options.random ?? Math.random;
    this.#maxDigests = options.maxDigests ?? DEFAULT_MAX_DIGESTS;
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
    // What the clock has switched off (`N-12`). First, because a template outside its schedule
    // either owes nothing at all or owes it later, and both answers change what the rest of this
    // pass may touch.
    const suppressed = await this.#activation.suppressed(this.#db, now);
    for (const template of suppressed.discarded) await this.#discard(template, now);

    // Before anything is claimed, because the decision is what says which requests are claimable
    // at all. A request folded into a digest is not owed as a message of its own.
    await this.#decide(now, suppressed.templateIds);
    await this.#db.tx((q) => this.#summaries.closeDue(q, now));
    const digested = await this.#digests(now, suppressed.templateIds);

    const claimed = await this.#claim(now, suppressed.templateIds);
    if (claimed.length === 0) {
      this.#stats.awaiting = await this.#countAwaiting();
      // Idle is when there is time for housekeeping. A window that released its first Down and
      // then saw nothing else closes empty, which is the common case for a template that
      // notifies about one sensor at a time. Rarely, though: the idle loop ticks every thirty
      // seconds and a `NOT EXISTS` sweep does not need to run that often.
      if (now.getTime() - this.#prunedAt >= PRUNE_EVERY_MS) {
        this.#prunedAt = now.getTime();
        await this.#summaries.prune(this.#db, new Date(now.getTime() - PRUNE_AFTER_MS));
      }
      return digested;
    }

    const contexts = await this.#contexts.loadFor(this.#db, claimed.map(toPending), now);

    for (const row of claimed) {
      const requestId = Number(row.id);
      const context = contexts.get(requestId);
      // The loader builds a context for every notification it is given, including one whose
      // sensor has been deleted. Missing means the row was not in the batch, which cannot happen.
      if (context === undefined) continue;

      const transport = this.#transports.get(row.t_method ?? '');
      const settings = row.t_settings ?? {};
      // Asked before rendering, because escaping is part of substitution: only substitution
      // knows which characters came from a value and which the operator typed as syntax.
      const escaping = transport?.bodyEscaping?.(settings) ?? 'none';
      const rendered = render(
        { subject: row.t_subject ?? '', body: row.t_body ?? '' },
        context,
        escaping,
      );
      if (rendered.unknown.length > 0) {
        // `N-06` refuses these when a template is saved, so reaching this means a template
        // written by a build that knew a name this one does not. The message still goes — with
        // the token visible, which is what an operator can act on — and the log says why.
        this.#logger.warn(
          { requestId, templateId: row.template_id, unknown: rendered.unknown },
          'a template uses placeholders this build does not know',
        );
      }

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
              about: [Number(row.sensor_id)],
              priority: row.t_priority ?? 3,
              settings,
              context,
            });

      await this.#record(requestId, row.attempts + 1, result, now);
    }

    this.#stats.awaiting = await this.#countAwaiting();
    return claimed.length + digested;
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

  /** What is owed as a message of its own. */
  async #claim(now: Date, suppressed: readonly number[]): Promise<ClaimRow[]> {
    // Only what is owed as a message of its own. A held request belongs to a digest, and one
    // whose window has been deleted belongs to nobody — so it is sent rather than lost.
    return this.#claimWhere(
      now,
      suppressed,
      `(r.disposition = 'immediate' OR (r.disposition = 'held' AND r.summary_id IS NULL))`,
      [],
    );
  }

  /** Everything a closed window is still holding, claimed together as one digest. */
  async #claimMembers(
    windowId: number,
    now: Date,
    suppressed: readonly number[],
  ): Promise<ClaimRow[]> {
    return this.#claimWhere(now, suppressed, `r.summary_id = $6`, [windowId], MAX_DIGEST_MEMBERS);
  }

  /**
   * Takes a batch, marking it attempted before anything is sent.
   *
   * Only requests whose template this build can actually deliver: a method with no transport is
   * left alone rather than failed. The same for a template switched off — `CAPABILITIES.MD §5.2`'s
   * activation schedules make "collect and send when reactivated" a first-class choice (`N-12`),
   * and leaving the rows queued is that behaviour arrived at early.
   */
  async #claimWhere(
    now: Date,
    suppressed: readonly number[],
    predicate: string,
    extra: readonly unknown[],
    limit = this.#batchSize,
  ): Promise<ClaimRow[]> {
    return this.#db.tx(async (q) => {
      const rows = await q.query<ClaimRow>(
        `
        WITH claimed AS (
          SELECT r.id
          FROM notification_request r
          LEFT JOIN notification_template t ON t.id = r.template_id
          WHERE r.status = 'pending'
            AND ${predicate}
            AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $1)
            -- A template that is gone, or was never there, is claimed on purpose: it fails with
            -- a reason an operator can act on rather than sitting in the queue for ever.
            AND (t.id IS NULL OR (t.enabled AND t.method = ANY($2::text[])))
            -- Outside its activation schedule and set to collect rather than discard (N-12).
            -- Left pending on purpose: this is "send it when I am back", not a failure.
            AND NOT (r.template_id = ANY($5::bigint[]))
          ORDER BY r.next_attempt_at NULLS FIRST, r.id
          LIMIT $3
          FOR UPDATE OF r SKIP LOCKED
        )
        UPDATE notification_request r
        -- A lease, not a retry delay: this is how long the row waits if this process dies
        -- between the claim and the record. The real backoff is written by #record.
        SET attempts = r.attempts + 1, next_attempt_at = $4
        FROM claimed
        WHERE r.id = claimed.id
        RETURNING
          r.id::text AS id, r.sensor_id::text AS sensor_id, r.at, r.state, r.message, r.observed,
          r.reason, r.attempts - 1 AS attempts, r.template_id::text AS template_id,
          (SELECT name FROM notification_template WHERE id = r.template_id) AS t_name,
          (SELECT method FROM notification_template WHERE id = r.template_id) AS t_method,
          (SELECT settings FROM notification_template WHERE id = r.template_id) AS t_settings,
          (SELECT subject FROM notification_template WHERE id = r.template_id) AS t_subject,
          (SELECT body FROM notification_template WHERE id = r.template_id) AS t_body,
          (SELECT recipients FROM notification_template WHERE id = r.template_id) AS t_recipients,
          (SELECT priority FROM notification_template WHERE id = r.template_id) AS t_priority,
          (SELECT enabled FROM notification_template WHERE id = r.template_id) AS t_enabled
        `,
        [
          now,
          this.methods,
          limit,
          new Date(now.getTime() + this.#leaseMs),
          [...suppressed],
          ...extra,
        ],
      );
      return rows;
    });
  }

  // -----------------------------------------------------------------------------------------
  // Summarisation (`N-11`).
  // -----------------------------------------------------------------------------------------

  /**
   * Decides, once, whether each newly queued notification is a message or part of a digest.
   *
   * Once, and recorded, because "the first Down of the window goes immediately" is not a property
   * of the request: it depends on what the window has already released. Deciding again on a
   * retry would move a failed immediate message into a digest and quietly change what the
   * operator was promised.
   */
  async #decide(now: Date, suppressed: readonly number[]): Promise<number> {
    return this.#db.tx(async (q) => {
      // A suppressed template's requests are left undecided rather than being folded into a
      // window that would open and close while nobody is listening. When the schedule reopens
      // the whole backlog is decided together, which is what makes "collect and send when
      // reactivated" arrive as one message and one digest rather than as a stale digest.
      const pending = await this.#summaries.undecided(q, this.#batchSize * 4, suppressed);
      let held = 0;
      for (const request of pending) {
        const mode = isSummarisationMode(request.summarisation)
          ? request.summarisation
          : DEFAULT_SUMMARISATION;
        // Slack, Teams, HTTP action and execute program are never summarised
        // (`CAPABILITIES.MD §5.2`): they are cheap and usually machine-consumed, and a digest
        // posted to a channel is worse than the messages it replaced.
        const summarisable =
          request.method !== null &&
          notificationMethods.ids.includes(request.method) &&
          notificationMethods.get(request.method).summarisable;

        if (!summarisable || !summarises(mode) || request.templateId === null) {
          await this.#summaries.decide(q, request.id, 'immediate', null);
          continue;
        }

        const window = await this.#summaries.openWindow(
          q,
          request.templateId,
          now,
          request.windowSeconds ?? DEFAULT_WINDOW_SECONDS,
        );
        const kind = kindOf(request);
        if (disposition(mode, kind, window.released) === 'immediate') {
          // Recorded before the message goes, so the *second* Down of a storm is held even if
          // the first one is still being delivered.
          await this.#summaries.release(q, window.id, kind);
          await this.#summaries.decide(q, request.id, 'immediate', null);
          continue;
        }
        await this.#summaries.decide(q, request.id, 'held', window.id);
        held += 1;
      }
      this.#stats.held += held;
      return held;
    });
  }

  /** Sends what the closed windows are holding. Returns how many requests it covered. */
  async #digests(now: Date, suppressed: readonly number[]): Promise<number> {
    const owing = await this.#db.tx((q) =>
      this.#summaries.owing(q, now, this.#maxDigests, suppressed, this.methods),
    );
    let covered = 0;
    for (const window of owing) {
      const members = await this.#claimMembers(window.id, now, suppressed);
      if (members.length === 0) continue;
      covered += await this.#sendDigest(members, now);
    }
    return covered;
  }

  /**
   * Throws away everything a template outside its schedule owes (`N-12`).
   *
   * **`discarded`, not `failed`.** Nobody was meant to receive it, so nothing went wrong —
   * counting it as a failure would put it on `N-13`'s Core Health failure count and send an
   * operator looking for a relay problem that does not exist. It is not `sent` either, because
   * nobody got it. The row says which schedule suppressed it and when that schedule reopens, so
   * "why did I not hear about this" has an answer.
   */
  async #discard(template: Suppression, now: Date): Promise<void> {
    const rows = await this.#db.query<{ id: string }>(
      `UPDATE notification_request
       SET status = 'discarded', next_attempt_at = NULL, last_error = $2, delivered_at = NULL,
           settled_at = now()
       WHERE status = 'pending' AND template_id = $1
       RETURNING id::text AS id`,
      [template.templateId, discardReason(template)],
    );
    if (rows.length === 0) return;
    this.#stats.discarded += rows.length;
    this.#logger.info(
      {
        templateId: template.templateId,
        scheduleId: template.scheduleId,
        discarded: rows.length,
        activeAt: template.activeAt,
        at: now,
      },
      'notifications discarded: the template is outside its activation schedule',
    );
  }

  /**
   * One window's worth of notifications, as one message — or as several, when it is too big.
   *
   * **The lines are the operator's own subject line, rendered per notification.** A digest cannot
   * use their subject as its subject: "%sensor on %device is %status" says nothing useful about
   * twelve sensors. But throwing their wording away and inventing our own would produce a digest
   * that reads nothing like the messages it replaced, so the subject becomes the line and the
   * digest's own subject is generated.
   */
  async #sendDigest(members: readonly ClaimRow[], now: Date): Promise<number> {
    const contexts = await this.#contexts.loadFor(this.#db, members.map(toPending), now);
    const [first] = members;
    if (first === undefined) return 0;

    const transport = this.#transports.get(first.t_method ?? '');
    const settings = first.t_settings ?? {};
    const escaping = transport?.bodyEscaping?.(settings) ?? 'none';

    const entries: { member: { row: ClaimRow; context: MessageContext }; line: string }[] = [];
    for (const row of members) {
      const context = contexts.get(Number(row.id));
      if (context === undefined) continue;
      entries.push({
        member: { row, context },
        line: substitute(row.t_subject ?? '', context, escaping).text,
      });
    }

    const parts = splitDigest(entries);
    let covered = 0;
    for (const [index, part] of parts.entries()) {
      const [lead] = part.members;
      if (lead === undefined) continue;
      const counts = countKinds(part.members.map((entry) => kindOf(entry.row)));
      const subject = digestSubject({
        siteName: lead.context.siteName,
        counts,
        total: part.members.length,
        part: index + 1,
        parts: parts.length,
      });

      const result =
        transport === undefined
          ? ({
              ok: false,
              retryable: false,
              error: `no transport for delivery method "${String(first.t_method)}"`,
            } as const)
          : await this.#attempt(transport, {
              requestId: Number(lead.row.id),
              sensorId: Number(lead.row.sensor_id),
              subject,
              body: part.lines.join('\n'),
              recipients: first.t_recipients ?? [],
              // Every sensor the digest lists: somebody who may not read one of them is not sent
              // a message naming it (`M-19`).
              about: part.members.map((entry) => Number(entry.row.sensor_id)),
              priority: first.t_priority ?? 3,
              settings,
              // One message about many sensors, so there is no single context that is *the*
              // context. The first member's is what a transport that wants one gets, and it is
              // the right one for the facts a digest actually uses — the site name and nothing
              // sensor-specific.
              context: lead.context,
            });

      if (result.ok) this.#stats.digests += 1;
      // **One backoff for the whole part, not one per member** (`P-123`). `#record` draws a
      // jittered delay of its own, so a digest of forty requests that failed came back due at
      // forty different moments — and the next pass claimed whichever handful had ripened,
      // assembled them into their own digest, and labelled it "part 1 of 1". One outage arrived
      // as half a dozen fragments, in an order the jitter chose, each claiming to be complete.
      const delayMs =
        result.ok || !result.retryable
          ? 0
          : retryDelayMs(this.#retry, lead.row.attempts + 1, this.#random);
      for (const entry of part.members) {
        await this.#record(Number(entry.row.id), entry.row.attempts + 1, result, now, delayMs);
        covered += 1;
      }
    }
    return covered;
  }

  async #record(
    requestId: number,
    attempts: number,
    result: DeliveryResult,
    now: Date,
    /**
     * The delay to use instead of drawing one, so every member of a digest waits the same time
     * (`P-123`). Ignored when the request is being given up on.
     */
    sharedDelayMs?: number,
  ): Promise<void> {
    if (result.ok) {
      this.#stats.sent += 1;
      await this.#db.query(
        `UPDATE notification_request
         SET status = 'sent', delivered_at = $2, settled_at = $2, next_attempt_at = NULL,
             last_error = NULL, skipped_recipients = $3
         WHERE id = $1`,
        [requestId, now, (result.skipped ?? '').slice(0, 2_000)],
      );
      this.#logger.info(
        {
          requestId,
          detail: result.detail,
          ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
        },
        'notification delivered',
      );
      return;
    }

    // Out of attempts, or a failure no amount of waiting fixes.
    const givingUp = !result.retryable || exhausted(this.#retry, attempts);
    if (givingUp) this.#stats.failed += 1;
    else this.#stats.deferred += 1;

    // The backoff is written here rather than at claim time, because only here is the attempt
    // count that shapes it known to have been used. The claim wrote a lease; this replaces it.
    const delayMs = givingUp
      ? 0
      : (sharedDelayMs ?? retryDelayMs(this.#retry, attempts, this.#random));
    await this.#db.query(
      `UPDATE notification_request
       SET status = $3, last_error = $2, next_attempt_at = $4,
           -- When it stopped being owed, which is not when it fell due (P-124). Null while it is
           -- still pending: a row waiting for its next attempt has not settled.
           settled_at = CASE WHEN $3 = 'pending' THEN NULL ELSE $5::timestamptz END
       WHERE id = $1`,
      [
        requestId,
        result.error,
        givingUp ? 'failed' : 'pending',
        givingUp ? null : new Date(now.getTime() + delayMs),
        now,
      ],
    );

    // A failed notification is itself an alarm (`WORKFLOW.MD §6`), so it is logged at the level
    // that says so, with everything an operator needs to act without opening the database.
    if (givingUp) {
      this.#logger.error(
        { requestId, attempts, retryable: result.retryable, err: result.error },
        'notification could not be delivered and will not be tried again',
      );
      return;
    }
    this.#logger.warn(
      { requestId, attempts, retryInMs: delayMs, err: result.error },
      'notification delivery failed; retrying',
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

import { describeError, type Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { AlarmEngine } from './engine.js';

export interface AlarmSchedulerOptions {
  db: Database;
  engine: AlarmEngine;
  logger: Logger;
  /**
   * Longest the scheduler will sleep, however far away the next due time is.
   *
   * The safety net, not the schedule. Promptness comes from sleeping until the next due time and
   * from `wake()`; this bound is what makes a *missed* wake cost a minute rather than a night. A
   * wait that can only ever be ended by a poke is a wait that one lost poke turns into silence,
   * and the failure mode of a notification system that goes quiet is that nobody notices.
   *
   * It is also what absorbs a clock jump. Due times are wall-clock (`timestamptz`) because they
   * are data; the sleep is a monotonic timer because it is scheduling (`CLAUDE.md`). If the wall
   * clock moves under us, the delay computed before the jump is wrong — and capping it means
   * wrong by at most this, after which the next wake re-reads both and corrects itself.
   */
  maxSleepMs?: number;
  /**
   * Shortest sleep between sweeps.
   *
   * Stops a due time in the past from becoming a busy loop: an alarm whose sweep cannot clear it
   * — a template that fails to resolve, a bounded batch — would otherwise be re-queried as fast
   * as the event loop allows.
   */
  minSleepMs?: number;
  /** How many full batches one wake drains before sleeping again. */
  maxRounds?: number;
  /** Monotonic milliseconds, which `overdueMs` is measured on. Injectable for a test. */
  monotonicNow?: () => number;
  /**
   * How long after a wake that found nothing to look again, in order.
   *
   * `wake()` fires *inside* the transaction that armed the alarm, before its commit — so a
   * scheduler that believed an empty sweep would go back to sleep for the full cap having
   * queried a moment too early. The alarm is committed a few milliseconds later and nothing is
   * left to notice it. That is not a hypothetical: it cost a 20-second test timeout before it
   * was understood, and in production it would have been a notification that arrived a minute
   * late for no visible reason.
   *
   * So a wake that finds nothing is re-checked rather than believed. Two attempts, the second
   * generous enough for a commit under load; a genuinely spurious wake — a batch that rolled
   * back — costs two extra indexed queries and nothing else.
   */
  settleMs?: readonly number[];
}

/** What the scheduler has been doing. `P-12` puts these on Core Health. */
export interface AlarmSchedulerStats {
  /** Sweeps run, whether or not they found anything. */
  sweeps: number;
  /** Notification steps fired. */
  fired: number;
  /** Times `wake()` was called. */
  wakes: number;
  /**
   * Wakes that found nothing due.
   *
   * Expected and harmless — see `wake()` — but worth counting: a ratio that climbs means
   * something is poking far more often than it arms anything.
   */
  idleWakes: number;
  /** When the scheduler intends to run next, or null when it is not running. For display. */
  nextWakeAt: Date | null;
  /**
   * How far past its wake the timer is, in milliseconds on the monotonic clock: 0 while the
   * wake is still ahead or nothing is armed (`P-247`).
   *
   * **The same clock as the timer, which is the point.** Worked out as the wall clock less
   * `nextWakeAt`, a forward step of the wall clock read as a sweep that had not run: an hour's
   * step was an hour overdue on Core Health, Down, and "escalations are not firing", about a timer
   * that fired on time a few seconds later.
   */
  overdueMs: number;
}

const DEFAULT_MAX_SLEEP_MS = 60_000;
const DEFAULT_MIN_SLEEP_MS = 25;
const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_SETTLE_MS: readonly number[] = [250, 1_000];

/**
 * The latency timer engine (`N-04`).
 *
 * **There are no timers, and that is the design.** The obvious reading of the ticket is a
 * `setTimeout` per pending notification, cancelled on recovery and on acknowledgement. Five
 * thousand sensors with an initial, an escalation and a repeat apiece is fifteen thousand live
 * timers; every one of them is a closure holding a sensor id, every cancellation is a chance to
 * leak one, and a restart drops the lot. `N-02` put the due time in a row instead, so the
 * cancellations the ticket asks for are `DELETE`s and `UPDATE`s that already happen for other
 * reasons — an alarm that recovers is removed, an acknowledged one has its `next_due_at` set to
 * null — and "no leaks across thousands of sensors" is structural rather than a promise. What is
 * left for this class is one timer: the one that decides when to look.
 *
 * **It sleeps until the next due time**, which it asks the database for. `N-02` shipped a tick a
 * second in its place, which was correct and wasteful: an installation with nothing pending paid
 * an indexed query every second for ever, and a due alarm still waited up to a second. Now an
 * idle installation pays one query a minute and a due alarm fires within milliseconds.
 *
 * Three things end a sleep: the due time arriving, `wake()`, and the cap.
 */
export class AlarmScheduler {
  readonly #db: Database;
  readonly #engine: AlarmEngine;
  readonly #logger: Logger;
  readonly #maxSleepMs: number;
  readonly #minSleepMs: number;
  readonly #maxRounds: number;
  readonly #settleMs: readonly number[];
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  /**
   * Whether `start` has been called.
   *
   * `wake()` is a no-op until it has. A scheduler nobody started sweeping because something
   * poked it would be a second scheduler nobody knew was running — which is exactly what a test
   * that builds two of them, or a process that has not finished starting up, would get.
   */
  #started = false;
  /** Set while a sweep is in flight, so a `wake()` during one is honoured after it. */
  #woken = false;
  /**
   * How many re-checks this wake has left.
   *
   * Set by `wake()`, spent by empty sweeps, and reset the moment one fires something. See
   * `settleMs`: the wake arrives before the commit it is about.
   */
  #settling = 0;
  #nextWakeAt: Date | null = null;
  /** The armed wake on `#monotonicNow`'s clock, or null. */
  #wakeDeadline: number | null = null;
  readonly #monotonicNow: () => number;
  #sweeps = 0;
  #fired = 0;
  #wakes = 0;
  #idleWakes = 0;

  constructor(options: AlarmSchedulerOptions) {
    this.#db = options.db;
    this.#engine = options.engine;
    this.#logger = options.logger.child({ component: 'alarm-scheduler' });
    this.#maxSleepMs = options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
    this.#minSleepMs = options.minSleepMs ?? DEFAULT_MIN_SLEEP_MS;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#monotonicNow = options.monotonicNow ?? ((): number => performance.now());
  }

  get stats(): AlarmSchedulerStats {
    return {
      sweeps: this.#sweeps,
      fired: this.#fired,
      wakes: this.#wakes,
      idleWakes: this.#idleWakes,
      nextWakeAt: this.#nextWakeAt,
      overdueMs:
        this.#wakeDeadline === null ? 0 : Math.max(0, this.#monotonicNow() - this.#wakeDeadline),
    };
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#started = true;
    this.#arm(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#nextWakeAt = null;
    this.#wakeDeadline = null;
  }

  /**
   * Something may now be due sooner than the scheduler is sleeping for.
   *
   * Called by the engine whenever it arms an alarm. **Deliberately allowed to be spurious**: it
   * fires inside the arming transaction, before the commit that may never happen, so a rolled
   * back batch pokes a scheduler that then finds nothing. That costs one indexed query and is
   * the right trade — the alternative is threading an after-commit hook through every path that
   * can arm an alarm, which is the ingestion write, `reevaluate`, and every audited mutation,
   * and forgetting one of them means a notification that waits a minute for no reason.
   *
   * Cheap and idempotent: several wakes before the sweep runs are one sweep.
   */
  wake(): void {
    this.#wakes += 1;
    this.#settling = this.#settleMs.length;
    if (this.#stopped || !this.#started) return;
    if (this.#running) {
      // A sweep is in flight and may have already read past whatever this is about. Remember it
      // rather than re-entering, and go round again when the current one finishes.
      this.#woken = true;
      return;
    }
    this.#arm(0);
  }

  /**
   * One pass: fire everything due, then work out when to come back.
   *
   * Never throws. A scheduler that died would take every future notification with it, and the
   * failure that killed it would be the one nobody heard about.
   *
   * Returns how many steps it fired, for tests and for the stats.
   */
  async sweep(now = new Date()): Promise<number> {
    // A stopped scheduler fires nothing. Without this a timer that had already fired when
    // `stop()` was called goes on to sweep afterwards — which during shutdown means sending a
    // notification the process is in the middle of abandoning, and in a test means one instance
    // quietly doing another instance's work.
    if (this.#stopped || this.#running) return 0;
    this.#running = true;
    this.#sweeps += 1;
    try {
      let fired = 0;
      // Repeats while the sweep comes back full: a core that was down through an outage has a
      // backlog, and dribbling it out one bounded batch per wake would take longer than the
      // outage did. Bounded, so a bug that keeps returning full batches cannot spin.
      for (let round = 0; round < this.#maxRounds; round += 1) {
        const result = await this.#db.tx((q) => this.#engine.sweep(q, now));
        fired += result.fired;
        // **Counted as each round commits, not once the loop ends** (`P-20`). The requests are
        // committed inside that transaction, so between the commit and the end of the loop the
        // rows exist and the counter describing them says zero — and the loop only continues
        // when a round came back *full*, which is precisely the backlog where the gap is widest
        // and Core Health is most worth reading. A counter that lags what it counts is a counter
        // that reports quiet at the busiest moment there is.
        this.#fired += result.fired;
        if (result.fired === 0) break;
      }
      if (fired === 0) this.#idleWakes += 1;
      return fired;
    } catch (error: unknown) {
      this.#logger.error({ err: describeError(error) }, 'the alarm sweep failed; retrying');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  /**
   * How long to sleep after a sweep at `now`.
   *
   * Public and pure so the arithmetic can be tested without waiting for any of it — a scheduler
   * whose only observable behaviour is "eventually" is a scheduler nobody can characterise.
   */
  delayFor(nextDueAt: Date | null, now: Date): number {
    if (nextDueAt === null) return this.#maxSleepMs;
    const until = nextDueAt.getTime() - now.getTime();
    if (until <= this.#minSleepMs) return this.#minSleepMs;
    return Math.min(until, this.#maxSleepMs);
  }

  /** One sweep, then re-arm. Split out so `start` and the timer share it exactly. */
  async #cycle(): Promise<void> {
    const now = new Date();
    const fired = await this.sweep(now);
    if (this.#stopped) return;

    if (this.#woken) {
      // Somebody armed an alarm while the sweep was reading. Go straight round again rather than
      // sleeping on a due time computed before it existed.
      this.#woken = false;
      this.#arm(0);
      return;
    }

    if (fired > 0) this.#settling = 0;

    let delay = this.#maxSleepMs;
    try {
      delay = this.delayFor(await this.#engine.nextDueAt(this.#db), new Date());
    } catch (error: unknown) {
      // The database is unreachable. Sleeping the cap is right: it retries, it does not spin,
      // and everything due is still due when it comes back.
      this.#logger.error({ err: describeError(error) }, 'could not read the next due time');
    }

    // A wake that found nothing may simply have been early — see `settleMs`. Look again soon
    // rather than sleeping on an answer read before the transaction that prompted it committed.
    if (this.#settling > 0) {
      const attempt = this.#settleMs[this.#settleMs.length - this.#settling] ?? 0;
      this.#settling -= 1;
      delay = Math.min(delay, attempt);
    }
    this.#arm(delay);
  }

  #arm(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#nextWakeAt = new Date(Date.now() + delayMs);
    this.#wakeDeadline = this.#monotonicNow() + delayMs;
    this.#timer = setTimeout(() => {
      void this.#cycle();
    }, delayMs);
    // Never a reason to hold the process open: an alarm that has not fired yet is still due
    // after a restart, because the due time is in the database and not in this timer.
    this.#timer.unref();
  }
}

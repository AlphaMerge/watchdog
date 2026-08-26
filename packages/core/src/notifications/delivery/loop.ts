import { describeError, type Logger } from '@ms/shared';
import type { NotificationDispatcher } from '../dispatcher.js';

export interface DeliveryLoopOptions {
  dispatcher: NotificationDispatcher;
  logger: Logger;
  /**
   * Longest to sleep with nothing queued.
   *
   * The heartbeat, not the schedule: promptness comes from `wake()`, and this is what makes a
   * missed wake cost half a minute rather than a night.
   */
  idleMs?: number;
  /** How long to wait after a pass that filled its batch, before draining the next one. */
  busyMs?: number;
  /** How many full batches one wake drains. */
  maxRounds?: number;
}

const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_BUSY_MS = 50;
const DEFAULT_MAX_ROUNDS = 20;

/**
 * What drives delivery (`N-07`).
 *
 * **Not `AlarmScheduler`, and the difference is real.** That one sleeps until a due time it can
 * read from a table and runs its sweep *inside* a transaction, which is exactly right for
 * advancing an alarm chain and exactly wrong here: delivery has no due times of its own — a
 * notification becomes deliverable the moment something queues it — and an SMTP conversation
 * inside a transaction would put a relay's timeout in charge of a database connection. Sharing
 * the class would have meant contorting both.
 *
 * What it does share is the shape that made `N-04` work: sleep long, be woken, and treat the
 * sleep as a safety net rather than a schedule.
 */
export class DeliveryLoop {
  readonly #dispatcher: NotificationDispatcher;
  readonly #logger: Logger;
  readonly #idleMs: number;
  readonly #busyMs: number;
  readonly #maxRounds: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  #started = false;
  #woken = false;
  #wakes = 0;

  constructor(options: DeliveryLoopOptions) {
    this.#dispatcher = options.dispatcher;
    this.#logger = options.logger.child({ component: 'delivery' });
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#busyMs = options.busyMs ?? DEFAULT_BUSY_MS;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  }

  get wakes(): number {
    return this.#wakes;
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
  }

  /**
   * Something has been queued.
   *
   * Called by the alarm engine when it writes a notification request — inside that transaction,
   * before its commit, so a pass prompted by it can legitimately find nothing. That costs one
   * indexed query on a partial index; the alternative is an after-commit hook threaded through
   * every path that can queue, and a notification that waits half a minute for no reason.
   */
  wake(): void {
    this.#wakes += 1;
    if (this.#stopped || !this.#started) return;
    if (this.#running) {
      this.#woken = true;
      return;
    }
    // Not zero: the wake arrives before the commit it is about, and a pass that ran in the same
    // millisecond would read an empty queue and go back to sleep. `busyMs` is long enough for
    // the transaction to land and short enough that nobody notices.
    this.#arm(this.#busyMs);
  }

  /** One pass, draining while batches come back full. Never throws. */
  async run(now = new Date()): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      let attempted = 0;
      for (let round = 0; round < this.#maxRounds; round += 1) {
        const count = await this.#dispatcher.dispatch(now);
        attempted += count;
        if (count === 0) break;
      }
      return attempted;
    } catch (error: unknown) {
      // A loop that died would take every future notification with it, and the failure that
      // killed it would be the one nobody heard about.
      this.#logger.error({ err: describeError(error) }, 'the delivery pass failed; retrying');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  async #cycle(): Promise<void> {
    const attempted = await this.run();
    if (this.#stopped) return;
    if (this.#woken) {
      this.#woken = false;
      this.#arm(this.#busyMs);
      return;
    }
    this.#arm(attempted > 0 ? this.#busyMs : this.#idleMs);
  }

  #arm(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#cycle();
    }, delayMs);
    // Never a reason to hold the process open: a queued notification is still queued after a
    // restart, because it is a row and not a timer.
    this.#timer.unref();
  }
}

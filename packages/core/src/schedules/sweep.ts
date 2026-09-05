import { describeError, type Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { SchedulePauses } from './pauses.js';

export interface ScheduleSweepOptions {
  db: Database;
  pauses: SchedulePauses;
  /**
   * Settles `paused_by_dependency` after a window has moved (`P-136`).
   *
   * **Required, and it closes the last way into `P-87`'s failure.** A master pausing because its
   * schedule closed is switched off rather than Down (`docs/state-machine.md` §3), so anything
   * it was holding must be released — and the sweep is the one path that moves a window without
   * a mutation to reach `DependencySync` through. The dependents kept the flag, dropped out of
   * the probe configuration, and were never scanned again; the pause API, computing what holds
   * them from the master's current state, said nothing did and refused to resume them.
   */
  dependencies: DependencySettler;
  logger: Logger;
  /** Poked after a sweep that moved something, so probes learn within the same second. */
  onChanged?: () => void;
  /** Override for tests. Production sweeps on the wall-clock minute and should not be told to. */
  intervalMs?: number;
}

/** Just enough of `DependencyPauses` to settle the flags after a window has moved. */
export interface DependencySettler {
  recompute(q: Queryable, at: Date): Promise<{ moved: number }>;
}

/** Sixty seconds: schedules have minute resolution, so nothing finer can be observed. */
const MINUTE = 60_000;

/**
 * Notices when a schedule's window opens or closes (`M-09`).
 *
 * **On the wall-clock minute, not on a computed deadline.** Working out the next boundary and
 * sleeping until it is exact right up to the moment a country changes its clocks, at which
 * point the deadline computed an hour ago is an hour wrong — and the transitions that matter
 * most are the ones nobody is awake for. Aligning to the minute costs one query a minute in an
 * installation with schedules, none at all in one without (the recompute's first statement is a
 * `LIMIT 1` that returns nothing), and it cannot drift: every tick re-reads the clock, so a
 * jump forwards is absorbed at the next tick and a jump backwards simply recomputes a state
 * that is already correct.
 *
 * A schedule boundary is not a configuration change, so this writes no audit entry — but it
 * does change what the probes should be scanning, and the fingerprint they compare is derived
 * from the assignment list that `paused_by_schedule` filters. Hence `onChanged`: the sweep
 * pokes the notifier, which recomputes and pushes only to the probes whose configuration
 * actually moved.
 */
export class ScheduleSweep {
  readonly #db: Database;
  readonly #pauses: SchedulePauses;
  readonly #dependencies: DependencySettler;
  readonly #logger: Logger;
  readonly #onChanged: (() => void) | undefined;
  readonly #intervalMs: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;

  constructor(options: ScheduleSweepOptions) {
    this.#db = options.db;
    this.#pauses = options.pauses;
    this.#dependencies = options.dependencies;
    this.#logger = options.logger.child({ component: 'schedule-sweep' });
    this.#onChanged = options.onChanged;
    this.#intervalMs = options.intervalMs;
  }

  /**
   * Sweeps once, now, and then on every wall-clock minute.
   *
   * **The immediate one is not a nicety** (`P-131`). `paused_by_schedule` is a stored flag, and
   * the probes' configuration is built from it — so a core that was down when a window closed
   * came back with every flag as it was before the boundary and handed the probes a list that
   * said to keep scanning. Waiting for the top of the next minute meant up to sixty seconds of
   * checks inside a window an operator had closed, on every restart, and the whole point of a
   * maintenance window is that nothing scans during it.
   *
   * Awaited, so a caller can order it before anything is served. Production does.
   */
  async start(): Promise<void> {
    if (this.#timer !== undefined || this.#stopped) return;
    await this.sweep();
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One pass. Never throws: a sweep that dies takes every future window with it. */
  async sweep(now = new Date()): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const result = await this.#db.tx(async (q) => {
        const moved = await this.#pauses.recompute(q, now);
        // In the same transaction, so a window that closes on a master never leaves a moment
        // where the master is paused and its dependents still think it is Down (`P-136`).
        await this.#dependencies.recompute(q, now);
        return moved;
      });
      if (result.moved > 0) {
        this.#logger.info(
          { moved: result.moved, transitions: result.transitions, inactive: result.inactive },
          'a schedule window opened or closed',
        );
        this.#onChanged?.();
      }
      return result.moved;
    } catch (error: unknown) {
      this.#logger.error({ err: describeError(error) }, 'the schedule sweep failed; retrying');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    const now = Date.now();
    // Just past the minute, so a boundary at 09:00:00 is acted on at 09:00:00 and not at
    // 08:59:59.998 — where the schedule is still closed and the sweep would decide nothing
    // changed, then wait another minute to find out that it had.
    const delay = this.#intervalMs ?? MINUTE - (now % MINUTE) + 50;
    this.#timer = setTimeout(
      () => {
        void this.sweep().finally(() => {
          this.#arm();
        });
      },
      Math.max(50, delay),
    );
    // Never a reason to hold the process open: a window that has not opened yet will still be
    // open after a restart, because the schedule is in the database and not in this timer.
    this.#timer.unref();
  }
}

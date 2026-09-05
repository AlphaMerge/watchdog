import { describeError, type Logger } from '@ms/shared';
import { PAUSE_CURSOR_START, type PauseCursor } from './pause-repository.js';

/** Just enough of `ObjectService` to run the sweep. */
export interface SweepsPauses {
  sweepPauses(
    since: PauseCursor,
    limit?: number,
  ): Promise<{
    expired: number[];
    started: number[];
    released: number;
    sensorsAffected: number;
    /** Where to resume from; null when the page was not truncated (`P-95`). */
    startedThrough: PauseCursor | null;
  }>;
}

export interface PauseSweepOptions {
  service: SweepsPauses;
  logger: Logger;
  /** How often to look. Coarse on purpose — see below. */
  intervalMs?: number;
  batchSize?: number;
  /**
   * Poked after a sweep that moved something, so probes learn in the same second.
   *
   * A pause expiring or a window opening writes an audit entry, and the config push rides that.
   * A dependency's recovery delay elapsing writes none — no operator did anything — so without
   * this the probes would not be told until some later change happened to poke them (`M-11`).
   */
  onChanged?: () => void;
}

/** Half a minute. Fine enough for a window given to the minute, coarse enough to cost nothing. */
const TICK = 30_000;

/**
 * Notices when a maintenance window opens, when a timed pause runs out, and when a dependency's
 * recovery delay elapses (`M-08`, `M-10`, `M-11`).
 *
 * Every *read* of a pause already accounts for the clock, so nothing is wrong between a boundary
 * and the sweep — the object simply is or is not paused. What the sweep is for is the three
 * things that are writes: the transition that uptime is computed from, the entry in the log, and
 * the configuration push that tells a probe to start or stop scanning.
 *
 * **Half a minute, not a second, and aligned to it.** A query a second for ever, on an
 * installation where nothing is ever paused, is a cost nobody agreed to; but a window given as
 * 22:00 should start at 22:00 rather than up to half a minute later, because monitoring that
 * runs into a planned outage is the alarm pausing exists to prevent. Ticking *on* the half
 * minute costs exactly what ticking every half minute costs and lands on the boundary instead
 * of somewhere after it.
 *
 * The window's opening is the one direction where lateness matters. An expiry that fires late
 * only means monitoring resumes late, which is the safe side of the same trade.
 */
export class PauseSweep {
  readonly #service: SweepsPauses;
  readonly #logger: Logger;
  readonly #intervalMs: number | undefined;
  readonly #batchSize: number;
  readonly #onChanged: (() => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  /**
   * The end of the last pass, and the start of the next one's window of interest.
   *
   * The epoch to begin with, on purpose: the first sweep after a restart then treats every
   * pause already in force as newly started and recomputes it, which is what reconciles the
   * windows that opened while the core was down. Idempotent, so it writes nothing when nothing
   * drifted.
   */
  #since: PauseCursor = PAUSE_CURSOR_START;

  constructor(options: PauseSweepOptions) {
    this.#service = options.service;
    this.#logger = options.logger.child({ component: 'pause-sweep' });
    this.#intervalMs = options.intervalMs;
    this.#batchSize = options.batchSize ?? 200;
    this.#onChanged = options.onChanged;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One pass. Never throws: a sweep that dies takes every future sweep with it. */
  async sweep(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    const since = this.#since;
    const startedAt = new Date();
    try {
      const report = await this.#service.sweepPauses(since, this.#batchSize);
      // Advanced only on success, so a failed pass is retried over the same interval rather
      // than leaving a window that opened during it unapplied for ever.
      //
      // **And not past what the batch limit truncated** (`P-95`). `#since` starts at the epoch
      // so the first pass after a restart reconciles every window that opened while the core
      // was down — which means `startedIn` returns *every pause currently in force*, oldest
      // first, capped at the batch size. Advancing to now regardless dropped everything past
      // the cap permanently: unlike `expired`, whose predicate stays true so an unswept row is
      // retried next tick, a missed `startedIn` row can never match `starts_at > since` again,
      // and nothing else sets its flags. An installation with a few hundred long-standing
      // pauses would silently never apply a maintenance window that opened during the restart —
      // its sensors keep scanning through the planned outage and alarm, which is the exact
      // failure pausing exists to prevent.
      this.#since = report.startedThrough ?? { startsAt: startedAt.toISOString(), objectId: 0 };
      if (report.expired.length > 0) {
        this.#logger.info(
          { objects: report.expired, sensorsAffected: report.sensorsAffected },
          'timed pauses expired; monitoring resumed',
        );
      }
      if (report.started.length > 0) {
        this.#logger.info(
          { objects: report.started, sensorsAffected: report.sensorsAffected },
          'maintenance windows opened; monitoring paused',
        );
      }
      if (report.released > 0) {
        this.#logger.info(
          { released: report.released },
          'dependency recovery delays elapsed; monitoring resumed',
        );
      }
      const moved = report.expired.length + report.started.length + report.released;
      if (moved > 0) this.#onChanged?.();
      return moved;
    } catch (error: unknown) {
      this.#logger.error({ err: describeError(error) }, 'the pause sweep failed; retrying');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    const now = Date.now();
    // Just past the boundary rather than on it: a window that starts at 22:00:00 is applied at
    // 22:00:00.05, where a tick a few milliseconds early would find nothing and wait another
    // half minute to notice.
    const delay = this.#intervalMs ?? TICK - (now % TICK) + 50;
    this.#timer = setTimeout(
      () => {
        void this.sweep().finally(() => {
          this.#arm();
        });
      },
      Math.max(50, delay),
    );
    // Never a reason to hold the process open for it: a boundary that has not been crossed yet
    // will still be there after a restart, because the times are in the database and not in a
    // timer.
    this.#timer.unref();
  }
}

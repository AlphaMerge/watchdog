import type { Logger } from '@ms/shared';
import type { HelperChange } from '../resolver/lookup-helper.js';

/**
 * The lookup helper's trouble latch (`P-432` §1.13, D29): Probe Health's `lookupHelperTrouble`,
 * the one gate field that alarms. A zone's outage never sets it: the helper is meant to carry
 * those lookups, so one outage stays one alarm, its sensors'. What sets it is the helper itself
 * failing:
 * - **not up for `TROUBLE_NOT_UP_MS`** (30 s) at a stretch, from its start or a loss;
 * - **`TROUBLE_LOSSES` losses (3) in `TROUBLE_WINDOW_MS`** (10 minutes), less a crash charged to a
 *   poison name that crashed again at its hourly ask (`charged: 'again'`), a fault already found
 *   and asked on purpose;
 * - **any `memory` loss**;
 * - **a rest**, when the probe resolves as with `system`.
 *
 * It clears after `TROUBLE_CLEAR_MS` (10 minutes) up with no loss. A rest until the probe restarts
 * (a skew, D28) keeps it set until then, since nothing short of a restart mends it.
 */

export const TROUBLE_NOT_UP_MS = 30_000;
export const TROUBLE_LOSSES = 3;
export const TROUBLE_WINDOW_MS = 600_000;
export const TROUBLE_CLEAR_MS = 600_000;

export type TroubleReason = 'not-up' | 'losses' | 'memory' | 'resting';

export interface HelperTroubleLatchOptions {
  readonly logger: Logger;
  /** A monotonic clock in milliseconds. */
  readonly now: () => number;
}

export class HelperTroubleLatch {
  readonly #logger: Logger;
  readonly #now: () => number;
  #set: TroubleReason | undefined;
  /** Set by a rest until restart: cleared by nothing else. */
  #untilRestart = false;
  #losses: number[] = [];
  /** Since when the helper has not been up: from its start. */
  #notUpSince: number | undefined;
  /** Since when it has been up with no loss. */
  #upSince: number | undefined;

  constructor(options: HelperTroubleLatchOptions) {
    this.#logger = options.logger.child({ component: 'lookup-helper' });
    this.#now = options.now;
    this.#notUpSince = this.#now();
  }

  /** Every change the helper reports (its `onChange`). */
  change(change: HelperChange): void {
    const now = this.#now();
    if (change.loss !== undefined) {
      this.#upSince = undefined;
      if (change.loss === 'memory') this.#raise('memory');
      if (change.charged !== 'again') {
        this.#losses = this.#losses.filter((at) => now - at < TROUBLE_WINDOW_MS);
        this.#losses.push(now);
        if (this.#losses.length >= TROUBLE_LOSSES) this.#raise('losses');
      }
    }
    switch (change.state) {
      case 'up':
        // A stretch that ended between two reports still counts.
        this.#judgeNotUp(now);
        this.#notUpSince = undefined;
        if (change.loss === undefined) this.#upSince ??= now;
        break;
      case 'resting':
        this.#notUpSince ??= now;
        this.#upSince = undefined;
        this.#raise('resting');
        if (change.delayMs === undefined) this.#untilRestart = true;
        break;
      case 'stopping':
      case 'stopped':
      case 'idle':
        // The probe is stopping, or the helper never started: not the helper's trouble.
        this.#judgeNotUp(now);
        this.#notUpSince = undefined;
        this.#upSince = undefined;
        break;
      default:
        this.#notUpSince ??= now;
        this.#upSince = undefined;
    }
  }

  /** 0 or 1, as Probe Health reads it: the timed rules are judged now. */
  value(): 0 | 1 {
    const now = this.#now();
    this.#judgeNotUp(now);
    if (
      this.#set !== undefined &&
      !this.#untilRestart &&
      this.#upSince !== undefined &&
      now - this.#upSince >= TROUBLE_CLEAR_MS
    ) {
      this.#logger.info(
        { was: this.#set },
        'the lookup helper has answered for ten minutes with no loss: its trouble is cleared',
      );
      this.#set = undefined;
    }
    return this.#set === undefined ? 0 : 1;
  }

  /** Why it is set, while it is. */
  reason(): TroubleReason | undefined {
    return this.#set;
  }

  #judgeNotUp(now: number): void {
    if (this.#notUpSince !== undefined && now - this.#notUpSince >= TROUBLE_NOT_UP_MS) {
      this.#raise('not-up');
    }
  }

  #raise(reason: TroubleReason): void {
    if (this.#set !== undefined) return;
    this.#set = reason;
    this.#logger.warn(
      { reason },
      'the lookup helper is in trouble: Probe Health shows a Warning until it has answered for ten minutes with no loss',
    );
  }
}

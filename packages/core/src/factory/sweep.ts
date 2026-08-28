import type { Logger } from '@ms/shared';
import { PeriodicSweep } from '../support/periodic-sweep.js';
import type { FactoryService } from './service.js';

export interface FactorySweepOptions {
  service: FactoryService;
  logger: Logger;
  /** How often factory sensors are recomputed. Their own scan interval is not consulted. */
  intervalMs?: number;
}

/**
 * The timer that recomputes Sensor Factory sensors (`T-21`).
 *
 * **One sweep for the whole installation rather than a scan interval per sensor**, and that is a
 * deliberate simplification with a reason behind it. A factory has no device to be polite to and
 * no packet to send: it is arithmetic over rows this process already has, costing two queries per
 * sweep however many factories there are. Honouring each sensor's own interval would mean a
 * second scheduler in the core — a timing wheel's worth of machinery — to stagger work that is
 * cheaper than the staggering.
 *
 * **The interval is the floor, not the ceiling.** A factory reading a sensor scanned every five
 * minutes still only changes every five minutes; recomputing it every thirty seconds writes the
 * same value nine times, which the sample table stores and the rollups then average to exactly
 * the same answer. Thirty seconds is chosen so a factory over a one-minute sensor is never more
 * than half an interval stale, which is what an operator watching a graph would notice.
 *
 * The timer itself is `PeriodicSweep`, shared with `P-12`'s Core Health sweep — including the
 * rule that an overrun is skipped and counted rather than queued.
 */
const DEFAULT_INTERVAL_MS = 30_000;

export class FactorySweep extends PeriodicSweep {
  constructor(options: FactorySweepOptions) {
    super({
      logger: options.logger,
      component: 'factory-sweep',
      what: 'a sensor factory sweep failed',
      run: () => options.service.sweep(),
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    });
  }
}

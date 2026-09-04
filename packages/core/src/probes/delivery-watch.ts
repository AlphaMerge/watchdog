import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { ProbeLink } from '../transport/probe-endpoint.js';
import type { ProbeReachability } from './reachability.js';
import {
  DELIVERY_DEFAULTS,
  verdict,
  type DeliveryOptions,
  type DeliveryVerdict,
} from './delivery.js';

/**
 * The sweep that asks, of every connected probe, whether it is still delivering (`P-74`).
 *
 * **Stateful half, kept away from the rule.** `delivery.ts` decides; this one finds the probes,
 * asks it, and moves the answer into `ProbeReachability` — the same split `state/machine.ts` and
 * `state/service.ts` have, and for the same reason: the table-driven tests then exercise the rule
 * production uses rather than a second copy of it.
 *
 * **Edge-triggered, never level-triggered.** `lost` and `resumed` are called only when the
 * verdict *changes*, because each of them re-evaluates every sensor under the probe and writes
 * state history. Calling them every thirty seconds while a probe stayed stalled would write a
 * transition per sweep into the table uptime and SLA are computed from, which is worse than the
 * silence it is fixing. `ProbeReachability` is idempotent as well, so this is belt and braces —
 * deliberately, because the cost of getting it wrong is corrupt history rather than a wasted call.
 */
export interface DeliveryWatchOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly reachability: ProbeReachability;
  /** What the core knows about one probe's link, right now. The endpoint's own accessor. */
  readonly linkFor: (probeObjectId: number) => ProbeLink;
  /** When this core process came up, for the start-up grace. */
  readonly startedAt: Date;
  readonly now?: () => Date;
  readonly settings?: DeliveryOptions;
}

export interface DeliveryStats {
  /** Probes currently held Unknown for silence rather than for a lost link. */
  readonly silent: number;
  /** Sweeps run, and how many of them changed anything. */
  readonly sweeps: number;
  readonly transitions: number;
}

export class ProbeDeliveryWatch {
  readonly #options: DeliveryWatchOptions;
  readonly #settings: DeliveryOptions;
  readonly #now: () => Date;
  /** Probes this sweep has marked, so it can tell an edge from a level. */
  readonly #silent = new Set<number>();
  #sweeps = 0;
  #transitions = 0;

  constructor(options: DeliveryWatchOptions) {
    this.#options = options;
    this.#settings = options.settings ?? DELIVERY_DEFAULTS;
    this.#now = options.now ?? ((): Date => new Date());
  }

  stats(): DeliveryStats {
    return { silent: this.#silent.size, sweeps: this.#sweeps, transitions: this.#transitions };
  }

  /** What the watch makes of one probe, for Probe Health to report without repeating the rule. */
  verdictFor(probeObjectId: number): DeliveryVerdict | null {
    const link = this.#options.linkFor(probeObjectId);
    if (!link.connected) return null;
    return verdict(
      {
        assignedSensors: link.assignedSensors,
        cadenceSeconds: link.cadenceSeconds,
        lastResultsAt: link.lastResultsAt,
        configSentAt: link.configSentAt,
      },
      this.#now(),
      this.#options.startedAt,
      this.#settings,
    );
  }

  /**
   * One pass over every probe.
   *
   * Never throws: a sweep that cannot read the object table is not a reason to decide anything
   * about a probe, and the next one tries again — the same judgement `ProbeReachability.lost`
   * makes when it cannot list a probe's sensors.
   */
  async settle(): Promise<number> {
    this.#sweeps += 1;
    let probes: { id: string }[];
    try {
      probes = await this.#options.db.query<{ id: string }>(
        `SELECT id::text AS id FROM object WHERE kind = 'probe'`,
      );
    } catch (error) {
      this.#options.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not list probes for the delivery sweep',
      );
      return 0;
    }

    let moved = 0;
    for (const row of probes) {
      const probeObjectId = Number(row.id);
      const seen = this.verdictFor(probeObjectId);
      if (seen === null) {
        // Not connected: `R-05` owns it from the moment the link went, and this sweep must not
        // clear what that set. The claim is dropped rather than held, because a probe that
        // reconnects and is *still* silent has to be markable again — holding it would leave the
        // next `stalled` looking like no change at all, and the probe would never be re-marked.
        this.#silent.delete(probeObjectId);
        continue;
      }

      const wasSilent = this.#silent.has(probeObjectId);
      if (seen.stalled && !wasSilent) {
        this.#silent.add(probeObjectId);
        this.#transitions += 1;
        this.#options.logger.warn(
          { probeObjectId, silentForMs: seen.silentForMs, windowMs: seen.windowMs },
          'a probe is connected but has stopped sending results; its sensors are Unknown',
        );
        moved += await this.#options.reachability.lost(probeObjectId, 'silence');
      } else if (!seen.stalled && wasSilent) {
        this.#silent.delete(probeObjectId);
        this.#transitions += 1;
        this.#options.logger.info(
          { probeObjectId },
          'a probe is sending results again; its sensors returned to their last reading',
        );
        moved += await this.#options.reachability.resumed(probeObjectId);
      }
    }
    return moved;
  }
}

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
  /**
   * How long this core process has been running, monotonically (`P-81`).
   *
   * Was a `startedAt: Date` compared against `new Date()`. That is a duration measured on the
   * wall clock, which a step moves in either direction: blind going backwards, and going forwards
   * indistinguishable from that much silence on every probe at once.
   */
  readonly uptimeMs?: () => number;
  readonly settings?: DeliveryOptions;
  /**
   * How many probes one sweep may mark, at most (`P-81`).
   *
   * Each `lost` walks a probe's subtree, opens a transaction, re-evaluates every sensor under it
   * and writes a `sensor_state` row per sensor that moves — the table uptime and SLA are computed
   * from. Nothing bounded how many probes one pass could do that to, while `AlarmEngine` in this
   * same codebase bounds `maxPerSweep` with a comment naming a forward clock jump as the reason
   * it exists.
   *
   * Monotonic ages make the clock jump itself unreachable, so this is the belt to that braces: a
   * genuine core-wide outage — a switch, the core's own uplink — really can leave every probe
   * silent at once, and the honest answer is still to mark them, just not all in one transaction
   * storm. What is left is still stalled at the next sweep thirty seconds later.
   */
  readonly maxPerSweep?: number;
}

export interface DeliveryStats {
  /** Probes currently held Unknown for silence rather than for a lost link. */
  readonly silent: number;
  /** Sweeps run, and how many of them changed anything. */
  readonly sweeps: number;
  readonly transitions: number;
  /**
   * Probes a sweep found stalled and deferred because it had hit its cap (`P-81`).
   *
   * Counted rather than silent, for the reason `CLAUDE.md` gives about backpressure: work put off
   * is visible or it is a lie. Non-zero means an installation-wide event, which is exactly when
   * an operator wants to know the sweep is rationing itself.
   */
  readonly deferred: number;
}

/**
 * Probes one sweep will mark, at most.
 *
 * Twenty rather than a percentage: it is a bound on *write* volume, and what makes a storm is the
 * transaction count and the history rows, neither of which scales with how many probes an
 * installation happens to have. At a thirty-second sweep it still clears a hundred probes inside
 * three minutes, which is well within the window that made them stalled in the first place.
 */
const DEFAULT_MAX_PER_SWEEP = 20;

export class ProbeDeliveryWatch {
  readonly #options: DeliveryWatchOptions;
  readonly #settings: DeliveryOptions;
  readonly #uptimeMs: () => number;
  #silentNow = 0;
  #sweeps = 0;
  #transitions = 0;
  #deferred = 0;

  constructor(options: DeliveryWatchOptions) {
    this.#options = options;
    this.#settings = options.settings ?? DELIVERY_DEFAULTS;
    const startedNs = process.hrtime.bigint();
    this.#uptimeMs =
      options.uptimeMs ??
      ((): number => Number((process.hrtime.bigint() - startedNs) / 1_000_000n));
  }

  stats(): DeliveryStats {
    return {
      silent: this.#silentNow,
      sweeps: this.#sweeps,
      transitions: this.#transitions,
      deferred: this.#deferred,
    };
  }

  /** What the watch makes of one probe, for Probe Health to report without repeating the rule. */
  verdictFor(probeObjectId: number): DeliveryVerdict | null {
    const link = this.#options.linkFor(probeObjectId);
    if (!link.connected) return null;
    return verdict(
      {
        assignedSensors: link.assignedSensors,
        cadenceSeconds: link.cadenceSeconds,
        // Ages, computed by the endpoint against a monotonic clock (`P-81`).
        sinceResultsMs: link.sinceResultsMs,
        sinceConfigMs: link.sinceConfigMs,
        connectedForMs: link.connectedForMs,
        configured: link.configured,
        configurable: link.configurable,
      },
      this.#uptimeMs(),
      this.#settings,
    );
  }

  /**
   * Whether this core has yet to learn if a probe is missing (`M-22`): the probe has not
   * connected since the core started, nothing has marked it lost, and the grace is still running.
   *
   * The same grace and the same uptime as the sweep below, so Probe Health and the lost mark
   * cannot disagree about when a probe that never came back is named. Until then it is a probe
   * that has not reconnected *yet*. A core upgrade would otherwise page once per remote probe
   * that took forty seconds to redial.
   */
  awaitingFirstConnect(probeObjectId: number): boolean {
    if (this.#options.linkFor(probeObjectId).connected) return false;
    if (this.#options.reachability.offlineReason(probeObjectId) !== undefined) return false;
    return this.#uptimeMs() < this.#settings.graceSeconds * 1_000;
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
    let silent = 0;
    let marked = 0;
    let deferred = 0;
    const cap = this.#options.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
    for (const row of probes) {
      const probeObjectId = Number(row.id);
      // **The truth, not a copy of it** (`P-77`). Asking `ProbeReachability` what it actually
      // holds means a `lost` that failed — it logs and returns without marking when it cannot
      // read the probe's sensors — is simply retried on the next sweep, instead of being recorded
      // as done by a shadow set that nothing could correct. A probe not connected is `R-05`'s and
      // reads `link`, so neither branch below fires for it.
      const held = this.#options.reachability.offlineReason(probeObjectId);
      if (held === 'silence') silent += 1;

      // **A probe that is simply not there** (`P-110`). `verdictFor` answers `null` for a
      // disconnected probe because delivery is `R-05`'s question, not this rule's — and `R-05`
      // learns about a disconnect from `ProbeEndpoint.#handleClose`, which fires only for a
      // session that *existed*. So a probe whose host went away while the core was down had no
      // session to close, nothing seeded `#unreachable` at boot, and `loadRuntimes` restores
      // `probeReachable: true` optimistically: its sensors read Up, green in the tree, absent
      // from the alarms view, with `since` from before the crash. `sensor_state` got no row at
      // all, so the whole absence integrated as Up for uptime and SLA.
      //
      // The same probe dropping while the core is *running* becomes Unknown within seconds. A
      // restart therefore silently reversed the correct answer for an outage still in progress,
      // and this file's own comment claimed the staleness is corrected by "the probe's own
      // reconnect *or its absence*". Absence corrected nothing.
      //
      // After the grace, which is the same one the delivery rule uses and exists for the same
      // reason: a core that has just started has not yet learned that a probe is missing, and
      // marking thousands of sensors Unknown on every restart would be an alarm storm generated
      // by the restart itself.
      if (!this.#options.linkFor(probeObjectId).connected) {
        if (held !== undefined || this.#uptimeMs() < this.#settings.graceSeconds * 1_000) continue;
        if (marked >= cap) {
          deferred += 1;
          continue;
        }
        marked += 1;
        this.#transitions += 1;
        this.#options.logger.warn(
          { probeObjectId },
          'a probe has not connected since this core started; its sensors are Unknown',
        );
        moved += await this.#options.reachability.lost(probeObjectId, 'link');
        continue;
      }

      const seen = this.verdictFor(probeObjectId);
      if (seen === null) continue;

      if (seen.stalled && held === undefined) {
        // Bounded (`P-81`). The probe is still stalled at the next sweep, and deferring is the
        // one option here that writes nothing wrong — the alternative on an installation-wide
        // event is one pass re-evaluating every sensor the core has.
        if (marked >= cap) {
          deferred += 1;
          continue;
        }
        marked += 1;
        this.#transitions += 1;
        this.#options.logger.warn(
          { probeObjectId, silentForMs: seen.silentForMs, windowMs: seen.windowMs },
          'a probe is connected but has stopped sending results; its sensors are Unknown',
        );
        moved += await this.#options.reachability.lost(probeObjectId, 'silence');
      } else if (!seen.stalled && held === 'silence') {
        this.#transitions += 1;
        this.#options.logger.info(
          { probeObjectId },
          'a probe is sending results again; its sensors returned to their last reading',
        );
        moved += await this.#options.reachability.resumed(probeObjectId);
      }
    }
    this.#silentNow = silent;
    this.#deferred = deferred;
    if (deferred > 0) {
      this.#options.logger.warn(
        { deferred, cap },
        'more probes stopped delivering at once than one sweep will mark; the rest follow',
      );
    }
    return moved;
  }
}

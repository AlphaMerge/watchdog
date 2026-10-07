import { RecentCount } from '../health/recent-count.js';

/**
 * What the core refused from each probe, for Probe Health (`P-228`).
 *
 * A probe may report on what it was given and nothing else: results for the sensors under it,
 * the answer to a query put to it, progress on a discovery run it was dispatched. Anything else
 * is refused where it arrives — ingestion, the query service, the discovery service — and
 * counted here, so the one place an operator looks at a probe says so.
 *
 * **Two numbers, because most refusals are ordinary and a few are not.**
 *
 * - `refused` is every one of them, a counter with no limit. The ordinary ones are the probe
 *   lagging a change the core has already made: a sensor moved to another probe or deleted while
 *   this one's spool still held results for it. That is the system working, and a warning on it
 *   would turn every move an administrator makes into an alarm on the probe they moved away from
 *   — two alarms for no outage at all.
 * - `foreign` is the subset the probe could never have had: a sensor that was never under it, a
 *   query put to another probe, a run dispatched elsewhere. No correct probe sends one. It is a
 *   count over the last five minutes rather than a counter (`RecentCount` says why), and it is
 *   what carries the warning.
 *
 * **And a third, kept apart from both** (`A-56`): `late` is a probe's own refusal to scan a sensor,
 * delivered after a configuration stopped leaving that sensor to it, and dropped (`A-53`). The
 * probe did what its configuration said and nothing is wrong with it, so it is not among
 * `refused`, where an operator looking for a probe that marks what it should not would have to
 * tell the two apart by guessing. A counter with no limit: it rises for ten minutes after a
 * credential set's targets or a device's address change, and then stops.
 *
 * **And a fourth, for `late`'s reason** (`A-72`): `withheld` is a result of any kind for a sensor
 * the core's own configuration withholds from the probe, dropped. The probe was not sent the
 * sensor, so it made the result under a configuration before.
 *
 * Keyed by probe object, the thing Probe Health reads by and the thing ownership is decided
 * against. A GID that owns no object yet has nothing it could legitimately report, so what it
 * sends is refused and counted in the totals only: there is no Probe Health sensor to show it on.
 */
/** How far back `foreign` looks: long enough to span a few sweeps, short enough to clear. */
export const FOREIGN_WINDOW_MS = 5 * 60_000;

export class ProbeRefusals {
  readonly #monotonicMs: (() => number) | undefined;
  readonly #refused = new Map<number, number>();
  readonly #foreign = new Map<number, RecentCount>();
  readonly #late = new Map<number, number>();
  readonly #withheld = new Map<number, number>();
  #refusedTotal = 0;
  #foreignTotal = 0;

  /** @param monotonicMs Milliseconds on a monotonic clock, for the foreign window. */
  constructor(monotonicMs?: () => number) {
    this.#monotonicMs = monotonicMs;
  }

  /** Refused, and ordinary: the probe had this once, or it no longer exists. */
  refused(probeObjectId: number | null, n = 1): void {
    if (n <= 0) return;
    this.#refusedTotal += n;
    if (probeObjectId === null) return;
    this.#refused.set(probeObjectId, (this.#refused.get(probeObjectId) ?? 0) + n);
  }

  /**
   * Refused, and the probe never had it. Counted as refused as well.
   *
   * @param n What arrived, which the five-minute window counts: a result sent again is the probe
   *   sending it again, and the warning lasts five minutes after the last of them.
   * @param counted Of those, the ones not counted before (`P-295`), which the totals and
   *   `refused` count: a batch sent again after a lost acknowledgement is not more refusals.
   */
  foreign(probeObjectId: number | null, n = 1, counted = n): void {
    if (n <= 0) return;
    this.refused(probeObjectId, counted);
    this.#foreignTotal += counted;
    if (probeObjectId === null) return;
    let recent = this.#foreign.get(probeObjectId);
    if (recent === undefined) {
      recent = new RecentCount(
        FOREIGN_WINDOW_MS,
        this.#monotonicMs === undefined ? {} : { monotonicMs: this.#monotonicMs },
      );
      this.#foreign.set(probeObjectId, recent);
    }
    recent.add(n);
  }

  /**
   * A refusal the probe made under the configuration before its last, dropped by the core
   * (`A-53`). Not counted as refused: nothing was refused from the probe, and nothing is wrong.
   */
  late(probeObjectId: number, n = 1): void {
    if (n <= 0) return;
    this.#late.set(probeObjectId, (this.#late.get(probeObjectId) ?? 0) + n);
  }

  /** How many of one probe's refusals arrived late, since start. Zero, not a gap, for none. */
  lateFor(probeObjectId: number): number {
    return this.#late.get(probeObjectId) ?? 0;
  }

  /**
   * A result for a sensor the core withholds from this probe, dropped (`A-72`): the probe's
   * configuration does not carry the sensor, so it was made under one before. Not counted as
   * refused, for `late`'s reason: nothing is wrong with the probe.
   */
  withheld(probeObjectId: number, n = 1): void {
    if (n <= 0) return;
    this.#withheld.set(probeObjectId, (this.#withheld.get(probeObjectId) ?? 0) + n);
  }

  /** How many of one probe's results were for a withheld sensor, since start. Zero for none. */
  withheldFor(probeObjectId: number): number {
    return this.#withheld.get(probeObjectId) ?? 0;
  }

  /** One probe's numbers, now. A probe nothing was ever refused from reads zero, not a gap. */
  countsFor(probeObjectId: number): { refused: number; foreignRecently: number } {
    const recent = this.#foreign.get(probeObjectId);
    const foreignRecently = recent?.count() ?? 0;
    // Dropped once its window is empty, so a probe that sent one stray report a year ago does not
    // hold a ring of buckets for ever. The next foreign report starts a fresh one.
    if (recent !== undefined && foreignRecently === 0) this.#foreign.delete(probeObjectId);
    return { refused: this.#refused.get(probeObjectId) ?? 0, foreignRecently };
  }

  /** Every probe, since start. For Core Health and the tests. */
  stats(): { refused: number; foreign: number } {
    return { refused: this.#refusedTotal, foreign: this.#foreignTotal };
  }
}

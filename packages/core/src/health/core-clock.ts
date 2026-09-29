import type { ProbeLink } from '../transport/probe-endpoint.js';

/**
 * Whether the core's own clock is the one that is wrong (`P-247`).
 *
 * **Every clock check here compares a probe with the core, so each one names the probe.** That
 * is right for one probe with a bad clock, and wrong when the core's clock is the bad one: a core
 * twenty minutes slow sees every probe twenty minutes ahead, refuses all of their results as
 * future-dated past fifteen (`DEFAULT_MAX_FUTURE_SKEW_MS`), and each probe's Probe Health warned
 * that its clock was at fault. One fault on one machine, N warnings, each naming a machine that
 * was fine, while every sensor on a remote probe froze in its last state.
 *
 * **When every remote probe reads ahead, the likelier fault is the one machine they have in
 * common.** Two or more, all ahead by more than Probe Health's own minute: then Core Health owns
 * it, and each Probe Health's clock warnings stand down while it does, as `M-21` does for the
 * machine's memory. One probe proves nothing, because it cannot be told apart from one probe
 * ahead, so with fewer than two the reading gaps. Two probes both set wrong the same way are
 * blamed on the core; that is the price, and it is a price in which machine is named, not in
 * whether an alarm is raised.
 *
 * **The local probe is left out.** It reads the core's own clock, so its offset is zero whatever
 * that clock says, and counting it would mean a single-host install with remote probes could
 * never agree.
 */

/** Probe Health's `clockOffset` warning, and so the lead at which the core is named instead. */
export const CORE_CLOCK_BEHIND_SECONDS = 60;
/** Probes that must agree. One cannot be told apart from one probe whose own clock is ahead. */
export const CORE_CLOCK_QUORUM = 2;

export interface CoreClockVerdict {
  /**
   * How far the core's clock is behind every remote probe, in seconds: the smallest lead among
   * them, and 0 when any of them is not ahead. Null, a gap, with fewer than two to compare.
   */
  readonly behindSeconds: number | null;
  /** Every remote probe ahead by more than a minute: Core Health's condition, not theirs. */
  readonly owned: boolean;
}

/**
 * The verdict from the remote probes' offsets, in milliseconds as `ProbeLink.clockOffsetMs`
 * carries them: positive when the probe is behind, so a probe ahead is negative. A probe whose
 * session has not measured one yet is `null`, and is left out rather than counted as agreeing.
 */
export function judgeCoreClock(offsetsMs: readonly (number | null)[]): CoreClockVerdict {
  const measured = offsetsMs.filter((offset): offset is number => offset !== null);
  if (measured.length < CORE_CLOCK_QUORUM) return { behindSeconds: null, owned: false };
  const lead = Math.min(...measured.map((offset) => -offset)) / 1_000;
  const behindSeconds = Math.max(0, Math.round(lead * 10) / 10);
  return { behindSeconds, owned: behindSeconds > CORE_CLOCK_BEHIND_SECONDS };
}

/**
 * The clock offsets of the connected probes that are not the core's local one, which both Core
 * Health and Probe Health judge from. Read from the same live links, so the two sweeps reach the
 * same verdict from the same measurements.
 */
export function remoteClockOffsets(
  connected: readonly number[],
  local: ReadonlySet<number>,
  link: (probeObjectId: number) => ProbeLink,
): (number | null)[] {
  const offsets: (number | null)[] = [];
  for (const probeId of connected) {
    if (local.has(probeId)) continue;
    const held = link(probeId);
    if (held.connected) offsets.push(held.clockOffsetMs);
  }
  return offsets;
}

import type {
  DiscoveryLevel,
  DiscoveryLevelEstimate,
  DiscoveryRun,
  DiscoveryStatus,
} from '../api/types';

/**
 * The arithmetic and the wording behind the discovery page (`D-10`).
 *
 * Separate from the component because every interesting decision here is a judgement that can be
 * wrong without anything failing: what one progress bar means when a run has two phases, how a
 * bracket of seconds reads as English, and why a disabled button is disabled. A component test
 * would prove a `<div>` exists; these prove the thing the operator actually reads.
 */

/**
 * How far a run has got, 0–1.
 *
 * **One bar for two phases, and the split is not even.** A run sweeps every address and then
 * identifies only the ones that answered, so the two phases have nothing to do with each other's
 * size: a /24 with three live hosts is 254 sweeps and 3 identifications. Weighting them by their
 * own counts would make the bar leap from 5% to 100% as the sweep ended. So the sweep owns a
 * fixed share and identification owns the rest — a bar that moves at a believable rate, which is
 * the only thing a progress bar is for.
 *
 * `ping` never identifies, so its sweep owns the whole bar rather than stopping at 70%.
 */
export const SWEEP_SHARE = 0.7;

export function progressOf(run: DiscoveryRun): number {
  if (run.status === 'done') return 1;
  if (run.total === 0) return 0;
  const swept = Math.min(1, run.cursor / run.total);
  if (run.level === 'ping') return swept;
  // Nothing answered, so there is nothing to identify and the sweep is the whole job after all.
  if (run.status === 'identifying' && run.found === 0) return 1;
  const identified = run.found === 0 ? 0 : Math.min(1, run.identifyCursor / run.found);
  return swept * SWEEP_SHARE + identified * (1 - SWEEP_SHARE);
}

/** What the run is doing, in the words an operator would use for it. */
export function phaseOf(run: DiscoveryRun): string {
  switch (run.status) {
    case 'queued':
      return 'waiting for its probe';
    case 'running':
      return 'sweeping';
    case 'identifying':
      return 'identifying';
    case 'done':
      return 'finished';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

/** Whether a run is still going, and so still worth asking about. */
export function isActive(status: DiscoveryStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'identifying';
}

/**
 * How long to wait before asking again.
 *
 * **Polling rather than the state stream, deliberately.** `U-02`'s WebSocket carries sensor
 * state, and a discovery run is not a sensor: it exists for minutes, one operator is looking at
 * it, and pushing its progress would mean a second message kind on the stream, a subscription
 * for it, and a fan-out to every connected client for something one of them cares about. One
 * request every couple of seconds against an indexed primary key is cheaper than that, and it
 * stops entirely the moment the run does.
 *
 * A queued run is asked about less often, because what it is waiting for is a probe to connect
 * and that does not happen in two seconds.
 */
export function pollIntervalMs(run: DiscoveryRun | null): number | null {
  if (run === null || !isActive(run.status)) return null;
  return run.status === 'queued' ? 5_000 : 2_000;
}

/**
 * A bracket of seconds as English.
 *
 * Both endpoints in the same unit, chosen by the *larger* of the two: "8 s – 4 minutes" reads as
 * a mistake, and "1–136 minutes" is the honest shape of an estimate whose two ends really are
 * that far apart. `D-06`'s own finding is that the range is the answer, so it is shown as one.
 */
export function estimateText(minSeconds: number, maxSeconds: number): string {
  const low = Math.min(minSeconds, maxSeconds);
  const high = Math.max(minSeconds, maxSeconds);
  // The largest unit in which the *low* end is still at least one, so the bracket never opens
  // with "0.3 hours". Picking by the high end alone reported a /16 standard sweep as
  // "0.3–2.3 hours" where `D-06` measured it as 17–136 minutes — the same number, said worse.
  const UNITS = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ] as const;
  const [unit, per] =
    UNITS.find(([, size]) => low >= size) ??
    // A low end of zero has no unit of its own, so the high end chooses — but only once it is
    // comfortably into that unit, or "0–64 seconds" becomes "0–1.1 minutes".
    UNITS.find(([, size]) => high / size >= 1.5) ??
    UNITS[3];

  const scale = (value: number): string => {
    const n = value / per;
    // One decimal only where it changes the answer: "1.5 hours" is useful, "17.0 minutes" is not.
    return per === 1 || n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
  };

  const from = scale(low);
  const to = scale(high);
  // Singular only when the whole bracket collapses to exactly one. "1–2 seconds" is plural and
  // so is "1.5 hours"; only "1 second" is not. Found live, reading "1 seconds" off the page.
  const noun = from === to && from === '1' ? unit : `${unit}s`;
  return from === to ? `${from} ${noun}` : `${from}–${to} ${noun}`;
}

export interface DiscoveryDraft {
  probeId: number | null;
  groupId: number | null;
  range: string;
  level: DiscoveryLevel;
  templates: string[];
  snmpCommunity: string;
}

export const EMPTY_DRAFT: DiscoveryDraft = {
  probeId: null,
  groupId: null,
  range: '',
  level: 'standard',
  templates: [],
  snmpCommunity: '',
};

/**
 * Why the Start button is not available, or null when it is.
 *
 * **A sentence rather than a boolean**, because a disabled button with no explanation is a
 * puzzle: the operator has filled in a range and a level and cannot see that the group they
 * chose sits under a different probe. `U-08` makes the same argument about field-level errors.
 *
 * The range itself is not judged here. The core's parser is the only thing that knows what a
 * range means, and a second opinion in the browser would eventually disagree with it — so an
 * empty box is a local answer and everything else waits for the preview.
 */
export function whyNotStartable(draft: DiscoveryDraft, previewOk: boolean): string | null {
  if (draft.probeId === null) return 'choose the probe that can reach this network';
  if (draft.groupId === null) return 'choose the group the devices should be created in';
  if (draft.range.trim() === '') return 'enter a range, like 10.0.0.0/24 or 10.0.0.1-10.0.0.50';
  if (!previewOk) return 'the range has to be one the core accepts — see the message above';
  return null;
}

/**
 * The levels in the order they should be offered, hardest last.
 *
 * Sorted by cost rather than by the order the API happened to return them, so the list reads as
 * a ramp and the expensive one is never the first thing a thumb lands on.
 */
export function orderedLevels(levels: readonly DiscoveryLevelEstimate[]): DiscoveryLevelEstimate[] {
  return [...levels].sort((a, b) => a.maxSeconds - b.maxSeconds || a.ports - b.ports);
}

/**
 * Whether an estimate is long enough to be worth warning about.
 *
 * Ten minutes, because that is roughly where somebody stops waiting and walks away — and a
 * discovery they walked away from is one they will not see the plan for. PRTG's own warning is
 * "may take days", which is true and gives nobody a decision.
 */
export const LONG_RUN_SECONDS = 600;

export function isLong(estimate: DiscoveryLevelEstimate): boolean {
  return estimate.maxSeconds >= LONG_RUN_SECONDS;
}

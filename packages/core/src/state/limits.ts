/**
 * Channel limits (`M-04`) — §2.2 of `docs/state-machine.md`.
 *
 * `M-02` built the layered model with §2.2's output as an input it never received, so a sensor's
 * state was the query state alone: Up whenever the check ran, whatever it measured. This is what
 * fills that in. A response time of 812 ms is a successful check and a problem, and until now
 * the system could only see the first half.
 *
 * Pure, like `machine.ts`, and for the same reason: the interesting cases are boundaries and
 * combinations, and both are cheap to enumerate against a function and expensive to arrange
 * against a database.
 *
 * **Limits are immediate.** The two-step rule applies to query failures only — a channel over
 * its error limit is Down on the very first sample (`WORKFLOW.MD §4` rule 2). That is not an
 * inconsistency: a failed check might be a dropped packet, but a disk that is 99% full is 99%
 * full, and waiting another interval to say so helps nobody.
 */

import type { ChannelLimitDefaults } from '@ms/sensors';
import { applyLookup, type LookupDefinition } from '../lookups/definition.js';
import { ROLLUP_SEVERITY, type RollupState } from './tables.js';
import type { SensorStateCause } from './tables.js';
import type { Verdict } from './machine.js';

/**
 * One channel's thresholds, as stored in `channel.limits`.
 *
 * Four numbers rather than two ranges, because that is what an operator configures and what
 * PRTG's UI presents: an upper and a lower bound for each of the two severities. Any of them may
 * be absent, and absent means "not set" rather than "zero" — a lower limit of 0 on a percentage
 * is a real configuration, and it must not be what "no lower limit" looks like.
 */
export interface ChannelLimits {
  /**
   * Whether to act on the thresholds at all.
   *
   * Separate from the thresholds themselves so an operator can silence a limit without losing
   * the numbers — the alternative is deleting them and typing them back in, which is how
   * thresholds get lost.
   */
  readonly enabled: boolean;
  readonly upperError: number | null;
  readonly upperWarning: number | null;
  readonly lowerWarning: number | null;
  readonly lowerError: number | null;
  /** Appended to the generated message when an error limit is breached. */
  readonly errorMessage: string;
  readonly warningMessage: string;
}

/**
 * What a sensor type's declared thresholds look like once they are in the column (`S-18`).
 *
 * `enabled` is true and the messages default to empty, which is what every other path already
 * writes. Nothing here decides *whether* to apply them — that is `limits_source`'s job, and
 * keeping the two apart is what lets the same function serve a create and a backfill.
 */
export function limitsFromDeclaration(declared: ChannelLimitDefaults): ChannelLimits {
  return {
    enabled: true,
    upperError: declared.upperError ?? null,
    upperWarning: declared.upperWarning ?? null,
    lowerWarning: declared.lowerWarning ?? null,
    lowerError: declared.lowerError ?? null,
    errorMessage: declared.errorMessage ?? '',
    warningMessage: declared.warningMessage ?? '',
  };
}

export const NO_LIMITS: ChannelLimits = {
  enabled: true,
  upperError: null,
  upperWarning: null,
  lowerWarning: null,
  lowerError: null,
  errorMessage: '',
  warningMessage: '',
};

/**
 * Reads what is in the column.
 *
 * Tolerant on the way in and strict on the way out: the API validates against a JSON Schema
 * before anything is written, so a value here that is the wrong shape came from a hand-edited
 * row or an older format. Treating it as absent keeps one bad row from failing every result for
 * that sensor — and `limitsAreEmpty` then makes the channel a no-op rather than a wrong answer.
 */
export function parseLimits(raw: unknown): ChannelLimits {
  if (typeof raw !== 'object' || raw === null) return NO_LIMITS;
  const source = raw as Record<string, unknown>;
  return {
    enabled: source['enabled'] !== false,
    upperError: number(source['upperError']),
    upperWarning: number(source['upperWarning']),
    lowerWarning: number(source['lowerWarning']),
    lowerError: number(source['lowerError']),
    errorMessage: text(source['errorMessage']),
    warningMessage: text(source['warningMessage']),
  };
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A partial edit.
 *
 * `null` clears a threshold and an absent key leaves it alone — the distinction JSON can
 * express and `??` cannot, which is why the merge below tests for `undefined` explicitly. It
 * matters: "set the upper error limit" must not silently wipe the warning limit somebody else
 * configured.
 */
export interface ChannelLimitsPatch {
  readonly enabled?: boolean;
  readonly upperError?: number | null;
  readonly upperWarning?: number | null;
  readonly lowerWarning?: number | null;
  readonly lowerError?: number | null;
  readonly errorMessage?: string;
  readonly warningMessage?: string;
}

export function mergeLimits(current: ChannelLimits, patch: ChannelLimitsPatch): ChannelLimits {
  const pick = <T>(next: T | undefined, held: T): T => (next === undefined ? held : next);
  return {
    enabled: pick(patch.enabled, current.enabled),
    upperError: pick(patch.upperError, current.upperError),
    upperWarning: pick(patch.upperWarning, current.upperWarning),
    lowerWarning: pick(patch.lowerWarning, current.lowerWarning),
    lowerError: pick(patch.lowerError, current.lowerError),
    errorMessage: pick(patch.errorMessage, current.errorMessage),
    warningMessage: pick(patch.warningMessage, current.warningMessage),
  };
}

/**
 * What is wrong with a set of limits, in words, or an empty list.
 *
 * JSON Schema validates each field on its own; nothing in it can say that a warning limit above
 * an error limit is nonsense. It is: the error limit would fire first and the warning would be
 * unreachable, so the operator would have configured a threshold that can never be seen. Better
 * to refuse it with a reason than to accept it and behave surprisingly.
 */
export function validateLimits(limits: ChannelLimits): string[] {
  const problems: string[] = [];
  const { upperError, upperWarning, lowerWarning, lowerError } = limits;

  if (upperError !== null && upperWarning !== null && upperWarning > upperError) {
    problems.push(
      `the upper warning limit (${String(upperWarning)}) is above the upper error limit ` +
        `(${String(upperError)}), so it could never be reached`,
    );
  }
  if (lowerError !== null && lowerWarning !== null && lowerWarning < lowerError) {
    problems.push(
      `the lower warning limit (${String(lowerWarning)}) is below the lower error limit ` +
        `(${String(lowerError)}), so it could never be reached`,
    );
  }
  const lower = lowerWarning ?? lowerError;
  const upper = upperWarning ?? upperError;
  if (lower !== null && upper !== null && lower > upper) {
    problems.push(
      `the lower limit (${String(lower)}) is above the upper limit (${String(upper)}), so every ` +
        'reading would breach both',
    );
  }
  return problems;
}

/** One channel that is not Up, and why. */
export interface ChannelBreach {
  readonly key: string;
  readonly name: string;
  readonly state: Exclude<RollupState, 'up'>;
  /** Which of the two ways a channel state is decided produced this one. */
  readonly cause: Extract<SensorStateCause, 'limit' | 'lookup'>;
  /** Ready to read: what the value was, what it means, and the operator's own note. */
  readonly message: string;
}

/** A reading, as much of it as a limit cares about. */
export interface ChannelReadingFacts {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly value: number;
  readonly decimals: number | null;
  readonly limits: ChannelLimits;
  /**
   * What the channel *names*, whether or not this installation has it (`M-06`).
   *
   * Separate from `lookup` because the two absences mean different things, and conflating them
   * is how a broken configuration reads as healthy. `lookupId: null` is a channel judged by its
   * limits; `lookupId` set with `lookup` null is a channel whose operator said "judge this by
   * that lookup" and this installation cannot.
   */
  readonly lookupId: string | null;
  /**
   * The lookup this channel is judged by, resolved.
   *
   * When one is present it decides the channel's state **instead of** the limits, not as well:
   * a lookup maps discrete codes and a limit bounds a continuous range, and a channel whose
   * value is a status code has no meaningful threshold. `WORKFLOW.MD §4` rule 2 puts both in
   * the same sentence — "same for lookup-driven states" — so they are immediate alike, but they
   * are not additive. *Decided by `M-06`.*
   */
  readonly lookup: LookupDefinition | null;
}

/**
 * Whether one reading breached a limit, and what to say about it.
 *
 * Error before warning, and upper before lower within each: a value cannot be over the upper
 * error limit and under the lower one at the same time unless the limits themselves are
 * contradictory, which `validateLimits` refuses.
 *
 * The comparison is strict. A reading exactly *at* the limit has not exceeded it — an upper
 * error limit of 100% on disk usage should fire at 100%, not at 99.99%, and a limit that fired
 * on equality would make "at most 100" impossible to express.
 */
export function evaluateChannel(reading: ChannelReadingFacts): ChannelBreach | null {
  // A lookup replaces the limits rather than joining them. See `ChannelReadingFacts.lookup`.
  if (reading.lookup !== null) return fromLookup(reading, reading.lookup);
  if (reading.lookupId !== null) return unresolvedLookup(reading, reading.lookupId);

  const { limits, value } = reading;
  if (!limits.enabled) return null;

  if (limits.upperError !== null && value > limits.upperError) {
    return breach(reading, 'down', 'above', limits.upperError, limits.errorMessage);
  }
  if (limits.lowerError !== null && value < limits.lowerError) {
    return breach(reading, 'down', 'below', limits.lowerError, limits.errorMessage);
  }
  if (limits.upperWarning !== null && value > limits.upperWarning) {
    return breach(reading, 'warning', 'above', limits.upperWarning, limits.warningMessage);
  }
  if (limits.lowerWarning !== null && value < limits.lowerWarning) {
    return breach(reading, 'warning', 'below', limits.lowerWarning, limits.warningMessage);
  }
  return null;
}

function breach(
  reading: ChannelReadingFacts,
  state: Exclude<RollupState, 'up'>,
  direction: 'above' | 'below',
  limit: number,
  custom: string,
): ChannelBreach {
  const severity = state === 'down' ? 'error' : 'warning';
  const shown = format(reading.value, reading.unit, reading.decimals);
  const bound = format(limit, reading.unit, reading.decimals);
  const base = `${reading.name} is ${shown}, ${direction} the ${severity} limit of ${bound}`;
  return {
    key: reading.key,
    name: reading.name,
    state,
    cause: 'limit',
    // The operator's own words go last, after the numbers. "Call the network team" is useless
    // without them and useful with them.
    message: custom === '' ? base : `${base} — ${custom}`,
  };
}

/**
 * §2.2 through a lookup (`M-06`).
 *
 * The message keeps the raw number *and* what it means: "Interface status is 2 (down)". Either
 * alone is worse — the number is what the device said and what a second opinion would check
 * against, the text is what the operator can act on, and a lookup that has been edited since
 * makes the two disagree in a way only the pair can reveal.
 */
function fromLookup(
  reading: ChannelReadingFacts,
  definition: LookupDefinition,
): ChannelBreach | null {
  const match = applyLookup(definition, reading.value);
  if (match.state === 'up') return null;

  const shown = format(reading.value, reading.unit, reading.decimals);
  return {
    key: reading.key,
    name: reading.name,
    state: match.state,
    cause: 'lookup',
    message: match.defined
      ? `${reading.name} is ${shown} (${match.text})`
      : // Naming the lookup, because the fix is to add the value to it and the operator has to
        // know which file to open.
        `${reading.name} is ${shown}, which ${definition.id} does not define`,
  };
}

/**
 * A channel whose lookup this installation has not loaded (`M-06`).
 *
 * Warning, not silence and not a fall back to limits. Silence would let a broken configuration
 * read as healthy, which is the failure the whole lookup path exists to avoid — a sensor that
 * says Up because nothing could judge it is worse than one that says it does not know. Falling
 * back would put a threshold the operator did not intend in charge, and the reason they
 * configured a lookup is that a threshold is the wrong tool for a status code.
 *
 * Not Down, either: the reading arrived and the check succeeded. What is broken is this
 * system's ability to interpret it, and saying the target is down would be a claim nothing
 * supports — the same distinction §2 draws for a lost probe. *Decided by `M-06`.*
 */
function unresolvedLookup(reading: ChannelReadingFacts, lookupId: string): ChannelBreach {
  return {
    key: reading.key,
    name: reading.name,
    state: 'warning',
    cause: 'lookup',
    message:
      `${reading.name} is ${format(reading.value, reading.unit, reading.decimals)}, but the ` +
      `lookup it is judged by (${lookupId}) is not loaded`,
  };
}

/**
 * How many breaches a message names before it stops listing them.
 *
 * A sensor with fifty channels can breach all fifty at once, and a message that lists them all
 * is a message nobody reads and a notification body that gets truncated somewhere downstream.
 */
const MAX_LISTED = 3;

/** What one result's readings were worth, all channels together. */
export interface ChannelOutcome {
  /** §2.2's answer, which `evaluate` combines with the query state. */
  readonly verdict: Verdict;
  /** The sensor message this implies, or empty when nothing breached. */
  readonly message: string;
  /** Every breach, worst first. */
  readonly breaches: readonly ChannelBreach[];
}

export const ALL_CLEAR: ChannelOutcome = {
  verdict: { state: 'up', cause: 'scan' },
  message: '',
  breaches: [],
};

/**
 * The sensor's channel state: the worst of its channels (`M-05`).
 *
 * Rolling up here rather than a layer later is not a shortcut — a result carries every channel
 * the check produced, and a channel's limit cannot be evaluated except against the reading in
 * that same result. §2.3 then combines this single verdict with the query state, which is where
 * the two-step rule lives and where these deliberately do not.
 */
export function rollUp(readings: readonly ChannelReadingFacts[]): ChannelOutcome {
  const breaches: ChannelBreach[] = [];
  for (const reading of readings) {
    const found = evaluateChannel(reading);
    if (found !== null) breaches.push(found);
  }
  if (breaches.length === 0) return ALL_CLEAR;

  breaches.sort((a, b) => ROLLUP_SEVERITY[b.state] - ROLLUP_SEVERITY[a.state]);
  const worst = breaches[0];
  if (worst === undefined) return ALL_CLEAR;

  const listed = breaches.slice(0, MAX_LISTED).map((each) => each.message);
  const remaining = breaches.length - listed.length;
  return {
    verdict: { state: worst.state, cause: worst.cause },
    message:
      remaining === 0
        ? listed.join('; ')
        : `${listed.join('; ')} (and ${String(remaining)} more channel${remaining === 1 ? '' : 's'})`,
    breaches,
  };
}

/**
 * A number an operator reads, not one a machine round-trips.
 *
 * `toFixed` when the channel declares decimals, because that is the operator saying how precise
 * this reading is. Otherwise trim: 0.28700000000000003 is the truth and 0.287 is the answer.
 * Deliberately not `toLocaleString` — the core's locale is whatever the host was installed with,
 * and a threshold message that reads differently on two servers is a bug report.
 */
export function format(value: number, unit: string, decimals: number | null): string {
  const shown =
    decimals === null
      ? String(Number(value.toPrecision(12)))
      : value.toFixed(Math.min(Math.max(decimals, 0), 10));
  return unit === '' ? shown : `${shown} ${unit}`;
}

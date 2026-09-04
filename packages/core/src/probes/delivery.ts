/**
 * Whether a probe that is *connected* is still carrying its sensors (`P-74`).
 *
 * **The gap this closes.** A sensor's state is re-evaluated when a result arrives, and the only
 * two routes to Unknown are an unreachable probe and a sensor that has never been scanned
 * (`state/machine.ts`). Nothing ages a sensor out. So any fault that stops results without
 * dropping the link — a wheel that stopped ticking, a worker pool that latched itself off
 * (`P-62`), an assignment list that never arrived, a bug not yet found — leaves every sensor
 * under that probe frozen in its last state, indefinitely, with no alarm. `CAPABILITIES.MD`
 * already promises Unknown for "a communication error", and `runbook-field-test.md` already
 * lists "a sensor that stopped reporting without its state saying so" as a failure criterion.
 * The implementation was narrower than its own specification.
 *
 * **The clock is the arrival clock, and that is the whole of why this is safe.**
 * `sensor_runtime.last_result_at` is the *check's* timestamp — `writeRuntimes` sets it from
 * `result.at`, which the probe wrote when it ran the check. A probe replaying an hour of spooled
 * results delivers rows stamped an hour ago, so a rule over that column stays an hour behind for
 * the whole catch-up and fires hardest on the probe that is recovering correctly. Nothing here
 * reads it. What is measured is when a batch last *landed*.
 *
 * **The predicate is zero, not "fewer than expected".** A saturated pool, a lagging wheel and a
 * probe deferring half its checks all still ship something, so none of them can trip this. That
 * is deliberate: how *much* a probe is behind is a matter of degree and belongs on Probe Health
 * as a number, while this is the binary question of whether it is delivering at all.
 *
 * **Pure, and separate from anything that reads a database or a clock**, for the reason
 * `state/machine.ts` is: the table-driven tests then drive the rule production uses instead of a
 * second copy of it that could drift.
 */

/**
 * What the sweep knows about one probe.
 *
 * **Ages, not instants** (`P-81`). Every field here used to be a wall-clock `Date` and the rule
 * subtracted them, which `CLAUDE.md` forbids in as many words: *time is monotonic for scheduling,
 * wall-clock for data*. This is a duration, so it is scheduling. A backward step put the reference
 * in the future and the watchdog answered 'delivering' for every probe until wall-clock caught up;
 * a forward step was indistinguishable from that much silence and marked whole probes Unknown.
 * Both are arithmetic on the wrong clock, and neither can happen to a difference of two readings
 * of `process.hrtime.bigint()`.
 *
 * The endpoint computes these when the link is read, because it is the only thing that holds both
 * the stamps and a monotonic clock. The `Date`s it also carries are for display and the API.
 */
export interface DeliveryFacts {
  /**
   * Sensors the core has told this probe to scan.
   *
   * From the assignment list the core computed, which already excludes every pause source, a
   * schedule window, a dependency and the core-evaluated types. So a probe that is legitimately
   * quiet has nothing assigned and the question does not arise — no exclusion logic is restated
   * here, because restating it is how the two would drift.
   */
  readonly assignedSensors: number;
  /**
   * The scan interval this probe was actually given, in seconds — the median across its
   * assignments. A probe scanning every ten seconds and one scanning daily are not the same
   * question, and a single global window would be wrong for both.
   */
  readonly cadenceSeconds: number | null;
  /**
   * Milliseconds since a results batch last **arrived**. Never `result.at`. Null when none has
   * since the core started, or since this probe was last seen at all.
   */
  readonly sinceResultsMs: number | null;
  /**
   * Milliseconds since this probe was last sent its assignments.
   *
   * A probe cannot be late with work it has only just been given, so the window runs from here as
   * well — which covers the config push that follows every reconnect. Null when this session has
   * been sent none, which `configured` below tells apart from "sent none because there are none".
   */
  readonly sinceConfigMs: number | null;
  /**
   * Milliseconds since this probe's current session was established.
   *
   * A probe cannot have been silent for longer than the session it is silent on. Without it the
   * ordinary reconnect — the probe kept its fingerprint, so the core answers `config-unchanged`
   * and stamps nothing — was judged on the core's whole uptime (`P-80`).
   */
  readonly connectedForMs: number;
  /**
   * Whether the core has successfully worked out what this probe should scan, on this session.
   *
   * **`assignedSensors: 0` cannot answer it** (`P-82`). That number is what the core *built*, and
   * on every path where the computation did not happen it is still the empty set a session opens
   * with — which reads exactly like a probe that legitimately has nothing to do. `assignmentsFor`
   * throwing is logged once and the connection is kept, and on a stable installation nothing
   * retries for days: a probe carrying three hundred sensors and checking none of them reported
   * `delivering: 1`, the precise failure this file exists to catch.
   */
  readonly configured: boolean;
  /**
   * Whether this probe is new enough to be sent configuration at all (`R-06`).
   *
   * Separate from `configured` so that one outage stays one alarm: a probe below the config-push
   * version scans nothing, but Probe Health's `protocol` channel already says so with its own
   * lookup, and a second alarm here for the same cause is what `CLAUDE.md` forbids.
   */
  readonly configurable: boolean;
}

export interface DeliveryOptions {
  /** Scan intervals of silence before a connected probe counts as not delivering. 0 disables. */
  readonly intervals: number;
  /** The window never shrinks below this, however fast the probe was told to scan. */
  readonly floorSeconds: number;
  /** Nor grows past it, however slow — a daily sensor must not buy a probe a day of silence. */
  readonly ceilingSeconds: number;
  /**
   * Quiet after the core starts, before any of this applies.
   *
   * `loadRuntimes` restores `probeReachable: true` optimistically and the reachability set starts
   * empty, both deliberately, so that a restart does not generate its own alarm storm. Without a
   * grace this would produce exactly that storm on the way back up.
   */
  readonly graceSeconds: number;
}

/**
 * Four intervals, matching the four the history endpoint already treats as the point past which a
 * reading stops being current. The floor keeps a ten-second sensor from making this hair-trigger;
 * the ceiling keeps a daily one from buying twenty-four hours of silence.
 */
export const DELIVERY_DEFAULTS: DeliveryOptions = {
  intervals: 4,
  floorSeconds: 120,
  ceilingSeconds: 24 * 60 * 60,
  graceSeconds: 120,
};

export type DeliveryReason =
  /** Nothing is assigned, so there is nothing to be late with. */
  | 'nothing-assigned'
  /** Disabled by configuration. */
  | 'disabled'
  /** Too soon after the core started to have an opinion. */
  | 'in-grace'
  /** Something arrived inside the window. */
  | 'delivering'
  /** Assigned work, and nothing has arrived for longer than the window allows. */
  | 'silent'
  /**
   * Connected, and the core never managed to work out what it should scan (`P-82`).
   *
   * A distinct reason because it is a distinct fault with a distinct fix: the probe is fine and
   * the core's own configuration build failed, so the message an operator reads must not send
   * them to the probe host.
   */
  | 'unconfigured'
  /** Below the config-push protocol version, so `R-06`'s `protocol` channel owns this one. */
  | 'too-old';

export interface DeliveryVerdict {
  readonly stalled: boolean;
  readonly reason: DeliveryReason;
  /** How long since anything last arrived, measured from the later of config push and start-up. */
  readonly silentForMs: number | null;
  /** What it was allowed to be. Null when the question did not arise. */
  readonly windowMs: number | null;
}

const NOT_STALLED = (reason: DeliveryReason): DeliveryVerdict => ({
  stalled: false,
  reason,
  silentForMs: null,
  windowMs: null,
});

/**
 * How long this probe may be silent before it is not carrying its sensors.
 *
 * Exported because Probe Health reports it beside the age, and an operator comparing the two
 * needs them to be the same number rather than two computations of the same intent.
 */
export function deliveryWindowMs(
  cadenceSeconds: number | null,
  options: DeliveryOptions = DELIVERY_DEFAULTS,
): number {
  // A probe with no cadence yet — nothing assigned, or assignments not sent — gets the floor.
  // The alternative is a window of zero, which would call every new probe stalled.
  const cadence = cadenceSeconds === null || !Number.isFinite(cadenceSeconds) ? 0 : cadenceSeconds;
  const seconds = Math.min(
    Math.max(cadence * options.intervals, options.floorSeconds),
    options.ceilingSeconds,
  );
  return seconds * 1_000;
}

/**
 * Is this probe still delivering?
 *
 * `coreUptimeMs` is how long this core process has been running, monotonically. The grace is
 * measured against it because the grace exists to stop a restart alarming on probes it has not
 * heard from *yet* — a probe that reconnects an hour later is in nobody's grace period.
 *
 * **Every input is an age, and every age is a monotonic difference**, so none of them can be
 * negative and no clock step can move one (`P-81`). The arithmetic below is the exact dual of the
 * `Math.max` over instants it replaces: the most recent anchor is the *smallest* age.
 */
export function verdict(
  facts: DeliveryFacts,
  coreUptimeMs: number,
  options: DeliveryOptions = DELIVERY_DEFAULTS,
): DeliveryVerdict {
  if (options.intervals <= 0) return NOT_STALLED('disabled');
  // Before anything else, because a probe the core cannot configure is `R-06`'s to report and its
  // `protocol` channel already does — one outage, one alarm (`P-82`).
  if (!facts.configurable) return NOT_STALLED('too-old');

  const graceMs = options.graceSeconds * 1_000;
  if (coreUptimeMs < graceMs) return NOT_STALLED('in-grace');
  const sinceGraceMs = coreUptimeMs - graceMs;

  // **"Nothing assigned" only when we actually worked it out** (`P-82`). An unconfigured session
  // carries the same empty set as a legitimately empty probe, and answering `nothing-assigned` for
  // it is how a probe with three hundred unchecked sensors reported itself as delivering.
  if (facts.configured && facts.assignedSensors <= 0) return NOT_STALLED('nothing-assigned');

  const windowMs = deliveryWindowMs(facts.cadenceSeconds, options);

  // **The most recent of the four, which among ages is the smallest.** Start-up plus grace,
  // because a core that has just come up has not had time to hear from anybody. The config push,
  // because a probe cannot be late with work it was only just given. The session's own start,
  // because a probe cannot be late on a connection that did not exist. And the last arrival, which
  // is the measurement itself. An anchor that has never happened is `Infinity` — not zero, which
  // would read as "just now" and excuse the probe for ever.
  const silentForMs = Math.min(
    sinceGraceMs,
    facts.sinceConfigMs ?? Number.POSITIVE_INFINITY,
    facts.sinceResultsMs ?? Number.POSITIVE_INFINITY,
    facts.connectedForMs,
  );

  // `>` rather than `>=`: "silent for longer than the window" is what the sentence says, and a
  // probe reporting exactly on its own period must not be called late for being punctual.
  if (silentForMs > windowMs) {
    const reason: DeliveryReason = facts.configured ? 'silent' : 'unconfigured';
    return { stalled: true, reason, silentForMs, windowMs };
  }
  return { stalled: false, reason: 'delivering', silentForMs, windowMs };
}

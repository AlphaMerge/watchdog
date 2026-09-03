import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * One probe watching itself, watched by the core (`P-13`, and `P-04`'s other half).
 *
 * **Evaluated by the core, and this is the decision the whole ticket turns on.** The obvious
 * design is a sensor that runs on the probe and reports its own numbers — and it fails at the
 * only moment that matters. `R-05` says a lost probe is **one alarm, not a thousand**: its
 * sensors go Unknown because nobody asked them anything, and the single alarm comes from Probe
 * Health. **A probe cannot report its own absence.** So the core evaluates this, from what it
 * knows (is the link up, how old is the last heartbeat, what protocol does this probe speak) and
 * from what the probe told it while it still could (scheduler lag, pool saturation, spool depth,
 * shipped on the heartbeat since protocol 7).
 *
 * A consequence worth stating: `ProbeReachability` excludes core-evaluated sensors from the set
 * it marks Unknown. Without that, this sensor would be silenced by the very outage it exists to
 * report — and `core.factory` was already being marked Unknown for a probe that never evaluated
 * it, which is how the exclusion was found.
 *
 * **The primary channel is the link**, not scheduler lag. Everything else here is a degree of
 * "working badly"; `connected` is the difference between a probe that is monitoring and one that
 * is not, and it is the channel the one alarm for a lost probe comes from.
 */

const CHANNELS: readonly ChannelDef[] = [
  // 1 or 0 through a lookup rather than a threshold, so the state reads "not connected" instead
  // of "below 0.5" — `M-06`'s rule that a status code is not a measurement.
  {
    key: 'connected',
    name: 'Link to the core',
    isPrimary: true,
    lookup: 'ms.probe.link',
  },
  // Seconds since the last heartbeat. Rises before `connected` falls, which is the window in
  // which an operator can still do something.
  { key: 'heartbeatAge', name: 'Since last heartbeat', unit: 's' },
  {
    key: 'protocol',
    name: 'Protocol version skew',
    lookup: 'ms.probe.protocol',
  },
  // **Only the wheel can measure this**, because only it knows the instant each tick should have
  // run at (`P-01`). p95 rather than the mean: a scheduler is late in bursts.
  {
    key: 'schedulerLag',
    name: 'Scheduler lag (p95)',
    unit: 'ms',
    // The shortest interval a sensor can be given is 10 s (`M-01`), so a p95 lag of a second is
    // 10% of it — late, and not yet wrong. Five seconds is half the shortest interval, at which
    // point a scan is nearly overlapping the next one and the graph's spacing has stopped
    // meaning what it says.
    limits: {
      upperWarning: 1_000,
      upperError: 5_000,
      warningMessage: 'checks are starting late',
      errorMessage: 'checks are starting so late that their spacing is no longer their interval',
    },
  },
  {
    key: 'poolUsage',
    name: 'Worker pool in use',
    unit: '%',
    // The pool grows to its maximum before this stays high (`P-18`), so a sustained 80% is a
    // pool that has already grown as far as it may. At 95% the next burst is deferred checks.
    limits: {
      upperWarning: 80,
      upperError: 95,
      warningMessage: 'the worker pool is nearly full',
      errorMessage: 'the worker pool is full; checks are about to be deferred',
    },
  },
  { key: 'queued', name: 'Checks waiting for a worker', unit: 'checks' },
  { key: 'checkWait', name: 'Wait for a worker (p95)', unit: 'ms' },
  // Skip-if-still-running: the previous scan of that sensor had not finished. Counted, never
  // silent — this is `CLAUDE.md`'s visible backpressure, as a number an operator can alarm on.
  { key: 'deferred', name: 'Checks deferred', unit: 'checks', counter: { bits: 64 } },
  // Worse than deferred: the queue was full and the check was turned away entirely.
  { key: 'refused', name: 'Checks refused', unit: 'checks', counter: { bits: 64 } },
  { key: 'timedOut', name: 'Checks timed out', unit: 'checks', counter: { bits: 64 } },
  { key: 'workerCrashes', name: 'Worker crashes', unit: 'workers', counter: { bits: 64 } },
  { key: 'scheduled', name: 'Sensors scheduled', unit: 'sensors' },
  // Results written to disk and not yet acknowledged. Non-zero is not a fault — it is what a
  // probe does while the core is unreachable — but a number that climbs and never falls is.
  { key: 'spoolDepth', name: 'Results spooled', unit: 'results' },
  { key: 'spoolBytes', name: 'Spool on disk', unit: 'MB' },
  // **The number that must never be a surprise**: readings evicted to stay inside the cap. Every
  // one is a measurement that no longer exists anywhere.
  {
    key: 'spoolDropped',
    name: 'Results dropped',
    unit: 'results',
    counter: { bits: 64 },
    // **The one default that is not a matter of degree.** A counter becomes a rate, so this is
    // results dropped per second, and any rate above zero is measurements that no longer exist
    // anywhere. The bound is below the smallest rate a single drop can produce rather than at
    // zero, because a limit of exactly zero fires on the floating-point residue of a rate that
    // has returned to none.
    limits: {
      upperError: 0.000_01,
      errorMessage: 'the spool is full and readings are being discarded',
    },
  },
  // **Depth cannot tell a stall from a catch-up, which is why this is a separate channel.** A
  // spool with thousands of results in it is a probe replaying an outage, and a threshold on
  // `spoolDepth` would alarm on exactly that — which is why it has none. What is never healthy is
  // a spool holding results with the link *up* and nothing moving, and that is what this counts.
  //
  // It exists because of the defect `615c9f3` fixed: a cursor parked on a segment boundary made
  // `peek` return empty for ever, so the drain read a full spool as "nothing to send". The link
  // stayed up, nothing was logged, and 30,000 results accumulated before anything would have
  // noticed — the only signal that would ever have fired was `spoolDropped`, hours later, once
  // the cap began discarding the evidence.
  {
    key: 'spoolStalled',
    name: 'Spool stalled for',
    unit: 's',
    // **Not a matter of degree**, like `spoolDropped`. The probe reports zero unless it has
    // already waited out its own stall window — five minutes of a connected link and a spool
    // that will not move — so any value here is a stall the probe has itself concluded is real,
    // and a threshold above zero would only delay the alarm further. Below one second rather
    // than at zero, for the same reason as `spoolDropped`: the value is a converted duration and
    // a bound of exactly zero fires on residue.
    limits: {
      upperError: 0.5,
      errorMessage: 'the spool is not draining although the core is reachable',
    },
  },
  { key: 'clockJumps', name: 'Clock jumps', unit: 'jumps', counter: { bits: 64 } },
  { key: 'cpu', name: 'CPU', unit: '%' },
  { key: 'memory', name: 'Memory (resident)', unit: 'MB' },
  { key: 'uptime', name: 'Uptime', unit: 's' },
];

export const probeHealth: SensorType = {
  id: 'ms.probe.health',
  category: 'System',
  costHint: 'light',
  evaluatedBy: 'core',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      probeId: {
        type: 'integer',
        minimum: 1,
        title: 'Probe',
        description:
          'Which probe this reports on. Left unset, it is the probe this sensor sits under — ' +
          'which is what an operator means every time but one, and the exception is a sensor ' +
          'deliberately placed elsewhere so that losing the probe does not also lose the view ' +
          'of it.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return CHANNELS;
  },

  execute(_context: CheckContext): Promise<CheckExecution> {
    // Unreachable unless the assignment filter has been broken, and the failure it would cause is
    // the exact one this type exists to prevent: a probe asked to report on itself says nothing
    // at all when it is the thing that has gone.
    return Promise.reject(
      new Error(
        'Probe Health is evaluated by the core, not by a probe — a probe cannot report its own ' +
          'absence, which is the one thing this sensor is for',
      ),
    );
  },
};

/** The channel keys, in declaration order. Exported so the core cannot drift from the type. */
export const PROBE_HEALTH_CHANNELS: readonly string[] = CHANNELS.map((channel) => channel.key);

/** Which of them are counters, so the core sends `counter` text rather than only a value. */
export const PROBE_HEALTH_COUNTERS: ReadonlySet<string> = new Set(
  CHANNELS.filter((channel) => channel.counter !== undefined).map((channel) => channel.key),
);

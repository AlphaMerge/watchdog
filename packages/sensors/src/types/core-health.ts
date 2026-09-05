import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * The core watching itself (`P-12`).
 *
 * **`CLAUDE.md` makes this a rule rather than a feature**: any subsystem with a queue, a pool or
 * a connection reports here. Every one of them has been adding a `stats()` for exactly this
 * ticket — ingestion (`S-07`), housekeeping (`S-06`), the alarm scheduler (`N-04`), delivery
 * (`N-13`), the live stream (`U-02`), probe reachability (`R-05`) — and this is where those
 * numbers become channels an operator can put a limit on, graph, and be paged about.
 *
 * **Evaluated by the core, like `core.factory` and for the same reason.** The inputs are counters
 * held in this process's memory; shipping them to a probe to be read back would be absurd. So
 * `evaluatedBy: 'core'` keeps it out of every probe's assignment list, and `execute` exists only
 * to fail loudly if that ever stops being true.
 *
 * **What it cannot do, stated rather than implied.** `WORKFLOW.MD §13` says Core Health goes Down
 * when the database is unavailable. This sensor cannot report that *while it is happening*: its
 * reading is a row, its state is a row, and there is nowhere to write either. What it does
 * instead is the more useful half — the queue, the write latency, the notification backlog and
 * the rollup lag all climb *before* a struggling database becomes an unreachable one, and those
 * are readable and alarmable. The live answer during a total outage comes from
 * `GET /api/v1/core-health` and the log, neither of which needs the database.
 *
 * **There is no "config age" channel**, which the ticket asks for and PRTG has. Theirs measures a
 * core that has stopped persisting its configuration file; ours has no such file — configuration
 * is rows in the same database as everything else, written in the transaction that changed them,
 * so there is no separate write that can fall behind. The real risk the number stands in for is a
 * *probe* running configuration older than the core's, which is per-probe and belongs on Probe
 * Health (`P-13`) beside version skew.
 */

/**
 * The channels, declared once and never derived from parameters.
 *
 * **The primary is the ingestion queue**, and choosing it took some thought. It is zero whenever
 * the core is keeping up and climbs whenever anything downstream of a probe is not — a slow
 * database, a full disk, a write that is retrying — which makes it the one number that means
 * "the core is failing at its job" rather than "one of its parts is busy". A health *score* would
 * have been the PRTG answer and is the wrong one here: an opaque 0–100 that nobody can act on,
 * assembled from numbers that each have a meaning of their own.
 *
 * **Three of these are counters, not gauges**, and are declared as such so the core's counter
 * path (`T-02`) turns them into rates. They only ever climb within one process; a restart takes
 * them back to zero, which a 64-bit counter going backwards means — a reset, so a gap rather than
 * a vast negative spike.
 */
const CHANNELS: readonly ChannelDef[] = [
  {
    key: 'ingestQueue',
    name: 'Ingestion queue',
    unit: 'readings',
    isPrimary: true,
    // Zero whenever the core is keeping up. The default queue is 200,000 rows, so a *sustained*
    // fifth of it is a database that has stopped keeping pace rather than a busy minute — and
    // half of it is close enough to refusals that somebody should be looking already.
    limits: {
      upperWarning: 40_000,
      upperError: 100_000,
      warningMessage: 'readings are arriving faster than they are being written',
      errorMessage: 'the ingestion queue is close to refusing batches; check the database',
    },
  },
  { key: 'writeLatency', name: 'Database write time (p95)', unit: 'ms' },
  {
    key: 'ingestRefused',
    name: 'Readings refused',
    unit: 'readings',
    counter: { bits: 64 },
  },
  { key: 'cpu', name: 'CPU', unit: '%' },
  { key: 'memory', name: 'Memory (resident)', unit: 'MB' },
  // Separate from resident memory because it moves first: a leak in JavaScript shows in the heap
  // while the resident set is still flat, and the two diverging is the shape of a native one.
  { key: 'heap', name: 'Heap in use', unit: 'MB' },
  // In seconds so `M-11`'s threshold triggers can say "when uptime < 600", which is how `T-05`
  // established that a restart is detected. Transition detection would need the core to remember
  // a previous value and would miss a restart that happened while the sensor was Down.
  { key: 'uptime', name: 'Uptime', unit: 's' },
  // The rollup number that goes wrong first and silently (`S-06`). Worst of the tiers rather than
  // one channel each: a single tier falling behind is the fault, and which one it is belongs in
  // the message.
  {
    key: 'rollupLag',
    name: 'Rollup lag (worst tier)',
    unit: 's',
    // The rollup runs every housekeeping pass, so an hour behind is several passes that did not
    // finish. A day behind is a graph that is wrong at every zoom level above raw, which is
    // exactly the failure this channel exists to catch before somebody reports it as missing
    // data.
    limits: {
      upperWarning: 3_600,
      upperError: 86_400,
      warningMessage: 'the rollups are behind; older graphs are stale',
      errorMessage: 'the rollups are a day behind; summarised graphs are wrong',
    },
  },
  { key: 'backfillQueue', name: 'Rollup backfill queue', unit: 'windows' },
  // **The disk the readings are on** (`S-17`), which until that ticket nothing in this system
  // knew anything about. A percentage rather than bytes for the alarm, because a threshold in
  // gigabytes is wrong on every installation but the one it was written for; the bytes are here
  // too, because "12% free" is not something an operator can act on without knowing of what.
  //
  // A **gap** on a core whose database is on another host: that core is not looking at a full
  // disk, it is not looking at the disk, and a zero here would raise exactly the alarm this
  // exists to make meaningful.
  {
    key: 'diskFree',
    name: 'Free disk space',
    unit: '%',
    // Lower limits, which is the whole reason `S-18`'s declaration has them: on this channel the
    // fault is *below*. Ten percent is where `housekeeping.disk` begins evicting the oldest
    // readings ahead of their retention, so the error limit and the eviction threshold are the
    // same event — the alarm and the action agree by construction rather than by coincidence.
    limits: {
      lowerWarning: 20,
      lowerError: 10,
      warningMessage: 'the disk holding the readings is filling',
      errorMessage: 'the disk is nearly full; the oldest readings are being evicted early',
    },
  },
  { key: 'diskFreeBytes', name: 'Free disk space', unit: 'MB' },
  // What this installation's own database occupies. The number that answers "is it us", which is
  // the first question when a shared volume fills.
  { key: 'databaseSize', name: 'Database size', unit: 'MB' },
  // **Never a rounding error.** Every one of these is a reading somebody asked us to keep for
  // longer than we kept it (`S-17`). A counter, so the counter path turns it into a rate: what
  // matters is not that an eviction happened once during an incident but that it is still
  // happening.
  {
    key: 'evictedChunks',
    name: 'Chunks evicted early',
    unit: 'chunks',
    counter: { bits: 64 },
    limits: {
      // As with `spoolDropped`: any rate above zero is data that was promised and is gone, and a
      // bound of exactly zero fires on the floating-point residue of a rate returning to none.
      upperError: 0.000_01,
      errorMessage: 'readings are being evicted ahead of their retention to keep the disk writable',
    },
  },
  { key: 'reapQueue', name: 'Channels awaiting reap', unit: 'channels' },
  { key: 'notifyPending', name: 'Notifications undelivered', unit: 'notifications' },
  // The one that goes wrong first when a relay dies: the count stays small while the age climbs.
  {
    key: 'notifyOldest',
    name: 'Oldest undelivered notification',
    unit: 's',
    // On the age rather than on the count, because that is what goes wrong first when a relay
    // dies: the count stays small and the age climbs. Fifteen minutes is longer than any
    // ordinary retry sequence; an hour is an alarm nobody has received and probably will not.
    limits: {
      upperWarning: 900,
      upperError: 3_600,
      warningMessage: 'an alarm has been waiting to be delivered',
      errorMessage: 'an alarm has been undelivered for an hour; check the relay',
    },
  },
  { key: 'notifyFailed', name: 'Notifications given up on (1 h)', unit: 'notifications' },
  {
    key: 'streamCutoffs',
    name: 'Live subscribers cut off',
    unit: 'subscribers',
    counter: { bits: 64 },
  },
  // A count that climbs steadily means a master is flapping — the alarm storm dependencies exist
  // to prevent, showing up as churn instead (`M-11`).
  {
    key: 'dependencyPauses',
    name: 'Dependency pauses',
    unit: 'sensors',
    counter: { bits: 64 },
  },
  { key: 'probesDown', name: 'Probes not connected', unit: 'probes' },
  // **Connected, and carrying nothing** (`P-74`, surfaced by `P-80`). Distinct from the line
  // above, which is a link that is gone: this is a probe whose session is up and heartbeating
  // while no results arrive, and folding the two together made Core Health say 'not connected'
  // about a probe whose own Probe Health said it was. No limit — the per-probe alarm is
  // `ms.probe.delivery` on that probe's own sensor, and a second one here for the same outage is
  // what `CLAUDE.md` forbids. This is the installation-wide number an operator reads beside it.
  { key: 'probesSilent', name: 'Probes not delivering', unit: 'probes' },
  // **The alarm scheduler's own two numbers** (`P-22`). It had a `stats()` like every other
  // subsystem and nothing read it, which is how a counter that was wrong stayed wrong through
  // `P-12` — `P-20` found it by hand.
  //
  // Overdue rather than `nextWakeAt`, because a channel holds a number and a timestamp would
  // have to be read against the clock by whoever looked. Zero whenever the scheduler is asleep
  // with a wake still ahead of it, which is almost always; anything else is a sweep that should
  // have happened and has not, and it climbs by a second a second until somebody notices.
  {
    key: 'alarmOverdue',
    name: 'Alarm sweep overdue by',
    unit: 's',
    // Zero whenever the scheduler is asleep with a wake still ahead of it, which is almost
    // always. Anything sustained is a sweep that should have happened, and every second of it is
    // a second an escalation is not escalating.
    limits: {
      upperWarning: 60,
      upperError: 300,
      warningMessage: 'the alarm sweep is late',
      errorMessage: 'the alarm sweep has not run; escalations are not firing',
    },
  },
  // A counter, so the counter path turns it into alarms-per-minute — which is the number an
  // alarm storm shows up in. `M-17` is a scenario test for the same rule; this is the rule
  // visible on a graph while it is happening.
  {
    key: 'alarmsFired',
    name: 'Notification steps fired',
    unit: 'steps',
    counter: { bits: 64 },
  },
  // `R-09`'s bound, which is the only part of it an operator needs on a graph. In-flight is a
  // number that is zero except while somebody is looking at it, and the counters for answered
  // and timed-out queries say the same thing the checks themselves already do. What is worth
  // seeing is the refusals: `CLAUDE.md` requires backpressure to be visible, and a rising line
  // here is a bound somebody has to raise rather than a spinner they keep retrying.
  {
    key: 'queriesRefused',
    name: 'On-demand checks refused',
    unit: 'queries',
    counter: { bits: 64 },
  },
  // `P-99`. A result stamped far in the future is refused rather than stored, because storing
  // one freezes that sensor's history for ever — `last_result_at` is a high-water mark, and
  // everything genuine after it reads as stale. Refusing it fixes the freeze; this channel is
  // what stops the refusal being the new silence. `CLAUDE.md`: never drop without counting.
  //
  // A rising line here is one probe host with a wrong clock, and it names a fix an operator can
  // carry out. Zero on every healthy installation, which is what makes any movement worth
  // looking at.
  {
    key: 'resultsFutureDated',
    name: 'Results refused as future-dated',
    unit: 'results',
    counter: { bits: 64 },
  },
  // `P-157`. Alarm reactions held back because the batch that carried them was a probe replaying
  // its spool: they are folded into the first batch that is not, which is what stops an outage
  // that began during a drain going unalarmed. `CLAUDE.md`: nothing is deferred silently.
  //
  // **A gauge, not a counter, and that is the whole value of it.** It rises during a drain and
  // returns to zero when the drain ends. One that stays up is a probe that never reports itself
  // caught up — a slow clock on a probe that does not report its backlog — and every sensor
  // counted here has an alarm that is not armed.
  {
    key: 'reactionsDeferred',
    name: 'Alarm reactions waiting on a catch-up',
    unit: 'sensors',
  },
];

export const coreHealth: SensorType = {
  id: 'ms.core.health',
  category: 'System',
  // Counters this process already holds, plus two small queries. No network round trip.
  costHint: 'light',
  evaluatedBy: 'core',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    // Deliberately none. Every channel is a fact about this core, not a choice an operator makes;
    // what to alarm on is a limit on a channel, which is visible and editable, rather than a
    // parameter baked in at creation.
    properties: {},
  },

  channels(): readonly ChannelDef[] {
    return CHANNELS;
  },

  execute(_context: CheckContext): Promise<CheckExecution> {
    // Unreachable unless the assignment filter has been broken. Loud rather than silent: a Core
    // Health sensor that started being scanned by a probe would report Down for ever, and the
    // probe has none of these numbers to report.
    return Promise.reject(
      new Error(
        'Core Health is evaluated by the core, not by a probe — this sensor should never have ' +
          'been assigned to one, and something is wrong with the probe configuration path',
      ),
    );
  },
};

/** The channel keys, in declaration order. Exported so the core cannot drift from the type. */
export const CORE_HEALTH_CHANNELS: readonly string[] = CHANNELS.map((channel) => channel.key);

/** Which of them are counters, so the core sends `counter` text rather than only a value. */
export const CORE_HEALTH_COUNTERS: ReadonlySet<string> = new Set(
  CHANNELS.filter((channel) => channel.counter !== undefined).map((channel) => channel.key),
);

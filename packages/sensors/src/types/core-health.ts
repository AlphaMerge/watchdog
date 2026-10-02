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
  // **How much the core's machine has left** (`P-208`), beside what the core holds. Probe Health
  // carries the same pair, and on the default installation — a local probe beside the core — the
  // two read the same machine. This one is for the core that has no probe beside it: every probe
  // remote, and the host running PostgreSQL, which is the largest tenant of memory there is.
  //
  // **This one owns the machine where both could report it** (`M-21`): the local probe's pair
  // gaps, so one squeeze on a single-host install is one sensor Down, and it is this one.
  // `MemAvailable` on Linux, the lowest in the last thirty seconds, a gap where the platform
  // cannot say; `packages/shared/src/process/machine-memory.ts` says why for each.
  {
    key: 'memoryAvailable',
    name: 'Memory available',
    unit: '%',
    // The same limits as Probe Health's, for the same measured reasons: `P-206` saw 8.5% fall to a
    // kernel kill in six seconds, so the error sits at 10%, and the runs that machine survived
    // bottomed out between 9.9 and 23.4% with swap gone, so the warning sits at 20%.
    limits: {
      lowerWarning: 20,
      lowerError: 10,
      warningMessage: "the core's machine is running low on memory",
      errorMessage: "the core's machine is nearly out of memory; the kernel may kill a process",
    },
  },
  { key: 'memoryAvailableBytes', name: 'Memory available', unit: 'MB' },
  // **How close the core is to the ceiling its own service sets** (`P-210`): the lower of
  // `ms-core.service`'s `MemoryHigh` and `MemoryMax` — `MemoryMax=8G` alone on the stock unit
  // (`P-213`) — against the working set. Probe Health's pair argues each choice;
  // `packages/shared/src/process/limit-memory.ts` has the measurements.
  {
    key: 'memoryLimitUsage',
    name: 'Memory used of its limit',
    unit: '%',
    // **Past 100% is the error for the same measured reason as Probe Health's**, and only a
    // `MemoryHigh` an operator has set can be stood above: the kernel throttles the core there to
    // a standstill. At the stock `MemoryMax` it kills. **The warning is Probe Health's 80% too**,
    // and the reason is weaker here, so it is stated as such: the probe's start-up surge is the
    // only one measured, and nobody has measured the core's — a second number would be a guess.
    limits: {
      upperWarning: 80,
      upperError: 100,
      warningMessage: 'the core is nearing its memory limit',
      errorMessage: 'the core is past its memory limit; the kernel is throttling it',
    },
  },
  { key: 'memoryLimit', name: 'Memory limit', unit: 'MB' },
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
  // `P-226`. Of the queue above, the entries that have failed three times and are parked: they no
  // longer hold compression and retention back, and are tried again an hour later and daily after
  // that. Until one succeeds, the summarised graphs for its window leave out the readings that
  // arrived late. **Any is the warning**, because nothing parks on a healthy installation. The
  // entry's own error is in the sensor's message; a limit's message cannot carry it.
  {
    key: 'backfillParked',
    name: 'Rollup backfills parked',
    unit: 'windows',
    limits: {
      upperWarning: 0,
      warningMessage:
        'a rollup backfill keeps failing; summarised graphs are missing readings that arrived late',
    },
  },
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
  // **Changes to a probe's link or report that were folded into one frame** (`U-24`). The frame
  // says "ask again" and carries nothing, so folding loses nothing — but it is the stream
  // declining to queue, and that is counted. A rate that stays up is a probe whose link is
  // flapping, or a browser that has stopped reading what it is sent.
  {
    key: 'streamCoalesced',
    name: 'Live probe changes folded together',
    unit: 'changes',
    counter: { bits: 64 },
  },
  // **Live sockets closed because what authenticated them no longer does** (`A-34`), one channel
  // per reason, because the reasons mean different things to whoever reads them: sessions ending
  // and expiring are an ordinary day, while a burst of revoked tokens or disabled accounts is
  // somebody responding to an incident — and this is where they see it reach the open screens.
  {
    key: 'streamEnded',
    name: 'Live sockets signed out: session ended',
    unit: 'sockets',
    counter: { bits: 64 },
  },
  {
    key: 'streamExpired',
    name: 'Live sockets signed out: expired',
    unit: 'sockets',
    counter: { bits: 64 },
  },
  {
    key: 'streamRevoked',
    name: 'Live sockets signed out: token revoked',
    unit: 'sockets',
    counter: { bits: 64 },
  },
  {
    key: 'streamDisabled',
    name: 'Live sockets signed out: account disabled',
    unit: 'sockets',
    counter: { bits: 64 },
  },
  // The check that closes them, failing (`A-34`). A failed check closes nothing, so without this
  // a stream that has stopped being checked looks exactly like one where nobody signed out.
  {
    key: 'streamCheckFailures',
    name: 'Live socket sign-in checks failed',
    unit: 'checks',
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
  // `E-08`. A report is the longest-running thing the core does, so its sweep is a pool with a
  // queue and `CLAUDE.md` says one of those reports here. **Two lines rather than one**, because
  // they mean different things to whoever is looking: a rising `reportsDeferred` is an
  // installation that has scheduled more reports than it can render and needs fewer or a bigger
  // bound, while a rising `reportsFailed` is one report that is broken — a security context that
  // was disabled, a span that resolves to nothing, a document over the cell limit. Collapsing
  // them into "report problems" would name neither fix.
  {
    key: 'reportsDeferred',
    name: 'Scheduled reports deferred',
    unit: 'reports',
    counter: { bits: 64 },
  },
  {
    key: 'reportsFailed',
    name: 'Report runs failed',
    unit: 'runs',
    counter: { bits: 64 },
  },
  // `E-09`. **A gauge, not a counter**, and that is the difference that makes it useful: the
  // question is "how many reports are stuck right now", which a rate cannot answer. A relay that
  // has been down for an hour shows a line climbing and then falling back to zero when it
  // recovers; a counter would show a step nobody can tell apart from a step last week.
  {
    key: 'reportsUndelivered',
    name: 'Reports waiting to be delivered',
    unit: 'reports',
  },
  // `P-204`. Report formatting runs in a small worker pool, off the event loop, with a bounded
  // queue — so it has the two lines every queue here has. **A gauge for what is waiting**, because
  // "a big report is formatting and three more are behind it" is a state rather than a rate; **a
  // counter for what was refused**, because a render that was turned away is gone, and the person
  // who pressed the button is the only other one who knows.
  {
    key: 'reportFormatsWaiting',
    name: 'Report formats waiting',
    unit: 'formats',
  },
  {
    key: 'reportFormatsRefused',
    name: 'Report formats refused',
    unit: 'formats',
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
  // `P-231`. The other way: stamped further back than anything here is kept, which is ten years
  // by default and no genuine replay reaches. A device with no RTC that boots at 1970, a VM
  // restored from an old snapshot. No limit, for the same reason as above; the probe it came
  // from has its own channel, which does.
  {
    key: 'resultsPastDated',
    name: 'Results refused as too old',
    unit: 'results',
    counter: { bits: 64 },
  },
  // `P-247`. Results whose timestamp is not a date at all, dropped whole: the state machine is a
  // fold over time and cannot place them. Our probe stamps every result with `toISOString`, so
  // anything here is a broken build or a hostile one, and what it drops is most often a failed
  // check, the one result a batch most needs to carry. Before this it was counted nowhere.
  {
    key: 'resultsUnreadableTime',
    name: 'Results dropped for an unreadable time',
    unit: 'results',
    counter: { bits: 64 },
    limits: {
      upperWarning: 0,
      warningMessage:
        'results are being dropped because their time cannot be read: a probe is sending malformed timestamps',
    },
  },
  // `P-247`. How far this core's clock is behind every remote probe's, when two or more are
  // connected: the smallest lead among them, 0 when any is not ahead, and a gap with fewer than two,
  // since one probe ahead cannot be told from one probe wrong. **The core's condition, not theirs**:
  // while this is over a minute, each Probe Health's clock warnings gap and its sentence names the
  // offset instead, as `M-21` does for memory. One fault, one alarm, on the machine at fault.
  //
  // **The error is at fifteen minutes because that is where ingestion refuses everything**
  // (`DEFAULT_MAX_FUTURE_SKEW_MS`, `P-99`): every remote probe's results are then future-dated to
  // this core, every sensor on them holds its last state, and a real outage cannot alarm.
  {
    key: 'clockBehind',
    name: 'Clock behind the probes',
    unit: 's',
    limits: {
      upperWarning: 60,
      upperError: 900,
      warningMessage:
        "this core's clock is behind every probe's by more than a minute; check time sync on the core's host",
      errorMessage:
        "this core's clock is so far behind that every probe's results are refused as future-dated; no sensor on a remote probe is being updated",
    },
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
  // `A-43`. Credential sets holding a key their kind does not declare, which only a set written
  // before writes were checked against the kind can: possibly a secret under a mistyped name,
  // stored in the clear. No read returns it. Re-entering the set removes it, and this falls with
  // each one re-entered. **Any is the warning**: it names a job for an operator, and the core log
  // says which sets, once, at start-up.
  {
    key: 'credentialsToReenter',
    name: 'Credential sets to re-enter',
    unit: 'sets',
    limits: {
      upperWarning: 0,
      warningMessage:
        'a credential set holds keys its kind does not declare; re-enter it (the core log says which)',
    },
  },
  // `A-41b`. Credential sets with no allowed targets and no SSH host keys: each goes wherever
  // somebody with `write` on the object it is stored on vouches for, which is trust in every one of
  // them with it. A number to read and bring down, with no limit: most installations start with
  // every set here, and a warning from the first reading would teach everyone to ignore it.
  {
    key: 'credentialsUnbounded',
    name: 'Credential sets without targets',
    unit: 'sets',
  },
  // `A-41c`. Sensors not being scanned because of their credentials: withheld from their probe by
  // the core, for who vouched for them or for what bounds the set, and refused by a probe that
  // found a device's name resolving outside the set's targets. Each reads Unknown and says why on
  // its own page; this is how many there are, which nothing else says in one place. No limit: a
  // set narrowed on purpose leaves some here for good, and the Unknown trigger pages for the rest.
  {
    key: 'credentialsWithheld',
    name: 'Sensors withheld for credentials',
    unit: 'sensors',
  },
  // `A-68`. Writes of the late-refusal record that were not made when they were due: the
  // statement gave way for a lock or for time, a configuration stopped waiting for it, or it
  // failed. Each is made again at the probe's next configuration or within the minute, and the
  // running core judges by what it holds in memory, so nothing is wrong while it runs: what one
  // costs is a core restarted before the write is made, which then reads a late refusal as a
  // failed scan. A counter with no limit and no lookup, so no state and no alarm: a delete of a
  // group makes a few on purpose. A rate that stays up is a database these writes cannot get
  // into, which until this was a line in the log and no number.
  {
    key: 'lateRefusalWritesGivenUp',
    name: 'Late-refusal record writes given up',
    unit: 'writes',
    counter: { bits: 64 },
  },
  // **Log lines the core could not write since the last reading** (`P-216` part 3): refused at its
  // output's eight-megabyte bound while the journal was not reading, or lost to an output that
  // closed. A count per reading, not a running total and not a counter's rate: a total would warn
  // for ever after one stall, and a rate gaps on the first reading after a restart, which is the
  // one covering the stall that caused it. **With a local probe it counts that probe's lines too**:
  // both write to one journal, and a journal that stops reading is one alarm, Core Health's, as
  // the machine's memory is (`M-21`). The local probe's own channel gaps.
  {
    key: 'logDropped',
    name: 'Log lines dropped',
    unit: 'lines',
    limits: {
      upperWarning: 0,
      warningMessage:
        'log lines are being dropped: the journal is not keeping up with what the services write',
    },
  },
  // What the output holds that the journal has not taken, up to the bound. No limit:
  // `logDropped` is the alarm, and this is how close the next stall is to it.
  { key: 'logBacklog', name: 'Log waiting to be written', unit: 'MB' },
  // **Requests refused for a `Host` this core does not answer to** (`A-47`), since the last
  // reading. No limit: a scanner produces these all day, and so does the one operator whose name
  // for the core is not in `api.allowedHosts` yet — who is told why in the answer itself. What the
  // line is for is the second case showing up as a step, when a DNS name or a proxy changes.
  { key: 'hostsRefused', name: 'Requests refused for an unknown Host', unit: 'requests' },
  // **Requests the per-client rate limit refused** (`A-39`), since the last reading. **Any is the
  // warning**: the limit is a backstop nobody using the web UI meets, so a refusal is a runaway
  // loop, an enumeration, or a provisioning script that needs `api.rateLimitPerMinute` raised or
  // `POST /objects/tree` used instead. The log names the client.
  {
    key: 'rateLimited',
    name: 'Requests refused by the rate limit',
    unit: 'requests',
    limits: {
      upperWarning: 0,
      warningMessage:
        'a client is being refused by the rate limit; if it is a script that needs more, raise ' +
        'api.rateLimitPerMinute or have it build with POST /objects/tree',
    },
  },
  // **Heartbeats that were due and did not arrive** (`H-18`), since the last reading: refused by
  // the receiver, timed out, not connected, or withheld because the housekeeping pass that sends
  // them failed. **Any is the warning**: the receiver is what reports a stopped core, and it is
  // about to report this one. A gap where no `heartbeat.url` is set, which is the default.
  {
    key: 'heartbeatFailures',
    name: 'Heartbeats that did not arrive',
    unit: 'requests',
    limits: {
      upperWarning: 0,
      warningMessage:
        'the heartbeat is not reaching its receiver, which will report this core as stopped; ' +
        'the core log says why',
    },
  },
];

export const coreHealth: SensorType = {
  id: 'ms.core.health',
  category: 'System',
  // Counters this process already holds, plus two small queries. No network round trip.
  costHint: 'light',
  evaluatedBy: 'core',
  // Its channels are the installation's own figures — queue depths, every probe's connection,
  // the database — which `/core-health` gives only to an account that can read the root. A sensor
  // anybody could put on a group they write would publish all of it there (`A-29`).
  requires: 'installation',

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

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
  // **A probe can be connected, heartbeating and monitoring nothing** (`P-74`). Nothing ages a
  // sensor out — the core re-evaluates when a result arrives — so a fault that stops results
  // without dropping the link freezes every sensor under this probe in its last state for ever.
  // `connected` above cannot see it, because the link is fine. This is the channel that can.
  { key: 'delivering', name: 'Sending results', lookup: 'ms.probe.delivery' },
  // How long since anything arrived. No limit: the lookup above is the alarm, and a second one
  // for one outage is what `CLAUDE.md` forbids.
  { key: 'resultAge', name: 'Since last result', unit: 's' },
  // **The half the core cannot see** (`P-76`). `delivering` above asks whether anything is coming
  // back at all, which is a question about arrivals and so the core's to answer. This asks whether
  // the checks the probe *dispatched* are settling — visible only on the probe, where dispatch and
  // completion sit on one thread against a monotonic clock. Warning, not Down: the probe is
  // working, and part of what it carries is not being checked.
  { key: 'checksCompleting', name: 'Checks settling', lookup: 'ms.probe.checks' },
  // How much of the probe is affected, which the state above cannot say. No limit: one outage,
  // one alarm, and the lookup is already it.
  { key: 'checksBehind', name: 'Sensors behind schedule', unit: 'sensors' },
  // **The two numbers that say how bad, beside the one that says whether** (`P-79`). The probe
  // has always measured and sent these; nothing on this side read them, so an operator got a
  // Warning saying checks had stopped settling and no way to see how many were stuck or for how
  // long. No limits on either: `checksCompleting` above is the alarm, and a second one for the
  // same outage is the thing `CLAUDE.md` forbids.
  { key: 'checksOutstanding', name: 'Checks in flight', unit: 'checks' },
  {
    key: 'checkStalled',
    name: 'Oldest check waiting',
    // Seconds, like `spoolStalled` and for the same reason: every other duration an operator
    // reads on this sensor is in seconds, and one in milliseconds beside them is misread once.
    unit: 's',
  },
  {
    key: 'protocol',
    name: 'Protocol version skew',
    lookup: 'ms.probe.protocol',
  },
  // **What the core refused from this probe** (`P-228`). A probe may report on the sensors under
  // it, answer the queries put to it and progress the discovery runs dispatched to it, and the
  // core now refuses anything else where it arrives. Both are the core's own numbers, like the
  // link's, so they read on a probe of any version.
  //
  // Every refusal, with no limit: most are ordinary. A sensor moved to another probe, or deleted,
  // while this one's spool still held results for it is the probe lagging a change the core has
  // already made, and a warning on it would turn every move into an alarm on the probe it moved
  // away from.
  { key: 'reportsRefused', name: 'Reports refused', unit: 'reports', counter: { bits: 64 } },
  // The ones no correct probe sends: a sensor that was never under it, a query put to another
  // probe, another probe's discovery run. **A count over the last five minutes, not a counter**,
  // because a rate needs the reading before it, and the first reading after a core restart or a
  // reconnect has none — which is exactly when a probe that should not be doing this would. It
  // falls back to zero five minutes after the last one, which is what clears the warning.
  {
    key: 'reportsForeign',
    name: 'Reports on work never given to it (5 min)',
    unit: 'reports',
    limits: {
      upperWarning: 0.5,
      warningMessage:
        'this probe reported on sensors, queries or discovery runs that were never given to it',
    },
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
  // **Whole ticks the wheel never visited** (`P-79`) — the other half of the lateness story, and
  // measured only by the wheel. `schedulerLag` says how late a tick was; this says how many
  // vanished entirely because the process was off-CPU for longer than a tick. The checks in them
  // were coalesced onto a later pass, so their spacing is not their interval any more. No limits:
  // `schedulerLag` beside it is the alarm, and this is what an operator reads to see why.
  { key: 'skippedTicks', name: 'Ticks skipped', unit: 'ticks', counter: { bits: 64 } },
  {
    key: 'poolUsage',
    name: 'Worker pool in use',
    unit: '%',
    // The pool grows to its ceiling before this stays high (`P-18`), so a sustained 80% is a
    // pool that has already grown as far as it may. At 95% the next burst is deferred checks.
    //
    // **"As far as it may" moved** (`P-34`): the ceiling is derived from the checks the probe
    // was actually assigned, so a sustained reading now means the probe has already tried to
    // help itself and either `workerPoolSize` is pinned or the workload outgrew what a probe
    // derives on its own. `docs/troubleshooting.md` has the two remedies.
    //
    // **This is `busy / held`, not `busy / ceiling`**, which is what makes it survive a moving
    // ceiling at all: a pool that cannot keep up has every worker it holds busy, whatever the
    // ceiling says. The failure `P-34` could introduce — a derived ceiling too low — therefore
    // shows up here rather than needing a signal of its own. It is also why the *transient* 100%
    // of a pool that is about to grow is not an alarm, and only a sustained reading is.
    limits: {
      upperWarning: 80,
      upperError: 95,
      warningMessage: 'the worker pool is nearly full',
      errorMessage: 'the worker pool is full; checks are about to be deferred',
    },
  },
  {
    key: 'sessionsOpen',
    name: 'Device sessions held',
    unit: 'sessions',
    // No threshold: how many SNMP and SSH sessions a probe should hold is a property of the
    // catalogue it was given, not of health. A hundred is ordinary for a probe watching a
    // hundred devices and alarming would be noise. What is never healthy is the *bound* being
    // passed, and that is `sessionOverflows`.
  },
  {
    key: 'sessionOverflows',
    name: 'Sessions opened past the bound',
    unit: 'sessions',
    counter: { bits: 64 },
    // **Any value above zero is worth a look, so the error sits just above it** — the style
    // `spoolDropped` uses, and for the same reason: this is not a matter of degree.
    //
    // The pools open past `maxSessions` rather than fail a check, which is the right trade —
    // refusing would fail a check to protect a file-descriptor budget. It is only defensible
    // while somebody can see it happening, which until `P-36` nobody could: the counter existed
    // and `stats()` was read by nothing outside its own tests. Sustained overflow is a probe
    // heading for `EMFILE`, and the remedy is a longer `idleMs`, fewer devices per probe, or a
    // higher bound.
    limits: {
      upperError: 0.5,
      errorMessage: 'device sessions are being opened past the pool bound',
    },
  },
  {
    key: 'sessionsEvicted',
    name: 'Sessions closed when idle',
    unit: 'sessions',
    counter: { bits: 64 },
    // No threshold, and it is the diagnostic half of the pair above. Eviction climbing in step
    // with `sessionsOpened` is a pool whose `idleMs` is shorter than the scan interval, so every
    // check pays a handshake it need not — expensive on SSH, and invisible without this.
  },
  // **The other half of the comment above** (`P-79`). It described reading eviction against
  // openings, and `sessionsOpened` was measured, sent, and read by nothing on this side — so the
  // diagnosis it names was one an operator could not actually make. No threshold, for the same
  // reason as its pair: a pool that opens sessions is a pool doing its job.
  { key: 'sessionsOpened', name: 'Sessions opened', unit: 'sessions', counter: { bits: 64 } },
  { key: 'queued', name: 'Checks waiting for a worker', unit: 'checks' },
  { key: 'checkWait', name: 'Wait for a worker (p95)', unit: 'ms' },
  // Skip-if-still-running: the previous scan of that sensor had not finished. Counted, never
  // silent — this is `CLAUDE.md`'s visible backpressure, as a number an operator can alarm on.
  { key: 'deferred', name: 'Checks deferred', unit: 'checks', counter: { bits: 64 } },
  // Worse than deferred: the queue was full and the check was turned away entirely.
  { key: 'refused', name: 'Checks refused', unit: 'checks', counter: { bits: 64 } },
  { key: 'timedOut', name: 'Checks timed out', unit: 'checks', counter: { bits: 64 } },
  { key: 'workerCrashes', name: 'Worker crashes', unit: 'workers', counter: { bits: 64 } },
  // **The alarm for a probe that is up and monitoring nothing** (`P-62`). The pool latches itself
  // off after repeated worker start failures and runs nothing until the probe restarts, while the
  // link stays connected and `poolUsage` reads 0% — a quiet night, as far as every other channel
  // here is concerned. Every sensor under that probe then holds its last state indefinitely,
  // because the core re-evaluates on an arriving result and none arrive.
  { key: 'poolState', name: 'Worker pool', lookup: 'ms.probe.pool' },
  // What the failure cost, which the state above cannot say. **No limit, deliberately**: the
  // lookup already turns this sensor Down for exactly this cause, and a second alarm for one
  // outage is the thing `CLAUDE.md` forbids. This is the number an operator reads afterwards.
  { key: 'discarded', name: 'Checks discarded', unit: 'checks', counter: { bits: 64 } },
  // **The listeners (`P-64`), and none of these carries a limit.** An allow-list exists in order
  // to reject and a public UDP port collects junk, so a threshold above zero would alarm on
  // correct configuration. Their value is diagnostic: they turn "my trap sensor reads zero" into
  // "the probe rejected four hundred in the last minute", which is the difference between a quiet
  // network and a receiver refusing everything a device sends it.
  { key: 'trapReceived', name: 'Traps received', unit: 'traps', counter: { bits: 64 } },
  { key: 'trapRejected', name: 'Traps rejected', unit: 'traps', counter: { bits: 64 } },
  { key: 'trapMalformed', name: 'Traps malformed', unit: 'traps', counter: { bits: 64 } },
  { key: 'syslogReceived', name: 'Syslog received', unit: 'messages', counter: { bits: 64 } },
  { key: 'syslogRejected', name: 'Syslog rejected', unit: 'messages', counter: { bits: 64 } },
  { key: 'syslogMalformed', name: 'Syslog malformed', unit: 'messages', counter: { bits: 64 } },
  // **The flow collector (`B-02`), and one of these is unlike everything else on this sensor.**
  // `flowMissed` counts what did *not* arrive — read out of the exporter's own running sequence,
  // which is the only evidence there is, because UDP drops silently. Without it a collector losing
  // a third of its flows to a saturated link is indistinguishable from a quiet network.
  { key: 'flowReceived', name: 'Flows received', unit: 'flows', counter: { bits: 64 } },
  { key: 'flowRejected', name: 'Flows rejected', unit: 'flows', counter: { bits: 64 } },
  {
    key: 'flowMalformed',
    name: 'Flow datagrams malformed',
    unit: 'datagrams',
    counter: { bits: 64 },
  },
  { key: 'flowMissed', name: 'Flows missed', unit: 'flows', counter: { bits: 64 } },
  {
    key: 'flowUndecodable',
    name: 'Flow records with no template',
    unit: 'records',
    counter: { bits: 64 },
  },
  { key: 'scheduled', name: 'Sensors scheduled', unit: 'sensors' },
  // **The second runner (`P-61`).** EXE and Script checks run in a child process rather than a
  // worker, with their own much smaller ceiling — so the pool channels above say nothing at all
  // about them, and a probe can be turning every shell-out away while `poolBusy` looks calm.
  // Separate channels rather than a sum, because the two saturate at completely different loads
  // and an operator diagnosing one does not want the other folded in.
  { key: 'childSlots', name: 'Child process slots', unit: 'processes' },
  { key: 'childBusy', name: 'Child processes running', unit: 'processes' },
  { key: 'childQueued', name: 'Checks waiting for a child process', unit: 'checks' },
  { key: 'childDeferred', name: 'Child checks deferred', unit: 'checks', counter: { bits: 64 } },
  { key: 'childRefused', name: 'Child checks refused', unit: 'checks', counter: { bits: 64 } },
  { key: 'childTimedOut', name: 'Child checks timed out', unit: 'checks', counter: { bits: 64 } },
  { key: 'childCrashes', name: 'Child process crashes', unit: 'processes', counter: { bits: 64 } },
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
  // **The other way a reading stops existing** (`P-78`). `spoolDropped` is the disk being full —
  // a deliberate eviction, decided with the results already safely written. This is the write
  // itself failing, so the readings never reached disk at all. The two want different fixes, and
  // a probe that cannot write its spool is losing *every* check it runs rather than the oldest
  // ones, which makes this the more urgent of the pair even though it will usually read zero.
  {
    key: 'spoolUnwritten',
    name: 'Results not written',
    unit: 'results',
    counter: { bits: 64 },
    // Not a matter of degree, and bounded below the smallest rate a single loss can produce
    // rather than at zero — both for the same reasons as `spoolDropped` above.
    limits: {
      upperError: 0.000_01,
      errorMessage: 'the spool cannot be written and readings are being lost',
    },
  },
  // **The third way a reading stops existing** (`P-79`): a line that will not parse, which is a
  // torn write at a crash boundary. Counted at read time, and unlike the two above it is usually
  // a *normal* recovery — one truncated record after an unclean shutdown is what a crash costs.
  // So it is visible and has no limits: paging somebody for the system correctly surviving a
  // power cut is worse than not knowing, and a rate that climbs while the probe is *not* crashing
  // is what an operator should be looking at, which is a graph and not a threshold.
  { key: 'spoolCorrupt', name: 'Results unreadable', unit: 'results', counter: { bits: 64 } },
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
  // `P-231`. Results the core refused from this probe in the last five minutes, because no clock
  // could have stamped them: more than fifteen minutes ahead of the core's, or older than
  // anything the core keeps. Counted on the core, per probe, because a wrong clock is one host's
  // and the probe cannot see it.
  //
  // **Counts over a window, not counters, so the warning clears itself and misses nothing.** A
  // warning on a running count would stay for ever after one bad batch. A counter's rate would
  // clear, but it gaps on the first reading after the core restarts or the probe reconnects from
  // a long outage, which is when a wrong clock first shows. Warning rather than Error: the probe
  // is working, and what is lost is the refused results, which its own sensors show as gaps.
  {
    key: 'resultsFutureDated',
    name: 'Results refused as future-dated (5 min)',
    unit: 'results',
    limits: {
      upperWarning: 0.5,
      warningMessage:
        "this probe's clock is ahead of the core's, and its results are being refused",
    },
  },
  {
    key: 'resultsPastDated',
    name: 'Results refused as too old (5 min)',
    unit: 'results',
    limits: {
      upperWarning: 0.5,
      warningMessage:
        "this probe's clock is further behind than the core keeps anything, and its results are being refused",
    },
  },
  { key: 'cpu', name: 'CPU', unit: '%' },
  { key: 'memory', name: 'Memory (resident)', unit: 'MB' },
  // **How much the machine has left, which is not how much the probe holds** (`P-208`). `P-206`'s
  // probe was the largest process on its VM when the kernel killed it, but a lint run and
  // PostgreSQL's shared buffers had taken the rest, and `memory` above could not have said so. On
  // a machine the probe has to itself the two nearly agree; beside the core and its database —
  // the default installation — they do not. `MemAvailable` on Linux, never `MemFree`, and the
  // lowest in the last thirty seconds rather than the latest, because a squeeze that ends in a
  // kill can be over inside one record interval. Read every two seconds on the probe's own timer,
  // not at the heartbeat, which is ten as shipped and missed a five-second squeeze (`P-218`).
  //
  // A **gap** where the platform cannot say, never a zero: a zero on this channel is the error.
  //
  // The machine's, not the probe's cgroup: a probe at its own unit's ceiling is killed with plenty
  // available here, and that is `memoryLimitUsage` below (`P-210`, `P-213`).
  {
    key: 'memoryAvailable',
    name: 'Memory available',
    unit: '%',
    // Lower limits, from what `P-206` measured on a 7,936 MiB VM. **The error is at 10%** because
    // that is where the fastest fall on record began: 675 MiB available (8.5%) to 30 MiB, and the
    // kernel killing a process, in six seconds — below it there is no time left to act. **The
    // warning is at 20%** because the three runs that machine survived bottomed out at 9.9, 17.0
    // and 23.4% with swap already exhausted in each: one more process from a kill, and a warning
    // at 20% would have said so for two of the three.
    limits: {
      lowerWarning: 20,
      lowerError: 10,
      warningMessage: "the probe's machine is running low on memory",
      errorMessage: "the probe's machine is nearly out of memory; the kernel may kill a process",
    },
  },
  // The same reading in megabytes, because "8% available" is not something an operator can act
  // on without knowing of what. No limit: a threshold in megabytes is wrong on every machine but
  // the one it was written for, which is `diskFreeBytes`' reason on Core Health too.
  { key: 'memoryAvailableBytes', name: 'Memory available', unit: 'MB' },
  // **How close the probe is to the ceiling its own service sets** (`P-210`), which the machine's
  // figure above cannot say: `ms-probe.service` caps the probe whatever the host has left. The
  // ceiling is the lower of `MemoryHigh` and `MemoryMax`, because the lower one acts first. The
  // stock unit sets only `MemoryMax`, where the kernel kills (`P-213`); a `MemoryHigh` an operator
  // sets below it is where the kernel throttles the probe to a standstill instead. Measured against
  // the working set, not `memory.current`, because page cache fills a cgroup to its ceiling on
  // purpose; `packages/shared/src/process/limit-memory.ts` has the measurements. The highest of the
  // last thirty seconds, and above 100 only past a `MemoryHigh`, which a cgroup can stand above.
  //
  // A **gap** where there is no ceiling — no limit, cgroup v1, or not Linux — never a zero, which
  // would say the probe is using none of a limit it does not have.
  {
    key: 'memoryLimitUsage',
    name: 'Memory used of its limit',
    unit: '%',
    // **The warning is at 80%, and it is the limit that does the work.** On the stock unit it is
    // the only one that can fire: the kernel kills at `MemoryMax`, so the reading after 100% is a
    // gap and what the core sees is the link drop (`P-213`). 80% because the probe's own start-up
    // grew 856 MiB in five seconds (`P-206`) — 14% of the stock 6 GiB — and from 80% one such
    // surge, which a configuration push can start at any time (`P-34`), still fits under the
    // ceiling; from 90% it would not. **What it catches is a probe that has settled high or is
    // leaking, not a surge in flight**: a surge crosses the last 20% in about seven seconds, and a
    // warning reaches the sensor about half a minute after the crossing (a heartbeat, a sweep). A
    // threshold that caught one would sit at a level the probe's own start-up passes through.
    // **The error is past 100%**, for a unit given a `MemoryHigh`:
    // past it with no swap the probe was stalled on memory 73% of the time within 17 seconds and
    // killed by its unit's watchdog within 25, and a probe that far gone rarely gets out the
    // heartbeat that would say so.
    limits: {
      upperWarning: 80,
      upperError: 100,
      warningMessage: 'the probe is nearing its memory limit',
      errorMessage: 'the probe is past its memory limit; the kernel is throttling it',
    },
  },
  // The ceiling itself, so "92% of its limit" says of what.
  { key: 'memoryLimit', name: 'Memory limit', unit: 'MB' },
  { key: 'uptime', name: 'Uptime', unit: 's' },
];

export const probeHealth: SensorType = {
  id: 'ms.probe.health',
  category: 'System',
  costHint: 'light',
  evaluatedBy: 'core',

  /**
   * The probe it reports on (`A-29`): the one `probeId` names, or the one it sits under.
   *
   * The second is a reference too. Rights can be granted on a device under a probe without any on
   * the probe itself, and a Probe Health sensor put on that device would otherwise publish the
   * probe's health to everybody who can read the device. Moving one re-checks it for the same
   * reason: the probe above it can change.
   */
  references(params) {
    const probeId = params['probeId'];
    return typeof probeId === 'number'
      ? [{ kind: 'object', objectId: probeId, expects: 'probe', param: 'probeId' }]
      : [{ kind: 'enclosing-probe', param: 'probeId' }];
  },

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

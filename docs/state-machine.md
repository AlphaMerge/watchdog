# Sensor state and pause precedence

The tables `M-02` onwards are built against, written before the code on purpose (`M-01`).
`PLAN.md` names precedence bugs between the four pause sources as Phase 3's principal risk, and
the exit criterion is a property test proving no sequence of events reaches an undefined state.
Neither is achievable against a state machine whose rules only exist in its own implementation.

Reviewed against [`WORKFLOW.MD §4`](WORKFLOW.MD) (state machine) and `§5` (dependency and pause).
Where this document is more specific than `WORKFLOW.MD`, it is filling a gap that would otherwise
be filled by whoever wrote the code first; those places are marked **decided here**.

---

## 1. Vocabulary

Both enums already exist in the database, from migration `003`. This document does not invent
vocabulary; it says what the values mean and when each is used.

### States — `sensor_state_kind`

| State                | Meaning                                                                  | v1  |
| -------------------- | ------------------------------------------------------------------------ | --- |
| `unknown`            | No current reading. Newly created, just resumed, or its probe is gone or silent. | yes |
| `up`                 | Last scan succeeded and every channel is within its limits.              | yes |
| `warning`            | A warning limit is breached, or the first consecutive scan failure.      | yes |
| `down`               | An error limit is breached, or the failure policy has been exhausted.    | yes |
| `down_acknowledged`  | `down`, with notifications suppressed by an operator. Still scanning.    | yes |
| `paused`             | Monitoring suppressed. No scans, no notifications, no uptime accrual.    | yes |
| `unusual`            | Reading deviates from a historic baseline.                              | V2  |
| `down_partial`       | Down on some cluster nodes and not others.                              | V2  |

`unusual` and `down_partial` are `[V2]`. The type accommodates them so the column never has to
change; **no v1 transition produces either**, and a test asserts that.

### Causes — `sensor_state_cause`

Every state change records why. Without it a history tab says a sensor went Down and leaves the
operator to guess whether that was the target, a threshold someone edited, or a dependency.

| Cause        | Set by                                                          |
| ------------ | --------------------------------------------------------------- |
| `scan`       | The check itself succeeded or failed                            |
| `limit`      | A channel crossed a configured limit                            |
| `lookup`     | A channel's value mapped to a state through a lookup            |
| `user`       | A person: manual pause, resume, acknowledgement                 |
| `schedule`   | A schedule's inactive window                                    |
| `dependency` | A master object went Down                                       |
| `parent`     | An ancestor was paused, cascading down                          |
| `probe`      | The probe owning this sensor is unreachable                     |
| `access`     | The account that vouched for this sensor can no longer read what it names (`A-29`), or write where its credentials are stored (`A-41`); or the sensor is outside its credentials' bounds (`A-41b`) |
| `simulated`  | An operator forced an error to test a notification chain        |

---

## 2. How a state is computed

Not a flat matrix of state × event. The inputs are layered, and a layered model is both what the
system actually does and far harder to get subtly wrong than an 8 × 15 grid nobody can check by
eye. Evaluated **in this order**, first match wins:

| # | Condition                             | Result              | Cause                            |
| - | ------------------------------------- | ------------------- | -------------------------------- |
| 1 | Any pause source active               | `paused`            | the first active source (§3)     |
| 2 | Simulated error set (`M-14`)          | `down` → §2.4       | `simulated`                      |
| 3 | Owning probe unreachable *or* connected and not delivering | `unknown` | `probe`               |
| 3a | Its voucher may no longer read what it names (`A-29`), or write where its credentials are stored (`A-41`); or it is outside its credentials' bounds (`A-41b`) | `unknown` | `access` |
| 4 | No reading since creation or resume   | `unknown`           | `scan`                           |
| 5 | Otherwise                             | worst of §2.1, §2.2 | whichever produced the worst     |

**Row 3 covers two faults with one answer** (`P-74`). A probe whose link has gone and a probe that
is connected and has stopped sending results are indistinguishable from the sensor's point of
view — nobody has asked it anything — so both produce `unknown`/`probe`, and both produce exactly
one alarm, on that probe's own Probe Health. What separates them is the message and the channel:
`connected` says whether the link is there, `delivering` says whether anything is coming back over
it, and the second is the one that can be Down while the first is Up.

The detector reads when a batch last *arrived*, never `result.at` — a probe replaying an hour of
spooled results sends rows stamped an hour ago while the batches themselves land now, so a rule
over the probe's own clock would fire hardest on the probe that is recovering correctly.

**Pause beats everything**, including a simulated error and a lost probe: it is an explicit
instruction to stop monitoring, and a paused sensor that reported Down because its probe went
away would be an alarm from something an operator switched off. *Decided here* — `WORKFLOW.MD`
does not order pause against probe loss.

**A simulated error is acknowledgeable, and nothing else about layer 2 changes.** It still
short-circuits layers 3 to 5 — a forced outage ignores the probe and the readings — but its
verdict then goes through §2.4 exactly as a real `down` does, so an acknowledged one reads
`down_acknowledged` with cause `user`. *Decided by `N-17`.* The reason is `M-14`'s own purpose:
a simulated error exists to rehearse a notification chain end to end, and acknowledging is the
step in that chain an operator most wants to be sure of, because it is what stops the repeats at
three in the morning. Layer 2 says "behave as though this were down"; `down_acknowledged` is how
a Down behaves once somebody has acknowledged it, so refusing it would have made the rehearsal
unfaithful at exactly the step worth rehearsing. Withdrawing the acknowledgement while the force
still stands returns the sensor to `down` with cause `simulated` — it is Down for that reason and
for no other, and `M-14` promises a forced outage says so.

**A lost probe is `unknown`, not `down`.** `WORKFLOW.MD §12` is explicit: we do not know whether
the target is up, and saying Down would be a claim the system cannot support. One alarm comes
from Probe Health (`R-05`), not from every sensor behind it.

**Row 3a is a sensor the core has declined to evaluate** (`A-29`). A Sensor Factory, a Probe Health
sensor and a Core Health sensor republish what they read — other sensors' values, a probe's
health, the installation's own figures — to everybody who can read them, so each is evaluated
through the eyes of the account that last vouched for it: whoever last wrote its parameters,
moved it or cloned it. When that account can no longer read what the sensor names, or has been
deleted or disabled, the core stops evaluating it. Its channels record nothing, which is a gap,
and it reads `unknown`/`access` with a sentence saying why and what fixes it — never naming the
object it cannot read.

- **Unknown, never Down.** Nothing about the thing measured has failed; the question stopped
  being asked. Down would turn one grant edit into one alarm per sensor that account wrote, which
  is `CLAUDE.md`'s "one outage, one alarm" broken by an administrator doing their job.
- **Below pause and a simulated error, above everything a reading decides**, for the reasons row
  3 is: a paused sensor is not being evaluated anyway, and a forced outage is an operator's
  rehearsal that ignores the readings. Below row 3 because both answer Unknown and a lost probe is
  the wider fact. Above row 4 because "not evaluated on purpose" and "not measured yet" are
  different things to tell an operator, and only this one has a fix they can act on.
- **It notifies as a lost probe does**: only through a trigger somebody configured on Unknown. A
  Down trigger does not fire, and an alarm already sent about a Down sensor is suspended rather
  than recovered — the sensor has not come back, it has stopped being looked at, and a recovery
  would be a false all-clear. `sensor-vouching.test.ts` revokes the read twenty factories depend
  on and counts the notifications.
- **What depends on it stays where it was** (`M-23`). A dependency master withheld while Down
  keeps holding its dependents until it is evaluated again: Unknown is not Down, but letting go
  would page each dependent on the outage the master can no longer speak for. Its
  `dependency_clear_at` is `infinity`, which `applyPauses` honours only while it reads
  `unknown`/`access`. So a pause lets go, as it does for any master, and the hold is back if the
  master comes back withheld. Vouched for again, it settles as any master returning from Down
  does: Down holds, paused lets go, and anything else waits `dependency.delaySeconds`. `P-135`
  releases a lost probe's masters for the opposite reason: their dependents are Unknown with
  them, and a withheld master's are not. **A factory whose every channel reads a sensor that is
  not being evaluated is withheld too**, in evaluation order, so the withholding carries down a
  chain. Its message names nothing. The status of a withheld sensor in a formula reads not-up,
  which is the formula language's rule for any Unknown. A factory over a lost or frozen probe's
  sensor is Unknown for its probe rather than withheld, which is below (`M-26`).
- **Like `probeReachable`, the fact is not persisted.** It is re-derived every sweep from the
  voucher stored on the sensor and the grants as they are now, so a grant restored, an account
  re-enabled or an edit by somebody who can read it clears it at the next sweep.

**The same row holds a sensor whose credentials nobody still vouches for** (`A-41`). A sensor sent
an inherited credential set is sent it only while the account that vouched for where it goes can
still write the object the set is stored on. When it cannot — or has been deleted or disabled, or
the sensor now sends the set somewhere nobody vouched for — the probe's configuration leaves the
sensor out, and it reads `unknown`/`access` with a sentence saying so and what fixes it, never
naming where the set is stored. Everything above holds for it: Unknown rather than Down from a
failed login, notified only through a trigger on Unknown, and re-derived, here at every
configuration a probe is built — which a grant, group or account change now pushes. The two
checks share one set of withheld sensors, each under its own name (the credential check under
one per probe), so one releasing a sensor never releases what another still holds.

**And a sensor outside its credentials' bounds** (`A-41b`). A set with allowed targets, or an SSH
set with host keys, is sent by its bounds alone: nobody vouches for it. A sensor outside them, one
named by host name when the targets name only addresses, or one whose probe is too old to check
a list of host keys, is left out of the configuration the same way, under the same per-probe
name, and reads `unknown`/`access` with the reason. Narrowing a set's targets can do that to a
group at once, and pages as Unknown does: once per sensor, into the digest, and not at all for a
sensor a Down dependency already holds, since a paused sensor is not configured.

**And a sensor whose probe refuses to scan it** (`A-41c`). A device named by host name, facing a
set whose targets name only addresses, is sent to a probe at protocol 24 (27 for a database
sensor, `A-62`), which resolves the name
at each scan and checks every address. When one is outside the targets, or the name resolves to
nothing, the probe sends the device nothing and marks its result `withheld`. **That result never
reaches the state machine.** It is not a failed scan: counted as one it would be a Down, and an
alarm, about a device nobody asked anything of. The core takes it out of the batch and holds the
sensor in the same set, under a second per-probe name, with the probe's own sentence. The
transition to Unknown is stamped as the probe measured the refusal, as a result's is.

**The mark is honoured only where the probe could have refused**: on an error with no readings,
for a sensor that probe was sent with a set whose targets left the name to it. On anything else
the result is the result it would be without the mark, a failed scan included, and is counted
with the probe's refused results on Probe Health. A probe cannot turn the failure of a sensor it
merely owns into a standing Unknown.

**A refusal is judged against the configuration it was made under** (`A-53`). A check already
running, or a result in the spool, when a configuration stops leaving a sensor to the probe (a
name entry now covers the device, it was given an address, it was paused, the core withholds it
itself) produces a refusal that arrives after that configuration. It was honest when it was made.
A result does not say which configuration its check ran under, and a probe that follows its
configuration refuses only what that configuration left to it, so for **ten minutes** after the
configuration that stopped leaving the sensor (`LATE_REFUSAL_GRACE_MS`, counted on the core's
monotonic clock from the first such configuration, and not started again by a later one) a
refusal from that probe for that sensor is **dropped**: not a failed scan, so no Warning, no Down
and no alarm, and not a hold, since what the configuration now says about the sensor is what
speaks for it. It lets no hold go either. It is counted on Probe Health's **Refusals delivered
late** (`lateRefusals`, `A-56`), a counter with no limit and so no state of its own, and not among
**Reports refused**, which counts what the core would not take from the probe. After the ten minutes the mark is one the probe has no claim to, as above, and the result
is the failed scan it reads as. What this gives a probe that misbehaves is a result that
vanishes, which it already had by not sending it: it cannot begin or prolong an Unknown with it,
and cannot use it on a result that is `ok` or has readings, on a sensor it was never left, or
after the ten minutes.

**A probe's protocol version alone begins one window an hour** (`A-68`). The version a probe
connects with is the one thing it says that decides what it is left: under one without
`credentialAddressPinning` it is left no named sensor, and under the newer one it is left them
again. Each such stop used to begin the ten minutes, so a probe that alternated had them for as
long as it kept reconnecting. A window is now **remembered for an hour from when it began**
(the ten minutes and `LATE_REFUSAL_COOL_OFF_MS`, fifty more), and it stays remembered when the
sensor is left to the probe again. Inside the hour a stop that only the version caused begins
nothing: the window stays where it began, a refusal is late for what remains of it, and for
nothing once it has run out. Five alternations give what one downgrade gives.

- **A stop somebody configured is not held to the hour.** Targets narrowed, a device given its
  address, moved or paused, a voucher lost: its grace begins when the configuration is built, as
  it always did, remembered window or not.
- **How the two are told apart.** The core asks its own check, the one that decides the
  configuration, what this configuration would have left the probe had its version stayed what
  the last one was built for. A sensor that would still be left was stopped by the version
  alone. One that would not was stopped by a change, whatever the version did beside it. Asked
  only when the version differs and a window to begin again is remembered, which is a probe
  reconnecting under another version inside the hour.
- **When that second check cannot be made** (the database did not answer it), the two cannot be
  told apart and time alone decides: no remembered window is begun again, and the log says so
  at `warn`. What that can cost is an operator's change made in the same configuration as the
  probe's version change being judged by the window already there.
- **What the hour costs a probe that is honest.** One rolled back, forward and back again inside
  an hour has, at the second rollback, only what is left of the first window. A refusal its
  spool still holds after that is a failed scan of a sensor the core is itself withholding for
  the probe's age: the sensor stands Unknown meanwhile, and two such are a Down, with its one
  alarm, when the probe is upgraded and the sensor let go, until its next scan. The same is
  true of a single downgrade whose refusals arrive more than ten minutes late
  (`credential-pinning.test.ts`, the alternating scenario, pins both as one Down each).
- **What alternating still does, and the grace never caused**: each downgrade withholds the
  probe's named sensors (Unknown, the Unknown trigger's page) and each upgrade lets them go (its
  recovery). That is the reconnects' doing: a probe that sends no refusal at all raises the same.

**The record survives a core restart** (`A-61`). Which sensors a configuration stopped leaving to
a probe, and when, is held in the core's memory, which is what a refusal is judged by, and stored
in `late_refusal_grace`: one row per (probe, sensor) with the time the first such configuration
was built. A core restarted inside the ten minutes reads the table before the probe endpoint
exists, so a late refusal delivered to it is still late: dropped, counted on **Refusals delivered
late**, no failed scan, no Down, no alarm. A failed scan after the restart is the failed scan it
always was, and past the ten minutes, counted from when the configuration stopped leaving the
sensor and not from the restart, the mark is one the probe has no claim to
(`credential-pinning.test.ts`, the alarm-volume scenario).

- **Written by the core, when a configuration it builds changes the record.** A row is written
  when a configuration stops leaving a sensor to its probe, and the write is waited for, within
  a bound, before that configuration is handed over. A configuration that changes nothing
  recorded writes nothing. **No result a probe sends writes to the table.** One thing a probe
  says does reach a configuration: the protocol version it connects with, which decides whether
  a named device is left to it at all. A probe that reconnects under a version that changes
  that causes one write, once per reconnect, of no more rows than it has sensors, and the stop
  it records begins the ten minutes for those sensors once in an hour and no oftener (`A-68`,
  above). What storing adds is the write, and that the ten minutes and the hour survive a
  restart. Otherwise what a probe that misbehaves can and cannot do is the paragraphs above, on
  either side of a restart.
- **What each probe was last left is in the same rows** (`A-68`). A row for a sensor the probe's
  last configuration left to it carries the protocol version that configuration was built for
  (`left_version`); a row for a remembered window carries its time (`stopped_at`); a sensor
  that is both has both, and no row has neither. They are written in the one statement, when a
  configuration changes what the probe is left, the version it is left it under, or a window.
  A core reads them at start, so the first configuration it builds for a probe is compared with
  the last one the core before it built: see the bound below.
- **The write gives way, and holds nobody back.** It runs in its own transaction with a lock
  timeout of 300 ms and a statement timeout of 2 s, and the configuration waits for it 3 s at
  most, whatever the connection is doing. It takes its own rows and then a key-share lock on
  the sensors' rows; a delete of a device or group takes those first and cascades into the
  table. 300 ms is under PostgreSQL's `deadlock_timeout` (a second as shipped), so the write is
  always the one to give up and the operator's delete is never the one aborted. Giving up is
  logged at `warn`, the configuration goes out, and the write is made again at the next
  configuration or within the minute. Each probe's writes are in a line of their own: one
  probe's configuration never waits on another's write. An entry whose sensor or probe was
  deleted meanwhile is dropped rather than written again.
- **A time is removed as the entry in memory is**: an hour after the window began (`A-68`), at
  the probe's first configuration after that, and on a one-minute timer for a probe that is
  never sent another. Not when the sensor is left to the probe again: that is when it most needs
  remembering. The row goes with its time unless the probe is left the sensor, and a deleted
  sensor or probe takes its rows with it.
- **A write that is not made when it is due is counted** (`A-68`): Core Health's **Late-refusal
  record writes given up** (`lateRefusalWritesGivenUp`, `ms_core_late_refusal_writes_given_up_total`),
  once for each write that gave way, was not waited for, or failed. A counter with no limit and
  no lookup, so no state and no alarm: a delete of a group makes a few on purpose, and each is
  made again within the minute. A rate that stays up is a database these writes cannot get into.
- **Monotonic while running, wall clock across a restart.** The ten minutes are counted on the
  monotonic clock, which a new process starts from nothing, so the table holds the wall clock's
  reading. At start, what has run is the wall clock now less the stored time, and that is bounded
  on both sides (`storedStop`, a table of cases in the test). More than ten minutes, by however
  much: spent, and the row removed, which is also what a clock set forward across the restart
  does, and ends the grace early. A stored time later than now, which is a clock set back: nothing
  can be counted from it, so the entry gets the ten minutes from that start and no more, the row
  is written down again as now so that a second start does not give them twice, and the log says
  so at `warn`. Neither side gives more than `LATE_REFUSAL_GRACE_MS`. A time past its ten
  minutes and inside its hour is taken up as remembered: nothing is late by it, and the probe's
  version begins no window against it after the restart either. Past the hour it is spent.

**The record is of a configuration, and a core that stops between a change and the next
configuration still finds the stop** (`A-61`, closed by `A-68`). The change itself is decided in
its own write, and what makes a refusal late is that the probe's *configuration* stopped leaving
it the sensor, which the core knows when it next builds that configuration, from what the one
before left the probe. For a connected probe the build follows the change by the notifier's
quarter of a second; for one that is away, at its next connection. What the one before left the
probe used to be in memory only, so a core that stopped in between started with nothing to
compare with, recorded no stop, and read the probe's late refusals as failed scans. It is now
stored and read back: the restarted core's first configuration for the probe finds the sensor no
longer left, begins its ten minutes then, and stores that before the probe is handed the
configuration (`credential-pinning.test.ts`, the scenario of a core that stops between a change
and the next configuration: no Down, no page). A refusal that reaches the restarted core before
it has built that configuration is honoured as the probe's, since what was stored says the probe
is still left the sensor: Unknown until its next scan, and not a failed scan either.

**The bound that is left** is a write that was not made. A core restarted after a write of the
record failed or gave way, and before it was made again at the probe's next configuration or
within the minute, starts with the table one configuration behind: a stop that write recorded is
not there, or, if it was the write of what the probe is left, the comparison is with the
configuration before. A late refusal for such a sensor is then the mark the probe has no claim
to: a failed scan, and as many as the sensor's failed-scan count (two, as shipped) are **one Down
for that sensor, with the one alarm a Down raises**, in the probe's words ("Not scanned: ..."),
until the next scan under the new configuration, counted on **Reports refused**. Core Health
counts those writes (above). The same follows a clock set forward across the restart, and the
first start on this schema of a core upgraded from before it, which has no row of what any probe
was left until it has built each a configuration.

**The next result that is not a refusal lets the sensor go, and that result decides it.** The
hold is dropped without re-deciding anything, so there is one transition, from Unknown to what
the result says: Up at the scan that found the name inside again, Down if the device does not
answer, and never a Down between for what the sensor read before it was held. Results are
ordered by the probe's clock, since a spool replays: an older refusal holds nothing, and an older
reading lets nothing go. If the batch carrying that result is not stored, the sensor is held
again as it was, and let go when the probe sends the batch again.

**A hold does not outlive the reason for it.** A sensor the core stops sending the probe (paused,
deleted, or withheld by the core itself) is dropped from what the probe refused at the next
configuration, an empty one included. A sensor moved to another probe is let go when the move
commits, whether or not the probe it left is connected, and in any case by its first result from
the probe it is under now. A deleted probe holds nothing.

**The set and the record of what a probe refused move together.** A refusal is recorded only
once the set has taken it; when that write fails the batch is refused back to the probe, which
sends it again.

### 2.1 Query state — did the check run?

From the result's `outcome`, with the two-step rule (`M-03`).

| Consecutive failures | State     | Cause  |
| -------------------- | --------- | ------ |
| 0 (last scan ok)     | `up`      | `scan` |
| 1                    | `warning` | `scan` |
| 2 or more            | `down`    | `scan` |

Per-sensor policy: `immediate` makes the first failure `down`; `warn N` holds `warning` for N
consecutive failures before `down`. Default N = 1, giving the table above. A successful scan
resets the counter to zero.

`M-03` makes it the inheritable setting `scan.retryWarnings` (0–10, default 1), resolved per
sensor through the ordinary inheritance chain — a group can say "warn for three intervals" for
everything beneath it, and one sensor can override. **N counts scans, not elapsed time**;
§6 left that open and this settles it, because the setting is a count of failures and a sensor
whose interval changes should not silently change how long it tolerates one.

**A policy change takes effect at the sensor's next scan, not immediately.** The policy is a rule
about results, so it applies to the next result — the same way an edited limit is applied when
the next reading arrives. Re-evaluating every affected sensor on the spot needs a pass over the
subtree, which is machinery `M-08` genuinely needs (a pause must not wait for a scan) and this
does not. *Decided by `M-03`.*

The counter is persisted in `sensor_runtime.consecutive_failures` rather than held in memory
(`M-02`). A restart between the first and second failure would otherwise silently hold a
genuinely down sensor at Warning for another interval, which is a deploy changing what an
operator is told about an outage.

### 2.2 Channel state — were the readings acceptable?

From limits (`M-04`) and lookups (`M-06`). **Immediate**: the two-step rule does not apply, so a
channel crossing an error limit is `down` on the very first sample (`WORKFLOW.MD §4` rule 2).

A channel is judged by **one or the other, never both**. A lookup maps discrete codes and a
limit bounds a continuous range; a channel whose value is a status code has no meaningful
threshold, and applying one anyway would let a number somebody typed years ago override what the
device is actually saying. `WORKFLOW.MD §4` rule 2 puts the two in one sentence — "same for
lookup-driven states" — so they are immediate alike, but they are not additive. *Decided by
`M-06`.*

| Worst channel                | State     | Cause             |
| ---------------------------- | --------- | ----------------- |
| Any channel over its error limit   | `down`    | `limit` or `lookup` |
| Any channel over its warning limit | `warning` | `limit` or `lookup` |
| All channels within limits         | `up`      | `scan`            |

Implemented by `M-04` in `packages/core/src/state/limits.ts`. Four thresholds per channel —
upper and lower, for each of error and warning — plus an `enabled` flag and a custom message per
severity, stored in the `channel.limits` jsonb column migration 001 already provisioned.

Four things this settles, none of which `WORKFLOW.MD` states:

- **The comparison is strict.** A reading exactly *at* a limit has not exceeded it. An upper
  error limit of 100 on a percentage has to be reachable, and one that fired at 100 would make
  "at most 100%" impossible to express. *Decided by `M-04`.*
- **Zero is a limit, not an absence.** `lowerError: 0` and "no lower limit" are different
  configurations; a channel that must never go negative is an ordinary thing to want. This is
  why the thresholds are nullable numbers rather than numbers defaulting to zero.
- **The worst channel decides, and it is decided here.** A result carries every channel the
  check produced, and a channel's limit can only be compared against the reading in that same
  result — so the roll-up across channels happens where the readings are, and §2.3 then combines
  one channel verdict with the query state. This is what `M-05` asked for; there was no second
  place to put it.
- **The message comes from whichever side produced the state.** `cause` already names that side,
  so the message is chosen from it rather than by a second rule that could disagree: a Down with
  cause `limit` reads "Response time is 812 ms, above the error limit of 500 ms", and a Down with
  cause `scan` reads whatever the probe said. When several channels breach, the message lists the
  worst three and counts the rest — a sensor may have fifty channels, and a message naming all
  fifty is one nobody reads.

Limits that contradict each other — a warning limit past its error limit, or a lower limit above
an upper one — are refused when they are set, with the reason. A threshold that could never fire
is a configuration mistake, and accepting it silently means an operator believes they are
covered when they are not.

### 2.2.0 Before anything judges it

`WORKFLOW.MD §3` draws one box — "apply scaling, spike filter, lookups" — feeding "evaluate
channel error/warning limits". `M-07` implements the first half, in
`packages/core/src/ingestion/scaling.ts`, and the order inside it is stated here because nothing
else states it:

1. **Scale.** `value × mul ÷ div`. A device reports bytes and the operator wants bits; a
   thermometer reports centidegrees and the operator wants degrees.
2. **Spike filter.** Discard the reading entirely if it falls outside `[min, max]`.
3. Only then §2.2 sees it.

**Scaling comes before the spike filter**, because the bounds and the limits are all numbers an
operator types in the channel's own unit. Two units in one form is a bug that reads as "the
filter is ignoring my setting". *Decided by `M-07`.*

**The scaled value is what is stored**, not the raw one. One number: what was written is what
was judged is what is drawn. Storing raw and scaling on read would work — every rollup aggregate
is linear — but it puts two representations of one measurement in the system, and that is how a
chart says 40 while the alarm that fired says 320. The cost is that changing a factor does not
rewrite history, so a graph steps at the moment of the change; that is true of every monitoring
system, and it is visible rather than subtle. *Decided by `M-07`.*

**A discarded reading is a gap, not a zero**, and contributes nothing to the channel's state
either — the same rule a failed check follows. A spike filter exists because a wrapped counter
reporting four billion would flatten a graph for a day; writing a zero in its place would simply
move the lie, and letting it breach a limit would alarm on an artefact. Every discard is counted
(`ResultStats.discardedSpike`), because a filter quietly eating a third of a channel's data looks
exactly like a device that stopped reporting.

### 2.2.1 Lookups

`M-06` implements them in `packages/core/src/lookups/`. `SingleInt` maps one value to one state
and a phrase; `Range` maps a half-open band, `from` inclusive and `to` exclusive so adjacent
bands neither overlap nor leave a gap. Built-ins are TypeScript modules — a lookup shipped as a
data file is one more thing the packaging step can forget, and a missing one would surface as a
sensor that never leaves Unknown — while an operator's own are JSON under `<dataDir>/lookups`
and replace a built-in with the same id.

Three decisions `CAPABILITIES.MD §1.2` leaves open:

- **`undefinedState` is required, with no default.** Whether an undocumented status code is fine
  or a problem depends entirely on the device, so the lookup's author has to say. Any default
  here would be this system deciding for them, and whichever way it decided would be wrong for
  half the lookups in existence.
- **A definition that is wrong is refused, not repaired**, and recorded with the reason where
  `GET /lookups` serves it. A lookup that silently failed to load leaves its channels judged by
  nothing, and a sensor reading Up for that reason is worse than one reading Unknown.
- **A channel naming a lookup this installation has not loaded is `warning`**, with the cause
  `lookup` and a message naming the id. Not silence — that lets a broken configuration read as
  healthy. Not a fall back to limits — the reason to configure a lookup is that a threshold is
  the wrong tool for the value. And not `down`: the check succeeded and the reading arrived, so
  what is broken is this system's ability to interpret it, and saying the target is down would
  be a claim nothing supports. It is the same distinction §2 draws for a lost probe.

The message keeps the raw number *and* what it means — "Interface status is 2 (down)". Either
alone is worse: the number is what the device said, the text is what an operator can act on, and
a lookup edited since makes the two disagree in a way only the pair reveals.

### 2.3 Combining them

`state = worst(query, channel)` where `down` > `warning` > `up`. The cause is taken from
whichever side produced the worst state; when both produce it, the **channel** cause wins,
because "the response time exceeded 500 ms" tells an operator more than "the scan failed".
*Decided here.*

**A failed scan has no channel state.** A check that failed records no channel values at all
(CLAUDE.md: no-data is not zero), so there is nothing to compare against a limit and §2.2 is not
evaluated — the state is the query state alone. Carrying the *previous* channel state forward
would keep a stale limit breach alive across an outage and attribute an outage to a threshold.
*Decided here.*

### 2.4 Acknowledgement

Applied last, and only to `down`:

| Situation                                                   | State               | Cause  |
| ----------------------------------------------------------- | ------------------- | ------ |
| Computed state is `down` and an acknowledgement is active   | `down_acknowledged` | `user` |
| Computed state is anything else                             | that state          | as-is  |

- **Suppresses notifications, not monitoring** (`WORKFLOW.MD §4` rule 4). The sensor keeps
  scanning, and its readings keep being stored.
- **Cleared by** recovery to any non-`down` state, by expiry, by resume (rule 5), and by an
  operator withdrawing it (`M-13`). The recovery does not have to arrive as a *result*: lifting a
  simulated error is one too, and `M-16` found that path leaking an acknowledgement onto a
  healthy sensor, where it silenced the next genuine failure.
- On expiry while still failing, the state returns to `down` with cause `user` — the change an
  operator needs to see is that the acknowledgement lapsed, not that the target is still down.
  *Decided here.* Only when the suppression was actually in effect **and the sensor is visibly
  `down` now**: an acknowledgement lapsing on a sensor that read Unknown ended nothing an operator
  could see, and naming `user` there would put the wrong cause on a state whose whole purpose is
  to be unmistakable (`M-16`). The second condition is also what excludes the layers that
  short-circuit above the reading — a paused sensor evaluates to `paused` and one whose probe is
  away to `unknown`, so neither reaches the override. A sensor held Down by a *simulated* error
  does reach it, and should: since `N-17` the acknowledgement was genuinely suppressing that
  Down, so its lapsing is exactly the change `user` names.
- **"Recovery" means a reading decided the state.** Layers 1 to 3 short-circuit before the
  reading is looked at, so a sensor that reads `unknown` because its probe went away has not
  recovered from anything, and clearing the acknowledgement there would un-suppress an outage
  nobody has fixed. *Decided by `M-02`*, whose test drove exactly that sequence.
- **Expiry is evaluated against the result's clock**, not the wall clock, so replaying a spool
  writes the history it would have written live. *Decided by `M-02`.* It follows that there is no
  sweep: an acknowledgement lapses when the next result notices, which is at most one scan
  interval late and is the same rule a replay obeys.
- **The clearing is persisted, not merely computed.** `M-02` cleared the acknowledgement in the
  machine's facts and left the columns alone, so a cache eviction or a restart brought a silenced
  alarm back silenced. `RuntimeWrite.acknowledged` carries it to the row (`M-13`), and a result
  can only ever clear one — nothing about a reading creates an acknowledgement.

---

## 3. Pause precedence

Four sources, evaluated in this order every tick (`WORKFLOW.MD §5`):

| # | Source       | Cause        | Set by                                        | Cleared by                             |
| - | ------------ | ------------ | --------------------------------------------- | -------------------------------------- |
| 1 | Parent       | `parent`     | An ancestor being paused, cascading down      | That ancestor resuming                 |
| 2 | Dependency   | `dependency` | A master sensor reaching `down` (`M-11`)      | Master recovering, plus the delay      |
| 3 | Schedule     | `schedule`   | A schedule's inactive window (`M-09`)         | The window ending                      |
| 4 | Manual       | `user`       | A person, indefinitely / timed / until a date, or a maintenance window reaching its start (`M-10`) | That person, or the deadline passing   |

### The rule

The four are **independent flags, not a priority chain**. A sensor is `paused` if *any* is set.
Precedence decides only which cause is *reported* — the first active source in the order above.

This is the distinction the risk in `PLAN.md` is about. If precedence were a chain, resuming the
highest-precedence source would resume the sensor; because they are a set, it does not. A sensor
paused by both its parent and by hand stays paused when the parent resumes, and the reported
cause simply changes from `parent` to `user`.

`M-12` tests exactly that against a real tree: all four turned on, then cleared one at a time,
with the reported cause walking down `parent → dependency → schedule → user` and the sensor
Paused at every step.

| Parent | Dependency | Schedule | Manual | State     | Cause        |
| ------ | ---------- | -------- | ------ | --------- | ------------ |
| –      | –          | –        | –      | not paused | —           |
| –      | –          | –        | ✓      | `paused`  | `user`       |
| –      | –          | ✓        | –      | `paused`  | `schedule`   |
| –      | –          | ✓        | ✓      | `paused`  | `schedule`   |
| –      | ✓          | –        | –      | `paused`  | `dependency` |
| –      | ✓          | –        | ✓      | `paused`  | `dependency` |
| –      | ✓          | ✓        | –      | `paused`  | `dependency` |
| –      | ✓          | ✓        | ✓      | `paused`  | `dependency` |
| ✓      | any        | any      | any    | `paused`  | `parent`     |

### How it is stored (`M-08`)

Two facts, not one. `object_pause` (migration 010) is what an operator asked for: one row per
paused object, with a deadline (`NULL` is indefinite), a message and who did it.
`sensor_runtime`'s four flags are what that works out to per sensor, **derived** from those rows
on every pause, resume, move and create.

Deriving on write rather than on read is the whole trade: a chain walk per pause instead of a
chain walk per sensor per scan. It is also what makes the flags survive a restart with nothing
in memory, and what lets `paused_by_parent` be recomputed *from scratch* — clearing one pause
does not mean a sensor is unpaused, because another ancestor may still hold it, and an
incremental toggle would have to walk the chain to find that out anyway.

**Manual pause applies to any object, not just a sensor.** Nobody pauses a sensor during
maintenance; they pause the device, the group, or the whole probe. A device has no state of its
own — its sensors do — so pausing one sets `paused_by_parent` on every sensor beneath it, and the
row is what remembers why, so a resume knows what to undo and a sensor created later inherits the
pause it was born into.

**A paused sensor is not in its probe's configuration at all.** `WORKFLOW.MD §3` skips it before
the check is enqueued, and the cheapest way to skip a check is never to schedule it: no new
protocol field, no probe-side rule to keep in step with the core's four sources, and a probe
cannot scan something it was not told about. *Decided by `M-08`.*

**A pause takes effect immediately, unlike a failure policy.** `M-03` could defer to the next
scan because a policy is a rule *about results*, so the next result applies it. A pause is not:
an operator pausing for maintenance means now, and a sensor that alarmed thirty seconds into a
planned outage is the exact failure pausing exists to prevent. `SensorStateService.reevaluate`
writes the transitions inside the same transaction as the pause.

**A timed pause is computed from the clock and swept on a timer.** Whether a pause is still in
force is `paused_until IS NULL OR paused_until > now()`, so every *read* is already right the
moment the deadline passes. What needs a sweep is the three things that are writes: the
transition to Unknown that uptime is computed from, the entry in the log, and the configuration
that tells a probe to start scanning again. Half a minute, not a second — the shortest pause a UI
offers is five minutes, and the lag is bounded, stated, and on the safe side: monitoring resumes
late rather than early. Deliberately not a timer per pause: a process holding five thousand
timers loses all of them on a restart, and a pause outliving the core is the normal case.

### Resume

- **Only the object that was directly paused can be resumed** (`WORKFLOW.MD §5`). Resuming a
  child that is paused by cascade is refused, with a reason — not silently ignored.
- Resuming clears **that source only**. The others are unaffected.
- When the last source clears, the sensor becomes `unknown` with cause `scan`, not its previous
  state: it awaits its next scan, and reporting a state measured before the pause would be
  reporting something the system has not checked since.
- Resuming clears any acknowledgement (`WORKFLOW.MD §4` rule 5).

### Dependency, specifically

- **Only a genuine `down` triggers dependency pausing.** A master that is paused — manually, by
  schedule, by its own parent — does *not* pause its dependents by dependency. The ordinary
  hierarchical cascade still applies if the master happens to be their ancestor, which it usually
  is not.
- `down_acknowledged` **does** trigger it: the target is still down, and an acknowledgement is a
  statement about notifications, not about the outage. *Decided here.*
- **The master keeps scanning while its dependents are paused.** Nothing else can detect
  recovery. PRTG had this bug through v19.1. `M-11` gets it from the one rule that a master is
  excluded from its own dependency, rather than from a special case: "master object for parent
  device" writes the master onto the *device*, so every sensor under it inherits that master —
  including the master, which the exclusion then removes.
- Recovery waits the configured **delay after dependency ends** before resuming dependents, so a
  flapping link does not generate an alarm storm every time it bounces.
- The cascade is **recursive**: dependents of a paused dependent also pause.

---

## 4. Transitions

Derived from §2 and §3 rather than authored separately — two hand-maintained lists disagree
eventually, and the one that is wrong is always the one not under test. Listed here so a reviewer
can check the model against `WORKFLOW.MD §4`'s diagram.

| From                | To                  | Trigger                                            | Cause                  |
| ------------------- | ------------------- | -------------------------------------------------- | ---------------------- |
| _(created)_         | `unknown`           | Sensor created                                     | `scan`                 |
| `unknown`           | `up`                | First successful scan, limits clear                | `scan`                 |
| `unknown`           | `warning`           | First scan fails, or first reading breaches warning | `scan` / `limit`      |
| `unknown`           | `down`              | First reading breaches an error limit              | `limit` / `lookup`     |
| `up`                | `warning`           | Scan failed (1st), or a warning limit breached     | `scan` / `limit`       |
| `up`                | `down`              | An error limit breached, or `immediate` policy     | `limit` / `scan`       |
| `warning`           | `down`              | Failure policy exhausted, or an error limit        | `scan` / `limit`       |
| `warning`           | `up`                | Successful scan, limits clear                      | `scan`                 |
| `down`              | `warning`           | Recovered to a warning limit only                  | `limit`                |
| `down`              | `warning`           | The failure policy was relaxed past the failure count | `scan`              |
| `down`              | `up`                | Successful scan, limits clear                      | `scan`                 |
| `down`              | `down_acknowledged` | Operator acknowledges                              | `user`                 |
| `down_acknowledged` | `down`              | Acknowledgement expired, still failing             | `user`                 |
| `down_acknowledged` | `up` / `warning`    | Recovered                                          | `scan` / `limit`       |
| any                 | `paused`            | Any pause source becomes active                    | first active (§3)      |
| `paused`            | `unknown`           | Last pause source cleared                          | `scan`                 |
| any                 | `unknown`           | Owning probe became unreachable                    | `probe`                |
| any but `paused`, or `down` (`simulated`) | `unknown` | The sensor's voucher lost read on what it names (`A-29`) or write where its credentials are stored (`A-41`), or was deleted or disabled; or the sensor is outside its credentials' bounds (`A-41b`) | `access` |
| `unknown` (`access`) | `up` / `warning` / `down` / `unknown` | Vouched for again: its last reading decides, as when a probe returns, until the next one | `scan` / `limit` / `lookup` |
| any but `paused`    | `down`              | Simulated error set                                | `simulated`            |
| `up`/`warning`/`down` | itself            | The reason changed, not the state                  | `scan` / `limit` / `lookup` |

**Not in v1:** every transition into or out of `unusual` and `down_partial`.

### 4.1 What this adds to the diagram in `WORKFLOW.MD §4`

Every edge in that diagram appears above. These do not appear in it, and are listed so the
review is auditable rather than asserted — each is required by a rule stated elsewhere in the
same documents, which is why the diagram not drawing it is an omission rather than a decision.

| Added                              | Required by                                                        |
| ---------------------------------- | ------------------------------------------------------------------ |
| `unknown` → `down`                 | §4 rule 2: limit-driven states are immediate, including the first reading |
| `down` → `warning`                 | Recovery is not all-or-nothing; a sensor can improve without clearing |
| `down_acknowledged` → `warning`    | Same, and the acknowledgement clears either way (§4 rule 5)         |
| `unknown` → `paused`               | The diagram pauses only from Up/Warning/Down; a sensor can be paused before its first scan |
| `down_acknowledged` → `paused`     | Same                                                                |
| any → `unknown` on probe loss      | §12: a probe's sensors go Unknown, not Down — we do not know        |
| any → `down` on simulated error    | `PLAN.md` Phase 3: a simulated error state for testing chains       |
| any → `unknown` on a lost voucher  | `A-29`: a sensor that republishes another object's data stops when its voucher could not read it; `A-41`: a sensor is not sent credentials its voucher could not send |

Nothing in the diagram is missing from the table.

### 4.2 What later tasks added

**`M-02`.**

One row, found by the conformance test rather than by reading: the machine moved from
`warning` (`scan`) to `warning` (`limit`) and the table was silent about it. §5 invariant 10
already required that change to be recorded — "including one whose state is the same as the last
if its *cause* differs" — so the omission was in the table, not in the rule. Re-entry with a new
cause is now listed, for `up`, `warning` and `down`. It is a real event: Warning because the scan
failed and Warning because a limit was breached are two different problems.

**`M-03`.** `down` → `warning` with cause `scan`. Reachable only by editing the failure policy:
while a sensor is failing the count only rises, and a success takes it straight to Up. Raising
`scan.retryWarnings` above the current failure count is an operator saying "this many failures is
not yet Down", and the sensor should say so at its next scan. Found the same way — by driving the
machine against the table rather than by reading it.

---

## 5. Invariants

What `M-02`'s property test asserts. Each is here because it is cheap to state and expensive to
discover later.

1. **Totality.** Every combination of inputs produces exactly one state. No sequence of events
   reaches an undefined state — Phase 3's exit criterion.
2. **Determinism.** The same inputs produce the same state and the same cause, in any order of
   evaluation.
3. **No v1 path reaches `unusual` or `down_partial`.**
4. **Pause dominates.** If any pause source is active the state is `paused`, whatever else is
   true — including a lost probe, a simulated error and an active acknowledgement.
5. **Pause is a set, not a chain.** Clearing one source never resumes a sensor that another
   source still holds.
6. **Cause is always attributable.** No state change is recorded without a cause that names
   something an operator can act on.
7. **`down_acknowledged` implies down.** It is only ever reachable from a computed `down`.
8. **Resume yields `unknown`.** Never the pre-pause state.
9. **A failed scan produces no channel-derived state**, because it produced no channel values.
10. **Uptime comes from these transitions, not from samples** (CLAUDE.md), so every change must
    be recorded — including one whose state is the same as the last if its *cause* differs.

---

## 6. Left for the tasks that follow

Named so they are decisions rather than omissions:

- ~~**`M-03`**~~ — done; §2.1 records the setting, the default and that N counts scans.
- ~~**`M-04`** / **`M-06`**~~ — done; §2.2 and §2.2.1 record what they settled.
- ~~**`M-07`**~~ — done; §2.2.0 records the order and what is stored.
- ~~**`M-11`**~~ — done. The delay is not a timer: it is `sensor_runtime.dependency_clear_at` on
  the *master*, a deadline in a table that survives a restart and cannot be lost by a process
  that dies mid-flap. A fresh failure discards it and a fresh recovery writes a new one, which is
  what happens if the master flaps during the delay — nothing accumulates and nothing has to
  remember the last one. A delay of zero releases the dependents in the recovery's own
  transaction; anything longer is released by the pause sweep.
- ~~**`M-15`**~~ — done. `GET /state-log` reads what `M-02` has been writing, scoped to a branch
  or a sensor, filtered by state and cause, with each transition's duration measured against the
  real next one rather than the next one on the page. Invariant 10 is what makes a cause change
  visible there even when the state did not move.
- **Restart.** ~~Pause state must survive a core restart~~ — done by `M-02`. The columns are on
  `sensor_runtime` (migration 008), one row per sensor, created by trigger the moment a sensor
  exists so that a later task's `UPDATE ... SET paused_manually = true` cannot silently match
  nothing.

---

## 7. What `M-02` built, and what it deliberately left unwired

The machine is complete: every layer of §2 is evaluated, every v1 transition of §4 is reachable,
and `state-machine.test.ts` drives the whole input space — 16 pause combinations × simulated ×
probe × acknowledged × 5 scan facts × 4 channel verdicts — asserting totality, determinism and
each invariant of §5.

What it does **not** do is decide the inputs. Each of these has a layer, a column and a test, and
is waiting for one task to set it:

| Input                    | Set by  | Until then                                            |
| ------------------------ | ------- | ----------------------------------------------------- |
| The four pause flags     | ~~`M-08`~~…~~`M-12`~~ | All four are live, and `pause-precedence.test.ts` arranges all sixteen combinations through the real mechanisms. |
| `acknowledged_at/until`  | ~~`M-13`~~ | Live: `POST`/`DELETE /objects/:id/acknowledge`, on a sensor or on anything above one |
| `simulated_error`        | ~~`M-14`~~ | Live: `POST`/`DELETE /objects/:id/simulate-error`. The sensor keeps being scanned, so lifting the force returns it to the truth with no scan in between |
| The channel verdict (§2.2) | ~~`M-04`, `M-06`~~ | Live: limits and lookups both produce one, and **persisted** in `sensor_runtime.channel_state/cause` since `P-85`. It was left out on the reasoning that a remembered breach is "a verdict on a measurement nobody took" — but the same row stores the state that verdict decided, so dropping the premise only meant every re-decide without a reading reached a different answer from the same row, and layer 5 read half its inputs. A resume clears it; a failed scan stores none. |
| `probeReachable`         | `R-05`, `P-232` | Always true, and **not persisted**: it is a fact about a live connection, and restoring it from a table would record thousands of "probe unreachable" transitions on every core restart — an alarm storm generated by the restart itself. False for a lost probe's sensors, and for the sensors a probe's clock has frozen (below). |
| `vouchedFor`             | `A-29`, `A-41` | Live: the core's three evaluators re-check each sensor's voucher every sweep, and every probe configuration re-checks who vouched for each sensor's credentials, and lay the answer over the loaded facts, as `probeReachable` is. Not persisted, for the same reason, and because the grants it depends on can change without the sensor changing at all. |

Two further notes for whoever picks those up:

- **A transition is never dropped for landing on an occupied instant** (`P-108`).
  `writeStateHistory` stamps each change strictly after that sensor's newest stored row, so two
  callers sharing one `now` — the pause sweep's loops, or two audit sinks reacting to one move —
  both land, and a probe whose clock runs ahead of the core cannot push a later core-clock
  transition into the past. An *identical* row still collides, which is what makes a replayed
  batch idempotent.

- **The unreachable overlay is derived from the tree, not snapshotted against it** (`P-103`).
  `lost` records which sensors a probe was carrying; a move, a create or a delete changes that
  answer, and the overlay is re-derived inside the same transaction. Without it a sensor moved
  off a dead probe onto a live one stayed `unknown`/`probe` for as long as the dead probe was
  away — no transition, because the state never changed, and no alarm, because it never moved.
  The clock-freeze overlay is kept in step the same way, on the same mutations and in the same
  transaction (`P-239`). A sensor moved off a frozen probe is thawed at once, whether or not
  that probe is still connected, and a sensor that arrives under one is left to its sweep.
  Freezing needs the probe's clock, and a probe that has gone away has none to offer. A failure
  here fails the mutation rather than being logged, because its transaction is aborted by then
  (`P-249`).

- **A resume is a floor on staleness, not an erasure of it** (`P-97`). `last_result_at` is the
  high-water mark that makes the at-least-once protocol safe; `resumed_at` is what says nothing
  has been measured since. They were one column until `P-97`, and a resume nulled it — so every
  duplicate the protocol can produce was applied as new, and so were readings a *disconnected*
  probe measured inside the pause window. §3 below says a paused sensor "is not in its probe's
  configuration at all", which holds only for a probe currently connected to receive that
  configuration; one that lost its link keeps scanning and spooling.

- **Results for one sensor must arrive in order.** They do: a probe's spool drain keeps one
  batch in flight (`R-02`), and one probe owns one branch. A result no newer than the last one
  applied is discarded and counted as `resultsStale`, which is what makes an at-least-once
  protocol safe — a resent batch must not advance a two-step failure twice.
- **A probe whose clock steps back freezes its sensors, and they read Unknown for it** (`P-232`).
  The rule above means a result no newer than the last one is dropped, and it cannot tell a
  duplicate from a result measured after the probe's clock went back: results carry no clock of
  their own. So a clock stepped back by N — an RTC reset at boot, NTP correcting a fast clock —
  has every one of that probe's sensors drop everything for N. The core measures each probe's
  offset from the `sentAt` on every heartbeat and batch, the smallest over five minutes, and a
  sensor whose last result is later than its probe's clock now reads, less a minute, is
  **frozen**. That is exact: nothing a probe re-sends was measured after its own clock, so no
  duplicate or replay makes it true, and a clock steadily behind does not either. A frozen
  sensor gets `probeReachable: false`, the lost probe's fact, so it is Unknown with cause
  `probe` and raises exactly what a lost probe's sensors raise; the core-evaluated types are left
  out, as they are for a lost probe. It is lifted when the clock passes the last result or is
  put right. **It is not a re-base of the watermark**: a result measured before the step and
  sent again cannot be told from one measured after, and applying it would put the watermark
  back and freeze the sensor again. Kept across a disconnect, and decided only once the new
  session's offset is known, so a probe that returns still behind never shows a stale reading.
  A sensor stays frozen while any probe's set holds it (`P-239`), so a probe letting one go that
  another has frozen too is not a thaw.
- **A trigger on Unknown sees a probe's live Probe Health as Unknown while the probe is lost or
  frozen; nothing else does** (`M-22`). A lost, silent or frozen probe's sensors are Unknown with
  cause `probe`, and the one alarm for that is the probe's Probe Health, which reads Down in all
  three cases. A carried sensor's alarm under a trigger is **held** only when that trigger
  covers a live Probe Health reporting on the probe. "Live" means not paused and not withheld
  (`A-29`). While it is held, nothing arms, and a standing alarm is suspended rather than
  cancelled or recovered, so the return is no wave of Ups. A trigger that does not cover the
  probe's Probe Health, such as one on a group below the probe, or a probe with none, notifies
  per sensor as before, so holding never takes the last route away from any trigger. The
  trigger on Unknown would otherwise have none: Probe Health is Down, not Unknown. So it alone
  sees Probe Health as Unknown for the episode, raises one alarm on it, armed from the episode's
  start, and says which probe and how many sensors. **The view is an input to the alarm
  engine's decision and to its sweep's standing check, and to nothing else.** `sensor_state`,
  uptime, `GET /sensors/:id/state`, the stream and the UI all read Probe Health as Down, and a
  test holds the history and the read equal with and without such a trigger. After a core
  restart the lost and frozen sets are empty until the grace has run out, but the carried
  sensors still read Unknown/`probe` in the table. So the hold finds their probe from the tree,
  and Probe Health's targets are resolved before the boot pass. Within the same grace the
  delivery watch waits out before it marks a probe lost, Probe Health sends nothing for a probe
  that has not connected since boot. That is a gap, not `connected` 0, so a probe that redials
  inside the grace pages nobody. **A withheld sensor's Unknown,
  cause `access` (`A-29`), is never held**, for three reasons. No sensor stands for it as one
  alarm. It is bounded by what one account wrote, not by what one probe carries. And the trigger
  over those sensors reaches the people who can fix them.
- **The episode and the set it holds move together, in every direction** (`M-24`). Whatever
  changes a probe's held set re-decides the probe's alarm in the same transaction, to or from
  empty included: a loss, a return, a freeze, a thaw, and a tree change that moves, creates,
  clones or deletes sensors under a lost or frozen probe. An episode ends when its set empties
  as well as when its probe returns. One that ends while its probe is still at fault, because
  every sensor it held was moved off it or deleted, is filed as **emptied**, and its alarm
  recovers in words that say the probe is still lost, silent or behind. Nothing stands an
  episode alarm down silently: the sweep sends that recovery itself if the re-decision never
  reached it, and cancels an alarm that was never sent. **An acknowledged Probe Health parks the
  episode alarm**, since the view would otherwise hide the acknowledgement from the chain, and
  the lapse resumes it where it stopped. **A Probe Health paused or withheld during the loss**
  cancels the episode alarm, as a pause cancels any alarm, and re-decides the sensors it held
  unheld, so from then on they notify one by one. Which came first, the pause or the loss, no
  longer decides whether a trigger hears anything, and holding still never takes the last route
  away. The link runs from Probe Health's own re-decision, so it is only as prompt as that. **A
  Probe Health deleted during the loss** has no row left to be re-decided (`M-25`). So the
  delete's own transaction re-decides what it held, while the episode index still maps it to
  its probe, and the triggers it alone covered stop holding. A sensor another live Probe Health
  covers stays held behind that one. **A Probe Health retargeted during the loss**, by an edit
  to its *Probe* or a move of its device, is still live and still has a row, so neither of those
  reaches it (`M-27`). The health sweep that sees it report on another probe publishes the new
  targets and then re-decides everything the old probe holds, before its own results go in, and
  the same follows. A failed re-decision is asked again at the next sweep. Its own episode alarm
  recovers too, because it reads its new probe now. The recovery goes out at once, not held as
  a return, and says the probe it stood for is still lost, silent or behind (`M-29`). The episode
  index remembers which probe each Probe Health last stood for in an episode, and asks through
  that probe once the Probe Health has moved. It remembers only since the core started, so one
  moved before anything asked after a restart recovers in its new probe's words.
- **A return is held before an alarm is over, and a relapse inside the hold is the same alarm**
  (`M-18`). This is the alarm engine's, not the state machine's: the sensor reads Up at the
  return, in `sensor_state` and everywhere else, and only the alarm waits. How long comes from
  the sensor's type, five minutes for Probe Health and none for any other type, or from the
  trigger's own `recoveryHoldSeconds`. An episode that ends because its probe came back is a
  return like any other. A loss inside the hold is the same episode alarm, resumed, even though
  it is a new episode, so a probe killed and restarted every few seconds is one alarm on a
  trigger on Unknown as on one on Down. An **emptied** episode recovers at once: its probe has
  not come back, and nothing flaps.
- **A Sensor Factory over a lost or frozen probe's sensor is Unknown with it** (`M-26`). Its
  inputs record nothing, so once its maximum age runs out every channel gaps. It reported an
  error for that, and paged Down beside the probe's Probe Health. Now the factory sweep holds a
  factory whose every gap is on a sensor reading `unknown`/`probe`, or on a factory held for one,
  or on a withheld sensor, as long as at least one is the probe's. It lays `probeReachable: false`
  over the factory's facts, as the lost set does, so row 3 decides it: `unknown`/`probe`, with a
  gap, and a message that names nothing. The probe is the wider fact, so a factory reading both
  is the probe's rather than withheld. The set settles on crossing, in the transaction that
  settles the sweep's voucher sets, and goes back if the write fails (`M-28`, below). Like the
  lost set, it is live and not persisted, and after a restart it is empty until the first factory
  sweep.
  - **The factory sweep's three sets settle as one** (`M-28`): the factories refused for who
    vouched for them, those withheld for what they read, and those held for their inputs'
    probe. A factory crosses between two of them in one sweep when its voucher returns, or a
    probe goes or comes back. Settled one after another, it was re-decided in between with
    neither: its last reading, a transition there and back, and an Up on a trigger on Up. All
    three move first, and what crossed is re-decided once. What came into or left them all is
    what holds or lets go of dependents, so a factory master moving between them keeps its
    mark. One withheld for another reason keeps its state, its cause and its start, and takes
    the new reason's words, with no transition.
  - **Until its inputs report again.** A sensor whose probe has come back reads its last reading
    at once, but nothing is measured until its first result, and a spool replays oldest first.
    So a factory stays held while every gap is on a sensor it saw away, that has reported nothing
    since and is not paused, for at most the factory's own maximum age after it last saw it away.
    Past that, the gap is its own, and it reports an error as before. Without this it went Down
    during Probe Health's held return (`M-18`), and again at every relapse.
  - **Carried by its inputs' probe, never by its own.** The alarm engine holds it behind the
    Probe Health of the probe holding the first of its inputs the lost and frozen sets hold, as it
    holds those sensors. Where the sets do not account for them, which is the boot grace and a
    return, it is carried by the probe its inputs sit under in the tree. The tree's fallback never
    carries a core-evaluated sensor by the probe it sits under: that probe has no episode, and a
    trigger on Unknown over it would hear nothing. A trigger that covers the probe's live Probe
    Health hears of the factory once, in the episode's alarm. One that does not hears its Unknown,
    as it would a sensor of that probe's. Held factories are let go with the probe's sensors when
    its Probe Health is paused, withheld, deleted or retargeted during the loss (`M-24`, `M-25`,
    `M-27`). A factory
    held before a core restart is carried by nothing until the first factory sweep, so a
    reconciliation in that window arms it as any sensor, and the due sweep parks it if that sweep
    has run by then.
  - **A factory master held Down keeps holding**, for `M-23`'s reason: its dependents may be
    anywhere, scanned as before. The mark is `M-23`'s, honoured for `unknown`/`probe` on a
    factory only. A master a probe scans that was marked while withheld reads `unknown`/`probe`
    when its own probe is lost, and lets go then, as `P-135` has it.
- **State never bumps `object.version`.** `sensor_runtime` has no `object_touch_owner` trigger,
  and state is deliberately absent from `GET /objects/:id`, whose ETag is built from
  configuration versions. A scan is not a configuration change, and if it were, `R-04` would
  push a fresh configuration to every probe once per interval. Listings carry `state` for
  colouring a tree; `GET /sensors/:id/state` is the whole answer for one sensor, uncached.

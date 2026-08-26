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
| `unknown`            | No current reading. Newly created, just resumed, or its probe is gone.   | yes |
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
| 3 | Owning probe unreachable              | `unknown`           | `probe`                          |
| 4 | No reading since creation or resume   | `unknown`           | `scan`                           |
| 5 | Otherwise                             | worst of §2.1, §2.2 | whichever produced the worst     |

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
| The channel verdict (§2.2) | ~~`M-04`, `M-06`~~ | Live: limits and lookups both produce one |
| `probeReachable`         | `R-05`  | Always true, and **not persisted**: it is a fact about a live connection, and restoring it from a table would record thousands of "probe unreachable" transitions on every core restart — an alarm storm generated by the restart itself. |

Two further notes for whoever picks those up:

- **Results for one sensor must arrive in order.** They do: a probe's spool drain keeps one
  batch in flight (`R-02`), and one probe owns one branch. A result no newer than the last one
  applied is discarded and counted as `resultsStale`, which is what makes an at-least-once
  protocol safe — a resent batch must not advance a two-step failure twice.
- **State never bumps `object.version`.** `sensor_runtime` has no `object_touch_owner` trigger,
  and state is deliberately absent from `GET /objects/:id`, whose ETag is built from
  configuration versions. A scan is not a configuration change, and if it were, `R-04` would
  push a fresh configuration to every probe once per interval. Listings carry `state` for
  colouring a tree; `GET /sensors/:id/state` is the whole answer for one sensor, uncached.

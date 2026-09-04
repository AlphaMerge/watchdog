# Failure-mode verification — `WORKFLOW.MD §13`, row by row

**2026-08-29 · `H-02`**

`WORKFLOW.MD §13` is eight rows, and its own last line says the expected-behaviour column *is*
the specification. This is the audit of what actually holds today: what proves each row, where
the proof is only at unit level, and where the behaviour does not exist at all.

The short version at the time of writing: **five rows held and were proved end to end; two were
proved in pieces and got a scenario; one was not implemented.** Two further gaps cut across rows
and were filed separately — `S-17` and `S-18`, both since closed, and this document is updated
where they changed the answer.

---

## Row by row

### 1. Core server restarts

> Paused states persist; sensors resume on their next due tick; probes reconnect and replay their
> spools

**Holds.** Three separate claims, each with its own proof, and the reason they hold is
structural rather than careful: **nothing that has to survive a restart lives in a timer.**

| Claim | Proof |
| --- | --- |
| Paused states persist | `pause.test.ts` — "survives a core restart, because the deadline is in the database" |
| Scheduled work resumes | `notification-engine.test.ts` — "survives a restart, because the due time is in the table and not in a timer"; `alarm-scheduler.test.ts` — "a new scheduler fires what the old one was sleeping on"; `notification-summaries.test.ts` — "a window is a row and not a timer" |
| Probes reconnect and replay | `spool-drain.test.ts`, `replay-pacer.test.ts` (`R-02`, `R-03`) |

What was missing was the property the third claim *rests on*: replay is only safe if the write is
idempotent, and nothing asserted that across two ingestor lifetimes.
`failure-modes.test.ts` now stores a batch, stops the ingestor, builds a second one against the
same database and offers the same readings again — twice, and then overlapping — and asserts the
row count is the number of distinct readings. It also builds a second `ObjectService` from
nothing and finds the pause, which a pause held anywhere in memory would fail.

Both halves are asserted, and the second was an afterthought that turned out to matter: the
replay must come back **accepted**, not merely counted. Removing `ON CONFLICT DO NOTHING` does
not duplicate the row — it errors on the unique index — so a row-count assertion alone passes
while the probe replays the same batch for ever.

Not asserted here: the socket. Reconnect and handshake are `probe-endpoint.test.ts`'s, and the
drain that resends is `spool-drain.test.ts`'s. What this adds is that the core end of that
exchange is safe to repeat, which is the half neither of them can see.

### 2. Database unavailable

> Checks continue, results spool locally, ingestion resumes on recovery; Core Health goes Down

**Holds, and the mechanism is the ack.** The core answers a batch it cannot store with a
*retryable nack* carrying `retryAfterMs` rather than an acknowledgement, and the probe's drain
keeps the batch on disk and tries again — the same path a probe uses when the core is unreachable,
which is why this needed no separate machinery.

| Claim | Proof |
| --- | --- |
| A write failure is not fatal | `ingestion.test.ts` — "reports a write failure without throwing, and counts it" |
| The probe is told to retry | `ingestion.test.ts` — "passes a refusal back to the probe as a nack it can retry" |
| Core Health reports it | `core-health.test.ts` — "fails the sensor with a message and no channel values when it cannot read" |

The end-to-end claim — *ingestion resumes on recovery*, with nothing lost and nothing doubled —
is now in `failure-modes.test.ts`, against a database wrapper that can be taken away and given
back: batches offered during the outage come back as nacks and write nothing, the replay after
recovery overlaps what was already stored, and the row count is the distinct readings.

One test there is worth naming, because it is the one that would bite. A batch **accepted into
the queue** and then hit by the outage still comes back as a nack — `submit` resolves at the
commit, not at the enqueue. Resolving early would have the probe drop from its spool a batch the
core never wrote, and nothing anywhere would say so.

### 3. Probe unreachable

> Probe Health goes Down; its sensors go Unknown (not Down — we don't know); a single alarm, not
> one per sensor

**Holds, thoroughly.** `probe-offline.test.ts` is thirteen tests on this row alone, including the
three that are easy to get wrong: Unknown rather than Down, **one transition per sensor rather
than two**, and a core-evaluated sensor left alone because no probe ever scanned it.

**Amended 2026-08-29 (`H-01`).** This row is about what the *core* does when a probe goes away,
and it is right. What it does not cover — and what this audit did not think to ask — is whether
the readings the probe spooled during the outage ever come back. They did not: a cursor parked on
a segment boundary made the spool hand back an empty batch for ever, so a probe that had once
caught up stopped delivering anything the next time it rolled a segment, with the link up and
nothing logged (`615c9f3`). Every test on this row passed throughout, because they all assert on
state transitions and none of them drains a spool, rolls a segment and drains again.

The lesson for the audit rather than the code: a row that reads "the system survives X" is
answered by the state machine, and the question underneath it — "and the data survives X too" —
is a different test. `92ec56a` makes the drain say when it is making no progress, so the next one
of these is loud rather than silent.

**Amended 2026-09-04 (`P-74`), and the amendment is a new row rather than a correction.** This
audit is of §13 as it stood, and §13 had no row for the case that actually followed from the two
paragraphs above: a probe that is **connected** and has stopped sending results. `615c9f3` was
exactly that fault and was found by `H-01`'s soak, and the table still described only the probe
that goes *away* — so the specification named the failure it had already suffered nowhere.

`WORKFLOW.MD §13` now carries **"Probe connected but sending no results"**, with the same answer
as the row above, because the sensors are equally unasked. What proves it: `probe-delivery.test.ts`
— fourteen table-driven rows over the pure rule, including forty consecutive spool-replay batches
that must not trip it and the start-up grace that must hold — and `probe-delivery-watch.test.ts`,
seven on the sweep, including that three sweeps over a stalled probe write **one** transition
rather than three, and that a probe which disconnects while silent and reconnects still silent can
be marked again.

`P-76` adds the finer case the core cannot see, and it is deliberately *not* a §13 row: a probe
that is delivering while some of what it carries is not being checked is a Warning on Probe Health
(`checksCompleting`, `checksBehind`), not a failure of the system to survive anything. Proved by
`check-flow.test.ts`.

The lesson, again and pointing the other way: this audit read every row of the table and could not
have found the row that was missing from it. Auditing a specification against the code says whether
the code matches; it does not say whether the specification is complete.

### 4. Notification delivery fails

> Logged, retried with backoff, surfaced on Core Health; the alarm itself is not lost

**Holds.** `notification-health.test.ts` covers the backoff, the lease, giving up, and the
distinction that matters: a rejection no amount of waiting fixes is not retried, and an alarm
given up on makes Core Health **Down** rather than merely warning — because nobody received it.

### 5. A check type hangs

> Killed at timeout; the worker is recycled; scheduler unaffected

**Holds.** `check-pool.test.ts` — "terminates and replaces a worker whose check ignores its
abort", and "reports a timeout when it happens, not when the check gives up". The second is the
subtler one: the timeout is reported at the deadline, not whenever the hung check eventually
notices.

### 6. Scheduler falls behind

> Lag metric rises, deferred-check counter increments, Probe Health warns before anything is
> silently dropped

**Half.** The numbers exist and are correct: `schedulerLag` (p95, measured by the wheel because
only it knows when each tick *should* have run), `deferred`, `refused`, `queued`, `checkWait`, all
on Probe Health and all in `report.ts`. Nothing is silently dropped — `CLAUDE.md`'s visible-
backpressure rule is met.

**"Warns" was not met, and the reason was `G2` below: no channel shipped with a limit.** `S-18`
closed that — `schedulerLag` now warns at 1 s and errors at 5 s out of the box, and `poolUsage` at
80/95 — so the row holds. The numbers themselves are provisional until `H-01`'s soak.

### 7. Disk fills

> Housekeeping escalates, oldest raw data is evicted first, a critical alarm fires before
> ingestion stops

**Was not implemented at all; `S-17` implemented it.** When this audit was written there was no
`statfs` anywhere in `packages/`, no disk channel on Core Health, and retention by **age** only — a
full disk stopped PostgreSQL and the first thing an operator learned about it was that ingestion
had stopped.

All three clauses hold now. *Housekeeping escalates*: a `disk` step after retention, measuring the
filesystem the readings are on. *Oldest raw data is evicted first*: raw before five-minute before
hourly, oldest forward, a day at a time, re-measuring after each drop. *A critical alarm fires
before ingestion stops*: `diskFree` errors at 10% — the same point eviction begins — and
`evictedChunks` fires on any rate above zero.

The decision that had to be written down rather than coded is in ADR-001: **emergency eviction may
break the configured retention**, because data that cannot be written is worse than data kept less
long than promised. It is never quiet about it.

### 8. Clock jumps

> Timing wheel resynchronises against monotonic time; samples keep wall-clock timestamps

**Holds.** `timing-wheel.test.ts` — "ignores a wall-clock step, and says that it saw one". The
wheel runs on `process.hrtime.bigint()`, per `CLAUDE.md`; the sample's `timestamptz` is wall
clock. The "and says that it saw one" half matters: a jump that were silently absorbed would be
indistinguishable from the wheel drifting.

---

## Gaps that cut across rows

### `G1` → `S-17` — nothing knows how full the disk is · **closed**

Row 7, above. Worth keeping the reason this was not merely "add a channel": **evicting oldest raw
data first is a policy that interacts with rollups.** Raw that has not been rolled up cannot be
dropped without losing the rollup, so the eviction order is "oldest raw *behind the rollup
watermark*" — and the watermark is already what `Housekeeper#rollForward` maintains, so the cap
was a query rather than a new concept.

What the audit did not anticipate, and `S-17` had to answer: **which disk**. The readings are on
PostgreSQL's volume and the core is on its own. A core that watched the wrong one would show a
healthy number in front of a volume about to fill, so a database on another host now produces no
reading at all rather than a misleading one.

### `G2` → `S-18` — the health sensors ship with no thresholds · **closed**

`ChannelDef` has no way to declare a default limit, and neither `ms.core.health` nor
`ms.probe.health` seeds one: `channel.limits` is a `jsonb` column that starts empty, and there is
no migration or startup path that fills it.

So every "Probe Health warns" and "a critical alarm fires" in §13 is, today, "an operator who
knew to set a threshold on this channel is warned". The numbers are all there and all correct —
what is missing is that a fresh install alarms on none of them. This is the difference between a
system that *can* be monitored and one that *is*.

---

## What this audit is not

It is not the soak (`H-01`), and two rows can only be fully believed after one: row 6's lag is
interesting at 5,000 sensors and uninteresting at ten, and row 7's eviction policy wants a real
retention window behind it. Both are verified here against forced conditions, which proves the
behaviour and not the sizing.

# Failure-mode verification — `WORKFLOW.MD §13`, row by row

**2026-08-29 · `H-02`**

`WORKFLOW.MD §13` is eight rows, and its own last line says the expected-behaviour column *is*
the specification. This is the audit of what actually holds today: what proves each row, where
the proof is only at unit level, and where the behaviour does not exist at all.

The short version: **five rows hold and are proved end to end; two are proved in pieces and now
have a scenario; one is not implemented.** Two further gaps cut across rows and are filed
separately.

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

**"Warns" is not met, and the reason is `G2` below: no channel ships with a limit.** The numbers
are alarmable; nothing alarms on them until an operator writes a threshold by hand.

### 7. Disk fills

> Housekeeping escalates, oldest raw data is evicted first, a critical alarm fires before
> ingestion stops

**Not implemented.** Not untested — absent. Searched: no `statfs`, no free-space read anywhere in
`packages/`, no disk channel on Core Health, and the housekeeper's retention is by **age** only
(`#retention`, `#stateRetention`, `#pruneAudit`). A full disk today stops Postgres, and the first
thing an operator learns about it is that ingestion has stopped.

Filed as `S-17`.

### 8. Clock jumps

> Timing wheel resynchronises against monotonic time; samples keep wall-clock timestamps

**Holds.** `timing-wheel.test.ts` — "ignores a wall-clock step, and says that it saw one". The
wheel runs on `process.hrtime.bigint()`, per `CLAUDE.md`; the sample's `timestamptz` is wall
clock. The "and says that it saw one" half matters: a jump that were silently absorbed would be
indistinguishable from the wheel drifting.

---

## Gaps that cut across rows

### `G1` → `S-17` — nothing knows how full the disk is

Row 7, above. The behaviour §13 specifies has three parts and the system has none of them: no
free-space measurement, no escalation as it falls, and no eviction of oldest raw data ahead of
ingestion stopping.

Worth stating why this is not merely "add a channel": **evicting oldest raw data first is a
policy that interacts with rollups.** Raw data that has not been rolled up yet cannot be dropped
without losing the rollup, so the eviction order is "oldest raw *behind the rollup watermark*",
and the watermark is already what `Housekeeper#rollForward` maintains.

### `G2` → `S-18` — the health sensors ship with no thresholds

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

# Notification timers: what "no leaks across thousands of sensors" costs

**Date:** 2026-08-26
**Task:** `N-04` — latency timer engine
**Measurement:** `packages/core/test/perf/notification-timers.test.ts`

## The question

`N-04` asks for latency timers that "cancel on recovery and on acknowledgement; survive a
restart; no leaks across thousands of sensors". The first two are behaviour and are asserted in
`packages/core/test/alarm-scheduler.test.ts`. The third is a cost, and `CLAUDE.md` is explicit
that a performance claim needs a measurement rather than an assertion.

## What was built, and what was not

The obvious reading of the ticket is a `setTimeout` per pending notification, cancelled when the
sensor recovers or somebody acknowledges it. At the v1 target — 5,000 sensors, each carrying an
initial notification, an escalation and a repeat — that is **15,000 live timer handles**, every
one of them a closure holding a sensor id, every cancellation a chance to leak one, and all of
them gone after a restart with nothing to rebuild them from.

`N-02` had already put the due time in a row (`notification_alarm.next_due_at`, with a partial
index over the rows that have one). So the cancellations this ticket asks for are the `DELETE`s
and `UPDATE`s that already happen for other reasons — an alarm that recovers is removed, an
acknowledged one has its `next_due_at` set to null — and what was left for `N-04` was a single
timer: the one that decides when to look.

`AlarmScheduler` sleeps until the next due time rather than ticking. `N-02` shipped a tick a
second in its place, which was correct and wasteful: an idle installation paid an indexed query
every second for ever, and a due alarm still waited up to a second. Three things end a sleep now
— the due time arriving, `wake()` from the engine when it arms something nearer, and a 60-second
cap that bounds the damage from a lost wake or a wall-clock jump.

## The measurement

2,000 sensors under one device, with a single state trigger on the **root** — inherited by every
one of them, which is `WORKFLOW.MD §6`'s own example of what inheritance is for and the worst
case for the engine. The trigger carries a five-minute initial latency, a thirty-minute
escalation and an hourly repeat, so every sensor has a full chain in flight.

Each figure is one transaction: decide the batch, write the history and the runtimes, reconcile
the alarms — the same sequence and the same order that ingestion uses.

| Step                                            | Time   |
| ----------------------------------------------- | ------ |
| First failure (Warning; nothing armed yet)      | 86 ms  |
| Second failure — **arming 2,000 chains**        | 145 ms |
| Holding them, inside their latency (worst of 3) | 53 ms  |
| Recovery — **cancelling all 2,000**             | 74 ms  |
| Firing 4,000 due steps after an hour            | 189 ms |

> **Corrected by `P-252` (2026-10-11).** The timer counts in the next paragraph measured the
> wrong timers. `process.getActiveResourcesInfo()` names only the handles keeping the process
> alive, and the scheduler `unref`s its timer, so the count never included it: the 2 were the
> database pool's idle clients, each of which holds a timer of its own, and the test failed under
> load when the pool held one more client at one sample than at another. The test now counts the
> timers started from `src/notifications/`, `unref`'d included, and separately everything else
> holding the process net of the pool's idle clients. Re-measured on 2026-10-11, twelve runs
> beside another toolchain container at load 4–8: **notifier timers 1 idle, 1 with 2,000 chains
> pending (0 once, sampled between cycles), 1 after they all cancelled; other timers 0, 0, 0.**
> With an `unref`'d timer per sensor added to the engine, it reads 10,001 with 2,000 pending and
> fails. The original count read 0 throughout for that mutant. The paragraph
> below is kept as it was written.

**Timers held by the process: 2 idle, 2 with 2,000 chains pending, 1–2 after they all
cancelled.** (Two, not one, because the test runner holds one of its own. The count sometimes
reads one lower after the fact, because between cycles the scheduler is momentarily holding no
timer at all — which is why the assertion is "never more than idle" rather than equality: an
equality would be asserting when the sample was taken rather than what the design does.) That is
the claim, and it is structural rather than careful: there is nothing in the design that could
allocate a timer per sensor.

The last row is a restart after a long outage. An hour is past both the five-minute initial
latency and the thirty-minute escalation, so each chain owes two notifications — 4,000 steps,
drained in one wake across two rounds of the bounded sweep. A design with a timer per step would
have had 4,000 of them to rebuild from nothing, and no record of which had already fired.

## The bug the measurement uncovered

`wake()` is called by the engine from *inside* the transaction that arms an alarm — deliberately,
because the alternative is threading an after-commit hook through the ingestion write,
`reevaluate` and every audited mutation, and forgetting one of them means a notification that
waits a minute for no reason. The design note said a spurious wake was harmless: it costs one
indexed query and the scheduler goes back to sleep.

That was half right. A wake that arrives *early* is not harmless. The scheduler can sweep, read,
and find nothing before the arming transaction commits — and then sleep for the full 60-second
cap with the alarm sitting there committed and overdue, because nothing is left to poke it again.
It showed up as a 20-second test timeout roughly one run in four, and in production it would have
been a notification that arrived a minute late for no visible reason and never twice the same way.

A wake that finds nothing is now re-checked rather than believed: twice, at 250 ms and 1 s, the
second generous enough for a commit under load. A genuinely spurious wake — a batch that rolled
back — costs two extra indexed queries and nothing else. Both halves are tested, and the second
test is the interesting one: it runs the same forced race against a scheduler configured with no
re-checks and asserts that it *does* sleep through the commit, so the fix is demonstrated rather
than described.

## What would fail this

The budget in the test is 5,000 ms per reaction, which is generous on purpose — it runs on
whatever the developer or CI has, and it is a regression bound rather than a target. What it
catches is an accidental per-sensor query: at 2,000 sensors a round trip apiece turns 145 ms into
minutes, and the failure would otherwise only show up in an installation nobody can reproduce.

The holding figure is the one to watch. 53 ms is the steady state of a large outage — every
sensor failing, every chain already armed, nothing to do but confirm that — and it is the work
the system repeats every scan interval for as long as the outage lasts.

## What is not measured here

Delivery. Nothing sends anything yet: a fired step queues a `notification_request` in the same
transaction that advanced the alarm, and `N-05` onwards turn those into messages. `N-15`'s
scenario test is where the end-to-end count is asserted against MailHog and a webhook sink.

# P-01 hashed timing wheel — measurements

Date: 2026-08-25 · Node 24.19.0, Debian 12 container on Apple Silicon · reproduce with
`./scripts/dev.sh npm test -w @ms/probe`

`ADR-001` Decision 2 chose an in-house hashed timing wheel over `setTimeout`-per-sensor, BullMQ
and cron libraries, on the claim that a timer heap "does not survive tens of thousands of
sensors". `WORKFLOW.MD` §3 states the constraint it has to meet: **a 60-second sensor fires every
60 seconds ±1s under full load**.

## Dispatch precision at the v1 target

5,000 sensors on a 60-second interval, one simulated hour:

```
300,000 dispatches in 90 ms of CPU
every sensor fired exactly 60 times — no more, no less
worst gap between consecutive firings: 60 seconds, exactly
busiest second: 104 dispatches against an ideal 83
```

Not ±1s: **exact**. The wheel dispatches on integer ticks, so a sensor's firings are congruent by
construction, and the assertion in the test is equality rather than a tolerance. What the ±1s
budget actually buys is the wall-clock lateness of the tick itself, which is measured separately
— against the real timer the p95 tick lag is under 250 ms.

The whole simulated hour costs 90 ms of CPU, which is the number that answers the ADR: the
scheduler is not going to be the bottleneck at 5,000 sensors, and `P-15` can go looking for the
real one.

## Testing a scheduler without waiting for one

The clock is injected. Every test but one drives `now()` itself and calls `advance()` directly,
so an hour of scheduling takes 90 ms and a suspended machine is one assignment. That is why
`advance()` is public: a scheduler tested by sleeping and hoping is a scheduler tested at one
timing, on one machine, once.

The exception is deliberate — one test runs the real timer for two seconds, because the
re-arming path is the part the probe actually depends on and an injected clock never exercises it.

## What the wheel does about time going wrong

**A missed period is coalesced, not replayed.** A stalled process — a stop-the-world pause, a
suspended VM, a closed laptop lid — leaves sensors overdue. Firing each once per missed period
would deliver thirty backlogged pings as a stampede at the worst possible moment; monitoring
wants the state of the world *now*. Measured: a 10-second sensor stalled for 300 seconds fires
once, and the 299 skipped ticks are counted rather than swallowed.

**Phase survives a catch-up.** A task re-arms to the next instant congruent with its original due
tick, so a sensor on the 17th second of each minute is still on the 17th second after the wheel
has been asleep for a thousand seconds.

**More than a revolution behind still fires everything once.** Two hours against a one-hour wheel
walks every slot exactly once; entries re-armed past the target are not found twice.

**A wall-clock step changes nothing.** An hour stepped onto the wall clock with the monotonic
clock unmoved dispatches nothing at all — the wheel is driven by `hrtime.bigint()`, as
`CLAUDE.md` requires. The divergence is noticed, counted and logged, because an operator
debugging "why did my sensors stop for eight hours" should find the suspend in the log rather
than infer it.

That last part was wrong first time and is worth recording. Measuring drift against a fixed epoch
means one NTP step leaves the clocks permanently apart, so every tick afterwards reports the same
jump again — the test caught it reporting one step three times. Comparing *consecutive* checks
reports each divergence exactly once and needs no re-anchoring, so a diagnostic never disturbs
tick numbering.

## Phase spreading

`hash(sensorId) % interval`, with a splitmix32 finaliser rather than `id % interval`: object ids
are not contiguous once a tree has been built and pruned, and gaps in a modulo become clumps in
the schedule. Across 5,000 sequential ids at a 60-second interval every second is used and the
busiest holds fewer than 1.5× the ideal share.

The first firing is the next tick on the sensor's phase, **not** a whole interval away. Waiting
an interval would mean a newly created sensor tells the operator nothing for up to twenty-four
hours, and the first scan is the one they are watching for. That is safe to do promptly precisely
because of the phase: 500 sensors pushed at once all scan within the first interval, and the
busiest second takes fewer than 25 of them.

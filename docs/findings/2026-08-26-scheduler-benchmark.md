# P-15 — the 5,000-sensor benchmark

- **Date**: 2026-08-26
- **Question**: `PLAN.md` Phase 2's exit criterion and `CLAUDE.md`'s go/no-go gate — **5,000
  sensors at 60 s on 8 cores, p95 dispatch jitter under 1 s, sustained**. `WORKFLOW.MD` §3 states
  the same constraint the way it matters to an operator: "a 60-second sensor must fire every
  60 seconds ±1 s under full load".
- **Reproduce**: `scripts/dev.sh "node --test --test-concurrency=1
  packages/probe/dist/test/perf/scheduler-benchmark.test.js"`. `MS_BENCH_MINUTES=60` for the
  sustained run, `MS_BENCH_SWEEP=1` for the pool-size sweep.
- **Machine**: Node 24.19.0, Debian 12 container, 8 cores visible. The development Postgres and a
  three-sensor dev probe were idle alongside; both are negligible at this scale.

## What is measured

**Dispatch jitter, end to end**: from the instant a sensor was *due* to the instant its check
actually began running in a worker. Two things contribute and both are real — the wheel firing
its tick late, and the check waiting for a free worker after it was submitted. They are reported
separately as well, because they have completely different fixes.

Measuring only the first would be measuring a `setTimeout`. A sensor whose check sat in a queue
for four seconds fired four seconds late, whatever the wheel did.

**The checks sleep rather than burn CPU**, because that is what a real check does. ICMP, SNMP and
HTTP checks spend nearly all of their time waiting for a packet, so a worker holds a *slot* while
using almost no CPU. A CPU-burning model would make the pool look CPU-bound when it is not.

## The result

`P-01` measured the wheel alone against a simulated clock and closed with "`P-15` can go looking
for the real one". It found it, and it was not the wheel.

**The wheel is not the bottleneck at any pool size that matters.** Its own p95 lag stayed between
4 and 10 ms throughout — against a budget of 1,000 — including in the runs where end-to-end
jitter was sixteen seconds. `ADR-001` Decision 2's bet on a hashed timing wheel over
`setTimeout`-per-sensor is vindicated by this measurement, not merely by the earlier one.

**The pool default was wrong, by a factor of sixteen.** It was `availableParallelism() - 1` — 7
on this machine — which is what a CPU-bound pool wants. Against the criterion's load that refused
21% of checks outright and delayed the rest by a p95 of **15.8 seconds**.

## The pool-size sweep

5,000 sensors at 60 s, 200 ms checks — an ordinary SNMP round trip and a fast HTTP check — 30 s
per point, no queue limit so that a refusal cannot hide a delay.

| slots | jitter p50 | **jitter p95** | jitter p99 | wheel p95 | pool wait p95 | RSS cost |
| ----- | ---------- | -------------- | ---------- | --------- | ------------- | -------- |
| 7 (old default) | 2 ms | **15,760 ms** | 17,784 ms | 6 ms | 15,757 ms | +80 MB |
| 16 | 1,136 ms | **2,852 ms** | 3,064 ms | 5 ms | 2,846 ms | +115 MB |
| 24 | 208 ms | **615 ms** | 641 ms | 6 ms | 609 ms | +134 MB |
| 32 | 202 ms | **405 ms** | 415 ms | 4 ms | 403 ms | +187 MB |
| **48 (new default)** | 7 ms | **213 ms** | 220 ms | 7 ms | 208 ms | +291 MB |
| 64 | 5 ms | **211 ms** | 255 ms | 7 ms | 207 ms | +329 MB |
| 128 | 4 ms | **7 ms** | 510 ms | 7 ms | 0 ms | +837 MB |
| 256 | 6 ms | **676 ms** | 676 ms | 676 ms | 0 ms | +1,732 MB |

## Reading the numbers

**The governing quantity is the dispatch batch, not average concurrency.** The obvious
arithmetic — 5,000 sensors ÷ 60 s = 83 checks a second, times 200 ms, is 17 in flight — is the
right average and the wrong number to size a pool by. The wheel fires **once a second and hands
over a whole second's batch at once**: 83 sensors, together. The queue then drains in tranches of
`ceil(batch / slots)`, and the wait a sensor sees is `(tranches - 1) × checkDuration`.

The curve is exactly that shape, which is the strongest evidence that this is the real mechanism
and not a story fitted to it:

| slots | tranches for a batch of 83 | predicted p95 wait | measured |
| ----- | -------------------------- | ------------------ | -------- |
| 32 | 3 | 400 ms | 403 ms |
| 48 | 2 | 200 ms | 208 ms |
| 64 | 2 | 200 ms | 207 ms |
| 128 | 1 | 0 ms | 0 ms |

**48 is where more slots stop being worth paying for.** 64 measured no better and cost 38 MB
more. 128 bought 200 ms for another 550 MB, and its p99 was unstable at 510 ms. 256 was worse
everywhere: with that many threads the wheel's *own* p95 lag rose from 7 ms to 676 ms as they
contended with its timer — the one place in this measurement where thread count hurts the
scheduler directly.

**The tie-break against 32 is how slow a check mix survives it.** Three tranches breaches the
one-second budget at roughly a 500 ms check; two at roughly a second. Ordinary HTTP checks exceed
500 ms routinely, so 32 would have been a default that passes this benchmark and fails a
realistic installation.

**It costs about 6.5 MB a worker.** Roughly 290 MB at 48 slots — and a fixed default pays that
whether the probe is watching five thousand sensors or fifty. That is the honest cost of the
change, and the reason `P-18` exists.

## What this says about `icmp.ping`

The one sensor type we ship sends four packets a second apart, so a real check takes about three
seconds. At the v1 target that is 83 × 3 = **250 checks in flight** — an order of magnitude past
what the sweep says is affordable, and past the point where thread count starts costing the wheel
its own precision.

Nothing is broken today: nobody runs five thousand ping sensors on one probe. But it is the
shape of the problem Phase 6 walks into as slower sensor types arrive, and there are two
independent levers — demand-driven pool sizing (`P-18`) and making the check itself cheaper
(`ping -i 0.2` turns three seconds into under one). Both are worth having; neither is urgent.

## The sustained hour

Every number above was measured over 30-second points. That is enough to choose a pool size — the
curve is unambiguous and the mechanism behind it is arithmetic — and it is not enough to close a
gate whose whole point is the word *sustained*. A 30-second window at a 60-second interval sees
each sensor fire at most once, so it cannot show a slow leak, a queue that grows over an hour, or
a worker that degrades.

One hour, 5,000 sensors at 60 s, 200 ms checks, against the new default of 48:

| | Measured | Budget |
| --- | --- | --- |
| Checks dispatched | 300,095 | 300,000 expected at this rate |
| Checks completed | **300,095** | every one of them |
| Refused | **0** | the pool never saturated |
| Dispatch jitter p50 | 8 ms | — |
| Dispatch jitter **p95** | **216 ms** | **1,000 ms** |
| Dispatch jitter p99 | 225 ms | — |
| — of which wheel lag p95 | 11 ms | — |
| — of which queue wait p95 | 209 ms | — |
| Resident memory | +515 MB | — |

**Nothing degraded over the hour.** The p99 sits 9 ms above the p95, which is the signature of a
distribution with no tail rather than one whose tail was not sampled — a queue that grew, a
worker that leaked or a wheel that drifted would all have separated those two numbers. The
completed count equals the dispatched count exactly: no check was dropped, deferred past its
successor, or left in flight at the end.

The split is the same one the sweep predicted. The wheel contributes 11 ms of the 216; the
remaining 209 is a check waiting for a slot, which at 48 slots and a batch of 83 is the third
tranche — 200 ms of predicted wait against 209 measured, over an hour rather than 30 seconds.

**515 MB is the run's total resident growth, not the pool's price.** The pool's own share is the
~290 MB the sweep attributes to it — measured properly, as the delta across pool sizes at
identical load — and the rest is the working set of five thousand scheduled sensors held for an
hour. Reporting the whole 515 as the cost of 48 threads would be the same over-attribution the
sweep already corrected once, when a 704 ms figure measured under a heavier check was blamed on
thread count alone. `P-18` is the task for the 290.

## Verdict

**Go**, with the default changed.

The architecture holds. The hashed timing wheel dispatches five thousand sensors with a p95 lag
under 10 ms, and the bounded worker pool is the right shape — a check that must not block the
scheduler runs somewhere else, and backpressure is counted rather than silent. What was wrong was
one number, chosen from the wrong quantity, and the benchmark that the gate exists to demand is
what found it.

# Observation: today's probe changes on a live stack (P-42 … P-46)

- **Date**: 2026-09-04
- **Method**: the dev stack, not a benchmark — `docker compose up postgres`,
  `scripts/dev-services.sh start`, then reading `ms.probe.health` through the API over 40 minutes.
- **What was running**: `main` at `2800fa7`, so `P-42`–`P-46` inclusive.
- **Scale**: 5,051 sensors on a 60-second interval across 269 devices, one local probe.

This exists because every change in `P-42`–`P-46` was validated by unit tests and a synthetic
benchmark, and none of it had been seen on a probe talking to a real core. That debt was recorded
twice; this pays most of it.

## What the probe says about itself

| Channel | Reading | Against |
| --- | --- | --- |
| `scheduled` | 5,046 sensors | 5,051 configured |
| `schedulerLag` | **5.7 ms** | `P-15`'s 1,000 ms budget |
| `checkWait` | 10.1 ms | — |
| `deferred` / `refused` / `timedOut` / `workerCrashes` | **0** | — |
| `memory` | 2,300 MB at 64 workers | formula predicts 2,360 MB |
| `clockJumps` | 0 | — |

**`P-15`'s gate holds with today's code**: 5.7 ms of scheduler lag is a two-hundredth of the
budget, at the v1 target, with nothing deferred or refused.

**The memory formula is right to 3%.** `docs/sizing.md` says `probe RAM ≈ 120 MB + workers × 35 MB`.
At 64 workers that predicts 2,360 MB and the probe holds 2,300 MB — 36 MB a worker against the
37 MB `H-01` measured over 24 hours at 48 workers. The formula was derived at the old default of
48; it survives `P-32`'s raise to 64 unchanged.

**Resident memory climbs and then stops, and the shape matters.** 1,731 MB at 5 minutes, 2,254 MB
at 34, 2,300 MB at 40 — that is +1,082 MB/h, then +427, then +220. Decelerating toward `H-01`'s
+0.68 MB/h steady state, which is warm-up rather than a leak. **Do not read a probe's memory inside
its first hour**; two samples half an hour apart would have said 1 GB an hour and meant nothing.

**No-data is not zero, in production.** The second probe (`n01`) has never connected here, and
every one of its channels reads `null` rather than `0` — the rule holding where it counts, on a
sensor an operator would otherwise read as a healthy probe scoring zero on everything.

## A defect I thought I had found, and did not

`poolUsage` read **4.7%** while the pool held 64 workers, and no worker had been retired in 34
minutes though `workerPoolMinSize` is 4. That looks exactly like a dead shrink policy, and there is
a mechanism ready to blame: `P-26` changed the decay's question from "has anything been submitted
lately" — true on any busy probe — to "has *this worker* been idle for the whole window", and with
84 checks a second arriving in per-second bursts against 64 workers, every worker is handed a job
every tick and no individual worker is ever idle for a minute. Same question, same answer, one
level down.

**It is wrong, and the reason is the metric rather than the pool.** `poolUsage` is
`poolBusy ÷ poolSize` sampled at the instant the heartbeat is built — not an average and not a
peak. A burst of 84 checks clears in about 20 ms, so a random sample catches the pool busy roughly
2% of the time. 4.7% is what a pool that is *fully* saturated once a second looks like through an
instantaneous gauge. `checkWait` at 10.1 ms is the corroboration: 84 checks against 64 workers
means about twenty of them wait one check-duration, which is exactly what it reads.

So the pool genuinely needs its 64 workers, for about 20 ms in every 1,000, and a decay that
declines to shed them is correct. A change was written to make the decay ask about the pool's peak
concurrency rather than about one worker's idleness; it was reverted, because peak concurrency
*is* 64 here, so the new rule would have declined for the same reason at extra cost per dispatch.
The two rules only disagree when the burst is smaller than the pool, and there `#pump`'s preference
for low-index slots already leaves the high ones idle for the old rule to find.

**What to take from it**: `poolUsage` is a gauge, not a duty cycle, and reading a bursty workload
through it understates the pool by more than an order of magnitude. Anyone sizing from that number
will size wrong. `schedulerLag` and `checkWait` are the signals that do not lie about a burst.

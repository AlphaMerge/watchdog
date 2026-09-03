# Measurements: the auto-sizing loop under sustained load (P-44)

- **Date**: 2026-09-04
- **Method**: `scripts/sizing/autosize.mjs` — the shipped `poolSizer`, the real `CheckPool` and the
  real `TimingWheel`, with the check duration changed underneath a running probe. Three phases of
  180 s: 1,500 ms checks, then 200 ms, then 1,500 ms again. Nothing else varies.
- **Raw data**: `2026-09-04-autosize-loop.json` (180 s phases, sizer at the shipped 30 s) and
  `2026-09-04-autosize-loop-short.json` (70 s phases, sizer at 10 s, with `busy`/`queued`)
- **Reproduce**: `node scripts/sizing/autosize.mjs`
- **Measured on**: 8-core arm64, `node:24-bookworm-slim`, 2,000 sensors on a 60-second interval
  (burst 33.3/s), pool floor lowered to 8 so the loop has somewhere to move

## Why this run exists

`bench.mjs` pins the ceiling and measures the pool underneath it. The sizing **loop** — measure
durations, derive a demand, apply hysteresis, move the ceiling, watch the pool shed or grow,
measure again — had therefore never run under load in any committed measurement, and every claim
in `docs/sizing.md` about how the ceiling behaves was read off the code rather than observed.

It runs the shipped `poolSizer`, imported from the probe's own build, which is why `P-44` extracted
it from `main()` first. Re-implementing the policy inside the benchmark is the mistake `P-31` cost
a week to.

## What is right

**The derived ceiling is exactly Little's floor times the margin.** Burst 33.3/s at 1,500 ms needs
50 workers; `50 × 1.3 = 65`, and the loop settled on **66** in every slow phase. (The extra worker
is float accumulation: the requirement is summed one assignment at a time, and adding `0.05` two
thousand times lands a shade above 50, which `Math.ceil` rounds up. Always upward, always by one.)

**A raise happens in a single step**, as `P-40` intends: 8 → 66 at the first computation, 9 → 66 at
the first computation that saw the new duration. No ramp, no intermediate value.

**A drop needs two consecutive readings**, also as intended: at the shipped 30 s cadence the
workload changed at t=180 and the ceiling moved at t=241 — one tick to see it, one to believe it.

**Nothing was deferred or refused at any point in either run**, including while checks were running
25 seconds late. That is `P-33`'s point measured rather than argued: below the floor the queue
absorbs the backlog and the counters stay at zero.

## Finding 1 — the pool does not come down to its ceiling, and holds memory it was told to release

At t=241 the ceiling dropped from 66 to 9. The pool went to 35 workers, then to 31, and **stayed at
31 for the remaining 120 seconds** — 3.4× its own ceiling. Resident memory held at ~517 MB.

The short run shows why it is not a draining artefact:

| t | ceiling | workers | busy | queued |
| --- | --- | --- | --- | --- |
| 101 | 9 | 35 | 0 | 0 |
| 105 | 9 | 35 | **0** | **0** |
| 110 | 9 | 35 | **0** | **0** |
| 120 | 9 | 31 | 31 | 0 |
| 140 | 9 | 31 | 0 | 0 |

At t=105 and t=110 the pool was **completely idle with nothing queued**, twenty-six workers above a
ceiling it had already been given, and it did not shed one.

**The mechanism.** `CheckPool.#considerShrink`'s prompt pass is correct but *opportunistic*: it
retires whatever is spare at the instant it runs, and breaks the moment a slot is mid-check. It is
invoked from exactly two places — a `setMaxSize` that lowers the ceiling, and the 60-second idle
timer. A wheel that fires every second produces bursts in which most slots are briefly busy, so a
pass landing in one sheds almost nothing and then waits another minute for the next chance.

This contradicts the comment directly above that loop, which says "over the ceiling comes down now,
not one worker a minute", and the `P-39` claim that a lowered ceiling sheds at once. Both are true
of the *ceiling* and neither is true of the *workers*, which is what costs memory. At the real
35 MB a worker, the 22 excess workers measured here are about **770 MB a probe holds after its
workload gets cheaper**. Filed as `P-45`.

## Finding 2 — the ceiling moves after the backlog, not before it

`docs/sizing.md` said a probe whose checks get slower "raises its ceiling before the backlog appears
rather than after". Measured, it is the other way round.

Phase 3, when checks went from 200 ms back to 1,500 ms:

| | shipped 30 s cadence | 10 s cadence |
| --- | --- | --- |
| workload changed | t=360 | t=141 |
| ceiling moved | **t=391** | **t=171** |
| lag | **31 s** | **30 s** |
| queued at the moment it moved | — | **308 checks** |
| worst lateness in the window | **11.6 s** | **10.6 s** |

**The lag is not the sizer's cadence — it is the measurement.** Both runs lag about thirty seconds
despite one recomputing three times as often, because `typicalDurationMs` is a median over a window
of recent runs and that window has to refill before the new duration is visible. Making the loop
run more often does not help; it re-derives the same stale number.

So a probe whose checks slow down runs under-provisioned for roughly half a minute, and in that
window checks can fall ten seconds late with **nothing deferred and nothing refused**. That is not
a defect in the sizing loop so much as its honest limit: it is a feedback controller reading a
lagging sensor. The sizing page has been corrected to say so.

## Caveats

- **The pool floor is 8 here, not the shipped 64.** At 64 the whole fast/slow range of this
  workload clamps to one value and the loop does nothing visible. What is measured is the loop, not
  the floor — but note that Finding 1 bites hardest in the case the code comment itself cites,
  a derived ceiling falling from 256 to 64.
- **Sleeping checks**, as in every other sizing measurement, and for the reason `P-15` gives.
- **The cold start in phase 1 is a harness artefact.** The benchmark has no configuration push, so
  its first sizing is 30 s after start and it spends that time far below the floor (worst lateness
  25.3 s). A real probe sizes about two seconds after its first config push (`P-41`'s settle), so
  do not read the 25 s figure as shipped behaviour. The phase-3 numbers are the shipped case.
- **One machine, one architecture**, and the machine had a background load of about 4.

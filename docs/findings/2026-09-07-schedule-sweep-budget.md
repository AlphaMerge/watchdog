# The schedule sweep: what a minute-by-minute walk over every sensor costs

**Date:** 2026-09-07
**Task:** `P-186` — the schedule sweep has no measured budget
**Measurement:** `packages/core/test/perf/schedule-sweep-performance.test.ts`

## The question

`ScheduleSweep` runs once a minute, for ever, in every installation that uses a schedule. It is
the only periodic loop in this system without a budget — ingestion, rollups, history, clone and
tree build all have one. Nothing measured this, and it matters twice.

It is a **duty cycle**: whatever it costs is paid 1,440 times a day whether or not anything
happens. And it is the term that bounds how long the pause view and the probe's configuration can
disagree after a window edge (`P-185`), which is the only part of it an operator can perceive.

## What was measured

Five thousand sensors — the v1 target — in a tree of the shape an installation has: one probe,
50 groups, 5 devices in each, 20 sensors on each device. Built through `ObjectService`, not by
inserting rows, because the sweep's cost is a recursive walk over the real `object` tree joined
onto `sensor_runtime`, and a tree assembled by hand would be measuring a shape production does
not have. The schedule is assigned at the **probe**, so the inheritance walk runs the full depth.

Three passes, because they are three different questions, and three samples of each.

| pass | median | samples | budget |
| --- | --- | --- | --- |
| no schedule assigned anywhere | **0.8 ms** | 2.4, 0.8, 0.8 | 50 ms |
| a window closing — 5,000 sensors move | **73.5 ms** | 247.2, 73.5, 66.0 | 1,000 ms |
| an ordinary minute — nothing at an edge | **10.4 ms** | 11.6, 10.4, 10.0 | 600 ms |

Measured with `ms-server` and the Vite container stopped, per `CLAUDE.md`. The remaining
containers were idle (all under 2.2% CPU); two containers belonging to unrelated work were
running, which is why three samples are reported rather than one.

## What the numbers say

**An installation that does not use schedules cannot tell the feature exists.** 0.8 ms is the
`LIMIT 1` in `anyWork` returning nothing. That is the common case and it is free.

**The always-paid cost is 10.4 ms a minute at five thousand sensors** — a duty cycle of 0.017%.
The recursive walk resolves the assignment down the whole tree and updates nothing, because
`applyPauses` writes only where `paused_by_schedule IS DISTINCT FROM` what it should be. Doing the
walk and discarding the answer is what makes the steady state cheap: no rows are touched, so no
`sensor_state` rows are written and nothing is pushed to a probe.

**An edge costs 73.5 ms for five thousand sensors moving at once**, including the state
transitions and the flag updates. Twice a day per schedule.

**The first pass of each is visibly dearer** — 2.4 ms, 247 ms, 11.6 ms — and that is cold buffers
and an unplanned query, paid once per process start rather than once a minute. It is reported
rather than averaged away because a reader should be able to see which number is which.

## What this settles about `P-185`

`P-185` was filed claiming the pause view and the probe's filter could disagree "for up to a
minute" after a window edge. That was already wrong on the arming — `ScheduleSweep.#arm` fires 50
ms past every wall-clock minute, and schedule boundaries have minute resolution — and this is the
other half of the answer. The disagreement lasts:

    50 ms (arming) + 73.5 ms (the edge sweep) ≈ 125 ms

at five thousand sensors, twice a day. Not a minute. Nothing in the product needed changing, and
the number is now committed rather than reasoned about.

## What is not measured here

The shape above five thousand. The walk is a recursive CTE over `object` and the cost should be
roughly linear in the sensor count, but that is an expectation and not a measurement — an
installation an order of magnitude larger is `P-15`'s question, and this budget will need
re-measuring there rather than extrapolating. The budgets above are set at roughly ten times the
measured value precisely so that a change which makes this materially worse fails rather than
drifts.

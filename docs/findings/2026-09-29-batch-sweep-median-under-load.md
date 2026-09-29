# The batch-size sweep's relative check, on the median write, under load (`P-237`)

2026-09-29. `packages/core/test/perf/ingestion-performance.test.ts`, the case "sustains 100,000
samples a minute with a p99 write inside 100 ms", run five times back to back in one toolchain
container.

**Deliberately not a quiet run.** The question was whether the relative check survives the
ordinary noise of a shared machine, so the machine was left as it was: other sessions' containers
running, `ms-server` up and connected to the database. Nothing here moves a budget.

```
  perf run conditions
  ----------------------------------------------------------------
  load average   4.85 / 5.87 / 6.44  over 8 CPUs  (0.61 per CPU)
                 as the container sees it, which is the kernel running the tests
  delivered CPU  286 ms for a fixed loop  (1.07x the reference machine's 267 ms)
                 a load average cannot see a host starving this VM; this can
  database       other client connections:
                   ms-core                  2 (0 active)

  !! the machine has work of its own: 0.61 per CPU against 0.5. The budgets below measure it as well as us.
  !! something else is on the shared database. CLAUDE.md asks for `ms-server` stopped
     (`scripts/dev-services.sh stop`); a second session counts too.
```

## Why the old check failed at random

The sweep writes 100,000 readings at each size, so it makes 100 writes at 1,000 rows and 20 at
5,000. `Ingestor.stats()` takes a percentile as the value at index `floor(fraction × n)`, which for
`p99` is index 99 of 100 and index 19 of 20: **the last one, the slowest write, at both sizes.** So
the old check, that the shipped size's p99 is below the largest size's, compared two single
stalls. A stall is added to whichever write it lands on, and one sweep in `P-233`'s window lost by
0.3 ms, 73.8 against 73.5 (`2026-09-29-probe-gate-ingestion.md`).

## The five sweeps

| Sweep | 1,000 rows: p50 | p99 | 2,000 rows: p50 | p99 | 5,000 rows: p50 | p99 | 5,000 ÷ 1,000 at p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 18.4 ms | 41.0 ms | 43.4 ms | 124.2 ms | 160.5 ms | 373.2 ms | 8.7× |
| 2 | 22.9 ms | **121.4 ms** | 61.6 ms | 146.2 ms | 102.1 ms | 178.9 ms | 4.5× |
| 3 | 20.6 ms | **135.8 ms** | 38.1 ms | 89.7 ms | 152.5 ms | 449.9 ms | 7.4× |
| 4 | 18.4 ms | 62.3 ms | 40.8 ms | 120.9 ms | 146.9 ms | 260.9 ms | 8.0× |
| 5 | 39.7 ms | **113.3 ms** | 36.2 ms | 118.5 ms | 110.2 ms | 247.8 ms | 2.8× |

**The medians separate, and the maxima do not.** The shipped size's median write ran from 18.4 to
39.7 ms, and the largest size's from 102.1 to 160.5 ms. The narrowest gap was 2.8×, in the sweep
where everything was slowest. Over the same five sweeps, the shipped size's p99 ran from 41.0 to
135.8 ms, and in sweep 3 the 2,000-row size beat the shipped one at p99, 89.7 against 135.8 ms.

The relative check now compares medians (`shipped.p50 < largest.p50`), with the measured range
stated beside it in the test.

## The absolute budget failed three times, and is not moved

The shipped size's p99, the slowest of its 100 writes, went over the 100 ms budget in sweeps 2, 3
and 5 (121.4, 135.8 and 113.3 ms). That assertion comes before the relative one, so those three
sweeps never reached the new check; their tables show it would have passed. The budget is the
phase's exit criterion, and it is measured on a quiet machine. On `P-233`'s quiet reruns (0.08 to
0.09 per CPU) it held three times out of three. This run is evidence that the criterion, taken
over 100 writes, is a maximum, and that a busy machine breaks it. It is not evidence that
ingestion got slower.

## The other perf cases with the same shape

Every percentile in `packages/*/test/perf` was checked for being taken over too few samples to be
anything but the maximum. For a p99 that is fewer than 101 samples, and for a p95 fewer than 21.

| Case | Statistic | Samples | Kind | Outcome |
| --- | --- | --- | --- | --- |
| ingestion sweep, shipped size | p99 write | 100 writes | absolute, 100 ms | a maximum; noted, see above |
| ingestion sweep, shipped against largest | p99 write | 100 and 20 | **relative** | **the defect; now medians** |
| ingestion, state machine, steady | p99 write | 100 batches of 300 readings, up to 1,000 rows a write: about 30 to 100 writes | absolute, 100 ms | a maximum; noted |
| ingestion, state machine, flapping | p99 write | about 20 writes (one batch a scan, 20 scans) | absolute, 100 ms | a maximum; noted |
| ingestion, gate | worst batch | 10 batches | absolute | already named a maximum, and says why |
| replay soak | live p99, during ÷ quiet | quiet 40; during 15 by default, 300 at `MS_SOAK_FRACTION=1` | **relative**, under 3× | both maxima by default; the quiet one always. Not changed, see below |
| report render (`P-204`) | p95 request wait, after against idle | 184 and 161 in the committed run | relative, idle + 50 ms | a real percentile |
| scheduler benchmark | p95 dispatch jitter | every dispatch of 5,000 sensors for 1.5 minutes | absolute | a real percentile |
| clock freeze, sizing pass, process-runner start-up, schedule sweep, tree build, report build | median | — | — | not affected |

**The replay soak is relative, compares maxima, and is left as it is.** Every live batch waits out
the ingestion flush timer, about 263 ms, and that floor dominates both arms: in the committed
full run the quiet arm's median was 263.7 ms and its maximum 274.6 ms. To fail the 3× budget, a
live batch during the replay has to take about 825 ms, which is a stall of some 560 ms on top of
the floor. That margin is fifty times the arm's measured spread, where `P-237`'s check had 0.3 ms.
A stall that large is the thing the case exists to catch.

The quiet arm's maximum does make the check more lenient: a stall in the control raises the bar
for the replay. Taking the quiet arm's median would remove that, but it changes the statistic
`R-08` recorded in `PLAN.md` (live p99 274.6 → 279.2 ms). That is a decision about the criterion,
not a robustness fix. It was decided the same day: the soak stays as it is, because the check
exists to catch the stall a maximum catches.

The absolute budget's own fix, a real percentile or a budget that says it is a maximum, is `P-251`.

# What a capped young generation costs a check worker (P-207)

- **Date**: 2026-09-13
- **Where**: the Docker Desktop VM on the development Mac — 8 CPUs, 7,936 MiB — with `ms-server`
  stopped and the rest of the dev stack up. The host was not quiet, and how that was handled is
  most of the method.
- **What ran**: `main` at `74391cf` (`P-206`'s spawn limit in place), then the same with
  `WORKER_YOUNG_GENERATION_MB = 8`.
- **Scripts**: [`scripts/sizing/young-generation-cost.mjs`](../../scripts/sizing/young-generation-cost.mjs)
  with [`gc-observing-worker.mjs`](../../scripts/sizing/gc-observing-worker.mjs), and `P-206`'s
  [`worker-startup-memory.mjs`](../../scripts/sizing/worker-startup-memory.mjs) for start-up.
- **Raw samples**: [`2026-09-13-young-generation-cost.jsonl`](2026-09-13-young-generation-cost.jsonl) —
  both runs' summaries and one window a minute plus every stalled one, the first batch's summaries,
  and the start-up and live samples.

## The question

`P-206` found that `resourceLimits.maxYoungGenerationSizeMb: 4` took a 64-worker start-up peak from
2,900 to 2,024 MiB, on `port.tcp`, which allocates next to nothing. A smaller young generation is
collected more often and promotes sooner, so the price — if there is one — is paid by checks that
allocate. WMI needs a Windows host and was not available; the three heaviest the dev stack has:

| Check | What it allocates |
| --- | --- |
| `snmp.table` | a walk of `hrStorageEntry` on `target`'s net-snmp |
| `rest.custom` | a 476 KB JSON document, parsed and run through three JSONPath expressions |
| `db.mysql` | 5,000 rows of 100 bytes from MariaDB, the whole result set in memory |

## The first attempt measured the host, not the cap

The first batch ran one variant per process, eleven minutes each, in the order default, cap, cap,
default, with 16 workers. It said the 4 MiB cap was **up to 30% faster** — p95 down from 67–83 ms to
46–50 on `rest.custom` — and cheaper in CPU. Then a four-worker run of the capped variant collapsed
four minutes in: minor collections on a 4 MiB nursery totalling **12 seconds of pause in a 10-second
window**, 570 checks refused, with the VM's load average at 2.

The host's was **14.95 on eight cores**, with `kernel_task` at 35%. The VM cannot see that from the
inside, which is `perf-conditions.mjs`'s whole reason to exist, and the sequential batch had no way
to tell a slow variant from a slow hour. Its uncapped runs also held 3.3 GiB resident against the
capped runs' 0.9, on a VM that was already short, so they may have been paying for memory pressure
the capped runs were not. **None of the first batch's timing is used below.** Its memory figures
are, because a heap's size does not depend on how fast the CPU delivered it.

## The design that survives a noisy host

The benchmark was rewritten so that **every arm runs at the same time, in one process**: each arm
has its own eight workers, every check is offered to every arm in the same tick, and whatever the
host does in a given second it does to all of them. Beside them, a thread runs a fixed loop once a
window — `perf-conditions.mjs`'s calibration, a tenth the size — so every ten-second window records
the CPU that was delivered while it ran. The summaries are taken twice, over every steady window
and over only the **clean** ones, where the loop ran within 25% of the run's fastest; the tables
below use the clean ones. The comparison is per window: each capped arm's p95 divided by the
uncapped arm's p95 in the same ten seconds, then the median and interquartile range of those
ratios.

**Run 1**: five arms (uncapped, 2, 4, 8, 16 MiB), 25 minutes, 138 steady windows, 117 clean.
Fastest calibration 22.8 ms; the slowest window 117.7. No failures, nothing refused.

**Run 2**: a replicate of uncapped, 8 and 16 MiB, 20 minutes, 108 steady windows, 92 clean. One
window's calibration took **2,478 ms** — the whole VM stalled for more than ten seconds, 280 s into
the run — and every one of the run's ten failed checks is a 10-second timeout that landed in that
window or the two after it, spread across all three arms (2, 5 and 3). Run 1 had none.

## What it costs

Per-window p95 against the uncapped arm, median [interquartile range], clean windows:

| Cap | `snmp.table` | `rest.custom` | `db.mysql` | CPU per check |
| --- | --- | --- | --- | --- |
| 2 MiB | 0.98 [0.85–1.08] | **1.12** [1.03–1.24] | **1.11** [1.03–1.21] | **1.22** [1.07–1.28] |
| 4 MiB | 0.93 [0.86–1.07] | 1.02 [0.92–1.11] | 0.96 [0.87–1.08] | 0.98 [0.85–1.04] |
| 8 MiB, run 1 | 0.96 [0.87–1.07] | 0.94 [0.86–1.03] | 0.91 [0.80–1.00] | 0.91 [0.79–0.98] |
| 8 MiB, run 2 | 0.98 [0.91–1.09] | 0.99 [0.94–1.10] | 1.02 [0.93–1.10] | 0.97 [0.88–1.03] |
| 16 MiB, run 1 | 0.95 [0.88–1.06] | 0.92 [0.82–1.01] | 0.88 [0.78–0.96] | 0.87 [0.76–0.93] |
| 16 MiB, run 2 | 0.98 [0.90–1.06] | 0.97 [0.85–1.06] | 0.98 [0.91–1.05] | 0.95 [0.86–1.01] |

**At 2 MiB the cap costs something** — a tenth on the p95 of the two heavy types and a fifth more
CPU, with ranges that stay above 1. **From 4 MiB up it costs nothing that can be measured**, and at
8 and 16 the first run leaned the other way, a replicate less so. The honest summary of 8 MiB is
*no cost, possibly a small saving*, not *faster*.

The absolute figures, for scale — run 1, clean windows, p50 / p95 / p99 in ms:

| | `snmp.table` | `rest.custom` | `db.mysql` | CPU per check |
| --- | --- | --- | --- | --- |
| uncapped | 18.8 / 49.7 / 81.6 | 53.5 / 139.1 / 236.1 | 32.5 / 87.3 / 149.1 | 8.7 ms |
| 8 MiB | 18.7 / 48.2 / 73.9 | 53.0 / 122.7 / 199.2 | 31.0 / 73.2 / 116.3 | 7.3 ms |

Those durations are high for the checks themselves: forty workers across five arms were hitting
one MariaDB, one net-snmp and one HTTP server in this process at once. They are comparable across
arms in the same window and not across runs.

## What it saves

Heap across each arm's eight workers, averaged over the steady windows:

| Cap | Run 1 | Run 2 | Young generation |
| --- | --- | --- | --- |
| uncapped | 1,348 MiB | 1,300 MiB | 986 / 978 MiB — **123 MiB a worker** |
| 2 MiB | 286 | — | 16 |
| 4 MiB | 320 | — | 32 |
| 8 MiB | **407** | **368** | 64 |
| 16 MiB | 540 | 453 | 127 |

**Left alone, V8 grew every worker's young generation to 123 MiB and kept it.** At the pool's
ceiling of 64 that would be 7.9 GiB of young generation before the old one held anything — not
measured at 64, but the arithmetic is reason enough for a bound. The old generation did not grow
under any cap: over the steady part of each run the first third and last third averaged 198 → 170
MiB uncapped, 219 → 172 at 8 MiB (run 1), 176 → 174 and 186 → 170 (run 2). Earlier promotion did
not become a leak.

Collections, per minute across eight workers, run 1:

| Cap | Scavenges | Scavenge pause | Full collections | Full pause |
| --- | --- | --- | --- | --- |
| uncapped | 37 | 1,966 ms | 54.5 | 1,243 ms |
| 2 MiB | 3,498 | 17,219 ms | 151.7 | 1,906 ms |
| 4 MiB | 1,641 | 9,204 ms | 71.6 | 1,090 ms |
| 8 MiB | 739 | 5,369 ms | 46.8 | 757 ms |
| 16 MiB | 365 | 3,560 ms | 30.4 | 533 ms |

At 8 MiB the workers scavenge twenty times as often and spend 2.7 times as long doing it, yet use
no more CPU per check; at 2 MiB the scavenger's 17 seconds a minute is where the cost shows. Why the
uncapped arm's CPU is no lower despite pausing less was not investigated — the measurement is that
it is not.

## Start-up

`P-206`'s benchmark — 64 workers, eight loading at once, `port.tcp` bursts — run again under the same
conditions for each cap:

| Cap | Peak | Settled at 150 s | All ready |
| --- | --- | --- | --- |
| uncapped | 2,702 MiB | 1,624 MiB | 6.9 s |
| 4 MiB | 1,873 | 1,503 | 6.0 s |
| 8 MiB | **2,129** | 1,754 | 5.7 s |
| 16 MiB | 2,709 | 1,641 | 5.9 s |

**Sixteen does nothing at start-up**: a light check never fills a 16 MiB nursery, so the cap never
binds. Eight takes 573 MiB off; four takes 829.

## The decision: 8 MiB

- **Not 2**: measurably slower and more expensive.
- **Not 16**: no help at start-up, which is where `P-206`'s kill happened, and a busy pool's heap
  a quarter to a third larger than at 8.
- **Not 4**, though it saves 256 MiB more at start-up and costs nothing measured: it is one halving
  from the cap that hurt, measured with checks that are heavy for this dev stack and not
  necessarily heavy for a production one. Eight keeps two halvings of margin and still takes 70% off
  a busy pool's heap.

`CheckPool` now starts every worker with `resourceLimits: { maxYoungGenerationSizeMb:
WORKER_YOUNG_GENERATION_MB }`, and `check-pool.test.ts` asks a worker what it was given — a one-line
option on a constructor is the kind of thing a refactor drops without a test failing.

**Live, same stack and load as `P-206`**: the probe's high-water mark went from **3,041 to 2,473
MiB**, the pool full at 10 s, settling to 1,701 MiB by four minutes (1,707 without the cap). With
`P-206`, a probe that was OOM-killed at 3,520 MiB earlier today now peaks 1,047 MiB lower.

## Reproducing

```
scripts/dev-services.sh stop
scripts/dev.sh 'node scripts/sizing/young-generation-cost.mjs check'
scripts/dev.sh 'node scripts/sizing/young-generation-cost.mjs default,young2,young4,young8,young16 1500'
scripts/dev.sh 'node scripts/sizing/worker-startup-memory.mjs stagger8-young8 150'
```

Read the calibration column before the durations. A run whose clean windows are a minority is a
run of the host.

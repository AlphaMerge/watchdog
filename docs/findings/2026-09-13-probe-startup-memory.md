# A probe's start-up memory, and the OOM kill it caused (P-206)

- **Date**: 2026-09-13
- **Where**: the Docker Desktop VM on the development Mac — 8 CPUs, 7,936 MiB, 1,023 MiB swap —
  shared with the rest of the dev stack and with other sessions' builds and test runs.
- **What ran**: `main` at `f867878` (`P-205`), then the same with `SPAWN_CONCURRENCY`, and — sampled
  the same way, afterwards — `864e82b`, the commit before `P-205` (see
  [the build before `P-205`, sampled](#the-build-before-p-205-sampled)).
- **Load**: the dev database's 5,000 `port.tcp` sensors and one `icmp.ping`, one-minute interval,
  one local probe; the pool at its ceiling of 64 plus the query runner's one worker.
- **Raw samples**: [`2026-09-13-probe-startup-memory.jsonl`](2026-09-13-probe-startup-memory.jsonl),
  every tenth second of each run plus its peak.

## What killed the probe

`P-205`'s confirmation run went silent about 70 seconds after start — the core closed the link for
six seconds without a frame — and was gone before `docker stop` could reach it. The VM's kernel
log has the kill: a `global_oom`, victim `MainThread` in that run's container, **anon-rss 3,687,196
kB — 3,520 MiB**. The task table printed with it says what else was holding memory at that moment
(pages × 4 kB):

| Process | Resident | Note |
| --- | --- | --- |
| ms-probe | 3,520 MiB | the victim |
| PostgreSQL shared memory | 1,429 MiB | `rss_shmem` of the TimescaleDB postmaster |
| a Node process under `npm exec eslint` | 1,294 MiB | another session's lint run |
| ms-core | 253 MiB | |
| SQL Server simulator | 212 MiB | plus 178 MiB swapped |
| swap | 252 kB free of 1,048,572 | exhausted |

So this was not a probe alone outgrowing a box. It was a probe at the top of a start-up peak on a
machine where a lint run happened to be using the headroom. The six seconds of silence before the
kill is what reclaim looks like with swap gone; that part is inference, and the kill is not.

**`P-205` did not cause it.** The `ms-server` built before `P-205`, running the same load, showed a
high-water mark of **3,763,872 kB (3,676 MiB)** while sitting at 1,960 MiB resident with nothing
swapped: the same peak from the old code, which on that occasion found enough memory free. A
sampled run of that build, [below](#the-build-before-p-205-sampled), has the same timeline as well
as the same peak.

## The shape of the peak

The probe was run with [`scripts/sizing/probe-memory-sampler.mjs`](../../scripts/sizing/probe-memory-sampler.mjs)
preloaded, which records its resident memory and every worker's V8 heap once a second:

| Seconds | Workers | Resident (anon) | Worker heaps, committed / used |
| --- | --- | --- | --- |
| 5 | 38 | 1,631 MiB | 1,176 / 705 |
| 10 | 50 | 2,487 MiB | 1,883 / 1,037 |
| 20 | 65 | 3,402 MiB | 2,657 / 1,445 |
| 20 – 105 | 65 | **3,400 – 3,519 MiB** | ~2,500 / ~1,440, up to 60 MiB in one worker |
| 120 | 65 | 2,449 MiB | 1,426 / 994 |
| 240 | 65 | 1,975 MiB | 1,093 / 974 |

**The excess is worker heap, committed during start-up and held for a minute and a half.** At the
plateau the 65 workers had committed about 2,500 MiB of heap and were using 1,440; four minutes in
they had committed 1,093 and were using 974. The drop, when it comes, is V8 giving back pages it had
been holding — nothing in the probe changes at that moment. The kill, about 75 seconds after the
probe started, is inside the plateau.

## The build before `P-205`, sampled

`P-206` asked for the build before `P-205` to be run the same way, and the high-water mark above is
one number from a probe nobody was watching. So `864e82b` — `P-205`'s parent — was built in its own
worktree and run as `scripts/dev-services.sh` runs the core and probe, in one toolchain container
with the main checkout's `dev/data` and `dev/tls` mounted in, the same sampler preloaded and
`ms-server` stopped: 18:01:31 to 18:06:09 UTC, the same 5,001 sensors. The VM had 5,186 MiB available
at the start, and **its swap was already full** — 3 MiB free of 1,023, left by the day's earlier runs,
where the `P-205` run had 169 free.

| Seconds | Before `P-205`: workers, resident (anon), worker heaps committed / used | `P-205` |
| --- | --- | --- |
| 5 | 35, 1,045 MiB, 754 / 501 | 38, 1,631 MiB, 1,176 / 705 |
| 10 | 59, 3,084 MiB, 2,398 / 1,232 | 50, 2,348 MiB, 1,785 / 970 |
| 20 | 65, 3,483 MiB, 2,747 / 1,425 | 65, 3,375 MiB, 2,657 / 1,442 |
| 60 | 65, 3,499 MiB, 2,692 / 1,450 | 65, 3,418 MiB, 2,568 / 1,441 |
| 100 | 65, 3,511 MiB, 2,597 / 1,440 | 65, 3,496 MiB, 2,480 / 1,433 |
| 110 | 65, 2,685 MiB, 1,842 / 1,112 | 65, 3,134 MiB, 2,105 / 1,268 |
| 120 | 65, 2,210 MiB, 1,359 / 976 | 65, 2,477 MiB, 1,478 / 1,008 |
| 240 | 65, 1,869 MiB, 1,087 / 969 | 65, 1,975 MiB, 1,092 / 970 |
| High-water mark | **3,565 MiB** | 3,567 MiB |
| All 65 workers up | 13 s | 18 s |
| Plateau above 3,300 MiB | 12 s – 109 s | 20 s – 105 s |

**The same start-up, to within two megabytes at its peak.** The same 65 workers commit
2,500 – 2,750 MiB of heap to use the same ~1,440, and V8 gives it back at the same moment, around
110 seconds. The one difference is how fast the pool filled — the growth log has 60 steps from
4 s to 13 s here, against 18 s for the pool to fill in the `P-205` run — and it moved the start of
the plateau, not its height. **`P-205` did not change a probe's start-up memory**, which is now a
sampled timeline rather than an inference from one high-water mark.

The run also reproduced the defect `P-205` fixed. Stopped with `docker stop`, the probe logged
"spool drain stopped" with 93 results pending and then **"the result spool is closed and cannot
accept results" 25 times in 12 ms** — the old hook order refusing what the workers delivered, as on
16:27 — where the `P-205` build's confirmation run logged none.

**And it met the thing that killed the first probe.** From about 18:05 another session's `P-207`
benchmark containers ran beside it — `docker stats` caught them at 2.5 and 2.6 GiB and up to 414%
CPU — and the VM's available memory fell to **30 MiB at 18:05:53**, swap empty. `docker events`
records the kernel killing one of those containers at that second (`oom`, exit 137); the session
running them reports a second kill at about 18:05:04. This probe was past its plateau, at about
1,900 MiB, and survived. The plateau figures above are from before any of that; the VM's memory in
the samples after 210 s is not.

The watchdog meant to stop this run below 400 MiB available did not act. It polled every two
seconds with a `docker exec`, read 675 MiB at 18:05:47, and logged its next reading — 2,230 MiB —
at 18:05:53, after the kill had freed the memory. The sampler inside the probe, which needs no new
process to read `/proc/meminfo`, recorded the low. A guard that has to start a process to look is
slowest exactly when memory is shortest.

## Why the heaps were that large: loading together

[`scripts/sizing/worker-startup-memory.mjs`](../../scripts/sizing/worker-startup-memory.mjs) takes the
pool out of it: 64 real `check-worker.js` threads with the real catalogue registry, `port.tcp`
checks against a local listener in bursts of 84 a second, and one thing varied at a time. With
`ms-server` stopped. Peak resident memory, and the time until all 64 had said ready:

| Loading at once | 8 cores | 2 cores (`--cpuset-cpus=0,1`) |
| --- | --- | --- |
| 64 | **≥ 4,331 MiB**, 12.1 s — killed at 50 s | 4,250 MiB, 16.2 s |
| 16 | 3,749 MiB, 5.6 s | — |
| 8 | **2,900 MiB, 6.1 s** | **2,856 MiB, 12.7 s** |
| 4 | 2,802 MiB, 8.6 s | — |
| 2 | — | 2,803 MiB, 13.9 s |

A worker that loads its registry beside 63 others commits about **52 MiB** of heap; one that loads
beside seven commits about **36**. Eight at a time is within 100 MiB of the lowest peak measured on
either machine, and it is *faster* to a full pool than starting everything at once, on both.

**It is not a matter of cores.** The two-core column has the same shape as the eight-core one, which
is why the limit shipped as a constant rather than something derived from `availableParallelism()`.
What V8 does inside each isolate to produce that shape was not investigated; the finding is the
dependence on concurrent loads, measured, and not a mechanism.

**Two benchmark runs were killed by the kernel on this VM**: all at once, at 4,289 MiB, and all at
once with an 8 MiB young generation, at 3,480 — the defect reproducing in the tool built to measure
it. Nothing but the benchmark was killed; the kernel log names both.

## What shipped: `SPAWN_CONCURRENCY = 8`

Every spawn in `CheckPool` — `start`, a growth burst, a crash's replacement, a recycle — now waits
for a turn, and at most eight workers load at once. A spawn waiting its turn is already counted as
growing, so the queue it will absorb does not order it a second time (asserted: 23 spawns for a
shortfall of 23). `check-pool.test.ts` pins the limit with a registry that takes 400 ms to import,
and fails with 24 loading at once when the limit is lifted.

On the live probe, same stack and load, sampled the same way:

| | Before | With the limit |
| --- | --- | --- |
| High-water mark | 3,567 MiB | **3,041 MiB** |
| All 65 workers up | 18 s | **8 s** |
| Plateau | 3,400 – 3,519 MiB to ~105 s | 2,949 – 2,990 MiB to ~110 s |
| At four minutes | 1,975 MiB | 1,707 MiB |

**−526 MiB live, where the benchmark showed −1,431.** A live pool already grows in steps as the
wheel's bursts arrive rather than all 64 at once, so it was never at the benchmark's worst case;
with the limit, the two agree (3,041 against 2,900).

## Measured and not shipped

**A full collection once the registry has loaded** (`gc` variants). Eight at a time with it: peak
2,814 MiB, and resident memory at 1,545 MiB by fifteen seconds rather than ninety. So it removes the
plateau's *length* and not its height, and the only way to call `gc()` in a worker is
`v8.setFlagsFromString('--expose-gc')` after the VM has started, which Node documents as
unpredictable. Not worth it for a shorter plateau at the same peak.

**A 4 MiB young generation** (`resourceLimits.maxYoungGenerationSizeMb`, a supported per-worker
API). On its own: 3,291 MiB. **With eight at a time: 2,024 MiB**, a plateau only about 20% above
steady state, and `port.tcp` throughput unchanged (84.6 checks a second, none failed). That is the
larger win, and it has a cost this benchmark cannot see: a smaller young generation collects more
often, and `port.tcp` allocates next to nothing. SNMP walks, HTTP bodies and WMI results are where
that would show, and `P-207` measures them before anything ships.

## The questions `P-206` asked

**Should the pool ceiling account for memory?** Not from inside the probe. What killed this one was
the box, not the probe's share of it: a lint run and PostgreSQL's shared buffers were 2.7 GiB of
the 7.9, and a ceiling derived from the probe's view of total memory knows about neither.
`workerPoolSize` is the operator's statement of what the probe may use, and `docs/sizing.md` now
gives the peak to size it against rather than the steady state.

**Can Probe Health see the approach?** Half of it. The `memory` channel is resident memory on every
heartbeat, so the plateau is plainly on it: the instrumented run above would have reported over
3,500 MB for a minute and a half. What it cannot see is the other half — how much the *machine* has
left — and that is `P-208`.

## Corrections

- `P-206` as first written said 3.7 GiB; the kernel's 3,687,196 kB is 3,520 MiB.
- It also said the pool's ceiling is derived from the CPU count. It is not: `defaultPoolSize()` is
  a constant 64, and `poolSizer` derives the working ceiling from the assigned work (`P-34`).
- `docs/sizing.md` gave the start-up peak as 2,912 MB at 64 workers, from 2026-09-04. Before this
  change it measured 3,740 MB (3,567 MiB) on the same stack; what grew in between was not
  investigated. With the change it is 3,189 MB.

## Reproducing

```
scripts/dev-services.sh stop
node scripts/sizing/worker-startup-memory.mjs stagger8 150    # inside scripts/dev.sh
node scripts/sizing/worker-startup-memory.mjs at-once 150      # expect a kill on an 8 GB VM
```

The live figures came from `ms-server` with the sampler preloaded — the committed
`probe-memory-sampler.mjs` is that file with its output variable renamed — started as
`scripts/dev-services.sh` starts it plus `NODE_OPTIONS=--import=<sampler>` and
`MS_PROBE_MEMORY_OUT`, and read back with `docker cp` after four minutes.

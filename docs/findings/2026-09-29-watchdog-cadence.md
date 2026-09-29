# A 5 s watchdog ping under starvation at the memory limit: no kills in three runs (`P-243`)

**The margin changed, and nothing was killed.** `P-216c`'s probe was killed by systemd's watchdog
when a 15 s interval timer fired 30.4 s after the previous ping. Both services now ping every
`WatchdogSec`/6, which is every 5 s against the shipped `WatchdogSec=30`, and still from the main
thread. The same harness, box and 5,000 hanging checks ran three times. Neither service was
restarted in any stage of any run. Every ping sent inside the measured window reached PID 1, and the
longest PID 1 went without one was 6.2 s. PID 1 received 688 of the core's 688 pings and 689 of the
probe's 689.

**What this does and does not show.** All three runs were milder than `P-216c`, so they show the
cadence holds under this stress, not under `P-216c`'s. Its probe's main thread was held for up to
7.4 s in a single block, with sampler gaps up to 15.0 s. Here the longest block was 5.0 s and the
longest sampler gap 5.9 s, and the box's memory pressure (`some`) peaked at 2.80% against 3.37%. So
the cadence has been shown against blocks of up to 5 s, keeping the gap within 1.2 s of its 5 s
interval, and it has **not** been shown against a 7–15 s block. Arithmetic says that costs a 20 s
gap at most, 10 s inside the limit; no run here tested it. The harness was not made harsher to force
one: a run tuned until it kills measures the tuning.

## The choice

The ticket gave three answers.

- **Off the main thread: no.** A thread that pings while the event loop is hung is a watchdog that
  cannot see the one thing it exists for. Making it ping only on proof of main-loop progress puts
  the main thread back in the path.
- **The kill is correct: no.** A restart lands on the same host under the same load, and counts
  toward `P-215`'s start limit (`H-23`). `P-216c`'s restart relieved nothing: the probe came
  back into the same load and the same full box, for the 190 s the stage had left.
- **A smaller interval: yes.** The longest gap becomes the longest block plus one interval. At
  `WatchdogSec`/6 that is block + 5 s, against 30 s: a 15 s block leaves 10 s, where the old
  interval left none. How soon a hung service is caught stays `WatchdogSec`. It costs four more
  `systemd-notify` spawns a minute per service, which took 5–686 ms each here and never failed.

`watchdogIntervalMs` in `packages/shared/src/lifecycle/systemd.ts` divides `WATCHDOG_USEC` by
`WATCHDOG_PINGS_PER_INTERVAL` (6), with a 1 s floor. An operator who shortens `WatchdogSec` keeps
the same margin in proportion.

## Per run and stage

| Run | Stage | Load (max) | Memory `some` (max) | Box memory (max) | `memoryLimitUsage` (max) | Main-thread block (max) | Sampler gap (max) | Longest ping gap, core / probe | Pings sent → received, core / probe | Slowest send, core / probe | Restarts |
| --: | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 1 | 0 baseline | 5.1 | 1.86% | 4,005 MiB | 90.0% | 0.3 s | 1.3 s | 5.1 / 5.1 s | 24→24 / 24→24 | 65 / 20 ms | 0 |
| 1 | 1 CPU ×6 | 56.7 | 0.18% | 4,011 MiB | 90.2% | 0.9 s | 2.0 s | 6.0 / 5.6 s | 48→48 / 48→48 | 460 / 131 ms | 0 |
| 1 | 2 + balloon | 57.1 | 1.86% | 4,095 MiB | 95.1% | 0.6 s | 1.4 s | 5.2 / 5.5 s | 60→60 / 60→60 | 184 / 124 ms | 0 |
| 1 | 3 + tighter balloon, stalled log | 57.0 | 2.49% | 4,095 MiB | 97.1% | 5.0 s | 5.9 s | 5.2 / 5.7 s | 61→61 / 62→62 | 163 / 96 ms | 0 |
| 1 | 4 recovery | 49.8 | 0.00% | 3,827 MiB | 90.4% | 0.1 s | 1.1 s | 5.1 / 5.1 s | 36→36 / 36→36 | 19 / 10 ms | 0 |
| 2 | 0 baseline | 5.2 | 1.14% | 4,037 MiB | 90.2% | 0.1 s | 1.0 s | 5.0 / 5.0 s | 24→24 / 25→25 | 23 / 17 ms | 0 |
| 2 | 1 CPU ×6 | 66.2 | 0.36% | 4,033 MiB | 90.0% | 1.4 s | 3.7 s | 5.5 / 5.6 s | 48→48 / 47→47 | 299 / 686 ms | 0 |
| 2 | 2 + balloon | 56.4 | 0.66% | 4,096 MiB | 94.4% | 1.1 s | 1.5 s | 5.5 / 6.2 s | 60→60 / 61→61 | 125 / 150 ms | 0 |
| 2 | 3 + tighter balloon, stalled log | 55.4 | 0.59% | 4,088 MiB | 96.2% | 3.7 s | 3.9 s | 5.1 / 5.5 s | 62→62 / 61→61 | 184 / 144 ms | 0 |
| 2 | 4 recovery | 50.1 | 0.00% | 3,875 MiB | 90.9% | 0.2 s | 1.1 s | 5.1 / 5.1 s | 36→36 / 36→36 | 31 / 15 ms | 0 |
| 3 | 0 baseline | 2.8 | 0.62% | 3,850 MiB | 90.0% | 0.1 s | 1.0 s | 5.0 / 5.1 s | 24→24 / 24→24 | 18 / 12 ms | 0 |
| 3 | 1 CPU ×6 | 53.5 | 1.91% | 3,836 MiB | 90.0% | 0.6 s | 1.8 s | 5.1 / 5.3 s | 48→48 / 48→48 | 99 / 151 ms | 0 |
| 3 | 2 + balloon | 54.8 | 2.80% | 4,010 MiB | 95.3% | 0.5 s | 2.3 s | 5.2 / 5.7 s | 60→60 / 60→60 | 187 / 385 ms | 0 |
| 3 | 3 + tighter balloon, stalled log | 55.3 | 2.03% | 4,095 MiB | 98.6% | 3.5 s | 3.7 s | 5.1 / 5.5 s | 61→61 / 61→61 | 146 / 120 ms | 0 |
| 3 | 4 recovery | 50.7 | 0.00% | 3,761 MiB | 90.2% | 0.1 s | 1.0 s | 5.1 / 5.1 s | 36→36 / 36→36 | 14 / 11 ms | 0 |

Ping gaps are the longest between two consecutive receipts in PID 1's own debug log (`Got
notification message … WATCHDOG=1`), not the harness's one-second polls. Main-thread blocks are
`monitorEventLoopDelay`'s maximum in each one-second sample from inside the probe, and the sampler
gap is the longest time between those samples; both are the probe's, not the core's.

Stage 3 stalls the probe's stdout, as in `P-216c`, and **no longer stresses the log**. With
refusals summarised once every 30 s (`P-216` part 3) the probe wrote 35–65 bytes a second, so
the stage's five minutes fit in the pipe's 64 KB buffer: the backlog read 0 and nothing was
dropped in any run. The bound is exercised by the unit test that writes to a pipe nobody reads.

**These runs predate `P-244`.** `d247b02` still has the memory cap's 10% reserve, so
`memoryLimitUsage` read 90% or more in every stage of every run, up to 98.6%. On a build with
`P-244`'s 25% reserve (`29a382a` onward), a saturated probe settles at or under 75%, so the same
figure would mean something else: here it is the cap doing what it was built to do, not a probe
about to be killed. The runs stayed on the older build so that they measure the same probe as
`P-216c`. The pool was therefore larger than a probe with `P-244` would hold. It reached 107–134
workers here, and a quarter keeps back 614 MiB more of 4 GiB, about 15 workers at the 40 MiB the cap
charges. So the memory side of the stress was, if anything, harder.

## Conditions

Every run: `scripts/sizing/probe-starvation.sh`, the same box shape (Debian 12, systemd 252,
8 CPUs, `memory.max` 4,294,967,296, `memory.swap.max` 1,073,741,824), 5,000 `port.tcp` sensors at a
60 s interval with `timeoutMs` 5,000 against `blackhole.pl`, and a preflight whose four connects
read connected, timeout, timeout, timeout. The balloon's `oom_score_adj` read 1000 on a trial unit
before each. Every Watchdog session held and `ms-server` was stopped: the toolchain count read 0 at
every 30-second sample of every run, and `ms-server` was absent in all of them.

| Run | Measured from (UTC, 2026-09-29) | VM before: available, swap used | VM after: load 1 / 5 / 15 min, available | Other containers, peak share of one CPU |
| --: | --- | --- | --- | --- |
| 1 | 03:22:57, for 1,169 s | 5,501 MiB, 522 of 1,023 MiB | 1.06 / 20.32 / 25.41, 5,878 MiB | CI runners ≤ 2.6%; dutydesk-cloud site 59.9% (mean 12.0%), db 24.4%, api 22.2%; dev PostgreSQL 30.1% |
| 2 | 04:03:05, for 1,164 s | 5,495 MiB, 520 of 1,023 MiB | 3.03 / 24.85 / 28.82, 5,876 MiB | CI runners ≤ 5.5%; dutydesk-cloud site 50.1%, db 39.5%, api 24.1%; dev PostgreSQL 50.2% (mean 4.0%) |
| 3 | 04:45:21, for 1,162 s | 5,492 MiB, 519 of 1,023 MiB | 2.77 / 25.50 / 28.13, 5,892 MiB | CI runners ≤ 3.5%; dutydesk-cloud site 33.4%, api 22.3%, db 6.8%; dev PostgreSQL 7.5% |

The CI runners are other projects' (`ddc-runner`, `ddc-runner-2`, `whatsbot-runner-fixed`), idle and
not ours to pause. The `dutydesk-cloud` stack, another project's eight containers, was up for all
three runs and was not there for `P-216c`; its peaks were brief (means under 12% of one CPU)
against a hog of 48 busy loops, and it is the one difference in the neighbours worth knowing.

All three runs installed the **same tarball**, built once from `d247b02` (the build stamp reads
`dirty: false`; sha256 `9cc56b20…`). Runs 2 and 3 were handed it directly, so that edits made in
the checkout between runs could not reach the box. The harness itself was identical in all three.
The commit that lands is `d247b02` rebased onto `P-244`, which touches no file the harness or the
services' watchdog path uses.

`2026-09-29-watchdog-cadence.jsonl` holds, per run, the stage records, every ping sent and PID
1's record of every ping received for both services, the five-second ticks with a subset of Probe
Health, and every tenth sample from inside the probe plus both sides of every gap longer than 3 s.

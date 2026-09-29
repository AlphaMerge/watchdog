# A probe whose checks hang grows its pool until the kernel kills it (`P-216b`, filed as `P-236`)

**Probe Health read 95% of its memory limit, and nothing acted on it.** A probe with 5,000
`port.tcp` sensors against a port that never answers grew its check pool to 98–110 workers, 3.7 to
4.0 GiB, and was killed by the kernel for its 4 GiB box six times in six minutes. The first came
nine seconds after its sensors arrived, in the baseline stage, with no CPU hog and no balloon
running. On the sixth, `StartLimitBurst=5` in 600 s left `ms-probe` failed for good: a probe that
has stopped and will not come back. That is the incident's "grew and went silent", reproduced
by the probe on its own.

systemd's watchdog killed nothing. Every kill was memory.

## The mechanism

- **The pool sizer knows the workload and not the memory.** `P-34` derives the pool's ceiling from
  Little's law on measured check durations. With every check waiting out its 5 s timeout, that is
  5,000 / 60 s × 5 s × 1.3 ≈ 540 workers, clamped to `autoPoolCeilingMax()`, 256.
- **Growth goes to the ceiling in one step.** `#grow()` adds workers for the whole unmet queue at
  once, and the queue was never empty: it sat at its 1,000 bound, and up to 4,323 checks were
  refused in one probe life.
- **A worker costs 35–40 MiB here.** From the probe's own samples, the RSS above what it held at
  5 workers, divided by the workers added, came to 35 MiB at 99 workers and 40 at 66. In `P-216`'s first run, with checks that
  finished in under a millisecond, it was about 27. 256 workers would be about 9.5 GiB, past the
  shipped `MemoryMax=6G` as well as this box.
- **The probe measured its own approach and did nothing with it.** `memoryLimitUsage` on Probe
  Health (`P-210`) read 95.1% six seconds before the fifth kill and 94.4% seven seconds before the
  sixth, and 73–82% in the last report before the others, which come every five seconds and lag.
  Nothing in the probe reads it.

Backpressure itself worked as designed. The queue held at its bound, refusals were counted, and
`checkWait` climbed to 67 s. The pool saturating was visible. The pool growing past its memory was
not bounded.

## Each restart

| Probe life, s after go | Ended by (systemd `Result`) | Workers at the last sample | Probe RSS at the last sample | Box memory at the last tick |
| ---------------------- | --------------------------- | -------------------------: | ---------------------------: | --------------------------: |
| started before go – 19.5 | `oom-kill`                | 108                        | 3,740 MiB                    | 4,096 of 4,096 MiB          |
| 25.8 – 61.0            | `signal`                    | 98                         | 3,776 MiB                    | 4,096 of 4,096 MiB          |
| 66.3 – 101.9           | `signal`                    | 101                        | 3,832 MiB                    | dying¹                      |
| 106.1 – 164.3          | `signal`                    | 107                        | 3,968 MiB                    | dying¹                      |
| 169.9 – 263.4          | `signal`                    | 110                        | 3,904 MiB                    | dying¹                      |
| 268.2 – 374.8          | `signal`                    | 110                        | 3,958 MiB                    | 4,096 of 4,096 MiB          |
| 380.4                  | `failed`: start limit hit   | –                          | –                            | –                           |

¹ The last tick caught the process with two threads left and its memory being released.

The first kill reads `oom-kill` because the OOM killer took a process inside the unit and the unit's
default `OOMPolicy=stop` stopped the rest. The five after it read `signal`. The journal lines that
name the signal were lost (below). An RSS of 3.8–4.0 GiB in a 4 GiB box at the last sample of
every life leaves the kernel's OOM killer as the only candidate.

With the probe dead the box used 150–260 MiB, so the probe was nearly all of the box. Memory
pressure (`full`) in the box peaked at 9.08%, and the box's swap at 256 MiB.

## What it did not answer

`P-216`'s own question, whether a probe grows when its log stalls, is still open. The stalled-stdout
stage began at 677 s, five minutes after the probe had stopped for good, so it paused a log with
nobody writing to it. The probe's log backlog peaked at 16.5 KB while it was alive. The rerun after
`P-236` (`P-216c`) is where that gets measured, on a probe that stays up.

## What was lost, and why

The run ended at the heap snapshot. A failed unit's `MainPID` is 0, the harness sent `SIGUSR2` to it,
and `kill(0, …)` signals the sender's own process group: the harness killed itself, exit 140, before
it read PID 1's journal. The shell then removed the box, and with it:

- **PID 1's journal at debug**, which names each kill's signal and the start-limit decision;
- **the probe's own output**, 3.0 MB through the FIFO, which held the pool's `pool ceiling` and
  `growing the check pool` lines. So the ceiling the sizer actually set is inferred from the
  arithmetic above, not read.

What survived: the stage and unit-event records, 832 one-second ticks with Probe Health every five
seconds, and 1,019 one-second samples from inside the probe. The harness now refuses to signal pid 0
or a dead pid, undoes its stages and reads the journal even when a stage throws, and has the shell
copy PID 1's journal, the units' journals, the kernel's OOM lines and the probe's output out of the
box before anything removes it.

## Conditions

`scripts/sizing/probe-starvation.sh` on `92ef472`, measured from 23:38:47 UTC on 2026-09-28. The box
ran Debian 12 with systemd 252 on 8 CPUs, with 5,000 `port.tcp` sensors, 60 s interval and
`timeoutMs` 5,000, against `blackhole.pl` on port 9999. The preflight confirmed the port hangs: one
connect filled the backlog-0 queue, and the next three timed out.

- **The box as built:** `memory.max` 4,294,967,296, `memory.swap.max` 1,073,741,824.
- **The VM at go:** 5,570 MiB available and 770 of 1,023 MiB swap in use, so it ran as built.
- **Every other session held**, and `ms-server` was down (restart-looping on exit 78).
- **The balloon's `oom_score_adj`** was 1000 on a trial unit. It never ran while the probe was
  alive, so it had no part in any kill.

`2026-09-29-probe-starvation-b.jsonl` holds the stage and unit-event records, the five-second ticks
with a subset of Probe Health, and every fifth sample from inside the probe, plus the last one of
each life.

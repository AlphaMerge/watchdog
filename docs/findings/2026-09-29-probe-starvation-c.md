# A memory-capped probe under starvation: no OOM, and one watchdog kill that was not the log (`P-216c`)

**`P-236` held, and something else did not.** The same 4 GiB box and the same 5,000 checks that
hang to their timeout killed `P-216b`'s probe six times for memory. This time the pool stopped at
what memory held, 79–131 workers, with up to 207 held back and the rest refused and counted. There
was no OOM kill in any stage, and the probe's resident size never passed 3.2 GiB.

But systemd's **watchdog** killed the probe once, 110 s into the stage that stalls its stdout on
top of the CPU hog and the tightest balloon. It restarted once, cleanly, and stayed up to the end.
The core, alive throughout, did not restart. This is the first watchdog kill in any of the
starvation runs.

## The kill was not the log

The stalled stdout is the obvious suspect, and the evidence says otherwise.

- **The log buffered; it did not block.** The probe's SonicBoom backlog grew steadily through the
  stall, 61 KB to 1.09 MB in the minute and a half before the kill. That is `write` returning while
  its data queues, not a `write` waiting on a pipe. After the reader was resumed, the restarted
  probe's 2.06 MB backlog drained to zero in about five seconds.
- **The core came within 4.4 s of the same limit, and its stdout was never stalled.** It logs to
  the journal, not to the FIFO. Its longest ping gap was 15.6 s under CPU alone, 19.3 s once the
  balloon pressed, and 25.6 s in the stall stage. The probe's own gaps rose the same way: 16.6, 25.1
  and then 30.4 s, which is the kill. What both services had in common in that stage was the host:
  load 72 on 8 CPUs, and the box at 4,096 of 4,096 MiB with its memory pressure (`some`) at 3.37%.
- **The ping was not late in the sending; it was never started.** The last ping before the kill
  went at 772.8 s and the next at 803.2 s: 30.4 s against `WatchdogSec=30`, with systemd's timeout
  0.1 s before the late one arrived. Every ping the probe did start took 48–700 ms to reach PID 1,
  so the missing one is a 15 s interval timer that did not fire on time. The probe's main thread was
  held for that long.
- **The main thread was held in blocks of seconds, in every stage with the balloon.** The sampler
  runs on that thread, and its own gaps show it. It saw no gap past 3.5 s under CPU alone, up to
  11.1 s once the balloon pressed, and up to 15.0 s in the stall stage, just before the kill.
  `monitorEventLoopDelay` put single blocks at 5.4 s and 7.4 s. Garbage collection accounts for
  some: up to 3.7 s of GC in one second's sample, on a main heap of 30 MiB, which is a thread off
  the CPU rather than a large heap. The rest is not attributed. A thread faulting pages in a cgroup
  at its limit, with 48 busy loops competing for the CPU, is the likely reading, and the core
  shows the same pattern with no pool and no stalled log.

**Answered by `P-243`:** both services now ping every 5 s, a sixth of `WatchdogSec`, and three
reruns of this harness killed nothing, with no gap past 6.2 s. Those reruns were milder than this
one, with blocks of up to 5 s rather than 7–15 s (`2026-09-29-watchdog-cadence.md`).

So **`P-220`'s question has an answer after all**: CPU starvation alone did not kill (`P-220`),
and CPU starvation with the memory at the box's limit did. A 15 s ping interval against a 30 s
limit leaves room for one late ping. Main-thread blocks of 7–15 s used that room up.

## What the log path did show

It did not cause the kill, and it is still wrong in two ways that a longer stall would make
matter.

- **One line per refused check.** 61,957 of the 62,309 lines the probe wrote, 12.2 of its 12.6 MB,
  were *check queue is full, refusing a check*, one per refusal, about 11 KB a second while the
  pool was saturated. The count is already on Probe Health (`refused`), so the lines carry nothing
  the channel does not.
- **The backlog has no bound.** SonicBoom's `maxLength` is 0, so a journal stalled for an hour at
  that rate would hold about 40 MB in the probe, and a day about 1 GB, with nothing counted and
  nothing on Probe Health. Here it held 2 MB for five minutes and let it go.
- **An exit could lose the write in flight** (found while fixing the two above, `P-216` part 3).
  SonicBoom writes asynchronously, and while the output pushes back it holds one chunk in a write
  it is retrying, which its exit flush skips, so an exit then could lose that chunk and write the
  lines after it: the last lines missing or out of order, exactly when a crash wrote them.

The sizer's *workload needs more workers than a probe may derive for itself* warning also came
once per 30 s pass, 37 times, where *memory is holding the check pool back* came once per probe
life, as `P-236` intended.

## What `P-236` did, stage by stage

| Stage | Load (max) | Box memory (max) | Pool ceiling (memory cap) | Held back (max) | Refused (max in a report) | `memoryLimitUsage` (max) | Probe RSS (max) | Ping gap, probe / core | Restarts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 baseline | 5.8 | 4,035 MiB | 79–107 | 177 | 6,267 | 90.0% | 3,202 MiB | 14.9 / 14.9 s | 0 |
| 1 CPU ×6 | 63.3 | 4,021 MiB | 107–131 | 149 | 20,331 | 89.9% | 3,201 MiB | 16.6 / 15.6 s | 0 |
| 2 + balloon | 70.6 | 4,095 MiB | 92–131 | 164 | 38,905 | 93.8% | 3,178 MiB | 25.1 / 19.3 s | 0 |
| 3 + tighter balloon, stalled log | 72.4 | 4,096 MiB | 49–122 | 207 | 45,647 | 94.7% | 2,892 MiB | **30.4** / 25.6 s | **1, watchdog** |
| 4 recovery | 53.4 | 3,907 MiB | 63–116 | 193 | 20,542 | 90.1% | 3,204 MiB | 15.4 / 19.3 s | 0 |

Ping gaps are the harness's one-second readings of `WatchdogTimestampMonotonic`, except the
probe's 30.4 s in stage 3, which is from the sent and received records around the kill.

**A side effect worth a decision:** the cap keeps a saturated probe's working set at about 90% of
its limit, because the reserve is 10% of it. Probe Health's `memoryLimitUsage` warns at 80%, so a
saturated, capped pool raises that warning beside `poolUsage`'s: two alarms for one condition. It
read 89.9–94.7% in every stage here, the baseline included.

## Conditions

`scripts/sizing/probe-starvation.sh` from `96ef77d` (the build manifest says `dirty: false`),
measured from 01:17:04 to 01:37:10 UTC on 2026-09-29. Debian 12, systemd 252, 8 CPUs, 5,000
`port.tcp` sensors at a 60 s interval with `timeoutMs` 5,000 against `blackhole.pl`. The
preflight's four connects read connected, timeout, timeout, timeout.

- **The box as built:** `memory.max` 4,294,967,296, `memory.swap.max` 1,073,741,824.
- **The VM before:** load 1.08 / 2.87 / 5.73; 5,550 MiB available and 530 of 1,023 MiB swap in use
  (the go script read 5,535 MiB four seconds later, so the box ran as built).
- **The VM after:** load 10.71 / 31.97 / 32.55, the hog's decay; 5,984 MiB available.
- **Every Watchdog session held, and `ms-server` stopped.** The toolchain count read 0 at every
  30-second sample.
- **Other-project CI runners in the same VM** (`ddc-runner`, `ddc-runner-2`,
  `whatsbot-runner-fixed`), idle and not ours to pause. They were sampled every 30 s: brief peaks
  of 0.6–7.4% of one CPU and nothing sustained, against a hog of 48 busy loops.
- **A second smoke box**, `ms-smoke-install-debian-62666`, another session's, was present with its
  services stopped: 0% CPU, 122 MiB.
- **The balloon's `oom_score_adj`** was 1000 on a trial unit.

`2026-09-29-probe-starvation-c.jsonl` holds the stage and unit-event records, every ping sent and
PID 1's record of it for both services, the five-second ticks with a subset of Probe Health, and
every fifth sample from inside the probe, plus both sides of every gap longer than three seconds.
Nothing was lost this time: PID 1's journal, the units' journals, the probe's 12.6 MB of output and
a 16 MB heap snapshot of the restarted probe all came out of the box before it was removed.

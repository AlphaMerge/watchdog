# A loaded probe on a starved host: first run (`P-216`, with `P-220`'s memory stage)

**An honest negative, for conditions that did not reproduce the incident.** A probe with 5,000
sensors in the smoke box went through a baseline, six busy loops per CPU, then CPU with a memory
balloon, then CPU, the balloon and a stalled stdout, then recovery. systemd killed and restarted
nothing: `NRestarts` stayed 0 for both units in every stage, and the longest ping gap was 18.6 s
against `WatchdogSec=30`. The probe did not grow either. Its RSS peaked at 2,542 MiB while it
started up and held 1.8–2.0 GiB after that.

It did not reproduce the incident, on two counts, and both are faults of the run rather than
findings about the probe:

1. **There was no memory pressure.** The balloon ran in both memory stages (1,480 and 1,301 MiB)
   and the box sat at 4,007 of its 4,096 MiB. But the box's memory pressure stayed at 0, the VM's
   `full` peaked at 1.66%, and neither the box nor the probe used any swap. The balloon was sized
   against `memory.current`, which counts reclaimable page cache, so the kernel dropped cache and
   nothing had to wait. It has to be sized against anonymous memory.
2. **There was no backpressure.** A `port.tcp` check to a port listening on the same host finishes
   in well under a millisecond. At 5,000 a minute the pool was idle most of the time: `queued` 0,
   `refused` 0, and the probe at 8–20% CPU once the hog had it. So the refusal flood that filled
   the incident's log never started, the log's backlog stayed at 0, and the stalled-stdout stage
   paused a log that had nothing to say.

## What it did measure

- **The main thread's event loop waits 2.3–2.5 s under CPU starvation.** That is the sampler's
  `monitorEventLoopDelay` maximum in the CPU stages. In the first CPU stage the sampler missed 60
  of its 240 one-second samples, which is the loop not getting the CPU, not a crash. The core's
  and the probe's watchdog pings still arrived within 18.6 s.
- **The workers hold the memory, not the main thread.** 65 workers held 1.1–1.6 GiB of heap
  between them, and the main heap stayed at or under 55 MiB used. The heap snapshot at the end of
  the stall stage, which covers the main thread only, is 16 MB. So growth like the incident's has
  to come from the main thread's buffers under a flood, or from the workers, and this run had
  neither.
- **Start-up is the peak**, 2,542 MiB, matching `P-206`'s 2,473 MiB. After it the probe settled
  at 1.8–2.0 GiB and stayed there through every stage.
- **The scheduler fell behind but kept up.** Its lag peaked at 310 ms, with 39 skipped ticks.

## Per stage

| Stage             | Load (max) | CPU `some` | Memory `full`, VM / box | Box memory (max) | Probe RSS (max) | Probe CPU (max) | Loop delay (max) | Ping gap, core / probe | Queued / refused | Restarts |
| ----------------- | ---------: | ---------: | ----------------------: | ---------------: | --------------: | --------------: | ---------------: | ---------------------: | ---------------: | -------: |
| 0 baseline, 120 s |      19.07 |     37.15% |                0.36% / 0 |        3,267 MiB |       2,541 MiB |            424% |           754 ms |          14.9 / 15.0 s |            0 / 0 |        0 |
| 1 CPU ×6, 240 s   |      73.04 |      88.8% |                0.86% / 0 |        2,813 MiB |       2,171 MiB |            147% |         2,340 ms |          18.6 / 17.8 s |            0 / 0 |        0 |
| 2 + balloon       |      72.89 |     94.58% |                1.66% / 0 |        4,007 MiB |       1,769 MiB |            100% |         1,689 ms |          15.8 / 15.1 s |            0 / 0 |        0 |
| 3 + stalled log   |      50.64 |     95.25% |                0.02% / 0 |        3,934 MiB |       1,855 MiB |             19% |         2,462 ms |          15.1 / 14.9 s |            0 / 0 |        0 |
| 4 recovery, 180 s |      50.93 |     92.62% |                   0 / 0 |        2,810 MiB |       2,017 MiB |             34% |           118 ms |          15.0 / 14.9 s |            0 / 0 |        0 |

Load and pressure are `avg10` and 1-minute figures, which lag a stage change. That is why recovery
still shows the hog's numbers at its start.

## Conditions

`scripts/sizing/probe-starvation.sh` on `58da25a`, from 22:53:31 UTC on 2026-09-28. The box ran
Debian 12 with systemd 252, on 8 CPUs, with 5,000 `port.tcp` sensors against the core's own port.

- **The box as built:** `memory.max` 4,294,967,296 and `memory.swap.max` 1,073,741,824.
- **The VM at go**, from `free -m` inside the box, which shows the VM because the box shares the
  host's cgroup namespace: 5,628 MiB available and 796 of 1,023 MiB of swap already in use.
- **Every other session held.** `ms-server` was down: it has been restart-looping on exit 78 since
  the day before.
- **The balloon's OOM priority**, checked before go on a trial unit of the same shape:
  `oom_score_adj` 1000, so a memory-cgroup OOM would take the balloon first.
- **Resident, not promised:** the balloon touches every page it allocates (`Buffer.alloc(…, 1)`).

`2026-09-29-probe-starvation.jsonl` holds the stage records, a five-second tick with a subset of
Probe Health, and every tenth sampler line from inside the probe during the run.

## Next

The same harness, changed so the conditions are reached:

- **A pool that fills.** The target becomes a local listener that never accepts, with a backlog of
  0. Once its queue is full the kernel drops every further SYN, so each `port.tcp` check waits out
  its 5 s timeout. That is about 400 checks in flight against about 65 workers, so the queue fills
  and refuses, as in the incident.
- **A balloon that presses.** Sized to the box's limit less its anonymous memory, so the page
  cache cannot absorb it.

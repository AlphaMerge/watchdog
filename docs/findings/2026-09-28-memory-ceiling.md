# One memory ceiling, and it kills (P-213)

- **Date**: 2026-09-28
- **Where**: the Docker Desktop VM on the development Mac — kernel 6.12.76-linuxkit, cgroup v2,
  8 CPUs, 7,936 MiB, 1,023 MiB swap — inside the smoke test's clean Debian 12 box, systemd 252,
  with the release installed as an operator would. **The VM was busy**: load 21.7 when the run
  began and 35 when it ended, from other sessions' builds and `ms-server`, and 86% of its swap was
  in use by them by the end. That stretches every start-up time below; it does not change who
  killed what.
- **What ran**: `P-213` uncommitted on `main` at `a32f1cb` — `ms-probe.service` with `MemoryMax=6G`
  and no `MemoryHigh`, `ms-core.service` with `MemoryMax=8G` and none.
- **Script**: [`scripts/sizing/memory-limit-live.sh`](../../scripts/sizing/memory-limit-live.sh),
  which now moves whichever ceiling binds first in the installed unit — `MemoryMax` here — and
  records systemd's journal for the probe.
- **Raw**: [`2026-09-28-memory-max-live.jsonl`](2026-09-28-memory-max-live.jsonl). The same
  stages against the old unit are `P-210`'s,
  [`2026-09-27-memory-limit.md`](2026-09-27-memory-limit.md).

## The question

`P-210` found that the stock units' `MemoryHigh` is a trap. Past it the kernel does not refuse or
kill; it throttles. With no swap the probe was stalled on memory 73% of the time within 17 s,
missed its 30-second watchdog, and was killed by systemd with a `SIGABRT`. It then restarted into
the same ceiling, stalled through start-up until `TimeoutStartSec`, and went round every ~85 s,
with `oom_kill` at zero and nothing anywhere saying *memory*. `P-213`'s candidates were to drop
`MemoryHigh` and let `MemoryMax` kill; to keep it and end the loop; or to keep both and say that
the 80% warning is the signal. This measures the first, as now shipped.

## What the shipped unit does

| Stage | What happened | Channel | Sensor |
| --- | --- | --- | --- |
| Stock unit | 277 MiB of 6,144 | 4.5% of 6,144 | Up |
| Ceiling set so the working set is 85% of it | 277 of 326 MiB, then the probe settled to 147 | 85.1% of 326.3, 12 s later | **Warning** 33 s after the change |
| Ceiling at 90% of the working set, swap configured | **Killed in the same second**; then killed 4.7–8.8 s into each of five restarts | a gap | **Down**: "Link to the core is 0" |
| Stock ceiling again | the next restart came up by itself, ready 22 s later | none yet: it reconnected as the stage ended | Down until then |
| Ceiling at 90% of the working set, no swap | **Killed in the same second**; the restart fit, and ran at 98% for 90 s | 98.0–98.6% of 199.1 | **Warning** |
| Stock ceiling again | — | 2.3% of 6,144 | Up |

**Past `MemoryMax` the kernel kills, at once, and systemd says why.** Both times the ceiling was
set below the probe's working set, the probe was dead before the next poll. The journal says so in
words: *A process of this unit has been killed by the OOM killer.*, *Main process exited,
code=killed, status=9/KILL*, *Failed with result 'oom-kill'.*, *Scheduled restart job, restart
counter is at 1.* — against `P-210`'s *Watchdog timeout (limit 30s)!* and a `SIGABRT`, which
point at a hung event loop rather than at memory.

**Swap was not a cushion.** With swap configured, the kernel moved 16–32 MiB of each attempt out
to it and killed the probe anyway, at once and at every restart. At `MemoryHigh` swap had held the
probe at 93% of the ceiling, working (`P-210`). `memory.max` does try reclaim, swap included,
before it kills, but it gives up after a bounded number of attempts that free nothing. On this VM,
with its swap mostly taken by other work and a load of 20–35, that came to nothing. A host with
free, fast swap was not measured.

**A probe whose start-up does not fit is killed at every start, for ever.** Under 132 MiB it was
killed six times in 59 s. Each start lasted 4.7–8.8 s and none reached ready. The core showed it Down
on the link, and the channel was a gap in `sample` for the four sweeps it lasted, not a zero.
Nothing stops this: restarts are 5 s apart, so systemd's default start limit of five in ten seconds
can never be reached. That is `P-215`, separate because a start limit counts every failed start,
and `ms-core` relies on restarting to wait out a PostgreSQL still recovering at boot.
**Raising the ceiling ends the loop by itself**: the restart scheduled under the old ceiling came
up under the new one, with nobody starting it.

**A probe whose start-up fits is not killed at all.** Under 199 MiB, the restart peaked at 195 MiB
and ran at 98% of the ceiling for 90 s, stalled on memory 0% of the time, at a warning —
then settled to 140 MiB as V8 gave back its start-up heap, as `sizing.md` describes. The channel
cannot read past 100% here: `memory.current` cannot exceed `memory.max`.

**The warning fired 33 s after the ceiling moved** — a heartbeat and then a sweep; `P-210`'s took 27.

## Against the old unit

| | `MemoryHigh=4G`, `MemoryMax=6G` (`P-210`) | `MemoryMax=6G` alone |
| --- | --- | --- |
| Usable before anything happens | 4 GiB | 6 GiB |
| Past the ceiling, no swap | stalled 73% within 17 s, killed by the watchdog within 25 | killed in the same second |
| What systemd records | `watchdog`, `SIGABRT` | `oom-kill`, `SIGKILL` |
| Past the ceiling, swap configured | kept working at 93% of the ceiling | killed, as without swap |
| A round of the loop | ~85 s: 60 s stalled in start-up, ~20 s to stop | 10–14 s: 5 s to restart, then killed 4.7–8.8 s in |

**The one thing given up is the swap band, and it was never a good one.** On a host with swap, the
old unit ran a probe between 4 and 6 GiB half-swapped; the new one runs it there in ordinary
memory, because that band is now under the ceiling. Past 6 GiB both kill.

**The spool is not a casualty.** A `SIGKILL` can tear at most the line being written, which
`ResultSpool` counts as `spoolCorrupt` and Probe Health documents as the normal cost of a crash.
Results already written and acknowledged survive. The old watchdog `SIGABRT` skipped `P-205`'s
graceful drain exactly as the kernel's `SIGKILL` does, so results in flight are lost the same way
under either.

## What the 80% warning catches

The ceiling the warning measures against moved from 4,096 MiB to 6,144, so the room behind it
fell from 2,867 MiB to 1,229. From 80%, one start-up surge — 856 MiB in five seconds (`P-206`) —
still fits; past about 86% it does not. **But a surge already under way is not caught**: it crosses
the last 20% in about seven seconds, and a warning reaches the sensor up to 33 s after the
crossing. What the warning catches is a probe that has settled high or is growing slowly — a leak,
or a workload added over weeks — which is the case an operator can act on. This is said in the
channel's comment, both unit files and `administration.md`.

## Not measured

- **A host with free, fast swap.** Whether `memory.max` reclaims a probe that is a little over
  rather than killing it depends on how quickly reclaim makes progress. Here it made none.
- **The core past its ceiling.** It is the same kernel mechanism and the same unit settings; only
  Core Health's reading, 2.9% of 8,192 MiB, was recorded.
- **cgroup v1**, where `MemoryMax=` maps to `memory.limit_in_bytes` depending on the systemd
  version.
- **A probe with sensors.** This one scanned nothing, and its working set was 140–277 MiB.

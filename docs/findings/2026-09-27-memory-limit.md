# How close a probe is to its own ceiling (P-210)

- **Date**: 2026-09-27
- **Where**: the Docker Desktop VM on the development Mac — Docker 29.7.2, kernel
  6.12.76-linuxkit, cgroup v2, 8 CPUs, 7,936 MiB, 1,023 MiB swap. The live run is inside the smoke
  test's clean Debian 12 box, systemd 252, with the release installed as an operator would and the
  probe under the shipped `ms-probe.service` — `MemoryHigh=4G`, `MemoryMax=6G`, `WatchdogSec=30`,
  `TimeoutStartSec=60`, `Restart=on-failure`, `ProtectControlGroups=yes` and all.
- **What ran**: `P-210` on top of `a03787f`, uncommitted. The probe had no sensors to scan; its
  working set was 144–304 MiB, so the ceiling was brought down to it with `systemctl set-property
  --runtime` rather than the probe driven up to 4 GiB.
- **Scripts**: [`scripts/sizing/memory-limit-live.sh`](../../scripts/sizing/memory-limit-live.sh)
  (the box, the install, a token) and
  [`memory-limit-live.mjs`](../../scripts/sizing/memory-limit-live.mjs) (the stages, run inside it);
  [`scripts/sizing/cgroup-high-behaviour.sh`](../../scripts/sizing/cgroup-high-behaviour.sh) for
  the kernel on its own.
- **Raw**: [`2026-09-27-memory-limit-live.jsonl`](2026-09-27-memory-limit-live.jsonl) — a poll every
  ~5 s of the kernel's view of the probe's cgroup, systemd's view of its unit, the core's live
  Probe Health and Core Health routes and the sensor's state, then every sample the sweep stored;
  [`2026-09-27-cgroup-high-behaviour.jsonl`](2026-09-27-cgroup-high-behaviour.jsonl).

## The question

`ms-probe.service` caps the probe whatever the host has left, so on a 64 GiB host the probe reaches
its ceiling with `memoryAvailable` (`P-208`) reading 80%. The new channel, `memoryLimitUsage`, is
the probe's working set as a share of the lower of `MemoryHigh` and `MemoryMax`, every level of the
cgroup tree up to the root and the tightest one winning; `memoryLimit` is that ceiling in MB. Three
things to find out: whether it reads what the kernel is enforcing, whether its limits fire where
the kernel acts, and what the kernel — and the unit — actually do to a probe past it.

## The live run

| Stage | Kernel: working set of the ceiling | Channel (the core's route) | Sensor | Stalled on memory |
| --- | --- | --- | --- | --- |
| Stock unit | 304 of 4,096 MiB — 7.4% | 7.4% of 4,096 | Up | 0% |
| Ceiling set so the working set is 85% of it | 170 of 200 MiB — 85.0% | 85.1% of 200.2, 11 s later | **Warning** 27 s after the change | 0% |
| Ceiling at 90% of the working set, swap available | 132–144 of 154 MiB — 85.8–93.4%, 14–54 MiB in swap | 92.2–93.7% of 153.6 | Warning | ≤ 2.4% |
| Stock ceiling again | 144 of 4,096 — 3.5% | 3.5% of 4,096 | Warning until the 30 s window rolled over | 0% |
| Ceiling at 90% of the working set, **no swap** | 144 of 130 MiB — 111% | 3.5% — the last heartbeat before it; none came after | Up, then **Down**: "Link to the core is 0" | 29 → 73% in 17 s, then killed |
| Stock ceiling again | 142 → 194 of 4,096 | 4.7% of 4,096, first heartbeat 40 s after | Up 51 s after | 76%, decaying to 0.2% |

**It reads what the kernel enforces.** At every poll where the probe was heartbeating, the route
agreed with the kernel's own files to within the thirty-second window — which is the highest of the
last thirty seconds by design, so it holds a peak for one window after the kernel has moved on.
`ProtectControlGroups=yes`, which makes `/sys/fs/cgroup` read-only for the probe, does not stop it
reading. The ceiling it found was the service's own, four levels down at
`/docker/<id>/system.slice/ms-probe.service`; the box and the slice above it set none.

**Each stored record carried it**, `memoryLimit` beside it, for both sensors. The five sweeps
while the probe was down stored nothing for it — a gap, not a zero — while Core Health's records
kept coming every thirty seconds. Core Health read 1.9–4.1% of 6,144 MiB, its own unit's `MemoryHigh=6G`,
throughout.

**The warning fired 27 seconds after the ceiling moved** — the next heartbeat (the installed
default is ten seconds, not the two the dev stack uses) and then the next sweep — with the message
the channel declares: *Memory used of its limit is 85.1 %, above the warning limit of 80 % — the
probe is nearing its memory limit*.

## Past the ceiling

**With swap, the kernel holds the probe just under it.** A ceiling 10% below the working set was met
by swapping 54 MiB out at once, and then — as the probe touched its pages again — by holding the
working set at 93.4% of the ceiling with 14 MiB in swap. The cgroup was stalled on memory at most
2.4% of the time, the probe heartbeated on schedule throughout, and the sensor sat at warning. That
is the right answer: it was working.

**Without swap, the kernel throttles it to a standstill, and the unit's watchdog kills it.** The
same ceiling with `MemorySwapMax=0` left nothing to reclaim. Within 17 s the cgroup was stalled 73%
of the time and the probe's last heartbeat was 19 s old. By the next poll, six seconds later,
systemd had killed it — result `watchdog`, which the journal of an earlier run of the same script
spelled out as `Watchdog timeout (limit 30s)!` and a `SIGABRT`. **The kernel never
killed anything** — `oom_kill` stayed at zero from start to finish; `MemoryMax` was 6 GiB away. What
killed the probe was its own unit: the probe pings the watchdog by running `systemd-notify` every
15 s (`packages/shared/src/lifecycle/systemd.ts`), and a process that cannot allocate cannot fork.

**And then it restarts into the same ceiling, indefinitely.** `Restart=on-failure` brought it back
5 s later, still under 130 MiB. Start-up alone took it past the ceiling within seconds — 105% at the
first poll — and it stalled there, never reported ready, and was stopped by `TimeoutStartSec=60`
(result `timeout`); the `SIGTERM` itself took ~20 s to land on a throttled process. The second
restart went from 37 MiB to 105% in under six seconds. Each round takes ~85 s, and systemd's default
start limit is five starts in ten seconds, so nothing ever gives up: the probe would have gone round
until someone raised the ceiling. When the stock 4 GiB came back, it reached `active` 28 s later and
heartbeated 11 s after that.

**The channel cannot report this, and what does report it is the link.** A probe that far past the
ceiling is not running the code that would say so. In this run the only heartbeat after the ceiling
moved was the one already in flight; Probe Health read Up, on the last heartbeat's 3.5%, for up
to 23 s until the watchdog fired, and then Down on the link. In that earlier run — its record
since overwritten — the probe got one heartbeat out at 108.2% and the sensor went Down with the
channel's own error message. Whether a probe past `MemoryHigh` gets a heartbeat out is luck.

## What that says about the limits

- **The warning at 80% is the one that matters, and it held.** It fired before anything went wrong
  and stayed on through the swap stage. From 80%, `P-206`'s start-up surge — 856 MiB in five
  seconds, 21% of the stock 4 GiB — reaches the ceiling before anybody has read the warning; that
  is why it is not 90.
- **The error at 100% is where the kernel acts, and is right as a threshold, but is not a reliable
  signal**: with swap the probe does not get past it, and without swap it usually cannot report it.
  It stays, because lowering it would mark a probe Down that was, at 93% with swap, working. The
  loop that follows is `P-213`.

## Working set, not `memory.current`

The kernel on its own, in containers with `memory.high` at 200 MiB, `memory.max` at 600 MiB and no
swap, sampled once a second from outside the cgroup. Run on a quiet VM — load 0.77 on 8 CPUs, with
`ms-server` stopped — because an earlier run under a load of 20–35 stretched the allocations below
the ceiling from ~20 ms to 0.5–1.6 s, and is not kept.

| Workload | `memory.current` | Working set | Stalled on memory | `high` events | `oom_kill` |
| --- | --- | --- | --- | --- | --- |
| 400 MB written to a file | **198 of 200 MiB** | 6 MiB | 0% | 425 | 0 |
| Node holding 32 MiB more at a time | 202 → 234 MiB over 39 s | the same | 29% at 5 s → 96.5% | 716 | 0 |

**Page cache fills a cgroup to its ceiling on purpose, and costs nothing there.** The file workload
held `memory.current` at 99% of `memory.high` with a working set of 6 MiB, and nothing in the cgroup
was ever stalled. On `memory.current` a probe replaying its spool through the disk would read "at
its ceiling" while perfectly well; that is why the channel is the working set. The `high` counter
in `memory.events` is no help either: the cache run counted 425 of them, harmlessly.

**Anonymous memory past `memory.high` with no swap is throttled, not refused and not killed.** Each
32 MiB took 19–35 ms below the ceiling; the one that crossed it took 434 ms; the next did not finish
in the 39 s that were left. The kernel let the cgroup creep past the ceiling — 234 MiB after 30 s,
which is what the channel reads as 117% — while stalling it a larger share of the time every second.
This is the probe's no-swap stage above, without a watchdog to end it.

**What the ticket proposed reading instead.** With 180 MB of page cache in the same 200 MiB,
Node 24.19's `process.availableMemory()` said **2 MiB** were left, while the working set was 18 MiB.
It is `memory.current` subtracted from the ceiling, page cache and all. `process.constrainedMemory()`
said 200 MiB — libuv 1.52 does take the lower of `memory.high` and `memory.max` — but the reader walks
the tree itself so that each level's ceiling is measured against that level's usage.

## Not measured

- **cgroup v1** (RHEL 8 and its rebuilds by default), a hybrid host, a limit on a parent slice,
  and a cgroup outside the probe's namespace: unit-tested against fixtures
  (`limit-memory.test.ts`), not run. There is no v1 host here.
- **`MemoryMax`**: on the stock unit `MemoryHigh` is 2 GiB below it and throttles first, and nothing
  here reached it. A unit with `MemoryMax` alone reads against that (unit-tested).
- **The core past its ceiling.** `ms-core.service` has the same pair and the same watchdog, and the
  same loop is to be expected; only its channel's reading was recorded.
- **A probe with sensors.** This one scanned nothing; how far a loaded probe's working set moves in
  thirty seconds is `P-206`'s start-up number, not a measurement of steady state.
- **Windows**, where WinSW sets no memory limit and the channel is a gap by construction (`H-09`).

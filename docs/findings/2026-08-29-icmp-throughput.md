# What ICMP costs at 1,000 targets, and whether a raw socket would earn its keep

`P-07`, measured 2026-08-29. Reproduce with:

```bash
scripts/dev.sh "node --test packages/probe/dist/test/perf/icmp-throughput.test.js"
```

Add `MS_PING_SWEEP=1` for the concurrency curve, `MS_PING_TARGETS` and `MS_PING_CONCURRENCY` to
change the shape of the run.

## Why this was measured

`ADR-001` chose the system `ping` binary as the default ICMP path — no privileges, correct
everywhere — and left "an optional raw-socket fast path" to be justified by a measurement at 1,000
targets. It also did the arithmetic that made the question urgent: `ping` waits about a second
between packets, so the default count of 4 holds a worker for roughly three seconds, and at the v1
target of 5,000 sensors on a one-minute interval that is **15,000 worker-seconds a minute against
60 seconds of wall clock**. `P-15` met the same wall from the scheduler's side and noted that a
pure-ping installation at that scale would want a 250-slot pool.

Ping is the most-used sensor type there is, so this is the one check whose cost decides how big a
probe has to be.

## What was measured, and what deliberately was not

Targets are loopback aliases (`127.x.y.z`, all local on Linux) and blackholed TEST-NET-1 addresses
(`192.0.2.0/24`, RFC 5737). **That removes the network entirely, which is the point**: what is
being compared is *our* cost per check — spawn, wait, parse — not somebody's link. A benchmark
against real hosts would have measured their latency and called it ours.

Node 24.19.0 in the pinned toolchain container, 8 cores, iputils 20221126.

## The numbers

1,000 live targets, 64 checks in flight:

| Configuration | Wall | Throughput | CPU per check | Replies |
| --- | --- | --- | --- | --- |
| `-c 4 -w 5` — what shipped before | 49.6 s | **20 targets/s** | 1.7 ms | 4000/4000 |
| `-c 4 -i 0.2 -W 2` — what ships now | 10.2 s | **99 targets/s** | 1.3 ms | 4000/4000 |

200 blackholed targets, the case a pool is actually sized for:

| Configuration | Wall | Throughput | Packets sent |
| --- | --- | --- | --- |
| before | 20.0 s | 10 targets/s | **1000** (5 per check) |
| now | 10.6 s | 19 targets/s | **800** (4 per check) |

Concurrency, 500 live targets:

| In flight | Before | Now | Ratio |
| --- | --- | --- | --- |
| 16 | 5/s | 25/s | 4.9x |
| 32 | 10/s | 49/s | 4.9x |
| 64 | 20/s | 98/s | 4.9x |
| 128 | 40/s | 187/s | 4.7x |
| 256 | 77/s | 324/s | 4.2x |

## What the numbers say

**The interval is worth 4.9x and costs nothing.** `-i 0.2` turns a three-second check into a
six-hundred-millisecond one, with identical reply counts, no privileges, no dependency and no
second code path. The ratio holds flat across the concurrency curve until 256 in flight, where
process spawn cost starts to show and it tails to 4.2x.

**0.2 is a floor, not a preference.** iputils documents 200 ms as the lowest an unprivileged
process may use, and BSD refuses below 0.1 s to anyone but the superuser. Below that the behaviour
depends on how `ping` was installed on the operator's machine — this container's binary carries
`cap_net_raw`, and a smaller interval works here for that reason and would not elsewhere. A
default may not assume it.

**`-c` and `-w` interact, and that is the finding nobody was looking for.** The iputils manual
states it and nothing else does: *with a deadline, ping waits for `count` **replies** and keeps
transmitting until the deadline expires.* So `-c 4 -w 5` against a host that is down sent **five**
packets over five seconds, not four — and `-c 4 -i 0.2 -w 5` would have sent **twenty-five**.
Lowering the interval without noticing this would have multiplied by five the ICMP traffic aimed at
exactly the hosts already in trouble.

Replacing `-w` with `-W` fixes it: the count means what the form says, live or dead, and the dead
case got 2x faster as a side effect. The run is then bounded by `(count - 1) x interval + W`
rather than by ping's own deadline, with the check's `AbortSignal` — which `CLAUDE.md` requires
anyway — as the outer bound.

**Against the v1 target**, 5,000 sensors on a 60-second interval is 83 checks a second:

- before: 77/s at **256** workers. Short of the target at any pool size worth having, which is
  what `P-15` ran into.
- now: 98/s at **64**. About 55 workers suffices, against a shipped default of 48.

## The raw socket: measured, and no

**Node cannot open one without a native addon.** `dgram` exposes `udp4` and `udp6` and nothing
else — not Linux's unprivileged `IPPROTO_ICMP`/`SOCK_DGRAM` ping sockets, which is the modern
answer and which this container has enabled (`net.ipv4.ping_group_range` is `0 2147483647`). The
options are `raw-socket` or `net-ping`, both native, both untouched since 2024.

The cost is therefore not "some code". It is a compiler on the operator's machine at install time,
a native artefact in the tarball for every platform we ship, and an unmaintained dependency in the
one code path that runs more than any other — against `CLAUDE.md`'s standalone constraint, where
every dependency is another thing an operator has to install and supervise.

**And the number it would have to beat is now 99 targets a second on 64 workers**, which already
clears the v1 target with headroom. Whatever a raw socket is worth, it is not worth that price for
a requirement that is already met.

**Revisit when**: a single probe needs more than about 10,000 ping sensors on a one-minute
interval, or the check interval drops below 30 seconds at the v1 count. Both put the requirement
past what 256 workers can spawn. The sensor is written so a second implementation slots in behind
the same pure parser, which is what `P-08` built it that way for.

## What changed as a result

- `icmp.ping` gained `intervalSeconds`, default **0.2**.
- `icmp.jitter` gained the same parameter with a default of **1**, deliberately: jitter is a
  measurement of the network *over time*, and twenty packets at 0.2 s sample four seconds of it
  rather than twenty. Congestion on a ten-second cycle is invisible in a four-second window.
- Linux uses `-W` (per packet) where it used `-w` (overall), for the reason above.
- macOS and Windows are unchanged. The `-c`/deadline interaction may well exist on BSD too, but it
  was not measured here and a change made on inference is not a measured change.

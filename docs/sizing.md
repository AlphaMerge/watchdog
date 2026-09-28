# Sizing an installation

Every number here is measured, and each links to the measurement. Where something has not been
measured this says so rather than estimating — the point of this page is that you can check it.

- Scheduler and memory across machine tiers: [`2026-09-03-sizing.md`](findings/2026-09-03-sizing.md)
- 24 hours at the v1 target: [`2026-08-30-soak-24h.md`](findings/2026-08-30-soak-24h.md)
- Storage: [`2026-08-25-timeseries-sizing.md`](findings/2026-08-25-timeseries-sizing.md)

---

## Start here

| Sensors | Core | Probe | Disk for 40 days raw |
| --- | --- | --- | --- |
| ≤ 100 | 2 cores, 2 GB | 2 cores, 1 GB | ~2 GB (0.2 GB compressed) |
| ≤ 1,000 | 2 cores, 4 GB | 2 cores, 2 GB | ~16 GB (1.3 GB compressed) |
| ≤ 5,000 | 4 cores, 8 GB | 2 cores, 4 GB | ~80 GB (6.4 GB compressed) |

Plus whatever PostgreSQL wants, which is the larger half of the core's box — TimescaleDB's own
guidance is that the recent working set should fit in about a quarter of RAM, and that is what
the one-day chunk interval was chosen against.

**Two cores is enough for a probe at every one of these sizes.** That is the most surprising
measured result and the one most likely to save money: at 5,000 sensors the dispatch jitter was
208 ms on two cores, 212 on four and 209 on eight — indistinguishable, and all a fifth of the
1,000 ms budget. A check waits for a packet, not for a core.

**The table assumes 200 ms checks.** If yours are slower — and `icmp.ping` is 600 ms — the pool
is what changes, not the cores. Read the next section before taking the 5,000-sensor row at face
value: at that size the shipped pool default is below what ping sensors need.

---

## Sizing a probe properly

The table above assumes 200 ms checks on a 60-second interval. If yours are slower, or the
interval is shorter, size from the rules below.

The wheel fires once a second, so work arrives in bursts rather than smoothly:

    burst = sensors ÷ interval in seconds

**There are two rules and the first one is not optional.**

### 1. Keep up at all

A worker is held for the whole check, so a pool of `workers` completes `workers ÷ check duration`
checks a second. That has to be at least the arrival rate, or the backlog grows every second for
as long as the probe runs:

    workers ≥ burst × check duration

**Below this line no tolerance saves you.** The lag does not settle at some large value; it
climbs. And it climbs *quietly* — the queue absorbs it, so nothing is refused and no counter
says anything is wrong until the queue's own bound is reached. Measured: 5,000 ping sensors on a
pool of 48 sat 4% under this line and reached a **median** check 3.0 s late and a p95 of 5.4 s
inside ninety seconds, with **nothing refused**. That was the shipped default until `P-32`
raised it to 64.

### 2. Then keep the jitter inside your tolerance

Once you are keeping up, the burst is served in rounds and the last check in a round waits for
the one before it:

    rounds  = ceil(burst ÷ workers)
    jitter ≈ (rounds − 1) × check duration

which is inside a tolerance when

    workers ≥ burst ÷ (1 + tolerance ÷ check duration)

**At the system's own 1,000 ms budget, rule 1 is always the binding one.** Rule 2 only overtakes
it when `check duration + tolerance` is under a second, which no sensor with a real network
round trip and this budget reaches. Size from rule 1 and use rule 2 to predict the jitter you
will then get.

### Leave headroom above the floor — it is a floor, not a target

Being *above* the line is not the same as being safely above it. Two measured points:

| | Floor | Pool | Ratio | Predicted jitter | Measured p95 |
| --- | --- | --- | --- | --- | --- |
| 200 ms checks, shipped pool | 16.7 | 48 | **2.9×** | 200 ms | 208–217 ms |
| 3 s checks, 256 workers | 250 | 256 | **1.02×** | 0 ms | **2,427 ms** |

At 2.9× the floor the model is right to within 17 ms across five independent runs. At 1.02× it
is wrong by 2.4 seconds, because worker start-up and ordinary variance are larger than a 2%
margin. Where between 1.02× and 2.9× it becomes safe **is not measured** — so treat the floor as
the number to clear comfortably, not to meet.

### Worked examples

**5,000 sensors, 60-second interval, 200 ms checks.** Burst 83.3. Rule 1 needs
`83.3 × 0.2 = 17` workers; the shipped ceiling of 64 is 3.8× that. Rule 2: 2 rounds, so about
200 ms of jitter, measured at 208–217 when the ceiling was 48 and unchanged by raising it — 83
is two rounds against either. Comfortable, and why 5,000 sensors fit on two cores.

**5,000 `icmp.ping` sensors — the case that moved the default.** A ping check costs **600 ms**
since `P-07` (`findings/2026-08-29-icmp-throughput.md`), so rule 1 needs `83.3 × 0.6 = 50`
workers. The ceiling used to be 48 — one under the floor — and measured a p95 of **5,082 ms**
with nothing refused. **It is 64 now** (`P-32`), which is 1.28× the floor and measures 614 ms.
If your ping sensors are on a shorter interval than 60 s, redo rule 1: the floor scales with the
burst, and `workerPoolSize` is the setting.

**5,000 HTTP sensors averaging 2 seconds.** Rule 1 needs `83.3 × 2 = 167` workers, well past the
shipped ceiling. An earlier version of this page said 83, from rule 2 alone; that was half the
true answer.

**The check duration is the multiplier, not the sensor count.** Ten thousand pings on a
300-second interval need `33.3 × 0.6 = 20` workers; two thousand 2-second HTTP checks on a
60-second interval need `33.3 × 2 = 67`. The second is a third of the sensors and three times
the pool.

### What a probe costs in memory

Memory follows the worker count, not the sensor count:

    probe RAM ≈ 120 MB + workers × 35 MB

The 35 MB is what a worker costs in a real probe, where each one loads the sensor catalogue —
measured over 24 hours at 48 workers and 1,790 MB resident. A synthetic pool with no catalogue
costs about 12 MB a worker, so do not size from a benchmark.

**Size for the start-up peak, not for this number.** Workers commit heap while they load the
catalogue and V8 holds it for about a minute and a half before giving it back, so a probe spends
its first two minutes above where it settles. Measured at 64 workers on 2026-09-13
(`findings/2026-09-13-young-generation-cost.md`): a peak of **2,593 MB**, held from about ten
seconds to about a hundred and ten, settling to about **1,800 MB** by four minutes. That peak is
about 10% above what the formula gives. A box sized exactly to the steady state can die during its
own start-up and then look perfectly healthy in every measurement taken after the restart — which
is what happened on the dev VM, and a miserable thing to diagnose — so size the box from the peak,
with headroom for whatever else runs on it.

**The peak was 3,740 MB before `P-206` and 3,189 MB before `P-207`.** At 3,740 a probe at the
5,000-sensor row's 4 GB had less than 300 MB during its own start-up, before the operating system
took its share. Two changes took it down. The pool used to start every worker a growth burst asked
for at once, and a worker that loads beside sixty others commits half as much heap again as one
that loads beside seven; it now loads them eight at a time (`P-206`). And each worker's young
generation is capped at 8 MiB (`P-207`), which V8 would otherwise grow as far as it likes.

**Checks that allocate cost more per worker than that formula says.** The 35 MB is a probe whose
checks are mostly light. Eight workers parsing a 476 KB JSON document, reading 5,000 database rows
and walking an SNMP table held **427 MB of heap between them** with the cap — and **1,413 MB
without it**, because V8 had grown each young generation to 129 MB and kept it
(`findings/2026-09-13-young-generation-cost.md`). That is about 53 MB of heap a worker before
anything native is counted. A full 64-worker pool on work like that has not been measured; size a
probe that runs mostly REST, database or SNMP-table sensors from a measurement of its own.

**The pool settles near the burst, so the burst is what you are buying memory for.** Measured at
a ceiling of 48, **with 200 ms checks** — the ceiling has since risen to 64, so the two pinned
rows would now pin at 64 and cost proportionally more:

| Sensors | Burst | Workers held | Benchmark RSS |
| --- | --- | --- | --- |
| 100 | 1.7/s | 4 | 117 MB |
| 500 | 8.3/s | 14 | 216 MB |
| 1,000 | 16.7/s | 24 | 312 MB |
| 2,500 | 41.7/s | 48 (was the ceiling) | 547 MB |
| 5,000 | 83.3/s | 48 (was the ceiling) | 571 MB |

Above about 2,500 sensors the burst exceeds the ceiling, so the pool pins there and the extra
latency is the second round the model predicts. Below it, the pool tracks the load and the
ceiling costs nothing — which is why raising it to 64 changed nothing for the first three rows.

**Read that table with the check duration it was measured at.** A slower check raises the floor
in direct proportion — three times the check duration is three times the workers, and three
times the memory at the same sensor count. The table is the shape for 200 ms checks, not a
lookup for any workload.

**`workerPoolSize` is a ceiling, not a headcount.** Lowering it caps memory, but never below the
floor rule 1 sets — under that line the probe stops keeping up rather than merely getting
slower. A probe watching fifty sensors costs about 120 MB, not the 555 MB its ceiling would
allow.

**A pool that has grown does come back down** (`P-45`), within a few seconds of the workers
finishing their checks rather than at the next idle window. It used to shed only what happened to
be idle at the instant the ceiling moved and then wait a minute for another chance: a pool asked to
go from 66 workers to 9 sat at 31 for two minutes while completely idle. Measured after the fix, it
spends **no time at all** above its ceiling over a whole run and halves resident memory in the
cheap phase.

The corollary is worth stating, because it is the price: **a correctly-sized small pool is more
exposed to a sudden slowdown than an oversized one.** Measured, the transient after checks slow
from 200 ms to 1,500 ms is about 25 seconds of lateness rather than about 12 — the probe is no
longer carrying spare workers that used to absorb it. That is the trade for roughly 770 MB, and
`workerPoolSize` is how you buy back the other side of it.

### You usually do not have to do this arithmetic

**Left at its default of 0, the probe applies rule 1 to itself** (`P-34`). It sums
`check duration ÷ interval` over the sensors it was actually assigned — using the duration it has
*measured* for each sensor type, not a guess — adds 30% headroom, and moves its own ceiling. It
recomputes every thirty seconds, and again shortly after a configuration push. Measured, the
ceiling it derives is Little's floor times the margin to the worker
(`findings/2026-09-04-autosize-loop.md`).

**It reacts after your checks slow down, not before** — an earlier version of this page claimed the
opposite. It is the *measurement* that lags rather than the loop: the duration it sizes from is the
median of the last 1,024 completed checks of that type, so the window has to refill before a change
is visible. Recomputing more often does not help; it re-derives the same stale number. In that
window a probe runs under-provisioned with **nothing deferred and nothing refused**, so the signal
to watch is scheduler lag on Probe Health, not the pool counters.

**The lag is bounded at about thirty seconds** (`P-46`). The window is counted in seconds, so the
delay cannot exceed it however small the pool is: measured at 13 seconds with 66 workers, 18 with
31 and 25 with 9. It used to be counted in *checks*, which made the delay `512 ÷ completions per
second` — 85 seconds at nine workers and worse at fewer — so a pool that was too small measured too
slowly and stayed too small. **If your check durations change in steps rather than drifting — and a
network or a device that degrades is exactly that — set `workerPoolSize` for the slow case** rather
than paying that half minute each time.

**It raises at once and lowers slowly, and the asymmetry is deliberate** (`P-40`). A pool that is
too small is a probe falling behind, and every second it waits is checks queueing — so an
increase takes effect immediately. A decrease has to be more than a twitch (10% of the ceiling,
or four workers, whichever is larger) and has to persist for about a minute, because a ceiling
that follows every wobble in a network's round-trip time destroys and rebuilds workers for a
workload that has not changed. **What you will see in the logs is a ceiling that climbs quickly
and comes down in steps a minute apart**, and that is working as intended rather than lagging.

The rules above are still worth knowing, for three reasons: to size the *box*, since the ceiling
the probe derives is memory you have to have; to read `workerPoolSize` when somebody has set it;
and because auto-sizing is bounded at 256 workers, past which the probe logs what it needed and
waits for you.

**The unit's memory ceiling is part of the box.** `ms-probe.service` sets `MemoryMax=6G`, which by
the formula above holds about 170 workers once settled and about 155 through the start-up peak —
well short of the 256 auto-sizing may reach. Past it the kernel kills the probe, and the probe
restarts into the same workload and is killed again (`P-213`). Probe Health's `memoryLimitUsage`
warns at 80% of it; raise it before a workload that needs more, with
`systemctl set-property ms-probe MemoryMax=…` (`administration.md`, "A service at its memory
ceiling").

**Setting `workerPoolSize` to anything non-zero turns this off** and fixes the ceiling there,
because the setting is a statement about how much memory the probe may use and a derived number
must not overrule it. Set it when you know your workload, or when the box is smaller than the
arithmetic wants.

---

## Sizing the core

The core holds configuration and ingestion, not checks, and it barely moves with sensor count:
**310 MB resident at 5,047 sensors, flat over 24 hours.** It absorbed 7,544,624 readings in that
day — about 87 a second — with its ingestion queue never above 92 against a warning threshold of
40,000.

Give it 4 cores and 8 GB at the v1 target and the headroom goes to PostgreSQL.

---

## Storage

**99.3 bytes a reading**, indexes included. From that:

    readings per day = sensors × channels per sensor × 86,400 ÷ interval
    bytes per day    = readings per day × 99.3

At the v1 target — 5,000 sensors, about 3 channels each, 60-second interval — that is 21.6
million rows and **2.8 GB a day**, or **80 GB** for the 40 days of raw data PRTG keeps.

**Compression is worth 12.5×**, taking those 40 days to about **6.4 GB**. It is the one
TimescaleDB feature this project depends on, and the reason it accepts the Community licence.

Rollups and their retention are separate and much smaller; they are computed by the core rather
than by the database, so moving off TimescaleDB would cost compression and nothing else.

---

## What is not measured

Say so rather than guess, and these are the gaps:

- **x86.** Every measurement here is arm64. The curve is set by check concurrency rather than by
  instruction set, so it should carry — but it has not been checked.
- **More than one probe against one core.** The soak ran a single local probe.
- **Remote probes over a real network**, including a saturated or lossy link.
- **`exe.script` sensors that genuinely compute.** Every measurement models checks that wait for
  a packet, which is what the protocol sensors do and is not what a script doing arithmetic does.
- **Windows.** No measurement on Windows Server exists (`H-06`, `H-17`) — Windows is release 1.1.

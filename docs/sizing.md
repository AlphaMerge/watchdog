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

---

## Sizing a probe properly

The table above assumes 200 ms checks on a 60-second interval. If yours are slower, or the
interval is shorter, size from the rule instead — it predicted all fifteen measured points to
within 12 ms.

The wheel fires once a second, so work arrives in bursts rather than smoothly:

    burst   = sensors ÷ interval in seconds
    rounds  = ceil(burst ÷ workers)
    jitter ≈ (rounds − 1) × check duration

Keep `jitter` inside your tolerance — the system's own budget is 1,000 ms — by giving the pool
enough workers to clear the burst in few enough rounds:

    workers ≥ burst ÷ (1 + tolerance ÷ check duration)

**Worked example.** 5,000 sensors, 60-second interval, 200 ms checks, 1,000 ms tolerance:
burst is 83, tolerance buys 6 rounds, so 14 workers suffice. The shipped ceiling of 48 is
comfortable — which is why 5,000 sensors fit on two cores.

**Worked example that does not fit.** 5,000 HTTP sensors averaging 2 seconds: burst is still 83,
but tolerance buys only 1 round, so you need 83 workers — above the shipped ceiling of 48. Raise
`workerPoolSize`, lengthen the interval, or split across probes.

**The check duration is the multiplier, not the sensor count.** Ten thousand pings are cheaper
than two thousand slow HTTP checks.

### What a probe costs in memory

Memory follows the worker count, not the sensor count:

    probe RAM ≈ 120 MB + workers × 35 MB

The 35 MB is what a worker costs in a real probe, where each one loads the sensor catalogue —
measured over 24 hours at 48 workers and 1,790 MB resident. A synthetic pool with no catalogue
costs about 12 MB a worker, so do not size from a benchmark.

**The pool settles near the burst, so the burst is what you are buying memory for** — the same
number that decides latency above. Measured, at a ceiling of 48:

| Sensors | Burst | Workers held | Benchmark RSS |
| --- | --- | --- | --- |
| 100 | 1.7/s | 4 | 117 MB |
| 500 | 8.3/s | 14 | 216 MB |
| 1,000 | 16.7/s | 24 | 312 MB |
| 2,500 | 41.7/s | 48 (ceiling) | 547 MB |
| 5,000 | 83.3/s | 48 (ceiling) | 571 MB |

Above about 2,500 sensors the burst exceeds the shipped ceiling, so the pool pins there and the
extra latency is the second round the model predicts. Below it, the pool tracks the load.

**`workerPoolSize` is a ceiling, not a headcount.** Lowering it caps memory at the cost of an
extra round of jitter once the burst outgrows it; raising it is what a probe watching slow checks
needs. A probe watching fifty sensors costs about 120 MB, not the 555 MB its ceiling would allow.

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
- **Windows.** No measurement on Windows Server exists (`H-06`, `H-09`).

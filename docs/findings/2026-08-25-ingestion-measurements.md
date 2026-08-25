# S-07 ingestion pipeline — measurements

Date: 2026-08-25 · TimescaleDB 2.29.2, PostgreSQL 17, Node 24.19.0, Debian 12 container on
Apple Silicon · reproduce with `./scripts/dev.sh node --test
"packages/core/dist/test/ingestion-performance.test.js"`

Phase 1's exit criterion (`PLAN.md`) is **100,000 samples a minute sustained with a p99 write
latency under 100 ms**. Both halves are measured through the pipeline the service actually runs
— batching, the bounded queue and per-batch attribution are all inside the timed path.

## Throughput and latency

100,000 readings across 2,000 channels, offered as 200 batches of 500 at once, the way a fleet
of probes reports.

| Batch size | Throughput | p99 write | Writes |
| --- | --- | --- | --- |
| **1,000 rows** | **3,621,280 samples/min** | **22.1 ms** | 100 |
| 2,000 rows | 3,559,977 samples/min | 51.9 ms | 50 |
| 5,000 rows | 3,778,228 samples/min | 84.0 ms | 20 |

**36× the throughput target at a fifth of the latency budget.**

The sweep is the point. Batch size buys almost nothing above a thousand rows — 4% more
throughput for four times the write latency — so the shipped default is 1,000 rather than the
largest value that still passes. The first version of this defaulted to 5,000 and produced a p99
of 107.7 ms on one run and 97.7 ms on the next: a number sitting on its budget is a coin toss,
not a margin, and it was buying nothing.

Running the same sweep inside the full `npm test`, where several test files share one PostgreSQL,
settles it. The shipped 1,000-row batch held at **36.1 ms**; 2,000 went to 52.1 ms; 5,000 went to
**180.4 ms — nearly twice the budget**. The default that looked adequate in isolation fails the
criterion the moment the database has company, which is the only condition that matters.

Going through the full path — the wire format, channel resolution, then the same pipeline —
sustains **2.5M samples a minute**. Channel resolution costs nothing in the steady state: 300
channels are created the first time they are reported and served from memory thereafter, with
no query at all. That is deliberate; at the v1 target a lookup per reading would be 15,000
pointless queries a minute for information that never changes.

## What the numbers mean for the design

The headroom says the bound that matters is not the write path. It is memory: the queue holds
200,000 readings by default, about two minutes of a large installation's output, and past that
batches are **refused rather than dropped**. Refusing is safe precisely because the probe has
not been acknowledged and still holds the batch in its disk spool (`R-02`) — the backlog belongs
on the probe's disk, not in the core's heap.

Backpressure is gradual for the same reason. Above half full, acknowledgements carry a
`retryAfterMs`; only past the bound do batches get refused outright. A system that only ever
says "full, go away" has already built the backlog it is complaining about.

## Two things worth writing down

**The backfill note belongs in the write's transaction.** Ingestion tells the rollup about every
range it writes, so a replayed spool cannot leave the rollups quietly wrong (`S-06`). The first
version did that after the write committed, which had two faults: a crash in between would
commit readings with no promise to re-roll them, and the acknowledgement raced the note so the
test saw an empty queue. Both disappear when the `INSERT` and the `rollup_backfill` check run in
one transaction — and the check is a single statement against a one-row table, so it costs
nothing worth measuring.

**Merged batches have to be told the truth individually.** Several probes' batches become one
`INSERT`, and the database reports one total. Splitting that total between them would tell every
probe a number that was not about its own readings. `RETURNING channel_id, time` gives back
exactly what landed, so each batch is counted against what it actually sent — which matters
because a probe reads a shortfall as "these were already stored", the normal state of affairs
during a replay.

## Not measured here

Sustained-over-time behaviour under a real probe fleet, and replay stampede control, belong to
`R-03` and `R-08`. What this measures is capacity and latency of the write path, which is what
Phase 1's criterion asks for.

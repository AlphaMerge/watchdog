# Spike: Apache-only rollups versus the Timescale Community licence

- **Date**: 2026-08-25
- **Question**: `docs/findings/2026-08-25-timescaledb-licensing.md` established that continuous
  aggregates, native compression, retention/compression policies, `add_job` and
  `time_bucket_gapfill` are **Timescale License**, not Apache-2.0. The decision was to build
  both paths far enough to measure, and choose on numbers.
- **Reproduce**: `scripts/spike/run.sh` — a dedicated PostgreSQL container, run first with
  `timescaledb.license=apache`, then restarted as `timescale` against the same data. Raw output
  in `dev/data/spike/`.

## The workload

15,000 channels at a 60-second interval — the v1 target of 5,000 sensors × ~3 channels
(`CAPABILITIES.MD` §13) — rolled up into 5-minute buckets. 3.6 million readings for the initial
fill, then one more hour (900,000 readings) to measure the steady-state refresh.

Hardware: the development container. Absolute numbers are not a sizing statement; the ratio
between the two paths is the point.

## Results

| | Apache path | Timescale Community |
| --- | --- | --- |
| Rollup mechanism | plain hypertable + our own `INSERT … ON CONFLICT DO UPDATE` | continuous aggregate |
| Initial fill (3.6M readings) | 8,542 ms | 4,655 ms |
| Incremental refresh (900k new readings) | 2,520 ms | **1,072 ms** |
| Same work, measured back to back in one session | 2,619 ms | 1,072 ms |
| Rollup on disk (900k buckets) | 110–132 MB | 124 MB |
| Raw on disk, uncompressed | 459 MB | 459 MB |
| Raw on disk, compressed | **not available** | **43 MB** |
| Graph query against a rollup | 1.97 ms | comparable |
| Graph query against compressed raw chunks | n/a | 1.25 ms |

## Reading the numbers

**Rollups: the Apache path is fine.** A continuous aggregate refreshes about 2.4× faster, but
both are cheap in absolute terms and the measurement overstates the gap. It refreshes a whole
hour at once; a housekeeping job running every five minutes touches roughly a tenth of that, so
the real steady-state cost is a few hundred milliseconds either way. Disk is a wash — 110–132 MB
against 124 MB for the same 900,000 buckets. There is no meaningful storage or query advantage
to a continuous aggregate at this scale.

**Compression is the one that has no answer.** 459 MB → 43 MB is **12.5×**, and PostgreSQL has
no columnar equivalent to fall back on. At the v1 target, 40 days of raw data is ~80 GB
uncompressed (`docs/findings/2026-08-25-timeseries-sizing.md`) and roughly **6.4 GB**
compressed. Queries against compressed chunks stayed fast — 1.25 ms — so this is not a
read-performance trade.

## What the Apache path actually costs, beyond the milliseconds

Three things the table does not show:

1. **We schedule it ourselves.** `add_job` is Timescale-License too, so the rollup and the
   retention sweep run from the core's own housekeeping loop. `WORKFLOW.MD` §9 already specifies
   housekeeping as a scheduled job, so this adds no dependency — but it is code we own, and it
   has to be crash-safe, restart-safe and observable. Budget it as real work, not glue.
2. **No real-time aggregation.** A continuous aggregate transparently unions materialised
   buckets with raw rows that have not been rolled up yet. Ours will not, so a query for the
   last few minutes reads a bucket that does not exist yet. The repository has to union the tail
   from raw, which is a correctness requirement rather than an optimisation.
3. **Gap handling moves up a layer.** `time_bucket_gapfill` is Timescale-License, so "gaps are
   not zeros" (`S-09`) has to be honoured in the repository and the wire format instead. Given
   CLAUDE.md already insists a gap survives storage, rollup, query *and* rendering, owning that
   logic is arguably where it belonged anyway.

## Recommendation

**Take the Community licence for compression; keep the rollups ours.**

The rollup comparison does not justify a licence obligation — we would be accepting one for a
2.4× speedup on an operation that costs a few hundred milliseconds every five minutes.
Compression is a different matter: 12.5× is not a tuning win, it is the difference between 80 GB
and 6.4 GB per installation, and there is no Apache-2.0 substitute at any price.

Concretely:

- Run PostgreSQL with `timescaledb.license=timescale`.
- Use **native compression** and `add_compression_policy`.
- Write **rollups and retention ourselves** anyway — a plain hypertable per tier, filled by the
  housekeeping job, dropped by `drop_chunks`. This keeps the rollup logic engine-agnostic, which
  is what `S-12`'s repository interface exists to protect, and it means a future move off
  TimescaleDB costs us compression and nothing else.

The licence obligation to accept: the Timescale License permits free self-hosted use but forbids
offering the software as a database-as-a-service. That does not touch a standalone product an
operator installs. It **does** attach if we ever ship TimescaleDB binaries inside our own
installer rather than telling the operator to install it, which is a question for `H-05`/`H-06`
and worth a lawyer's five minutes before 1.0.

If that obligation is unacceptable, the Apache-only path is genuinely viable — it costs ~74 GB
more per installation at the v1 target, and the rollup work is the same either way.

## What this changes

- `CLAUDE.md` hard constraint 4 and `ADR-001` Decision 4 both need amending: their claim that
  continuous aggregates, compression and retention policies are Apache-2.0 is wrong, and the
  constraint should say which licence we are actually accepting and why.
- `S-06` becomes "rollup tiers and retention, written by us, plus a compression policy" rather
  than "continuous aggregates".
- `docker-compose.dev.yml` should switch to `TIMESCALEDB_LICENSE=timescale` so development
  exercises what production runs.

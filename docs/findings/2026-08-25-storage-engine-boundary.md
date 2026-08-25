# S-12 — what the TimescaleDB dependency actually is

Date: 2026-08-25 · TimescaleDB 2.29.2, PostgreSQL 17 · reproduce with `./scripts/dev.sh node
--test "packages/core/dist/test/storage-engine.test.js"`

`ADR-001` Decision 4 promised that "all time-series access sits behind a repository interface so
a plain-Postgres fallback is contained", and `S-11` may need to collect on that promise if
TimescaleDB turns out to be unusable on Windows Server. This is the audit of what containment
actually costs.

## The dependency, in full

Four things. Everything else the time-series store does is ordinary SQL that any PostgreSQL runs.

| Need | TimescaleDB | Licence | Substitute |
| --- | --- | --- | --- |
| Bucket a timestamp | `time_bucket` | Apache 2.0 | **`date_bin`**, in core since PostgreSQL 14 — verified identical, below |
| Find aged chunks | `timescaledb_information.chunks` | Apache 2.0 | `pg_inherits` / `pg_class` over partitions |
| Compact them | `compress_chunk` | **Timescale License** | **None.** Report `compaction: false` and stop asking |
| Drop whole chunks | `drop_chunks` | Apache 2.0 | `DROP TABLE` on a partition |

That is the `StorageEngine` interface in `packages/core/src/timeseries/engine.ts`, and it is the
whole of it. A second engine is a four-method object, not a reimplementation of the store.

**The boundary is enforced, not documented.** `storage-engine.test.ts` scans every file under
`packages/core/src` for `time_bucket`, `create_hypertable`, `drop_chunks`, `compress_chunk`,
`timescaledb` and their neighbours, and fails if any appears outside the engine and the two
migrations. Writing an engine-specific query in the wrong place is a test failure, not a review
comment.

Two things moved to make that true. `Database.check()` no longer probes for the extension — which
storage engine is in use is the store's question, not the connection pool's, and asking it there
put a TimescaleDB dependency in the one class every part of the system touches. And the
housekeeping loop now asks `capabilities()` once: an engine reporting `compaction: false` is
never asked to compact again, so a fallback would log one line at start-up rather than failing a
pass every five minutes.

## The bucketing substitute is exact

The crux. If the two functions disagreed by so much as a second, rollups written by one engine
would be unreadable by the other.

`time_bucket(w, t)` and `date_bin(w, t, TIMESTAMPTZ 'epoch')` agree for all three tier widths at
every probe tried, including the Unix epoch itself, a European DST transition, and a year
boundary — and both agree with the JavaScript arithmetic the housekeeper slices time with.

Better than agreeing on scalars: **the same store, driven by a `date_bin` engine, rolls up and
reads back byte-identical results.** `SqlTimeSeriesStore` is constructed with each engine in turn
over the same readings, and the two answers are compared to each other and to hand-computed
values. An interface with one implementation is an assertion; this one has been exercised twice.

## What a fallback would still owe

**Compression, and nothing else.** That was already the conclusion of the licence decision
(`ADR-001` Decision 4 amendment) and this confirms it from the other direction: the rollup tiers,
retention, the backfill queue, the watermarks and every read are engine-agnostic today. Losing
TimescaleDB would cost roughly 10x on disk (`2026-08-25-rollup-measurements.md`) and nothing else.

**The schema, which is the part the interface cannot contain.** `create_hypertable` is in
migration 003 and the compression settings in 004, and migrations are checksummed to detect drift
— so their SQL cannot be parameterised by engine without making the checksum depend on the
engine, which would make every existing installation look drifted. A fallback therefore needs its
**own migration list, selected at start-up**, not a conditional inside the existing one. Roughly:

- `sample`, `sample_5m`, `sample_1h`, `sample_1d` as `PARTITION BY RANGE (time)`, with partitions
  created ahead of time by the housekeeping loop rather than automatically.
- No compression settings, and no `ALTER TABLE ... SET (timescaledb.compress)`.
- The same indexes, constraints and triggers, which are all plain PostgreSQL already.

Creating partitions ahead of time is the one genuinely new piece of work, and it belongs in
housekeeping beside the sweeps that already run there.

## Recommendation for S-11

Spike TimescaleDB on Windows Server first, as planned. If it installs, this document is
insurance and nothing more. If it does not, the work is a `PlainPostgresEngine` plus a second
migration list — bounded, understood, and with the risky half already measured.

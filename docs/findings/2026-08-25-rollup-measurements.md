# S-06 rollup, compression and retention — measurements

Date: 2026-08-25 · TimescaleDB 2.29.2, PostgreSQL 17, Node 24.19.0, Debian 12 container on
Apple Silicon · reproduce with `./scripts/dev.sh node --test
"packages/core/dist/test/rollup-performance.test.js"`

The rollup tiers are written by us rather than as continuous aggregates. That decision, and the
spike behind it, are in `docs/findings/2026-08-25-rollup-storage-spike.md` and the ADR-001
Decision 4 amendment. This document measures what was then built.

## Throughput, at the v1 target

15,000 channels — 5,000 sensors at roughly three channels each (`CAPABILITIES.MD` §13) — with a
reading a minute. The unit measured is the real one: a whole five-minute bucket across every
channel, rolled up by the same repository the service runs.

| | Rows in | Buckets out | Time |
| --- | --- | --- | --- |
| raw → 5m, four buckets | 300,000 | 60,000 | 620 ms |
| 5m → 1h, one bucket | 60,000 | 15,000 | 146 ms |
| 1h → 1d, one bucket | 15,000 | 15,000 | 139 ms |

These are from an isolated run. Under the full `npm test`, where several test files share one
PostgreSQL, the same figures land nearer 283 ms a bucket — still four orders of magnitude inside
the budget, but worth knowing before someone re-measures and thinks something regressed.

**155 ms to roll up a five-minute bucket, which arrives every 300,000 ms.** The loop uses
0.05% of its period at the v1 target. That is the number that matters: the failure mode for a
rollup is falling behind and never catching up, and there is three orders of magnitude of room
before that becomes conceivable.

The cascade is why the tiers above cost so little. Rolling an hour from `sample_5m` reads twelve
rows per channel instead of sixty from raw, and — because the tiers store `value_sum` and
`sample_count` rather than an average — the result is identical to rolling it from raw.

On disk, before compression: raw 103.1 bytes a row, `sample_5m` 116.1 bytes a row. A five-minute
bucket costs slightly more than a raw reading and replaces five of them, so the finest tier pays
for itself at about 4.4:1 even before anything is dropped.

## Compression, and the thing that decides its ratio

**The compression ratio depends on how many readings each channel holds inside a chunk, not on
how many channels there are.** Compression batches rows within a segment, and `segmentby =
channel_id` means each channel is its own segment. A test that is wide and shallow measures
mostly per-batch overhead.

| Shape | Rows per channel per chunk | Ratio |
| --- | --- | --- |
| 15,000 channels × 20 readings | 20 | 4.4× |
| 300 channels × 1,440 readings | 1,440 | **10.1×** |
| the spike's dataset | ~14,400 | 12.5× |

At the v1 target with one-day chunks, each channel holds 1,440 readings — the middle row. So
**10× is the number to plan capacity with**, not the spike's 12.5×, which came from a dataset
with ten days of readings per channel in a chunk.

40 days of raw at the v1 target is roughly 112 GB uncompressed. Compressing everything older
than the default seven days leaves about 7 days at full size and 33 days at a tenth: **≈ 30 GB
instead of 112 GB.** A query against a compressed chunk still answered in 0.9 ms.

This was worth catching. The first version of this measurement used the wide-and-shallow shape
and reported 4.4×, which would have understated the licence's value by more than half and made
the capacity plan wrong in the expensive direction.

## Two things the implementation got wrong first

**A backfill window wider than one pass was silently truncated.** The loop claims queue entries,
re-rolls the window in bounded slices, then deletes the entries. With a slice budget of eight
days for the five-minute tier, a probe that spooled for a fortnight had six days of its replay
deleted from the queue unread — correct data sitting in raw, never summarised, invisible until
retention dropped it. `#rollRange` now reports how far it actually got, and whatever it did not
reach goes back on the queue before the claim is cleared. Covered by *"re-queues a backfill
window it could not finish in one pass"*.

**`ON CONFLICT DO UPDATE` alone cannot shrink a bucket.** Re-rolling a window whose source rows
have gone — because a channel was reaped, or retention dropped a chunk — leaves the buckets they
produced standing for ever, updated by nothing. A backfill now clears its window before
rebuilding it. A forward roll does not, because its window is new. Covered by *"removes a bucket
whose readings have all gone"*.

## Guards worth keeping

Compression and retention are capped by the watermark of the tier above, and by the oldest
pending backfill. A tier that has never run caps them at nothing at all. The effect is that a
system whose rollups are failing stops dropping data rather than quietly eating the only copy of
it — measured in *"will not drop raw the rollup has not consumed, however old it is"*, where a
fifty-day-old chunk survives a forty-day horizon and then goes on the pass after the tier catches
up.

`sensor_state` is deliberately not in the retention sweep. A sensor that has sat Up for three
years has one row, three years old, and `drop_chunks` would take it — leaving the sensor with no
known state and breaking the uptime and SLA figures that CLAUDE.md requires be computed from
state history. Retention there has to carry the latest row per sensor forward first: `S-15`.

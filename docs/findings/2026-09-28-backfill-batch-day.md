# A backfill batch-day, measured

**Date:** 2026-09-28
**Task:** `P-226` — a backfill after a long replay rebuilt every channel's history from one channel's
**Measurement:** `packages/core/test/perf/backfill-performance.test.ts`, TimescaleDB 2.29.2

## The question

`P-226` changed what a backfill does. It used to be one window, recomputed for every channel, in
slices of one day of every channel. Now it re-rolls only the channels that arrived late, in
batches of 250, one day of one batch in every tier at a time. That unit is a **batch-day**. A
pass takes batch-days while it holds the housekeeping lock. So the cost of one batch-day decides
how many a pass can do, and how far past its budget the one it always takes can run.

The shape measured is the worst a batch-day meets at the v1 target:

- 250 channels, with a day of readings at 60 s already rolled up and **compressed**;
- a second reading a minute on top, thirty seconds off the first, written into the compressed raw
  chunk.

Every five-minute bucket is recomputed from two readings a minute. Every compressed batch the
recompute touches is unpacked, with the decompression limit lifted as the backfill lifts it.

## The first run, and the bound that was wrong

| | |
| --- | --- |
| Load average | 12.47 / 20.21 / 22.71 over 8 CPUs (1.56 per CPU) |
| Delivered CPU | 273 ms for the fixed loop (1.02× the reference machine's 267 ms) |
| Other clients on the database | `ms-core`, 2 connections, 0 active |

| Step | Time | Rows |
| --- | ---: | ---: |
| Replay: 360,000 late readings into compressed raw (ingestion's cost, for the record) | 25,833 ms | |
| `sample_5m` | 6,409 ms | 72,000 buckets |
| `sample_1h` | 324 ms | 6,000 buckets |
| `sample_1d` | 15 ms | 250 buckets |

It failed its bound: 6,409 ms against 4,688 ms. **The bound was the wrong one.** It divided the
300 s interval by the 64 slices a pass then took, as if every slice cost what a five-minute slice
does. But a pass takes its slices a tier at a time, and the hour and day tiers cost a twentieth of
the five-minute one or less.

The three tiers together were 6.75 s. At that speed, 64 slices were about 21 batch-days, or 142 s.
That is inside the interval, but it is half of it, on a machine that was busy.

## What changed because of it

**A pass is bounded by time, not by a count.** It takes batch-days until half the housekeeping
interval has gone, and it always takes the first. A starved machine does fewer and a fast one
catches up sooner, where a fixed count would overrun the interval on the first and sit idle on the
second. `MAX_BACKFILL_DAYS_PER_PASS`, 64, is the ceiling for a machine fast enough that time never
binds.

**The trade:** how far a pass reaches is no longer reproducible, and two runs over the same queue
stop on different days. What is reproducible is where a pass stops: on a day boundary shared by
every tier, with the next pass continuing from exactly there. The tests pin that with an injected
monotonic clock.

The loop is day-major for the same reason. If it read the clock between tiers, a pass could stop
with the five-minute tier a day ahead of the hourly one, and the continuation would redo that day.

A pass overruns its budget by at most one batch-day, because the clock is read before a day, not
during it. The asserted bound is now that a pass of 150 s gets through at least four batch-days,
so the one it always takes stays well inside the budget.

## The re-measure

This ran alone: the dev toolchain count was 0 when it started.

| | |
| --- | --- |
| Load average | 13.22 / 24.35 / 24.76 over 8 CPUs (1.65 per CPU), still falling from something heavier |
| Delivered CPU | 497 ms for the fixed loop (**1.86×** the reference machine's 267 ms) |
| Other clients on the database | `ms-core`, 1 connection, 0 active |

| Step | Time | Rows |
| --- | ---: | ---: |
| Replay: 360,000 late readings into compressed raw (ingestion's cost, for the record) | 17,760 ms | |
| `sample_5m` | 4,015 ms | 72,000 buckets |
| `sample_1h` | 476 ms | 6,000 buckets |
| `sample_1d` | 28 ms | 250 buckets |
| **Batch-day** | **4,519 ms** | |

It passed. A pass of 150 s takes about 34 batch-days, which is 8,500 channel-days. The one
batch-day a pass always takes is 3% of the budget.

The delivered-CPU factor of 1.86× at a toolchain count of 0 means the VM was busy with something
outside this project's toolchain. The run does not say what.

## What the numbers are not

- **An upper bound, not a typical figure.** Both runs were on a loaded machine, and the re-measure
  was on a VM delivering about half the CPU of the reference. The re-measure's five-minute tier is
  still lower than the first run's, on a slower VM, and two runs cannot explain that. Neither run
  is a distribution.
- **One batch, one day.** A backfill of many days or many batches costs this times the number of
  batch-days, spread over passes. Nothing here was measured across passes.
- **TimescaleDB 2.29 only.** The floor is 2.14.0, and nothing older than the dev image's 2.29 was
  run. The one change known to bear on this shape is 2.16.0's upsert unpacking only batches with
  a row to update (`#7108`). It should not matter here, because this shape updates a row in every
  batch it touches. But what a batch-day costs on the releases in between is unmeasured.

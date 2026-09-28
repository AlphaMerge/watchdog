# P-233 — the ingestion budgets, through the probe gate

Date: 2026-09-29 · commit `e3d25e6` (P-233 on `abb7b25`) · TimescaleDB 2.29.2, PostgreSQL 17.11,
Node 24.19.0, Debian 12 container on Apple Silicon · every other session held, both runs · reproduce
with

```
./scripts/dev.sh "node scripts/perf-conditions.mjs; cd packages/core && \
  node --test --test-concurrency=1 dist/test/perf/ingestion-performance.test.js && \
  node --test dist/test/perf/replay-soak.test.js"
```

**Since `P-228` every probe batch passes an ownership gate before ingestion stores anything, and
until `P-233` no budget covered it.** The budgets called `acceptResults`, the path the core's own
producers use, which has no gate. They now call `acceptProbeResults`, from the probe object that
owns the sensors. The gate caches who owns each sensor. A restart starts with that cache empty,
and every move or delete anywhere clears it.

## The gate's worst batch: 18 ms against a 100 ms budget

One probe with `PLAN.md`'s whole v1 target, 5,000 sensors, arranged the way a real tree is:
10 branches, each with 10 groups, each group with 10 devices, and 5 sensors on each device, so
every sensor sits four levels below the probe. The probe offers them as it ships, in batches of
500 (`spoolBatchMaxRows`), one at a time. Each batch's gate is timed on its own, because a batch
is what waits for it.

| Pass | Run 1: median | Run 1: worst | Run 2: median | Run 2: worst |
| --- | --- | --- | --- | --- |
| After a restart (empty cache) | 3.61 ms | 5.08 ms | 3.93 ms | 5.79 ms |
| Steady state (warm) | 0.10 ms | 0.13 ms | 0.09 ms | 0.10 ms |
| After a move of 500 sensors to another probe | 3.44 ms | **19.62 ms** | 3.96 ms | **18.27 ms** |

**The budget is one write's: a cold batch's gate may cost no more than Phase 1 allows the write
itself (a p99 under 100 ms).** The worst batch in either run was a fifth of that. It is the batch
after the move. The move cleared the cache, and that batch holds the 500 moved sensors, so it also
walks the audit log to tell a move from a probe reporting sensors it was never given. It found all
500 moved and none foreign. The warm budget is a twentieth of the write budget, 5 ms, and the gate
used a fiftieth of that.

The move went through `ObjectService.move`, with a real `DatabaseAuditSink` and a real
`ResultCacheInvalidator` on the service, as `main.ts` wires them. Nothing in the test clears the
cache by hand. Had the move failed to clear it, the moved branch would have been admitted as the
old probe's, and the case would have failed on the count.

Measured on a busy VM the day before this window, the same case took a median of 41 ms and a
worst of 72 ms. So the margin shrinks tenfold under load, and still holds.

## The throughput budgets, now through the gate

| Case | Run 1 | Run 2 | Budget |
| --- | --- | --- | --- |
| Full path, every batch missing the owner cache | 2,485,373 samples/min | 2,055,190 samples/min | 100,000 |
| State machine, steady state (warm gate) | 2,533,991 samples/min, p99 43.6 ms | 1,935,602 samples/min, p99 37.9 ms | 100,000; p99 < 100 ms |
| Flapping, every sensor changing state on every scan | p99 37.1 ms | p99 32.2 ms | p99 < 100 ms |
| Replay at 5% of an hour, live p99 degradation | 0.97× | 0.95× | < 3× |

The full-path case opens its timed window with the owner cache cleared. All 100 batches are
offered before any lookup returns, so every one of them asks the database. This is the restart
shape, with every probe's first batch arriving at once, and the worst mix the gate sees.

The replay soak asserts that the gate refused nothing. A source wired to the wrong probe would
otherwise have been acknowledged at once and stored nowhere, which would read as a very fast
replay. It ran at the default 5%, not the full hour. The committed full-hour figures in
`replay-soak.test.ts` date from before the gate, and re-taking them belongs to the next full
`test:perf`.

## Conditions

| | Run 1, 02:56:28 | Run 2, 02:58:03 |
| --- | --- | --- |
| Load average (1/5/15 min, 8 CPUs) | 13.67 / 36.80 / 32.59 — **1.71 per CPU, flagged** | 3.24 / 26.89 / 29.46 — 0.41 per CPU |
| Delivered CPU, fixed loop | 266 ms (1.00× reference) | 271 ms (1.01×) |
| Other database clients | none | none |
| `ms-server` | restarting on exit 78, about every 30 s | the same; 471 restarts before and after, so no boot during the run |

Both runs follow straight on `P-216b`'s starvation run, and the 5-minute averages are its tail.
Run 1 was flagged for load, so run 2 was taken once the 1-minute average fell under 0.5 per CPU.
`ms-server` was not stopped, because that is the user's call. It was in a restart loop: the dev
database has an applied migration that the main checkout's build calls edited. Each cycle is one
refused boot and one database connection.

## One failure outside P-233, and three reruns

In run 2, the raw-writer batch-size sweep missed its p99: 285.6 ms against 100 ms for the shipped
1,000-row batch, where run 1 had measured 22.9 ms on the same commit a minute earlier. That case
calls the `Ingestor` directly, with no service and no gate, and `P-233` did not touch it. The same
code 12× apart is the environment, not the code. The PostgreSQL log shows nothing unusual in that
window: "TimescaleDB background worker limit of 16 exceeded" was logged during run 1's sweep as
well, and the only checkpoints were small ones from scratch-database drops.

It was rerun three times, back to back, while every session was still held, to tell an outlier
from a pattern:

| Sweep | Time | Load, 1 min | Delivered CPU | 1,000 rows: p99 | 2,000 rows: p99 | 5,000 rows: p99 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| run 1 | 02:56 | 1.71 per CPU | 1.00× | 22.9 ms | 47.8 ms | 101.6 ms | passed |
| run 2 | 02:58 | 0.41 per CPU | 1.01× | **285.6 ms** | 49.5 ms | 214.7 ms | failed: p99 over budget |
| rerun 1 | 03:00:26 | 0.08 per CPU | 0.99× | 73.8 ms | 59.2 ms | 73.5 ms | failed: shipped size not faster than 5,000 rows |
| rerun 2 | 03:00:34 | 0.09 per CPU | 1.00× | 24.2 ms | 49.2 ms | 89.3 ms | passed |
| rerun 3 | 03:00:41 | 0.09 per CPU | 1.00× | 38.2 ms | 27.4 ms | 78.2 ms | passed |

No other database client was connected in any of these, and `ms-server` did not boot during them:
its restart count was 473 before and after the reruns.

**The 285.6 ms did not recur, so it is an observation, not a budget failure.** Every rerun kept the
shipped p99 inside 100 ms. Rerun 1 failed only the case's relative check, that the shipped size
writes faster than the largest, by 0.3 ms (73.8 against 73.5). Across these five sweeps the
shipped size's p99 ran from 22.9 to 285.6 ms. That spread is wider than a same-run comparison of
two sizes can hold, and the next full `test:perf` should look at it. No budget has been moved.

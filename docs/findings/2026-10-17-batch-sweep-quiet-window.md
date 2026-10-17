# The batch-size sweep's p99 on a quiet machine, and what a real percentile costs (`P-251`)

2026-10-17, main at `c42cd516`. `packages/core/test/perf/ingestion-performance.test.ts`, the case
"sustains 100,000 samples a minute with a p99 write inside 100 ms", in one toolchain container.

**A quiet window.** `ms-server` was stopped (`scripts/dev-services.sh stop`), and the other
project's containers on the VM were paused for the window at the user's word. No other toolchain
run was going. These are the conditions printed before the first run and after the last:

```
  perf run conditions
  ----------------------------------------------------------------
  load average   0.64 / 2.41 / 4.64  over 8 CPUs  (0.08 per CPU)
                 as the container sees it, which is the kernel running the tests
  delivered CPU  288 ms for a fixed loop  (1.08x the reference machine's 267 ms)
                 a load average cannot see a host starving this VM; this can
  database       nothing else is connected
  ----------------------------------------------------------------
  ...
  load average   0.81 / 1.70 / 3.98  over 8 CPUs  (0.10 per CPU)
  delivered CPU  268 ms for a fixed loop  (1.00x the reference machine's 267 ms)
  database       nothing else is connected
```

## The case as it stands: five sweeps

The sweep writes 100,000 readings at each size, which is 100 writes at the shipped 1,000 rows.
`Ingestor.stats()` takes the p99 at index `floor(0.99 × n)`. At 100 writes that is the last
index, so the shipped size's "p99" is its slowest write (`P-237`).

| Sweep | 1,000 rows: p50 | "p99" (the max) | 2,000 rows: p50 | p99 | 5,000 rows: p50 | p99 | wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20.3 ms | **102.3 ms** | 31.7 ms | 68.3 ms | 74.3 ms | 96.2 ms | 9.8 s |
| 2 | 17.4 ms | **200.7 ms** | 27.9 ms | 60.0 ms | 70.2 ms | 119.2 ms | 8.2 s |
| 3 | 14.2 ms | 44.5 ms | 30.9 ms | 158.5 ms | 116.5 ms | 407.3 ms | 9.2 s |
| 4 | 18.4 ms | 60.0 ms | 43.2 ms | 219.5 ms | 112.5 ms | 328.7 ms | 12.3 s |
| 5 | 16.4 ms | 40.1 ms | 35.2 ms | 317.1 ms | 74.1 ms | 214.8 ms | 8.6 s |

**The budget failed twice in five on a quiet machine.** That is not the busy machine
`2026-09-29-batch-sweep-median-under-load.md` measured (0.61 per CPU, `ms-core` connected). This
time the load was 0.08 to 0.13 per CPU, nothing else was on the database, and the delivered CPU
was the reference machine's. The shipped size's slowest write still went over 100 ms in sweeps 1
and 2. Throughout, its median stayed between 14.2 and 20.3 ms. `P-233`'s quiet reruns held three
of three, and that was luck of the draw over a single write.

Throughput was never close to the line. The slowest sweep sustained 2.15 million samples a
minute at the shipped size, against a target of 100,000. The relative check (`shipped.p50 <
largest.p50`) held in all five, by 3.7× to 8.2×.

## A real percentile: three sweeps at 300 writes

The same case, run from a throwaway copy of the compiled file with 150 ticks per channel instead
of 50. That makes 300,000 readings per size, which is 300 writes at the shipped size. The queue
bound was raised to 400,000 rows so that nothing was refused. The copy was deleted afterwards.
At 300 writes, `floor(0.99 × 300)` is index 297, the third-slowest write.

| Sweep | 1,000 rows: p50 | p99 (3rd slowest of 300) | 2,000 rows: p50 | p99 | 5,000 rows: p50 | p99 | wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 14.0 ms | 47.2 ms | 28.2 ms | 59.8 ms | 65.5 ms | 142.1 ms | 17.2 s |
| 2 | 14.5 ms | 35.6 ms | 30.4 ms | 68.5 ms | 82.7 ms | 372.7 ms | 18.8 s |
| 3 | 14.8 ms | 49.4 ms | 30.3 ms | 109.5 ms | 83.8 ms | 195.8 ms | 19.5 s |

**Taken over 300 writes, the p99 holds with half the budget to spare**: 35.6 to 49.4 ms against
100 ms, three of three. The stalls that broke the maximum are still there, since the 5,000-row
size's p99 is its single slowest write at 60 writes and reached 372.7 ms. But at the shipped size,
one or two stalls no longer decide the result.

## What each of `P-251`'s two options costs

- **A real percentile.** Taking 200 or more writes at every size is what this variant did, and
  it roughly doubles the case: about 18.5 s against about 9.6 s. The ticket asks for at least 200
  writes per size, so the p99 is not the last index. Only the shipped size carries the absolute
  budget; the other sizes are compared on their medians. So the cheaper form is 200 to 300
  writes at the shipped size alone, with the other sizes left at 100,000 readings. That adds
  about 2 to 4 s, the shipped size's share of the wall time.
- **Reported and budgeted as a maximum.** This adds no wall time. But a maximum of 100 ms fails
  two quiet sweeps in five, so the budget would have to rise to something like 250 ms to hold.
  That would no longer be the phase's "p99 write inside 100 ms", and a maximum is the one
  statistic a single stall decides.

**Recommendation for `P-251`:** the real percentile, at the shipped size only, with 300 writes.
It is not the free option, but it costs a few seconds and keeps the criterion as written, and
on a quiet machine it passed three of three with margin where the maximum failed two of five.
The ticket says to pick whichever costs less wall time. Read literally, that is the maximum, but
the maximum cannot keep the 100 ms number. This entry records the numbers; the choice is made in
`P-251` itself.

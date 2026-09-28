# The probe clock sweep at 5,000 sensors, measured

**Date:** 2026-09-29
**Task:** `P-232` — a probe whose clock steps back freezes its sensors, and nothing says why
**Measurement:** `packages/core/test/perf/clock-freeze-performance.test.ts`, TimescaleDB 2.29.2

## The question

`ClockFreeze.sweep` runs every thirty seconds. For every connected probe whose offset is known it
runs one statement, `FROZEN_UNDER_SQL`: a recursive walk of the probe's branch, joined to
`sensor_config` and `sensor_runtime`, keeping the sensors whose last result is later than the
probe's clock reads now. On almost every pass the clock is fine and the answer is no rows. That
pass is paid all the time, so its budget is 1% of the period: 300 ms.

The other cost is the edge: a clock steps back and every sensor freezes, then it is put right and
every one thaws. Each moves the sensors through `reevaluate` and the dependency recompute, the
same two calls `ProbeReachability.lost` makes. That is printed, not budgeted, because it is the
lost path's cost and was already being paid.

The tree is the v1 target on one probe: 50 groups, 5 devices each, 20 `icmp.ping` sensors a
device. That is 5,000 sensors and 5,301 objects under the probe, built through `createTree` and
analysed. Every sensor's last result is a minute old, as on a probe that is scanning.

## Conditions

| | |
| --- | --- |
| Load average | 4.53 / 6.50 / 11.81 over 8 CPUs (0.57 per CPU) |
| Delivered CPU | 287 ms for the fixed loop (1.07× the reference machine's 267 ms) |
| Other clients on the database | `ms-core`, 2 connections, 0 active |

The VM had one other toolchain run on it. `perf-conditions.mjs` flagged the load (0.57 per CPU
against 0.5) and the idle `ms-core` connections. The ordinary pass is about twenty times under its
budget, so neither changes the answer.

## Numbers

| Step | Time |
| --- | ---: |
| Ordinary pass, nothing frozen, median of 20 | **14.6 ms** |
| Ordinary pass, worst of 20 | 23.1 ms |
| `EXPLAIN ANALYZE` of the statement alone | 16.1 ms execution, 0.6 ms planning |
| Edge: 5,000 sensors frozen | 550 ms |
| Edge: 5,000 sensors thawed | 204 ms |

The ordinary pass is 0.05% of the thirty seconds it runs on.

## The plan

```
Nested Loop  (actual time=15.977..15.979 rows=0 loops=1)
  Buffers: shared hit=48713
  CTE below
    ->  Recursive Union  (actual time=0.019..5.449 rows=5301 loops=1)
          ->  Index Scan using object_pkey on object            (rows=1)
          ->  Nested Loop                                       (rows=1325 loops=4)
                ->  WorkTable Scan on below below_1
                      Filter: (depth < 1000)
                ->  Index Scan using object_parent_idx on object child  (loops=5301)
  ->  Nested Loop  (actual time=0.361..10.531 rows=5000 loops=1)
        ->  CTE Scan on below                                   (rows=5000)
              Filter: (kind = 'sensor'::object_kind)
              Rows Removed by Filter: 301
        ->  Index Scan using sensor_config_pkey on sensor_config  (loops=5000)
              Filter: (type <> ALL ('{ms.probe.health,ms.core.health,core.factory}'::text[]))
  ->  Index Scan using sensor_runtime_pkey on sensor_runtime    (loops=5000)
        Filter: (last_result_at > '2026-09-28 22:04:59.914+00'::timestamp with time zone)
        Rows Removed by Filter: 1
Execution Time: 16.107 ms
```

Every step is an index scan: the walk on `object_parent_idx`, then two primary-key probes per
sensor. Every buffer was a hit. There is no index on `last_result_at`, and one would not help. The
walk has to reach every sensor to know which are under the probe, and the time filter then rejects
all but the frozen ones one row at a time. About a third of the time is the walk. The rest is the
10,000 primary-key probes.

**It is linear in the sensors a probe carries**, and the sweep runs the statement once per
connected probe. So the total per pass is linear in the connected fleet: about 15 ms per 5,000
sensors, whether they sit on one probe or many.

## What it means

- **The sweep can run every thirty seconds at the v1 target** for less than a tenth of a percent
  of one connection's time. Nothing needs to be cached between passes.
- **The edge costs what a lost probe costs**, because it makes the same calls. The tree has no
  triggers, so neither number includes the alarm engine's work. The freeze came out slower than
  the thaw. This run does not say why, and neither number is a budget.

## Re-taking it

```
node scripts/perf-conditions.mjs
cd packages/core && node --test --test-concurrency=1 dist/test/perf/clock-freeze-performance.test.js
```

It runs in `npm run test:perf` with the rest, in about ten seconds.

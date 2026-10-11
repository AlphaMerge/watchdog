# Each sensor's newest state: the text alias, the column, or one sensor at a time

- **Date**: 2026-10-11
- **Ticket**: `P-388`
- **Question**: `orderedAfterLast` (`state/runtime.ts`) and `stateAtHorizon`
  (`timeseries/store.ts`) wrote `DISTINCT ON (sensor_id) sensor_id::text AS sensor_id … ORDER BY
  sensor_id, time DESC`. A bare name in `DISTINCT ON` and `ORDER BY` is the output column first, so
  both sorted by the id made text. The answer is right, since text and bigint ids are one to one,
  but nothing about `(sensor_id::text, time)` is an index. Does it cost the `(sensor_id, time)`
  index at 5,000 sensors, and does qualifying the column help?
- **Reproduce**: `npm run test:perf` runs `packages/core/test/perf/state-latest-plan.test.ts`, or
  run that file alone:

  ```bash
  ./scripts/dev.sh "timeout 600 sh -c 'npm run build -w packages/core && cd packages/core && node --test dist/test/perf/state-latest-plan.test.js'"
  ```

## The data

5,000 sensors with 40 transitions each, three days apart: 200,000 rows over 120 days, in 17
weekly chunks, analysed. `orderedAfterLast` is asked for 1, 50 and all 5,000 sensors.
`stateAtHorizon` is asked at 90 days, which reaches every sensor: 10 rows each, 50,000 in all.

## Conditions

The development toolchain container, 8 CPUs. Load average 2.94 / 4.48 / 5.41 at the start, with
`ms-server` running on the same PostgreSQL. **The plans and block counts are the finding. They do
not depend on load.** The times are medians of 7 warm runs and are given for scale; the ranges
show how much the machine moved them.

## Results

Every form returned the same rows as the original, at every size (asserted).

`orderedAfterLast`:

| Sensors | Form | Median | Range | Blocks | Plan |
| --- | --- | --- | --- | --- | --- |
| 1 | text alias (was) | 0.28 ms | 0.25–1.25 | 74 | Sort over 17 index scans |
| 1 | qualified column | 0.31 ms | 0.23–2.04 | 74 | Sort over 17 index scans |
| 1 | **one at a time (now)** | **0.09 ms** | 0.07–0.27 | **3** | Limit over the newest chunk's index |
| 50 | text alias (was) | 2.72 ms | 2.50–4.98 | 2,040 | Sort over 17 index scans |
| 50 | qualified column | 3.17 ms | 2.31–9.34 | 2,040 | Incremental sort over a merge of 17 index scans |
| 50 | **one at a time (now)** | **0.26 ms** | 0.20–0.55 | **150** | Limit over the newest chunk's index, 50 times |
| 5,000 | text alias (was) | 323 ms | 263–383 | 1,480 | **Sort spilled to disk** (`external merge`) over 17 sequential scans |
| 5,000 | qualified column | 209 ms | 202–244 | 201,425 | Incremental sort over a merge of 17 index scans |
| 5,000 | **one at a time (now)** | **12.1 ms** | 11.8–12.9 | 15,000 | Limit over the newest chunk's index, 5,000 times |

`stateAtHorizon`, 90 days:

| Form | Median | Range | Blocks | Plan |
| --- | --- | --- | --- | --- |
| text alias (kept) | 69.8 ms | 67.5–76.6 | 386 | Sort over 5 index scans on time, and one sequential scan |
| qualified column | 46.6 ms | 45.0–56.5 | 45,463 | Incremental sort over a merge of 5 index scans |

## What it means

- **The text key does cost the index's order.** Every alias plan sorts the rows it reads. At
  5,000 sensors that sort no longer fits in memory and spills to disk.
- **Qualifying alone removes the sort, but not the reading.** Both `DISTINCT ON` forms read every
  row of every sensor asked about and keep the newest of each, so their cost grows with each
  sensor's history. The qualified form reads them through the index and fetches each row from
  the table for `cause`, which the index does not carry: 201,425 blocks at 5,000 sensors.
- **One sensor at a time reads only what it keeps.** `CROSS JOIN LATERAL (… ORDER BY time DESC
  LIMIT 1)` reads one row per sensor, backwards from the index, and TimescaleDB stops at the
  newest chunk that has one. That is 3 blocks per sensor, however long the history. It is the
  fastest at every size measured: 3×, 10× and 27× the original.
- **Not fewer blocks at every size.** At 5,000 sensors the original's sequential scan read
  1,480 blocks to the lateral form's 15,000. The scan reads them in order while the lateral
  form reads them at random, and a cold cache was not measured. `orderedAfterLast` runs on every
  state write, usually for a handful of sensors, where the lateral form also reads by far the
  fewest blocks. It reaches 5,000 only when a whole probe's sensors move at once.

## Decision

- **`orderedAfterLast` is the lateral form**, exported as `NEWEST_STATES` so the perf test
  measures the text the code runs. The perf test asserts it never sorts and reads at most 4
  blocks per sensor. With the old query put back, it fails on the first size ("the lateral form
  sorted"). Its `build-hygiene` allow-list entry is gone.
- **`stateAtHorizon` is unchanged.** Qualified, it is about 23 ms faster warm and reads 117× the
  blocks. It runs once per retention pass, over the chunks that pass is about to drop: the data
  least likely to be in memory, which is where a sequential read is cheapest. Its allow-list
  entry stays, with this measurement as the reason.
- A lateral form of `stateAtHorizon` would need the set of sensors with rows before the horizon,
  which is itself a scan of those rows. It was not tried.

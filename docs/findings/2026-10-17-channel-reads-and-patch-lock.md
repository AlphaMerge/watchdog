# A channel PATCH's lock, the channel list's subquery and a `/values` poll, at 5,000 sensors (`P-324`, `P-341`, `P-374`)

2026-10-17, main at `c42cd516`. Three new `test:perf` cases, each run twice in one quiet window:
- `channel-patch-lock-performance.test.ts` (`P-324`)
- `channel-list-performance.test.ts` (`P-341`)
- `values-poll-performance.test.ts` (`P-374`)

**Conditions.** For the window:
- `ms-server` was stopped (`scripts/dev-services.sh stop`).
- The other project's containers on the VM were paused, at the user's word.
- No other toolchain run was going.

Every header said the same of the database. The load ranged from 0.10 to 0.30 per CPU, and the delivered CPU from 1.00× to 1.03× the reference machine's. The cases' own lines report 15 clients of *other* databases on the server, 0 of them active. The first header, before the first case:

```
  perf run conditions
  ----------------------------------------------------------------
  load average   0.87 / 0.52 / 1.40  over 8 CPUs  (0.11 per CPU)
                 as the container sees it, which is the kernel running the tests
  delivered CPU  266 ms for a fixed loop  (1.00x the reference machine's 267 ms)
                 a load average cannot see a host starving this VM; this can
  database       nothing else is connected
  ----------------------------------------------------------------
```

## `P-324`: a channel PATCH's `FOR UPDATE` on its sensor

**Fixture.** 5,000 `icmp.ping` sensors under one probe. One sensor is measured, with a sibling on the same device as the control.

**What was timed:**
- A live result for the measured sensor, through `IngestionService.acceptProbeResults` and an `Ingestor` wired as `main.ts` wires it. It was timed three ways: alone; beside a loop of channel PATCHes (`patchChannel`, with a limit flipped every call) on the same sensor; and beside the same loop on the sibling.
- The PATCH alone.
- The foreign key check a row referencing the sensor takes: `FOR KEY SHARE` on its `object` row, which is what arming an alarm does. Timed the same three ways.

Each row is 400 runs after 50 warm-up runs.

| | Run 1: median | p95 | Run 2: median | p95 |
| --- | --- | --- | --- | --- |
| results, alone | 1.60 ms | 2.28 ms | 1.46 ms | 2.30 ms |
| results, PATCH loop on its sensor | 1.65 ms | 2.36 ms | 1.65 ms | 2.53 ms |
| results, PATCH loop on a sibling | 1.70 ms | 2.44 ms | 1.95 ms | 5.40 ms |
| channel PATCH, alone | 2.18 ms | 3.25 ms | (4.06 ms in the loop) | |
| FK check, alone | 0.33 ms | 0.48 ms | 0.67 ms | 2.92 ms |
| FK check, PATCH loop on its sensor | 2.28 ms | 3.19 ms | 4.71 ms | 15.10 ms |
| FK check, PATCH loop on a sibling | 0.46 ms | 1.05 ms | 0.68 ms | 1.47 ms |

**A results transaction does not wait for the PATCH.** The PATCH was in flight for the whole window. Beside it on the measured sensor, the result took −0.06 ms (run 1) and −0.30 ms (run 2) against the same loop on the sibling: noise. Nothing in a results write locks the sensor's `object` row:
- `sample` and `sensor_state` have no foreign key to it;
- the `sensor_runtime` UPDATE changes no key;
- `channel_counter` references the channel row, which the PATCH holds only `FOR NO KEY UPDATE`.

**A foreign key check on the sensor waits about one PATCH.** That was +1.82 ms at the median in run 1, where one PATCH took 2.18 ms, and +4.02 ms in run 2, where one took 4.06 ms. This is what a `FOR NO KEY UPDATE` helper would save. It applies only to a statement that inserts a row referencing the sensor (an alarm armed), and only while an operator is saving that sensor's channel.

**Verdict:** it does not matter. The `FOR UPDATE` stays.

## `P-341`: the channel list plans against `sample` when nothing needs it

**Fixture:**
- 5,000 sensors with 3 channels each, 15,000 channels in all, of a test type that declares every channel.
- `sample` holds the shipped 40 days of raw retention in 41 daily chunks, 33 of them compressed: 2,414,881 readings. The density is lower than v1's, but the planning cost is per chunk, not per row.

| | Run 1: median | p95 | Run 2: median | p95 |
| --- | --- | --- | --- | --- |
| `GET /objects/:id/channels`, a type that cannot say | 1.56 ms | 3.69 ms | 1.65 ms | 2.53 ms |
| the same, every key declared (`P-341`'s case) | 3.97 ms | 7.21 ms | 4.18 ms | 6.78 ms |
| the same, two keys taken out 30 days ago | 4.46 ms | 8.95 ms | 4.77 ms | 7.15 ms |
| the statement alone, as shipped, every key declared | 2.87 ms | 4.46 ms | 2.88 ms | 3.98 ms |
| the statement alone, without the subquery | 0.35 ms | 0.72 ms | 0.32 ms | 0.61 ms |
| 304, nothing included | 0.91 ms | 1.46 ms | 1.10 ms | 2.00 ms |
| 304, `?include=ancestors` | 1.54 ms | 3.19 ms | 1.87 ms | 3.07 ms |
| 304, `?include=channels`, every key declared | 5.28 ms | 9.91 ms | 5.99 ms | 10.74 ms |
| a new connection's first statement, as shipped | 22.60 ms | 31.63 ms | 23.76 ms | 39.08 ms |
| a new connection's first statement, without the subquery | 3.93 ms | 5.16 ms | 4.41 ms | 6.10 ms |

**The subquery is never run, but it is planned.**
- **Warm.** Planning took 1.87 to 2.17 ms against 0.07 to 0.09 ms, with all 41 chunk relations planned, while execution took 0.5 ms. It adds 2.5 ms a call.
- **On a new connection,** it adds 18.7 to 19.4 ms, all of it planning. That is the first read after `pg`'s pool has closed an idle connection (10 s by default).
- **A 304 for `?include=channels`** costs about 4.5 ms more than one with nothing included.

**Verdict:** it does not matter at v1, so the statement stays as it is.
- The worst figure is a 304 for `?include=channels` at a p95 under 11 ms, or 24 ms on a cold connection, against the 250 ms an operator's page has (`A-12`).
- The cost grows with the chunk count, which retention bounds at about 41, not with the number of readings.

If a later change multiplies the reads, dropping the subquery when every key is declared is worth 2.5 ms each, and this case measures it.

## `P-374`: `/values` reads the object and its channels on every poll

**Fixture:**
- The same tree, plus 40 polled sensors with 8 channels each (15,200 channels in all) and 1,234,440 readings over 41 chunks, 33 compressed.
- Each part was timed 400 times through the functions the route calls, over 20 sensors, no auth and signed in.

| Run 1 / run 2, median | 8 channels, all declared | 2 retired 30 days ago |
| --- | --- | --- |
| route, no auth | 6.53 / 6.33 ms | 6.99 / 6.78 ms |
| route, signed in | 8.71 / 8.32 ms | 8.89 / 8.75 ms |
| `latestForSensor` (the values, as before `U-38`) | 2.12 / 1.95 ms | 2.00 / 1.93 ms |
| `channels()` (`U-38`'s two reads) | 3.88 / 3.83 ms | 4.24 / 4.18 ms |
| of which the object read | 0.82 / 0.84 ms | 0.83 / 0.84 ms |
| of which the channel read | 2.99 / 3.06 ms | 3.40 / 3.39 ms |
| a slim read in place of the object read | 0.42 / 0.41 ms | 0.40 / 0.41 ms |

**Throughput,** polling the 20 declared sensors at once for 50 rounds on a pool of 5 connections (20 ship):

| | Run 1 | Run 2 |
| --- | --- | --- |
| signed in | 399 polls/s, 1.67 ms of CPU a poll | 455 polls/s, 1.40 ms of CPU a poll |
| no auth | 533 polls/s | 599 polls/s |

The floor is 40 polls/s: 30 accounts, each with 20 sensors open at 15 s.

**`U-38`'s two reads are 3.9 to 4.2 ms of a 6.3 to 7.0 ms poll.**
- **The object read** is 0.8 ms of that. A path that reads only `sensor_type` and `params` would save 0.4 ms a poll, 5% of a signed-in poll.
- **The channel read** is the larger part. Most of it is `P-341`'s planning of the subquery, and a slimmer object read would not touch it.

**Verdict:** it does not matter.
- A poll every 15 s at under 9 ms, signed in, leaves one core at a few percent for any dashboard v1 targets.
- The slim path is not worth a second way of reading a sensor.

## What the three cases cost `test:perf`

About 2.5 minutes together: `P-324` 13 s, `P-341` 52 s (24 s of it building the fixture), `P-374` 69 s. They hold generous budgets (each case says why) and print the numbers above.

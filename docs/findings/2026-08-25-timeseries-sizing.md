# Measurements: time-series storage (S-05)

- **Date**: 2026-08-25
- **Measured on**: PostgreSQL 17.11, TimescaleDB 2.29.2 (Apache licence mode)
- **Method**: 1.5 million rows written into a hypertable shaped exactly like `sample`
  (15,000 channels × 100 minutes — one minute at the v1 target is 5,000 sensors × ~3 channels),
  then `pg_total_relation_size` over its chunks

## Chunk interval

The v1 target is 5,000 sensors at a 60-second interval (`CAPABILITIES.MD` §13), which is about
**21.6 million rows a day**.

| Chunk interval | Size of one chunk |
| --- | --- |
| 1 day (chosen) | 2,878 MB |
| 7 days (TimescaleDB's default) | 20 GB |

Timescale's guidance is that the recent working set should fit in roughly a quarter of RAM. On
the 16 GB box the target names that budget is ~4 GB, so a one-day chunk fits and the default
does not. `sensor_state` keeps the seven-day default: transitions are orders of magnitude rarer
than readings, and uptime queries span months, so wider chunks mean fewer to touch.

## Indexes are most of the storage, so a redundant one is expensive

First cut had two indexes of our own on `sample`: `(channel_id, time DESC)` for graph queries
and a unique `(channel_id, time)` for replay idempotency.

| Indexes on `sample` | Bytes/row | 40 days of raw data |
| --- | --- | --- |
| `(channel_id, time DESC)` + unique `(channel_id, time)` | 139.7 | 112 GB |
| unique `(channel_id, time)` alone | 99.3 | 80 GB |

**32 GB for nothing.** PostgreSQL reads a btree backwards as happily as forwards, so the unique
index already serves the newest-first query. Verified in the plan:

```
Limit
  ->  Index Scan Backward using _hyper_6_4_chunk_bench2_channel_id_time_idx
        Index Cond: (channel_id = 42)
```

At 62.6% of total size before the trim, indexes are the majority of this table — a duplicate is
not a rounding error. `timeseries-schema.test.ts` now asserts that neither hypertable carries an
index of ours that another already covers, so the next one has to be argued for.

`sensor_state` went the same way, from three indexes to one: a unique `(sensor_id, time)`
`INCLUDE (state)`. Uniqueness for replay, backwards scans for "what is this sensor's latest
state", and `INCLUDE` making that answer index-only — which matters because the alarms view asks
it for every sensor at once.

The `(time DESC)` index `create_hypertable()` leaves behind stays on both. The rollup job (S-06)
scans a time window across every channel, which is what that index is for and what a
channel-leading composite cannot serve.

## What this implies for sizing guidance (H-08)

At the v1 target, raw retention costs roughly **2.8 GB a day**, or **80 GB for the 40 days**
PRTG keeps raw data. `CAPABILITIES.MD` §13 lists 1,000 GB of disk for a 5,000-sensor
installation, so raw data is well inside it — but that figure is for raw samples only, and the
rollup tiers (S-06) have not been measured yet. Neither has compression, which is a
Timescale-License feature and therefore still an open question (see the licensing finding).

## TimescaleDB is a hard prerequisite, and now says so

The install smoke test caught this: its box ran plain PostgreSQL 15, so migration 003 failed
with `function create_hypertable(...) does not exist` wrapped as *"migration 3 (timeseries)
failed"* — naming neither the missing component nor the fix.

Three changes came out of it:

1. **Migration 003 checks for the extension first** and raises a message that names it, with a
   `HINT` giving the exact remedy. The extension cannot be installed from the migration — it
   needs a package, an entry in `shared_preload_libraries` and a restart — so saying precisely
   what to do is the only useful thing this code can do.
2. **`DatabaseError` and `MigrationError` now carry the cause**, including PostgreSQL's `HINT`.
   The hint is frequently the entire answer, and it was being dropped between the driver and
   the log. An operator now reads:

   ```
   fatal: migration 3 (timeseries) failed: query failed: the TimescaleDB extension is not
   installed in this database
     hint: Install the timescaledb package for your PostgreSQL version, add timescaledb to
     shared_preload_libraries, restart PostgreSQL, then run: CREATE EXTENSION timescaledb;
   ```
3. **The smoke box installs TimescaleDB** from Timescale's own repository, the same way an
   operator would (measured: 2.28.3 on Debian 12 / PostgreSQL 15). Testing against a box
   without it proved only that the migration fails politely, which is not the same as proving
   the product installs.

This is also a data point for `S-11` (TimescaleDB on Windows): on Debian the prerequisite is
three commands, and the failure mode when it is missing is now a clear message rather than a
puzzle. Whether the same holds on Windows Server is still unmeasured, and `ADR-001` names
plain-Postgres with hand-rolled partitioning as the fallback if it does not.

# Finding: most TimescaleDB features we planned on are not Apache-2.0

- **Date**: 2026-08-25
- **Found during**: Phase 0, F-02 (dev Compose)
- **Affects**: `CLAUDE.md` hard constraint 4, `ADR-001` Decision 4, `PLAN.md` Phase 1, `TASKS.md` S-06
- **Status**: open — needs a decision before S-06 starts

## What the documents assume

`CLAUDE.md` constraint 4:

> **Apache-licensed TimescaleDB features only.** Hypertables, continuous aggregates, native
> compression and retention policies are Apache 2.0.

`ADR-001` Decision 4 repeats it:

> Hypertables, native compression, continuous aggregates and `add_retention_policy()` are in
> the Apache-2.0 "TimescaleDB Open Source" core.

## What is actually true

Measured against `timescale/timescaledb:latest-pg17`, TimescaleDB **2.29.2**, PostgreSQL 17,
started with `-c timescaledb.license=apache`.

| Feature                                          | Apache 2.0? | Evidence                                                                |
| ------------------------------------------------ | ----------- | ----------------------------------------------------------------------- |
| `create_hypertable()`                            | **yes**     | `(3,public,sample,t)`                                                   |
| `time_bucket()`                                  | **yes**     | returns buckets normally                                                |
| `drop_chunks()`                                  | **yes**     | executes, returns empty set                                             |
| Plain PG materialised view + `REFRESH`           | **yes**     | `SELECT 100` / `REFRESH MATERIALIZED VIEW`                              |
| Continuous aggregates (`timescaledb.continuous`) | **no**      | `ERROR: functionality not supported under the current "apache" license` |
| Native compression (`timescaledb.compress`)      | **no**      | same error                                                              |
| `add_compression_policy()`                       | **no**      | `not supported under the current "apache" license`                      |
| `add_retention_policy()`                         | **no**      | `not supported under the current "apache" license`                      |
| `add_job()` (background job scheduler)           | **no**      | `not supported under the current "apache" license`                      |
| `time_bucket_gapfill()`                          | **no**      | `not supported under the current "apache" license`                      |

The licence cannot be changed per session — `SET timescaledb.license = 'apache'` fails with
_"Cannot change a license in a running session"_. It is a server start parameter.

TimescaleDB's own hint calls the blocked ones _"free community feature"_: they are covered by
the **Timescale License (TSL)**, which permits free self-hosted use but forbids offering the
software as a database-as-a-service. They are not Apache 2.0.

## Why it matters

Four Phase 1 deliverables were specified directly on top of TSL-only features:

- `S-06` — continuous aggregates `sample_5m` / `sample_1h` / `sample_1d`, compression policy,
  per-tier retention policies.
- The rollup chain in `WORKFLOW.MD §9`.
- `time_bucket_gapfill` is the obvious tool for the "gaps are not zeros" rule (`S-09`), and it
  is TSL too.
- Housekeeping was assumed to ride on Timescale's own job scheduler.

## The two ways out

**A — accept the Timescale Community licence.** Change constraint 4 to permit TSL features and
run the server with `timescaledb.license=timescale` (the image default). Phase 1 proceeds
exactly as written. The cost is a licence obligation: we must not offer the product as a hosted
database service, and if we ever redistribute TimescaleDB binaries in our installer rather than
telling the operator to install it, the TSL terms attach to that distribution. Worth a lawyer's
eye before the 1.0 installers in `H-05`/`H-06`.

**B — stay strictly Apache, build the tier ourselves.** Keep hypertables and `time_bucket`;
implement rollups as plain materialised views (or ordinary hypertables written by a rollup job),
retention as scheduled `drop_chunks()`, and gap handling in the repository layer. We already own
a scheduler and `WORKFLOW.MD §9` already specifies housekeeping as a scheduled job, so the
scheduling half costs little. The real losses are incremental refresh — continuous aggregates
materialise only changed buckets, ours would recompute a window — and native compression, which
has no Apache equivalent and will cost disk.

Both are viable. B costs perhaps 1–2 weeks of Phase 1 and permanently more disk; A costs a
licence constraint on how the product may be sold and shipped.

## Until it is decided

`docker-compose.dev.yml` starts PostgreSQL with `timescaledb.license=${TIMESCALEDB_LICENSE:-apache}`,
so the constraint as currently written is enforced mechanically: a TSL-only feature fails at the
moment someone writes it. Override with `TIMESCALEDB_LICENSE=timescale` once option A is chosen.

## Reproduction

```bash
docker compose -f docker-compose.dev.yml up -d postgres
docker exec -i monitoring-system-dev-postgres-1 psql -U monitoring -d monitoring <<'SQL'
CREATE TABLE sample (time timestamptz NOT NULL, channel_id int NOT NULL, value double precision);
SELECT create_hypertable('sample','time');
CREATE MATERIALIZED VIEW sample_5m WITH (timescaledb.continuous) AS
  SELECT time_bucket('5 minutes', time) AS bucket, channel_id, avg(value) AS avg
  FROM sample GROUP BY bucket, channel_id;
SQL
```

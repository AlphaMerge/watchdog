# Measurements: the budgets after four tickets touched the dispatch path

- **Date**: 2026-09-04
- **Method**: `npm run test:perf` — the measured budgets `CLAUDE.md` keeps out of `npm test`.
  `ms-server` stopped; the background review workflow stopped first as well (see *Host* below).
- **Raw data**: `2026-09-04-perf-budgets-run.txt` — the tail of each workspace's run, which is
  where every summary table is emitted
- **Reproduce**: `./scripts/dev.sh "npm run test:perf"`, or one file with
  `./scripts/dev.sh "cd packages/core && node --test dist/test/perf/<name>.test.js"`
- **Measured on**: 8-core arm64, `node:24-bookworm-slim` in Docker Desktop's LinuxKit VM,
  PostgreSQL 17 + TimescaleDB from `docker-compose.dev.yml`
- **Compares against**: `2026-09-03-perf-budgets.md`, the same suite on the same host yesterday

**33 of 33 passed, nothing cancelled, no budget missed.** Two are skipped by design — the
pool-size sweep (`MS_BENCH_SWEEP=1`) and the full-hour soak (`MS_SOAK_MINUTES=60`).

## Why this run was worth doing

`P-73` through `P-79` put new work on paths that run per check:

- `P-76` calls `CheckFlowWatchdog.dispatched` on every accepted dispatch and `completed` on every
  settled check — two `Map` operations each, on the thread the wheel runs on.
- `P-77` changed `checksBehind` to iterate the **assignment set** rather than the completion map,
  which at the v1 target is 5,000 entries per `stats()` call instead of however many had
  completed.
- `P-78` added a second `.catch` to `ResultSpool.append`'s promise chain, on the path every result
  takes to disk.

`CLAUDE.md` is explicit that a performance claim needs a measurement committed to the repo. None
of the three is visible in the numbers, and the paragraph below on the host is the reason that
sentence says *not visible* rather than *costs nothing*.

## `P-15`'s gate — 5,000 sensors at 60 s, dispatch jitter p95 under 1,000 ms

5,000 sensors, 200 ms checks, 8 cores, 90 seconds a run.

| Pool | jitter p50 | **p95** | p99 | wheel p95 | wait p95 | RSS delta | refused |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shipped default (64) | 4 ms | **209 ms** | 214 ms | 8 ms | 206 ms | +622 MB at 64 | 0 |
| old default (7) | 18,755 ms | **28,951 ms** | 29,073 ms | 7 ms | 28,949 ms | +30 MB at 7 | **3,471** |
| demand-driven (4 → 64) | 7 ms | **213 ms** | 311 ms | 8 ms | 207 ms | +11 MB at 4 | 0 |
| small, fixed 48 | 7 ms | 95 ms | 95 ms | 95 ms | 0 ms | +162 MB at 48 | 0 |
| small, demand-driven | 3 ms | 30 ms | 30 ms | 30 ms | 0 ms | +10 MB at 4 | 0 |
| `icmp.ping` as it ships (64) | 11 ms | **612 ms** | 624 ms | 11 ms | 606 ms | +513 MB at 64 | 0 |
| before `P-07`, 3 s checks | 1,364 ms | **3,171 ms** | 3,228 ms | 226 ms | 3,158 ms | +2,068 MB at 256 | 0 |

**The gate passes at 209 ms against a 1,000 ms budget**, with 7,630 of 7,630 dispatched checks
completed and nothing refused. The check that actually ships — `icmp.ping`, a 600 ms check rather
than the synthetic 200 ms one — passes at **612 ms**, which is the number to quote when anyone
asks what the criterion means in production.

### The comparison with yesterday, and the confound in it

| | 2026-09-03 | 2026-09-04 |
| --- | --- | --- |
| shipped default | pool 48 → p95 **296 ms**, p99 1,114 ms, wheel p95 53 ms | pool 64 → p95 **209 ms**, p99 214 ms, wheel p95 8 ms |
| demand-driven | 4 → 48 → p95 **214 ms**, p99 411 ms | 4 → 64 → p95 **213 ms**, p99 311 ms |

**The shipped-default row is not a like-for-like comparison — the default moved from 48 workers to
64 between the two runs**, so that row measures a different configuration, not a faster one. The
demand-driven row is the closer pair, and it is 214 ms against 213 ms: unchanged, to well inside
the noise of this host.

Yesterday's p99 of 1,114 ms — flagged there as a tail worth knowing about, measured at load
average 9 — did not reappear; today's p99 is 214 ms. That is a statement about the host on each
day, not about a change in the code.

## The spool, which `P-78` touched

A 1-minute disconnect at 5,000 sensors on a 60 s interval:

| | 2026-09-03 | 2026-09-04 |
| --- | --- | --- |
| written | 1.0 MB in 1 segment, **22 ms** | 1.0 MB in 1 segment, **11 ms** |
| projected for an hour | 62 MB at 216 B a reading — 3.0% of the 2 GiB default | identical |
| replay | 37 ms, **135,735 readings/s**, 1,629× the outage | 17 ms, **286,854 readings/s**, 3,442× |
| integrity | lost 0, duplicated 0, corrupt 0 | lost 0, duplicated 0, corrupt 0 |

The write and replay figures roughly halved. **This is not a `P-78` speedup and should not be read
as one** — `P-78` adds a `.catch` to a promise chain, which cannot make anything faster. Both runs
are single samples of a millisecond-scale operation on a shared Docker VM, and the honest reading
is that the added handler is below this benchmark's resolution.

What the row does establish is the thing worth establishing: `lost 0, duplicated 0, corrupt 0`
still holds with the new counter in the path, and `spoolUnwritten` stayed at zero throughout a run
where nothing was meant to fail.

## The core budgets

| Measurement | Result |
| --- | --- |
| Rollup, 15,000 channels at 60 s: raw → 5m | 571 ms for 4 buckets — **143 ms a bucket against a 300,000 ms period** |
| — 5m → 1h | 141 ms for 15,000 buckets |
| — 1h → 1d | 131 ms for 15,000 buckets |
| — on disk | raw 103.1 B/row, 5m 116.3 B/row |
| Native compression, 300 channels × 1,440 readings | 40.0 MB → 4.0 MB, **10.1×**, in 138 ms; graph read against compressed chunks 1.3 ms |
| Tree build, 5,000 objects over HTTP, budget 30 s | serial **22.8 s** (24% spare), 8 in flight 6.6 s, bulk one request **2.2 s** |
| Replay fairness: live probe while another empties an hour | passes |
| Sizing pass over 5,000 assignments (`P-48`) | median **0.42 ms**, worst 1.21 ms, budget 50 ms |

Two of these want a note.

**Compression measured 10.1×, and `CLAUDE.md` cites 12.5×.** Different shapes: the licensing note's
figure comes from `2026-08-25-rollup-storage-spike.md` on production-shaped chunks, and this
benchmark builds 300 channels × 1,440 readings to keep the test inside a minute. The test asserts
"an order of magnitude", which is what it is named for and what it got. Nothing here contradicts
the licence argument — both numbers are far past the point where native compression is worth the
TSL dependency — but the two figures are not measuring the same thing and should not be quoted
against each other.

**Tree build is 22.8 s against a 21.0 s baseline recorded after `S-16`.** The test's own output
carries the explanation: each create now writes a `sensor_runtime` row (`M-02`) and checks for a
paused ancestor (`M-08`). 24% spare against a 30 s budget, and the bulk path `P-19` exists for is
2.2 s.

## Host, stated because it bounds every number above

Load average **2.74** at the start and **4.56** at the end. This machine was not idle: an
unrelated project's Electron processes ran at roughly 5% throughout, and the `test:perf` suite
itself is what drove the average up during the run.

A background review workflow had been running earlier and was stopped before this — it had been
patching and restoring files in the main working tree, which is also why the full suite was
re-run from `tsc -b --force` before any of these commits. See
`2026-09-04-tests-that-passed-for-the-wrong-reason.md` for why that mattered more than it sounds.

**So: read these as budgets comfortably met, not as a regression baseline.** The margins are
large — 209 ms into 1,000 ms, 143 ms into 300,000 ms, 0.42 ms into 50 ms — and a host at load
average 3 cannot move any of them enough to matter. A run-to-run difference of 10 or 20% in the
millisecond-scale rows is this machine, not the code, and the spool row above is the clearest
example of exactly that.

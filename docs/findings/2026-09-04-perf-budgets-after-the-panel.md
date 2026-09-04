# Measurements: the budgets after the review panel's twenty fixes

- **Date**: 2026-09-04, second run of the day
- **Method**: `npm run test:perf` — the measured budgets `CLAUDE.md` keeps out of `npm test`.
  `ms-server` stopped; no review workflow running (see *Host*)
- **Reproduce**: `./scripts/dev.sh "npm run test:perf"`, or one file with
  `./scripts/dev.sh "cd packages/core && node --test dist/test/perf/<name>.test.js"`
- **Measured on**: 8-core arm64, `node:24-bookworm-slim` in Docker Desktop's LinuxKit VM,
  PostgreSQL 17 + TimescaleDB from `docker-compose.dev.yml`
- **Compares against**: `2026-09-04-perf-budgets-after-the-watchdogs.md`, the same suite on the
  same host earlier the same day, before `P-80`–`P-83`

**33 of 33 passed, nothing cancelled, no budget missed.** Two skipped by design — the pool-size
sweep (`MS_BENCH_SWEEP=1`) and the full-hour soak (`MS_SOAK_MINUTES=60`).

## Why this run

`P-80` through `P-83` changed code on paths that run per check or per sweep:

- `linkFor` now reads a monotonic clock and computes three ages on every call (`P-81`).
- `verdict` takes ages rather than instants, and the sweep is bounded to twenty probes a pass.
- `CheckFlowWatchdog` keeps a completion clock per runner and an assignment stamp per sensor
  (`P-82`), and `dueDispatcher` carries a runner label on every accepted dispatch.
- `ResultSpool.append` gained a closed-check; `peek` and `commit` gained skip accounting (`P-80`).
- Every settled check now goes through an extracted `resultSink` rather than a closure in
  `main()` (`P-83`).

None of it is visible in the numbers. `CLAUDE.md` says a performance claim needs a measurement in
the repo, and "not visible" is the claim this page supports — not "free".

## `P-15`'s gate — 5,000 sensors at 60 s, dispatch jitter p95 under 1,000 ms

| Pool | jitter p50 | **p95** | p99 | wheel p95 | wait p95 | RSS delta | refused |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shipped default (64) | 5 ms | **209 ms** | 215 ms | 9 ms | 205 ms | +677 MB at 64 | 0 |
| old default (7) | 18,697 ms | **28,927 ms** | 29,058 ms | 7 ms | 28,924 ms | +32 MB at 7 | **3,468** |
| demand-driven (4 → 64) | 6 ms | **213 ms** | 307 ms | 8 ms | 206 ms | +16 MB at 4 | 0 |
| small, fixed 48 | 3 ms | 6 ms | 6 ms | 6 ms | 0 ms | +185 MB at 48 | 0 |
| small, demand-driven | 5 ms | 38 ms | 38 ms | 38 ms | 0 ms | +15 MB at 4 | 0 |
| `icmp.ping` as it ships (64) | 8 ms | **613 ms** | 620 ms | 8 ms | 607 ms | +536 MB at 64 | 0 |
| before `P-07`, 3 s checks | 660 ms | **2,384 ms** | 2,458 ms | 9 ms | 2,380 ms | +2,095 MB at 256 | 0 |

**209 ms against a 1,000 ms budget**, 7,536 of 7,536 completed, nothing refused. Against the
earlier run today — same host, same defaults — the two rows that matter are **identical**:

| | before `P-80`–`P-83` | after |
| --- | --- | --- |
| shipped default (64) | p95 **209 ms** | p95 **209 ms** |
| demand-driven (4 → 64) | p95 **213 ms** | p95 **213 ms** |
| `icmp.ping` as it ships | p95 **612 ms** | p95 **613 ms** |
| sizing pass, 5,000 assignments | median 0.42 ms | median **0.36 ms** |

That is as close to "no change" as this benchmark can express. It is not evidence that the new
work is free — a per-call `hrtime.bigint()` and a `Map` lookup are far below this benchmark's
resolution, and would not show up if they cost ten times what they do.

## The spool, which `P-80` changed in three places

A 1-minute disconnect at 5,000 sensors on a 60 s interval:

| | before | after |
| --- | --- | --- |
| written | 1.0 MB in 1 segment, 11 ms | 1.0 MB in 1 segment, **15 ms** |
| replay | 17 ms, 286,854 readings/s | 20 ms, **253,903 readings/s** |
| integrity | lost 0, duplicated 0, corrupt 0 | lost 0, duplicated 0, corrupt 0 |

Slower by a third on both, and **that is not a real regression either** — the earlier run's own
write-up says the same thing in the other direction, where these figures roughly *halved* from the
run before it without any change that could have made them faster. These are single samples of a
millisecond-scale operation on a shared Docker VM; the honest reading of three runs at 22 ms, 11 ms
and 15 ms is that the noise is larger than anything being measured. What the row establishes is
the part that is not noise: `lost 0, duplicated 0, corrupt 0` still holds with a closed-check on
`append`, skip accounting in `peek` and corruption counted at `commit`.

## The core budgets

| Measurement | Result |
| --- | --- |
| Rollup, 15,000 channels at 60 s: raw → 5m | 636 ms for 4 buckets — **159 ms a bucket against a 300,000 ms period** |
| — 5m → 1h | 154 ms for 15,000 buckets |
| — 1h → 1d | 150 ms for 15,000 buckets |
| — on disk | raw 103.1 B/row, 5m 116.3 B/row |
| Native compression, 300 channels × 1,440 readings | 40.0 MB → 4.0 MB, **10.1×**, in 123 ms |
| Tree build, 5,000 objects over HTTP, budget 30 s | serial **25.9 s** (14% spare), 8 in flight 7.0 s, bulk **2.6 s** |
| Replay fairness: live probe while another empties an hour | passes |
| Sizing pass over 5,000 assignments (`P-48`) | median **0.36 ms**, worst 1.24 ms, budget 50 ms |

### The one number worth watching

**Tree build has gone 21.0 s → 22.8 s → 25.9 s across three measurements**, and the margin against
its 30 s budget is down to 14%. The first two figures are `S-16`'s baseline and this morning's run.

I cannot attribute the latest step to anything I changed, and I am not going to pretend otherwise:
object creation writes channels through `ObjectRepository.createChannels`, not through the
`ChannelResolver` path `P-80` touched, and nothing else in `P-80`–`P-83` is on it. The load average
was higher for this run than for the morning's, which is the ordinary explanation. But three
increasing samples is a shape worth naming rather than filing away, and a single run cannot
separate drift from host noise.

**What would settle it:** run this one file five times on a quiet machine and look at the spread.
That is `P-84`.

One thing *was* found by reading rather than measuring while writing this page: `ChannelResolver`
issued the `sensor_config` type query **twice** on the first-sighting path — once for the declared
limits and once for the shape `P-80` added — under a comment claiming the two shared it. Fixed
here; it is not on the tree-build path and does not explain the number above.

## Host, stated because it bounds every number

Load average 3.96 at the start, and an unrelated project's Electron processes running throughout.
No `ms-server`, and no review workflow — the earlier one had been patching files in the working
tree, which is why the previous page says to check for that before trusting a run.

**Read these as budgets comfortably met, not as a regression baseline.** 209 ms into 1,000 ms,
159 ms into 300,000 ms, 0.36 ms into 50 ms. The exception is tree build, which is the only row
where the margin is small enough that host noise and real drift are hard to tell apart — which is
exactly why it gets a ticket rather than a sentence.

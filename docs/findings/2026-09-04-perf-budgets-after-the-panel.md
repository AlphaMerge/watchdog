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
| Tree build, 5,000 objects over HTTP, budget 30 s | serial **25.9 s** in this batch; **23.7 s (21% spare)** re-measured interleaved — see below |
| Replay fairness: live probe while another empties an hour | passes |
| Sizing pass over 5,000 assignments (`P-48`) | median **0.36 ms**, worst 1.24 ms, budget 50 ms |

### The one number worth watching, and what happened when it was chased

The tree build read 21.0 s (`S-16`'s baseline), 22.8 s this morning and **25.9 s** here — margin
against the 30 s budget down to 14%. Three increasing samples is a shape worth naming, so it was
filed as `P-84` and chased the same evening. What came back is more useful than a regression would
have been, and it starts with getting it wrong twice.

**Round 1 — five runs, each in its own container.** 28.0, 26.9, 27.2, 28.0, 28.1 s. Spread 1.2 s.
A tight spread and every sample above the 25.9 s recorded here reads unambiguously as *real drift*,
and that is what it was called.

**Round 2 — the bisect said no.** `2166bab` (before `P-80`): 23.8, 23.7, 23.7. `e109482` (after
both `P-80` commits): 23.6, 23.7, 24.3. `d6de81e` (after `P-81`–`P-83`): 23.6, 23.5, 23.5. No
commit steps. By elimination that left the *documentation* commit, whose only code change removed
a duplicated query — a change that can only make things faster.

**Round 3 — re-measure HEAD, back to back with the bisect.** 24.1, 23.7, 23.8 s. Identical to every
historical commit. **The bisect had been comparing against a number taken twenty minutes earlier,
and that number was the thing that was wrong.**

| commit | when | how | serial (s) |
| --- | --- | --- | --- |
| `2166bab` | morning | full `test:perf` | 22.8 |
| HEAD | 16:5x | full `test:perf` | 25.9 |
| HEAD | 17:23–27 | 5 runs, **5 containers** | 28.0 26.9 27.2 28.0 28.1 |
| `2166bab` | 17:29 | 3 runs, **1 container** | 23.8 23.7 23.7 |
| `e109482` | 17:32 | 3 runs, 1 container | 23.6 23.7 24.3 |
| `d6de81e` | 17:35 | 3 runs, 1 container | 23.6 23.5 23.5 |
| HEAD | 17:37 | 3 runs, 1 container | 24.1 23.7 23.8 |

**Within a batch the spread is ≤ 1.2 s. Across batches on the same commit it is 23.7 to 28.1 s.**
That is the finding: **repeats inside one batch are not independent samples.** They share whatever
the environment happened to be for those two minutes, so a batch reports its own precision and
says nothing about its accuracy — which is exactly how five tight samples at 27–28 s manufactured
a regression that was not there.

The one systematic difference between the fast and slow batches is one process per container versus
three sharing one, which is a plausible mechanism and is **not** established here: it is one
uncontrolled variable in a comparison with several. It is written down as a hypothesis for whoever
needs the number to be tighter, not as a conclusion.

**The answer for the budget:** `serial` at HEAD is **23.7 s, 21% spare**, unchanged from before
`P-80` when measured the same way in the same minutes. Nothing in `P-80`–`P-83` moved it.

**The rule this produced, which now applies to every row on this page:** a measurement is only
comparable to one taken *in the same batch*. Comparing today's number against yesterday's page
answers a different question from the one it looks like it answers, and the only honest way to
compare two commits is to interleave them.

One thing *was* found by reading rather than measuring while writing this page: `ChannelResolver`
issued the `sensor_config` type query **twice** on the first-sighting path — once for the declared
limits and once for the shape `P-80` added — under a comment claiming the two shared it. Fixed
here. It is on the ingestion path and not the tree-build one, and it explains nothing above; it is
recorded because the comment was false, not because the query was slow.

## Host, stated because it bounds every number

Load average 3.96 at the start, and an unrelated project's Electron processes running throughout.
No `ms-server`, and no review workflow — the earlier one had been patching files in the working
tree, which is why the previous page says to check for that before trusting a run.

**Read these as budgets comfortably met, not as a regression baseline.** 209 ms into 1,000 ms,
159 ms into 300,000 ms, 0.36 ms into 50 ms. Tree build is the only row where the margin is small
enough for the batch effect above to matter, and its interleaved answer is 23.7 s — 21% spare.

Every other row on this page is a single batch and inherits the same caveat. None of them is close
enough to its budget for it to change the conclusion, which is the only reason they are not
re-measured the same way.

# S-08 historic data query — measurements

Date: 2026-08-25 · TimescaleDB 2.29.2, PostgreSQL 17, Node 24.19.0, Debian 12 container on
Apple Silicon · reproduce with `./scripts/dev.sh npm run test:perf -w @ms/core`

The query rules are PRTG's, reproduced from `CAPABILITIES.MD` §9 and `WORKFLOW.MD` §9: ranges
over 500 days are shortened to 365, ranges of 40 days or more are averaged over at least 60
minutes, and the API picks the coarsest rollup that still satisfies the requested resolution.

## Source selection

40 days of one-minute readings on three channels — 172,800 raw rows, a single sensor's history
at the retention limit.

**The same answer, two sources.** Hourly buckets over the whole 40 days, asked of the tier and
then of raw (only reachable through the repository — over 40 days the rules will not let anyone
ask raw for hourly buckets, which is rather the point of the rules):

| Source | Rows read per channel | Time |
| --- | --- | --- |
| `sample_1h` | 960 | **15 ms** |
| `sample` | 57,600 | 40 ms |

**60× fewer rows buys 2.7× the speed.** Worth stating plainly rather than claiming the ratio:
at this volume fixed costs — planning, chunk exclusion across 40 daily chunks, serialising the
result — still dominate. The row reduction matters more as the table grows: at the v1 target
`sample` holds ~864 million rows against `sample_1h`'s 14 million, where index depth and cache
residency are what decide the answer rather than rows scanned.

End to end, through the planner and the HTTP shape:

| Request | Source | Buckets | Rows/channel | Time |
| --- | --- | --- | --- | --- |
| 40 days, 1 hour | `sample_1h` | 960 | 960 | 16 ms |
| 40 days, 1 day | `sample_1d` | 40 | 40 | 4 ms |
| 39 days, 45 minutes | `sample_5m` | 1,248 | 11,520 | 28 ms |
| 39 days, 44 minutes | `sample` | 1,278 | 57,600 | 49 ms |

The last two rows are the same question asked one minute apart, and they are why the planner
steers a *default* resolution onto a width a tier can compose. 44 minutes is a supported
averaging interval that does not divide by five, so it can only be built from raw. An **explicit**
request for 44-minute buckets is still honoured — `source` says where the numbers came from —
because quietly answering a different question is worse than the scan.

## Stitching costs nothing

There is no real-time aggregation: a tier is only authoritative up to its watermark, so a live
graph always ends with a tail read from raw. Winding every tier back a full day and asking again:

```
stitched 2 sources   13 ms   960 buckets   <- a day of tail read from raw
```

No penalty, and `history.test.ts` asserts the stronger property — **the answer does not depend on
how far the rollup has got.** The same range, read fully materialised and then re-read with the
five-minute watermark wound back into the middle of it, produces identical channel arrays. A
bucket straddling the boundary takes part of its readings from each source and is still counted
exactly once.

## Two harness problems this work surfaced

**A latency percentile measured on a busy shared database measures the harness.** The S-07
ingestion p99 was 24 ms in isolation and failed intermittently at 136 ms once two more
database-heavy test files joined the suite. Measurements now live in their own suite
(`test/perf/`), run serially with `--test-concurrency=1`, and run *before* the correctness tests
rather than immediately after fifteen scratch databases have been dropped. Three consecutive
full runs are clean.

Relatedly, the assertions changed shape. `p99 < half the budget` and `tier is 2x faster than
raw` were both asserting the hardware. What is checked now is the stated criterion itself
(`p99 < 100 ms`) plus the *ordering* that justified the design decision — the shipped batch size
writes faster than the largest one, the tier reads faster than raw — which is stable because a
busy machine moves both numbers together.

**`tsc -b` never deletes output for a deleted source.** Two throwaway test files written during
the S-03 review were still being compiled into `dist/test` and run by every `npm test`, long
after their sources were removed. They passed, so the only cost was a confusing test count — but
a stale test that *fails* would have been a much worse afternoon. `test/build-hygiene.test.ts`
now fails if any compiled test has no source.

# Measurements: the `test:perf` budgets, two that failed, and the re-run that closed them

- **Date**: 2026-09-03
- **Method**: `npm run test:perf` — the measured budgets, which `CLAUDE.md` keeps out of
  `npm test` on purpose. Run with `ms-server` stopped.
- **Raw data**: `2026-09-03-perf-budgets-run.txt`, the whole run;
  `2026-09-03-perf-budgets-scheduler.txt`, the separately recovered `P-15` table;
  `2026-09-03-perf-budgets-clean-run.txt`, the re-run after both fixes;
  `2026-09-03-perf-budgets-icmp-corrected.txt`, the `icmp.ping` case against the check that ships
- **Reproduce**: `./scripts/dev.sh "npm run test:perf"`, or one file with
  `./scripts/dev.sh "cd packages/core && node --test dist/test/perf/<name>.test.js"`
- **Measured on**: 8-core arm64, `node:24-bookworm-slim` in Docker Desktop's 7.75 GB LinuxKit VM,
  PostgreSQL 17 + TimescaleDB from `docker-compose.dev.yml`

**First run: 29 of 31 passed. Two failed, and neither was what its output first appeared to
say** — one a SIGKILL wearing an assertion's clothes, the other a budget miss on a host that was
not entitled to adjudicate it. Both were filed and fixed the same day (`P-30`, `P-29`), and the
re-run at the end of this page is clean: **31 of 31, nothing cancelled**. The failures are kept
here in full rather than overwritten, because what each one turned out to be is the finding.

---

## What passed, with the numbers

### Ingestion and storage

| Budget | Measured | Against |
| --- | --- | --- |
| Ingestion, 1,000 rows a write (shipped default) | **3,201,544 samples/min**, p99 42.1 ms | 100,000/min, p99 < 100 ms |
| — at 2,000 rows | 3,557,107 samples/min, p99 65.4 ms | |
| — at 5,000 rows | 3,540,273 samples/min, p99 98.7 ms | |
| Full ingest path, 30,000 readings | 2,547,652 samples/min | 100 channels created once, 300 then served from cache with no query |
| State machine, steady | 2,502,112 samples/min, p99 32.9 ms | **costs −0.2% of throughput** against 2,497,851 with no states |
| State machine, every sensor flapping every scan | p99 write 26.1 ms, 1,900 transitions in 20 writes | 271 ms per batch end to end, 250 ms of it the flush timer |

The shipped 1,000-row default is **32× its target**, and the two larger batch sizes buy no
throughput while spending p99 — which is the shape that chose the default.

### Rollups, compression and query

| Budget | Measured |
| --- | --- |
| raw → 5m at the v1 target (15,000 channels) | **604 ms for 4 buckets** — 151 ms a bucket, against a 300,000 ms budget |
| 5m → 1h | 133 ms for 15,000 buckets |
| 1h → 1d | 129 ms for 15,000 buckets |
| On disk | raw 103.1 B/row, 5m 117.4 B/row |
| Compression, a day per channel (the production chunk shape) | **40.0 MB → 4.0 MB, 10.1×, in 198 ms** |
| Graph read against compressed chunks | 1.1 ms |
| 40 days of hourly buckets, from `sample_1h` vs from raw | **24 ms vs 61 ms** — 2.5×, reading 60× the rows |
| A 44-minute window no tier divides | 77 ms from raw, 1,277 buckets from 57,600 rows/channel |
| A day of tail stitched onto a rollup | 18 ms, 960 buckets from 2 sources |

Compression measured 10.1× here against the 12.5× the sizing page quotes; that page's figure is
from `2026-08-25-timeseries-sizing.md` on a fuller chunk, and both are worth keeping — the
smaller number is what a single day's chunk gives.

### Notifications and inheritance

| Budget | Measured |
| --- | --- |
| First failure with nothing armed | 100 ms |
| Arming 2,000 escalation chains | 139 ms |
| Holding them (worst of 3) | 66 ms |
| Cancelling all 2,000 | 78 ms |
| Firing 4,000 due steps | 235 ms |
| Timers held | 2 idle, 2 with 2,000 pending, 2 after |
| Inheritance clone, 221 objects | 37.2 ms in **15 statements** |
| Seven-level render, setting and credential at each level | 6.12 ms / 2,863 bytes; a 304 is 1.55 ms and **4.0× cheaper** |

### The probe

| Budget | Measured |
| --- | --- |
| ICMP, what ships now (`count 4, -i 0.2, -W`) | **10,147 ms, 99 targets/s**, 1.13 ms CPU each, 4000/4000 replies |
| ICMP, before `P-07` (`count 4, -w 5`) | 49,672 ms, 20 targets/s, 1.56 ms CPU each — **the 5× `P-07` bought** |
| ICMP against a blackhole, now vs before | 10,542 ms (19 targets/s) vs 20,058 ms (10 targets/s) |
| Process-runner start-up, fixture registry | p50 23.1 ms, p95 50.3 ms |
| — with the real catalogue (`icmp.ping`) | p50 26.5 ms |
| — 8 checks at a concurrency of 4 | 84 ms total, 10 ms each |
| Spool: 5,000 readings for a 1-minute outage | 1.0 MB in 1 segment, 22 ms to write |
| — an hour projected | 62 MB at 216 B a reading, **3.0% of the 2 GiB shipped default** |
| — replay | 37 ms in 3 batches, **135,735 readings/s**, caught up **1,629× faster than the outage** |
| — integrity | lost 0, duplicated 0, corrupt 0 |
| Replay fairness: a live probe while two others replay | p50 265.6 ms against 265.3 ms quiet — **0.98×, budget 3×** |

ICMP measured on 8 cores, 1,000 targets, 64 in flight.

### `P-15`'s gate — 5,000 sensors at 60 s, dispatch jitter p95 under 1,000 ms

Recovered separately, with the 256-worker case skipped, because the SIGKILL below destroys the
report. 5,000 sensors, 200 ms checks, 8 cores, 90 seconds a run:

| Pool | jitter p50 | **p95** | p99 | wheel p95 | wait p95 | RSS delta | refused |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shipped default (48) | 7 ms | **296 ms** | 1,114 ms | 53 ms | 257 ms | +555 MB at 48 | 0 |
| old default (7) | 18,707 ms | **28,848 ms** | 29,001 ms | 7 ms | 28,838 ms | +34 MB at 7 | **3,456** |
| demand-driven (4 → 48) | 8 ms | **214 ms** | 411 ms | 9 ms | 208 ms | +16 MB at 4 | 0 |
| small installation, fixed 48 | 4 ms | 141 ms | 141 ms | 141 ms | 0 ms | +262 MB at 48 | 0 |
| small installation, demand-driven | 6 ms | 62 ms | 62 ms | 62 ms | 1 ms | +18 MB at 4 | 0 |

**The gate passes at 296 ms against a 1,000 ms budget**, with nothing refused, and the
demand-driven pool an operator actually gets reaches **214 ms** — starting from four workers costs
nothing at the percentile the criterion is stated at.

Two things to read carefully rather than at a glance:

- **The p99 of 1,114 ms is above the budget's number, and the budget is stated at p95.** That is
  the criterion `PLAN.md` and `WORKFLOW.MD §3` set, so this is a pass; but a tail that crosses a
  second on a host at load average 9 is worth knowing, and the committed sustained hour
  (`2026-08-26-scheduler-benchmark.md`) is where the settled tail lives.
- **The RSS column understates the later rows.** All five runs share one process in sequence, so a
  pool that grows to 48 after an earlier run already reached 48 adds nothing measurable. Read the
  column down the *small installation* pair, where it is a clean comparison — **+262 MB fixed
  against +18 MB demand-driven**, which is `P-18`'s whole argument in one line — and not across
  the first three.

**The old core-count default is the counter-example, and it is emphatic**: 7 workers against a
burst of 83 gave a p95 of 28.8 *seconds* and **refused 3,456 of 7,536 checks**. Almost all of it is
wait, not wheel — 28,838 ms of 28,848 — which is the pool, not the timer, and is why `P-15` sized
the pool rather than tuning the wheel.


---

## Failure 1 — the scheduler file is SIGKILLed, not failing (`P-30`)

`node:test` reported:

```
✖ dist/test/perf/scheduler-benchmark.test.js (390913.464345ms)
  'test failed'
```

No assertion, no stack, no message — and **every test inside the file passed**. That output is
what `node:test` prints when the child process dies instead of asserting.

```
NODE_EXIT=137                      # 128 + SIGKILL
peak RSS   2,636,592 kB (2.57 GB)
killed at  84 s of the 90 s run
available  2,643 MB in the VM
```

The case is the file's last one — "shows what the sensor type we actually ship would need" — which
asks for **256 workers at 3-second checks for 90 seconds** to assert `completed > 0`. Inside the
whole file it dies sooner than in isolation, because three 90-second soaks have already run in the
same process.

**Checked rather than assumed: `P-26` did not cause this.** The pre-`P-26` `pool.ts` was compiled
back in and verified in the emitted JavaScript (`busySince=4, idleSince=0`) before running — it is
killed identically, `NODE_EXIT=137`. The case has always been this expensive on a machine this
size.

Two separate faults, which is why the ticket does not simply raise Docker's memory limit: the case
costs 2.6 GB to assert almost nothing, and **a SIGKILL is indistinguishable from a real failure**
in the output — the precise "false failures teach everyone to stop reading the output" problem
that `CLAUDE.md` separates `test:perf` from `npm test` to avoid.

It also destroys the report: the jitter table is printed from the file's `after` hook, so the run
that met `P-15`'s gate could not show its own numbers. The table above was recovered separately.

**Fixed, and the case has now run for the first time.** It reads `MemAvailable` before starting
and skips with a sentence when the machine cannot hold 256 workers — verified both ways on the
command that used to be killed: **skipped at 3,005 MB available (exit 0)** where it previously
gave `NODE_EXIT=137`, and **ran to completion at 4,262 MB**, peak RSS **2,801 MB**. The 2,575 MB
above was a truncated peak, read from a run killed at 84 s.

Because it had never completed, its own subject had never been measured — only predicted from
arithmetic in `2026-08-26-scheduler-benchmark.md`:

    icmp.ping-shaped  3000 ms check  pool 256
      jitter p50 603 ms  p95 2333 ms  p99 2371 ms
      (wheel p95 18 ms, wait p95 2325 ms)   7,876/7,876 checks, 0 refused

**The `icmp.ping`-shaped load misses the 1,000 ms budget by 2.3×** — 3.8× alone on a cold
process — and 2,325 of those 2,333 ms are *wait*. At 256 workers the pool is the constraint and
the wheel is not, which is the prediction confirmed and the reason `P-07` made the check cheaper
rather than the pool bigger. The whole file now runs 6 pass, 0 fail, 1 skipped, exit 0, with its
report intact.

## Failure 2 — the serial tree build is over its 30-second budget (`P-29`)

Phase 1's exit criterion is **5,000 objects through the API in under 30 seconds**. Three runs,
`ms-server` stopped:

| Run | Serial | Rate | Spare |
| --- | --- | --- | --- |
| 1, dev database | 31.5 s | 159 objects/s | −5% |
| 2, dev database | 33.0 s | 152 objects/s | −10% |
| 3, **fresh empty database** | 35.4 s | 141 objects/s | −18% |

**The dev database's size is not the cause**, which was the first suspect and was tested rather
than argued: the `monitoring` database has grown to **4,958 MB** since the soak, so run 3 went
against a brand-new empty TimescaleDB container — and came out **worst of the three**.

**The cost is per request, not per object.** The same 5,000 objects in *one* request took
**2.6–3.0 s against a 2.8 s baseline** — unchanged — while the serial path has gone
**21.0 → 23.7 → 28.8 → 31.5–35.4 s** across its recorded history
(`2026-08-25-tree-build-measurement.md`, `2026-08-29-bulk-tree-create.md`). Eight in flight moved
too: 5.9 → 7.9–11.1 s. So the extra sits in what a *request* costs — socket, routing, validation,
serialisation — not in what a create costs, which is what `2026-08-29-bulk-tree-create.md` already
identified as the serial path's whole expense.

**Resolved, and it was not a regression** — see `P-29`. A `--cpu-prof` run measured **28.7 s,
the fastest of the lot with the profiler attached**, against the 28.8 s recorded on 2026-08-29:
nothing had got slower. The profile showed the process **63.6% idle**, and counting the
statements gave **11 database round trips per sensor create**, two of which existed only to work
around ordering — the object was read before its channels existed, then the version re-read and
patched in. Reading once, after the writes, took it to **10 round trips and 4.15 → 3.71 ms a
create (−10.6%)**. Three runs after the fix: **26.1, 28.3, 28.8 s** — all inside the budget,
where before it was one run in four. Margin is now 4–13% against a machine that varies ~20%, so
it is better rather than settled.

**Read the original numbers with their caveat, which is large.** Only two commits have touched the create path since
the 28.8 s measurement (`H-07`, `S-18`), neither plausibly per-request; and the host carried other
projects' containers throughout at a load average of about **9 on 8 cores**. Stopping `ms-server`
is not the same as a quiet machine. A per-request cost is the most contention-sensitive thing in
the test, and a **12% spread across three runs cannot adjudicate a 5% miss**. So `P-29`'s first
step is to re-measure on a genuinely idle host, and only then to go looking.

---

## The re-run, after `P-29` and `P-30`

Same command, same machine, `ms-server` stopped, with both fixes in
(`2026-09-03-perf-budgets-clean-run.txt`):

| | `@ms/core` | `@ms/probe` |
| --- | --- | --- |
| tests | 16 | 17 |
| pass | **16** | **15** |
| fail | 0 | 0 |
| cancelled | 0 | 0 |
| skipped | 0 | 2 |

**Both failures are closed by measurement rather than by adjustment.** The two skips are the
opt-in sweeps (`MS_PING_SWEEP`, `MS_BENCH_SWEEP`), not the new memory guard — headroom measured
4,279 MB against its 4,000 MB floor, so the 256-worker case ran.

- **The serial tree build passed inside a full run**, which is the test that matters rather than
  in isolation: **27.6 s, 8% spare**, with bulk at 2.6 s (91% spare) and eight in flight at 9.0 s
  (70%).
- **The scheduler file completed and printed its report**, which is what `P-30` was for:

| Pool | jitter p50 | **p95** | p99 | wheel p95 | wait p95 | RSS delta | refused |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shipped default (48) | 7 ms | **214 ms** | 221 ms | 7 ms | 210 ms | +558 MB at 48 | 0 |
| old default (7) | 18,810 ms | **29,082 ms** | 29,235 ms | 9 ms | 29,079 ms | +36 MB at 7 | **3,485** |
| demand-driven (4 → 48) | 7 ms | **215 ms** | 377 ms | 9 ms | 210 ms | +16 MB at 4 | 0 |
| small, fixed 48 | 4 ms | 7 ms | 7 ms | 7 ms | 1 ms | +254 MB at 48 | 0 |
| small, demand-driven | 5 ms | 43 ms | 43 ms | 43 ms | 0 ms | +18 MB at 4 | 0 |
| `icmp.ping`-shaped (256) | 604 ms | **2,427 ms** | 2,460 ms | 12 ms | 2,422 ms | +2,585 MB at 256 | 0 |

`P-15`'s gate is met at **214 ms against 1,000 ms**, and the demand-driven pool an operator
actually gets matches it at 215 ms.

**The `icmp.ping` row reproduces**: 2,427 ms here against 2,333 ms standalone, both essentially
all wait — but see the correction below, because it is not the check that ships.

### Two numbers that moved, and neither is a signal

- **`small, fixed 48` measured p95 7 ms here against 259 ms in the run before, and 141 ms in the
  one before that.** It is a 15-second run containing 15 checks, so one scheduling hiccup moves
  the percentile by two orders of magnitude. Read the *pair* — fixed 254 MB against
  demand-driven 18 MB — which is what that case exists to show, and ignore its latency column.
- **The state machine "costs 8.3% of throughput" here and −0.2% in the first run.** Same code,
  and both inside budget. It is the difference of two independently noisy throughput
  measurements, which is the least stable quantity in the suite; the claim it supports is "the
  state machine is not what limits ingestion", and 2.47M samples/min against 2.70M supports that
  as well as 2.50 against 2.50 did.

What did *not* move is worth as much: compression 10.1× in both runs, ICMP 99 targets/s in both,
storage 103.1 B/row in both.

---

## Correction: that `icmp.ping` row was the wrong check (`P-31`)

**The case measured above models a three-second `icmp.ping`, and `icmp.ping` has not cost three
seconds since 2026-08-29.** The benchmark was written on 2026-08-26, when `ping` idled a second
between packets; `P-07` then passed `-i 0.2` and made the same check **600 ms** with identical
reply counts (`2026-08-29-icmp-throughput.md`). The case kept the old duration while calling
itself the type we ship, and this page repeated that claim.

The arithmetic inverts at the v1 target's burst of 83.3 checks a second:

| Check duration | In flight (Little's law) | Reads as |
| --- | --- | --- |
| 3,000 ms (pre-`P-07`, what was measured) | 250 | a pool nobody would configure |
| **600 ms (what ships)** | **50** | a pool an operator very nearly has |

Re-measured against the shipped default of 48 workers at the real 600 ms:

    icmp.ping as it ships (48)  600 ms check  pool 48
      jitter p50 3027 ms  p95 5371 ms  p99 5932 ms
      (wheel p95 7 ms, wait p95 5366 ms)   rss +466 MB   refused 0

**Worse than the case it replaced, and for a different reason.** 48 workers at 600 ms serve
80 checks a second against 83.3 arriving, so the pool is **4% short of stable** and the queue
grows for as long as the run lasts. A median check three seconds late is a backlog, not a tail —
and nothing is refused, so no counter reports it. That is `P-32`.

It also exposed `P-33`: `docs/sizing.md`'s rule
`workers ≥ burst ÷ (1 + tolerance ÷ check duration)` bounds the jitter of one burst and never
asks whether that burst clears before the next arrives. It is missing Little's floor,
`workers ≥ burst × check duration`, and understates **every worked example on the page** — 14
against 16.7 for the 200 ms model, 31 against 50 for `icmp.ping`, and 83 against 166.7 for the
2-second HTTP example the page offers as the one that *does not* fit.

Both halves of `P-32` were already measured and never put side by side: `P-07` recorded that
83/s "needs about 55 now", and `P-15` set the default to 48 against a 200 ms model where the
floor is 16.7. Each was right about its own number.

---

## Caveats

- **The host was not idle.** Load average about 9 on 8 cores, with unrelated containers from other
  projects running throughout. Every number above is a floor on this hardware rather than a
  measurement of the software alone — which matters for `P-29` and for nothing else here, since
  every other budget passed with an order of magnitude to spare.
- **arm64 only**, as with every other measurement in this directory.
- **`MS_BENCH_MINUTES` defaults to 1.5.** `P-15`'s criterion says *sustained*, and the committed
  hour is in `2026-08-26-scheduler-benchmark.md`; 90 seconds is the suite-sized version of it.
- **The 256-worker case did not run** in the recovered scheduler table, so this run says nothing
  about the `icmp.ping`-shaped load. `2026-08-26-scheduler-benchmark.md` §"What this says about
  `icmp.ping`" is still the measurement for that.

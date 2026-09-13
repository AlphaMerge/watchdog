# What a report costs the database and the event loop

**Date:** 2026-09-13
**Task:** `P-203` — a report is one query per sensor, and nobody has measured what that costs
**Measurement:** `packages/core/test/perf/report-render-performance.test.ts`
**Runs:** [the committed run](2026-09-13-report-render-cost-run.txt), and
[the first run, before the change](2026-09-13-report-render-cost-before.txt)

## The question

`ReportRenderer` reads history one sensor at a time through `HistoryService.forSensor` — the sensor
page's own read, chosen in `E-04` so a report and the graph beside it cannot disagree about an hour.
The ticket asked what that costs at 1, 10, 100 and 500 sensors over a month and a year, and whether
batching, a concurrency limit, or nothing was the answer. `E-06` added a second question: formatting
is CPU on the one event loop the core serves every request from.

## What was measured

**500 `icmp.ping` sensors, two channels each**, built through `ObjectService`. The rollup tiers a
report actually reads were filled for all of them — the planner answers last month from `sample_5m`
in 45-minute buckets and last year from `sample_1h` in 9-hour buckets, about a thousand buckets
either way — so **8.8 million five-minute rows and 8.7 million hourly rows**, with a bucket missing
about one time in 97. Both watermarks sit past the window, so every read is one segment from one
tier: a report run at 03:00 over last month.

Every report is `graph_and_table`, the heaviest document: it carries each bucket's spread as well as
its average. Build times are the median of three.

Conditions, from `scripts/perf-conditions.mjs`: 0.14 load per CPU, delivered CPU 1.03× the reference
machine, nothing else connected to PostgreSQL. `ms-server` was not running. The development
containers for the protocol simulators and the Vite server were up and idle, each under 2.5% CPU —
recorded in the run file rather than stopped, because they were somebody else's.

## The database reads

| sensors | last month | last year | per sensor | transactions |
| --- | --- | --- | --- | --- |
| 1 | 28 ms | 21 ms | ~20 ms | 4 |
| 10 | 214 ms | 190 ms | ~20 ms | 31 |
| 100 | 1,906 ms | 2,036 ms | ~20 ms | 301 |
| 500 | **refused in 7 ms** | **refused in 9 ms** | — | 1 |

**It is linear, at about twenty milliseconds a sensor, and a thousand buckets costs the same from
either tier.** Where those twenty milliseconds go, timed per transaction over the 100-sensor reports:

| transaction | each | per sensor |
| --- | --- | --- |
| the series itself (`readSeries`) | 16.4 – 21.4 ms | 1 |
| the sensor's channels | 1.1 – 1.4 ms | 1 |
| the tier watermarks | 0.4 – 0.5 ms | 1 |
| an empty transaction, for scale | 0.39 ms | — |

### What this settles about batching

**Batching is not worth a second implementation of `segmentsFor`.** Nearly all of a sensor's cost —
16 to 21 of its 20 milliseconds, the spread being the ordinary noise of three samples — is the series
query aggregating its buckets, and a batched query does exactly the same aggregation over exactly the
same rows. The round trips a batch would save — the channel lookup and
the watermark read, 1.5 ms a sensor — are 8% of the total. The watermark read is genuinely redundant
across a report (it is the same answer for every sensor), and caching it would save 0.4 ms a sensor;
that is recorded here rather than done, because it would change the sensor page's read path to save
a fifth of a second on a 500-sensor report — which the value limit now refuses before reading anyway.

### What it did change: refusing before reading

**The 500-sensor rows were the finding.** A default report over 500 two-channel sensors is about
992,000 values, five times `MAX_CELLS`. In the first run the renderer read every sensor's history —
**10.4 seconds and 1,500 transactions against the live database** — and only then counted the
document and refused. A scheduled report in that state does it on every run, and the operator sees
one refusal and not the ten seconds behind it:

```
            500      10377 ms (9740, 10496, 10377)    20.8 ms           1500         1500   REFUSED after reading: 992,000 values
```

Both terms of the count are known before anything is read: the plan says how many buckets, and one
query says how many channels each sensor has. `ReportRenderer.build` now asks
`HistoryService.channelCounts` first and refuses with the same error, the same numbers and the same
advice. **Seven milliseconds and one transaction.** The check after reading stays, and stays the
authoritative one; `report-render.test.ts` asserts that the estimate equals what the finished
document counts, so the early check cannot refuse a report that would have fitted, and that a
refused report reads no history at all.

## The formatting

Every format, on a 100-sensor `graph_and_table` document of about 198,000 values:

| format | wall | event loop held | size |
| --- | --- | --- | --- |
| HTML | 790 – 947 ms | the same | 14.1 – 14.4 MiB |
| XML | 726 – 728 ms | the same | 11.5 – 11.7 MiB |
| CSV | 445 – 451 ms | the same | 4.0 MiB |
| PDF, `graph_only` | 624 – 631 ms | the same | 1.9 MiB |
| PDF with tables | 1,432 – 1,649 ms | the same | **refused**: 1,900 pages |

**Every format holds the event loop for its whole duration.** The three text formats are synchronous
by construction, and so, in practice, is the PDF — `pdfkit` writes as it is told to draw, and the
only asynchronous moment is the stream's end. The last row deserves its own sentence: **a PDF that
will be refused for its page count holds the loop for a second and a half before it says so**,
because the page count is only known once every cell has been measured.

## Two reports at once, and a request that arrived meanwhile

`ReportRunner` renders at most two at once. The test renders a month and a year over 100 sensors
concurrently — build, HTML, then a `graph_only` PDF each — while issuing the sensor page's own
history read every 25 ms from the same process and the same pool, which is how the core serves a
request while it renders.

| | requests | p50 | p95 | worst |
| --- | --- | --- | --- | --- |
| idle | 161 | 6.7 ms | 10.8 ms | 18.9 ms |
| during two reports | 108 | 7.1 ms | **1,268.6 ms** | **2,646.8 ms** |

The event loop's longest single block in that time was **1,424 ms**.

**The database reads do not hurt anybody** — the median request is unchanged while two reports read
200 sensors' history between them, because every read yields. **The formatting does.** One request
in twenty waited more than a second, and the worst waited 2.6 seconds, behind HTML and PDF
formatting that ran back to back on the loop. Everything the core does on that loop waits the same:
API requests, the probes' results arriving, the state machine deciding alarms, the WebSocket that
pushes state to every open browser.

**That is a problem worth a ticket, and it is `P-204`.** A report at 03:00 costs nothing anybody sees;
"Run now" on a large report at 14:00 freezes the core for everyone for a second or two, and two of
them freeze it for longer. The shape of the fix is the one `CLAUDE.md` already uses for checks —
formatting in a `worker_threads` worker, with the document passed in and the bytes passed back — and
it is deliberately not done here: it is a design change with its own failure modes, and this ticket's
job was to establish whether it was needed.

## Two ways this harness lied before it told the truth

Both are worth recording, because both are ordinary and both would have produced a findings file
that was confidently wrong.

**The event-loop column read 0 ms, then 6 ms, for an 800 ms synchronous render.** Node's
`monitorEventLoopDelay` times each tick against the one before, so the interval straight after
`enable()` — or after `reset()`, which forgets the previous tick as well — is never recorded, and a
render that begins at once blocks inside exactly that interval. The fix is to let the histogram tick
before the work starts, and not to reset it.

**The two-reports test reported a worst case of 30 ms on its second run, after its first had caught
2.8 seconds.** The sampler shared the event loop it was measuring: while a render held the loop the
sampler was frozen too, so it never sent a request into a stall, and timing each request from its
*send* hid every one. The first run's 2.8 s was a read that happened to be in flight when a block
began. This is coordinated omission, and the fix is the standard one — requests on a fixed cadence,
each timed from when it was *due*.

## What is not measured here

A report whose series have to be stitched from a tier and raw — a span that runs past a watermark
that is behind. That is the case `segmentsFor` exists for and it reads more rows; it is the ordinary
state for a report over "the last seven days" run while a rollup is catching up. Reports of more
than two channels a sensor, which reach the value limit sooner and change nothing else. And a
machine other than this one: the per-sensor cost is dominated by one query's aggregation, so it
should move with the database's CPU, and that is an expectation rather than a measurement.

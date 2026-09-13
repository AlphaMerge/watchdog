# Formatting a report beside the core, not on it

**Date:** 2026-09-13
**Task:** `P-204` — a report's formatting holds the core's event loop
**Measurement:** `packages/core/test/perf/report-render-performance.test.ts`, and
`packages/core/test/report-formatter.test.ts` for the pool's behaviour
**Run:** [the committed run](2026-09-13-report-formatter-run.txt)
**Follows:** [what a report costs the database and the event loop](2026-09-13-report-render-cost.md)
(`P-203`)

## The question

`P-203` found every report format synchronous for its whole duration, and two reports formatting
at once freezing every request the core served meanwhile for seconds. This ticket moved formatting
into `worker_threads` workers (`ReportFormatter`) and had to show two things: that a concurrent
request now waits about what it waits idle, and what the move itself costs, because the document
still has to be copied into the worker on the loop.

## What was built

- **`ReportFormatter`**, two workers by default, started on first use and given back after a
  minute idle. The core still builds the document — reading history yields, and `P-203` measured
  it costing a concurrent request nothing — and a worker turns it into files. The document goes
  in by structured clone; the bytes come back transferred, not copied.
- **A bounded queue.** Eight jobs may wait; the ninth is refused with `409 REPORT_BUSY`. The render
  route has no other bound — any number of people can press "render" — so the pool is where it
  lives.
- **A timeout that ends the worker** (two minutes), and **a crashed worker fails one job**; the
  queue behind it gets a new worker.
- **A refusal crosses the thread as a refusal.** A `ReportError` loses its class in a structured
  clone, so its fields are sent and the pool rebuilds it; otherwise a PDF over its page limit would
  become a 500.
- **Two Core Health channels**: *Report formats waiting* (the queue, now) and *Report formats
  refused* (a counter), also exported as `ms_core_report_formats_waiting` and
  `ms_core_report_formats_refused_total`.
- **A lower bound on a PDF's pages**, checked before a font is loaded or a cell measured: total
  table rows over the most rows one page can hold. A property test asserts it never exceeds the
  real page count, over 200 random documents of all three kinds and page heights from 160 to
  900 points — a bound that over-counted would refuse a report that fits.

Conditions, from `scripts/perf-conditions.mjs`: 0.13 load per CPU, delivered CPU 1.01× the
reference machine, nothing else connected to PostgreSQL, `ms-server` not running; the protocol
simulator containers were up and idle, each under 3% CPU, recorded in the run file.

## A request the core serves while two reports render

The `P-203` scenario, unchanged: a month and a year over 100 sensors built concurrently, each
formatted as HTML and then a `graph_only` PDF, while the sensor page's own history read is issued
every 25 ms from the same process and pool, each timed from when it was due. Measured both ways in
one run.

| | requests | p50 | p95 | worst | longest loop block |
| --- | --- | --- | --- | --- | --- |
| idle | 161 | 7.3 ms | 12.3 ms | 14.2 ms | — |
| formatting on the event loop | 212 | 394.8 ms | **1,777.3 ms** | 2,005.7 ms | 1,386 ms |
| formatting in `ReportFormatter` | 184 | 3.1 ms | **10.8 ms** | 95.2 ms | 65 ms |

**A request waits what it waits idle.** The p95 is inside idle's own noise, and so is the lower p50:
idle's was 6.7 and 8.1 ms in the two earlier runs. The budget the test now asserts is p95 at most
50 ms above idle's p95.

**What is left on the loop is the copy into the worker.** The worst request, 95 ms, and the longest
block, 65 ms, match the structured clone of a 100-sensor document on its way in. Timed on its own, a
`structuredClone` of that document takes a median of 89 ms; `postMessage` does only the
serialising half of that on the calling thread, which fits the 46–67 ms every worker row in the run shows as
"held". That is a twentieth of what formatting held, and it scales with the document, which the
value limit bounds.

## Each format, on the loop and in a worker

Last month over 100 sensors, `graph_and_table`, about 198,000 values:

| format | on the loop: wall / held | in a worker: wall / held | size |
| --- | --- | --- | --- |
| HTML | 811 / 814 ms | 1,300 / 56 ms | 14.4 MiB |
| CSV | 448 / 448 ms | 548 / 67 ms | 4.0 MiB |
| XML | 705 / 711 ms | 844 / 58 ms | 11.7 MiB |
| PDF, `graph_only` | 662 / 664 ms | 755 / 55 ms | 1.9 MiB |
| PDF with tables | **refused in under 1 ms** | refused in 99 / 52 ms | at least 1,838 pages |

**Wall time goes up by a tenth to a fifth**, which is the clone and the thread hop — and, most
likely, for the first job (the HTML row, half a second slower than the rest) starting the worker
and loading its modules. Last year's HTML, formatted by a warm worker, was 873 ms against 763 on
the loop. A report is scheduled or requested, not
interactive; a slower report that nobody else waits for is the trade this ticket exists to make.

**The PDF refusal is now immediate.** `P-203` measured this document holding the loop for 1.4 to
1.6 seconds before it was refused, because the page count was only known once every cell had been
measured. The lower bound refuses it in under a millisecond on the main thread, with "at least
1,838 pages" — and in a worker the 99 ms is the copy, not the refusal. A document whose rows would
fit but whose column groups would not (each group repeats every row) is still refused by the real
count afterwards; `report-pdf.test.ts` covers both.

## A correction to `P-203`'s number

**The on-the-loop p95 `P-203` recorded, 1,268.6 ms, was measured by a sampler that stopped too
early,** and so was the first run of this ticket, which read 13.0 ms at p95 beside a 2,742.8 ms
worst case — from 99 requests where about 208 had come due. The sampler stopped as soon as the
reports finished, which is the moment the final stall ended, so every request due during that stall
was never sent. It is the coordinated omission `P-203` fixed at the start of each stall, surviving
at the end of the last one. The sampler now sends every request due before the work ended.

Corrected, formatting on the loop measured **1,777 ms at p95 in the committed run, and 2,550 ms in
the run before it** — the p95 moves by where the stalls fall against the 25 ms cadence, but it is
worse than `P-203` said, not better. The worker figures were not affected: their stalls are too
short to leave a backlog, and their request counts match the time they ran. `P-203`'s findings
file carries a note pointing here.

## What this does not settle

- **Memory.** A worker holds `pdfkit`, `fontkit`, the font and — while it works — its own copy of
  the document and the output. A first attempt read process RSS around the formatting and was
  discarded: the same test formats every document on the main thread too, so the number could not
  say which thread held what. Measuring it needs the worker's own heap statistics, and the
  one-minute idle return is what keeps it from being permanent.
- **A scheduled run can be refused by a full queue.** `ReportRunner` holds two runs and the pool
  has two workers, so the scheduled path never waits on itself — but eight renders queued from the
  API at the same moment would make a scheduled run fail with `REPORT_BUSY` and count as a failed
  run. That needs ten concurrent large renders, and the alternative is an unbounded queue.
- **Two workers, by the runner's bound, not by measurement.** Two cost a concurrent request nothing
  measurable on an eight-core machine; what three would cost, or two on a two-core one, is not
  measured.

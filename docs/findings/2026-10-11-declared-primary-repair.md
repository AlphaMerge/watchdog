# What the declared-primary repair costs a start

- **Date**: 2026-10-11
- **Ticket**: `P-332`
- **Question**: The declared-primary repair (`P-323`, `state/declared-primary.ts`) runs at every
  start, not awaited. It reads every sensor, runs each sensor's type on its stored parameters, and
  moves any primary an earlier build left on the wrong channel. What does that cost at the v1
  target of 5,000 sensors and 15,000 channels, on every start and on the first start after an
  upgrade?
- **Reproduce**: `npm run test:perf` runs `packages/core/test/perf/declared-primary-performance.test.ts`,
  or run that file alone:

  ```bash
  ./scripts/dev.sh "timeout 600 sh -c 'npm run build -w packages/core && cd packages/core && node --test dist/test/perf/declared-primary-performance.test.js'"
  ```

## The data

5,000 sensors under 50 devices: 1,000 each of `port.tcp`, `icmp.ping`, `snmp.cpu`,
`snmp.traffic` and `http.request`, interleaved so every page of 500 holds all five. Each sensor has
a row for every channel its type declares for `{}`, which is 1 to 5, so 15,000 channels. Analysed.
The shipped catalogue (`coreCatalogue('v1')`) does the declaring, and `DatabaseAuditSink` does the
recording.

- **Every later start**: every primary is already the declared one. This is the cost of every start
  once the pass has run.
- **First start after an upgrade**: one sensor in ten has its primary on another of its channels,
  or on none for a type that declares only one, as a build before `P-314` could leave it. That is
  500 sensors to move.

## Conditions

The development toolchain container, 8 CPUs, with `ms-server` stopped. `scripts/perf-conditions.mjs`
at the start: load 0.83 / 2.82 / 5.91, which is 0.10 per CPU; delivered CPU 269 ms for its fixed
loop, 1.01× the reference machine; nothing else connected to the database. The test's own line
counted 15 idle connections to other databases and none active. Four runs.

## Results

| Run | Every later start, median of 5 | Range | First start, 500 to move |
| --- | --- | --- | --- |
| 1 | 28 ms | 26–30 | 296 ms |
| 2 | 35 ms | 27–56 | 402 ms |
| 3 | 31 ms | 27–71 | 185 ms |
| 4 | 41 ms | 30–52 | 445 ms |

Every run: all 5,000 sensors read in 10 pages; on the first start, 500 moved, 1,000 audit entries
(a demotion and a promotion each), nothing skipped, no page failed, and every primary the declared
one afterwards. On every later start, nothing moved (all asserted).

Where a later start's time goes, measured by doing a page's two halves without the pass around
them, per sweep of all 5,000 sensors:

| Run | The SQL: 10 page reads and 10 not-primary reads | The types' declarations |
| --- | --- | --- |
| 1 | 20 ms (18–24) | 4 ms (3–4) |
| 2 | 22 ms (20–24) | 5 ms (4–7) |
| 3 | 23 ms (21–28) | 4 ms (3–5) |
| 4 | 21 ms (20–23) | 4 ms (4–5) |

## What it means

- **A start pays about 30 ms for this pass at the v1 target**, 6 µs or so a sensor, linear in
  sensors since every page costs the same. It is not awaited, so the start does not wait for it
  either. No transaction is opened and nothing is locked when nothing would move.
- **Most of it is the database**, two indexed reads a page. The types' code, run on every sensor's
  parameters, is about a sixth. That is the part `P-323` could not make a single statement of, and
  it is small.
- **The first start after an upgrade costs a few hundred milliseconds** for 500 moves, each a short
  locked transaction a page with its audit entries. It runs once; the next start is back to the
  sweep.
- **Not measured**: parameters other than `{}`. A type whose declaration grows with its parameters
  (`snmp.table`'s columns) runs more code per sensor, but at 4 ms for 5,000 sensors that half
  would have to grow tenfold to matter. A cold cache was not measured either: each run read
  tables the setup had just written.

## Decision

Nothing to change. At about 30 ms a start, the pass does not need a marker, a version check or
batching other than what it has, and `P-323`'s reasoning for running it every start stands.
`P-333`, one policy for the start-up passes, can take this number as this pass's cost.

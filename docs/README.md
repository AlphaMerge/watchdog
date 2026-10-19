# Documentation

Every document in this repository, and which one answers the question you arrived with.

The root [`README.md`](../README.md) is the shortest path from a clone to something running.
This page is the map of everything else. [`CLAUDE.md`](../CLAUDE.md) is the working agreement —
the hard constraints, the design rules, and the decisions that need an ADR to reopen.

## Start here

| If you are…                    | Read, in this order                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **installing this**            | [installation](installation.md) → [sizing](sizing.md) → [administration](administration.md)            |
| **operating it**               | [the web UI](web-ui.md) → [administration](administration.md) → [troubleshooting](troubleshooting.md)  |
| **adding a sensor type**       | [adding a sensor type](adding-a-sensor-type.md) → [sensor reference](sensor-reference.md)              |
| **writing code here**          | [ADR-001](ADR-001-architecture.md) → [WORKFLOW.MD](WORKFLOW.MD) → [PLAN.md](PLAN.md) → [TASKS.md](TASKS.md) |
| **deciding whether it does X** | [CAPABILITIES.MD](CAPABILITIES.MD) — the scope contract, with `[V1]`/`[V2]`/`[OUT]` markers             |

## I want to…

| …                                                      | Go to                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| See which sensor types exist and what they measure      | [sensor-reference.md](sensor-reference.md)                                     |
| Write a new sensor type                                 | [adding-a-sensor-type.md](adding-a-sensor-type.md)                             |
| Find a route, its parameters and its responses          | [api-reference.md](api-reference.md)                                           |
| Understand a view in the browser                        | [web-ui.md](web-ui.md)                                                         |
| Work out why a sensor is Down, Unknown or still Warning | [state-machine.md](state-machine.md), [troubleshooting.md](troubleshooting.md) |
| Know how much hardware to buy                           | [sizing.md](sizing.md)                                                         |
| Give somebody an account and the right permissions      | [administration.md](administration.md)                                         |
| Send alarms by email, and prove the relay works         | [administration.md → Email](administration.md#email)                           |
| Back it up, or restore onto a different host            | [runbook-backup-restore.md](runbook-backup-restore.md)                         |
| Qualify a release candidate                             | [runbook-field-test.md](runbook-field-test.md)                                 |
| Decide what the v1 release candidate is                | [proposal, 2026-09-28](findings/2026-09-28-v1-release-candidate.md)            |
| Know what the current candidate is and what was checked | [v1.0.0-rc.2, 2026-10-04](findings/2026-10-04-v1-release-candidate-cut.md)     |
| Cut the next candidate, `v1.0.0-rc.3`                   | [the cut checklist, 2026-10-19](findings/2026-10-19-rc3-cut-checklist.md)       |
| Upgrade to 1.0, and know what reads differently after   | [release-notes-1.0.md](release-notes-1.0.md)                                   |
| See the field-test runbook rehearsed, and what it got wrong | [dress rehearsal, 2026-10-04](findings/2026-10-04-field-test-dress-rehearsal.md) |
| Check a performance claim                               | [findings/](findings/) — every number here was measured                        |
| Pick up a piece of work                                 | [TASKS.md](TASKS.md)                                                           |

---

## Sensors

| Document                                           | What it is                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| [sensor-reference.md](sensor-reference.md)         | Every type: parameters, defaults, channels, requirements. **Generated — do not edit.** |
| [adding-a-sensor-type.md](adding-a-sensor-type.md) | The `SensorType` contract, the rules the catalogue enforces, and a worked example |

The types themselves are one file each in
[`packages/sensors/src/types/`](../packages/sensors/src/types/), and what a type is *for* is
documented where its author wrote it. The reference describes the shape; the source describes the
intent.

Adding a type is a one-file job. If you find yourself editing a switch statement to add a check,
stop — that is the thing the plugin contract exists to prevent.

## The web UI

| Document                                              | What it is                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| [web-ui.md](web-ui.md)                                | Every view an operator uses, and what each one is for          |
| [`packages/web/README.md`](../packages/web/README.md) | Developing it — the stack, the dev server, the design tokens   |

PRTG's drag-and-drop **map and dashboard designer** is `[V2]` and is not built
([`CAPABILITIES.MD §6`](CAPABILITIES.MD)). What v1 offers instead is the Overview and the Alarms
view; [web-ui.md](web-ui.md) says what each covers.

## The API

| Document                             | What it is                                                          |
| ------------------------------------- | --------------------------------------------------------------------- |
| [api-reference.md](api-reference.md) | Every route. **Generated from the OpenAPI document — do not edit.**  |

A running core serves the same document at `/openapi.json`, which is what the reference is
rendered from — so it is the schema the server actually validates against, not a description of
one.

## Operating it

| Document                                               | What it is                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [installation.md](installation.md)                     | Installing, the first administrator, remote probes, upgrading, uninstalling   |
| [release-notes-1.0.md](release-notes-1.0.md)           | What 1.0 is and needs, what is in it, every upgrade note, and its known limits |
| [administration.md](administration.md)                 | Roles and rights, device credentials, inheritance, pausing, email, what to watch |
| [sizing.md](sizing.md)                                 | How much hardware, from measurements rather than estimates                    |
| [troubleshooting.md](troubleshooting.md)               | Symptoms, and the one number that diagnoses each                              |
| [runbook-backup-restore.md](runbook-backup-restore.md) | What is in a backup, restoring elsewhere, and what to rehearse                |
| [runbook-field-test.md](runbook-field-test.md)         | The release-candidate field test, and what counts as passing it               |

## How the system behaves

| Document                             | What it is                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| [WORKFLOW.MD](WORKFLOW.MD)           | The loops and lifecycles — scanning, state, alarms, notifications, discovery    |
| [state-machine.md](state-machine.md) | Sensor state and pause precedence in full: vocabulary, transitions, invariants  |

`WORKFLOW.MD` is the contract for behaviour over time. `state-machine.md` is the part of it that
is subtle enough to need its own document — read it before changing anything that decides a
state, and before assuming you know what a pause does to a subtree.

## Scope and decisions

| Document                                           | What it is                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [CAPABILITIES.MD](CAPABILITIES.MD)                 | What PRTG does, marked `[V1]` / `[V2]` / `[OUT]`. **The scope contract.**   |
| [ADR-001-architecture.md](ADR-001-architecture.md) | Stack and architecture decisions, each with its rationale                   |
| [ADR-002-map-exposure.md](ADR-002-map-exposure.md) | How a map is exposed: public share links, custom HTML, and why geo maps wait |
| [ADR-003-uploaded-files.md](ADR-003-uploaded-files.md) | Where an operator's uploaded file lives, what bounds it, and why SVG is refused |
| [ADR-004-geographical-maps.md](ADR-004-geographical-maps.md) | Where a geo map's tiles come from, and why the product ships none            |
| [ADR-005-stored-reports.md](ADR-005-stored-reports.md) | Where a generated report lives, and why PDFs are excluded until they exist |
| [ADR-006-report-rendering.md](ADR-006-report-rendering.md) | A PDF and a graph without a browser, and what that costs instead |
| [PLAN.md](PLAN.md)                                 | The phased roadmap, with exit criteria and the measured results per phase    |
| [TASKS.md](TASKS.md)                               | The ticket-sized backlog — **pick work from here**                           |

Keep the scope markers current when something moves between `[V1]`, `[V2]` and `[OUT]`. Before
proposing anything that contradicts `ADR-001`, say so explicitly and explain why.

## Measurements

[`findings/`](findings/) holds every measured result that changes a documented assumption. A
performance claim in this repository is expected to point at one of these; an assertion without a
measurement is not a claim.

**Storage and time series**

- [Time-series storage sizing](findings/2026-08-25-timeseries-sizing.md) (`S-05`)
- [Rollup, compression and retention](findings/2026-08-25-rollup-measurements.md) (`S-06`)
- [Ingestion pipeline](findings/2026-08-25-ingestion-measurements.md) (`S-07`)
- [The batch-size sweep's p99 is its slowest write; the sizes are compared on medians](findings/2026-09-29-batch-sweep-median-under-load.md) (`P-237`)
- [Historic data queries](findings/2026-08-25-historic-query-measurements.md) (`S-08`)
- [What the TimescaleDB dependency actually is](findings/2026-08-25-storage-engine-boundary.md) (`S-12`)
- [Most TimescaleDB features we planned on are not Apache-2.0](findings/2026-08-25-timescaledb-licensing.md)
- [Apache-only rollups versus the Timescale Community licence](findings/2026-08-25-rollup-storage-spike.md)
- [TimescaleDB on Windows](findings/2026-09-03-timescaledb-on-windows.md) (`S-11`)
- [Each sensor's newest state: the text alias, the column, or one sensor at a time](findings/2026-10-11-state-latest-plan.md) (`P-388`)

**Scheduler, probes and checks**

- [Hashed timing wheel](findings/2026-08-25-timing-wheel-measurements.md) (`P-01`)
- [The 5,000-sensor benchmark](findings/2026-08-26-scheduler-benchmark.md) (`P-15`) — the architecture go/no-go gate
- [What a check in its own process costs](findings/2026-08-27-process-runner-startup.md)
- [Handing a script to PowerShell](findings/2026-08-27-powershell-transport.md)
- [ICMP at 1,000 targets](findings/2026-08-29-icmp-throughput.md)
- [Demand-driven pool sizing](findings/2026-08-29-pool-sizing.md)
- [The pool default against the sensor type we ship](findings/2026-09-03-pool-default.md) (`P-32`)
- [What the once-a-minute schedule sweep costs](findings/2026-09-07-schedule-sweep-budget.md) (`P-186`)

**Tree, API and notifications**

- [Tree CRUD API](findings/2026-08-25-tree-api-measurements.md) (`S-03`)
- [Building a 5,000-object tree](findings/2026-08-25-tree-build-measurement.md)
- [Building a 5,000-object tree in one request](findings/2026-08-29-bulk-tree-create.md)
- [What "no timer leaks across thousands of sensors" costs](findings/2026-08-26-notification-timers.md)
- [The tree build was two measurements wearing one name](findings/2026-09-08-tree-build-was-two-measurements.txt) (`P-193`)
- [Whether a filling database slows creates, and the noise that swallowed the question](findings/2026-09-08-tree-build-fill-and-noise.txt) (`P-194`)
- [Object visibility on the read paths: the approach, and what it costs at 20,000 sensors](findings/2026-09-28-object-visibility.md) (`A-12`)

**Reports**

- [What a report costs the database and the event loop](findings/2026-09-13-report-render-cost.md) (`P-203`)
- [Formatting a report beside the core, not on it](findings/2026-09-13-report-formatter.md) (`P-204`)
- [Japanese, Chinese and Korean in a PDF report: which font, and what it costs](findings/2026-09-13-report-cjk-fonts.md) (`E-12`)

**Whole-system**

- [24-hour soak at 5,000 sensors](findings/2026-08-30-soak-24h.md) (`H-01`)
- [Failure modes, row by row](findings/2026-08-29-failure-modes.md) (`WORKFLOW.MD §13`)
- [Sizing across machine tiers](findings/2026-09-03-sizing.md) (`H-08`)
- [The `test:perf` budgets, two that failed, and the re-run that closed them](findings/2026-09-03-perf-budgets.md) (`P-29`, `P-30`)
- [The auto-sizing loop under load, and the feedback trap in it](findings/2026-09-04-autosize-loop.md) (`P-44`, `P-45`, `P-46`)
- [Today's probe changes on a live stack, and a defect that was not one](findings/2026-09-04-live-probe-check.md) (`P-42`–`P-46`)
- [Forty-four tests that passed for the wrong reason, and what exposed each](findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md) (`P-58`–`P-197`, `A-11`, `S-11`, `H-09`)
- [The budgets after four tickets touched the dispatch path](findings/2026-09-04-perf-budgets-after-the-watchdogs.md) (`P-73`–`P-79`)
- [The budgets after the review panel's twenty fixes](findings/2026-09-04-perf-budgets-after-the-panel.md) (`P-80`–`P-83`)
- [The first run that skipped nothing: every criterion at full size](findings/2026-09-08-perf-budgets-full-criteria.txt) (`P-15`, `P-07`, `P-30`)
- [Review round four: the night's security and alarm-volume commits, 22 defects](findings/2026-09-29-review-round-4.md) (`S-21`, `A-44`–`A-47`, `P-239`–`P-242`, `M-23`)
- [Review round 4b: the landings since round four, and round four's gaps, 19 defects](findings/2026-09-29-review-round-4b.md) (`N-18`, `A-48`–`A-50`, `M-24`, `P-245`–`P-247`)

---

## Generated documents

Two of these are rendered from the code and fail the build when they drift:

| Document                                   | Generated by                       |
| -------------------------------------------- | ------------------------------------ |
| [sensor-reference.md](sensor-reference.md) | `scripts/docs/sensor-reference.mjs` |
| [api-reference.md](api-reference.md)       | `scripts/docs/api-reference.mjs`    |

`packages/core/test/build-hygiene.test.ts` regenerates both and fails if the result differs from
what is committed — which is the only way a reference like this stays true. Edit the code, then
re-run the generator; never edit the output.

Everything else here is hand-authored prose, and `docs/` is excluded from Prettier for that
reason: it reflows tables and swaps emphasis markers, which turns every edit into a diff full of
noise.

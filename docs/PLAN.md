# Implementation Plan

Phased roadmap for building the monitoring system described in `CAPABILITIES.MD` (what),
`WORKFLOW.MD` (how it behaves) and `ADR-001-architecture.md` (what we build it with).

`TASKS.md` breaks these phases into ticket-sized work items. This document is the _why and in
what order_; that one is the queue.

## Principles

1. **Vertical slices, not horizontal layers.** Every phase ends with something you can run and
   watch work. No phase produces only a schema or only an API.
2. **The plugin contract early.** Sensor types are the product's breadth. Once `SensorType` is
   stable (Phase 2), adding sensors is parallelisable, low-risk work — which is why almost
   everything else comes before or immediately after it.
3. **Self-monitoring from Phase 1.** We do not get to claim performance numbers we cannot
   measure.
4. **Standalone install is a Phase 1 deliverable, not a Phase 8 afterthought.** The very first
   milestone installs as a systemd service. Packaging debt compounds worse than code debt.
5. **Correctness of the state machine over breadth of sensors.** Fifteen sensor types with a
   correct two-step failure, dependency and acknowledgement model beat sixty with alert storms.

## Phase overview

| Phase | Theme                     | Exit condition                                                                |
| ----- | ------------------------- | ----------------------------------------------------------------------------- |
| 0     | Foundations               | Repo, CI, dev Compose, `ms-core` and `ms-probe` skeletons start under systemd |
| 1     | Object model + storage    | Tree CRUD with inheritance, hypertables, rollups, retention, audit            |
| 2     | Scheduler + first sensors | Timing wheel dispatches Ping/HTTP/Port/DNS at 5k sensors                      |
| 3     | State machine             | Two-step failure, limits, lookups, pause, dependencies, acknowledgement       |
| 4     | Notifications             | Triggers, latency, escalation, summarisation, email + webhook + Slack         |
| 5     | Web UI                    | Device tree, sensor pages, live graphs, alarms, logs, settings                |
| 6     | Sensor breadth            | SNMP, SSH, WMI, TLS, mail, databases, script, factory — ~40 types             |
| 7     | Discovery + templates     | Sweep, identify, provision; device templates; bulk operations                 |
| 8     | Remote probes             | Outbound mTLS, approval, disk spool, replay, incremental config               |
| 9     | Users + RBAC              | Accounts, groups, per-object rights, API tokens, TOTP, audit UI               |
| 10    | Hardening + release       | Soak tests, installers for Linux and Windows, docs, 1.0                       |

Phases 6 and 7 can overlap once Phase 3 lands. Phase 9 can start any time after Phase 1; it is
placed late only because it is not needed to prove the hard parts work.

---

## Phase 0 — Foundations

**Goal.** A repository that builds, tests, lints and installs, with both processes starting and
talking to each other over a trivial protocol.

**Deliverables**

- TypeScript monorepo: `packages/core`, `packages/probe`, `packages/shared`, `packages/web`.
- `docker-compose.dev.yml`: PostgreSQL + TimescaleDB, MailHog, SNMP simulator, syslog sender.
  **Development only** — production never sees a container.
- systemd units for `ms-core` and `ms-probe`; a WinSW config stub for Windows.
- CI: build, typecheck, lint, unit tests, and a smoke test that installs the tarball on a clean
  Linux VM and confirms both services reach "running".
- `pino` structured logging, config loading (file + env), graceful shutdown.
- Core↔probe transport: mTLS-framed message channel with a heartbeat, nothing else yet.

**Exit criteria**

- `npm run dev` brings up the full dev environment.
- `make package && install.sh` on a clean box yields two running systemd services.
- CI is green and the install smoke test runs on every commit.

**Risks.** Monorepo tooling churn. Keep it boring — npm workspaces and tsc project references.

### Outcome — complete, 2026-08-25

All three exit criteria met. Measured on Node 24.19.0, TimescaleDB 2.29.2, Debian 12.

| Exit criterion | Result |
| --- | --- |
| `npm run dev` brings up the dev environment | PostgreSQL+TimescaleDB, MailHog, SNMP simulator and syslog sender all reach healthy |
| Tarball installs to two running systemd services | `scripts/smoke-install.sh`: both `active`, both stop with `result=success exit=0` |
| CI green, smoke test on every commit | `.github/workflows/ci.yml`: build/lint/format/test, install smoke test, dev-compose check |

Also verified beyond the stated criteria:

- **`sd_notify` works without a native addon.** `Type=notify` with `NotifyAccess=all`, shelling
  out to `systemd-notify`. 75 seconds under `WatchdogSec=30`: zero restarts, zero watchdog
  events. Node cannot write to an `AF_UNIX`/`SOCK_DGRAM` socket, so this was the open question.
- **The transport survives a core restart.** A real probe reconnected after the core was killed,
  with jittered backoff (500 ms, 715 ms, 600 ms, 2076 ms) and no operator action.
- **A fresh install is secure by default.** `install.sh` issues the probe-channel CA and both
  key pairs, generates a 256-bit access key and wires it into both configurations.

Test count at the end of Phase 0: **55** (`node:test`), covering the config loader, the
lifecycle, the frame codec, protocol validation, reconnect backoff and the probe endpoint over
real mutual TLS.

**Deviations from the plan as written**

- **No esbuild bundle** (`F-07`). The tarball ships compiled JavaScript plus a pruned
  production `node_modules`. Bundling buys little while every dependency is pure JavaScript, and
  it actively fights the native addons that arrive with `argon2` and `net-snmp` in later phases.
  Revisit if start-up time or tarball size becomes a real complaint.
- **`packages/web` is a placeholder.** The workspace exists; React and Vite are not dependencies
  yet because nothing consumes them until `U-01` in Phase 5.
- **Timescale licensing — settled 2026-08-25.** `S-06` as originally written built on features
  that are not Apache-2.0. Both paths were spiked and measured
  (`docs/findings/2026-08-25-rollup-storage-spike.md`); we now run with
  `timescaledb.license = timescale` and use native compression, while writing the rollup tiers,
  retention and their scheduler ourselves. See the ADR-001 Decision 4 amendment.

---

## Phase 1 — Object model and storage

**Goal.** The tree exists, is editable through the API, and time-series data flows in and rolls
up correctly.

**Deliverables**

- Schema and migrations: `object` (probe/group/device/sensor with `parent_id`), `sensor_config`,
  `channel`, `credential_set`, `audit_log`.
- **Setting inheritance resolver** — the single most-used piece of logic in the system. Resolve
  any inheritable setting to the nearest ancestor that defines it; support explicit override and
  revert-to-inherit. Table-driven tests over deep trees.
- Hypertables: `sample`, `sensor_state`. Rollup tiers `sample_5m`, `sample_1h`, `sample_1d`,
  written by us rather than as continuous aggregates. Native compression, and retention per
  tier, driven by the core's own housekeeping loop.
- Ingestion pipeline: batched writes, bounded queue, backpressure signal to probes. Refusals,
  duplicates and failures are all counted; a refused batch stays in the probe's spool rather
  than being dropped.
- Historic-data query API with automatic rollup selection, reproducing PRTG's rules: reject
  ranges over 500 days (shorten to 365), force ≥60-minute averaging on 40–500 day ranges. Every
  adjustment the rules make is reported back with the answer rather than applied silently.
- Gap semantics: no-data is distinct from zero, in storage, in queries and in the wire format.
- Audit log on every create/update/delete with a diff, written inside the mutation's own
  transaction and surviving the deletion of what it describes.

**Exit criteria**

- Create a 5,000-object tree via the API in under 30 seconds.
- Ingest 100,000 samples/minute sustained with p99 write latency under 100 ms.
- Rollups verified against hand-computed expectations, including across gaps.
- Retention policies demonstrably drop expired data.

**Risks.** TimescaleDB on Windows (ADR open question 1) — resolve in this phase. All
time-series access sits behind a repository interface so a plain-Postgres fallback is contained;
S-12 has since audited exactly what that fallback would owe — four methods and a second migration
list — and verified that `date_bin` reproduces `time_bucket` exactly
(`docs/findings/2026-08-25-storage-engine-boundary.md`).

### Progress

| Task | State | Notes |
| --- | --- | --- |
| S-01 migration tooling | done | Checksum drift detection, advisory lock, `ms-core migrate up/down/status`, `database.autoMigrate` |
| S-02 object model | done | Hierarchy, cycle prevention and cascade enforced in the database, not only the API |
| S-03 tree CRUD API | done | 17 routes, keyset pagination, ETag/If-Match, counted delete, set-based clone |
| S-04 inheritance resolver | done | One recursive CTE; batch resolution for a whole page; source reported for every value |
| S-05 sample and state hypertables | done | One-day and seven-day chunks; no foreign key to `channel`; a gap is the absence of a row |
| S-06 rollups, compression, retention | done | Three tiers carrying sum and count, a backfill queue for late data, watermark-guarded compression and retention, orphan reaping |
| S-07 ingestion pipeline | done | Bounded queue, batched idempotent writes, gradual backpressure on the wire, channel resolution with a warm cache; protocol version 2 |
| S-08 historic query API | done | PRTG's range and averaging rules as a pure function; a range split across however many sources hold it, so the answer does not depend on the rollup's progress |
| S-10 audit log | done | Every mutation with actor, timestamp and diff, written in the change's own transaction and outliving the object it describes |
| S-12 time-series interface | done | `TimeSeriesStore` over a four-method `StorageEngine`; the boundary is enforced by a source scan and the seam exercised by a second engine |
| S-14 sibling ordering | done | Manual arrangement within a parent, honoured by the tree and by `sort=manual`, falling back to name where nobody has arranged anything |
| S-13 conditional GET | done | ETags that cover the inheritance chain, so the common UI read is conditional again |
| S-09, S-11 | not started | S-09 is mostly delivered by S-05 through S-08; what is left is the UI side |

All four exit criteria are met and measured:

- **Create a 5,000-object tree via the API in under 30 seconds** — measured at **21.0 seconds**
  over real HTTP with a serial client, and **5.9 seconds** with eight requests in flight. `S-16`
  took the serial path from 24.0 s by narrowing what a create reads about its parent. The
  statement-level breakdown showed the request layer costs more than all the SQL, so the lever
  that remains is fewer requests rather than fewer statements.
- **Ingest 100,000 samples/minute, p99 write under 100 ms** — measured at **3,621,280
  samples/minute with a p99 write of 22.1 ms**, and 2.5M/minute through the full wire path
  including channel resolution.
- **Rollups verified against hand-computed expectations, including across gaps** — in
  `packages/core/test/rollup.test.ts`, which also proves the cascade is weighted by readings
  rather than by bucket.
- **Retention demonstrably drops expired data** — same file, including the guards that stop it
  dropping anything the rollup has not consumed.

Rolling up a five-minute bucket for all 15,000 channels of the v1 target takes **155 ms of its
300,000 ms period**, and compression at the production chunk shape is **10.1x**.

Measurements are recorded in `docs/findings/2026-08-25-tree-api-measurements.md`,
`docs/findings/2026-08-25-timeseries-sizing.md`,
`docs/findings/2026-08-25-rollup-storage-spike.md`,
`docs/findings/2026-08-25-rollup-measurements.md`,
`docs/findings/2026-08-25-ingestion-measurements.md`,
`docs/findings/2026-08-25-historic-query-measurements.md`,
`docs/findings/2026-08-25-storage-engine-boundary.md` and
`docs/findings/2026-08-25-tree-build-measurement.md`.

**Two schema gaps S-02 shipped with, closed by S-03's migration 002:**

- A device had nowhere to store its address, though `CAPABILITIES.MD` §1 defines a device as
  "an IP address or DNS name + credentials" and `WORKFLOW.MD` §2 requires discovery to match on
  it. `device_config` now holds `host` and `ip_version`.
- Scan interval, timeout and retry policy were columns on `sensor_config`. They are inheritable
  — a group setting the interval for everything beneath it is the normal case — so they moved
  into `object_setting`, where the resolver can see them. Columns on a sensor-only table could
  not express the inheritance the specification requires.

---

## Phase 2 — Scheduler and first sensor types

**Goal.** Prove the hard performance claim before building anything on top of it.

**Deliverables**

- Hashed timing wheel, 1-second resolution, driven by monotonic time, with phase-spreading by
  `hash(sensorId)`.
- Bounded worker pool; child-process runner for shell-outs; per-check timeout and cancellation
  via `AbortSignal`.
- Backpressure: skip-if-still-running, deferred-check counter, scheduler lag histogram.
- `SensorType` plugin contract and the registry (ADR decision 7).
- First four sensor types: **Ping, HTTP, Port, DNS**.
- ICMP decision resolved with measurements: system-binary vs raw socket, at 1,000 targets.
- Core Health and Probe Health sensors, plus the `prom-client` metrics behind them.
- The **protocol simulator harness**: mock SNMP agents, a scriptable-latency HTTP server, an SSH
  server, a syslog sender. This is a deliverable, not a test fixture.

**Exit criteria**

- **5,000 sensors at 60 s on 8 cores, p95 dispatch jitter < 1 s, sustained for 1 hour.**
- A deliberately hung check does not delay any other check or the API.
- Killing a worker mid-check loses exactly one result and recycles cleanly.

**Risks.** This phase decides whether the architecture is right. If the timing wheel or the
worker pool cannot hit the target, we change course here — not in Phase 8.

### Progress

| Task | State | Notes |
| --- | --- | --- |
| P-01 hashed timing wheel | done | Monotonic-driven, phase-spread, coalescing catch-up; injected clock so dispatch is asserted rather than timed |
| P-02 worker pool runner | done | Bounded pool, timeout that reports on time, cooperative abort with a terminate backstop, crash recycling, skip-if-still-running |
| P-05 `SensorType` contract and registry | done | New `@ms/sensors` package; schema validation with defaults, declared channels with a primary, `writeOnly` redaction at one boundary, `GET /sensor-types`, guide in `docs/adding-a-sensor-type.md` |
| P-08 ping sensor | done | System `ping` spawned directly for `AbortSignal` support; pure parser with Linux/BSD/Windows fixtures; `rtt` and `loss` channels |
| P-16 toolchain `ping` | done | `dev/toolchain/Dockerfile`; the base image had no `ping`, so the default ICMP path could not be tested |
| P-15 5,000-sensor benchmark | done | **Go.** One sustained hour: 300,095 checks dispatched, 300,095 completed, 0 refused, p95 dispatch jitter 216 ms against the 1,000 ms budget. It also found the shipped pool default wrong by a factor of sixteen (`docs/findings/2026-08-26-scheduler-benchmark.md`) |
| P-03, P-04, P-06, P-07, P-09…P-14 | not started | |

Two of the four exit criteria are covered by tests already: **a deliberately hung check does not
delay any other check**, and **killing a worker mid-check loses exactly one result and recycles
cleanly** — both in `packages/probe/test/check-pool.test.ts`.

The scheduler half of the throughput criterion is measured: **5,000 sensors over a simulated hour is
300,000 dispatches in 90 ms, with every sensor firing exactly 60 times and a worst gap of exactly
60 seconds** (`docs/findings/2026-08-25-timing-wheel-measurements.md`). Dispatch jitter is not
±1 s but zero — the wheel dispatches on integer ticks — so the exit criterion's 1-second budget
is entirely available to the worker pool and the tick's own lateness, measured at a p95 under
250 ms against the real timer.

**P-15 has now measured the other half, and the architecture gate is closed: go.** Five thousand
sensors at 60 s for one hour on eight cores dispatched 300,095 checks and completed all 300,095,
refusing none, at a p95 dispatch jitter of **216 ms** against the 1,000 ms budget — of which the
wheel itself contributed 11 ms and waiting for a worker slot the other 209 ms. The p99 landed
9 ms above the p95, which is what a distribution with no tail looks like: nothing leaked, drifted
or degraded over the hour.

What the benchmark changed was the pool, not the wheel. The shipped default was
`availableParallelism() - 1` — a CPU-shaped number for work that is almost entirely waiting —
and against this load it refused 21% of checks and delayed the rest by a p95 of 15.8 seconds. The
governing quantity turned out to be the *dispatch batch*: the wheel hands over a whole second's
worth at once, so the queue drains in tranches of `ceil(batch / slots)`. The default is now a
flat 48, chosen from a measured sweep and recorded in
`docs/findings/2026-08-26-scheduler-benchmark.md`.

P-05 landed the plugin contract, which is what the rest of the phase is built from, and P-08 put
the first type in it. Sensors can now be created and the check runs correctly against a real
target — but nothing schedules one: `R-04` is what tells a probe which sensors it owns, so the
wheel still has nothing to dispatch. It also closed the last
credential surface from Phase 1: parameters marked `writeOnly` are stripped from every read at a
single boundary, which is the one thing S-03 could not do without knowing what a parameter meant.

---

## Phase 3 — Sensor state machine

**Goal.** Behaviour correctness. This is what separates a monitoring product from a cron job
with graphs.

**Deliverables**

- The six v1 states and every transition between them in `WORKFLOW.MD §4`. **Unusual** and
  **Down (Partial)** stay `[V2]` — the state type must accommodate them, the logic need not.
- Two-step failure with the per-sensor retry policy (`immediate down` … `warn N intervals then
down`); default is one warning interval.
- Channel limits: upper/lower error and warning, custom limit messages, immediate effect.
- Multi-channel rollup: sensor state is the worst channel state combined with the query state.
- Lookups: definition format, `SingleInt` and `Range` types, `undefinedState`, custom overriding
  built-in by matching id.
- Spike filter and scaling factors.
- Pause: manual (indefinite / presets / until-datetime, with a message), by schedule, by
  dependency, by parent cascade — evaluated in that precedence order. Persists across restart.
- Schedules: weekly grid **and** period-list authoring; suppress monitoring, notifications and
  reports.
- Maintenance windows with start/end datetimes.
- Dependencies: _use parent_, _select object_, _master object for parent device_; recursive
  cascade; master keeps running while dependents are paused; delay-after-recovery.
- Acknowledgement: state, until-options, message, expiry back to Down, cleared by resume,
  grantable to read-only users.
- Simulated error state for testing chains.
- Full state-change log with cause attribution.

**Exit criteria**

- A property-based test suite over the state machine passes: no sequence of events reaches an
  undefined state. **Met** (`M-16`): `state-machine-properties.test.ts` folds generated event
  sequences — results, pauses, acknowledgements, simulated errors, probe loss — and checks §5's
  invariants after every step. It found two live defects in the acknowledgement layer and four
  transitions `M-01`'s tables did not describe.
- Scenario tests: unplugging a simulated switch produces **one** dependency-suppressed alarm,
  not forty. **Met** (`M-17`): with forty sensors behind the switch, one ends Down and forty end
  Paused by dependency, the probe drops to a single check, and only one Down has no successor.
  The forty transient Downs the same batch produces are superseded within one millisecond, in
  the transaction that recorded them.
- Paused states survive a core restart. **Met** (`M-08`): the flags are on `sensor_runtime`,
  derived from `object_pause` on write, and `pause.test.ts` rebuilds the service against the same
  database to prove nothing was held in memory.

**Risks.** Precedence bugs between the four pause sources. Write the precedence table first,
test it exhaustively.

### Progress

| Task | State | Notes |
| --- | --- | --- |
| M-01 state and pause precedence tables | done | `docs/state-machine.md` plus `packages/core/src/state/tables.ts`; all sixteen pause combinations written out and computed, and asserted to agree |
| M-02 core state machine | done | `packages/core/src/state/`; migration 008 adds `sensor_runtime`. Decisions ride in the readings' own transaction, so a state change and the readings that caused it commit together. Measured cost **8.3% of ingestion throughput** — 2.53M samples/min against 2.76M without, p99 write 38.8 ms against a 100 ms budget |
| M-03 two-step failure and retry policy | done | `scan.retryWarnings` was already declared and inheritable; `SensorStateService` now resolves it per sensor. Settles that N counts scans, and that a policy change applies at the next scan |
| M-04 channel limits | done | `packages/core/src/state/limits.ts`; no migration — migration 001 had already provisioned `channel.limits`. Immediate in both senses: Down on the first sample past an error limit, and an edited limit acts on the next scan, because `ResultCacheInvalidator` rides the audit sink |
| M-05 multi-channel rollup | done | Absorbed by `M-04`: `rollUp` takes the worst channel, §2.3 in `evaluate` combines it with the query state. A result carries every channel at once, so there was no second place for it |
| M-06 lookups | done | `packages/core/src/lookups/`; migration 009 adds `channel.lookup_id`. JSON rather than PRTG's `.ovl` XML, built-ins as TypeScript modules, operator definitions under `<dataDir>/lookups` overriding by id. A channel is judged by a lookup **or** its limits, never both |
| M-07 scaling and spike filter | done | `packages/core/src/ingestion/scaling.ts`; no migration — the columns have been on `channel` since 001. Scale before filter, store the scaled value, and a discarded reading is a gap that decides nothing |
| M-08 manual pause | done | Migration 010 adds `object_pause`; the per-sensor flags are derived from it on pause, resume, move and create. Any object can be paused, so the parent cascade lands here rather than in `M-12`. A paused sensor leaves its probe's configuration entirely, and a timed pause is computed from the clock and swept every 30 s |
| M-09 schedules | done | Migration 011 adds `schedule`; the assignment is an ordinary inheritable setting, so one resolver serves it. Both authoring modes normalise to one canonical form, each schedule carries a time zone, and the sweep runs on the wall-clock minute rather than on a computed deadline |
| M-10 maintenance windows | done | Migration 012 adds `object_pause.starts_at`. A window is a pause that has not started yet — one column, not a fifth source — and cancelling one before it begins is the same resume that ends one in progress |
| M-11 dependencies | done | Migration 013 adds `sensor_runtime.dependency_clear_at`. Driven by state changes, inside the ingestor's own transaction; the cascade is a bounded fixpoint; a loop is refused where it is made, because a loop of masters can never recover. The master keeps scanning by the one rule that it is excluded from its own dependency |
| M-12 pause precedence integration | done | All sixteen combinations against a real tree, arranged through the mechanism that really sets each flag. Clearing the sources one at a time walks the reported cause down `parent → dependency → schedule → user` with the sensor Paused at every step |
| M-13 acknowledgement | done | Migration 014 records who. Works on a sensor or on everything Down beneath a container. Found that `M-02` cleared acknowledgements only in the cache, so a restart brought a silenced alarm back silenced |
| M-14 simulated error | done | No migration — `M-02` left the column and the layer. Loud rather than expiring, and a forced sensor keeps being scanned, so lifting the force returns it to the truth with no scan in between |
| M-15 state-change log | done | `GET /state-log`, scoped to a branch or a sensor. Duration is measured against the real next transition rather than the next one on the page |
| M-16 property-based state machine tests | done | `fast-check` over event *sequences*. Found two live defects in the acknowledgement layer and four transitions `M-01`'s tables did not describe |
| M-17 alarm-storm scenario | done | One Down, forty Paused, one check left on the probe. Found that the dependency's pause collided with the Down that caused it and was silently dropped, leaving history and runtime disagreeing about a sensor uptime is computed from |

**Where Phase 3's exit criteria stand after `M-02`.**

- *No sequence of events reaches an undefined state* — the whole input space is enumerated in
  `state-machine.test.ts`: 16 pause combinations × simulated × probe × acknowledged × 5 scan
  facts × 4 channel verdicts, asserting exactly one v1 state, a cause on every one, and each
  invariant of `state-machine.md` §5. `M-16` has since added the property test over event
  *sequences*, which is where the fold's history-dependent rules live and where two live
  acknowledgement defects turned up.
- *Paused states survive a core restart* — **met** for manual pause: the deadline and the reason
  are rows, not timers, and a new process reads them back with nothing in memory. Tested in
  `pause.test.ts`.
- *One dependency-suppressed alarm, not forty* — untouched; `M-11` and `M-17`.

`M-03`, `M-04`, `M-06` and `M-07` close five of the deliverables above: "two-step failure with the
per-sensor retry policy", "channel limits", "multi-channel rollup", "lookups", and "spike
filter and scaling factors". What is left in Phase 3 is the whole pause block (`M-08`…`M-12`)
and acknowledgement onward (`M-13`…`M-17`).

The tables are the specification `M-02` implements against, which is the order this phase's risk
demands: precedence is a *set* of independent sources, not a priority chain, and the sixteen-row
table is exhaustive rather than representative.

---

## Phase 4 — Notifications

**Goal.** Alarms leave the building, correctly, without flooding anyone.

**Deliverables**

- Trigger engine with object-level triggers and inheritance; a sensor's effective trigger set
  shows the source object for each.
- **State trigger**: initial latency, initial notification, escalation latency, escalation
  notification, repeat interval, recovery notification.
- **Threshold trigger**: channel, condition, value, latency, trigger and clear notifications.
- Latency timers that cancel on recovery and on acknowledgement.
- Notification templates with placeholder substitution (`%sensor`, `%device`, `%status`,
  `%lastmessage`, `%lastvalue`, `%since`, `%linksensor`, `%priority`, …).
- Delivery: **email (SMTP with relay, auth, TLS, fallback relay), HTTP action/webhook, Slack,
  Teams, execute program**.
- Summarisation with all six modes; default _first down and up immediately, then summarise_;
  digest caps with overflow splitting; Slack/Teams/webhook/script never summarised.
- Template activation schedules with queue-or-discard for suppressed notifications.
- Delivery retry with backoff; failures logged and surfaced on Core Health.
- Send-test-notification action.

**Exit criteria**

- A 200-sensor simulated outage produces one immediate message plus digests — verified against
  MailHog and a webhook sink.
- A 30-second blip under a 5-minute latency produces nothing.
- Acknowledging cancels pending escalations; recovery notification still fires.

All three exit criteria are met and measured, in
`packages/core/test/notification-scenario.test.ts` against a real MailHog and a real HTTP sink:

- **A 200-sensor outage becomes 9 emails** — one immediate message for the first Down, then the
  remaining 199 as **8 digests** of 25, 25, 25, 25, 25, 25, 25 and 24. Every one is numbered
  "(n of 8)", because a digest that says "25 notifications" with no idea how many are missing is
  a digest nobody can trust. The same outage produces **200 webhook posts**, which is correct
  rather than a failure: `CAPABILITIES.MD §5.2` never summarises a machine-consumed channel, and
  that is the trade-off an operator makes when they choose one.
- **A 30-second blip under a 5-minute latency produces nothing at all** — no message, no queued
  request, and the armed chain is stood down rather than left waiting. The recovery is silent
  too: a chain that never fired has nothing to recover from.
- **Acknowledging cancels the escalation and the recovery still fires** — in
  `packages/core/test/notification-engine.test.ts`, which drives the two halves together because
  they pull in opposite directions and getting one right by breaking the other is the bug.

`M-17` measured the other half of *one outage, one alarm*: where a dependency **is** modelled, a
switch failure in front of forty sensors produces one Down and forty Paused, so summarisation
never sees the storm at all. The two mechanisms are complementary — dependencies collapse what is
causally one outage, summarisation collapses what is merely simultaneous.

---

## Phase 5 — Web UI

**Goal.** The product becomes usable by someone who has not read the API docs.

**Deliverables**

- React + Vite app served by the core as static assets.
- **Device tree** with rollup status colouring, live-updating over WebSocket (not polling).
- **Sensor detail page**: live graph, channel table, historic tabs (2 days / 30 days / 365 days),
  log, settings, notification triggers.
- **Alarms view**: filterable by severity, scoped globally or per branch, sorted by priority
  then duration; acknowledge, pause and resume from the list.
- **Logs view** with the PRTG category structure (status changes, system events, object history).
- Settings forms generated from each sensor type's `paramsSchema` — new sensor types need no
  frontend work.
- Inheritance-aware settings controls: every inheritable field shows its inherited value and an
  override toggle.
- Charts per the `dataviz` guidance; light and dark themes; keyboard-navigable; WCAG AA contrast.

**Exit criteria**

- A new user can add a device, add three sensors, set a threshold and receive an email without
  touching the API.
- The tree stays responsive with 5,000 sensors and updates within a second of a state change.

### Progress

| Task | State | Notes |
| --- | --- | --- |
| U-01 frontend scaffold | done | React 19 + Vite 8 + Tailwind 4 + React Router 7; CSS-custom-property tokens shared with the canvas charts to come; light and dark themes; served by the core from `api.webRoot` |
| U-02 WebSocket state stream | done | `GET /api/v1/stream`, subscribe by subtree, snapshot then changes; published from `writeStateHistory` through a new `Queryable.afterCommit`, so nothing provisional reaches a screen. Resync is "subscribe again"; a subscriber that falls behind is cut off and counted rather than quietly trimmed. The tree is live and polls nothing |
| U-03 device tree | done | Shape fetched a level at a time and cached, states streamed, rollup computed from the stream alone — so a collapsed branch shows the colour of an outage inside it without its children ever being loaded. Virtualised; measured at **5,200 rows flattened and 5,000 states rolled up in 4.4 ms**, the shape the exit criteria name. Search and tag filtering are server-side and inheritance-aware |
| U-04 sensor detail page | done | Six URL-addressable tabs over one page that also serves devices and groups. Needed one new endpoint, `GET /sensors/{id}/values`: a reading older than three scan intervals is **withheld** rather than shown as current, so a sensor that stopped reporting shows nothing while a genuine zero still shows 0. State is streamed and readings are polled — the only polling in the app, for the one thing a stream is the wrong shape for |
| U-05 time-series charts | done | uPlot panels, one chart per unit — the dual-axis trap is designed out rather than resisted. Eight categorical slots run through the `dataviz` validator against our own surfaces (light CVD ΔE 9.1 / normal 19.6; dark 8.4 / 19.3, all gates pass); status colours stay reserved. `spanGaps` false and no null-to-number path anywhere, so a gap is a break in the line; canvas is `aria-hidden` behind a caption and a table view |
| U-06…U-11 | not started | |

Pulled forward out of order, on request, and it reads honestly: with no state machine and no
sensor types, every sensor shows Unknown and each empty panel names the task that fills it. The
exit criteria are untouched — neither can be met before Phase 3 and `P-08`.

---

## Phase 6 — Sensor breadth

**Goal.** Reach ~40 sensor types — the v1 catalogue in `CAPABILITIES.MD §3`.

**Deliverables, grouped by workstream** (parallelisable once the contract is stable):

- **SNMP**: v1/v2c/v3; Traffic (with 32/64-bit counter wrap handling), Custom, Custom String,
  Custom Table, CPU, Memory, Disk Free, Uptime; Trap Receiver.
- **SSH**: Script, Disk Free, Load Average, Meminfo.
- **Windows**: CPU Load, Memory, Volume, Service — via PowerShell/WinRM from a Windows probe.
- **TLS**: Certificate (expiry, chain, hostname), Security Check (protocols and ciphers).
- **Web**: HTTP Advanced, HTTP Content, HTTP Transaction, REST Custom with JSONPath/XPath.
- **Mail**: SMTP, POP3, IMAP, SMTP&IMAP Round Trip.
- **Databases**: PostgreSQL, MySQL, MSSQL — connect, query, time and value channels.
- **Script**: EXE/Script and EXE/Script Advanced with a documented output format, sandboxed.
- **Syslog Receiver** (in-house RFC 3164/5424 parser, filter rules, count channels).
- **Sensor Factory**: formula language over other sensors' channels.
- Ping Jitter, Port Range.

**Exit criteria**

- Every type has unit tests against the simulator harness and a documented parameter schema.
- Adding a new sensor type is demonstrably a one-file, half-day job.

---

## Phase 7 — Auto-discovery and templates

**Deliverables**

- Three-stage discovery: sweep, identify (SNMP sysObjectID/sysDescr, WMI, SSH banner, open
  ports, reverse DNS), provision.
- Discovery levels from ping-only to detailed.
- **Idempotent** re-runs — match on IP/DNS within the target group, add only what is missing.
- Resumable, cancellable, rate-limited so discovery never starves live checks.
- Device templates: built-in set, plus save-this-device-as-a-template.
- Scheduled rediscovery (off by default), with optional auto-creation of new devices.
- Bulk operations: multi-select edit, clone, move, delete.
- Discovery run summary: scanned, found, created, errors.

**Exit criteria**

- Discovering a /24 with mixed Linux, Windows and SNMP devices produces correct sensor sets and
  sets each device's Ping sensor as its master dependency.
- Re-running creates zero duplicates.

---

## Phase 8 — Remote probes

**Deliverables**

- Probe registration: GID, access keys, source-IP allowlist, per-GID revocation, pending-approval
  queue with an administrator action.
- Outbound-only mTLS from probe to core.
- **Disk-backed spool** with a bounded size, oldest-first eviction and a dropped-results counter
  — better than PRTG's RAM-only 500k-result buffer.
- Ordered replay on reconnect, rate-limited so a backlogged probe cannot stall ingestion.
- Incremental configuration push: each probe holds only its own subtree.
- Probe Health: connection state, lag, spool depth, version skew.
- A probe going offline produces **one** alarm; its sensors go Unknown, not Down.
- Probe installer for Linux and Windows.

**Exit criteria**

- A probe disconnected for one hour reconnects and replays with no data loss and no ingestion
  stall.
- Version skew between core and probe is detected and reported rather than silently
  misbehaving.

### Progress

| Task | State | Notes |
| --- | --- | --- |
| R-02 disk-backed result spool | done | Segmented NDJSON, bounded and evicting oldest-first with a counter, torn tails healed on open; the drain clears nothing until the core confirms |
| R-04 incremental config push | done | Protocol 3; content-addressed fingerprint on the handshake, deltas within a session, snapshot or `config-unchanged` after a disconnect; change detection rides the audit sink |
| R-03 ordered replay on reconnect | done | Probes report their backlog; catch-up is paced by how many are replaying at once and live batches are never paced; larger batches once behind |
| R-01, R-05…R-08 | not started | R-04 added the storage half of R-01: `probe_config.gid`, one branch per probe |

Pulled forward out of order, on request, and it closed the loop the previous phases had left
open: with `P-08` providing a sensor type and `R-04` telling a probe which sensors it owns, the
system scans a real target on a schedule for the first time — and with `R-02` it keeps them:
results go to disk before anything else touches them and reach the database whether or not the
core was up when the check ran.

**Measured against the PRTG comparison the task exists for.** The core was killed, the probe kept
scanning for 100 seconds, and the whole process was then restarted: 12 results came back off disk,
replayed as one batch, and the per-minute sample timeline has no gap across the outage. PRTG
buffers in RAM and loses that.

`R-03` then made catch-up fair. The queue's own `retryAfterMs` is one global signal and slows
every probe alike; a probe now reports how far behind it is, and only probes with a backlog are
paced — so a reconnecting fleet cannot queue everyone else's live results behind it.

What the system still cannot do is turn readings into *states* — Up, Warning, Down — which is
Phase 3.

---

## Phase 9 — Users, RBAC and security

**Deliverables**

- Accounts (read/write and read-only), user groups, one primary group per user.
- Per-object access rights: none / read / write / full, inherited up the tree, explicit beats
  inherited, highest across groups wins.
- Read-only restrictions enforced at account level: no admin groups, no stored credentials,
  optional acknowledge permission.
- Credential sets inherited from group/device; encrypted at rest; **write-only through the API**.
- API tokens per user; session auth for the UI; argon2 password hashing; TOTP MFA.
- Audit log UI with per-object history and diffs.
- Security pass: rate limiting, CSRF, security headers, dependency audit, SSRF guards on
  user-supplied URLs, sandboxing for script sensors.

**Exit criteria**

- An access-control test matrix passes for every combination of role, group and tree position.
- A read-only user cannot retrieve any credential by any route, including historic-data and
  export endpoints.

---

## Phase 10 — Hardening and release

**Deliverables**

- 24-hour soak at 5,000 sensors: no memory growth, no lag drift, correct rollups throughout.
- Failure-mode verification against the table in `WORKFLOW.MD §13` — every row tested.
- Upgrade path: schema migration with rollback, config backup, version-skew handling.
- Backup and restore procedure, documented and tested.
- Installers: Linux tarball with an install script plus `.deb`/`.rpm`; Windows MSI with WinSW.
- Documentation: installation, administration, sensor reference, API reference (from OpenAPI),
  troubleshooting runbook.
- Sizing guidance published from measured numbers, not guesses.

**Exit criteria**

- A clean install on Ubuntu and on Windows Server, monitoring 100 real devices for a week
  without intervention.

---

## What we are explicitly not building in v1

Restating from `CAPABILITIES.MD §15`, because scope creep in a PRTG clone is the obvious failure
mode: no packet sniffing, no 250-sensor catalogue, no clustering, no maps/dashboard designer, no
reporting engine, no ticket system, no libraries, no native mobile or desktop apps, no
vendor-specific SNMP sensor types (device templates cover them generically).

Flow monitoring (NetFlow/sFlow/IPFIX), maps, reports, libraries, tickets, clustering and
LDAP/OIDC are the strongest **v2** candidates, roughly in that order.

## Sequencing notes for whoever picks this up

- Phase 2 is the go/no-go gate on the architecture. Do not let it slip past a working
  measurement.
- Phase 3 is where most of the subtle bugs live. Budget more time than it looks like it needs.
- Phase 6 is the only phase that parallelises cleanly across several workers. Everything before
  it is mostly sequential.
- Keep `CAPABILITIES.MD` updated as scope markers move between `[V1]`, `[V2]` and `[OUT]`. It is
  the scope contract.

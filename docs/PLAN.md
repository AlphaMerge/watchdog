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
| P-03 child-process runner | done | `ProcessRunner` beside `CheckPool`, same submit/callback contract, one spool sink. **The justification is narrower than "if a check can hang"**: a worker is terminable and has its own heap limit, so hanging and leaking are survivable there — a *hard crash* is not, and a segfault in a native module takes the whole probe down. That, and running as a different OS user, is what a thread cannot offer. One process per check rather than a pool, because not amortising is the feature: nothing survives from one check to the next. Measured at ~21 ms of start-up, the whole catalogue costing 1.3 ms more than a one-file registry — the rule about heavy imports living inside `execute`, showing up as a number (`docs/findings/2026-08-27-process-runner-startup.md`) |
| P-04, P-06, P-07, P-09…P-14 | not started | |

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
| U-06 alarms view | done | `GET /alarms` on the partial index migration 008 created for it, walking ancestry *up* from the alarms rather than down from the root. Paused and Unknown are deliberately not alarms. Severity chips count what the filter hides; the list is the server's answer and the stream only prompts a debounced refetch. Inline acknowledge/pause. Found an `M-14` defect on the way: a scan overwrote the operator's message on a forced sensor |
| U-07 logs view | done | The three `CAPABILITIES.MD §6` categories as three tabs over three endpoints, plus a new global `GET /audit`. Keyset paging throughout — load-more appends, a filter change discards; verified on 200 rows across a page boundary. Audit scoping is one object exactly, never a subtree, so a deletion's own entry cannot be walked past |
| U-08 schema-driven forms | done | A form built from `paramsSchema`, wired into editing a sensor and into a new add-sensor flow. Found the defect that made it possible at all: `params` is replaced on update and a read never returns a credential, so any read-modify-write deleted every secret silently — `carryWriteOnly` is the mirror of redaction and sits beside it. A field the controls cannot draw becomes a JSON box rather than nothing, for the same reason |
| U-09 inheritance-aware controls | done | Override toggle per setting, reusing `U-08`'s controls. Needed `SettingView.inherited` — the setting resolved *at the parent* — because a view carrying only the effective value could show what reverting does only by doing it. Overridden-to-the-same-value stays a distinct state: the toggle reads `own`, never a comparison, so a deliberate pin does not silently become a follower |
| U-10 notification configuration UI | done | Template editor and trigger editor, both generated from schemas the core already publishes — the third and fourth use of `U-08`'s generator. Needed `POST /templates/preview`, because a live preview of the *stored* template shows the old subject line while the operator types a new one; the draft runs through the same parse every write uses, so an unsaveable draft is refused rather than half-rendered. Inherited triggers are read-only with their source and the note that they fire as well as the local ones. `seedDefaults` replaced three copies of a top-level-only seeding loop that silently dropped nested defaults |
| U-11 accessibility and responsive pass | done | Measured in the browser across nine routes and both themes, not asserted. Three real defects, each systemic rather than local: `role="tree"` with no arrow keys at all — now the ARIA pattern with a roving tab stop, which takes the tree from ~15,000 tab stops at the 5,000-sensor target to one; `--ms-border` at 1.23:1 under every input, against 1.4.11's 3:1, so control edges moved to a second grey clearing 3:1 on all six surfaces; and 41 controls whose `focus:outline-none focus-visible:ring-2` left them with **no** focus indicator under forced colors, since a ring is a box-shadow. Also: per-route document titles and focus-on-navigation (2.4.2), reflow at 320px, and a 24px floor on control height |

Pulled forward out of order, on request. It began reading honestly rather than well: with no
state machine and no sensor types, every sensor showed Unknown and each empty panel named the
task that would fill it. Phase 3 and `P-08` have since landed underneath it, so the panels carry
real data and every task in the phase is done.

**Exit criteria.** The second is measured: `5,200 rows flattened and 5,000 states rolled up in
4.4 ms` (`U-03`, re-measured every run by `tree-model.test.ts`), against a budget of a second,
and the tree is pushed rather than polled so a state change arrives in one WebSocket frame. The
first — a new user adding a device, three sensors and a threshold and receiving an email without
touching the API — now has every piece it needs on screen (`U-08` adds sensors, `U-09` sets
inheritable settings, `U-10` writes the template and the trigger), and each has been driven end
to end in the browser on its own ticket. **It has not been walked start to finish as one
sitting**, and until it has, treat the criterion as unproven rather than met.

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

### Progress

| Task | State | Notes |
| --- | --- | --- |
| T-01 SNMP session layer | done | Credentials, OIDs, session and pool under `packages/sensors/src/support/snmp/`. `net-snmp` is **isolated rather than vendored** — one importing file and an ~80-line declaration bounding the replacement cost — and it turns out to need no native code at all, which corrects Decision 10 (ADR-001 amended). Credentials are an argument to the layer, not something it reads from `params`, so `A-05` is a change of caller; until `A-05` lands a community string is per-sensor, which is the scheduling risk `A-05`'s own note predicted. A walk fails rather than spins on a non-increasing OID and fails rather than truncates at its bound; `Counter64` stays `bigint` for `T-02`; abort cancels the request, never the shared session. Tested over a real socket against a hand-written misbehaving agent (the SNMP half of `P-06`, early) plus `net-snmp`'s own agent for a genuine v3 authPriv conversation |
| A-05 credential vault | done, pulled forward from Phase 9 | Its stated dependency `A-03` needs accounts, which do not exist — but that dependency is *who may write* a credential, and everything here is already write-only to everyone. Forced by `T-01`, exactly as this ticket's own scheduling note predicted. A key file rather than the OS keystore (libsecret needs a session D-Bus a systemd service has no; DPAPI needs a native addon), generated at first start, 0600, and refused if the mode widens. AES-256-GCM with object id and kind in the **associated data**, so a `secret` cell copied between rows fails to authenticate — an attack that otherwise needs no key. The probe config fingerprint hashes a rotation *stamp*, never the credential: a community string is low-entropy enough that a published digest is recovered by guessing. Secrets reach only the probe that owns the sensor, only for kinds the sensor *type* declared, over mutual TLS, and are never written to the probe's disk |
| T-02 SNMP Traffic sensor | done | Most of the work is in the *core*: a counter becomes a rate in `ingestion/counters.ts` against a baseline in `channel_counter`, because a check runs in whichever worker is free and every probe restart would otherwise lose the baseline for every interface on the box. A 64-bit counter going backwards is a **reset**, never a wrap — 46 years to go round at 100 Gbit/s — while a 32-bit one wraps every 34 seconds of gigabit and correcting for it is the whole job. The width travels on the *reading*, since `auto` falls back per device and a 32-bit wrap read as 64-bit looks exactly like a reboot. Counters cross the wire as decimal text: `ifHCInOctets` passes 2^53 in nine days. Interface selection is by index or by name; the add-time *picker* needs `R-09` |
| T-03 SNMP Custom + Custom String | done | Two types plus `support/snmp/check.ts`, the preamble all four SNMP types share. `snmp.custom` reuses `T-02`'s counter path and *asks* gauge-or-counter rather than guessing from the varbind type, which is wrong in both directions; the device is consulted to check the answer and a mismatch goes in the message. The regex in `snmp.custom.string` is the sharp edge: measured, `(a+)+$` against forty characters takes **86 seconds** and nothing in JavaScript can interrupt it, so the match runs in a `node:vm` context with V8's watchdog — measured at 0.19 µs direct against 99.7 µs sandboxed, irrelevant beside a UDP round trip. A mistyped pattern now fails one check in 250 ms instead of holding a worker until the pool kills it |
| T-04 SNMP Custom Table | done | One sensor is one row and its channels are the columns — the ticket's other layout, channels-per-row, is the one the channel model cannot carry: `channels(params)` is declared before a sensor runs, which is what lets a channel be created with a primary, a lookup and a counter width, and rows are only knowable from the device. The row is resolved by matching a naming column on **every scan**, because a table index is an integer an agent reassigns — the dev target's own `hrStorageTable` is indexed 1, 3, 6, 7, 8, 10, 11, 33… — and an index-pinned sensor silently watches a different volume afterwards; an index is still accepted, and given with a value becomes a hint checked first so an unchanged table costs one request rather than a walk. Reuses `T-02`'s counter path, `M-06`'s lookups and `T-03`'s sandboxed matcher, the last because matching runs against every row and a backtracking pattern would otherwise cost the 250 ms watchdog on each one. Verified against the target's real agent: a column that agent does not implement gaps to `value: null` through storage and query rather than reading zero |
| T-05 SNMP CPU / Memory / Disk Free / Uptime | done | Four types plus `support/snmp/mibs.ts`. **`sysUpTime` is the wrong OID for uptime** — it counts from the last time the *agent* re-initialised, and on the dev target read 32 hours against `hrSystemUptime`'s 8.9 days on a box that had not rebooted, so a sensor built on it raises a false reboot alarm on the first device it sees. Restart detection is `M-11`'s threshold trigger on an uptime channel in **seconds** (verified: "when uptime < 600") rather than transition detection, which would need the core to keep a previous reading and synthesise a value the probe never sent — and would miss a restart that happened while the sensor was Down. **"Available memory" has three sources that disagree 2×**: measured on one 7936 MiB box, MemAvailable 5169 MiB, free+buffers+cached 5583 MiB, MemFree alone 2819 MiB — the last would call it 64% used against a true 35%, which is how a product teaches its operators to ignore memory alarms. `hrStorageSize` is in allocation units, differing per row on the same device (1024 memory, 4096 filesystems). Nothing assumes an index starts at one: the target numbers its processors from 196608 and its storage rows 1, 3, 6, 7, 8, 10, 11, 33 |
| T-06 SNMP Trap Receiver | done | The first *listener* sensor, and most of the ticket was deciding where that shape lives. A socket cannot be inside a check — one runs in whichever worker is free and only while it is running — so the probe owns one receiver and `CheckContext.received` hands each sensor what arrived since it last looked. The listener knows nothing about sensors; filter rules, counting and retention are `params` and live in the type, tested against a fabricated batch with no socket. `T-20` reuses the contract unchanged. **v1 and v2c traps are different messages** — header fields against varbinds — and a rule matching one but not the other looks exactly like a quiet network, so RFC 3584 §3.1 normalises both in one place (verified live: a v1 and a v2c trap both read `linkDown` in the same message). Informs are acknowledged before the callback, or one event becomes a burst of retransmissions. Two things it refuses to call zero: no listener running, and a buffer that overwrote notifications before the sensor read them — both fail the check, because a receiver that was never switched on must not look like silence |
| T-07 SSH session layer | done | `support/ssh/` mirrors `support/snmp/` on purpose — a second transport shaped differently is a second set of habits for whoever adds the third — with `ssh2` in one file behind a hand-written `.d.ts`. **The host key policy is where the thinking went.** A client that accepts any key authenticates the server not at all, so a password can go to whatever answered on port 22 while the check goes green; most tools default to that because the alternative needs somewhere to record what was trusted, and a probe has nowhere (the config channel is one-way, `R-09`). Solved with a person rather than a store: the expected fingerprint is a credential field, and a strict check with nothing recorded fails **naming the fingerprint presented**, so the operator compares it and pastes it in. `hostVerifier` runs during key exchange, so a host that fails never receives the password — asserted, not assumed. Connection reuse matters more than for SNMP (a handshake is TCP + KEX + auth, not a datagram): measured live, five checks share one connection, and concurrent opens join one in-flight handshake instead of racing. A non-zero exit is a result, not an error; output is bounded and passing the bound fails rather than truncating, because `T-08` parses it |
| T-08 SSH Script / Disk Free / Load Average / Meminfo | done | Four types plus a pure `parse.ts`, because every one of these formats has a variant that parses *almost* right and yields a number that is wrong rather than absent. The script format is line-oriented first — `echo "queue:12"` is one line of shell, where emitting JSON from shell is quoting a script author cannot test by running it — with a bare number and a JSON object also accepted. `df -P -k` is deliberate: without `-P` a long device name wraps and the parser reads the previous filesystem's columns, and `df` honours `BLOCKSIZE` from the environment. `ssh.load` makes **load per processor** primary, since 4 is idle on 32 cores and desperate on one. `ssh.meminfo` gets `MemAvailable` directly — the number `T-05` had to approximate over SNMP — and the two agreed live on the same box, 37.12% against 32.03% minutes apart. **Live verification found a real defect in `R-04`:** a rotated credential changed the config *version* but produced an *empty delta*, because `diffAssignments` hashed each sensor without `A-05`'s stamps — so a probe recorded the new version and kept authenticating with the old secret indefinitely. Fixed and pinned |
| T-11 T-12 TLS Certificate / Security Check | done | `support/tls/handshake.ts` plus two types. The certificate sensor connects with `rejectUnauthorized: false` **on purpose** — a sensor that refuses to look at a broken certificate cannot report on it, which is the one moment you need it most — and grades the fault instead. Expiry could not be tested against a real certificate because `openssl` 3.0 has no `-not_before`, so `inspectCertificate` was extracted as a pure function over a fabricated chain; a wildcard matching two labels and a chain-walk regression were both caught that way. The security sensor scores by handshaking weakest-version-first and stopping at the first success, because the weakest thing a server accepts is the only number that matters |
| T-13 T-14 HTTP Advanced / Content | done | Two types and `support/http/request.ts`, extracted once there were three callers. Credentials come from the *device* through a new `http` credential kind, so a hundred sensors against one API rotate in one place rather than a hundred. The body is bounded and passing the bound **fails rather than truncates**: a pattern matched against half a document reports a value as missing, which is a far more confusing fault than "this page is bigger than this sensor reads". `support/snmp/extract.ts` became `support/pattern.ts` on the way — there was never any SNMP in it |
| T-22 Ping Jitter / Port Range | done | Jitter is RFC 3550's estimator rather than a spread, because two links with identical minimum, maximum and mean can differ by whether a voice call works — the difference is in the order the packets arrived, which no summary of the set can see. The port set **counts rather than judges**: a back-end pool wants all of them open and a firewall canary wants none, so the same sensor serves both and a limit on the channel decides. Capped at 64 ports, which is enough for either job and short of the point where a probe every sixty seconds becomes somebody's intrusion-detection alert |
| T-15 HTTP Transaction | done | The sensor for a login rather than a page: a form, a POST, a session cookie and something behind it, where every part answers 200 while the whole is broken. Five sensors in a row cannot do it — they do not share a session, do not run in order, and are five alarms for one outage. **The cookie jar belongs in `fetchHttp`**, because a login answers 302 with a `Set-Cookie` and the very next hop must carry it; a jar applied between *steps* sends it one request too late and the dashboard comes back as the login page with a healthy 200. Two defects in shared code surfaced: a 302 was re-sending the POST body (RFC 7231 §6.4.3 — every browser changes it to GET; 307/308 now preserve both), and `pattern.ts` bounded every subject at 4 KB, so a token below 4 KB of markup read as "not found" |
| T-16 REST Custom | done (JSON; XML in `T-24`) | `rest.custom` plus `support/json-path.ts`, a bounded path language. A regular expression over JSON works until a field moves, a key is reordered or a number arrives as a string — none of which is a change to the data. **A path selects a set and the aggregate is an explicit choice**: "how many nodes are down" and "the worst load on any node" are the same path, and a language that silently took the first match would answer both wrongly. Stops short of script expressions, because full JSONPath's filter evaluates JavaScript in the reference implementation. The descent is iterative — the recursive one overflowed the stack at ~12,000 levels of nesting and said `Maximum call stack size exceeded`, which is not a diagnosis. XML needed a parser and a dependency decision with a second caller behind it (v2 VMware SOAP), so it went to `T-24` rather than a hand-rolled parser in a sensor type |
| T-17 Mail sensors | done | Four types over one connection and three hand-written protocol clients. npm's mail libraries are all *clients* — they retry, they queue, they hide a 452 behind a reconnect — and every one of those is the opposite of what a check must do. All three protocols are the same transport wearing different words, so the socket, the deadline, the abort and the in-place STARTTLS upgrade are written once and each protocol supplies only "has this reply ended". **SMTP, IMAP and a mailbox all answering is still three green sensors on a system where mail has not moved for six hours** — the round trip is the only one that measures the pipeline rather than its parts, and it deletes what it sent by a per-check token because POP3 renumbers. `DELE` is not a delete until `QUIT` and `STORE \Deleted` is not one until `EXPUNGE`, so both failures fail the check rather than filling a mailbox one message a minute. STARTTLS asked for and not offered fails rather than downgrading; a carriage return in an address is refused at the protocol, since an address is a sensor parameter and that is command injection through a form. `mail` joined the credential kinds in migration 024. GreenMail joined the dev stack: MailHog is a sink and speaks no POP3 or IMAP |
| T-18 Database sensors | done | Three types over one interface and three driver files. `pg` was already here; `mysql2` and Microsoft's `tedious` are dependencies rather than hand-written protocols, which is CLAUDE.md's rule read the right way round — syslog and WMI are ours *because npm has no maintained option*, and these have one. **No pool, the opposite of the SNMP and SSH decision**: a database connection costs the server a backend and a slot against `max_connections`, and holding one per sensor is how a monitoring system takes a database down on the day it is needed. **The statement timeout has to be server-side** — a client that hangs up leaves the query running, once a minute, for ever — and the live test earned its keep: setting only MySQL's `max_execution_time` let a MariaDB run a ten-second query under a three-second timeout, because MariaDB has `max_statement_time`, in seconds. `verifyTls` defaults to false here and nowhere else, since almost every database server runs the self-signed certificate its installer made. Dev stack gained MariaDB and Azure SQL Edge behind a `db` profile — SQL Server's own image is amd64 only and segfaults under emulation on Apple silicon |
| T-19 EXE/Script sensors | done | The escape hatch, and why the plugin contract does not have to cover everything. Both types declare `isolation: 'process'`, which is what `P-03` was built for. **The sandboxing is one function and it is the whole ticket**: a sensor names a *file inside a directory the operator configured on the probe* — not a path — because otherwise anyone who may add a sensor may run any command as the account holding every credential this system has. `realpath` before the prefix comparison, not after, since a symlink inside the directory is the obvious way around a check made on the name. **Warning is not an outcome a check can report**, deliberately: it comes from a limit on a channel, which is visible and editable, where a Warning baked into a script is a threshold nobody can change without editing the script on every probe. PRTG's `returncode:value:message` and `{"prtg":{"result":[…]}}` are both read unchanged; the advanced sensor's channels come from the program, since the core creates a channel the first time a sensor mentions it |
| T-20 Syslog Receiver | done | `syslog.receiver`, and it needed **no change to `T-06`'s listener contract** — the probe owns one socket, `CheckContext.received` hands each sensor what it has not seen, and a second protocol arrived to find the seam already the right shape. The ring came out into `NotificationRing` at the second caller, which is not the call `P-19` made about the session pools: those are *similar*, these are byte-for-byte identical and what varies is entirely outside them. Both RFC formats, because a receiver that only read 5424 works against a test rig and not against a network, and both of RFC 6587's TCP framings, because guessing wrong on octet-counting corrupts messages in a way that gets blamed on the sender for weeks. **Counting by severity is the reading**: one count goes Down on a busy night and Up on a quiet one. Rules are ANDed — ORed, a second rule would widen the sensor. The sender list is a filter and not a lock, since syslog authenticates nothing at all |
| T-21 Sensor Factory | done | `core.factory`, the one type the **core** evaluates rather than a probe — its inputs are channel values this process already holds. Results go through `acceptResults` exactly as a probe's do, so a factory sensor has history, limits, dependencies and alarms with no special case downstream. **The formula language is hand-written and deliberately not a sandbox around JavaScript**: `new Function` would let anybody with sensor-create rights run code in the process holding the vault key. A gap propagates through the whole expression, because a total that quietly lost a term is a number that looks like data and is wrong; `default(…, 0)` is how an operator says otherwise, in the formula where it can be seen. Cycles are refused before evaluation and every member of a ring is named; within a sweep, factories are evaluated in dependency order so a factory over a factory sees this sweep's value |
| T-23 Sensor type authoring guide | done | The guide had drifted into telling people the wrong thing — written at `P-05`, before `isolation` and `evaluatedBy` existed, and still advising `costHint: 'heavy'` for a type that shells out, which was true when there was no mechanism. A guide that is out of date is worse than none: it is confidently wrong where somebody new will trust it. Worked example is `dns.blocklist`, a real sensor in one file, and writing it found two defects of the same shape — a sensor that always answers the reassuring thing. Node's resolver retries four times by default with `timeout` per *try*, and `NXDOMAIN` means both "not listed" and "no such zone", so a typo'd list name read as clean. The second was found by the live run and by nothing else |
| T-24 REST Custom, the XML half | done | `fast-xml-parser` rather than a hand-written parser, which is CLAUDE.md's rule read the right way round: syslog, NetFlow and WMI are ours *because npm has no maintained option*, and XML has several. A document is **validated before it is parsed**, because the library is lenient by design and would build a tree from a truncated response — the case a monitoring check meets most often, and the confidently-wrong number this ticket exists to avoid. **XPath spelling over the same engine, not a second engine**: a path beginning with `/` is translated to the steps `selectPath` already walks, so `/prtg/result[last()]/value` and `$.nodes[*].load` are one bounded language with two spellings. `[1]` is the first in XPath and the second in JSONPath, so the syntax the path is written in decides. Two callers — `rest.custom` gains `format: auto|json|xml`, and `exe.script.advanced` reads PRTG's advanced XML, which its own sensors emit by default. The tests found the real defect: `looksLikeXml` read an HTML error page as XML, and HTML parses *well enough*, which turned "this is not an API response" into "your path matched nothing in it" |
| T-09 Windows check transport | done | `ADR-001`'s open question 3, answered: a PowerShell shell-out, not an in-house WinRM client. WS-Management's only widely-permitted authentication is NTLMv2 or Kerberos, so a client is a cryptographic implementation rather than a protocol port — written in v1 to reach machines a Windows probe already reaches with a supported client. **A Windows probe is a real constraint, stated rather than worked around**: one probe monitors many machines because `Get-CimInstance -CimSession` *is* WinRM, but a Linux-only installation cannot monitor Windows, and an operator meets that as a sentence rather than as `spawn ENOENT`. **The defect only a real PowerShell could find**: the script went over stdin via `-Command -`, which on pwsh 7 reads stdin as *interactive* input — the multi-line wrapper produced no output and exit code 0. `-EncodedCommand` is the form that works on both 5.1 and 7, and putting the script in argv is fine because the script is not the secret; the credential is, and it travels in the environment. Measured in `docs/findings/2026-08-27-powershell-transport.md` |
| T-10 Windows CPU / Memory / Volume / Service | done (queries unverified against Windows) | Four types, one query each. The performance counter rather than `Win32_Processor.LoadPercentage`, which is a single sample and disagrees with Task Manager on a busy machine. `Win32_OperatingSystem` counts in **kibibytes**. **One volume sensor for the machine with a channel per volume**, not one per volume — six drives as six sensors is six alarms when the machine goes — with the lowest free percentage as the primary. A service sensor that does not restart anything, because a monitoring system that restarts turns an incident into an intermittent one nobody investigates. A mutation found the bad kind of defect: with no credential configured the transport blanked the host, so a sensor pointed at `server01` quietly measured the probe's own box and filed the numbers under `server01`. **The queries themselves have never run against Windows** — the transport and the wrapper are proved, the four `Get-CimInstance` calls are written against recorded output, and that is an open item rather than an implied pass |

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

**Both exit criteria are met and measured**, on 2026-08-27 against the dev network
(`172.19.0.0/24`). Phase 7 is complete: `D-01` through `D-10` are all done.

| What | Measured |
| --- | --- |
| Detailed sweep of a /24 | **5.1 s**, 254 addresses, 49.5 addresses/second — inside the 8–64 s the preview offered |
| Found | 11 hosts alive, 11 identified, 243 unreachable, 0 failed |
| First provisioning | 11 devices, 12 sensors, **11 master dependencies**, 0 problems |
| Re-run, identical | **0 devices, 0 sensors created**; 11 matched, 12 skipped |
| With an SNMP credential | 8 further sensors on the 2 SNMP hosts; still 0 new devices |
| Sensors Up on first scan | **19 of 20** |

**The master dependency is where `D-05` said it would be**: `dependency.masterId` on the
*device*, the HTTP sensor inheriting it with `definedOn` naming the device, and the Ping sensor
resolving to *itself* with `holding: false` — `M-11`'s `a.master_id <> o.id` keeping the master
scanning while its dependents pause, which is the bug PRTG carried to v19.1.

**"Correct sensor sets" turned out to mean withholding them.** Nine of the eleven hosts
classified `unknown` and got a Ping and nothing else, which is right: `unknown` is a real answer,
and guessing would create sensors that fail from their first scan. The two that answered SNMP
matched `ms.linux`, and its SNMP sensors were **still withheld** until a credential existed on
the group — `D-03`'s `credential` gate, visible in the plan as a template that matched and a
sensor list that did not include it. Adding the credential and re-provisioning created exactly
those eight, and they came up Up. The one Warning is `snmp.diskfree` asking for `/` on a
container whose storage table has no such row, and it says so in those words along with the
twelve rows it does have — a template default meeting a container, diagnosed rather than left as
a red square.

**Two halves of the criterion were not measured, and are stated rather than implied.** There is
no Windows machine on the dev network, so the `T-10` sensor set has never been provisioned by a
discovery — the same open item `T-10` already carries. And the two SNMP hosts are a Net-SNMP
agent and a simulator rather than switches or appliances, so `sysObjectID`-driven vendor
templates are exercised only by `D-03`'s unit tests.

---

### Phase 7 progress

| Ticket | Status | Notes |
| --- | --- | --- |
| D-10 Discovery UI | done | **The estimate is shown before the choice**, which is what `D-06` was for: `detailed` on a /24 is a minute and on a /16 is hours, and a picker without the numbers is the picker PRTG has. Levels cheapest first, and anything over ten minutes flagged — roughly where somebody walks away, and a discovery they walked away from is one whose plan they never read. **One bar over two phases, split 70/30 rather than by count**: a /24 with three live hosts is 254 sweeps and 3 identifications, so weighting by count would leap from 5% to 100% as the sweep ended. **Polled, deliberately** — `U-02`'s stream carries sensor state, and pushing a run one operator is watching would mean a new message kind and a fan-out to every client; the timer chains from each answer so a slow reply cannot stack requests. The browser forms no opinion about a range: the core's parser is the only thing that knows, and its own sentence is what gets shown |
| D-09 Bulk operations | done | `POST /objects/bulk`, one route with an `operation` discriminator over six verbs. **A loop over the single-object methods, with `batch` deliberately unused** — contradicting the note `S-03` left, and said out loud: `batch` hands out the repository, and hierarchy validation, redaction, audit and inheritance recomputation all live in the service method above it, so composing repository calls would be a second way to update an object. One transaction over a selection would also hold the exclusive tree lock for the whole batch, which for five hundred objects is a self-inflicted outage in the thing meant to notice outages. **Each object atomic, the batch best-effort**, with a per-object outcome: forty sensors selected and one deleted underneath you should be thirty-nine paused and a line naming the fortieth. Cascade goes *through* the delete guard rather than around it — ask for the safe delete, read the descendant count out of the refusal, retry with `exact`, so the retry catches a subtree that changed in between. Live verification found the revert: `value: null` meaning "inherit" failed on every object, because the null reached the setting's own schema — it is its own `revertSetting` operation now, the same split the single-object routes make between `PUT` and `DELETE`, and null stays a storable value rather than becoming an instruction |
| D-08 Discovery run summary | done | `GET /discovery/:id/summary`, **derived rather than stored**: every number comes from the run row and the host rows, so it cannot drift and a second provisioning pass updates it for free — a stored blob would need rewriting by the sweep, by identification and by every provisioning attempt, and the first writer to forget would leave a page confidently reporting numbers nothing else agreed with. A **headline** sentence above the table, written as cases rather than a template with optional clauses, because the sentences worth reading are the unhappy ones. Three distinctions it refuses to collapse: `unidentified` (never looked at) is not `unknown` (looked at, unplaceable), *not provisioned yet* is not *created nothing*, and *created nothing* is not *created nothing new* — the last being idempotency working, which is what a re-run is checking. Errors are in the summary rather than behind a second request, because a run that created eleven devices and could not create two is where somebody stops reading at the good number |
| D-07 Scheduled rediscovery | done | **Off by default is three independent gates, not a checkbox**: no schedule exists until somebody creates one, a new one is created disabled, and `auto_provision` is a second flag that is separately off — so an enabled schedule's default behaviour is to sweep, identify and leave the plan for an operator to read. Turning auto-provisioning on is safe only because `D-04` is idempotent, which a second live firing confirmed: zero new devices, zero new sensors. **A cadence is an event and `M-09`'s schedule is a window** — "every Sunday at 03:00" is not a weekly calendar of active periods — so the cadence is its own pure module and an `M-09` schedule is attachable *alongside* it as a permission window. **The next firing is searched forward a minute at a time rather than computed**, because adding 24 hours to 02:30 lands on 03:30 the night the clocks go forward; the test that asked for the run after the first one found a daily cadence firing twice the morning they go back. The next run is booked *before* the discovery starts, so a start that throws does not leave the schedule due for ever. Live verification found the routes at `/rediscovery` rather than `/discovery/schedules`, where `/discovery/:id` was answering them, and an invalid cadence escaping as a 500 that said nothing |
| D-06 Discovery levels | done | Three levels, each a real trade rather than a slider with names on it; the extra ports at `detailed` were chosen because each changes what gets created, which is the difference between a discovery level and a port scan. The table is in `@ms/shared` and the job carries its choices, so the estimate is about the run that happens — `D-02` had identification using the *sweep's* timeout, which made detailed no more patient than standard. **The estimate is a range and the arithmetic is the point**: the two halves pull in opposite directions, the cost is linear in the fraction alive, and the endpoints bracket every outcome. The first version added the two worst cases together and reported a range that did not contain the answer for a half-alive network. Templates are a filter rather than a fourth level |
| D-05 Default master dependency | done | `M-11` had the mechanism; this is discovery using it. **The master is a template property rather than a hardcoded `icmp.ping`** — a switch reached only over SNMP has no Ping, and an appliance behind a firewall that drops ICMP is watched by its certificate — with at most one per template, because which won would otherwise depend on the order somebody wrote them in. **Only on a device this pass created**: a device an operator already set up has dependency choices of its own, possibly "none" deliberately, and overwriting them would edit a decision somebody made on purpose on every re-run. A master that could not be created leaves the device with none, since one that cannot scan would pause every sensor on it for ever |
| D-04 Provisioning and idempotency | done | **Three matching keys in order of what each means** — the address is exact, the reverse name finds a device somebody created years ago by name, and the short name is last because two sites can each have a `web01`. Within the target group, because the same address legitimately exists twice in one installation. A device created during the pass joins the index immediately, or two addresses resolving to one name become two devices. The duplicate check compares the parameters the *spec* names rather than the sensor's, since a hand-made sensor carries every default its schema has. Through `ObjectService` rather than the database, and one host per transaction rather than one for the lot. **The first live run failed and found two defects**: `validateTemplate` checked only that a sensor type existed and not that the parameters would make it, so a built-in template naming `snmp.diskfree` without a mount point failed per device; and the per-*host* catch then lost every sensor after it, leaving a device with a Ping and a report saying nothing was wrong |
| D-03 Device templates | done | The lookup catalogue's shape — definition, built-ins, catalogue, loader, override-by-id — because an operator who has learnt one knows the other, and because `CAPABILITIES.MD §3.7` chooses templates plus SNMP Custom over hardcoded vendor sensor types precisely so they are *data*. Matching is data and never an expression; criteria are ANDed, since a template that ORed them would widen as it was made more specific. Every match is returned rather than the best, because a Linux box serving HTTP is genuinely both. **The whole set exists to avoid one failure**: a discovery creating thirty sensors per device, twenty of which fail from their first scan, which is how an operator learns to turn the feature off — so `requires` is per sensor and `credential` names what a sensor cannot work without. Save-as-template deliberately infers no match rule: only the operator knows whether it is for this model, this vendor or every switch |
| D-02 Device identification | done | A second stage of `D-01`'s job rather than `R-09`'s synchronous request/response — nobody waits on identifying two hundred hosts, and `R-09` is still needed for the cases where a request *is* waiting. **The classifier is pure and in `@ms/shared`**: the probe opens sockets and `classify` draws every conclusion, because a misclassified host gets the wrong sensor set from `D-03` and that has to be testable without a network. Evidence is ranked by worth — `sysObjectID`, then `sysDescr`, then a banner, then a port, then a reverse name, which can only raise an answer nothing else reached. Two orderings earned comments: ESXi before Linux, because an ESXi agent reports a Linux-looking string; and the generic switch/router/firewall rule *after* the OS rules, because `sysDescr` contains the host's own name and `FreeBSD firewall.example.com` was being read as a switch. **Two defects found live**: a NUL byte in a banner made `jsonb` refuse the whole batch, and the failure then retried 298 times in three minutes with every component behaving correctly on its own — nobody was checking that progress was being made |
| D-01 Network sweep | done | Three properties, three mechanisms. **Resumable is one integer** — how many addresses have been offered — held on the *core*, because the probe is the thing that restarts; it advances only after the hosts in the same message are stored, so it is a floor rather than a promise and a replayed address is free. **Cancellable is a message, not a disconnect**, and is recorded before it is sent so a cancel works while the probe is down. **Not starving live checks** needed more than a number: the sweep stands down entirely while any check is queued and counts the time, and the rate is a token bucket rather than a delay per address. The range parser is in `@ms/shared` so the two ends cannot disagree about how big a range is; a CIDR excludes its network and broadcast addresses, except a /31 and a /32, which are entirely host addresses. IPv4 only, said out loud: a /64 is eighteen million million million addresses. **Live verification earned its keep** — the four new protocol members were written into the wrong union, so the core sent a message the probe's validator rejected and the pair sat in a reconnect loop with every unit test passing |

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
| R-01 probe identity and approval | done | **Reaching the port is no longer the same as being trusted**, and until this it was: a probe presenting the shared key was handed configuration immediately. A pending probe is now *welcomed rather than rejected* — it gets an identity, it heartbeats, it appears in the queue with the name and address it reported, and it gets no configuration at all, so it scans nothing. Rejecting it would leave an administrator approving something they cannot see, and would make the probe re-enrol on every retry. The check lives in `#queueConfig`, so an unapproved probe scans nothing because there is one door. **The session exists before the decision does** — asking the registry is a round trip and messages keep arriving during it. **A per-probe key**, SHA-256 not argon2 (there is nothing to guess in 32 random bytes, and a slow hash on the handshake only makes a reconnect wait), issued once, which is what makes revoking one probe possible without rotating everybody's. **The probe persists its identity** beside the spool at `0o600` — it lived only in memory, so every restart enrolled again — and keeping it out of the config file means copying `probe.json` does not clone an identity. Revoked rather than deleted, and two places had to learn that a revoked identity does not hold a branch or replacing a probe would mean deleting the record that keeps it out |
| R-05 probe offline handling | done | The state machine always knew the answer; nothing told it the probe was gone. Sensors under a lost probe read **Unknown, cause `probe`** — Down would be a claim the system cannot support, and one cable would page once per sensor. **The set is sensor ids, not probe ids**, because the question is asked once per sensor per decision. **The overlay lives in one place**: a sensor whose probe is gone must read Unknown however its state is re-decided, and `loadRuntimes` restores `probeReachable: true` because there is no column for it — so a pause clearing would otherwise flip it back to Up mid-outage. A returning probe gives its sensors back their last reading rather than holding them Unknown, because that reading is the most recent measurement and the next scan corrects it |
| R-06 version skew detection | done | The negotiation worked; it did not *say* anything. Incompatible was never the dangerous case — a closed link is loud. The dangerous one is a probe on protocol 2 that connects, heartbeats, passes every health signal, is refused configuration and therefore scans nothing, which was an `info` line and nothing else. **The version numbers were scattered** — a bare `3` for configuration, `4` and `5` for the two discovery stages — so `capabilitiesFor` is now the one map and every gate reads it. **`describeSkew` separates compatible from current**, and names both versions every time, because "probe is outdated" is unactionable. **A run assigned to a too-old probe used to wait forever**: `sendSweep` answered `false` both for offline and for never, so the caller waited, which is right for one and wrong for the other — now three-way, and a `too-old` run fails with the versions and the fix. **The refusal moved into the registry**, after the sighting is written, so the refusal an operator is most likely to meet stopped being the only one that left no row |
| R-07 probe installers | done | It looked like packaging and was a security defect: `install.sh` issues **one** `probe.crt`/`probe.key` on the core host, so every probe in an installation presented the same TLS identity and revoking one at the transport layer was impossible — `R-01` made the access key per-probe, the certificate under it was shared. `ms-enrol` now issues a certificate per probe and packs it with the CA, the enrolment key and the core's address into one file an operator carries; it refuses to guess an address when the core binds a wildcard, because a bundle that cannot connect is worse than a question. `package.sh --probe-only` gives a probe host a probe — 12M against 16M measured, but the win is that there is no core to start, no `core.json` to misconfigure and no web root. `smoke-enrol.sh` proves it across **two** boxes, since a localhost-only SAN or a leftover `127.0.0.1` passes on one. Fixed on the way: the full tarball had been unbuildable since `T-18` on a `pg` range conflict |
| R-08 disconnect/reconnect soak | done | Two clauses that fail in different places, so measured in two — zero data loss is the probe's spool, no ingestion stall is the core's pacer; one test spanning both would need the two services to import each other, which `ADR-001` does not allow. **An hour is a quantity, not a duration**: at the v1 target it is 300,000 readings, and sleeping for one would measure a clock. Probe side: 300,000 readings, 61.7 MB, replayed in 1.77 s, **0 lost, 0 duplicated, 0 corrupt**, caught up 2031x faster than the outage; an hour is 3% of the shipped spool, so the default is sized for about a day and a half. Core side, two probes each replaying an hour beside a live one: live p99 274.6 → 279.2 ms, **1.02x against a 3x budget**, replaying probes paced 50 ms and the live one never. Writing it taught me the pacer does not slow a *lone* catch-up — that is work, not unfairness — so the test runs two probes against a limit of one |

Both exit criteria are met and measured:

- **A probe disconnected for one hour reconnects and replays with no data loss and no ingestion
  stall** — measured in two halves, because the two clauses fail in different places and
  `ADR-001` keeps the two services from importing each other. The probe side spools an hour at
  the v1 target (**300,000 readings, 61.7 MB**), survives a restart mid-outage, and replays every
  one of them **once** in **1.77 s** — **0 lost, 0 duplicated, 0 corrupt**, catching up 2031×
  faster than the outage that produced it. The core side runs two probes each replaying an hour
  beside a third reporting live: live p99 goes **274.6 ms → 279.2 ms, a factor of 1.02** against
  a 3× budget, with the replaying probes paced 50 ms and the live one never.
- **Version skew between core and probe is detected and reported rather than silently
  misbehaving** — `R-06`. The half that was missing was never the incompatible peer, which
  closes the link loudly; it was the *compatible but outdated* one, which connects, heartbeats,
  passes every health signal and is refused configuration, so nothing under it is ever scanned.
  That is now a skew verdict on `GET /probes` naming both versions and what the probe cannot do,
  and a discovery run assigned to a too-old probe fails with a reason instead of queueing for
  ever.

**One deliverable is not met and does not block the exit criteria:** *Probe Health — connection
state, lag, spool depth, version skew*. The sensor itself is `P-13`, still open in Phase 2, so
the facts exist and are exposed over the API and in the log but no sensor collects them yet.
`R-05`'s "one alarm for a lost probe" is the same shape: the sensors go Unknown with cause
`probe`, and the single alarm that replaces the storm is Probe Health's to raise once `P-13`
lands.

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

### Progress

| Task | State | Notes |
| --- | --- | --- |
| A-01 accounts and authentication | done | Everything before it ran as `anonymous` — the `Actor` union carried a `user` variant nothing produced, so the audit log recorded *that* a thing happened without *who*. argon2id for passwords and SHA-256 for session tokens, which look like the same problem and are opposites. Server-side sessions per `ADR-001`, because revoking a stateless token means a deny-list — a table, so nothing was saved. Throttling counts per address *and* per account, because locking an account is a denial of service anybody can trigger and counting only addresses stops nothing distributed |
| A-02 user groups and primary group | done | Rights hang off groups so they survive the person leaving. The primary group is the *default*, answering only which group owns what a user creates; access is the union of all groups, because otherwise *adding* somebody to a group could take access away |
| A-03 per-object access rights | done | Rules applied **per group, then combined** — the other reading lets a `read` grant on a leaf strip another group's inherited `full`. `none` is storable and distinct from revoking. Administrators short-circuit the walk, because "may do anything, including to objects that do not exist yet" is not a position in the tree. Mutation-tested 11/11 |
| A-04 read-only restrictions | done | A role is a **ceiling**, not a starting point. Three ways into a read-only administrator, all refused by trigger — and writing the tests found the third, making the *group* administrative under an existing read-only member |
| A-05 credential vault | done | Already complete; `A-10` pinned the boundary it provides |
| A-06 API tokens | done | A token is never more than its owner: scope capped at creation *and* at every use, because either alone leaves a gap. A token cannot mint a token |
| A-07 TOTP MFA | done | Enrolment is two-step, so a mistyped setup cannot lock somebody out. A code cannot be replayed inside its own window. Enforcement is per group |
| A-08 audit log UI | not started | The per-object route exists (`S-10`); what is missing is the global feed |
| A-09 security hardening | done | Three of six already existed; auditing first found the one that mattered — the SSRF guard covered webhooks and not sensors, and a sensor is the *better* vector because its response is stored and rendered |
| A-10 access-control matrix | done | Found a real bug: `/access/effective` answered what the *groups* granted rather than what the account could do, so a read-only account was told it held `full`. The credential sweep covers every registered route by construction |

Both exit criteria are met:

- **An access-control test matrix passes for every combination of role, group and tree
  position** — 12 rows over HTTP in `access-matrix.test.ts`, on top of `A-03`'s 13-row matrix
  against the resolver. The HTTP layer is where the one real defect was: a route that resolved
  the right without applying the role's ceiling.
- **A read-only user cannot retrieve any credential by any route, including historic-data and
  export endpoints** — met by a boundary rather than a role check, which is the stronger
  property: no route returns a credential *to anyone*. Proved by sweeping every registered GET
  route with a planted secret, for all three roles.

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

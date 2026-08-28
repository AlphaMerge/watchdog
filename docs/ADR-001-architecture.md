# ADR-001: Core architecture and technology stack

- **Status**: Proposed
- **Date**: 2026-08-24
- **Deciders**: Roman
- **Supersedes**: —

## Context

We are building a PRTG-class monitoring system in Node.js (see `CAPABILITIES.MD` and
`WORKFLOW.MD` for the target behaviour). Two hard constraints come from the project brief:

1. **Production runs as a standalone server** — a native service on a Linux or Windows host,
   supervised by the OS. Not Docker, not Kubernetes.
2. **Docker is for development only** — dependency services (Postgres, mail sinks, SNMP
   simulators, syslog senders) run in Compose on the developer's machine.

The v1 performance target is **5,000 sensors at a 60-second interval on one 8-core / 16 GB
box**, with p95 dispatch jitter under one second — comparable to PRTG's own published sizing
(8 cores / 12 GB for 5,000 sensors) with headroom.

Everything below was verified against current package registries and vendor docs on
2026-08-24. Version numbers are the state at that date, not pins.

---

## Decision 1 — Process topology: one core process, N probe processes

**Decision.** Mirror PRTG's core/probe split from day one, but implement the local probe as a
separate OS process rather than an in-core thread.

```
┌──────────────────────── monitoring host ────────────────────────┐
│                                                                  │
│  ms-core (systemd / Windows service)                             │
│   ├── HTTP API + web UI + WebSocket push        (Fastify)        │
│   ├── configuration store, RBAC, audit                           │
│   ├── ingestion pipeline → storage                               │
│   ├── trigger engine + notification dispatcher                   │
│   └── probe endpoint (mTLS)                                      │
│                                                                  │
│  ms-probe (local, separate process, same supervisor)             │
│   ├── timing wheel scheduler                                     │
│   ├── worker_threads pool  → network checks                      │
│   ├── child processes      → shell-outs (ping, PowerShell)       │
│   ├── listeners: syslog, SNMP trap, flow                         │
│   └── disk spool for results when the core is unreachable        │
│                                                                  │
│  PostgreSQL + TimescaleDB (local service)                        │
└──────────────────────────────────────────────────────────────────┘

           ms-probe (remote site) ──── outbound mTLS ────► ms-core
```

**Why**

- A crashing or wedged check must never take down the API. Separate processes give a hard
  boundary the event loop cannot.
- The local probe and a remote probe then run _identical code_. There is no "works locally,
  breaks remotely" class of bug, and remote probes stop being a bolt-on.
- The core can be restarted for an upgrade while probes keep collecting into their spools.

**Consequences.** An IPC hop even in the single-host case (mitigated: same protocol, Unix
socket / loopback locally). Two services to supervise instead of one — the installer handles it.

---

## Decision 2 — Scheduler: in-process hashed timing wheel, not a job queue

**Decision.** Write a hashed timing wheel in the probe, bucketed by due-second, advanced by a
single interval tick against `process.hrtime.bigint()`. Dispatch into a bounded worker pool.
No Redis, no BullMQ in v1.

**Why**

- `setTimeout` per sensor does not survive tens of thousands of sensors; the timer heap becomes
  the bottleneck and precision degrades.
- BullMQ (6.2.0, actively maintained) is excellent at _distribution and retries_ but adds Redis
  — a second service to install and supervise, which fights the standalone constraint. Its
  value is horizontal scale-out, which we do not need at 5,000 sensors on one box.
- Cron libraries (`croner`, `toad-scheduler`) are built for coarse job scheduling, not
  fine-grained mass dispatch.
- Phase-spread by `hash(sensorId) % interval` so bulk-created sensors don't stampede one second.

**Rejected alternatives**

| Option                  | Why not                                          |
| ----------------------- | ------------------------------------------------ |
| `setTimeout` per sensor | Timer-heap pressure and drift at scale           |
| BullMQ + Redis          | Extra service, contradicts standalone production |
| Cron-style scheduler    | Wrong granularity and no backpressure model      |
| DB-polled work table    | Adds latency and DB load to the hottest path     |

**Revisit when** we need multiple probe hosts sharing one work pool, or a v2 clustering story.
The scheduler interface should be narrow enough to swap the implementation.

---

## Decision 3 — Check execution: worker_thread pool, with child processes for shell-outs

**Decision.** A `piscina`-style bounded worker pool executes network checks. Checks that shell
out (system `ping`, PowerShell/WinRM, user EXE/Script sensors) run as child processes with
hard timeouts and resource limits.

**Why**

- Worker threads give per-check crash isolation at a fraction of the cost of a process, and
  each has its own event loop so one slow check doesn't stall the others in its pool.
- User-supplied scripts are untrusted code. They belong in a separate process, ideally under a
  different OS user, always with a kill timer.
- Pool size is bounded so saturation surfaces as measurable lag rather than unbounded memory.

**Backpressure rules.** If a sensor's next execution comes due while the previous one is still
running, skip it and count the skip. Deferred-check count and scheduler lag are first-class
metrics on the Probe Health sensor.

---

## Decision 4 — Storage: PostgreSQL + TimescaleDB, single database

**Decision.** One PostgreSQL instance holds both relational configuration (objects, users,
credentials, triggers, templates, audit) and time-series data (samples, state history) in
TimescaleDB hypertables.

**Why**

- **It is one service to install.** `apt install postgresql timescaledb`, one systemd unit,
  one data directory, one `pg_dump`/WAL backup story. That is the whole reason it beats the
  alternatives under the standalone constraint.
- Hypertables, native compression, continuous aggregates and `add_retention_policy()` are in
  the Apache-2.0 "TimescaleDB Open Source" core (extension at 2.27.2, June 2026). We must stay
  inside the Apache-licensed feature set and not drift into TSL-only features.
  **[Amended 2026-08-25 — this bullet was wrong. See the amendment at the end of this
  decision.]**
- Continuous aggregates map exactly onto the rollup workflow in `WORKFLOW.MD §9`: raw →
  5-minute → 1-hour → 1-day, with retention policies per tier.
- Joining a metric to its device, its owning group and its ACL in one query is worth a great
  deal for the UI, and is painful when config and metrics live in different engines.

**Rejected alternatives**

| Option                       | Why not                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ClickHouse (26.7, LTS 26.3)  | Faster at extreme cardinality, but it is a _second_ database next to Postgres for config — double the ops surface on a single box      |
| InfluxDB 3 Core              | Viable single-node, but long-range compaction/HA is the Enterprise upsell and the storage/query model is a bigger departure            |
| VictoriaMetrics (v1.150)     | Superb single-binary metrics store, but no relational half — we'd still run Postgres                                                   |
| SQLite + hand-rolled rollups | Simplest footprint; we'd own compression, downsampling and retention ourselves, and write concurrency caps us well below 5,000 sensors |
| DuckDB                       | Single-writer file model, wrong for continuous concurrent ingestion. Good later for offline report crunching                           |

### Amendment, 2026-08-25 — the licence claim above was wrong

Measured against TimescaleDB 2.29.2 with `timescaledb.license=apache`
(`docs/findings/2026-08-25-timescaledb-licensing.md`): only `create_hypertable`, `time_bucket`
and `drop_chunks` are Apache 2.0. Continuous aggregates, native compression,
`add_compression_policy`, `add_retention_policy`, `add_job` and `time_bucket_gapfill` all fail
with *"functionality not supported under the current apache license"*. They are Timescale
License — free for self-hosted use, but not Apache.

A spike built both paths and measured them on identical data
(`docs/findings/2026-08-25-rollup-storage-spike.md`, reproducible via `scripts/spike/run.sh`):

| | Apache-only | Timescale Community |
| --- | --- | --- |
| Incremental rollup refresh, 900k readings | 2,520 ms | 1,072 ms |
| Rollup on disk, 900k buckets | 110–132 MB | 124 MB |
| Raw on disk, compressed | **no equivalent** | **43 MB from 459 MB** |

**Decision.** Run with `timescaledb.license = timescale` and use **native compression**; write
the rollup tiers, the retention sweep and the job that drives them ourselves.

A 2.4× speedup on an operation costing a few hundred milliseconds every five minutes does not
justify binding the rollup layer to one engine. 12.5× on disk, with no Apache substitute, does
justify accepting the licence. Writing the rollups ourselves anyway means a future move off
TimescaleDB costs compression and nothing else — which is exactly what Decision 4's own
repository-interface hedge (and `S-12`) exists to protect.

Consequences we take on: `add_job` is TSL too, so the rollup, compression and retention sweeps
run from the core's own housekeeping loop; there is no real-time aggregation, so the repository
must union the not-yet-rolled-up tail from raw; and `time_bucket_gapfill` is TSL, so "gaps are
not zeros" is honoured in the repository and the wire format. The licence forbids offering the
product as a database-as-a-service, and attaches to any installer that bundles TimescaleDB
binaries — a question for `H-05`/`H-06`.

**Consequences.** TimescaleDB must be installable on the target OSes — verify the Windows
story early, since it is weaker than Linux. If Windows-native TimescaleDB proves impractical,
the fallback is plain PostgreSQL with our own partitioned tables and materialised-view rollups;
keep all time-series access behind a repository interface so this stays a contained change.

**Schema sketch**

```sql
-- configuration: ordinary relational tables
object(id, parent_id, kind, name, tags[], priority, ...)   -- probe/group/device/sensor
sensor_config(object_id, type, interval_s, timeout_ms, retry_policy, params jsonb)
channel(id, sensor_id, name, unit, scale_mul, scale_div, limits jsonb, lookup_id)

-- time series: hypertables
sample(time timestamptz, channel_id int, value double precision)   -- raw, ~40d
sample_5m / sample_1h / sample_1d                                  -- continuous aggregates
sensor_state(time, sensor_id, state, message, cause)               -- hypertable, drives uptime
```

Downtime and SLA are computed from `sensor_state`, never from `sample` — so they survive
rollup and stay correct across gaps.

---

## Decision 5 — API and web layer: Fastify + WebSocket push

**Decision.** Fastify 5 with JSON-schema validation, `@fastify/websocket` for live updates,
and a generated OpenAPI document. A versioned REST resource model (`/api/v1/...`), not
PRTG's `.htm`-suffixed RPC.

**Why**

- Fastify is the strongest fit for a long-lived process serving both a JSON API and thousands
  of push connections; schema-first validation gives us the OpenAPI doc for free.
- Express 5's WebSocket middleware ecosystem is stale (`express-ws` untouched since 2021).
- Hono is excellent but centred on multi-runtime edge deployment; our shape is one fat,
  stateful Node process.
- **Push over polling** is a deliberate improvement on PRTG: the device tree subscribes to
  state-change events instead of re-fetching.

We still ship a PRTG-shaped compatibility endpoint set (`table.json`, `historicdata.json`,
`getsensordetails`) behind `/api/prtg-compat/` in `[V2]`, because it makes existing customer
scripts and dashboards work.

---

## Decision 6 — Protocol libraries, and where we must build our own

Verified maintenance status as of 2026-08-24:

| Protocol                | Choice                                                                                | Status                                              | Risk                              |
| ----------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| SNMP v1/v2c/v3, traps   | `net-snmp` 3.26.3                                                                     | Active (Apr 2026), sessions + trap receiver + agent | Single maintainer — isolated, see below |
| SSH                     | `ssh2` 1.17.0                                                                         | Active (Aug 2025), de facto standard                | Low                               |
| MQTT                    | `mqtt` 5.15.2                                                                         | Active                                              | Low                               |
| Modbus                  | `modbus-serial` 8.0.25                                                                | Active                                              | Low                               |
| LDAP                    | `ldapts` 9.0.0                                                                        | Active; prefer over the stale `ldapjs`              | Low                               |
| SMTP / IMAP / POP3      | `nodemailer` 9, `imapflow` 1.7, `node-pop3` 0.15                                      | All active                                          | Low                               |
| Databases               | `pg` 8.23, `mysql2` 3.24, `tedious` 20, `oracledb` 7                                  | All active                                          | Low                               |
| TLS certificates        | Node built-in `tls.getPeerCertificate()`; `node-forge` for deep X.509                 | Built-in                                            | None                              |
| sFlow                   | `sflow` 1.28.2                                                                        | Active                                              | Medium                            |
| **ICMP ping**           | System `ping` binary via the `ping` wrapper by default; optional raw-socket fast path | See below                                           | **High**                          |
| **Syslog receiver**     | **Build in-house**                                                                    | No maintained receiver on npm                       | Owned                             |
| **NetFlow v5/v9/IPFIX** | **Build in-house**                                                                    | Ecosystem dead (2016–2018 packages)                 | Owned                             |
| **WMI**                 | **PowerShell / WinRM shell-out**                                                      | No maintained Node WMI client                       | Owned                             |
| Local host metrics      | `systeminformation` 5.33                                                              | Very active                                         | Low                               |

**ICMP is the sharp edge.** Node's `dgram` does not expose Linux's unprivileged
`IPPROTO_ICMP`/`SOCK_DGRAM` ping sockets, and the raw-socket packages (`raw-socket` 1.8.1,
`net-ping` 1.2.4) have been untouched since 2024. Decision: **default to the system `ping`
binary** (no privileges, correct everywhere, adequate for hundreds of targets), and ship an
optional raw-socket fast path enabled by `setcap cap_net_raw+ep` on the Node binary or a small
privileged helper. Ping being the single most-used sensor type makes this worth doing properly
— benchmark both paths in Phase 2.

### Amended 2026-08-25 (P-08) — we spawn `ping` ourselves, not through the npm wrapper

The decision above — *default to the system `ping` binary* — stands, and `P-08` implements it.
What it does not use is the `ping` npm wrapper this row suggests. That package (1.0.0, last
published April 2026) contains no reference to `AbortSignal` anywhere in its source, and
CLAUDE.md requires every check to honour `ctx.signal`. A check that cannot be cancelled has its
worker terminated on every timeout, which costs more than the wrapper saves.

Spawning it ourselves is about 200 lines, and the half that carries the risk — turning three
platforms' output into numbers — is a pure function with captured real output from Linux, BSD and
Windows as fixtures. That matters more than the line count for the most-used sensor type there
is. One example of why: Windows counts an ICMP "Destination host unreachable" as a *received*
packet, so its own summary reports `Received = 2, Lost = 0 (0% loss)` for a host that is not
there. Loss is therefore computed from timed echo replies, never from the summary line.

**Still open, and still `P-07`:** the raw-socket fast path, and the measurement at 1,000 targets
that would justify it. One number is already visible without it — `ping` waits about a second
between packets, so the default count of 4 holds a worker for roughly three seconds. At 5,000
sensors on a one-minute interval that is 5,000 process spawns a minute and 15,000 worker-seconds,
which no plausible pool size absorbs. `P-07` and `P-15` are where that gets confronted; the
sensor is written so a second implementation slots in behind the same pure parser.

### Amended 2026-08-27 (T-01) — `net-snmp` is isolated rather than vendored

The row above records the SNMP risk as "single maintainer" and names vendoring a fork as the
mitigation. `T-01` does not vendor it, and this is what replaced that.

**Two things measured while building it.** `net-snmp` 3.26.3 is MIT, was last published in April
2026, and its whole dependency tree is `asn1-ber` 1.2.2 and `smart-buffer` 4.2.0 — two packages
with no dependencies of their own and no native code between them. So the thing being carried is
three pure-JavaScript packages, not a build toolchain, and the cost of *not* vendoring is
correspondingly small.

**What replaces vendoring is a boundary.** `packages/sensors/src/support/snmp/session.ts` is the
only file in `packages/` that imports `net-snmp`, and `net-snmp.d.ts` beside it declares the
whole surface we use in about eighty lines — six functions, one interface, five constant tables.
That file is the inventory: it bounds the replacement cost at "one module" instead of "a search
through the repository", and it is checked by the compiler, so a use that drifts outside it stops
the build.

Vendoring stays the answer if the package is abandoned or a fix is needed that upstream will not
take. Doing it *now* would mean carrying ~15,000 lines of somebody else's protocol code, and its
security-sensitive USM half, against a risk that has not materialised — while giving up the
upstream fixes that are the reason to depend on a maintained library at all.

---

**Syslog, flow and WMI are subsystems we own**, not integrations. Budget for them accordingly:
a syslog receiver is ~150 lines of parsing plus filter rules; a NetFlow v9/IPFIX collector
needs a template cache and is a genuine multi-week piece of work — which is why flow sensors
are `[V2]`.

---

## Decision 7 — Sensor types are plugins, not a switch statement

**Decision.** Every sensor type is a module implementing a fixed contract, registered in a
catalogue at startup.

```ts
interface SensorType {
  id: string; // "snmp.traffic"
  category: string;
  paramsSchema: JSONSchema; // drives the add-sensor UI and API validation
  channels(params): ChannelDef[]; // declared up front
  execute(ctx: CheckContext): Promise<CheckResult>; // must honour ctx.signal
  costHint: 'light' | 'medium' | 'heavy'; // informs pool placement
}
```

**Why.** PRTG's value is 250 sensor types. We reach breadth only if adding one is a small,
uniform, well-tested unit of work — and if users can add their own without forking us.
The `paramsSchema` generating the UI form means a new sensor type needs no frontend work.

This is the single highest-leverage decision in the document. It is what makes the phased plan
in `PLAN.md` deliverable.

---

## Decision 8 — Frontend: React 19 + TypeScript + Vite, uPlot for dense charts

**Decision.** React 19.2 + TypeScript 7 + Vite 8. **uPlot** for time-series panels, **ECharts**
for topology, heatmaps and summary widgets. Built as static assets and served by the core — no
separate web server to install.

**Why.** uPlot is canvas-based and still the fastest thing available for 100k+ point line
charts. Its npm cadence has slowed (1.6.32, Mar 2025) — accepted risk, we vendor and patch if
needed. Recharts is SVG and folds at that density; visx is primitives, not charts.

See the `dataviz` guidance before building any chart: consistent palette, accessible contrast,
light and dark themes.

### Amended 2026-08-25 (U-01) — the two slots this decision left open

The original decision named the framework, the build tool and the charting libraries, and said
nothing about **styling** or **routing**. `U-01` had to fill both. Neither contradicts anything
above; both are recorded here so the next person does not have to infer them from `package.json`.

| Slot     | Choice                | Why                                                                                                                                                                                        |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Styling  | **Tailwind CSS 4**    | Utility classes keep the styling next to the markup, which matters most in the parts of this UI that are dense and repetitive — tree rows, channel tables, alarm lists. Its v4 engine is configured in CSS, so the design tokens below are plain custom properties rather than a JavaScript config the build has to interpret. |
| Routing  | **React Router 7**    | The obvious default, and the one thing in the frontend where inventing our own would buy nothing. Used in its declarative mode; no data-router loaders, so routes stay independent of how any given page fetches.                                                                                                             |

**Design tokens are CSS custom properties, not Tailwind theme keys.** Every colour, including the
six sensor states, is defined once in `packages/web/src/index.css` against `:root` and overridden
under `[data-theme='dark']`. Tailwind consumes them through `@theme`. The reason is that charts
are canvas — uPlot cannot read a Tailwind class, but it can read a custom property, so `U-05`
gets the same palette as the DOM without a second source of truth.

### Amended 2026-08-26 (U-05) — the series palette, and what "one axis" costs

uPlot landed as chosen, at 1.6.32 — the version the accepted-risk note above names — and the
custom-property decision paid: `readChartTheme` resolves the same tokens the DOM uses, at draw
time, so a theme switch rebuilds every chart with no second palette to keep in step.

Two things this decision did not anticipate:

**Charts need a categorical palette, and the state tokens are not it.** A colour that also means
"channel 4" stops meaning "down". So `--ms-series-1…8` are their own slots, taken from the
`dataviz` reference palette and re-validated against *our* surfaces rather than the skill's
defaults — light `#ffffff`, dark `#111827` — because a contrast result only means anything
against the surface the chart draws on. Both modes clear every gate; three light slots land in
the sub-3:1 warn band, whose mandated relief is the table view and the value-bearing legend that
every panel ships. The validator command is recorded beside the tokens.

**"One axis, never two" decides the page layout, not just a chart option.** A sensor's channels
routinely carry different units, so a panel holds only the channels that share one and a sensor
gets as many panels as it has units. That is `groupByUnit`, and it makes a two-scale chart
unrepresentable rather than merely discouraged.

**No component library.** Not Material, not shadcn, not Radix wholesale. The surface this product
needs is small and unusual — a virtualised tree, a channel table, a schema-driven form — and none
of it comes out of a component library anyway. Accessible primitives may be added *individually*
where the WAI-ARIA pattern is genuinely hard (a combobox, a modal focus trap); pulling in a whole
system to get a button is how a design system stops being ours.

**What remains true:** the app is built to static assets and served by `ms-core` from the
`api.webRoot` setting (empty serves no UI, which is what a headless install wants). There is no second web server in production. The Vite dev server exists only for
development, in Docker, like everything else in `docker-compose.dev.yml`.

---

## Decision 9 — Auth: server-side sessions, argon2, TOTP

**Decision.** Server-side sessions with secure cookies for the web UI; per-user API tokens for
programmatic access. `argon2` 0.45 for password hashing. `otpauth` 9.5 for TOTP MFA.
`ldapts` for directory auth and `openid-client` 6.8 for OIDC in `[V2]`.

**Why.** Sessions are revocable — for an internal ops tool where "disable that account now"
must actually work, that beats stateless JWTs. argon2 over bcrypt for memory-hardness.
`otpauth` over the abandoned `speakeasy` (last published 2016).

Credentials for monitored devices are **encrypted at rest** with a key from the OS keystore or
an operator-supplied key file, and are **write-only through the API** — never returned, even to
administrators. This is a deliberate improvement on PRTG, which keeps them in a config XML.

---

## Decision 10 — Packaging: native service, Docker for dev only

**Decision.**

| Target             | Mechanism                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux production   | `systemd` units for `ms-core` and `ms-probe`: `Restart=on-failure`, `WatchdogSec` with `sd_notify` heartbeats, cgroup limits, dedicated service user |
| Windows production | **WinSW** (actively maintained, MIT) wrapping `node.exe`. **Not** `node-windows`, which has sat at `1.0.0-beta.8` since 2022                         |
| Distribution       | esbuild bundle + the runtime's `node_modules` for native addons, in a versioned tarball/MSI with an install script                                   |
| Development        | Docker Compose: Postgres+TimescaleDB, MailHog, an SNMP simulator, a syslog generator, a flow exporter                                                |

**Node SEA** (single executable applications) is at stability 1.1 — Active Development, with
manual handling required for native addons. We have `argon2`, and `better-sqlite3` if it is ever
used. **`net-snmp` is not one of them** — measured while building `T-01`: `net-snmp` 3.26.3
depends only on `asn1-ber` and `smart-buffer`, neither of which has a `gypfile` or any
dependency of its own. Three pure-JavaScript packages, so the SNMP stack costs the installer
nothing.

**`ssh2` needs a note rather than a correction** (measured while building `T-07`): its runtime
dependencies `asn1` and `bcrypt-pbkdf` are pure JavaScript, but it declares `cpu-features` and
`nan` as **optional** dependencies, and `cpu-features` is a `node-gyp` build. We do not build
them — the repo runs npm with install scripts disabled, and `ssh2` falls back to its JavaScript
implementations without them. So the SSH stack costs the installer nothing either, *provided the
release build keeps install scripts off*. Turning them on to satisfy some other package would
quietly add a compiled addon to the tarball, which is the thing this decision exists to avoid.

Revisit when SEA stabilises. `pkg` is deprecated by Vercel; `nexe`
has been in beta for years. Neither is an option.

---

## Decision 11 — Observability of the monitor itself

**Decision.** Ship Core Health and Probe Health as real sensors from Phase 1, backed by
`@prometheus-io/client` metrics (`prom-client` under its current name) and structured
`pino` logs.

Metrics that must exist before we have any right to trust the system: scheduler lag p50/p95/p99,
deferred-check count, worker pool utilisation, check duration by sensor type, ingestion queue
depth, DB write latency, notification queue depth and delivery failures, probe connection state
and spool depth.

**Why.** A monitoring system that cannot monitor itself is not trustworthy, and every
performance decision above (timing wheel, pool bounds, backpressure) is unverifiable without
these numbers.

---

## Decision 12 — Testing

- `node:test` for backend unit and integration tests — zero dependencies, which matters in a
  project already carrying several native addons.
- `vitest` 4 for the React frontend.
- **A protocol simulator harness** we write ourselves: mock SNMP agents, an HTTP server with
  scriptable latency and failure, an SSH server, a syslog sender, a flow exporter. Generic HTTP
  load tools cannot exercise the scheduler; this harness is what lets us honestly claim 5,000
  sensors.
- `autocannon` and `artillery` for the API and WebSocket layers.
- Soak tests are a release gate: 5,000 simulated sensors for 24 hours with no memory growth,
  no scheduler lag drift, and correct rollups.

---

## Summary of the stack

| Layer                  | Choice                                                       |
| ---------------------- | ------------------------------------------------------------ |
| Runtime                | Node.js current LTS, TypeScript                              |
| API / web              | Fastify 5, `@fastify/websocket`, OpenAPI                     |
| Frontend               | React 19, Vite 8, uPlot + ECharts                            |
| Storage                | PostgreSQL + TimescaleDB (Apache-licensed features only)     |
| Scheduling             | In-house hashed timing wheel                                 |
| Execution              | Bounded worker_threads pool + child processes for shell-outs |
| Transport (probe↔core) | Outbound mTLS, disk-spooled, incremental config push         |
| Auth                   | Sessions + API tokens, argon2, TOTP; LDAP/OIDC later         |
| Supervision            | systemd (Linux), WinSW (Windows)                             |
| Dev environment        | Docker Compose — **development only**                        |
| Observability          | pino, @prometheus-io/client, self-monitoring sensors        |

## Open questions to resolve before Phase 1 closes

1. Is TimescaleDB practical on Windows Server, or is Windows a plain-Postgres deployment?
2. Raw-socket ICMP vs system-binary ping — measured throughput and accuracy at 1,000 targets.
3. ~~Do we need a WinRM client written in-house, or is a PowerShell shell-out from a
   Windows-hosted probe sufficient for the v1 WMI sensor set?~~ **Settled by `T-09`: the
   shell-out.** WS-Management's only widely-permitted authentication is NTLMv2 or Kerberos —
   Basic needs `AllowUnencrypted` or a certificate on every machine — so a client is a
   cryptographic implementation rather than a protocol port, written to reach machines a Windows
   probe already reaches with a supported client. The cost is that a Linux-only installation
   cannot monitor Windows, which is stated to the operator rather than worked around. Revisit if
   a cross-platform WinRM client becomes worth it; the sensor types call a transport interface
   and would not change.
4. Config storage: pure database, or database plus an exportable declarative file for
   version-controlled setups? (Leaning: database of record, YAML export/import in `[V2]`.)

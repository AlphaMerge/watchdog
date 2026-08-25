# MonitoringSystem — project instructions

A PRTG-class infrastructure monitoring system in Node.js/TypeScript.

## Read these first

| Document                       | What it is                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `docs/CAPABILITIES.MD`         | What PRTG does, with `[V1]` / `[V2]` / `[OUT]` scope markers. **The scope contract.** |
| `docs/WORKFLOW.MD`             | How the system must behave over time — loops, lifecycles, state machines              |
| `docs/ADR-001-architecture.md` | Stack and architecture decisions with rationale                                       |
| `docs/PLAN.md`                 | Phased roadmap with exit criteria per phase                                           |
| `docs/TASKS.md`                | Ticket-sized backlog — **pick work from here**                                        |

Before starting a task, read its phase section in `PLAN.md` and any `WORKFLOW.MD` section it
references. Before proposing an approach that contradicts `ADR-001`, say so explicitly and
explain why — do not quietly diverge.

---

## Hard constraints

1. **Production is a standalone native service.** systemd on Linux, WinSW on Windows. Never
   introduce a production dependency that assumes a container runtime, an orchestrator, or a
   cloud-managed service.
2. **Docker is development-only.** `docker-compose.dev.yml` runs Postgres/TimescaleDB, MailHog
   and the protocol simulators for local work. Nothing in `packages/` may require Docker at
   runtime.
3. **No new always-on service dependencies without an ADR.** PostgreSQL is the only one. Adding
   Redis, a message broker or a second database means writing an ADR and getting agreement
   first — every one of them is another thing an operator has to install and supervise.
4. **TimescaleDB Community licence, accepted for one feature only.** Only hypertables,
   `time_bucket` and `drop_chunks` are Apache 2.0 — continuous aggregates, native compression,
   compression and retention *policies*, `add_job` and `time_bucket_gapfill` are all Timescale
   License (measured: `docs/findings/2026-08-25-timescaledb-licensing.md`). We accept that
   licence for **native compression and nothing else**: it is worth 12.5× on disk and has no
   Apache substitute at any price, while the rollup comparison was close to a wash
   (`docs/findings/2026-08-25-rollup-storage-spike.md`). Rollup tiers, retention and the job
   that drives them are written in `packages/core` regardless, so moving off TimescaleDB would
   cost compression and nothing else. Depending on any further TSL feature needs an ADR. The
   licence permits free self-hosted use but forbids offering this as a database-as-a-service,
   and it attaches to us if we ever ship TimescaleDB binaries inside our own installer rather
   than telling the operator to install it — settle that before `H-05`/`H-06`.

---

## Architecture in one screen

```
ms-core (service)                        ms-probe (service, local and remote)
 ├── Fastify API + web UI + WS push       ├── hashed timing wheel scheduler
 ├── config store, RBAC, audit            ├── bounded worker_threads pool
 ├── ingestion → PostgreSQL/Timescale     ├── child processes for shell-outs
 ├── trigger engine + notifications       ├── syslog / SNMP-trap / flow listeners
 └── probe endpoint (mTLS)                └── disk spool when core is unreachable
```

Probes always dial **out** to the core. The local probe runs the same code as a remote one.

## Stack

| Layer             | Choice                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| Runtime           | Node.js current LTS, TypeScript strict                                   |
| API               | Fastify 5, `@fastify/websocket`, JSON-schema validation → OpenAPI        |
| Frontend          | React 19, Vite 8, uPlot (dense time series) + ECharts (topology/summary) |
| Storage           | PostgreSQL + TimescaleDB, single database for config **and** metrics     |
| Scheduling        | In-house hashed timing wheel — not BullMQ, not `setTimeout`-per-sensor   |
| Auth              | Server-side sessions + API tokens, `argon2`, `otpauth` TOTP              |
| Logging / metrics | `pino`, `prom-client`                                                    |
| Tests             | `node:test` (backend), `vitest` (frontend), in-house protocol simulators |

---

## Non-negotiable design rules

**Sensor types are plugins.** Every check implements the `SensorType` contract: `id`,
`category`, `paramsSchema` (JSON Schema — it generates the UI form and validates the API),
`channels()`, `execute(ctx)` honouring `ctx.signal`, and `costHint`. Never add a sensor type by
extending a switch statement. Adding a type should be a one-file, half-day job.

**Nothing blocks the scheduler.** Every check runs in a worker or a child process, with a
timeout and an `AbortSignal`. If a check can hang, it runs in a child process.

**Backpressure is visible, never silent.** When the pool saturates, count the deferred checks
and raise scheduler lag on Probe Health. Never queue unboundedly, never drop without counting.

**No-data is not zero.** A Down sensor records no channel values. Gaps must survive storage,
rollup, query and rendering as gaps. Graphs break the line; they never draw to zero.

**Uptime comes from state history, not samples.** Downtime and SLA are computed from
`sensor_state`, so they stay correct across rollups and gaps.

**Inheritance is resolved in one place.** All inheritable settings go through the resolver in
`packages/core`. Never reimplement parent-walking locally.

**Credentials are write-only.** Monitored-device credentials are encrypted at rest and never
returned by any API route, to anyone, including administrators. Check this on every new endpoint
that touches an object.

**One outage, one alarm.** Dependencies, notification latency and summarisation exist for this.
Any change that could multiply alarms needs a scenario test.

**The system monitors itself.** Core Health and Probe Health are real sensors. Any new
subsystem with a queue, a pool or a connection adds a metric to one of them.

---

## Conventions

- **TypeScript strict**, no `any` in committed code. Prefer discriminated unions over
  optional-field soup for check results and events.
- **Validate at boundaries** with JSON Schema (Fastify) — API inputs, sensor params, config
  files, probe messages.
- **Errors carry context**: a check failure records the sensor id, the target, the phase it
  failed in, and the underlying error. "ETIMEDOUT" alone is not a diagnosis.
- **Structured logs only** (`pino`), with correlation ids for requests and check executions.
  Never `console.log` in `packages/`.
- **Time is monotonic for scheduling, wall-clock for data.** `process.hrtime.bigint()` drives
  the wheel; samples carry `timestamptz`. Handle clock jumps explicitly.
- **Migrations are forward and back.** Every schema change ships with a tested rollback.
- **Naming** follows the object model: probe / group / device / sensor / channel. Do not invent
  synonyms (no "node", "host", "monitor", "metric" for these concepts).
- **Time-series access goes through the repository interface**, so the storage engine can be
  swapped.
- Charts follow the `dataviz` skill guidance. UI work follows WCAG 2.1 AA.

## Testing expectations

- New logic ships with unit tests. New sensor types ship with tests against the protocol
  simulator harness, not live network targets.
- State machine, inheritance and pause-precedence changes need property-based or table-driven
  tests — these are where the subtle bugs live.
- Anything touching alarm volume needs a scenario test (see `M-17` in `TASKS.md`).
- Performance claims need a measurement committed to the repo, not an assertion.

## Things that have already been decided — don't relitigate without an ADR

- Timing wheel over BullMQ/Redis (standalone constraint).
- Postgres+TimescaleDB over ClickHouse/Influx/VictoriaMetrics (one service to install).
- Separate probe process even on a single host (isolation, and remote probes share the code).
- System `ping` binary as the default ICMP path, raw socket as an opt-in fast path.
- We build syslog, NetFlow/IPFIX and WMI transports ourselves — npm has no maintained options.
- Not building at all: packet sniffing, the full 250-sensor catalogue, eHealth (DICOM/HL7)
  sensors, native mobile/desktop apps, event-log write-back, PRTG config-file compatibility
  (`CAPABILITIES.MD §15`). Deferred to v2, not abandoned: clustering, maps, reports, tickets,
  libraries, flow monitoring, LDAP/OIDC (see the v2 candidates in `TASKS.md`).

## Working agreements

- Keep `CAPABILITIES.MD` scope markers current when scope moves between `[V1]`, `[V2]` and
  `[OUT]`.
- Tick tasks in `TASKS.md` as they land; add new tasks rather than growing existing ones.
- When a phase's exit criteria are met, note the measured numbers in `PLAN.md`.
- Phase 2's 5,000-sensor benchmark (`P-15`) is the architecture go/no-go gate. Do not build
  Phase 3 on an unmeasured scheduler.

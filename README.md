# MonitoringSystem

A PRTG-class infrastructure monitoring system in Node.js and TypeScript.

Probes run checks against your devices, the core stores the results, evaluates state and sends
notifications. Production is a **standalone native service** — systemd on Linux, WinSW on
Windows — with PostgreSQL as its only always-on dependency.

**Status: Phase 0 (foundations) complete.** Both services start, talk to each other over mutual
TLS and install from a tarball. There is no monitoring yet — the object model is Phase 1 and the
scheduler is Phase 2. See [`docs/PLAN.md`](docs/PLAN.md).

## The documents

| Document                                                           | What it is                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`docs/CAPABILITIES.MD`](docs/CAPABILITIES.MD)                     | What PRTG does, with `[V1]`/`[V2]`/`[OUT]` markers. The scope contract.  |
| [`docs/WORKFLOW.MD`](docs/WORKFLOW.MD)                             | How the system must behave over time — loops, lifecycles, state machines |
| [`docs/ADR-001-architecture.md`](docs/ADR-001-architecture.md)     | Stack and architecture decisions, with rationale                         |
| [`docs/PLAN.md`](docs/PLAN.md)                                     | Phased roadmap with exit criteria                                        |
| [`docs/TASKS.md`](docs/TASKS.md)                                   | Ticket-sized backlog — **pick work from here**                           |
| [`docs/findings/`](docs/findings/)                                 | Measured results that change a documented assumption                     |
| [`docs/adding-a-sensor-type.md`](docs/adding-a-sensor-type.md)     | How to write a sensor type. One file, six members.                       |
| [`docs/installation.md`](docs/installation.md)                     | Installing, upgrading, and adding a remote probe                         |
| [`docs/administration.md`](docs/administration.md)                 | Roles and rights, credentials, pausing, what to watch                    |
| [`docs/troubleshooting.md`](docs/troubleshooting.md)               | Symptoms, and the number that diagnoses each one                         |
| [`docs/sizing.md`](docs/sizing.md)                                 | How much hardware, from measurements rather than estimates               |
| [`docs/sensor-reference.md`](docs/sensor-reference.md)             | Every sensor type — **generated from the catalogue**                     |
| [`docs/api-reference.md`](docs/api-reference.md)                   | Every route — **generated from the OpenAPI document**                    |
| [`docs/runbook-backup-restore.md`](docs/runbook-backup-restore.md) | Backing up, and restoring onto a host that is not the one it came from   |
| [`docs/runbook-field-test.md`](docs/runbook-field-test.md)         | The release-candidate field test, and what counts as passing it          |

## Layout

```
packages/shared   config loading, logging, lifecycle, the core↔probe wire protocol
packages/sensors  the SensorType contract and the catalogue — one file per sensor type
packages/core     ms-core  — API, storage, notifications, probe endpoint
packages/probe    ms-probe — scheduler, check execution, protocol listeners
packages/web      web UI (Phase 5)
deploy/           systemd units, WinSW definitions, the installer
scripts/          development and packaging scripts
```

## Development

**Everything runs in Docker.** You do not need Node, PostgreSQL or OpenSSL on your machine —
only Docker. This is a development convenience: nothing in `packages/` requires a container at
runtime, and production never sees one.

```bash
npm run dev
```

That starts PostgreSQL + TimescaleDB, MailHog, an SNMP simulator and a syslog sender. Then use
the pinned Node 24 toolchain container for everything else:

```bash
scripts/dev.sh npm install
```

```bash
scripts/dev.sh npm run build
```

```bash
scripts/dev.sh npm test
```

```bash
scripts/dev.sh npm run lint
```

`scripts/dev.sh` with no arguments drops you into a shell in that container.

If you would rather use a local Node (24 or newer), every one of those works without the
wrapper — `npm install`, `npm test`, and so on.

### Development services

| Service                  | Where                                                                  | Notes                                             |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- |
| PostgreSQL + TimescaleDB | `localhost:5432`                                                       | database `monitoring`, user/password `monitoring` |
| MailHog                  | SMTP `localhost:1025`, UI [localhost:8025](http://localhost:8025)      | notification sink for Phase 4                     |
| SNMP simulator           | `localhost:1161/udp`                                                   | target for the SNMP sensors in Phase 6            |
| syslog sender            | → `localhost:1514/udp`                                                 | synthetic messages for the syslog receiver        |
| monitoring target        | HTTP `localhost:8081`, SSH `localhost:2222`, SNMP `localhost:1162/udp` | a Linux box to point sensors at — see below       |

The database runs with `timescaledb.license=timescale`, matching production. We depend on the
Timescale Community licence for exactly one feature — native compression, worth about 10x on
disk with no Apache-licensed substitute — and write the rollup tiers, retention and the loop that
drives them ourselves, so nothing else is tied to the engine. The reasoning and the measurements
are in [Decision 4 of ADR-001](docs/ADR-001-architecture.md) and
[the storage spike](docs/findings/2026-08-25-rollup-storage-spike.md).

Setting `TIMESCALEDB_LICENSE=apache` starts the database under the Apache-only feature set. It is
worth doing occasionally: it makes any new dependency on a Timescale-License feature fail
immediately, and migration 004 refuses to apply at all, with a message saying why.

### The monitoring target

`snmpsim` and `syslog-sender` each speak one protocol. `target` is a _device_: one Debian box
answering ICMP, HTTP, SSH and SNMP at once, which is the shape the device/sensor object model is
built around. It is built from [`dev/target/`](dev/target/) and the probe reaches it as `target`
on the compose network — the published loopback ports are only so you can poke at it by hand.

| Protocol | Where                              | Notes                                                      |
| -------- | ---------------------------------- | ---------------------------------------------------------- |
| ICMP     | `target`                           | no daemon; the container answers ping                      |
| HTTP     | `target:80`, host `:8081`          | `/` contains `monitoring-target-ok`, `/down` returns 503   |
| SSH      | `target:22`, host `:2222`          | user/password from `TARGET_SSH_USER`/`TARGET_SSH_PASSWORD` |
| SNMP     | `target:161/udp`, host `:1162/udp` | v2c, community `public`                                    |

Nothing checks it yet: sensor types arrive with `P-05`, and `R-04` is what tells a probe which
sensors it owns. Until both land, a sensor object is configuration the probe never hears about.

### Running the two services locally

```bash
scripts/dev-certs.sh
```

issues a development CA and a certificate for each side into `dev/tls/`. Then:

```bash
scripts/dev.sh "node packages/core/dist/src/main.js --config dev/core.json"
```

```bash
scripts/dev.sh "node packages/probe/dist/src/main.js --config dev/probe.json"
```

`scripts/dev-e2e.sh` does both, kills the core, and shows the probe reconnecting on its own.

For a long-running pair instead — the API published on loopback so a browser can reach it:

```bash
npm run dev:services
```

`stop`, `restart` and `logs` are the other arguments to `scripts/dev-services.sh`.

### The web UI

```bash
npm run dev:ui
```

[localhost:5173](http://localhost:5173) — Vite with hot reload, in a container, proxying `/api`
to the core. In production there is no dev server: `ms-core` serves the built assets itself from
`api.webRoot` (`ADR-001` Decision 8). See [`packages/web/README.md`](packages/web/README.md).

The proxy rewrites `Host`, so a write from `:5173` reaches the core looking cross-origin and the
CSRF guard would refuse it. `dev/core.json` lists both spellings of the dev server in
`api.allowedOrigins`, which is the same key an install behind a reverse proxy on a different
hostname needs, for the same reason (`A-11`).

### Making it actually scan something

A probe branch has to be claimed by the probe that connects, or it is told to scan nothing:

```bash
curl -X PATCH http://127.0.0.1:8080/api/v1/objects/2 -H 'content-type: application/json' -H "if-match: $(curl -sSI http://127.0.0.1:8080/api/v1/objects/2 | grep -i ^etag: | tr -d '\r' | cut -d' ' -f2)" -d '{"kind":"probe","gid":"dev-local-probe"}'
```

`dev-local-probe` is the GID in `dev/probe.json`. `R-01` replaces claiming a branch by hand with
an enrolment flow; until then this is how a probe is told which subtree is its own.

With that done, the core pushes the branch's sensors, the probe schedules them and checks start
running. `MS_LOG_LEVEL=debug npm run dev:services` shows each one finishing — they are logged at
debug because at five thousand sensors a minute an info line per check is the whole journal.

Results are written to `dev/data/spool` before anything else touches them and drained to the core
as it acknowledges them, so they survive the core being down and the probe being restarted
(`R-02`). They land in the `sample` hypertable and are readable through
`GET /api/v1/sensors/{id}/history`.

Every result also decides a state (`M-02`). A sensor goes **Unknown → Up** on its first
successful scan, **Up → Warning → Down** across two consecutive failures, and back to **Up** on
recovery — each change appended to `sensor_state` with what it changed from, why, and the
probe's own message. A failed check records no readings at all, so a graph breaks the line
rather than drawing it to zero. `GET /api/v1/sensors/{id}/state` is the current answer for one
sensor; listings carry `state` so the tree can colour itself.

How many consecutive failures are reported as Warning before Down is the inheritable setting
`scan.retryWarnings` (`M-03`): zero is immediate-down, the default is one warning interval, and a
group can set it for everything beneath it.

Any object can be **paused** (`M-08`) — indefinitely, for a duration, or until a moment, with a
message. Pausing a device pauses every sensor beneath it, immediately: they change state in the
request, and their probe stops being told to scan them at all. Only the object that was directly
paused can be resumed, and the refusal names the one that can. A resumed sensor reads Unknown
until its next scan, never the state it had before.

```bash
curl -X POST http://127.0.0.1:8080/api/v1/objects/7/pause -H 'content-type: application/json' -d '{"minutes":15,"message":"swapping a PSU"}'
```

Before any of that, a reading is scaled by the channel's factors and passed through its spike
filter (`M-07`): bytes become bits, centidegrees become degrees, and a wrapped counter reporting
four billion is discarded rather than flattening the graph. The **scaled** value is what is
stored, judged and drawn — one number, so a chart can never disagree with the alarm that fired.
A discarded reading leaves a gap, not a zero, and decides nothing.

A channel whose reading is a status code rather than a measurement is judged by a **lookup**
(`M-06`) instead of by limits: `2` becomes "down" and Down, `1` becomes "up" and Up. Built-in
definitions ship with the build; an operator's own go in `<dataDir>/lookups` as JSON and replace
a built-in with the same id. `GET /api/v1/lookups` lists what loaded — and what was refused, and
why.

Channels carry limits (`M-04`): upper and lower thresholds for warning and error, with a custom
message each. They are immediate — a reading past an error limit is Down on the very first
sample, with no two-step rule, because a disk that is 99% full is 99% full. Editing one takes
effect on the next scan, not the next restart.

```bash
curl -X PATCH http://127.0.0.1:8080/api/v1/objects/8/channels/rtt -H 'content-type: application/json' -d '{"limits":{"upperWarning":50,"upperError":200}}'
```

## Configuration

Layered: **schema defaults → configuration file → environment**, validated once at startup. A
bad setting stops the process with every problem listed, and an unknown setting is an error —
a typo must never be silently ignored.

```bash
MS_API__PORT=9090 MS_DATABASE__SSL=true ms-core --config /etc/ms/core.json
```

`__` separates levels and `SNAKE_CASE` maps to `camelCase`, so `MS_DATABASE__POOL_SIZE` sets
`database.poolSize`. Secrets can be read from a file instead of the environment:

```bash
MS_DATABASE__PASSWORD__FROM_FILE=/run/credentials/ms-core.service/db-password
```

which is how the systemd unit passes the database password via `LoadCredentialEncrypted=`.

## Installing

```bash
scripts/package.sh
```

produces `release/ms-<version>-<os>-<arch>.tar.gz`. On the target host (Node 24+, systemd,
openssl):

```bash
tar -xzf ms-0.1.0-linux-x86_64.tar.gz && cd ms-0.1.0 && sudo ./install.sh
```

The installer creates the `ms-core` and `ms-probe` service users, issues the probe-channel CA
and certificates, generates a shared access key, installs the units and starts both services.
`--probe-only` installs just a probe on a remote host.

`scripts/smoke-install.sh` runs exactly that against a clean Debian box with a real systemd and
asserts both services reach `active` and stop with exit 0. It runs on every commit in CI.

## Conventions

Enforced by `npm run lint`, not by review:

- TypeScript strict, no `any`
- No `console.log` in `packages/` — structured `pino` logs only
- Validate at boundaries with JSON Schema: API inputs, sensor params, config files, probe messages
- Errors carry context: the object, the phase, the underlying cause

See [`CLAUDE.md`](CLAUDE.md) for the full set and the hard constraints behind them.

## Infrastructure

This repo has no dedicated GCP project.

Estate-wide notes — what runs where, which project owns which DNS zone, and
runbooks for undeleting a project or moving a DNS zone — live in
[AlphaMerge/infrastructure](https://github.com/AlphaMerge/infrastructure).

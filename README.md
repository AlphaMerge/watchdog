# MonitoringSystem

A PRTG-class infrastructure monitoring system in Node.js and TypeScript.

Probes run checks against your devices, the core stores the results, evaluates state and sends
notifications. Production is a **standalone native service** — systemd on Linux, WinSW on
Windows — with PostgreSQL as its only always-on dependency.

**Status: Phase 0 (foundations) complete.** Both services start, talk to each other over mutual
TLS and install from a tarball. There is no monitoring yet — the object model is Phase 1 and the
scheduler is Phase 2. See [`docs/PLAN.md`](docs/PLAN.md).

## The documents

| Document                                                       | What it is                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`docs/CAPABILITIES.MD`](docs/CAPABILITIES.MD)                 | What PRTG does, with `[V1]`/`[V2]`/`[OUT]` markers. The scope contract.  |
| [`docs/WORKFLOW.MD`](docs/WORKFLOW.MD)                         | How the system must behave over time — loops, lifecycles, state machines |
| [`docs/ADR-001-architecture.md`](docs/ADR-001-architecture.md) | Stack and architecture decisions, with rationale                         |
| [`docs/PLAN.md`](docs/PLAN.md)                                 | Phased roadmap with exit criteria                                        |
| [`docs/TASKS.md`](docs/TASKS.md)                               | Ticket-sized backlog — **pick work from here**                           |
| [`docs/findings/`](docs/findings/)                             | Measured results that change a documented assumption                     |

## Layout

```
packages/shared   config loading, logging, lifecycle, the core↔probe wire protocol
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

| Service                  | Where                                                             | Notes                                             |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------- |
| PostgreSQL + TimescaleDB | `localhost:5432`                                                  | database `monitoring`, user/password `monitoring` |
| MailHog                  | SMTP `localhost:1025`, UI [localhost:8025](http://localhost:8025) | notification sink for Phase 4                     |
| SNMP simulator           | `localhost:1161/udp`                                              | target for the SNMP sensors in Phase 6            |
| syslog sender            | → `localhost:1514/udp`                                            | synthetic messages for the syslog receiver        |

The database runs with `timescaledb.license=timescale`, matching production. We depend on the
Timescale Community licence for exactly one feature — native compression, worth about 10x on
disk with no Apache-licensed substitute — and write the rollup tiers, retention and the loop that
drives them ourselves, so nothing else is tied to the engine. The reasoning and the measurements
are in [Decision 4 of ADR-001](docs/ADR-001-architecture.md) and
[the storage spike](docs/findings/2026-08-25-rollup-storage-spike.md).

Setting `TIMESCALEDB_LICENSE=apache` starts the database under the Apache-only feature set. It is
worth doing occasionally: it makes any new dependency on a Timescale-License feature fail
immediately, and migration 004 refuses to apply at all, with a message saying why.

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

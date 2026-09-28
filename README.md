# MonitoringSystem

A PRTG-class infrastructure monitoring system in Node.js and TypeScript.

Probes run checks against your devices, the core stores the results, evaluates state and sends
notifications. Production is a **standalone native service** under systemd, with PostgreSQL as
its only always-on dependency. **1.0 runs on Linux only.** Windows — the WinSW service, the MSI and
the four WMI sensor types — is release 1.1: its code stays in the tree, and what it waits for is a
Windows machine to prove it on (`docs/TASKS.md`, _Release 1.1 — Windows_).

**Status: Phases 0–9 complete; Phase 10 (hardening and release) in progress.** The object model,
the scheduler, the state machine, notifications, the web UI, ~43 sensor types, discovery, remote
probes and RBAC are in. What is left is the release work: the Ubuntu half of the field test is
proved and in CI, and the rest of `H-09` needs hardware. See [`docs/PLAN.md`](docs/PLAN.md).

## The documents

Start at [`docs/README.md`](docs/README.md) — it indexes everything below and says which document
answers which question.

| Document                                                           | What it is                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`docs/CAPABILITIES.MD`](docs/CAPABILITIES.MD)                     | What PRTG does, with `[V1]`/`[V2]`/`[OUT]` markers. The scope contract.  |
| [`docs/WORKFLOW.MD`](docs/WORKFLOW.MD)                             | How the system must behave over time — loops, lifecycles, state machines |
| [`docs/ADR-001-architecture.md`](docs/ADR-001-architecture.md)     | Stack and architecture decisions, with rationale                         |
| [`docs/PLAN.md`](docs/PLAN.md)                                     | Phased roadmap with exit criteria                                        |
| [`docs/TASKS.md`](docs/TASKS.md)                                   | Ticket-sized backlog — **pick work from here**                           |
| [`docs/findings/`](docs/findings/)                                 | Measured results that change a documented assumption                     |
| [`docs/adding-a-sensor-type.md`](docs/adding-a-sensor-type.md)     | How to write a sensor type. One file, six members.                       |
| [`docs/state-machine.md`](docs/state-machine.md)                   | Sensor state and pause precedence — transitions, invariants, precedence  |
| [`docs/web-ui.md`](docs/web-ui.md)                                 | Every view in the browser, and what each one is for                      |
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
hostname needs, for the same reason (`A-19`).

### Starting again from nothing

```bash
scripts/dev-reset.sh
```

Drops the `monitoring` database and removes the three things a fresh install has none of — the
vault key, the generated password and the probe's spool — then starts the core so it migrates and
bootstraps. It names what it will destroy and asks first; `--yes` for a script.

**Worth doing occasionally, and not only when something is broken.** A development database that
has been migrated forward for weeks is not the thing we ship, and the ways it differs are
invisible precisely because nobody chose them. `P-183` is the example: the bootstrap administrator
was created in no group, so on a genuinely new installation the only account was refused by every
object-scoped route — and every environment anybody used had been _upgraded_ into user groups by a
migration whose backfill quietly fixed it. It survived for as long as it did because nothing
anybody ran was new.

Nothing under `dev/data` is touched beyond those three, and no other database is — including the
`ms_test_*` scratch ones the suites make. The 5,000-sensor load is reproducible afterwards with
`scripts/soak.sh --sensors 5000`.

### Talking to the API by hand

`dev/core.json` runs with `api.requireAuthentication` on, which is what a stock install does, so
the calls below need a credential. One command mints one:

```bash
eval "$(scripts/dev-token.sh)"
```

That logs in with the password the core generated on its first boot — `dev/data/first-admin-password`
— issues a full-scope API token from that session, and exports it as `MS_TOKEN` in the current
shell. `scripts/soak.sh` and the smoke harnesses read the same variable, and
`scripts/lib/api-auth.sh` is the one place that turns it into a header.

The UI at :5173 asks for that same password, and makes you replace it before it shows you
anything else (`U-17`). Once you have, `dev-token.sh` cannot log in any more and says so — issue
a token from the UI instead.

### Making it actually scan something

A probe connects on its own and then waits: it is in the queue, `pending`, scanning nothing until
somebody says which part of the tree is its own. That is `R-01`'s enrolment flow, and it is two
calls.

```bash
curl -s http://127.0.0.1:8080/api/v1/probes -H "authorization: Bearer $MS_TOKEN"
```

`dev-local-probe` is the GID in `dev/probe.json`, and on a new installation it is the only thing
in the list. Give it an object to own, then approve it onto that object:

```bash
curl -X POST http://127.0.0.1:8080/api/v1/objects -H "authorization: Bearer $MS_TOKEN" -H 'content-type: application/json' -d '{"kind":"probe","parentId":1,"name":"Development local probe"}'
```

```bash
curl -X POST http://127.0.0.1:8080/api/v1/probes/dev-local-probe/approve -H "authorization: Bearer $MS_TOKEN" -H 'content-type: application/json' -d '{"objectId":2,"local":true}'
```

`objectId` is the `id` the first call answered with — 2 on a new installation, where the root is
1 and nothing else exists yet. `local` marks the probe that runs beside this core, which is what
stops it being deleted like a remote one.

The probe's connection is closed as it is approved, and it comes back about a second later
through the handshake that issues both its key and its first configuration (`P-189`). With that
done, the core pushes the branch's sensors, the probe schedules them and checks start running. `MS_LOG_LEVEL=debug npm run dev:services` shows each one finishing — they are logged at
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
curl -X POST http://127.0.0.1:8080/api/v1/objects/7/pause -H "authorization: Bearer $MS_TOKEN" -H 'content-type: application/json' -d '{"minutes":15,"message":"swapping a PSU"}'
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
curl -X PATCH http://127.0.0.1:8080/api/v1/objects/8/channels/rtt -H "authorization: Bearer $MS_TOKEN" -H 'content-type: application/json' -d '{"limits":{"upperWarning":50,"upperError":200}}'
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

## Continuous integration

**CI runs on self-hosted runners, on this machine.** GitHub-hosted jobs cannot start while the
account's Actions spending limit is unpaid — they fail in seconds with zero steps and no logs,
only a check-run annotation — so the workflow targets `self-hosted` instead (`P-198`).

Bring the runner up, or back:

```
scripts/dev-runner.sh                 # one runner
RUNNER_COUNT=2 scripts/dev-runner.sh  # two, so two jobs run at once
```

It builds `dev/runner/Dockerfile`, mints a registration token with `gh`, and starts a container
per runner labelled `watchdog-linux`. Each gets its own work directory, because two agents sharing
one would hand concurrent jobs the same checkout (`P-201`). `docker start watchdog-runner-1` is
enough after a reboot; re-running the script re-registers the pool and is also how you shrink it.

The runner drives **this machine's** Docker through a mounted socket, which is what lets the jobs
run the toolchain through compose and boot privileged systemd boxes. Two consequences worth
knowing:

- CI's containers and volumes are scoped so they cannot touch yours — the compose project is
  `watchdog-ci`, its PostgreSQL is on `MS_DEV_PG_PORT` (55432) rather than your 5432, and the
  smoke harnesses name their boxes per run and reap only their own (`P-200`).
- A CI run and a `scripts/smoke-*.sh` you start by hand can happily overlap.

Three repository variables steer it, and each is one `gh variable set` away from changing where a
job runs with no edit to the workflow:

| Variable            | Effect                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI_RUNNER_LINUX`   | JSON array of labels for the Linux jobs. Unset means `["self-hosted","watchdog-linux"]`                                                                                                        |
| `CI_RUNNER_WINDOWS` | The label of a Windows runner. **Unset, so the two Windows jobs are skipped** — setting it brings back `H-06`'s MSI install and `S-11`'s TimescaleDB provisioning, and the artifact they share |
| `CI_DB_HOST`        | Where the tests reach the CI database. Unset means `host.docker.internal`, which is how a containerised runner reaches a port published on the host                                            |

## Infrastructure

This repo has no dedicated GCP project.

Estate-wide notes — what runs where, which project owns which DNS zone, and
runbooks for undeleting a project or moving a DNS zone — live in
[AlphaMerge/infrastructure](https://github.com/AlphaMerge/infrastructure).

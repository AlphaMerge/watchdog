# Installing MonitoringSystem

Two services and one database. Neither service needs a container runtime, an orchestrator or
anything cloud-managed — that is a hard constraint, not a preference, and it is why the whole
procedure below is a tarball and a shell script.

- **`ms-core`** holds the configuration, the database, the API and the web UI.
- **`ms-probe`** runs the checks. One is installed beside the core; more are installed on other
  hosts, and run exactly the same code.
- **PostgreSQL with TimescaleDB** is the only always-on dependency there is.

---

## Before you start

| | |
| --- | --- |
| OS | Linux with systemd, or Windows with WinSW |
| Node.js | 22 or newer, on `PATH` |
| PostgreSQL | with the TimescaleDB extension available — 17 is what everything here is measured and tested on |
| `openssl` | on `PATH` — the installer issues the probe-channel certificates with it |
| Privileges | `root`, to create the service users and the units |

The installer refuses rather than half-installing when any of those is missing, and says which.

**The database is not installed for you.** TimescaleDB's licence permits free self-hosted use but
attaches to whoever ships its binaries, so this project tells you to install it rather than
bundling it (`CLAUDE.md`, "TimescaleDB Community licence"). Use your distribution's packages and
the TimescaleDB project's own repository.

### Sizing

Proper sizing guidance is `H-08` and is not written yet, because it depends on a soak that has
not been run. What *has* been measured is the storage, in
[`docs/findings/2026-08-25-timeseries-sizing.md`](findings/2026-08-25-timeseries-sizing.md):

- **99.3 bytes per reading** on disk uncompressed, indexes included.
- At the v1 target of 5,000 sensors on a 60-second interval — about 21.6 million rows a day —
  that is **~2.8 GB a day**, or **~80 GB** for the 40 days of raw data PRTG keeps.
- With TimescaleDB's native compression, the same 40 days measured **12.5× smaller: ~6.4 GB**
  ([the rollup spike](findings/2026-08-25-rollup-storage-spike.md)).

Take anything about CPU and RAM from your own trial until `H-08` lands. The one number worth
planning around is TimescaleDB's: the recent working set should fit in roughly a quarter of RAM,
which is what the one-day chunk interval was chosen against.

---

## 1. The database

Create the database and a role that owns it. The core needs no superuser rights of its own after
this — the one thing that does need them is a *restore*, which is
[`docs/runbook-backup-restore.md`](runbook-backup-restore.md).

```sql
CREATE ROLE monitoring LOGIN PASSWORD 'choose-something-better-than-this';
CREATE DATABASE monitoring OWNER monitoring;
\c monitoring
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

The schema itself is not created here. `ms-core` migrates on startup, and refuses to start
against a schema it does not recognise rather than running against one it might corrupt.

## 2. The application

Unpack the release and run the installer from inside it:

```bash
sudo ./install.sh
```

That creates the `ms-core` and `ms-probe` service users, lays out `/opt/ms`, `/etc/ms` and
`/var/lib/ms-*`, issues the probe-channel CA and certificates, generates the probe access key,
installs both systemd units, and enables and starts them.

- `--probe-only` on a host that is only running a remote probe.
- `--core-only` where the probe is somewhere else entirely.
- `--no-start` to stage a machine that is not meant to come up yet.

## 3. The connection

The one thing the installer cannot guess. In `/etc/ms/core.json`:

```json
{
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "monitoring",
    "user": "monitoring",
    "password": "choose-something-better-than-this"
  }
}
```

Then check it before restarting anything:

```bash
sudo /opt/ms/bin/ms-core config check
```

`config check` loads the file exactly as the service would, reports **every** problem rather than
the first, and exits non-zero if the service would not start. It is worth running before a
restart every time, because the alternative is finding out from `journalctl` with the service
already down.

```bash
sudo systemctl restart ms-core
```

## 4. The first administrator

There is no default password, because an installation with a known one is worse than an
installation with none. On the first start against an empty database the core creates one
administrator with a generated password and writes it to:

    /var/lib/ms-core/first-admin-password

Mode 0600, owned by the service. It is deliberately **not** in the log — every logger here
redacts a field called `password`, and renaming it to slip past that would be defeating a control
that is doing its job. The log line says where the file is.

Log in, change the password when prompted, and delete the file.

The API and UI listen on **`127.0.0.1:8080`** by default — loopback, so that a fresh install is
not exposed before anyone has decided how it should be. Reach it over an SSH tunnel, or put a
reverse proxy in front of it and set `api.allowedOrigins` to the origin browsers will use.
Changing `api.host` to `0.0.0.0` also works and is your decision to make deliberately.

## 5. The local probe

The probe dials **out** to the core, never the other way round, so nothing needs to be opened
inbound on the probe host. It presents its certificate and the access key the installer generated,
and then waits: a new probe arrives in **`pending`** and is given no work at all until somebody
approves it.

Approve it under **Probes** in the UI, or:

```bash
curl -X POST http://127.0.0.1:8080/api/v1/probes/<gid>/approve -d '{"objectId":2,"local":true}'
```

`objectId` is the probe object in the tree this identity owns from now on. `"local": true` says
this is the probe running beside the core — it cannot be deleted, matching PRTG, and it is the
one that runs checks which have to execute on the core's own host. It is said explicitly rather
than guessed, because an address proves nothing on a host with several interfaces.

---

## Remote probes

**Every probe gets its own certificate and its own key.** Do not copy the core's `probe.crt` and
`probe.key` to another host: every probe would then present the same TLS identity, and revoking
one at the transport layer would not be possible at all. Issue a bundle instead.

On the **core** host:

```bash
sudo /opt/ms/bin/ms-enrol web-dc2 --out web-dc2.enrol
```

Carry that file to the probe host — it holds a private key and the enrolment key, so it is
written 0600, and it is meant to be carried once and deleted. Then, from inside a probe-only
tarball:

```bash
sudo ./install-probe.sh --enrolment web-dc2.enrol
```

That is a separate installer from `install.sh`, deliberately: a probe host should receive a
probe, not the core, the web UI and a flag trusted not to start them.

The core listens for probes on **23560** by default, separately from the API on 8080. That port
needs to be reachable from the probe host; nothing needs to be reachable *into* the probe.

The probe appears in the UI as `pending` within a few seconds of starting. Approve it, and give
it a branch of the tree to monitor. **A leaked bundle is an identity that can knock, not one that
monitors** — nothing it grants takes effect until a person approves that probe by name.

**A probe that cannot reach the core does not lose readings.** It spools them to its own disk and
replays them, rate-limited, when the connection comes back — so a network outage between a probe
and its core costs you the outage and not the data.

---

## Upgrading

Unpack the new release and run the same installer:

```bash
sudo ./install.sh
```

It replaces `/opt/ms/app`, `/opt/ms/bin` and `/opt/ms/web`, and **never overwrites anything in
`/etc/ms`**. Each configuration file is copied to a timestamped `.bak` beside it, and the version
this release ships is written alongside as `.json.new` so you can diff them.

Before restarting, the installer runs `config check` against every configuration file. **If a
setting was renamed or made required, it stops there** — the new application is on disk, the old
services are still running on the old version, and nothing has been restarted. Fix the
configuration and `systemctl restart ms-core ms-probe`.

Migrations run on startup and are reversible. A build started against a database migrated by a
*newer* build refuses to start; install the matching release rather than migrating backwards.

## Uninstalling

```bash
sudo systemctl disable --now ms-core ms-probe
sudo rm -rf /opt/ms /etc/systemd/system/ms-{core,probe}.service
sudo systemctl daemon-reload
```

`/etc/ms`, `/var/lib/ms-*` and the database are left alone deliberately — they hold the
configuration, the credential-vault key and every reading ever taken. Remove them when you mean
to, not as a side effect of removing the application.

---

## What to read next

- [`docs/administration.md`](administration.md) — accounts, credentials, backups, what to watch
- [`docs/troubleshooting.md`](troubleshooting.md) — when something does not work
- [`docs/runbook-backup-restore.md`](runbook-backup-restore.md) — before you need it

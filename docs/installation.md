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
| OS | Linux with systemd. **1.0 does not run on Windows** — the Windows service (WinSW), its MSI and the four `windows.*` sensor types are release 1.1 (`TASKS.md`, *Release 1.1 — Windows*) |
| Node.js | 22 or newer, on `PATH` |
| PostgreSQL | with the TimescaleDB extension available — 17 is what everything here is measured and tested on |
| TimescaleDB | **2.14.0 or newer.** `ms-core` refuses to start against an older one, names the version it found, and stops rather than restarting (exit 78). Tested on 2.29; see below for why 2.14 |
| `openssl` | on `PATH` — the installer issues the probe-channel certificates with it |
| `ping` | iputils' (`iputils-ping` on Debian and Ubuntu, `iputils` on RHEL), on every host that runs a probe — the ICMP sensors run it (`ADR-001` Decision 6). The packages depend on it, so `apt` and `dnf` install it for you |
| Privileges | `root`, to create the service users and the units |

The installer refuses rather than half-installing when any of those is missing, and says which.

**`ping` is a dependency, not a suggestion** (`H-31`). ICMP is the default availability check, and
without the binary every ping sensor reads Down with *the "ping" binary is not available on this
probe*. Container images of Ubuntu and Debian ship without one; real installations of them do not.

**The setup opens one kernel setting for it.** `ms-probe.service` runs with `NoNewPrivileges=`
and without `CAP_NET_RAW`, so the capability `ping` is installed with does nothing inside it. What
works is Linux's unprivileged ICMP socket, which only the groups in `net.ipv4.ping_group_range`
may open. RHEL 9 and its rebuilds open it to every group already. Debian and Ubuntu leave the
kernel's default, `1 0`: nobody — and a container does not show it, because Docker opens the range
inside every container, which is how the dress rehearsal pinged (`H-15`). When the range is still that default,
the setup sets it to the `ms-probe` group alone and writes the same to
`/etc/sysctl.d/60-ms-probe-ping.conf`, so a boot keeps it, and a purge removes it again
(*Uninstalling*). A range somebody has set is left as it
is; if it leaves `ms-probe` out, the setup says so, and you widen it to include that group's id.
Not `CAP_NET_RAW` in the unit instead: a raw socket would give the probe, and every script sensor
it runs, a copy of the host's IP traffic.

**Why 2.14.0.** That release limited how many rows one write may decompress, and made
`compress_chunk` recompress a chunk that was written to after it was compressed (TimescaleDB
changelog, 2.14.0: `#6566`, `#6579`, `#6609`, and `#6575` for upserts into compressed chunks).
A probe replaying its spool writes into compressed chunks, and the core relies on both: it lifts
the limit for the writes it has bounded, and recompresses what they leave behind. An older
TimescaleDB would need a second way of doing each, so it is refused at start-up rather than at
the first replay.

**The database is not installed for you.** TimescaleDB's licence permits free self-hosted use but
attaches to whoever ships its binaries, so this project tells you to install it rather than
bundling it (`CLAUDE.md`, "TimescaleDB Community licence"). Use your distribution's packages and
the TimescaleDB project's own repository.

### Sizing

Full guidance, with the measurement behind every number, is
[`docs/sizing.md`](sizing.md). The short version: **two cores is enough for a probe at every size
up to the v1 target** — at 5,000 sensors the dispatch jitter measured 208 ms on two cores against
212 on eight, because a check waits for a packet rather than for a core. Give the core 4 cores
and 8 GB at that size and the headroom to PostgreSQL.

The storage half is in
[`docs/findings/2026-08-25-timeseries-sizing.md`](findings/2026-08-25-timeseries-sizing.md):

- **99.3 bytes per reading** on disk uncompressed, indexes included.
- At the v1 target of 5,000 sensors on a 60-second interval — about 21.6 million rows a day —
  that is **~2.8 GB a day**, or **~80 GB** for the 40 days of raw data PRTG keeps.
- With TimescaleDB's native compression, the same 40 days measured **12.5× smaller: ~6.4 GB**
  ([the rollup spike](findings/2026-08-25-rollup-storage-spike.md)).

The one number worth planning around beyond that is TimescaleDB's: the recent working set should
fit in roughly a quarter of RAM, which is what the one-day chunk interval was chosen against.

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

**It has to be TimescaleDB's Community build, preloaded, under its Community licence.** `ms-core`
relies on native compression, which is Timescale-licensed rather than Apache (`ADR-001`
Decision 4), and migration 004 refuses to run without it. Four things, all of which the
smoke-test boxes set up (`scripts/smoke/provision-postgres.sh`):

- **The package with the licensed module in it.** From the TimescaleDB project's own repository
  that is `timescaledb-2-postgresql-17`. Not `timescaledb-2-oss-postgresql-17`, and not a
  distribution's own package unless it says it carries the TSL module: Debian 13's
  `postgresql-17-timescaledb` is the Apache-only build. On an Apache-only build the licence
  setting below is refused, because the module it names is not there, and migration 004 fails
  again with the same message however often you set it.
- **Preloaded**, in `postgresql.conf`, with PostgreSQL restarted afterwards:
  `shared_preload_libraries = 'timescaledb'`.
- **The Community licence**, `timescaledb.license = 'timescale'` in the same file. It is the full
  package's default; say it anyway, so the file records what the installation depends on.
- **At least the version the table above names.** An older one is refused at start-up.

`SHOW timescaledb.license;` answers `timescale` when all of that is in place.

The schema itself is not created here. `ms-core` migrates on startup, and refuses to start
against a schema it does not recognise rather than running against one it might corrupt.

## 2. The application

Three ways in, and they do the same thing: the package or the tarball puts files on disk, and
then all three run the same `ms-setup`, which creates the `ms-core` and `ms-probe` service users,
lays out `/opt/ms`, `/etc/ms` and `/var/lib/ms-*`, issues the probe-channel CA and certificates,
generates the probe access key, installs both systemd units, and enables them. On an upgrade it
starts them too; on a first installation it does not (below).

**Debian, Ubuntu:**

```bash
sudo apt install ./ms_0.1.0_amd64.deb
```

`apt` rather than `dpkg -i`, because the package depends on `iputils-ping` and only `apt` fetches
a dependency. `dpkg -i` works where `ping` is already installed; where it is not, it stops with
*dependency problems*, and `sudo apt-get -f install` finishes it.

**RHEL, Rocky, AlmaLinux, Fedora:**

```bash
sudo dnf install ./ms-0.1.0-1.x86_64.rpm
```

**A first installation starts nothing** (`H-30`). `/etc/ms/core.json` has just been created from
the release's example, which has no database password, so the setup leaves both services
stopped, ends without an error — `dpkg -l ms` reads `ii` — and says what to set:

```
==> /etc/ms/core.json is new, so nothing was started.

    It is the release's example, and it has no database password yet. Give the core one
    (database.password, docs/installation.md §3), check it, then start:
```

That is §3. Every later run — an upgrade, a re-run, a reinstall over an existing `core.json` —
starts the services as before, whatever the file's password says, since the password may be in
a credential the setup cannot see (§3).

**Anywhere else** — unpack the release and run the installer from inside it:

```bash
sudo ./install.sh
```

The tarball installer takes three flags the packages have no equivalent for, because a package
either contains a core or it does not:

- `--probe-only` on a host that is only running a remote probe. The `ms-probe` package is the
  packaged form of this, and it conflicts with `ms` so a host cannot end up with both.
- `--core-only` where the probe is somewhere else entirely.
- `--no-start` to stage a machine that is not meant to come up yet. `MS_SETUP_NO_START=1` does
  the same for a package install, which is what baking a golden image wants.

It ends with a summary whose `services` line says what that run did — started them, started
nothing because it was a first installation, or started nothing under `--no-start` — and, when
nothing was started, the two commands that start them (`H-35`).

### Why Node is not a package dependency

Neither the `.deb` nor the `.rpm` hard-depends on Node, and that is deliberate rather than an
oversight: no Debian or enterprise release ships one new enough, so the Node an operator has
came from NodeSource, from a version manager, or from the official tarball — and none of those
satisfy a dependency on the distribution's own package. A hard dependency would make the packages
uninstallable on exactly the machines they are for. The installer checks for a real Node 22+ and
says what it found instead.

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

`config check` loads the file exactly as the service would — `/etc/ms/core.json`, unless
`--config` names another — reports **every** problem rather than the first, and exits non-zero if
the service would not start. A check that finds no file to read fails; it does not pass on the
defaults. It is worth running before a
restart every time, because the alternative is finding out from `journalctl` with the service
already down.

```bash
sudo systemctl reset-failed ms-core ms-probe
sudo systemctl start ms-core ms-probe
```

**`reset-failed` first, every time.** Each unit is allowed five starts in ten minutes, an
operator's included, and the sixth is refused and leaves the unit `failed`; `reset-failed` clears
that count and changes nothing else (`P-222`;
[what a start failure does](administration.md#what-a-start-failure-does)). A first installation
has not started either service, so here it clears nothing — and costs nothing.

**The password as an encrypted credential instead.** Leave `database.password` empty, and give
the core the password through `MS_DATABASE__PASSWORD__FROM_FILE` in a drop-in
(`sudo systemctl edit ms-core`); the three lines are in the comments of `ms-core.service`. The
setup cannot see a password delivered that way, which is why it never judges `core.json` by its
password: only a `core.json` it has just created is a first installation.

**Email is the other setting a first installation leaves empty.** `notifications.smtp` in the
same file names the relay alarms are sent through; until it is set the core starts, says at start
that no relay is configured, and sends no email. Setting it, and the test send that proves it, are
in [`administration.md` → Email](administration.md#email).

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
reverse proxy in front of it and set `api.allowedOrigins` to the origin browsers will use and
`api.trustedProxies` to the proxy's address. Without the second, the session cookie is never
`Secure` and the login throttle counts every browser as the proxy
(`administration.md` → Reverse proxies). Changing `api.host` to `0.0.0.0` also works and is your
decision to make deliberately.

**The core answers only to its own names** (`A-47`): every address, `localhost`, and the names in
`api.allowedHosts`. The installer puts the machine's `hostname -f` there. Any other name a browser
uses to reach the core, including the proxy's public one, goes in that list too, or it gets 421
(`administration.md` → The names the core answers to).

## 5. The local probe

The probe dials **out** to the core, never the other way round, so nothing needs to be opened
inbound on the probe host. It presents its certificate and the access key the installer generated,
and then waits: a new probe arrives in **`pending`** and is given no work at all until somebody
approves it.

Approve it under **Probes** in the UI, or with an API token (`MS_TOKEN`, scope `full`), first
creating the probe object it will own — a fresh installation has the root object and nothing
else:

```bash
auth=(-H "Authorization: Bearer ${MS_TOKEN}" -H 'content-type: application/json')
curl -s "${auth[@]}" http://127.0.0.1:8080/api/v1/probes?status=pending     # the probe's gid
curl -s "${auth[@]}" -X POST http://127.0.0.1:8080/api/v1/objects \
  -d '{"kind":"probe","parentId":1,"name":"Local probe"}'                   # → its id
curl -s "${auth[@]}" -X POST http://127.0.0.1:8080/api/v1/probes/<gid>/approve \
  -d '{"objectId":<id>,"local":true}'
```

Without the token the request is refused `401`, and without the content type `415`. `objectId`
is the probe object in the tree this identity owns from now on. `"local": true` says
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

Install the new version the same way you installed the old one — `apt install ./ms_….deb`,
`dnf install ./ms-….rpm`, or unpack the new release and run `sudo ./install.sh`
(`sudo ./install-probe.sh` on a remote probe host). `dpkg -i` and `rpm -U` work too, where every
dependency is already installed. The packages depend on `ping` (`H-31`), which a release before
that did not ask for, and on a host without it only `apt` and `dnf` fetch it.

None of them **overwrite anything in `/etc/ms`**. Each configuration file is copied to a
timestamped `.bak` beside it, and the version this release ships is written alongside as
`.json.new` so you can diff them.

**No old process runs on new files**, whichever way you install, but what you are left with when
the new build refuses your configuration differs:

- **The tarball** copies the new release in beside the running one and asks the *new* build
  whether it can read your configuration (`config check`) while the old services are still
  running. If a setting was renamed or made required, it stops there and says so: **nothing has
  been changed**, and the old version is still installed and still running. Fix the configuration
  and run the installer again. Otherwise it stops the services, moves the new release in, starts
  them, and keeps the release it replaced at `/opt/ms/previous`.
- **A package** stops the services before it unpacks, because the package manager replaces the
  files itself and the new build can only be asked afterwards. If it refuses the configuration,
  the new version is installed, **both services are left stopped**, and the message says so. Fix
  the configuration, then `sudo systemctl reset-failed ms-core ms-probe` and
  `sudo systemctl start ms-core ms-probe` — or, after a `.deb`, `sudo dpkg --configure -a`, which
  asks again and starts them.

`--no-start` and `MS_SETUP_NO_START=1` leave both services stopped, including any that were
running before.

Migrations run on startup and are reversible. A build started against a database migrated by a
*newer* build refuses to start; install the matching release rather than migrating backwards.

**From a release before `A-47`**, check two things first. An `api.trustedProxies` range wider
than /16 for IPv4 or /48 for IPv6 is now refused, so the configuration check above stops there
until it names the proxy. And a browser that reaches the core by a name gets 421 unless that name
is in `api.allowedHosts`, or is the host of `notifications.publicUrl` or of an `api.allowedOrigins`
entry. An upgrade does not add the machine's name, since it never rewrites your configuration.
List them before upgrading (`administration.md` → The names the core answers to).

### The units are the release's

The systemd units live in `/usr/lib/systemd/system`, and every upgrade replaces them: `ms-core`,
`ms-probe`, and `ms-recover@`, which starts either of them again after it stopped for crashing
([When a service keeps crashing](administration.md#when-a-service-keeps-crashing)). **Do not
edit them.** Put every change — the database password as an encrypted credential, a different
memory ceiling — in a drop-in, which no upgrade touches:

```bash
sudo systemctl edit ms-core
```

`systemctl set-property ms-core MemoryMax=…` writes a drop-in as well. Releases before this one
kept the units in `/etc/systemd/system` and overwrote them at every upgrade, edits included. The
first upgrade to this one removes a unit there that is exactly as an earlier release shipped it,
and **keeps one you edited**, naming it: a unit in `/etc/systemd/system` overrides the release's
whole, so until you move your change into a drop-in and delete it, nothing a release changes in
the unit applies.

### Going back, after a tarball upgrade

The release an upgrade replaced is at `/opt/ms/previous` until the next upgrade. If the new core
has already migrated the database, undo that first, with the **new** build: the previous build's
`migrate status` names the migrations it does not know, and `migrate down` removes that many.

```bash
sudo systemctl stop ms-probe ms-core
sudo /opt/ms/previous/bin/ms-core migrate status --config /etc/ms/core.json
sudo /opt/ms/bin/ms-core migrate down --steps 2        # however many it named
cd /opt/ms && sudo mkdir rolled-back
for entry in app bin web docs etc deploy libexec VERSION; do
  [ -e "$entry" ] && sudo mv "$entry" rolled-back/
done
sudo mv previous/* . && sudo rmdir previous
sudo systemctl start ms-core ms-probe
```

A package has no `previous`: install the earlier package version with `apt` or `dnf`, after the
same `migrate down`.

**Taking back migration 064 can rename maps, reports and libraries.** Since 064 a name is unique
only among what one account can read, so two groups may each have a "Core Network". The releases
before it insist on a name being unique across the installation, so the way back keeps the oldest
of each name as it is and appends its id to every other one — `Core Network (#12)`, shortened to
fit the 100 characters a name may have — and moves its version on, so an editor still open on the
old name is refused rather than saving it back. Nothing is merged or deleted. If a renamed one
would still clash, because somebody had already used that exact name, the rollback stops and
changes nothing; rename one of the two and run it again.

## Uninstalling

```bash
sudo dpkg -P ms          # or: sudo rpm -e ms
```

From a tarball install:

```bash
sudo systemctl disable --now ms-core ms-probe
sudo rm -rf /opt/ms /usr/lib/systemd/system/ms-{core,probe}.service /usr/lib/systemd/system/ms-recover@.service
sudo systemctl daemon-reload
```

`/etc/ms`, `/var/lib/ms-*`, the database and your drop-ins under
`/etc/systemd/system/ms-*.service.d` are left alone deliberately — they hold the
configuration, the credential-vault key and every reading ever taken. Remove them when you mean
to, not as a side effect of removing the application. The service users stay too.

**The probe's ping setting goes with a purge** (`H-34`). `dpkg -P` (or `apt purge`) and `rpm -e`
remove `/etc/sysctl.d/60-ms-probe-ping.conf` (*Before you start*) while it is still exactly as the
setup wrote it, and say so; one you have edited is left where it is, and named. A plain
`apt remove` or `dpkg -r` keeps it, as dpkg keeps a configuration file until the purge — rpm has
no such step, so an erase is the end. The running kernel's `net.ipv4.ping_group_range` is not
changed by either: what it held before the setup opened it is not recorded, and something else may
have set it since, so it stays until the next boot, which reads `/etc/sysctl.d` without the file.
After a tarball install, remove the file yourself if the setup wrote one.

---

## What to read next

- [`docs/administration.md`](administration.md) — accounts, credentials, backups, what to watch
- [`docs/troubleshooting.md`](troubleshooting.md) — when something does not work
- [`docs/runbook-backup-restore.md`](runbook-backup-restore.md) — before you need it

# Administering MonitoringSystem

Running the thing once it is installed: who may do what, where the secrets live, what to watch,
and what to have rehearsed before you need it.

- Installing is [`docs/installation.md`](installation.md).
- When something is broken, [`docs/troubleshooting.md`](troubleshooting.md).
- Backups have their own runbook, [`docs/runbook-backup-restore.md`](runbook-backup-restore.md).

---

## Accounts, roles and rights

Two independent controls, and the distinction matters when a permission does not behave the way
somebody expected.

**A role is what an account may do at all**, on the whole installation:

| Role | |
| --- | --- |
| `admin` | Everything, including accounts, groups, probes and system settings |
| `readwrite` | May change objects it has been granted write access to |
| `readonly` | May look, never change — regardless of any grant below |

**A right is what a group may do to a branch of the tree**: `none`, `read`, `write`, `full`.
Rights are granted to *groups*, never directly to accounts, and they resolve by three rules:

1. They **inherit down** the tree.
2. An **explicit grant beats an inherited one**, at the same object.
3. Across the groups an account is in, the **highest right wins**.

`none` is a grant, not an absence — it overrides inheritance to carve a hole in a branch. Deleting
a grant is the different thing: it restores whatever the object inherits.

The two controls are a floor and a ceiling, in that order: the role caps the right. A `readonly`
account in a group with `full` on a device may still only read it. `GET /objects/:id/access/
effective` answers "what may this account actually do here, and *where did that come from*",
which is what makes a refusal debuggable rather than mysterious.

### API tokens

A token carries **the rights of the account that owns it, never more**, and can be given less. It
is shown once, at creation, and no route can read it back afterwards. Revoke by deleting it;
there is no expiry to wait for.

Tokens authenticate with `Authorization: Bearer …` and are not subject to the CSRF header
requirement — that applies to cookie-authenticated writes, because a cookie is what a browser
attaches on its own.

### Two-factor authentication

TOTP, per account, self-enrolled under the account's own settings. Recovery codes are generated
at enrolment and shown once. An administrator can disable MFA on an account that has locked
itself out; they cannot read anybody's secret.

---

## Credentials for monitored devices

**Credentials are write-only and that is enforced in one place.** A parameter a sensor type marks
`writeOnly` is stripped from every API response by `ObjectService.#redact` — not per route, so a
new endpoint cannot forget to do it — and the read carries `redactedParams` instead, saying which
fields exist without saying what they are. No API route returns a stored credential to anyone,
including administrators. This is deliberate and there is no flag to turn it off.

They are encrypted at rest with the **vault key**, at `/var/lib/ms-core/vault.key` by default:

- Mode 0600, owned by `ms-core`.
- **Without it every stored credential is unrecoverable.** Not "hard to recover" — the ciphertext
  is all that is in the database.
- It is in every backup for exactly that reason, which is also why a backup archive is as
  sensitive as the credentials themselves.

Credentials are inherited like every other setting: set the SNMP community once on a group, and
every device beneath it uses it. That is the point — rotating one is one edit, not four hundred.

---

## Inheritance

Intervals, credentials, dependency behaviour, notification settings and access rights all inherit
down the tree, and all of them resolve through **one** resolver in `packages/core`. An object
either inherits a setting or overrides it; there is no third state, and there is no place in the
code where parent-walking is reimplemented locally.

`GET /objects/:id/settings` shows both the effective value and where it came from. When something
scans every 60 seconds and you are sure you set 300, that is the endpoint that says which ancestor
disagrees.

---

## Pausing

Four independent pause sources, and this is the thing most worth understanding before an
on-call night:

| Source | Set by |
| --- | --- |
| Manual | A person, with or without a duration |
| Schedule | A maintenance window |
| Dependency | A master sensor going down |
| Parent | Any ancestor being paused |

**They are a set, not a precedence chain.** Clearing the one the UI happens to report does not
necessarily resume the object — `pausedBy` lists every source currently holding it, which is why
it exists. A paused sensor records no readings and raises no alarms, and its downtime is not
counted against its SLA.

Acknowledging is not pausing. An acknowledged sensor keeps scanning and keeps recording; it
simply stops re-notifying. Use it for "I know, I am on it", and a pause for "do not tell me and
do not count this".

---

## What to watch

The system monitors itself with real sensors, and every subsystem with a queue, a pool or a
connection reports into one of them. The full channel list is in
[`docs/sensor-reference.md`](sensor-reference.md) under **System**; these are the ones worth an
alarm.

### Core Health — `ms.core.health`

| Channel | Watch it because |
| --- | --- |
| `ingestQueue` | Readings arriving faster than they are written. Warns at 40,000, errors at 100,000 |
| `rollupLag` | Rollups falling behind. An hour is a warning; a day means graphs at wide ranges are wrong |
| `diskFree` | Errors below 10%. See below — a full disk costs retention |
| `evictedChunks` | **Any value above zero is an error.** Data was dropped early to stay on disk |
| `notifyOldest` | Notifications queued and undelivered. 15 minutes warns; an hour means nobody is being told anything |
| `alarmOverdue` | The alarm sweep is not running. Everything downstream of it is silently stale |
| `probesDown` | Probes not connected. Their sensors are not being checked |

### Probe Health — `ms.probe.health`

| Channel | Watch it because |
| --- | --- |
| `connected` | The link to the core |
| `schedulerLag` | Checks starting later than scheduled. Warns at 1 s, errors at 5 s — this is the first sign of an overloaded probe |
| `poolUsage` | Worker pool saturation. Warns at 80% |
| `deferred` | Checks the pool could not start. **Backpressure is counted, never silent** |
| `spoolStalled` | **Any value above zero is an error.** The link is up and the spool is not moving — results are accumulating for a reason nothing else reports |
| `spoolDropped` | **Any value above zero is an error.** Results were lost because the spool filled |
| `clockJumps` | The host's clock moved. Scheduling is monotonic, but data is wall-clock |

These thresholds ship as **defaults, not policy**. They are written once when the channel is
created and never again — change or clear one and it is yours from then on, because a default
that reappeared after somebody deliberately removed it would be worse than no default at all.

### Prometheus

`/metrics`, outside `/api/v1` because that is the path every scraper config, service-discovery
rule and Helm chart already assumes. **It is guarded explicitly**, because authentication only
covers `/api/` — the app shell has to be public — so a route outside that prefix would otherwise
be public too, and the scrape body is a map of the installation: every queue depth, the sensor
counts per probe, the probe names.

A scraper authenticates with an API token, which is what `authorization` in a `scrape_config` is
for. While the core is still starting it answers **503** rather than an empty body, because an
empty body is recorded as every series vanishing at once.

---

## Housekeeping, retention and a full disk

Rollups, retention and the job that drives them are written in `packages/core`, not delegated to
the database — so the storage engine could change and this behaviour would not. Native
compression is the one TimescaleDB feature relied on, and it is worth 12.5× on disk
([measured](findings/2026-08-25-rollup-storage-spike.md)).

**A full disk costs retention, and it says so.** When free space falls under the reserve, the
housekeeper evicts the oldest raw chunks early — up to a bounded number of steps per pass — and
raises `evictedChunks`. That channel exists so the trade is visible: the alternative is a
database that stops accepting writes, and a monitoring system that stops recording is worse than
one that has forgotten last month. Treat any eviction as "add disk", not as normal operation.

If the configured data path is on a remote database host, the core cannot measure it and reports
nothing rather than guessing — a wrong number here would be worse than no number.

---

## Backups

Have this rehearsed before you need it. The whole procedure is
[`docs/runbook-backup-restore.md`](runbook-backup-restore.md); the short version:

```bash
sudo /opt/ms/bin/ms-backup --out /var/backups/ms
```

One timestamped `tar.gz` holding the database, both configuration files, the vault key and the
probe-channel certificates. **Rehearse the restore onto a host that is not the one it came
from** — restoring over the original proves almost nothing, because the data, the key and the
certificates are all already there and a restore that quietly did nothing would pass.

The archive decrypts every monitored-device credential in the installation. Store it where the
database's own storage is stored, and no more widely.

---

## Upgrades

Covered in [`docs/installation.md`](installation.md#upgrading). The two things worth repeating:

- **`config check` runs before anything restarts.** A renamed or newly-required setting stops the
  upgrade with the old services still running on the old version.
- **A build refuses to start against a schema migrated by a newer build.** That refusal is
  correct. Install the matching release rather than migrating backwards.

---

## Reverse proxies

The API listens on loopback by default. Behind a proxy, set `api.allowedOrigins` to the origin
browsers will actually use:

```json
{ "api": { "allowedOrigins": ["https://ms.example.com"] } }
```

The CSRF guard compares the browser's `Origin` against the request's `Host`, and a proxy that
rewrites `Host` makes those differ for a request that is not cross-site at all — so without this
key every write from such a deployment is refused. Full origins, with a scheme; not a bare
hostname, and not a wildcard. A bad value is refused at startup, not at the first write.

Set `notifications.publicUrl` to the same origin, or alarm emails will link to an address nobody
receiving them can open.

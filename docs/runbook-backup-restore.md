# Backup and restore

**`H-04`.** Two commands, and one procedure that is only worth having if it has been rehearsed.
`scripts/smoke-restore.sh` rehearses it on every run: it backs up one host and restores onto a
second, clean one, then asserts the tree, the readings and the credential came back.

---

## What is in a backup, and what is not

    /opt/ms/bin/ms-backup --out /var/backups/ms

One timestamped `tar.gz`, mode 0600, holding:

| | Why |
| --- | --- |
| `database.dump` | `pg_dump --format=custom` of the configured database — the object tree, the readings, the state history, the audit log |
| `vault.key` | **Without it, every stored credential is unrecoverable.** See below |
| `core.json`, `probe.json` | So a rebuild does not start from the example file |
| `tls/` | The probe-channel CA and certificates, so existing probes reconnect without re-enrolment |
| `MANIFEST` | When, from which release, from which host — and with which TimescaleDB and PostgreSQL, which is what a restore has to match (below) |

Not in it, deliberately:

- **The probe's result spool.** It is a queue, not data. A rebuilt probe carries on from its own
  disk, and a spool restored onto a different machine would replay readings that machine never
  took.
- **`/opt/ms` itself.** That comes from the release tarball. Restoring it would be copying
  something already reproducible, and restoring it *over a newer install* is a downgrade nobody
  asked for.

### The archive is as sensitive as the credentials in it

The vault key decrypts every monitored-device credential in the installation. An archive holding
both is, in effect, the plaintext of all of them. It is written 0600 and belongs wherever the
database's own storage belongs — and nowhere more widely. That is also why the key is in it: a
backup without the key restores a system that cannot log in to anything it monitors, and there is
no way to recover them afterwards.

An installation that has stored no credentials yet has no key, and `ms-backup` says so and
carries on rather than refusing to back up a working system.

### A database password that is not in core.json

`ms-backup` and `ms-restore` read the connection from `core.json`, and **pass the password to
nothing but libpq**: it goes into a password file in their own private directory, never through a
shell, so a `$`, a backtick or a quote in it is only a character (`H-21`). If the password is a
systemd credential instead — a drop-in on `ms-core.service` — `core.json` has none, and both leave
libpq's own environment alone. Hand it over the way libpq takes one:

    sudo sh -c 'PGPASSWORD="$(systemd-creds decrypt --name=db-password /etc/ms/db-password.cred -)" \
      /opt/ms/bin/ms-backup --out /var/backups/ms'

---

## Restoring

    systemctl stop ms-core ms-probe
    /opt/ms/bin/ms-restore /var/backups/ms/ms-backup-20260829T101912Z.tar.gz

The order is the procedure, and it is not interchangeable:

1. **Refuse if anything is running** — in any state but stopped. Restoring under a live core
   would have it writing into a database being replaced beneath it, and a core waiting for its
   database is `activating`, not `active`, for as long as the database is missing: in a disaster
   recovery that is exactly how it is found, and it would migrate into the empty database
   alongside the restore.
2. **Refuse unless the database will take it**, before anything is written: reachable, empty,
   and on the TimescaleDB version the archive was taken with. `pg_restore --clean` into a
   populated database leaves whatever it could not drop, and the result is a mixture of two
   installations that looks like one; `ms-restore` refuses and tells you the one command that
   empties it. The version is the next section but one.
3. **Configuration, key and certificates first**, so a failure part-way leaves a system that
   cannot start rather than one that starts and cannot decrypt anything it reads.
4. **The database.**
5. **Check before starting**, which is the section after next.

### TimescaleDB makes this less simple than it looks

Three things go wrong with a plain `pg_restore`, and `ms-restore` handles all three. They are
worth knowing because a hand-rolled restore hits them in this order:

- The dump carries `COMMENT ON EXTENSION timescaledb`, and only the extension's owner — the
  superuser who installed it — may set that. Restoring as the application's role aborts on a
  *comment*, hundreds of tables in. The extension entries are filtered out of the archive's table
  of contents: the extension belongs to the server, not to the backup.
- Hypertable chunks restore as ordinary tables unless the extension is put into restore mode
  first. `timescaledb_pre_restore()` does that and needs a superuser; `ms-restore` tries the
  application's role, then a local `postgres`, and refuses with the two statements to run by hand
  if neither works. **Skipping it produces a database that looks restored and has no hypertables
  in it.**
- The dump COPYs into `_timescaledb_catalog`, which is how a restored database knows which tables
  are hypertables. The application's role has no rights there — on the original machine the
  extension created those rows with its own privileges — so `ms-restore` grants them for the
  restore. The role already owns every byte of the data; this gives it nothing it did not have,
  and it keeps the restored objects owned by the application rather than by `postgres`.

### The TimescaleDB version

**A dump restores only into the TimescaleDB version that took it.** Its `_timescaledb_catalog`
rows are laid out for that version, and releases change the layout: 2.28 replaced
`_timescaledb_catalog.chunk_constraint`, a table the dump copies into, with a view. A host rebuilt
after a disaster gets whatever the repository serves that day, so a newer version on the target
is the ordinary case, not an unlucky one.

`ms-backup` writes the version into the archive's `MANIFEST` (`timescaledb=`, with
`postgresql=` beside it), and `ms-restore` checks it before it writes anything. Into a database
with no extension yet it creates exactly that version, if this host has it installed. When the
versions differ it refuses, names both, and nothing has been restored. Then:

1. **Install the archive's version.** The TimescaleDB repository keeps earlier releases; ask the
   package manager for that one (`apt-cache madison timescaledb-2-postgresql-17`,
   `dnf --showduplicates list timescaledb-2-postgresql-17`) and install it, then restart
   PostgreSQL.
2. **Put that version into the empty database**, as a superuser:

       DROP EXTENSION IF EXISTS timescaledb;
       CREATE EXTENSION timescaledb VERSION '2.27.2';

3. **Run `ms-restore` again.**
4. **Bring the extension forward before `ms-core` starts.** Upgrade the package to the version you
   mean to run, restart PostgreSQL, and as a superuser, as the first command of a fresh session:

       psql -X -d monitoring -c 'ALTER EXTENSION timescaledb UPDATE'

An archive taken before `H-21` records no version. `ms-restore` says so and goes on; if the
restore then fails in `_timescaledb_catalog`, the version to install is the one the old host ran.

---

## Before starting the restored installation

    /opt/ms/bin/ms-core config check
    /opt/ms/bin/ms-core migrate status

Both read `/etc/ms/core.json`, as the service does — the restored one.

**A backup taken from a newer release carries a newer schema**, and `ms-core` refuses to start
against one (`H-03`). That refusal is correct and the remedy is to install the matching release,
not to migrate backwards. `migrate status` names the migrations this build does not know.

    systemctl reset-failed ms-core ms-probe
    systemctl start ms-core ms-probe

Probes reconnect on their own. A probe on another host needs nothing done to it: the
probe-channel CA came back with the archive, so its certificate still verifies.

---

## What to rehearse, and how often

The restore, onto a host that is not the one the backup came from. Restoring over the original
proves almost nothing — the data is already there, the key is already there, the certificates are
already there, and a restore that quietly did nothing would pass.

`scripts/smoke-restore.sh` is that rehearsal, in two containers, and it is what found every one
of the TimescaleDB problems above. It runs in CI beside the install smoke test. Both of its
containers come from one image, so they always have the same TimescaleDB: it proves that a
mismatch is *refused*, with an archive whose manifest names another version, and cannot prove the
four steps above. Rehearse those by hand the first time a host is rebuilt onto a newer repository.

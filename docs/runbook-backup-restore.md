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
| `MANIFEST` | When, from which release, from which host |

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

---

## Restoring

    systemctl stop ms-core ms-probe
    /opt/ms/bin/ms-restore /var/backups/ms/ms-backup-20260829T101912Z.tar.gz

The order is the procedure, and it is not interchangeable:

1. **Refuse if anything is running.** Restoring under a live core would have it writing into a
   database being replaced beneath it.
2. **Configuration, key and certificates first**, so a failure part-way leaves a system that
   cannot start rather than one that starts and cannot decrypt anything it reads.
3. **The database, into an empty one.** `pg_restore --clean` into a populated database leaves
   whatever it could not drop, and the result is a mixture of two installations that looks like
   one. `ms-restore` refuses and tells you the one command that empties it.
4. **Check before starting**, which is the next section.

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

---

## Before starting the restored installation

    /opt/ms/bin/ms-core config check
    /opt/ms/bin/ms-core migrate status

**A backup taken from a newer release carries a newer schema**, and `ms-core` refuses to start
against one (`H-03`). That refusal is correct and the remedy is to install the matching release,
not to migrate backwards. `migrate status` names the migrations this build does not know.

    systemctl start ms-core ms-probe

Probes reconnect on their own. A probe on another host needs nothing done to it: the
probe-channel CA came back with the archive, so its certificate still verifies.

---

## What to rehearse, and how often

The restore, onto a host that is not the one the backup came from. Restoring over the original
proves almost nothing — the data is already there, the key is already there, the certificates are
already there, and a restore that quietly did nothing would pass.

`scripts/smoke-restore.sh` is that rehearsal, in two containers, and it is what found every one
of the TimescaleDB problems above. It runs in CI beside the install smoke test.

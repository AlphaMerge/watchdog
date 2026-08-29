#!/usr/bin/env bash
# MonitoringSystem restore (TASKS.md H-04).
#
#     sudo ./restore.sh /var/backups/ms/ms-backup-20260829T101500Z.tar.gz
#     sudo ./restore.sh <archive> --database-only     # leave /etc/ms alone
#
# Restores onto a host where MonitoringSystem is already installed and the services are stopped.
# The order is the whole procedure and it is not interchangeable:
#
#   1. Refuse if anything is running. Restoring under a live core would have it writing into a
#      database being replaced beneath it.
#   2. Restore the configuration, the vault key and the probe-channel certificates *first*, so a
#      failure part-way leaves a system that cannot start rather than one that starts and cannot
#      decrypt anything it reads.
#   3. Restore the database into an empty one. `pg_restore --clean` into a populated database is
#      the commonest way a restore half-works.
#   4. Say what to do next, which is to check the schema before starting.
#
# **The restored installation may be older than the archive.** A backup taken from a newer
# release carries a newer schema, and `ms-core` refuses to start against one (`H-03`). That is
# the correct failure and this script says so rather than letting the service discover it.
set -euo pipefail

CONFDIR=/etc/ms
PREFIX=/opt/ms
database_only=0
archive=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --database-only) database_only=1 ;;
    --confdir) CONFDIR="$2"; shift ;;
    --prefix)  PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) archive="$1" ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ -n "${archive}" ] || die "usage: restore.sh <archive.tar.gz> [--database-only]"
[ -f "${archive}" ] || die "no such archive: ${archive}"
[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v pg_restore >/dev/null 2>&1 || die "pg_restore is required (install the PostgreSQL client)"

# 1. Nothing may be running.
for svc in ms-core ms-probe; do
  if systemctl is-active --quiet "${svc}" 2>/dev/null; then
    die "${svc} is running; stop it first (systemctl stop ms-core ms-probe)"
  fi
done

staging="$(mktemp -d)"
trap 'rm -rf "${staging}"' EXIT
tar -xzf "${archive}" -C "${staging}"
work="$(find "${staging}" -maxdepth 1 -type d -name 'ms-backup-*' | head -1)"
[ -n "${work}" ] || die "this does not look like a MonitoringSystem backup"
[ -f "${work}/database.dump" ] || die "the archive has no database dump in it"

echo "==> archive contents"
sed 's/^/    /' "${work}/MANIFEST" 2>/dev/null || echo "    (no manifest — an archive from before H-04)"

if grep -q '^vaultKey=MISSING' "${work}/MANIFEST" 2>/dev/null; then
  echo "    WARNING: no vault key in this archive; stored credentials will not decrypt" >&2
fi

# 2. Configuration, key and certificates before the data.
if [ "${database_only}" -eq 0 ]; then
  echo "==> restoring configuration, vault key and certificates"
  install -d -m 0755 "${CONFDIR}"
  for name in core probe; do
    [ -f "${work}/${name}.json" ] || continue
    if [ -f "${CONFDIR}/${name}.json" ]; then
      # The same timestamped copy `install.sh` takes, for the same reason: whatever is on this
      # host now is somebody's, even if it is about to be replaced.
      install -m 0600 -o root -g root "${CONFDIR}/${name}.json" \
        "${CONFDIR}/${name}.json.$(date -u +%Y%m%dT%H%M%SZ).bak"
    fi
    install -m 0640 -o root -g "ms-${name}" "${work}/${name}.json" "${CONFDIR}/${name}.json" \
      2>/dev/null || install -m 0640 "${work}/${name}.json" "${CONFDIR}/${name}.json"
  done

  if [ -f "${work}/vault.key" ]; then
    # Read out of the restored configuration, so a key file that was moved stays moved.
    key_rel="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).vault?.keyFile ?? "vault.key"' "${CONFDIR}/core.json" 2>/dev/null || echo vault.key)"
    data_dir="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).service?.dataDir ?? "/var/lib/ms-core"' "${CONFDIR}/core.json" 2>/dev/null || echo /var/lib/ms-core)"
    case "${key_rel}" in
      /*) key_path="${key_rel}" ;;
      *)  key_path="${data_dir}/${key_rel}" ;;
    esac
    install -d -m 0750 "$(dirname "${key_path}")"
    install -m 0600 "${work}/vault.key" "${key_path}"
    chown ms-core:ms-core "${key_path}" 2>/dev/null || true
    echo "    vault key -> ${key_path}"
  fi

  if [ -d "${work}/tls" ]; then
    install -d -m 0755 "${CONFDIR}/tls"
    cp "${work}"/tls/* "${CONFDIR}/tls/"
    chmod 644 "${CONFDIR}"/tls/*.crt 2>/dev/null || true
    chmod 640 "${CONFDIR}"/tls/*.key 2>/dev/null || true
    chown root:ms-core "${CONFDIR}"/tls/core.* 2>/dev/null || true
    chown root:ms-probe "${CONFDIR}"/tls/probe.* 2>/dev/null || true
  fi
fi

# 3. The database, into an empty one.
eval "$(node -e '
  const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const db = cfg.database ?? {};
  const out = {
    host: db.host ?? "127.0.0.1", port: db.port ?? 5432,
    database: db.database ?? "monitoring", user: db.user ?? "monitoring",
    password: db.password ?? "",
  };
  process.stdout.write(Object.entries(out).map(([k, v]) => `cfg_${k}="${String(v)}"`).join("\n"));
' "${CONFDIR}/core.json")"

echo "==> restoring ${cfg_database} on ${cfg_host}:${cfg_port}"
export PGPASSWORD="${cfg_password}"
existing="$(psql --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
  --dbname="${cfg_database}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo 0)"
if [ "${existing}" -gt 0 ]; then
  # `pg_restore --clean` into a populated database leaves whatever it could not drop, and the
  # result is a mixture of two installations that looks like one. An empty schema is the
  # precondition, and dropping it is the operator's decision to make out loud.
  die "${cfg_database} already has ${existing} table(s). Restore into an empty database:
    psql -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' -d ${cfg_database}
  then run this again."
fi

psql_ms() {
  psql --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
    --dbname="${cfg_database}" -qtA "$@"
}

# **TimescaleDB has a restore procedure and this is it.** Two things go wrong without it.
#
# The dump carries `COMMENT ON EXTENSION timescaledb`, and only the extension's *owner* — the
# superuser who installed it — may set that. Restoring as the application's own role therefore
# aborts on a comment, several hundred tables in, with `--exit-on-error` doing exactly what it
# was asked to. The extension entries are filtered out of the archive's table of contents
# instead: the extension is not the backup's to restore, it belongs to the server.
#
# And hypertable chunks are restored as ordinary tables unless the extension is put into restore
# mode first. `timescaledb_pre_restore()` does that; `post_restore` puts it back and re-arms the
# background workers. Skipping the pair leaves a database that looks restored and has no
# hypertables in it.
# `timescaledb_pre_restore()` runs `ALTER DATABASE … SET timescaledb.restoring`, which is a
# superuser action — the application's own role cannot do it and should not be able to. On the
# deployment ADR-001 describes, PostgreSQL is on this host and `postgres` is reachable from root,
# so that is tried second. A remote database has to be told by somebody who can.
restoring_mode() {
  local fn="timescaledb_$1_restore"
  psql_ms -c "SELECT ${fn}()" >/dev/null 2>&1 && return 0
  if id postgres >/dev/null 2>&1; then
    su postgres -c "psql -d '${cfg_database}' -qtAc 'SELECT ${fn}()'" >/dev/null 2>&1 && return 0
  fi
  return 1
}

echo "    preparing the extension"
psql_ms -c "CREATE EXTENSION IF NOT EXISTS timescaledb" >/dev/null 2>&1 || die \
  "this database has no timescaledb extension and ${cfg_user} cannot create one.
    Run, as a superuser:  psql -d ${cfg_database} -c 'CREATE EXTENSION timescaledb'
  then run this again."
# The dump carries TimescaleDB's *internal* tables — the compressed hypertables among them — and
# those live in schemas the extension owns, not the application. On the machine the backup came
# from the extension created them with its own privileges; here they arrive as ordinary
# `CREATE TABLE` statements from a role that has no rights in that schema. Granting them for the
# restore is the narrow fix: the role already owns every byte of the data, so this gives it
# nothing it did not have, and it is what lets the restore run as the application rather than as
# a superuser leaving every table owned by `postgres`.
#
# The catalog *tables* need it as much as the schemas do — the dump COPYs into
# `_timescaledb_catalog.hypertable`, which is how a restored database knows which tables are
# hypertables at all.
grant_internal() {
  id postgres >/dev/null 2>&1 || return 1
  su postgres -c "psql -d '${cfg_database}' -qtAc \"
    DO \\\$\\\$
    DECLARE s text;
    BEGIN
      FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE '_timescaledb%'
      LOOP
        EXECUTE format('GRANT ALL ON SCHEMA %I TO %I', s, '${cfg_user}');
        EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %I', s, '${cfg_user}');
        EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO %I', s, '${cfg_user}');
      END LOOP;
    END
    \\\$\\\$;\"" >/dev/null 2>&1
}

restoring_mode pre || die \
  "could not put timescaledb into restore mode: it needs a superuser, and neither ${cfg_user} nor
  a local 'postgres' account could do it. Restoring without it produces a database whose
  hypertables are ordinary tables — which looks restored and is not. As a superuser, run:

    psql -d ${cfg_database} -c 'SELECT timescaledb_pre_restore()'
    ${PREFIX}/bin/ms-restore ${archive} --database-only
    psql -d ${cfg_database} -c 'SELECT timescaledb_post_restore()'"

grant_internal || echo "    note: could not grant on the timescaledb schemas; a restore that needs them will say so" >&2

toc="${staging}/toc.list"
pg_restore --list "${work}/database.dump" | grep -v -E ' (EXTENSION|COMMENT) - ' > "${toc}" || true

restore_status=0
pg_restore --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
  --dbname="${cfg_database}" --no-owner --no-privileges --exit-on-error \
  --use-list="${toc}" \
  "${work}/database.dump" || restore_status=$?

# `post_restore` runs whatever happened: leaving the extension in restore mode would leave the
# database subtly broken in a way nothing else reports.
restoring_mode post || echo "    WARNING: could not leave restore mode; run SELECT timescaledb_post_restore() as a superuser" >&2
[ "${restore_status}" -eq 0 ] || die "pg_restore failed (exit ${restore_status}); the database is incomplete"

cat <<'NEXT'

==> restored.

Before starting, check that this build matches the schema that was restored:

    /opt/ms/bin/ms-core config check
    /opt/ms/bin/ms-core migrate status

A backup taken from a newer release carries a newer schema, and ms-core refuses to start against
one. Install the matching release rather than migrating backwards.

    systemctl start ms-core ms-probe
NEXT

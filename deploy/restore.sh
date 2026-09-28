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
#   2. Refuse unless the database will take it: reachable, empty, and with the TimescaleDB version
#      the archive was taken with. `pg_restore --clean` into a populated database is the
#      commonest way a restore half-works, and a different extension version is the second. Asked
#      before anything is written, so a refusal leaves the host as it was.
#   3. Restore the configuration, the vault key and the probe-channel certificates *first*, so a
#      failure part-way leaves a system that cannot start rather than one that starts and cannot
#      decrypt anything it reads.
#   4. Restore the database.
#   5. Say what to do next, which is to check the schema before starting.
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
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
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

# 1. Nothing may be running — and "running" is every state but stopped (`H-21`). `is-active
# --quiet` is true only for `active`, and a core waiting for its database is `activating`, in five-
# minute rounds for as long as the database is missing (`P-215`) — which, in a disaster recovery,
# is exactly how the core is found. It would connect within seconds of the empty database appearing
# and migrate into it alongside `pg_restore`. A unit between restarts is `activating` too.
for svc in ms-core ms-probe; do
  state="$(systemctl is-active "${svc}" 2>/dev/null || true)"
  case "${state}" in
    inactive|failed|'') ;;
    *) die "${svc} is ${state}; stop it first (systemctl stop ms-core ms-probe)" ;;
  esac
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

# 2. Everything that can refuse, before anything is written (`H-21`). The database this is going
# into — reachable, empty, and with the TimescaleDB the archive was taken with — is asked about
# first, so that a refusal leaves this host exactly as it was. It used to restore /etc/ms and the
# vault key before it had asked, and then refuse. The settings are the ones the core will run
# with afterwards: the archive's, unless `--database-only` keeps this host's.
db_config="${CONFDIR}/core.json"
if [ "${database_only}" -eq 0 ] && [ -f "${work}/core.json" ]; then db_config="${work}/core.json"; fi
[ -f "${db_config}" ] || die "no core.json to read the database connection from (${db_config})"

# **Nothing read from the configuration is handed to a shell parser** (`H-21`), for the reason
# `ms-backup` gives: this used to `eval` generated assignments, so a password with a `$` in it
# aborted the restore and one with a backtick ran as root — here from a file that came out of an
# archive. Values come back one per line and are read by position, the password goes straight into
# a libpq password file in the private staging directory, and the two names that reach a command
# line as `postgres` are held to what a role or a database is ordinarily called.
config="$(node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const [file, passFile] = process.argv.slice(1);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  const db = cfg.database ?? {};
  const fields = [
    db.host ?? "127.0.0.1",
    db.port ?? 5432,
    db.database ?? "monitoring",
    db.user ?? "monitoring",
  ].map(String);
  if (fields.some((value) => /[\r\n\0]/.test(value))) {
    console.error(`${file}: a database setting has a line break in it`);
    process.exit(1);
  }
  for (const [what, name] of [["database", fields[2]], ["user", fields[3]]]) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) {
      console.error(`${file}: database.${what} "${name}" is not a name this script will pass to psql`);
      process.exit(1);
    }
  }
  const password = String(db.password ?? "");
  if (password !== "") {
    const escaped = password.replace(/[\\:]/g, (c) => `\\${c}`);
    writeFileSync(passFile, `*:*:*:*:${escaped}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${fields.join("\n")}\n`);
' "${db_config}" "${staging}/pgpass")" || die "could not read ${db_config}"
cfg_host="$(printf '%s\n' "${config}" | sed -n 1p)"
cfg_port="$(printf '%s\n' "${config}" | sed -n 2p)"
cfg_database="$(printf '%s\n' "${config}" | sed -n 3p)"
cfg_user="$(printf '%s\n' "${config}" | sed -n 4p)"
if [ -f "${staging}/pgpass" ]; then
  export PGPASSFILE="${staging}/pgpass"
  unset PGPASSWORD
fi

echo "==> checking ${cfg_database} on ${cfg_host}:${cfg_port}"
# Asked first and on its own, with psql's own reason left on the terminal: every question below
# reads a failure as "no", and a password PostgreSQL refuses is not "an empty database".
psql --no-psqlrc --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
  --dbname="${cfg_database}" -qtAc 'SELECT 1' >/dev/null \
  || die "could not connect to ${cfg_database} on ${cfg_host}:${cfg_port} as ${cfg_user}"
existing="$(psql --no-psqlrc --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
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
  psql --no-psqlrc --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
    --dbname="${cfg_database}" -qtA "$@"
}

# The same database as the local `postgres` superuser, with no shell between here and psql: the
# database name is an argument, never part of a command string.
psql_postgres() {
  id postgres >/dev/null 2>&1 || return 1
  runuser -u postgres -- psql --no-psqlrc -d "${cfg_database}" -qtA "$@"
}

# **The extension version the archive was taken with, and no other** (`H-21`). A dump's
# `_timescaledb_catalog` rows are laid out for the extension that wrote them, and Timescale restores
# only into the same version: 2.28 replaced `_timescaledb_catalog.chunk_constraint`, a table the
# dump COPYs into, with a view. `CREATE EXTENSION` with no version installs the newest one on this
# host, and a host rebuilt after a disaster has whatever the repository served that day — so this
# used to fail hundreds of tables in, or, where the COPY happened to fit, load rows whose meaning
# had changed. `ms-backup` records the version in the manifest; an archive from before it did not.
archived_tsdb="$(sed -n 's/^timescaledb=//p' "${work}/MANIFEST" 2>/dev/null | head -1)"
case "${archived_tsdb}" in
  '') ;;
  *[!0-9A-Za-z.-]*) die "the archive's manifest names timescaledb '${archived_tsdb}', which is not a version" ;;
esac

tsdb_mismatch() {
  local found="$1"
  local pg_major
  pg_major="$(psql_ms -c "SELECT current_setting('server_version_num')::int / 10000" 2>/dev/null || echo '<major>')"
  die "this archive was taken with TimescaleDB ${archived_tsdb}, and ${found}.
  Timescale restores only into the version that took the dump. Nothing has been restored. To go on:

    1. Install TimescaleDB ${archived_tsdb} for PostgreSQL ${pg_major} beside, or instead of, the
       one this host has (runbook-backup-restore.md, \"The TimescaleDB version\").
    2. As a superuser, in the empty database:
         DROP EXTENSION IF EXISTS timescaledb;
         CREATE EXTENSION timescaledb VERSION '${archived_tsdb}';
    3. Run this again.
    4. Then, and before ms-core starts, bring the extension up to the installed one:
         psql -X -d ${cfg_database} -c 'ALTER EXTENSION timescaledb UPDATE'"
}

echo "    preparing the extension"
installed_tsdb="$(psql_ms -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'" 2>/dev/null || true)"
if [ -z "${installed_tsdb}" ]; then
  if [ -n "${archived_tsdb}" ]; then
    offered="$(psql_ms -c "SELECT count(*) FROM pg_available_extension_versions WHERE name = 'timescaledb' AND version = '${archived_tsdb}'" 2>/dev/null || echo 0)"
    [ "${offered}" = "1" ] || tsdb_mismatch "this host does not have that version installed"
    create="CREATE EXTENSION timescaledb VERSION '${archived_tsdb}'"
  else
    create="CREATE EXTENSION timescaledb"
  fi
  psql_ms -c "${create}" >/dev/null 2>&1 || psql_postgres -c "${create}" >/dev/null 2>&1 || die \
    "this database has no timescaledb extension and neither ${cfg_user} nor a local 'postgres'
  account could create one. Run, as a superuser:  psql -d ${cfg_database} -c \"${create}\"
  then run this again."
  installed_tsdb="$(psql_ms -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")"
fi
if [ -z "${archived_tsdb}" ]; then
  echo "    WARNING: this archive does not say which TimescaleDB took it (taken before H-21). If" >&2
  echo "    the restore fails in _timescaledb_catalog, install the version that took it and retry." >&2
elif [ "${installed_tsdb}" != "${archived_tsdb}" ]; then
  tsdb_mismatch "this database has ${installed_tsdb}"
fi
echo "    timescaledb ${installed_tsdb}"

# 3. Configuration, key and certificates before the data.
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

# 4. The database.
#
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
  psql_postgres -c "SELECT ${fn}()" >/dev/null 2>&1 && return 0
  return 1
}

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
#
# The role's name reaches the server as a psql variable and a session setting, not as text spliced
# into the statement.
grant_internal() {
  psql_postgres -v ON_ERROR_STOP=1 -v role="${cfg_user}" >/dev/null 2>&1 <<'SQL'
SELECT set_config('ms.restore_role', :'role', false);
DO $$
DECLARE
  s text;
  r text := current_setting('ms.restore_role');
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE '_timescaledb%'
  LOOP
    EXECUTE format('GRANT ALL ON SCHEMA %I TO %I', s, r);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %I', s, r);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO %I', s, r);
  END LOOP;
END
$$;
SQL
}

echo "==> restoring ${cfg_database}"
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

cat <<NEXT

==> restored.

Before starting, check that this build matches the schema that was restored:

    ${PREFIX}/bin/ms-core config check --config ${CONFDIR}/core.json
    ${PREFIX}/bin/ms-core migrate status --config ${CONFDIR}/core.json

A backup taken from a newer release carries a newer schema, and ms-core refuses to start against
one. Install the matching release rather than migrating backwards.

    systemctl reset-failed ms-core ms-probe
    systemctl start ms-core ms-probe
NEXT

#!/usr/bin/env bash
# MonitoringSystem backup (H-04).
#
#     sudo ./backup.sh [--out /var/backups/ms] [--config /etc/ms/core.json]
#
# Produces one timestamped tar.gz holding everything a restore needs and nothing it does not:
# the database, the configuration, the credential-vault key and the probe-channel certificates.
#
# **The vault key is in here, and that is not optional.** Monitored-device credentials are
# encrypted at rest with it; a backup without it restores a system that cannot log in to anything
# it monitors, and there is no way to recover them afterwards. It also means this archive is as
# sensitive as the credentials themselves — it is written 0600 and belongs somewhere with the
# same protection as the database's own storage. `restore.sh` says so again on the way back in.
#
# **What is deliberately not here**: the probe's result spool, which is a queue and not data — a
# restored probe re-reads what it needs from its own disk or simply carries on — and the
# application itself, which comes from the release tarball. A backup of /opt/ms would be a copy
# of something already reproducible, and restoring it over a newer install is a downgrade nobody
# asked for.
set -euo pipefail

CONFIG=/etc/ms/core.json
OUT=/var/backups/ms
label=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift ;;
    --out)    OUT="$2"; shift ;;
    --label)  label="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ -f "${CONFIG}" ] || die "no such configuration: ${CONFIG}"
command -v pg_dump >/dev/null 2>&1 || die "pg_dump is required (install the PostgreSQL client)"
command -v psql >/dev/null 2>&1 || die "psql is required (install the PostgreSQL client)"

# Read the connection out of the configuration rather than asking for it again. A backup pointed
# at a different database from the one the service uses is the kind of mistake that is only
# discovered during a restore.
#
# **Nothing read from the configuration is handed to a shell parser** (`H-21`). This used to
# `eval` generated `cfg_x="…"` assignments, so a database password with a `$` in it — which is
# what password generators produce — aborted the backup under `set -u`, and one with a backtick or
# `$(…)` in it ran as root. The values come back one per line and are read by position, and the
# password never comes back at all: node writes it straight into a libpq password file inside
# the private staging directory, which `pg_dump` and `psql` read and nothing else does.
#
# A configuration with no password leaves libpq's own environment alone, so an installation whose
# password is a systemd credential rather than a line in core.json (`ms-core.service`'s drop-in)
# can supply it the way libpq always takes one — `PGPASSWORD` or `PGPASSFILE`.
read_config() {
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [file, passFile] = process.argv.slice(1);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    const db = cfg.database ?? {};
    const fields = [
      db.host ?? "127.0.0.1",
      db.port ?? 5432,
      db.database ?? "monitoring",
      db.user ?? "monitoring",
      (cfg.service ?? {}).dataDir ?? "/var/lib/ms-core",
      (cfg.vault ?? {}).keyFile ?? "vault.key",
    ].map(String);
    if (fields.some((value) => /[\r\n\0]/.test(value))) {
      console.error(`${file}: a database or path setting has a line break in it`);
      process.exit(1);
    }
    const password = String(db.password ?? "");
    if (password !== "") {
      // libpq reads `host:port:database:user:password`, with `:` and `\` escaped by a backslash.
      // Wildcards, because this file lives for one run and serves one connection.
      const escaped = password.replace(/[\\:]/g, (c) => `\\${c}`);
      writeFileSync(passFile, `*:*:*:*:${escaped}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${fields.join("\n")}\n`);
  ' "$1" "$2"
}

staging="$(mktemp -d)"
trap 'rm -rf "${staging}"' EXIT
chmod 700 "${staging}"

config="$(read_config "${CONFIG}" "${staging}/pgpass")" || die "could not read ${CONFIG}"
cfg_host="$(printf '%s\n' "${config}" | sed -n 1p)"
cfg_port="$(printf '%s\n' "${config}" | sed -n 2p)"
cfg_database="$(printf '%s\n' "${config}" | sed -n 3p)"
cfg_user="$(printf '%s\n' "${config}" | sed -n 4p)"
cfg_dataDir="$(printf '%s\n' "${config}" | sed -n 5p)"
cfg_keyFile="$(printf '%s\n' "${config}" | sed -n 6p)"
if [ -f "${staging}/pgpass" ]; then
  export PGPASSFILE="${staging}/pgpass"
  unset PGPASSWORD
fi

case "${cfg_keyFile}" in
  /*) key_path="${cfg_keyFile}" ;;
  *)  key_path="${cfg_dataDir}/${cfg_keyFile}" ;;
esac

psql_ms() {
  psql --no-psqlrc --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
    --dbname="${cfg_database}" -qtA "$@"
}

# **Which TimescaleDB took this dump, written into the archive** (`H-21`). A dump's
# `_timescaledb_catalog` rows are laid out for the extension version that wrote them, and Timescale
# restores only into the same version: 2.28 replaced a catalog table the dump COPYs into with a
# view. A replacement host is built from whatever the repository serves on the day, so the one
# fact a disaster recovery needs is the one the archive has to carry — `ms-restore` refuses a
# mismatch with this version in the message.
tsdb_version="$(psql_ms -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")" \
  || die "could not reach ${cfg_database} on ${cfg_host}:${cfg_port} as ${cfg_user}"
pg_version="$(psql_ms -c 'SHOW server_version')"
[ -n "${tsdb_version}" ] || die "${cfg_database} has no timescaledb extension — is this the database ms-core uses?"

stamp="$(date -u +%Y%m%dT%H%M%SZ)${label:+-${label}}"
work="${staging}/ms-backup-${stamp}"
mkdir -p "${work}"

echo "==> backing up ${cfg_database} on ${cfg_host}:${cfg_port}"
# --format=custom so `pg_restore` can rebuild in dependency order and parallelise; --no-owner and
# --no-privileges because the role names on the machine this is restored onto are the restoring
# operator's business, not this database's.
pg_dump \
  --host="${cfg_host}" --port="${cfg_port}" --username="${cfg_user}" \
  --dbname="${cfg_database}" \
  --format=custom --no-owner --no-privileges \
  --file="${work}/database.dump"

echo "==> including the configuration and the vault key"
install -m 0600 "${CONFIG}" "${work}/core.json"
[ -f /etc/ms/probe.json ] && install -m 0600 /etc/ms/probe.json "${work}/probe.json"
if [ -f "${key_path}" ]; then
  install -m 0600 "${key_path}" "${work}/vault.key"
else
  # Loud, not fatal: an installation with no credentials stored yet has no key, and refusing to
  # back it up would be refusing to back up a system that is working.
  echo "    WARNING: no vault key at ${key_path}; stored credentials will not be recoverable" >&2
fi

if [ -d /etc/ms/tls ]; then
  mkdir -p "${work}/tls"
  cp /etc/ms/tls/* "${work}/tls/" 2>/dev/null || true
  chmod 600 "${work}"/tls/* 2>/dev/null || true
fi

# What was backed up, by what, and from where. A restore that cannot tell which release produced
# an archive is a restore that finds out from a migration error.
version="unknown"
[ -f /opt/ms/VERSION ] && version="$(cat /opt/ms/VERSION)"
cat > "${work}/MANIFEST" <<MANIFEST
takenAt=${stamp}
version=${version}
host=$(hostname)
database=${cfg_database}
databaseHost=${cfg_host}:${cfg_port}
timescaledb=${tsdb_version}
postgresql=${pg_version}
vaultKey=$([ -f "${key_path}" ] && echo present || echo MISSING)
MANIFEST

install -d -m 0700 "${OUT}"
archive="${OUT}/ms-backup-${stamp}.tar.gz"
tar -czf "${archive}" -C "${staging}" "ms-backup-${stamp}"
chmod 600 "${archive}"

cat <<SUMMARY
==> ${archive}
    $(du -h "${archive}" | cut -f1) — database, configuration, vault key, probe-channel certificates

This archive decrypts every monitored-device credential in the installation. Store it where the
database's own storage is stored, and no more widely.
SUMMARY

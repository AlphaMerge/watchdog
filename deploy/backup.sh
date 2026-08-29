#!/usr/bin/env bash
# MonitoringSystem backup (TASKS.md H-04).
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
# The `cfg_*` variables are produced by an `eval` of generated assignments below. shellcheck
# cannot follow that and reports each of them as referenced but never assigned; the directive is
# file-scoped because it has to sit before the first command to be, and it is the reason the
# generator emits a fixed, known set of names rather than whatever the config happens to hold.
# shellcheck disable=SC2154
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

# Read the connection out of the configuration rather than asking for it again. A backup pointed
# at a different database from the one the service uses is the kind of mistake that is only
# discovered during a restore.
read_config() {
  node -e '
    const { readFileSync } = require("node:fs");
    const cfg = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const db = cfg.database ?? {};
    const out = {
      host: db.host ?? "127.0.0.1",
      port: db.port ?? 5432,
      database: db.database ?? "monitoring",
      user: db.user ?? "monitoring",
      password: db.password ?? "",
      dataDir: (cfg.service ?? {}).dataDir ?? "/var/lib/ms-core",
      keyFile: (cfg.vault ?? {}).keyFile ?? "vault.key",
    };
    process.stdout.write(Object.entries(out).map(([k, v]) => `${k}=${String(v)}`).join("\n"));
  ' "$1"
}

eval "$(read_config "${CONFIG}" | sed 's/^/cfg_/;s/=/="/;s/$/"/')"

case "${cfg_keyFile}" in
  /*) key_path="${cfg_keyFile}" ;;
  *)  key_path="${cfg_dataDir}/${cfg_keyFile}" ;;
esac

stamp="$(date -u +%Y%m%dT%H%M%SZ)${label:+-${label}}"
staging="$(mktemp -d)"
trap 'rm -rf "${staging}"' EXIT
work="${staging}/ms-backup-${stamp}"
mkdir -p "${work}"

echo "==> backing up ${cfg_database} on ${cfg_host}:${cfg_port}"
# --format=custom so `pg_restore` can rebuild in dependency order and parallelise; --no-owner and
# --no-privileges because the role names on the machine this is restored onto are the restoring
# operator's business, not this database's.
PGPASSWORD="${cfg_password}" pg_dump \
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

#!/usr/bin/env bash
# Prepares PostgreSQL inside the smoke-test box.
#
# This is the operator's prerequisite, not something install.sh does: the installer sets up
# MonitoringSystem, and the documentation tells an operator to have PostgreSQL ready first.
set -euo pipefail

# TimescaleDB has to be preloaded, which means a configuration change and a restart — exactly
# what the migration's own error message tells an operator to do.
pg_conf="$(find /etc/postgresql -name postgresql.conf | head -1)"
if ! grep -q "^shared_preload_libraries.*timescaledb" "${pg_conf}"; then
  echo "shared_preload_libraries = 'timescaledb'" >> "${pg_conf}"
  # Explicit, though it is also TimescaleDB's default: ms-core needs native compression, which
  # is Timescale Community rather than Apache, and migration 004 refuses to apply without it.
  echo "timescaledb.license = 'timescale'" >> "${pg_conf}"
fi

systemctl restart postgresql

for _ in $(seq 1 30); do
  pg_isready -q && break
  sleep 1
done
pg_isready -q || { echo "postgres did not become ready" >&2; exit 1; }

run_sql() { su postgres -c "psql -tAc \"$1\""; }

if [ "$(run_sql "SELECT 1 FROM pg_roles WHERE rolname = 'monitoring'")" != "1" ]; then
  run_sql "CREATE ROLE monitoring LOGIN PASSWORD 'monitoring'"
fi

if [ "$(run_sql "SELECT 1 FROM pg_database WHERE datname = 'monitoring'")" != "1" ]; then
  su postgres -c "createdb -O monitoring monitoring"
fi

su postgres -c "psql -d monitoring -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'" >/dev/null

echo "postgres ready with timescaledb $(su postgres -c "psql -d monitoring -tAc \"SELECT extversion FROM pg_extension WHERE extname='timescaledb'\"")"

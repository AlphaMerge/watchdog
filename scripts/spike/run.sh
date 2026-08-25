#!/usr/bin/env bash
# Storage spike: measure the Apache-only rollup path against the Timescale-License one.
#
# Runs a dedicated PostgreSQL container so the development database is left alone, first in
# `apache` licence mode and then restarted in `timescale` mode against the same data.
#
#   scripts/spike/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
container=ms-spike-rollup
image=timescale/timescaledb:latest-pg17
out="${here}/../../dev/data/spike"
mkdir -p "${out}"

start_pg() {
  local licence="$1"
  docker rm -f "${container}" >/dev/null 2>&1 || true
  docker run -d --name "${container}" \
    -e POSTGRES_DB=spike -e POSTGRES_USER=spike -e POSTGRES_PASSWORD=spike \
    -e TIMESCALEDB_TELEMETRY=off \
    -v "${container}-data:/var/lib/postgresql/data" \
    "${image}" \
    postgres -c shared_preload_libraries=timescaledb -c "timescaledb.license=${licence}" \
      -c shared_buffers=512MB -c work_mem=64MB -c maintenance_work_mem=256MB >/dev/null
  for _ in $(seq 1 60); do
    docker exec "${container}" pg_isready -U spike -d spike >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "postgres did not become ready" >&2
  exit 1
}

restart_pg() {
  local licence="$1"
  docker stop "${container}" >/dev/null
  docker rm "${container}" >/dev/null
  docker run -d --name "${container}" \
    -e POSTGRES_DB=spike -e POSTGRES_USER=spike -e POSTGRES_PASSWORD=spike \
    -e TIMESCALEDB_TELEMETRY=off \
    -v "${container}-data:/var/lib/postgresql/data" \
    "${image}" \
    postgres -c shared_preload_libraries=timescaledb -c "timescaledb.license=${licence}" \
      -c shared_buffers=512MB -c work_mem=64MB -c maintenance_work_mem=256MB >/dev/null
  for _ in $(seq 1 60); do
    docker exec "${container}" pg_isready -U spike -d spike >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "postgres did not come back" >&2
  exit 1
}

run_sql() {
  docker exec -i "${container}" psql -U spike -d spike -v ON_ERROR_STOP=0 -q < "$1"
}

echo "==> phase 1: apache licence"
docker volume rm "${container}-data" >/dev/null 2>&1 || true
start_pg apache
docker exec "${container}" psql -U spike -d spike -tAc "SHOW timescaledb.license"

run_sql "${here}/rollup-00-setup.sql"            | tee "${out}/00-setup.txt"
run_sql "${here}/rollup-01-apache.sql"           | tee "${out}/01-apache.txt"
run_sql "${here}/rollup-02-apache-incremental.sql" | tee "${out}/02-apache-incremental.txt"
run_sql "${here}/rollup-03-sizes.sql"            | tee "${out}/03-apache-sizes.txt"
run_sql "${here}/rollup-04-query.sql"            | tee "${out}/04-apache-query.txt"

echo
echo "==> phase 2: timescale licence, same data"
restart_pg timescale
docker exec "${container}" psql -U spike -d spike -tAc "SHOW timescaledb.license"

run_sql "${here}/rollup-05-cagg.sql"             | tee "${out}/05-cagg.txt"
run_sql "${here}/rollup-06-cagg-incremental.sql" | tee "${out}/06-cagg-incremental.txt"
run_sql "${here}/rollup-07-compression.sql"      | tee "${out}/07-compression.txt"

echo
echo "==> results written to ${out}"
docker rm -f "${container}" >/dev/null
docker volume rm "${container}-data" >/dev/null 2>&1 || true

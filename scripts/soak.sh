#!/usr/bin/env bash
# The 24-hour soak (TASKS.md H-01).
#
#     ./scripts/soak.sh                       # 5,000 sensors, 24 hours
#     ./scripts/soak.sh --hours 2             # a shorter window, same harness
#     ./scripts/soak.sh --report FILE         # analyse a run that has already happened
#     ./scripts/soak.sh --teardown            # remove the soak tree
#
# Provisions the load, samples the installation's own health sensors once a minute, checks the
# rollups against the samples they were built from every fifteen, and reports a verdict on the
# three things H-01 asks about: no memory growth, no scheduler lag drift, rollups correct
# throughout.
#
# **It runs against a real installation, not a simulation.** The dev stack is the one to point it
# at locally; nothing here assumes that, and `MS_API` points it at any other. It writes into
# `docs/findings/` because a performance claim without a measurement committed to the repo is not
# a claim this project makes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${MS_API:-http://127.0.0.1:8080/api/v1}"
PG_CONTAINER="${MS_PG_CONTAINER:-monitoring-system-dev-postgres-1}"

hours=24
sensors=5000
report_only=''
teardown=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hours)    hours="$2"; shift ;;
    --sensors)  sensors="$2"; shift ;;
    --report)   report_only="$2"; shift ;;
    --teardown) teardown=1 ;;
    -h|--help)  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "${report_only}" ]; then
  exec node "${repo_root}/scripts/soak/report.mjs" "${report_only}"
fi

if [ "${teardown}" -eq 1 ]; then
  exec node "${repo_root}/scripts/soak/provision.mjs" --remove --api "${API}"
fi

command -v node >/dev/null 2>&1 || { echo "error: Node.js is required" >&2; exit 1; }
curl -sf "${API}/objects/root" >/dev/null || {
  echo "error: no installation answering at ${API}" >&2
  echo "       start one:  scripts/dev-services.sh start" >&2
  exit 1
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="${repo_root}/docs/findings/soak-${stamp}.jsonl"
rollups="${repo_root}/docs/findings/soak-${stamp}-rollups.txt"

echo "==> provisioning ${sensors} sensors"
node "${repo_root}/scripts/soak/provision.mjs" --sensors "${sensors}" --api "${API}"

# **A settling period before the first sample.** Five thousand sensors created in the last minute
# are five thousand first checks in the next one, and the burst that produces is the provisioning
# path's behaviour rather than the steady state H-01 asks about. One scan interval is enough for
# the wheel to spread them.
echo "==> letting the wheel spread the first scan (90s)"
sleep 90

# Rollup correctness, on its own clock. Every fifteen minutes rather than every minute because
# the query scans an hour of raw samples, and a soak whose instrument is a measurable load on the
# thing it measures is not measuring it.
(
  while true; do
    sleep 900
    {
      printf '\n===== %s =====\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      docker exec -i "${PG_CONTAINER}" psql -U monitoring -d monitoring \
        < "${repo_root}/scripts/soak/check-rollups.sql" 2>&1 || echo "(rollup check failed to run)"
    } >> "${rollups}"
  done
) &
rollup_watcher=$!
trap 'kill "${rollup_watcher}" 2>/dev/null || true' EXIT

echo "==> sampling for ${hours}h into ${out}"
node "${repo_root}/scripts/soak/sample.mjs" --out "${out}" --hours "${hours}" --api "${API}"

kill "${rollup_watcher}" 2>/dev/null || true

echo
echo "==> rollup checks"
if [ -f "${rollups}" ]; then
  # Any non-zero in a column other than the first means a bucket disagreed with its samples.
  awk '/^ *[0-9]+ \|/ { print }' "${rollups}" | tail -5
  bad="$(awk -F'|' '/^ *[0-9]+ \|/ { for (i = 2; i <= 6; i++) if ($i + 0 > 0) n++ } END { print n + 0 }' "${rollups}")"
  echo "    disagreeing columns across all checks: ${bad}"
else
  echo "    none ran (a soak shorter than 15 minutes)"
fi

echo
node "${repo_root}/scripts/soak/report.mjs" "${out}"

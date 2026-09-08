#!/usr/bin/env bash
# Put the dev stack back to what a *fresh install* starts from (`P-187`).
#
#     scripts/dev-reset.sh              # shows what it will destroy, then asks
#     scripts/dev-reset.sh --yes        # for a script; there is no undo
#     scripts/dev-reset.sh --no-start   # reset, but leave ms-server stopped
#
# **A development database that has been migrated forward for weeks is not the thing we ship.**
# `P-183` is what this exists for: `ensureFirstAdministrator` created the bootstrap account in no
# group, so on a fresh install the only account was refused by all 32 object-scoped routes — and
# every environment anybody used had been *upgraded* into user groups by migration `032`, whose
# backfill put existing admins in `Administrators`. The defect was invisible for as long as it
# existed because nothing anybody ran was new. The only fresh installation this project made was
# the one `smoke-install.sh` builds in a container, and it could not see it either until `U-20`
# gave it a credential to be refused with.
#
# So: a way to be new, cheaply, on purpose.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker-compose.dev.yml"
data_dir="${repo_root}/dev/data"
db_name="monitoring"
db_user="monitoring"
assume_yes=0
start_after=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)      assume_yes=1 ;;
    --no-start) start_after=0 ;;
    -h|--help)  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# **Named one by one, not as a directory.** `dev/data` is also where somebody's own notes and
# scratch files live — `api.txt`, `smoke-api.sh`, `spike/`, `test-logs/` — and a reset that took
# the directory would take those with it. What a fresh install does not have is the database, the
# vault key, the generated password and the probe's spool. Nothing else here is *state*:
# `lookups/` and `device-templates/` are content an operator authored, and a fresh install is
# perfectly entitled to them.
state=("${data_dir}/vault.key" "${data_dir}/first-admin-password" "${data_dir}/spool")

echo "this will destroy, and there is no undo:"
echo "  - the '${db_name}' database in the dev PostgreSQL container (schema and every row)"
for one in "${state[@]}"; do
  if [ -e "${one}" ]; then
    echo "  - ${one#"${repo_root}/"}"
  else
    echo "  - ${one#"${repo_root}/"} (already absent)"
  fi
done
echo "it will not touch: the container or its volume, any other database including the"
echo "                   ms_test_* scratch ones, or anything else under dev/data"
echo

if [ "${assume_yes}" -ne 1 ] && [ "${MS_ASSUME_YES:-}" != "1" ]; then
  if [ ! -t 0 ]; then
    echo "refusing: nothing to ask on, and no --yes. Pass --yes if you mean it." >&2
    exit 1
  fi
  printf 'reset it? [y/N] '
  read -r answer
  case "${answer}" in
    y | Y) ;;
    *) echo "left alone"; exit 1 ;;
  esac
fi

# The core holds a pool open, and `DROP DATABASE` will not run while anything is connected.
# `WITH (FORCE)` would evict them, but a core that is mid-write when its database vanishes is a
# needless way to find out what that does.
echo "==> stopping ms-server"
"${repo_root}/scripts/dev-services.sh" stop >/dev/null

echo "==> dropping and recreating '${db_name}'"
docker compose -f "${compose_file}" exec -T postgres \
  psql -U "${db_user}" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS ${db_name} WITH (FORCE)" \
  -c "CREATE DATABASE ${db_name} OWNER ${db_user}"

# **Checked rather than assumed.** The database inherits `timescaledb` from `template1`, which is
# where the image's own initialisation put it — so this works and migration `003` will find what
# it needs. If that ever stops being true the failure is a migration abort with a good message,
# and this check turns it into a sentence at the point the assumption was made.
if ! docker compose -f "${compose_file}" exec -T postgres \
  psql -U "${db_user}" -d "${db_name}" -tAc \
  "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'" | grep -q 1; then
  echo "error: the new '${db_name}' has no timescaledb extension" >&2
  echo "       it is inherited from template1; check that the image still installs it there" >&2
  exit 1
fi

echo "==> removing the state a fresh install has none of"
for one in "${state[@]}"; do
  rm -rf "${one}"
  echo "    ${one#"${repo_root}/"}"
done

if [ "${start_after}" -ne 1 ]; then
  echo "done. start it with: scripts/dev-services.sh start"
  exit 0
fi

echo "==> starting ms-server, which will migrate and bootstrap"
"${repo_root}/scripts/dev-services.sh" start >/dev/null

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1; then break; fi
  sleep 1
done

if [ -r "${data_dir}/first-admin-password" ]; then
  echo
  echo "a fresh installation is running."
  echo "  password  dev/data/first-admin-password"
  echo "  token     eval \"\$(scripts/dev-token.sh)\""
  echo "  UI        http://127.0.0.1:5173 (npm run dev:ui)"
  echo
  echo "there are no objects and no probe branch claimed — see README, 'Making it actually scan"
  echo "something', which is the path a real operator walks and is now the one you are on."
else
  echo "error: ms-core did not write a bootstrap password; check scripts/dev-services.sh logs" >&2
  exit 1
fi

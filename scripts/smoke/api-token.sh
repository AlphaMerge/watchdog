#!/usr/bin/env bash
# Prints an API token for the installation on this box. Runs *inside* the smoke container.
#
# The shipped `core.json` does not set `api.requireAuthentication`, so it defaults to on — which
# is correct for the thing being smoke-tested and means the assertions below it need a credential
# (`U-20`). A bearer token rather than a session, because the caller is a `docker exec curl` on
# the other side of a container boundary and a cookie jar does not survive that.
#
# The password is the one `ensureFirstAdministrator` generated on first boot. On a box this test
# built ninety seconds ago it is still there; if it is not, the installation was not fresh and
# that is worth failing over rather than working around.
#
# A token's name is unique per account, so a second caller on the same box — a measurement run
# after the smoke test, say — names its own with `MS_TOKEN_NAME`, or is refused `TOKEN_EXISTS`.
set -euo pipefail

API="${MS_API:-http://127.0.0.1:8080/api/v1}"
token_name="${MS_TOKEN_NAME:-smoke}"
password_file="${MS_PASSWORD_FILE:-/var/lib/ms-core/first-admin-password}"

[ -r "${password_file}" ] || {
  echo "error: no ${password_file} — this installation is not fresh" >&2
  exit 1
}

password="$(head -1 "${password_file}")"
login="$(sed -n "s/.*password for the '\([^']*\)' account.*/\1/p" "${password_file}")"
login="${login:-admin}"

jar="$(mktemp)"
trap 'rm -f "${jar}"' EXIT

body="$(node -e '
  const [login, password] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ login, password }));
' "${login}" "${password}")"

code="$(curl -s -o /dev/null -w '%{http_code}' -c "${jar}" \
  -H 'content-type: application/json' -d "${body}" "${API}/auth/login")"
[ "${code}" = "200" ] || {
  echo "error: ${API}/auth/login answered ${code} for '${login}'" >&2
  exit 1
}

request="$(node -e '
  process.stdout.write(JSON.stringify({ name: process.argv[1], scope: "full" }));
' "${token_name}")"
issued="$(curl -s -b "${jar}" -H 'content-type: application/json' \
  -d "${request}" "${API}/auth/tokens")"
secret="$(printf '%s' "${issued}" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')"
[ -n "${secret}" ] || {
  echo "error: no secret in ${issued}" >&2
  exit 1
}

printf '%s\n' "${secret}"

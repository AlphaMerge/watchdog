#!/usr/bin/env bash
# An API token for the dev stack, for the shell clients in this repository (`U-20`).
#
#     eval "$(scripts/dev-token.sh)"      # sets MS_TOKEN in this shell
#     scripts/dev-token.sh --secret       # just the secret, for a script to capture
#
# `dev/core.json` runs with `api.requireAuthentication` on, the same as a stock install, so
# `scripts/soak.sh` and anything else driving the API needs a credential. This logs in with the
# password `ensureFirstAdministrator` generated on first boot and issues a full-scope token from
# that session.
#
# **The secret is printed, which is the point** — it cannot be retrieved again, only reissued.
# It is a token against a development database on loopback; do not adapt this for anything else.
# `POST /auth/tokens` refuses to mint a token from a token, so this needs the password and there
# is no way round that by design.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${MS_API:-http://127.0.0.1:8080/api/v1}"
password_file="${MS_PASSWORD_FILE:-${repo_root}/dev/data/first-admin-password}"
name="dev-$(date -u +%Y%m%dT%H%M%SZ)"
secret_only=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --secret) secret_only=1 ;;
    --name) name="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -r "${password_file}" ] || {
  echo "error: no password file at ${password_file}" >&2
  echo "       it is written once, on the first boot that finds no accounts." >&2
  echo "       if it was deleted after use — as its own text tells you to — issue a token" >&2
  echo "       from the UI instead and export MS_TOKEN yourself." >&2
  exit 1
}

password="$(head -1 "${password_file}")"
# The file names the account it belongs to; `admin` is what the bootstrap creates.
login="${MS_LOGIN:-$(sed -n "s/.*password for the '\([^']*\)' account.*/\1/p" "${password_file}")}"
login="${login:-admin}"

jar="$(mktemp)"
trap 'rm -f "${jar}"' EXIT

body="$(printf '{"login":%s,"password":%s}' \
  "$(printf '%s' "${login}" | node -e 'process.stdout.write(JSON.stringify(require("node:fs").readFileSync(0,"utf8")))')" \
  "$(printf '%s' "${password}" | node -e 'process.stdout.write(JSON.stringify(require("node:fs").readFileSync(0,"utf8")))')")"

code="$(curl -s -o /dev/null -w '%{http_code}' -c "${jar}" \
  -H 'content-type: application/json' -d "${body}" "${API}/auth/login")"

if [ "${code}" != "200" ]; then
  echo "error: ${API}/auth/login answered ${code} for '${login}'" >&2
  if [ "${code}" = "401" ]; then
    echo "       the generated password has been changed — which is what it is for." >&2
    echo "       issue a token from the UI and export MS_TOKEN yourself." >&2
  fi
  exit 1
fi

issued="$(curl -s -b "${jar}" -H 'content-type: application/json' \
  -d "$(printf '{"name":"%s","scope":"full"}' "${name}")" "${API}/auth/tokens")"

secret="$(printf '%s' "${issued}" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')"
[ -n "${secret}" ] || {
  echo "error: no secret in the answer from ${API}/auth/tokens" >&2
  echo "       ${issued}" >&2
  exit 1
}

# Logging out ends the session this used; the token outlives it, which is the point of a token.
curl -s -o /dev/null -b "${jar}" -X POST "${API}/auth/logout" || true

if [ "${secret_only}" -eq 1 ]; then
  printf '%s\n' "${secret}"
else
  printf 'export MS_TOKEN=%s\n' "${secret}"
fi

#!/usr/bin/env bash
# Authenticating a shell client against the API (`U-20`).
#
# Source this; it defines functions and sets nothing else.
#
# **`api.requireAuthentication` defaults to on**, and has since `P-154`. Every shell client in
# this repository was written before that and called the API anonymously, which is why the soak
# harness refused to start against a stock installation and reported "no installation answering"
# — a diagnosis that sends somebody to look at the service they are already talking to.
#
# One credential mechanism: a bearer token in `MS_TOKEN`. Not a session, because half of these
# callers run their `curl` inside a container through `docker exec`, where a cookie jar on the
# host is no use, and because `scripts/soak/*.mjs` already read exactly this variable. Minting one
# for the dev stack is `scripts/dev-token.sh`.

# `curl` with the credential attached, if there is one. No credential is the right answer for an
# installation with the flag off — `ms_api_probe` below tells the two cases apart, so a caller
# never has to guess which it is talking to.
#
# **Two branches rather than an array of arguments**, because macOS ships bash 3.2, where
# expanding an empty array under `set -u` is an unbound-variable error rather than nothing. It
# fails inside a `$(…)` that a caller has already guarded with `|| true`, so the symptom is an
# empty status code and a confident report that nothing is listening — which is the exact
# misdiagnosis this file exists to remove.
ms_curl() {
  if [ -n "${MS_TOKEN:-}" ]; then
    curl -H "authorization: Bearer ${MS_TOKEN}" "$@"
  else
    curl "$@"
  fi
}

# The same, inside a container. The smoke harnesses run their `curl` through `docker exec`, where
# a cookie jar on the host would be no use and this header is.
ms_docker_curl() {
  local box="$1"
  shift
  if [ -n "${MS_TOKEN:-}" ]; then
    docker exec "${box}" curl -H "authorization: Bearer ${MS_TOKEN}" "$@"
  else
    docker exec "${box}" curl "$@"
  fi
}

# Is anybody home, and will they talk to us?
#
# Prints one of `ok`, `unauthenticated`, `forbidden` or `unreachable`. **The distinction is the
# whole point of this file**: a 401 means the installation is up and this caller has no
# credential, which is a different problem from nothing listening, and a caller that collapses
# them tells the operator to start a service that is already running.
ms_api_probe() {
  local api="$1"
  local code
  code="$(ms_curl -s -o /dev/null -w '%{http_code}' "${api}/objects/root" 2>/dev/null || true)"
  case "${code}" in
    2*) printf 'ok\n' ;;
    401) printf 'unauthenticated\n' ;;
    403) printf 'forbidden\n' ;;
    000 | '') printf 'unreachable\n' ;;
    *) printf 'unreachable\n' ;;
  esac
}

# The sentence to print when `ms_api_probe` did not say `ok`. Writes to stderr and returns 1, so
# a caller can `ms_api_require "${API}" || exit 1`.
ms_api_require() {
  local api="$1"
  # Said, never shown: the value is a credential, and one this API refused may be good elsewhere.
  local token_state=unset
  [ -z "${MS_TOKEN:-}" ] || token_state='set but not accepted'
  case "$(ms_api_probe "${api}")" in
    ok) return 0 ;;
    unauthenticated)
      echo "error: ${api} needs a credential and MS_TOKEN is ${token_state}" >&2
      echo "       api.requireAuthentication is on — the default since P-154." >&2
      echo "       for the dev stack:  eval \"\$(scripts/dev-token.sh)\"" >&2
      echo "       elsewhere:          an administrator's token, scope 'full', issued" >&2
      echo "                           from a signed-in session (docs/installation.md §5)" >&2
      return 1
      ;;
    forbidden)
      echo "error: ${api} accepted the credential in MS_TOKEN and refused the request" >&2
      echo "       the soak lists the probes: it needs an administrator's token, scope 'full'" >&2
      return 1
      ;;
    *)
      echo "error: nothing is answering at ${api}" >&2
      echo "       start one:  scripts/dev-services.sh start" >&2
      return 1
      ;;
  esac
}

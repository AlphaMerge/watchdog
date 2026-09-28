#!/usr/bin/env bash
# Probe Health's memory-limit channel on a real systemd install, what the shipped unit does to a
# probe past its ceiling (`P-210`, `P-213`), and how the units' start limit and the core's start-up
# waits behave (`P-215`).
#
#     scripts/sizing/memory-limit-live.sh [out.jsonl]
#
# Builds and installs the release into the smoke test's clean systemd box (`MS_SMOKE_KEEP=1`), so
# the probe runs under the shipped `ms-probe.service` — its memory ceiling, its watchdog and
# `ProtectControlGroups` included — and then runs `memory-limit-live.mjs` inside it, which moves
# the probe's ceiling under it and records what systemd, the kernel, the core and the sensor say.
# About twenty minutes, half of it the smoke test. The box is removed at the end.
#
# Development only. It throttles the probe in that box on purpose; nothing outside it is touched.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${1:-${repo_root}/docs/findings/$(date -u +%Y-%m-%d)-memory-limit-live.jsonl}"
log="$(mktemp)"
token_error="$(mktemp)"
box=""
cleanup() {
  if [ -n "${box}" ]; then docker rm -f "${box}" >/dev/null 2>&1 || true; fi
  rm -f "${log}" "${token_error}"
}
trap cleanup EXIT

# The box's name is read before the smoke test's result is acted on, so a failed smoke test still
# has its box removed by the trap rather than left running.
set +e
MS_SMOKE_KEEP=1 "${repo_root}/scripts/smoke-install.sh" | tee "${log}"
smoke="${PIPESTATUS[0]}"
set -e
box="$(sed -n 's/^==> kept \([^ ]*\) .*/\1/p' "${log}")"
[ "${smoke}" -eq 0 ] || {
  echo "the smoke test failed; nothing to measure" >&2
  exit 1
}
[ -n "${box}" ] || {
  echo "smoke-install.sh kept no box" >&2
  exit 1
}

echo "==> starting the services again (the smoke test ends by stopping them)"
# The smoke test has started both several times already, and every start counts toward the units'
# start limit (P-215): cleared first, so the cases measure their own starts.
docker exec "${box}" systemctl reset-failed ms-core ms-probe
docker exec "${box}" systemctl start ms-core ms-probe
docker cp "${repo_root}/scripts/smoke/api-token.sh" "${box}:/tmp/api-token.sh"
docker cp "${repo_root}/scripts/sizing/memory-limit-live.mjs" "${box}:/tmp/memory-limit-live.mjs"

# The generated password still works, because this is a fresh install; the token never leaves
# this shell and the box.
# Its own token name: the smoke test already holds one called `smoke`, and names are unique.
token=""
error=""
for _ in $(seq 1 30); do
  if token="$(docker exec -e MS_TOKEN_NAME=memory-limit-live "${box}" bash /tmp/api-token.sh 2>"${token_error}")" &&
    [ -n "${token}" ]; then
    break
  fi
  error="$(cat "${token_error}")"
  token=""
  sleep 2
done
[ -n "${token}" ] || {
  echo "could not issue an API token in ${box}: ${error}" >&2
  exit 1
}

echo "==> measuring (about eleven minutes) into ${out}"
if ! docker exec -e MS_TOKEN="${token}" "${box}" node /tmp/memory-limit-live.mjs >"${out}"; then
  echo "the measurement failed; the probe's and the core's journals follow" >&2
  docker exec "${box}" journalctl -u ms-probe --no-pager -n 40 >&2 || true
  docker exec "${box}" journalctl -u ms-core --no-pager -n 20 >&2 || true
  exit 1
fi
echo "==> done: $(wc -l <"${out}") lines"

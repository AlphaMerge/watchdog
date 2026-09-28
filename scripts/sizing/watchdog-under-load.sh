#!/usr/bin/env bash
# Whether systemd's watchdog kills an idle ms-core or ms-probe on a loaded host, and why (`P-220`).
#
#     scripts/sizing/watchdog-under-load.sh [out.jsonl]
#
# Builds and installs the release into the smoke test's clean systemd box (`MS_SMOKE_KEEP=1`), so
# both services run under the shipped units, puts a wrapper in front of `systemd-notify` that
# records every ping the services send, and runs `watchdog-under-load.mjs` inside the box. That
# holds a CPU hog of one, three and six busy loops per CPU in turn and records what was sent, what
# PID 1 accepted, the services' event-loop lag and the machine's pressure stall figures. About
# thirty minutes, ten of them the smoke test; `MS_HOG_STAGES` (`factor:seconds,...`) shapes it,
# and `MS_START_WHEN=<file>` holds the measurement until that file exists. The box is removed at
# the end.
#
# Development only, and **not on a shared machine without booking it**: the hog competes with
# everything on the VM, and other people's timing tests fail beside it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${1:-${repo_root}/docs/findings/$(date -u +%Y-%m-%d)-watchdog-under-load.jsonl}"
log="$(mktemp)"
token_error="$(mktemp)"
box=""
cleanup() {
  if [ -n "${box}" ]; then docker rm -f "${box}" >/dev/null 2>&1 || true; fi
  rm -f "${log}" "${token_error}"
}
trap cleanup EXIT

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

# The wrapper runs as the service's own user and writes where that user may: `STATE_DIRECTORY`,
# which systemd sets from `StateDirectory=` and which survives the restarts a kill causes (the
# runtime directory does not). One line per helper: wall-clock start and finish, the helper's exit
# status — non-zero when its wait for PID 1 timed out — and the arguments.
echo "==> putting a recording wrapper in front of systemd-notify"
docker exec "${box}" bash -c '
  set -e
  real="$(command -v systemd-notify)"
  mv "${real}" "${real}.real"
  cat >"${real}" <<EOF
#!/bin/bash
started=\$(date +%s.%N)
"${real}.real" "\$@"
status=\$?
echo "\${started} \$(date +%s.%N) \${status} \$*" >>"\${STATE_DIRECTORY:-/tmp}/notify-wrapper.log"
exit \${status}
EOF
  chmod 755 "${real}"
'

echo "==> starting the services again (the smoke test ends by stopping them)"
# Every start counts toward the units' start limit (`P-215`), and the smoke test has used some.
docker exec "${box}" systemctl reset-failed ms-core ms-probe
docker exec "${box}" systemctl start ms-core ms-probe
docker cp "${repo_root}/scripts/smoke/api-token.sh" "${box}:/tmp/api-token.sh"
docker cp "${repo_root}/scripts/sizing/watchdog-under-load.mjs" "${box}:/tmp/watchdog-under-load.mjs"

token=""
error=""
for _ in $(seq 1 30); do
  if token="$(docker exec -e MS_TOKEN_NAME=watchdog-under-load "${box}" bash /tmp/api-token.sh 2>"${token_error}")" &&
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

# On a shared machine the build can run before everyone else holds and the hog only once they do:
# with MS_START_WHEN set, everything up to here happens, and then the run waits for that file.
if [ -n "${MS_START_WHEN:-}" ]; then
  echo "==> built and installed; waiting for ${MS_START_WHEN} to exist before measuring"
  until [ -e "${MS_START_WHEN}" ]; do sleep 2; done
fi

echo "==> measuring into ${out}"
if ! docker exec -e MS_TOKEN="${token}" ${MS_HOG_STAGES:+-e MS_HOG_STAGES="${MS_HOG_STAGES}"} \
  "${box}" node /tmp/watchdog-under-load.mjs >"${out}"; then
  echo "the measurement failed; the services' journals follow" >&2
  docker exec "${box}" journalctl -u ms-core -u ms-probe --no-pager -n 40 >&2 || true
  exit 1
fi
echo "==> done: $(wc -l <"${out}") lines"

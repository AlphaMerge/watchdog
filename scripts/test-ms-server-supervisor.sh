#!/usr/bin/env bash
# The ms-server supervisor, against a fake `node`: does the container exit when either process does?
#
#   scripts/dev.sh "bash scripts/test-ms-server-supervisor.sh"
#
# CI runs it on the Linux runner, beside shellcheck.
#
# In the toolchain container, because the supervisor runs there and its behaviour is bash's —
# macOS's bash 3.2 has no `wait -n` at all, so a run on the host would test a different shell.
#
# **Every case runs twice: as a file, and as `bash -c` with the file's text.** The bug below only
# happened under `bash -c` — the same lines run as a file returned from `wait -n` at once — so a
# test that ran the supervisor one way would have passed against the broken version.
#
# The case that matters is the first. On 2026-09-15 the dev PostgreSQL was down after a Docker
# restart, ms-core died with ENOTFOUND inside the supervisor's three-second pause, and the old
# `wait -n $core $probe` said "wait: 9: no such job" — bash had already reaped the core — and waited
# on the probe alone. The container stayed Up for ten hours with no core in it, and :5173 answered
# 502 the whole time.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
supervisor="${repo_root}/scripts/lib/ms-server-supervisor.sh"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# A `node` that is ms-core or ms-probe by its arguments, logs what happens to it, exits when told
# to by the environment, and otherwise runs until it is sent SIGTERM.
mkdir -p "${work}/bin"
cat > "${work}/bin/node" <<'EOF'
#!/usr/bin/env bash
role=core
case "$*" in *probe*) role=probe ;; esac
echo "${role} start" >> "${FAKE_LOG}"
trap 'echo "${role} term" >> "${FAKE_LOG}"; exit 0' TERM
if [ "${role}" = core ]; then after="${FAKE_CORE_EXIT_AFTER:-}"; code="${FAKE_CORE_EXIT_CODE:-1}"
else after="${FAKE_PROBE_EXIT_AFTER:-}"; code="${FAKE_PROBE_EXIT_CODE:-1}"; fi
if [ -n "${after}" ]; then
  sleep "${after}" & wait $!
  echo "${role} exit ${code}" >> "${FAKE_LOG}"
  exit "${code}"
fi
while :; do sleep 1 & wait $!; done
EOF
chmod +x "${work}/bin/node"

failures=0
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }

# Runs the supervisor with the given environment and a deadline; sets `status`, `took` and `log`.
run() {
  local logfile="${work}/log.$RANDOM"
  : > "${logfile}"
  local started=$SECONDS
  set +e
  if [ "${mode}" = file ]; then
    env PATH="${work}/bin:${PATH}" FAKE_LOG="${logfile}" "$@" \
      timeout --signal=KILL 20 bash "${supervisor}" 2>"${logfile}.err"
  else
    env PATH="${work}/bin:${PATH}" FAKE_LOG="${logfile}" "$@" \
      timeout --signal=KILL 20 bash -c "$(cat "${supervisor}")" 2>"${logfile}.err"
  fi
  status=$?
  set -e
  took=$((SECONDS - started))
  log="$(cat "${logfile}")"
  # Nothing may outlive the supervisor: a probe left running is the bug in another shape.
  if command -v pgrep >/dev/null && pgrep -f "${work}/bin/node" >/dev/null; then
    fail "a fake process outlived the supervisor"
    pkill -f "${work}/bin/node" || true
  fi
}

for mode in file string; do

echo "[${mode}] the core dies during the start-up pause (the 2026-09-15 case)"
run FAKE_CORE_EXIT_AFTER=0.2 FAKE_CORE_EXIT_CODE=1
[ "${status}" -eq 1 ] || fail "exit status ${status}, expected 1 (137 is the 20 s deadline: the supervisor hung)"
[ "${took}" -le 6 ] || fail "took ${took} s"
case "${log}" in *"probe start"*) fail "started a probe for a core that was already dead" ;; esac

echo "[${mode}] the core dies after the probe has started"
run FAKE_CORE_EXIT_AFTER=5 FAKE_CORE_EXIT_CODE=3
[ "${status}" -eq 3 ] || fail "exit status ${status}, expected the core's 3"
case "${log}" in *"probe term"*) ;; *) fail "the probe was not stopped: ${log//$'\n'/; }" ;; esac

echo "[${mode}] the probe exits cleanly, which is still an exit Docker has to restart"
run FAKE_PROBE_EXIT_AFTER=1 FAKE_PROBE_EXIT_CODE=0
[ "${status}" -eq 1 ] || fail "exit status ${status}, expected 1 for a zero exit"
case "${log}" in *"core term"*) ;; *) fail "the core was not stopped: ${log//$'\n'/; }" ;; esac

echo "[${mode}] docker stop: SIGTERM reaches both, and the supervisor exits 143"
: > "${work}/stop.log"
if [ "${mode}" = file ]; then
  PATH="${work}/bin:${PATH}" FAKE_LOG="${work}/stop.log" bash "${supervisor}" 2>/dev/null &
else
  PATH="${work}/bin:${PATH}" FAKE_LOG="${work}/stop.log" bash -c "$(cat "${supervisor}")" 2>/dev/null &
fi
pid=$!
sleep 5
kill -TERM "${pid}"
set +e
wait "${pid}"
status=$?
set -e
stop_log="$(cat "${work}/stop.log")"
[ "${status}" -eq 143 ] || fail "exit status ${status}, expected 143"
case "${stop_log}" in *"core term"*"probe term"* | *"probe term"*"core term"*) ;;
  *) fail "not both stopped: ${stop_log//$'\n'/; }" ;; esac

done

if [ "${failures}" -gt 0 ]; then
  echo "${failures} failure(s)"
  exit 1
fi
echo "all supervisor cases pass"

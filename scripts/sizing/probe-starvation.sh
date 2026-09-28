#!/usr/bin/env bash
# What a starved probe does with its memory and its log, and whether systemd kills it (`P-216`,
# with `P-220`'s memory stage).
#
#     scripts/sizing/probe-starvation.sh [out-dir]
#
# Builds and installs the release into the smoke test's clean systemd box (`MS_SMOKE_KEEP=1`),
# limits the whole box's memory (`MS_BOX_MEMORY`, default 4g, plus `MS_BOX_SWAP`, default 1g), and
# changes three things about the probe before measuring:
#
# - its stdout and stderr go into a FIFO that a unit of its own drains, so a stage can stop the
#   reader and leave the probe writing into a pipe nobody reads, as a starved journald would;
# - `probe-memory-sampler.mjs` runs inside it, writing its heap, its workers' heaps, the log's
#   backlog, its event-loop delay and its GC time every second;
# - `--heapsnapshot-signal=SIGUSR2`, so the peak can be attributed (`MS_HEAP_SNAPSHOT=1`).
#
# Then `probe-starvation.mjs` runs inside the box: it gives the probe 5,000 `port.tcp` sensors
# against a local port that never answers (`blackhole.pl`), so each check waits out its 5 s timeout
# and the pool fills and refuses, as it did in the incident. The first run pointed them at the
# core's own port, which answers in under a millisecond, and the pool never filled
# (`docs/findings/2026-09-29-probe-starvation.md`).
#
# and holds stages of a CPU hog, a memory balloon sized to the box's own limit, and a stalled
# stdout, recording what `watchdog-under-load.mjs` records beside the probe's own numbers.
# `MS_STAGES` (`cpu:seconds[:leaveMiB[:stall]]`) shapes it, and `MS_START_WHEN=<file>` holds the
# measurement until that file exists. The box is removed at the end.
#
# **The memory limit is the box's, never the VM's.** A balloon sized to the shared VM took the dev
# PostgreSQL into crash recovery the night this was written. The box runs its own PostgreSQL,
# inside the limit, so the pressure stays inside the box.
#
# Development only, and **not on a shared machine without booking it**.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir="${1:-${repo_root}/docs/findings/$(date -u +%Y-%m-%d)-probe-starvation}"
mkdir -p "${out_dir}"
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

# 4g: P-206 measured this probe alone at a 2,473 MiB peak with 5,000 sensors, and the box holds its
# own PostgreSQL and core besides.
memory="${MS_BOX_MEMORY:-4g}"
swap="${MS_BOX_SWAP:-1g}"
to_mib() {
  case "$1" in
    *g) echo $(( ${1%g} * 1024 )) ;;
    *m) echo "${1%m}" ;;
    *) echo "a size is <n>g or <n>m, not $1" >&2; exit 2 ;;
  esac
}
limit_mib="$(to_mib "${memory}")"
total_mib=$(( limit_mib + $(to_mib "${swap}") ))
echo "==> limiting the box to ${limit_mib} MiB of memory and ${total_mib} MiB with swap"
docker update --memory "${limit_mib}m" --memory-swap "${total_mib}m" "${box}" >/dev/null

echo "==> putting a recording wrapper in front of systemd-notify"
docker exec "${box}" bash -c '
  set -e
  real="$(command -v systemd-notify)"
  mv "${real}" "${real}.real"
  cat >"${real}" <<EOF
started=\$(date +%s.%N)
"${real}.real" "\$@"
status=\$?
echo "\${started} \$(date +%s.%N) \${status} \$*" >>"\${STATE_DIRECTORY:-/tmp}/notify-wrapper.log"
exit \${status}
EOF
  chmod 755 "${real}"
'

echo "==> sending the probe's output through a FIFO, and loading the sampler into it"
docker exec "${box}" mkdir -p /opt/ms-starvation
docker cp "${repo_root}/scripts/sizing/probe-memory-sampler.mjs" \
  "${box}:/opt/ms-starvation/probe-memory-sampler.mjs"
docker cp "${repo_root}/scripts/sizing/blackhole.pl" "${box}:/opt/ms-starvation/blackhole.pl"
target_port="${MS_TARGET_PORT:-9999}"
docker exec "${box}" bash -c '
  set -e
  chmod 755 /opt/ms-starvation
  chmod 644 /opt/ms-starvation/probe-memory-sampler.mjs /opt/ms-starvation/blackhole.pl
  cat >/etc/systemd/system/ms-blackhole.service <<EOF
[Unit]
Description=A local TCP port that never answers (P-216 harness)
[Service]
ExecStart=/usr/bin/perl /opt/ms-starvation/blackhole.pl '"${target_port}"'
EOF
  mkdir -p /var/lib/ms-starvation
  # Restarted whenever cat sees EOF, which is every time the probe restarts and closes its end.
  cat >/etc/systemd/system/ms-stdout-reader.service <<EOF
[Unit]
Description=Drains the ms-probe output FIFO (P-216 harness)
[Service]
ExecStartPre=/bin/sh -c "test -p /var/lib/ms-starvation/probe.fifo || mkfifo -m 0666 /var/lib/ms-starvation/probe.fifo"
ExecStart=/bin/sh -c "exec cat /var/lib/ms-starvation/probe.fifo >>/var/lib/ms-starvation/probe-output.log"
Restart=always
RestartSec=100ms
EOF
  mkdir -p /etc/systemd/system/ms-probe.service.d
  cat >/etc/systemd/system/ms-probe.service.d/starvation.conf <<EOF
[Unit]
Wants=ms-stdout-reader.service
After=ms-stdout-reader.service
[Service]
StandardOutput=file:/var/lib/ms-starvation/probe.fifo
StandardError=inherit
Environment=MS_PROBE_MEMORY_OUT=/var/lib/ms-probe/memory.ndjson
Environment="NODE_OPTIONS=--import=/opt/ms-starvation/probe-memory-sampler.mjs --heapsnapshot-signal=SIGUSR2"
EOF
  systemctl daemon-reload
  systemctl start ms-stdout-reader ms-blackhole
'

echo "==> starting the services again (the smoke test ends by stopping them)"
docker exec "${box}" systemctl reset-failed ms-core ms-probe
docker exec "${box}" systemctl start ms-core ms-probe
docker cp "${repo_root}/scripts/smoke/api-token.sh" "${box}:/tmp/api-token.sh"
docker cp "${repo_root}/scripts/soak/provision.mjs" "${box}:/tmp/provision.mjs"
docker cp "${repo_root}/scripts/sizing/probe-starvation.mjs" "${box}:/tmp/probe-starvation.mjs"

token=""
error=""
for _ in $(seq 1 30); do
  if token="$(docker exec -e MS_TOKEN_NAME=probe-starvation "${box}" bash /tmp/api-token.sh 2>"${token_error}")" &&
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

# Checks what the measurement depends on, and changes nothing: the box's cgroup, the FIFO and its
# reader, and the sampler's lines from inside the probe. A run that would fail on one of those
# fails here, before the window is booked, rather than inside it.
echo "==> preflight"
docker exec -e MS_TOKEN="${token}" -e MS_PREFLIGHT=1 -e MS_TARGET_PORT="${target_port}" \
  "${box}" node /tmp/probe-starvation.mjs

# With MS_START_WHEN set, everything up to here happens, and then the run waits for that file.
if [ -n "${MS_START_WHEN:-}" ]; then
  echo "==> built and installed; waiting for ${MS_START_WHEN} to exist before measuring"
  until [ -e "${MS_START_WHEN}" ]; do sleep 2; done
fi

echo "==> measuring into ${out_dir}"
status=0
docker exec -e MS_TOKEN="${token}" -e MS_BOX_LIMIT_MIB="${limit_mib}" -e MS_TARGET_PORT="${target_port}" \
  ${MS_STAGES:+-e MS_STAGES="${MS_STAGES}"} \
  ${MS_SENSORS:+-e MS_SENSORS="${MS_SENSORS}"} \
  ${MS_HEAP_SNAPSHOT:+-e MS_HEAP_SNAPSHOT="${MS_HEAP_SNAPSHOT}"} \
  "${box}" node /tmp/probe-starvation.mjs >"${out_dir}/run.jsonl" || status=$?

# Whatever the run managed, the probe's own samples are evidence, and so is how much output
# reached the reader.
docker cp "${box}:/var/lib/ms-probe/memory.ndjson" "${out_dir}/probe-memory.ndjson" 2>/dev/null || true
docker exec "${box}" bash -c 'ls -la /var/lib/ms-starvation/; ls -la /var/lib/ms-probe/*.heapsnapshot 2>/dev/null' \
  >"${out_dir}/files.txt" 2>&1 || true
if [ "${MS_HEAP_SNAPSHOT:-}" = "1" ]; then
  mkdir -p "${out_dir}/heap"
  for snapshot in $(docker exec "${box}" bash -c 'ls /var/lib/ms-probe/*.heapsnapshot 2>/dev/null'); do
    docker cp "${box}:${snapshot}" "${out_dir}/heap/" || true
  done
fi

if [ "${status}" -ne 0 ]; then
  echo "the measurement failed (${status}); the services' journals follow" >&2
  docker exec "${box}" journalctl -u ms-core -u ms-probe -u ms-stdout-reader --no-pager -n 60 >&2 || true
  exit 1
fi
echo "==> done: $(wc -l <"${out_dir}/run.jsonl") lines, $(wc -l <"${out_dir}/probe-memory.ndjson" 2>/dev/null || echo 0) probe samples"

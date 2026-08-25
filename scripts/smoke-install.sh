#!/usr/bin/env bash
# Install smoke test (TASKS.md F-08): unpack the release tarball onto a clean Debian box with
# a real systemd, run install.sh, and assert both services reach "active".
#
# Development/CI only.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container=ms-smoke-install
image=ms-smoke:bookworm

# Build unless handed a specific tarball. Reusing whichever one happened to be lying around is
# how this test silently validated a package built before the change under test — which is worse
# than not running it, because it reports success.
if [ "$#" -gt 0 ]; then
  tarball="$1"
  [ -f "${tarball}" ] || {
    echo "no such tarball: ${tarball}" >&2
    exit 1
  }
  echo "==> using the tarball given on the command line (not rebuilding)"
else
  echo "==> building a release tarball"
  # package.sh needs npm. The promise everywhere else here is that Docker is the only thing you
  # need on the host, so fall back to the toolchain container when there is no npm — otherwise
  # this fails on exactly the machines the container exists for.
  if command -v npm >/dev/null 2>&1; then
    "${repo_root}/scripts/package.sh" >/dev/null
  else
    "${repo_root}/scripts/dev.sh" "scripts/package.sh" >/dev/null
  fi
  tarball="$(ls -t "${repo_root}"/release/ms-*.tar.gz 2>/dev/null | head -1)"
  [ -n "${tarball}" ] && [ -f "${tarball}" ] || {
    echo "scripts/package.sh produced no tarball" >&2
    exit 1
  }
fi
echo "    ${tarball}"

cleanup() { docker rm -f "${container}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> building smoke image"
docker build -q -t "${image}" "${repo_root}/scripts/smoke" >/dev/null

echo "==> booting a clean systemd box"
cleanup
docker run -d --name "${container}" \
  --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  "${image}" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "${container}" systemctl is-system-running --wait >/dev/null 2>&1; then break; fi
  state="$(docker exec "${container}" systemctl is-system-running 2>/dev/null || true)"
  [ "${state}" = "running" ] || [ "${state}" = "degraded" ] && break
  sleep 1
done
echo "    systemd: $(docker exec "${container}" systemctl is-system-running 2>/dev/null || echo unknown)"

echo "==> provisioning PostgreSQL (the operator's prerequisite, not install.sh's job)"
docker cp "${repo_root}/scripts/smoke/provision-postgres.sh" "${container}:/tmp/provision-postgres.sh"
docker exec "${container}" bash /tmp/provision-postgres.sh

echo "==> installing $(basename "${tarball}")"
docker cp "${tarball}" "${container}:/tmp/release.tar.gz"
docker exec "${container}" bash -c 'mkdir -p /tmp/unpacked && tar -xzf /tmp/release.tar.gz -C /tmp/unpacked'
docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh --no-start'

docker cp "${repo_root}/scripts/smoke/configure-core.sh" "${container}:/tmp/configure-core.sh"
docker exec "${container}" bash /tmp/configure-core.sh

echo "==> starting the services"
docker exec "${container}" systemctl start ms-core ms-probe

echo "==> asserting both services are active"
failed=0
for svc in ms-core ms-probe; do
  state="$(docker exec "${container}" systemctl is-active "${svc}" 2>/dev/null || true)"
  printf '    %-9s %s\n' "${svc}:" "${state}"
  if [ "${state}" != "active" ]; then
    failed=1
    docker exec "${container}" systemctl status "${svc}" --no-pager -l || true
    docker exec "${container}" journalctl -u "${svc}" --no-pager -n 40 || true
  fi
done

echo "==> asserting the API answers"
if docker exec "${container}" curl -sf http://127.0.0.1:8080/api/v1/objects/root >/dev/null; then
  echo "    GET /api/v1/objects/root: ok"
else
  echo "    GET /api/v1/objects/root: FAILED" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the shipped catalogue has sensor types in it"
# @ms/sensors is a separate workspace package staged and symlinked by package.sh. If that goes
# wrong the core still starts and still answers — it just refuses to create any sensor, which is
# a failure nobody would notice until an operator tried.
if docker exec "${container}" curl -sf http://127.0.0.1:8080/api/v1/sensor-types \
  | grep -q 'icmp.ping'; then
  echo "    GET /api/v1/sensor-types: icmp.ping present"
else
  echo "    GET /api/v1/sensor-types: FAILED — the shipped catalogue is empty" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the core serves the web UI"
# The UI is built by package.sh, staged into the tarball and pointed at by api.webRoot. This is
# the only place that proves the whole chain — a build that never ran, a path install.sh did not
# create, or a webRoot pointing somewhere else all look identical until someone opens a browser.
if docker exec "${container}" curl -sf http://127.0.0.1:8080/ | grep -q 'id="root"'; then
  echo "    GET /: app shell ok"
else
  echo "    GET /: FAILED — no app shell served" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the probe was told what to scan"
# A fresh install has no branch claiming this probe's GID, so the configuration it receives is
# empty — but it must *receive* one. This is the only place that proves protocol 3, the config
# service and the probe's side of it all line up in the packaged layout rather than in the
# development tree.
if docker exec "${container}" journalctl -u ms-probe --no-pager | grep -q 'applied configuration'; then
  echo "    configuration push: ok"
else
  echo "    configuration push: FAILED — the probe was never sent a configuration" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the data lifecycle ran"
# The housekeeping loop is what rolls up, compresses and drops. It runs on a timer inside the
# service, so a packaging or migration fault that leaves it dead would otherwise show up as
# nothing at all until data started disappearing or piling up.
if docker exec "${container}" journalctl -u ms-core --no-pager \
     | grep -q 'housekeeping pass complete'; then
  echo "    housekeeping pass: ok"
else
  echo "    housekeeping pass: FAILED — no completed pass in the journal" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 40 || true
  failed=1
fi

echo "==> asserting the probe's worker pool started"
# The pool spawns worker threads from a file inside the tarball, so this is the only place that
# proves the packaged layout resolves it. A path that works in the repo and not in /opt/ms would
# otherwise surface as a probe that never checks anything.
if docker exec "${container}" journalctl -u ms-probe --no-pager | grep -q 'check pool started'; then
  echo "    check pool: ok"
else
  echo "    check pool: FAILED — no worker pool in the journal" >&2
  docker exec "${container}" journalctl -u ms-probe --no-pager -n 40 || true
  failed=1
fi

echo "==> asserting graceful stop"
for svc in ms-core ms-probe; do
  docker exec "${container}" systemctl stop "${svc}"
  result="$(docker exec "${container}" systemctl show "${svc}" -p Result --value)"
  code="$(docker exec "${container}" systemctl show "${svc}" -p ExecMainStatus --value)"
  printf '    %-9s result=%s exit=%s\n' "${svc}:" "${result}" "${code}"
  { [ "${result}" = "success" ] && [ "${code}" = "0" ]; } || failed=1
done

if [ "${failed}" -ne 0 ]; then
  echo "==> SMOKE TEST FAILED" >&2
  exit 1
fi
echo "==> smoke test passed"

#!/usr/bin/env bash
# Install smoke test (TASKS.md F-08): unpack the release tarball onto a clean Debian box with
# a real systemd, run install.sh, and assert both services reach "active".
#
# Development/CI only.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container=ms-smoke-install
image=ms-smoke:bookworm

tarball="${1:-$(ls -t "${repo_root}"/release/ms-*.tar.gz 2>/dev/null | head -1)}"
[ -n "${tarball}" ] && [ -f "${tarball}" ] || {
  echo "no release tarball found — run scripts/package.sh first" >&2
  exit 1
}

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

#!/usr/bin/env bash
# Remote probe enrolment smoke test (TASKS.md R-07).
#
# Two clean systemd boxes on one network: a core on the first, a probe-only package on the
# second, enrolled across with a bundle carried between them exactly as an operator would. Then
# assert the probe connected, appeared in the approval queue by the name it was enrolled under,
# and was given nothing to scan until somebody approved it.
#
# **One box would prove nothing this needs proving.** The enrolment flow exists because the probe
# is somewhere else: a bundle that quietly depended on a file path only the core host has, a
# certificate with a SAN that only matches localhost, or a probe.json still pointing at 127.0.0.1
# all pass on a single host and fail on the day it matters.
#
# Development/CI only.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_box=ms-smoke-core
probe_box=ms-smoke-probe
network=ms-smoke-net
image=ms-smoke:bookworm

# **Always the toolchain container, never the host's npm.** This script boots Docker containers,
# so Docker is a hard requirement and there is no situation where the host toolchain is the only
# option — while there is a common one where it is the wrong option: a workspace whose
# `node_modules` were installed inside the container carries native bindings for the container's
# platform, and building against them with the host's Node fails somewhere deep in a bundler.
#
# `$@` rather than a local array: bash 3.2 treats an empty array's expansion as unbound under
# `set -u`, and the full-package call passes no arguments at all.
package() {
  "${repo_root}/scripts/dev.sh" "scripts/package.sh $*" >/dev/null
}

echo "==> building both packages"
package
package --probe-only
# `ms-[0-9]*` rather than `ms-*`: the probe package is `ms-probe-…`, which `ms-*` also matches,
# and picking it up here would hand the core's installer a tarball with no core in it.
newest() {
  local newest='' candidate
  for candidate in "$@"; do
    [ -f "${candidate}" ] || continue
    if [ -z "${newest}" ] || [ "${candidate}" -nt "${newest}" ]; then newest="${candidate}"; fi
  done
  printf '%s' "${newest}"
}
core_tarball="$(newest "${repo_root}"/release/ms-[0-9]*.tar.gz)"
probe_tarball="$(newest "${repo_root}"/release/ms-probe-*.tar.gz)"
[ -f "${core_tarball}" ] || { echo "no core tarball built" >&2; exit 1; }
[ -f "${probe_tarball}" ] || { echo "no probe tarball built" >&2; exit 1; }
echo "    core:  $(basename "${core_tarball}")"
echo "    probe: $(basename "${probe_tarball}")"

cleanup() {
  docker rm -f "${core_box}" "${probe_box}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> building smoke image"
docker build -q -t "${image}" "${repo_root}/scripts/smoke" >/dev/null

echo "==> booting two clean systemd boxes on one network"
docker network create "${network}" >/dev/null
for box in "${core_box}" "${probe_box}"; do
  docker run -d --name "${box}" --hostname "${box}" --network "${network}" \
    --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock \
    "${image}" >/dev/null
done

for box in "${core_box}" "${probe_box}"; do
  for _ in $(seq 1 60); do
    state="$(docker exec "${box}" systemctl is-system-running 2>/dev/null || true)"
    { [ "${state}" = "running" ] || [ "${state}" = "degraded" ]; } && break
    sleep 1
  done
  echo "    ${box}: $(docker exec "${box}" systemctl is-system-running 2>/dev/null || echo unknown)"
done

failed=0
note_failure() {
  echo "    $1" >&2
  failed=1
}

# --- the core -----------------------------------------------------------------------------
echo "==> installing the core"
docker cp "${repo_root}/scripts/smoke/provision-postgres.sh" "${core_box}:/tmp/provision-postgres.sh"
docker exec "${core_box}" bash /tmp/provision-postgres.sh
docker cp "${core_tarball}" "${core_box}:/tmp/release.tar.gz"
docker exec "${core_box}" bash -c 'mkdir -p /tmp/unpacked && tar -xzf /tmp/release.tar.gz -C /tmp/unpacked'
docker exec "${core_box}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh --core-only --no-start'
docker cp "${repo_root}/scripts/smoke/configure-core.sh" "${core_box}:/tmp/configure-core.sh"
docker exec "${core_box}" bash /tmp/configure-core.sh

# The core binds a wildcard by default, which is right for a service and useless as an address
# to hand a probe. `ms-enrol` refuses to guess one, so the box's own name is what goes in.
docker exec "${core_box}" bash -c "
  node -e '
    const { readFileSync, writeFileSync } = require(\"node:fs\");
    const cfg = JSON.parse(readFileSync(\"/etc/ms/core.json\", \"utf8\"));
    cfg.probeEndpoint.host = \"0.0.0.0\";
    writeFileSync(\"/etc/ms/core.json\", JSON.stringify(cfg, null, 2) + \"\n\");
  '"
docker exec "${core_box}" systemctl start ms-core
sleep 2
state="$(docker exec "${core_box}" systemctl is-active ms-core || true)"
echo "    ms-core: ${state}"
[ "${state}" = "active" ] || {
  docker exec "${core_box}" journalctl -u ms-core --no-pager -n 40 || true
  echo "==> SMOKE TEST FAILED: the core did not start" >&2
  exit 1
}

# The core's certificate is issued by install.sh with a SAN for localhost and the box's own
# hostname, so the probe has to dial it by that name for TLS to verify at all. That is the
# realistic shape — an operator enrols against a name, not an address.
echo "==> issuing an enrolment bundle on the core"
docker exec "${core_box}" /opt/ms/bin/ms-enrol web-dc2 \
  --host "${core_box}" --out /tmp/web-dc2.enrol

echo "==> asserting the bundle is a bundle and not a surprise"
bundle_json="$(docker exec "${core_box}" cat /tmp/web-dc2.enrol)"
for field in '"bundleVersion": 1' '"probeName": "web-dc2"' '"accessKey"' '"ca"' '"cert"' '"key"'; do
  case "${bundle_json}" in
    *"${field}"*) : ;;
    *) note_failure "enrolment bundle is missing ${field}" ;;
  esac
done
# It carries a private key: it must not be world-readable even for the moment it exists.
mode="$(docker exec "${core_box}" stat -c '%a' /tmp/web-dc2.enrol)"
[ "${mode}" = "600" ] || note_failure "enrolment bundle is mode ${mode}, expected 600"

# **Each probe gets its own certificate.** Before R-07 there was one probe.crt on the core and
# every probe presented it, so this is the assertion the ticket exists for.
second="$(docker exec "${core_box}" bash -c '/opt/ms/bin/ms-enrol other-probe --host x --port 1 2>/dev/null')"
first_cert="$(printf '%s' "${bundle_json}" | sed -n 's/.*"cert": "\(.*\)",$/\1/p' | head -c 200)"
second_cert="$(printf '%s' "${second}" | sed -n 's/.*"cert": "\(.*\)",$/\1/p' | head -c 200)"
if [ -n "${first_cert}" ] && [ "${first_cert}" = "${second_cert}" ]; then
  note_failure "two enrolments produced the same certificate — probes are not individually revocable"
else
  echo "    per-probe certificate: ok"
fi

# --- the probe ----------------------------------------------------------------------------
echo "==> installing the probe on the other box"
docker cp "${core_box}:/tmp/web-dc2.enrol" "${repo_root}/build/web-dc2.enrol"
docker cp "${repo_root}/build/web-dc2.enrol" "${probe_box}:/tmp/web-dc2.enrol"
rm -f "${repo_root}/build/web-dc2.enrol"
docker cp "${probe_tarball}" "${probe_box}:/tmp/probe.tar.gz"
docker exec "${probe_box}" bash -c 'mkdir -p /tmp/unpacked && tar -xzf /tmp/probe.tar.gz -C /tmp/unpacked'
docker exec "${probe_box}" bash -c 'cd /tmp/unpacked/ms-probe-* && ./install-probe.sh --enrolment /tmp/web-dc2.enrol'

state="$(docker exec "${probe_box}" systemctl is-active ms-probe || true)"
echo "    ms-probe: ${state}"
[ "${state}" = "active" ] || {
  docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
  note_failure "the probe did not start"
}

echo "==> asserting there is no core on the probe host"
# The point of a probe-only package. A core service unit here would mean the operator can start
# one by accident on a machine with no database.
if docker exec "${probe_box}" test -e /etc/systemd/system/ms-core.service; then
  note_failure "a core unit was installed on the probe host"
else
  echo "    no ms-core unit: ok"
fi
if docker exec "${probe_box}" test -e /opt/ms/app/core; then
  note_failure "the core application was installed on the probe host"
else
  echo "    no core application: ok"
fi

echo "==> asserting the probe reached the core across the network"
connected=0
for _ in $(seq 1 30); do
  if docker exec "${probe_box}" journalctl -u ms-probe --no-pager | grep -q 'connected to core'; then
    connected=1
    break
  fi
  sleep 1
done
if [ "${connected}" -eq 1 ]; then
  echo "    probe connected: ok"
else
  docker exec "${probe_box}" journalctl -u ms-probe --no-pager -n 40 || true
  docker exec "${core_box}" journalctl -u ms-core --no-pager -n 40 || true
  note_failure "the probe never connected — mutual TLS across two hosts is what this proves"
fi

echo "==> asserting it is waiting for approval, under the name it was enrolled with"
probes_json="$(docker exec "${core_box}" curl -sf http://127.0.0.1:8080/api/v1/probes || true)"
case "${probes_json}" in
  *'"displayName":"web-dc2"'*) echo "    enrolled name reached the queue: ok" ;;
  *) note_failure "the probe is not in the queue as web-dc2: ${probes_json}" ;;
esac
case "${probes_json}" in
  *'"status":"pending"'*) echo "    waiting for approval: ok" ;;
  *) note_failure "the probe did not arrive pending — reaching the port is not being trusted (R-01)" ;;
esac

echo "==> asserting the core reports no version skew for a probe from the same build"
case "${probes_json}" in
  *'"kind":"current"'*) echo "    skew: current" ;;
  *) note_failure "the core reports a skew against a probe built from the same tree (R-06)" ;;
esac

echo "==> asserting an unapproved probe was given nothing to scan"
# R-01's claim, across two hosts this time: a probe that has connected is not a probe that may
# scan, and the door is the core's.
if docker exec "${probe_box}" journalctl -u ms-probe --no-pager | grep -q 'applied configuration'; then
  note_failure "an unapproved probe was sent configuration"
else
  echo "    no configuration before approval: ok"
fi

echo "==> asserting a re-run keeps the operator's configuration"
docker exec "${probe_box}" bash -c "
  node -e '
    const { readFileSync, writeFileSync } = require(\"node:fs\");
    const cfg = JSON.parse(readFileSync(\"/etc/ms/probe.json\", \"utf8\"));
    cfg.probe.checkQueueMaxLength = 4242;
    writeFileSync(\"/etc/ms/probe.json\", JSON.stringify(cfg, null, 2) + \"\n\");
  '"
docker exec "${probe_box}" bash -c 'cd /tmp/unpacked/ms-probe-* && ./install-probe.sh --no-start' >/dev/null
kept="$(docker exec "${probe_box}" node -p 'JSON.parse(require("node:fs").readFileSync("/etc/ms/probe.json","utf8")).probe.checkQueueMaxLength')"
if [ "${kept}" = "4242" ]; then
  echo "    upgrade kept probe.json: ok"
else
  note_failure "an upgrade overwrote the operator's configuration (checkQueueMaxLength is ${kept})"
fi

echo "==> asserting the installer refuses an unusable bundle rather than half-installing"
docker exec "${probe_box}" bash -c 'printf "{\"bundleVersion\":1}" > /tmp/broken.enrol'
if docker exec "${probe_box}" bash -c 'cd /tmp/unpacked/ms-probe-* && ./install-probe.sh --enrolment /tmp/broken.enrol' >/dev/null 2>&1; then
  note_failure "the installer accepted an incomplete enrolment bundle"
else
  echo "    incomplete bundle refused: ok"
fi

if [ "${failed}" -ne 0 ]; then
  echo "==> SMOKE TEST FAILED" >&2
  exit 1
fi
echo "==> enrolment smoke test passed"

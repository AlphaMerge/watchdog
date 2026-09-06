#!/usr/bin/env bash
# Install smoke test (TASKS.md F-08): unpack the release tarball onto a clean Debian box with
# a real systemd, run install.sh, and assert both services reach "active".
#
# Development/CI only.
set -euo pipefail

# **`grep -q` in a pipeline lies under `pipefail`.** It exits at the first match, the producer on
# the left gets SIGPIPE and reports 141, and `pipefail` makes the whole pipeline fail — so a
# *successful* match reads as a failed assertion whenever the producer had more to write. That is
# only reliable when the output is short, which is why it went unnoticed until the journal got
# long enough. `matches` reads the producer to completion and asks grep afterwards.
matches() {
  local pattern="$1"
  shift
  local output
  output="$("$@" 2>/dev/null || true)"
  printf '%s' "${output}" | grep -q -- "${pattern}"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/api-auth.sh
. "${repo_root}/scripts/lib/api-auth.sh"

# **Ubuntu is named in the exit criterion, so it is a target here** (`PLAN.md` Phase 10: "a clean
# install on Ubuntu and on Windows Server"). Proving Debian and *assuming* Ubuntu would be
# assuming the half of the sentence that has a different PostgreSQL packaging, a different
# TimescaleDB repository and a different init layout.
#
#     MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh
distro="${MS_SMOKE_DISTRO:-debian}"
case "${distro}" in
  debian) dockerfile=Dockerfile;        image=ms-smoke:bookworm ;;
  ubuntu) dockerfile=Dockerfile.ubuntu; image=ms-smoke:ubuntu ;;
  *) echo "unknown MS_SMOKE_DISTRO: ${distro} (debian|ubuntu)" >&2; exit 2 ;;
esac
container="ms-smoke-install-${distro}"

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
  # **In the toolchain container, not on the host.** The promise everywhere else here is that
  # Docker is the only thing you need, and `command -v npm` is the wrong question to ask about
  # that: a host can have an npm that is present and wrong — a different Node major, or one
  # whose optional native bindings were never installed for this platform — and the failure is
  # a `vite build` that cannot load rolldown, minutes into a script that looked like it was
  # working. Set MS_SMOKE_HOST_NPM=1 to use the host's, for a CI runner that is the toolchain.
  if [ "${MS_SMOKE_HOST_NPM:-0}" = "1" ]; then
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
docker build -q -t "${image}" -f "${repo_root}/scripts/smoke/${dockerfile}" \
  "${repo_root}/scripts/smoke" >/dev/null

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

# **A credential, because the thing under test ships with authentication on.** The example
# `core.json` does not set `api.requireAuthentication`, so it defaults to on, and every assertion
# below was written before that default existed — they answered 401 and reported the API as
# broken (`U-20`). Minting the token is itself a check worth having: it exercises the bootstrap
# password, the login route and token issue on a packaged build.
echo "==> issuing an API token from the generated bootstrap password"
docker cp "${repo_root}/scripts/smoke/api-token.sh" "${container}:/tmp/api-token.sh"
if MS_TOKEN="$(docker exec "${container}" bash /tmp/api-token.sh)"; then
  export MS_TOKEN
  echo "    POST /api/v1/auth/tokens: issued"
else
  echo "    POST /api/v1/auth/tokens: FAILED — no token, the assertions below cannot run" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the API answers"
if ms_docker_curl "${container}" -sf http://127.0.0.1:8080/api/v1/objects/root >/dev/null; then
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
if matches 'icmp.ping' ms_docker_curl "${container}" -sf http://127.0.0.1:8080/api/v1/sensor-types; then
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
if matches 'id="root"' docker exec "${container}" curl -sf http://127.0.0.1:8080/; then
  echo "    GET /: app shell ok"
else
  echo "    GET /: FAILED — no app shell served" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the probe reached the core and is awaiting approval"
# **This asserted "the probe was told what to scan" until 2026-08-29, and had been wrong since
# `R-01`.** A fresh install's probe is *not* sent a configuration: it is registered as pending
# and given nothing until somebody approves it, which is the property `smoke-enrol.sh` exists to
# prove. The assertion here outlived the behaviour it was written for and reported a failure on
# every run.
#
# What is worth proving in *this* script is the packaged layout: the mTLS channel, the protocol
# handshake and the probe's side of it all lining up from /opt/ms rather than from the
# development tree. A probe the core has registered as pending proves exactly that, and stops
# where `smoke-enrol.sh` begins.
if matches 'waiting for approval' docker exec "${container}" journalctl -u ms-core --no-pager; then
  echo "    probe handshake: connected, pending approval"
else
  echo "    probe handshake: FAILED — no probe reached the core" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  docker exec "${container}" journalctl -u ms-probe --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the state machine is wired into the packaged build"
# A fresh install has no sensors, so no state can be produced — but the route being registered
# proves migration 008 applied and M-02's read side shipped. An unregistered route answers
# ROUTE_NOT_FOUND; a registered one looks for the object and answers OBJECT_NOT_FOUND. The
# difference is the whole assertion.
state_code="$(ms_docker_curl "${container}" -s http://127.0.0.1:8080/api/v1/sensors/999999/state \
  | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p')"
if [ "${state_code}" = "OBJECT_NOT_FOUND" ]; then
  echo "    GET /api/v1/sensors/:id/state: registered"
else
  echo "    GET /api/v1/sensors/:id/state: FAILED — answered ${state_code:-nothing}" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi

echo "==> asserting the data lifecycle ran"
# The housekeeping loop is what rolls up, compresses and drops. It runs on a timer inside the
# service, so a packaging or migration fault that leaves it dead would otherwise show up as
# nothing at all until data started disappearing or piling up.
if matches 'housekeeping pass complete' docker exec "${container}" journalctl -u ms-core --no-pager; then
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
if matches 'check pool started' docker exec "${container}" journalctl -u ms-probe --no-pager; then
  echo "    check pool: ok"
else
  echo "    check pool: FAILED — no worker pool in the journal" >&2
  docker exec "${container}" journalctl -u ms-probe --no-pager -n 40 || true
  failed=1
fi

# --- the upgrade path (H-03) ------------------------------------------------------------------
#
# Re-running the installer is how an upgrade happens, and it is the path with the most ways to
# lose an operator's day: a configuration that the new build cannot read, a schema the new build
# is behind or ahead of, a config file quietly replaced. This asserts the three that matter.

echo "==> asserting a re-run keeps the configuration and takes a backup"
before="$(docker exec "${container}" md5sum /etc/ms/core.json | cut -d' ' -f1)"
docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh --no-start' >/dev/null
after="$(docker exec "${container}" md5sum /etc/ms/core.json | cut -d' ' -f1)"
if [ "${before}" = "${after}" ]; then
  echo "    configuration: kept"
else
  echo "    configuration: FAILED — install.sh overwrote /etc/ms/core.json" >&2
  failed=1
fi
backups="$(docker exec "${container}" bash -c 'ls /etc/ms/core.json.*.bak 2>/dev/null | wc -l')"
if [ "${backups}" -ge 1 ]; then
  echo "    backup: ${backups} timestamped copy(ies)"
  # Mode 0600 and root-owned: a configuration file holds the database password, and a backup
  # that widened its permissions would be a credential leak introduced by an upgrade.
  perms="$(docker exec "${container}" bash -c 'stat -c "%a %U" /etc/ms/core.json.*.bak | head -1')"
  if [ "${perms}" = "600 root" ]; then
    echo "    backup permissions: ${perms}"
  else
    echo "    backup permissions: FAILED — expected '600 root', got '${perms}'" >&2
    failed=1
  fi
else
  echo "    backup: FAILED — no timestamped copy of the previous configuration" >&2
  failed=1
fi

echo "==> asserting config check accepts what the services are running on"
for svc in core probe; do
  if docker exec "${container}" /opt/ms/bin/ms-${svc} config check --config /etc/ms/${svc}.json >/dev/null 2>&1; then
    echo "    ms-${svc}: ok"
  else
    echo "    ms-${svc}: FAILED — the installed configuration does not validate" >&2
    docker exec "${container}" /opt/ms/bin/ms-${svc} config check --config /etc/ms/${svc}.json || true
    failed=1
  fi
done

echo "==> asserting an installer re-run refuses to restart onto a broken configuration"
# The property this exists for: the old service keeps running. An upgrade that restarts into a
# configuration the new build cannot read has taken the installation down to tell the operator
# about a typo.
docker exec "${container}" cp /etc/ms/core.json /tmp/core.json.good
docker exec "${container}" bash -c 'echo "{\"api\": {\"port\": \"eighty-eighty\"}}" > /etc/ms/core.json'
if docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh' >/tmp/upgrade.log 2>&1; then
  echo "    FAILED — install.sh restarted onto a configuration that cannot load" >&2
  failed=1
else
  echo "    refused, as it should"
  for svc in ms-core ms-probe; do
    state="$(docker exec "${container}" systemctl is-active "${svc}" 2>/dev/null || true)"
    printf '    %-9s still %s\n' "${svc}:" "${state}"
    [ "${state}" = "active" ] || { echo "    FAILED — ${svc} was taken down by the refusal" >&2; failed=1; }
  done
fi
docker exec "${container}" cp /tmp/core.json.good /etc/ms/core.json

echo "==> asserting the schema gate refuses a core older than its database"
# A downgrade has *nothing pending* — the schema is past the build, not before it — so a check
# that counts pending migrations sees a healthy installation. This plants a migration from the
# future and asserts the core refuses to start on it.
docker exec "${container}" su postgres -c "psql -d monitoring -c \"INSERT INTO schema_migration (id, name, checksum) VALUES (99001, 'from-the-future', 'x')\"" >/dev/null
docker exec "${container}" systemctl stop ms-core
if docker exec "${container}" systemctl start ms-core 2>/dev/null && \
   [ "$(docker exec "${container}" systemctl is-active ms-core 2>/dev/null || true)" = "active" ]; then
  echo "    FAILED — the core started against a schema newer than itself" >&2
  failed=1
else
  echo "    refused, as it should"
fi
docker exec "${container}" su postgres -c "psql -d monitoring -c \"DELETE FROM schema_migration WHERE id = 99001\"" >/dev/null
docker exec "${container}" systemctl start ms-core
sleep 2

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

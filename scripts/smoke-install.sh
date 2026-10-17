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
# shellcheck source=scripts/lib/smoke-names.sh
. "${repo_root}/scripts/lib/smoke-names.sh"
# shellcheck source=scripts/lib/build-tree.sh
. "${repo_root}/scripts/lib/build-tree.sh"
# shellcheck source=scripts/lib/mac-metadata.sh
. "${repo_root}/scripts/lib/mac-metadata.sh"
# shellcheck source=scripts/lib/doc-block.sh
. "${repo_root}/scripts/lib/doc-block.sh"

# **Ubuntu is named in the exit criterion, so it is a target here** (`PLAN.md` Phase 10: "a clean
# install on Ubuntu and on Windows Server"). Proving Debian and *assuming* Ubuntu would be
# assuming the half of the sentence that has a different PostgreSQL packaging, a different
# TimescaleDB repository and a different init layout.
#
#     MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh
#
# `--profile full` (or `MS_SMOKE_PROFILE=full`) expects the full profile; the default is v1, the
# release candidate, and a package that is not the profile expected fails (`H-20`).
#
# `MS_SMOKE_KEEP=1` leaves the box running when the script ends and prints its name — for a
# measurement that needs a real systemd install to work in (`scripts/sizing/memory-limit-live.sh`,
# `P-210`). Both services are stopped by then: the last assertion is that they stop cleanly.
distro="${MS_SMOKE_DISTRO:-debian}"
case "${distro}" in
  debian) dockerfile=Dockerfile;        image=ms-smoke:bookworm ;;
  ubuntu) dockerfile=Dockerfile.ubuntu; image=ms-smoke:ubuntu ;;
  *) echo "unknown MS_SMOKE_DISTRO: ${distro} (debian|ubuntu)" >&2; exit 2 ;;
esac
# Per-run (`P-200`): CI and a hand-run share one Docker daemon now.
container="$(ms_smoke_name "install-${distro}")"

# **Which profile the package must be** (`H-20`): `v1` unless `--profile full` or
# `MS_SMOKE_PROFILE=full` says otherwise. The v1 assertions used to run only when the installed
# manifest already said v1, so a `package.sh` whose default had slipped to `full` produced a
# package that skipped them and still reported "smoke test passed". The expectation comes from the
# caller now, and a package that is not what was expected fails.
expected_profile="${MS_SMOKE_PROFILE:-v1}"
tarball=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || { echo "--profile needs v1 or full" >&2; exit 2; }
      expected_profile="$2"
      shift 2
      ;;
    --profile=*) expected_profile="${1#--profile=}"; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) tarball="$1"; shift ;;
  esac
done
case "${expected_profile}" in
  v1 | full) ;;
  *) echo "the expected profile must be v1 or full, not '${expected_profile}'" >&2; exit 2 ;;
esac

# Build unless handed a specific tarball. Reusing whichever one happened to be lying around is
# how this test silently validated a package built before the change under test — which is worse
# than not running it, because it reports success.
if [ -n "${tarball}" ]; then
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
  # Which commit this is (`H-11`), worked out here: `git` inside the toolchain container cannot
  # reach a worktree's repository, whose `.git` names a path on the host. **Fails closed**
  # (`H-20`): a `git` that errors is not a clean tree, and the tree is asked again once the
  # package is built, because an edit made during a build of several minutes is under a stamp
  # taken before it.
  build_commit=""
  build_dirty=0
  build_state=""
  if git -C "${repo_root}" rev-parse --verify HEAD >/dev/null 2>&1; then
    build_state="$(ms_tree_state "${repo_root}")" || {
      echo "git cannot say whether this tree is clean, so a package built from it could not" \
        "say what it is" >&2
      exit 1
    }
    read -r build_commit build_dirty _ <<<"${build_state}"
  fi
  # A v1 package is built with `package.sh`'s default, so the default is what is tested.
  build_profile=""
  [ "${expected_profile}" = "v1" ] || build_profile="MS_BUILD_PROFILE=${expected_profile}"
  if [ "${MS_SMOKE_HOST_NPM:-0}" = "1" ]; then
    # shellcheck disable=SC2086 # empty, or one NAME=value that has to stay a separate word
    env ${build_profile} MS_BUILD_COMMIT="${build_commit}" MS_BUILD_DIRTY="${build_dirty}" \
      "${repo_root}/scripts/package.sh" >/dev/null
  else
    "${repo_root}/scripts/dev.sh" \
      "${build_profile} MS_BUILD_COMMIT=${build_commit} MS_BUILD_DIRTY=${build_dirty} scripts/package.sh" \
      >/dev/null
  fi
  if [ -n "${build_state}" ] && [ "$(ms_tree_state "${repo_root}" || true)" != "${build_state}" ]; then
    echo "the tree changed while it was being packaged, so the package is not what its stamp" \
      "says; run this again on a tree nobody is editing" >&2
    exit 1
  fi
  tarball="$(ls -t "${repo_root}"/release/ms-*.tar.gz 2>/dev/null | head -1)"
  [ -n "${tarball}" ] && [ -f "${tarball}" ] || {
    echo "scripts/package.sh produced no tarball" >&2
    exit 1
  }
fi
echo "    ${tarball}"

remove_box() { docker rm -f "${container}" >/dev/null 2>&1 || true; }
# **This run's installer output, and nobody else's.** Runs share the machine by design (`P-200`:
# a Debian and an Ubuntu run, or CI and a hand run), and a log at a fixed /tmp path let one run
# pass on what another one's installer printed.
logs="$(mktemp -d "${TMPDIR:-/tmp}/ms-smoke-install.XXXXXX")"
cleanup() {
  rm -rf "${logs}"
  if [ "${MS_SMOKE_KEEP:-0}" = "1" ]; then
    echo "==> kept ${container} (docker rm -f ${container} removes it)"
    return
  fi
  remove_box
}
trap cleanup EXIT

echo "==> building smoke image"
docker build -q -t "${image}" -f "${repo_root}/scripts/smoke/${dockerfile}" \
  "${repo_root}/scripts/smoke" >/dev/null

# **Listed by the image's GNU tar, before anything is booted.** A release repacked on a Mac holds
# an AppleDouble `._<name>` for every file with extended attributes, which the host's tar would
# not list, and one of them stops the core before any assertion here is reached (`H-20`).
echo "==> asserting the tarball holds nothing a Mac's tar added"
mac_entries="$(docker run --rm -i --entrypoint tar "${image}" -tzf - <"${tarball}" \
  | ms_mac_metadata_count)"
if [ "${mac_entries}" != "0" ]; then
  echo "    FAILED — ${mac_entries} entries are ._* or __MACOSX; pack it on Linux, or with" \
    "COPYFILE_DISABLE=1 --no-mac-metadata --no-xattrs" >&2
  echo "==> SMOKE TEST FAILED" >&2
  exit 1
fi

echo "==> booting a clean systemd box"
remove_box
# The labels are two separate arguments by design, so this expansion must split.
# shellcheck disable=SC2046
docker run -d --name "${container}" \
  $(ms_smoke_labels) \
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

# **No `ping`, no install** (`H-31`): the probe's ICMP sensors run the system binary, and the
# installer refuses the way it refuses without Node. The image has one, as a host does; it is
# hidden for this one attempt.
ping_path="$(docker exec "${container}" bash -c 'command -v ping')"
docker exec "${container}" mv "${ping_path}" "${ping_path}.hidden"
if docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh' >"${logs}/noping.log" 2>&1; then
  echo "    FAILED — install.sh installed onto a host with no ping" >&2
  failed_early=1
elif ! grep -q 'ping is required' "${logs}/noping.log"; then
  echo "    FAILED — install.sh refused, but not for ping:" >&2
  sed 's/^/      /' "${logs}/noping.log" >&2
  failed_early=1
else
  echo "    no ping: refused — $(grep 'ping is required' "${logs}/noping.log")"
fi
docker exec "${container}" mv "${ping_path}.hidden" "${ping_path}"
docker exec "${container}" test ! -e /opt/ms/bin/ms-core || {
  echo "    FAILED — the refused install left /opt/ms behind" >&2
  failed_early=1
}

# **And a real host's ICMP setting, which a container does not have** (`H-31`). Docker opens
# ping_group_range to every group; the kernel's own default, on every host the packages are for,
# is `1 0`, nobody. The box's network namespace is its own, so this goes no further.
docker exec "${container}" bash -c 'echo "1 0" > /proc/sys/net/ipv4/ping_group_range'

# **A first install, as an operator runs it: no `--no-start`** (`H-30`). The core's file was just
# created from the example, with no password, so nothing is started and the installer says what
# to set — and exits 0, where it used to start the core onto the empty password and fail.
if docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh' >"${logs}/first.log" 2>&1; then
  sed 's/^/    /' "${logs}/first.log" | tail -22
else
  echo "    FAILED — a first install exited non-zero:" >&2
  sed 's/^/      /' "${logs}/first.log" >&2
  failed_early=1
fi
echo "==> asserting a first install started nothing, and said what to configure"
for svc in ms-core ms-probe; do
  state="$(docker exec "${container}" systemctl is-active "${svc}" 2>/dev/null || true)"
  printf '    %-9s %s\n' "${svc}:" "${state}"
  [ "${state}" = "inactive" ] || { echo "    FAILED — ${svc} is ${state} after a first install" >&2; failed_early=1; }
done
# **Only ms-setup's message, from its heading to its last line.** install.sh ends a first
# installation with its own `reset-failed` and `start` lines, so the whole log would say those
# whether or not ms-setup said anything.
sed -n '/core\.json is new, so nothing was started/,/the lines are in the comments of ms-core\.service/p' \
  "${logs}/first.log" >"${logs}/first-message.log"
for said in 'core.json is new, so nothing was started' 'database.password' \
  'MS_DATABASE__PASSWORD__FROM_FILE' 'systemctl reset-failed ms-core ms-probe' \
  'systemctl start ms-core ms-probe' 'the lines are in the comments of ms-core.service'; do
  grep -qF -- "${said}" "${logs}/first-message.log" || {
    echo "    FAILED — the first install did not say '${said}'" >&2
    failed_early=1
  }
done
# **And install.sh's own summary says the same, because ms-setup told it so** (`H-35`).
for said in 'ms-core ms-probe: not started, a first installation' \
  'This is a first installation, so nothing was started'; do
  grep -qF -- "${said}" "${logs}/first.log" || {
    echo "    FAILED — install.sh's summary of a first install did not say '${said}'" >&2
    failed_early=1
  }
done

docker cp "${repo_root}/scripts/smoke/configure-core.sh" "${container}:/tmp/configure-core.sh"
docker exec "${container}" bash /tmp/configure-core.sh

echo "==> starting the services"
# A start that fails would otherwise end the run under `set -e` with systemd's pointer to a
# journal, in a box the exit trap is about to remove.
if ! docker exec "${container}" systemctl start ms-core ms-probe; then
  for svc in ms-core ms-probe; do
    docker exec "${container}" systemctl status "${svc}" --no-pager -l || true
    docker exec "${container}" journalctl -u "${svc}" --no-pager -n 40 || true
  done
  echo "==> SMOKE TEST FAILED" >&2
  exit 1
fi

echo "==> asserting both services are active"
failed="${failed_early:-0}"
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

echo "==> asserting the installed build says which commit it is"
# `H-11`. Every build said `0.1.0` and nothing else. Compared with the manifest that was installed
# and, when this script packaged it, with the commit it packaged — not merely "a commit came
# back", which a build reporting somebody else's would satisfy.
#
# The route answers the manifest and then what the server constructed (`H-12`), in that order:
# the response schema lists the manifest's fields in the order `package.sh` writes them. So the
# served document is the installed one with its closing brace replaced by `,"subsystems":…`.
installed="$(docker exec "${container}" cat /opt/ms/app/core/build.json 2>/dev/null | tr -d ' \n' || true)"
served="$(ms_docker_curl "${container}" -sf http://127.0.0.1:8080/api/v1/build 2>/dev/null || true)"
if [ -z "${served}" ] || [ -z "${installed}" ] || [[ "${served}" != "${installed%\}},\"subsystems\":{"* ]]; then
  echo "    GET /api/v1/build: FAILED — served '${served}', installed '${installed}'" >&2
  failed=1
elif [ -n "${build_commit:-}" ] && ! matches "\"commit\":\"${build_commit}\"" printf '%s' "${served}"; then
  echo "    GET /api/v1/build: FAILED — '${served}' is not ${build_commit}" >&2
  failed=1
else
  echo "    GET /api/v1/build: ${served}"
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

echo "==> asserting the package is the ${expected_profile} profile it was meant to be"
if matches "\"profile\":\"${expected_profile}\"" printf '%s' "${served}"; then
  echo "    profile: ${expected_profile}"
else
  echo "    profile: FAILED — expected ${expected_profile}, and the core says '${served}'" >&2
  failed=1
fi

echo "==> asserting the dependencies are the ones locked at the package's commit"
# `H-20`. The candidate of 2026-09-28 was installed with `npm install` from caret ranges, and 29 of
# its 234 runtime packages were versions no suite had run against. `package.sh` installs from the
# committed lock now and checks what it installed; this asks the installed box the same question,
# against the lock at the commit the package names, which is the claim its manifest makes. A
# package built with uncommitted changes is compared with this checkout's lock instead, and says
# so, because nothing about it is exact.
stamped_commit="$(printf '%s' "${installed}" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')"
stamped_lock="$(printf '%s' "${installed}" | sed -n 's/.*"lock":"\(sha256:[0-9a-f]\{64\}\)".*/\1/p')"
lock_dir="$(mktemp -d)"
lock_source=""
if [ -z "${stamped_lock}" ]; then
  echo "    lock: FAILED — the package records no lock: '${installed}'" >&2
  failed=1
elif matches '"dirty":true' printf '%s' "${installed}"; then
  cp "${repo_root}/package-lock.json" "${lock_dir}/root-lock.json"
  lock_source="this checkout's package-lock.json (the package was built with uncommitted changes)"
elif [ -z "${stamped_commit}" ]; then
  echo "    lock: FAILED — the package names no commit, so there is no lock to compare it with" >&2
  failed=1
elif git -C "${repo_root}" show "${stamped_commit}:package-lock.json" >"${lock_dir}/root-lock.json" 2>/dev/null; then
  lock_source="package-lock.json at ${stamped_commit:0:12}"
else
  echo "    lock: FAILED — this repository has no ${stamped_commit}, so its lock cannot be read" >&2
  failed=1
fi
if [ -n "${lock_source}" ]; then
  docker cp "${lock_dir}/root-lock.json" "${container}:/tmp/root-lock.json"
  docker cp "${repo_root}/scripts/lib/stage-lock.mjs" "${container}:/tmp/stage-lock.mjs"
  workspaces="shared sensors core probe"
  # shellcheck disable=SC2086 # the workspaces are separate arguments
  locked="$(docker exec "${container}" node /tmp/stage-lock.mjs hash /tmp/root-lock.json \
    /opt/ms/app ${workspaces} 2>&1 || true)"
  shipped="sha256:$(docker exec "${container}" sha256sum /opt/ms/app/package-lock.json 2>/dev/null \
    | cut -d' ' -f1)"
  # shellcheck disable=SC2086
  if ! verified="$(docker exec "${container}" node /tmp/stage-lock.mjs verify /tmp/root-lock.json \
    /opt/ms/app ${workspaces} 2>&1)"; then
    echo "    lock: FAILED — against ${lock_source}: ${verified}" >&2
    failed=1
  elif [ "${locked}" != "${stamped_lock}" ]; then
    echo "    lock: FAILED — build.json says ${stamped_lock}, and ${lock_source} gives ${locked}" >&2
    failed=1
  elif [ "${shipped}" != "${stamped_lock}" ]; then
    echo "    lock: FAILED — app/package-lock.json is ${shipped}, and build.json says" \
      "${stamped_lock}" >&2
    failed=1
  else
    echo "    lock: ${stamped_lock}, from ${lock_source}; ${verified}"
  fi
fi
rm -rf "${lock_dir}"

echo "==> asserting a v1 build carries nothing v1 leaves out"
# `H-12`. Of the running core, not of the manifest: a stamp that says v1 over a core that built
# maps anyway is the defect, and only the core can show it. The five withheld types by name, so
# that putting one back fails here; the three subsystems as the core reports what it built; and
# two of their routes, because a route that answers is what an operator would actually meet —
# reports among them, the heavier subsystem and the one with a formatter pool behind it. Run
# whenever v1 was expected, whatever the package says (`H-20`).
if [ "${expected_profile}" = "v1" ]; then
  types="$(ms_docker_curl "${container}" -sf http://127.0.0.1:8080/api/v1/sensor-types 2>/dev/null || true)"
  carried=""
  for id in flow.netflow windows.cpu windows.memory windows.service windows.volume; do
    if matches "\"id\":\"${id}\"" printf '%s' "${types}"; then carried="${carried} ${id}"; fi
  done
  maps_status="$(ms_docker_curl "${container}" -s -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:8080/api/v1/maps 2>/dev/null || true)"
  reports_status="$(ms_docker_curl "${container}" -s -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:8080/api/v1/reports 2>/dev/null || true)"
  if [ -z "${types}" ]; then
    echo "    v1: FAILED — GET /api/v1/sensor-types did not answer" >&2
    failed=1
  elif [ -n "${carried}" ]; then
    echo "    v1: FAILED — the catalogue carries${carried}" >&2
    failed=1
  elif ! matches '"subsystems":{"maps":false,"reports":false,"libraries":false}' printf '%s' "${served}"; then
    echo "    v1: FAILED — the core built v2 subsystems: '${served}'" >&2
    failed=1
  elif [ "${maps_status}" != "404" ] || [ "${reports_status}" != "404" ]; then
    echo "    v1: FAILED — GET /api/v1/maps answered ${maps_status} and /reports" \
      "${reports_status}, not 404" >&2
    failed=1
  else
    echo "    v1: no flow or Windows types, no maps, reports or libraries;" \
      "/maps and /reports are 404"
  fi
else
  echo "    a full build was expected — nothing is withheld"
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

echo "==> asserting an icmp.ping sensor on the installed probe reaches Up (H-31)"
# **Through the running units, at a real host's ICMP setting** (`1 0`, set before the install).
# The rehearsal's every ping sensor read Down for want of a binary; with one, a `ping` the probe
# runs still could not use the capability it is installed with, under the unit's
# `NoNewPrivileges=` and bounding set. `ms-setup` opens ping_group_range to the probe's group, and
# this is the proof that it is enough: the real probe, its worker, its child process, its sandbox.
api=http://127.0.0.1:8080/api/v1
json() { docker exec -i "${container}" node -pe "JSON.parse(require('node:fs').readFileSync(0,'utf8'))$1"; }
echo "    $(docker exec "${container}" grep -h ping_group_range /etc/sysctl.d/60-ms-probe-ping.conf 2>&1)"
probe_gid=''
for _ in $(seq 1 30); do
  probe_gid="$(ms_docker_curl "${container}" -sf "${api}/probes?status=pending" 2>/dev/null \
    | json ".items[0]?.gid ?? ''" 2>/dev/null || true)"
  [ -n "${probe_gid}" ] && break
  sleep 1
done
ping_state=''
ping_said=''
if [ -z "${probe_gid}" ]; then
  echo "    FAILED — no probe is waiting for approval" >&2
  failed=1
else
  root_id="$(ms_docker_curl "${container}" -sf "${api}/objects/root" | json '.id' || true)"
  probe_object="$(ms_docker_curl "${container}" -sf -X POST "${api}/objects" -H 'content-type: application/json' \
    -d "{\"kind\":\"probe\",\"parentId\":${root_id},\"name\":\"Local probe\"}" | json '.id' || true)"
  ms_docker_curl "${container}" -sf -X POST "${api}/probes/${probe_gid}/approve" \
    -H 'content-type: application/json' -d "{\"objectId\":${probe_object},\"local\":true}" >/dev/null || true
  device_id="$(ms_docker_curl "${container}" -sf -X POST "${api}/objects" -H 'content-type: application/json' \
    -d "{\"kind\":\"device\",\"parentId\":${probe_object},\"name\":\"This box\",\"host\":\"127.0.0.1\"}" \
    | json '.id' || true)"
  ping_sensor="$(ms_docker_curl "${container}" -sf -X POST "${api}/objects" -H 'content-type: application/json' \
    -d "{\"kind\":\"sensor\",\"parentId\":${device_id},\"name\":\"Ping\",\"sensorType\":\"icmp.ping\"}" \
    | json '.id' || true)"
  for _ in $(seq 1 150); do
    ping_said="$(ms_docker_curl "${container}" -sf "${api}/sensors/${ping_sensor}/state" 2>/dev/null || true)"
    ping_state="$(printf '%s' "${ping_said}" | json '.state' 2>/dev/null || true)"
    [ "${ping_state}" = up ] && break
    [ "${ping_state}" = down ] && break
    sleep 1
  done
  if [ "${ping_state}" = up ]; then
    echo "    icmp.ping 127.0.0.1, sensor ${ping_sensor} on probe object ${probe_object}: up"
  else
    echo "    FAILED — the ping sensor is '${ping_state:-unknown}': ${ping_said}" >&2
    docker exec "${container}" journalctl -u ms-probe --no-pager -n 30 || true
    failed=1
  fi
fi

# --- the upgrade path (H-03) ------------------------------------------------------------------
#
# Re-running the installer is how an upgrade happens, and it is the path with the most ways to
# lose an operator's day: a configuration that the new build cannot read, a schema the new build
# is behind or ahead of, a config file quietly replaced. This asserts the three that matter.

echo "==> asserting the units are the release's, in /usr/lib"
# `H-21`. An operator's changes go in a drop-in under /etc, which no upgrade touches; a unit in
# /etc/systemd/system itself would override the release's whole, and be overwritten by the next.
if docker exec "${container}" test -f /usr/lib/systemd/system/ms-core.service && \
   ! docker exec "${container}" test -e /etc/systemd/system/ms-core.service; then
  echo "    ms-core.service: /usr/lib/systemd/system, nothing in /etc"
else
  echo "    units: FAILED — not where an upgrade can replace them without an operator's edits" >&2
  failed=1
fi

# What an upgrade must keep and what it must clear up: a drop-in of the operator's, and a unit an
# earlier release left in /etc exactly as it shipped it, which would otherwise go on overriding
# every unit installed after it.
docker exec "${container}" mkdir -p /etc/systemd/system/ms-core.service.d
docker exec "${container}" bash -c \
  'printf "[Service]\nEnvironment=MS_H21_DROP_IN=kept\n" > /etc/systemd/system/ms-core.service.d/h21.conf'
docker cp "${repo_root}/scripts/smoke/legacy-units/ms-probe.service" \
  "${container}:/etc/systemd/system/ms-probe.service"
docker exec "${container}" systemctl daemon-reload

echo "==> asserting a re-run keeps the configuration and takes a backup"
before="$(docker exec "${container}" md5sum /etc/ms/core.json | cut -d' ' -f1)"
# `H-26`: a setting the new build accepts and that does nothing under it, so that this upgrade's
# check passes with a warning to show. Only a v1 probe has one — `flowListener.enabled`, with no
# flow sensor type to feed (`B-08`); the full build would open the port and say nothing. Written
# in place, so the file keeps its owner and mode, and put back once the upgrade has been read.
if [ "${expected_profile}" = "v1" ]; then
  docker exec "${container}" cp -p /etc/ms/probe.json /tmp/probe.json.h26
  docker exec "${container}" node -e '
    const fs = require("node:fs");
    const file = "/etc/ms/probe.json";
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.flowListener = { ...(config.flowListener ?? {}), enabled: true };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  '
fi
# With a start, the way an upgrade is run: it stops both services, swaps the release in and
# starts them again (`H-21`) — `--no-start` would now leave them stopped.
docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh' >"${logs}/rerun.log" 2>&1 || {
  echo "    FAILED — the re-run did not succeed:" >&2
  sed 's/^/      /' "${logs}/rerun.log" >&2
  failed=1
}
# **An upgrade's summary says it started them, and nothing about a first installation** (`H-35`):
# the note used to close every run with a core, this one included, just after both restarted.
if grep -qi 'first installation' "${logs}/rerun.log"; then
  echo "    FAILED — the upgrade's summary carries the first-installation note:" >&2
  sed 's/^/      /' "${logs}/rerun.log" >&2
  failed=1
elif ! grep -qF '  services        ms-core ms-probe: started' "${logs}/rerun.log"; then
  echo "    FAILED — the upgrade's summary does not say both services were started:" >&2
  sed 's/^/      /' "${logs}/rerun.log" >&2
  failed=1
else
  echo "    summary: $(grep -F '  services  ' "${logs}/rerun.log" | sed 's/^ *//'), no first-installation note"
fi
if [ "${expected_profile}" = "v1" ]; then
  # The warning itself, under the installer's heading for it, in what the operator was shown —
  # and the upgrade went ahead all the same, which the assertions below are about. The probe
  # that was just started read the file with the setting in it, which a v1 probe starts on; the
  # file goes back now and the probe reads it at its next start.
  #
  # **Once** (`H-27`): the tarball asks the new build twice, in `place-release.sh` before the swap
  # and in `ms-setup` after it, and `ms-setup` is the one that shows a pass its warnings. A count
  # of two is the warning printed by both; `grep -c` prints 0 and exits 1 on none, which the
  # comparison reads and `set -e` does not.
  shown="$(grep -c '^    warning: flowListener.enabled' "${logs}/rerun.log" || true)"
  if grep -q 'probe.json is valid for .*The check says:' "${logs}/rerun.log" && \
     [ "${shown}" = "1" ]; then
    echo "    a passing check's warning: shown once (flowListener.enabled on a v1 probe)"
  else
    echo "    FAILED — the upgrade did not show the passing check's warning exactly once (${shown}):" >&2
    sed 's/^/      /' "${logs}/rerun.log" >&2
    failed=1
  fi
  docker exec "${container}" cp -p /tmp/probe.json.h26 /etc/ms/probe.json
fi
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

echo "==> asserting the upgrade swapped the release in, and kept the units right"
for svc in ms-core ms-probe; do
  state="$(docker exec "${container}" systemctl is-active "${svc}" 2>/dev/null || true)"
  printf '    %-9s %s\n' "${svc}:" "${state}"
  [ "${state}" = "active" ] || { echo "    FAILED — ${svc} is not running after the upgrade" >&2; failed=1; }
done
if docker exec "${container}" test -f /opt/ms/previous/VERSION; then
  echo "    previous release: kept at /opt/ms/previous"
else
  echo "    FAILED — the release it replaced was not kept" >&2
  failed=1
fi
if docker exec "${container}" test -e /etc/systemd/system/ms-probe.service; then
  echo "    FAILED — the unit an earlier release left in /etc is still overriding" >&2
  failed=1
else
  echo "    earlier release's unit: removed"
fi
if matches 'MS_H21_DROP_IN=kept' docker exec "${container}" systemctl show ms-core -p Environment; then
  echo "    operator's drop-in: kept, and applied"
else
  echo "    FAILED — the operator's drop-in did not survive the upgrade" >&2
  failed=1
fi
docker exec "${container}" rm -rf /etc/systemd/system/ms-core.service.d
docker exec "${container}" systemctl daemon-reload

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
# Without the flag, as the documentation runs it: the launcher reads /etc/ms (`H-21`). It used to
# read no file, check the schema's defaults and say "valid" whatever core.json held.
if matches 'file            /etc/ms/core.json' docker exec "${container}" /opt/ms/bin/ms-core config check; then
  echo "    ms-core config check, no flag: reads /etc/ms/core.json"
else
  echo "    FAILED — ms-core config check with no flag did not read /etc/ms/core.json" >&2
  failed=1
fi

echo "==> asserting an installer re-run refuses to restart onto a broken configuration"
# The property this exists for: the old service keeps running. An upgrade that restarts into a
# configuration the new build cannot read has taken the installation down to tell the operator
# about a typo.
# `H-21`: and nothing was touched — the same processes, on the same tree, told the truth about it.
docker exec "${container}" cp /etc/ms/core.json /tmp/core.json.good
pids_before="$(docker exec "${container}" systemctl show ms-core ms-probe -p MainPID --value | tr '\n' ' ')"
# The directory's inode, not its contents: this re-runs the same tarball, so a swap would put
# identical files in place, and only a new directory would show it happened.
tree_before="$(docker exec "${container}" stat -c %i /opt/ms/app)"
docker exec "${container}" bash -c 'echo "{\"api\": {\"port\": \"eighty-eighty\"}}" > /etc/ms/core.json'
if docker exec "${container}" /opt/ms/bin/ms-core config check >/dev/null 2>&1; then
  echo "    FAILED — ms-core config check with no flag passed a core.json that cannot load" >&2
  failed=1
fi
if docker exec "${container}" bash -c 'cd /tmp/unpacked/ms-* && ./install.sh' >"${logs}/upgrade.log" 2>&1; then
  echo "    FAILED — install.sh restarted onto a configuration that cannot load" >&2
  failed=1
else
  echo "    refused, as it should"
  for svc in ms-core ms-probe; do
    state="$(docker exec "${container}" systemctl is-active "${svc}" 2>/dev/null || true)"
    printf '    %-9s still %s\n' "${svc}:" "${state}"
    [ "${state}" = "active" ] || { echo "    FAILED — ${svc} was taken down by the refusal" >&2; failed=1; }
  done
  pids_after="$(docker exec "${container}" systemctl show ms-core ms-probe -p MainPID --value | tr '\n' ' ')"
  [ "${pids_before}" = "${pids_after}" ] || {
    echo "    FAILED — the services were restarted (${pids_before}-> ${pids_after})" >&2
    failed=1
  }
  tree_after="$(docker exec "${container}" stat -c %i /opt/ms/app)"
  if [ "${tree_before}" != "${tree_after}" ] || \
     docker exec "${container}" test -e /opt/ms/.incoming; then
    echo "    FAILED — the refusal left the installed tree changed" >&2
    failed=1
  fi
  grep -q 'Nothing was changed' "${logs}/upgrade.log" || {
    echo "    FAILED — the refusal did not say that nothing was changed:" >&2
    sed 's/^/      /' "${logs}/upgrade.log" >&2
    failed=1
  }
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

echo "==> asserting a probe stopped for crashing comes back, and one refused its file does not"
# `H-23`, on a real systemd. The shipped cool-down is ten minutes; a drop-in shortens it for this
# box only, the way no operator would, so the test takes seconds.
cooldown=15
docker exec "${container}" mkdir -p /etc/systemd/system/ms-recover@.service.d
docker exec "${container}" bash -c "printf '[Service]\nEnvironment=MS_RECOVER_BASE_SEC=${cooldown}\n' \
  > /etc/systemd/system/ms-recover@.service.d/smoke.conf"
docker exec "${container}" systemctl daemon-reload
# **Among what the unit names, not all of it** (`H-25`): an operator's drop-in adds to the list,
# as the runbook's `OnFailure=` below does, and that is not a fault in the release's unit.
for svc in ms-core ms-probe; do
  named="$(docker exec "${container}" systemctl show "${svc}" -p OnFailure --value)"
  case " ${named} " in
    *" ms-recover@${svc}.service "*) ;;
    *)
      echo "    FAILED — ${svc} names '${named}' in OnFailure=, without ms-recover@${svc}.service" >&2
      failed=1
      ;;
  esac
done
is_active() { [ "$(docker exec "${container}" systemctl is-active ms-probe 2>/dev/null || true)" = active ]; }
wait_active() {
  for _ in $(seq 1 "$1"); do is_active && return 0; sleep 1; done
  return 1
}
# Killed the way the kernel kills it at its ceiling, until the start limit stops it: after a
# reset, the sixth start inside ten minutes is refused. Only this test's starts are counted.
# **Watched for `failed`, not for `Result=start-limit-hit`**: on systemd 252 a loop that runs into
# the limit keeps the crash's own result, `signal` here, and `recover.sh` has the measurements.
# Checked 7 s after each kill: the refusal comes 5 s after it and the retry 15 s after that.
state() { docker exec "${container}" systemctl is-active ms-probe 2>/dev/null || true; }
docker exec "${container}" systemctl reset-failed ms-probe
kills=0
trace=''
for _ in $(seq 1 10); do
  [ "$(state)" = failed ] && break
  wait_active 30 || true
  trace="${trace}      $(date +%T) before kill $((kills + 1)): $(docker exec "${container}" systemctl show ms-probe \
    -p ActiveState -p SubState -p NRestarts -p Result -p MainPID | tr '\n' ' ')"$'\n'
  docker exec "${container}" systemctl kill -s KILL ms-probe 2>&1 | sed 's/^/        kill: /' || true
  kills=$((kills + 1))
  sleep 7
done
result="$(docker exec "${container}" systemctl show ms-probe -p Result --value)"
if [ "$(state)" != failed ]; then
  echo "    FAILED — ${kills} kills did not trip the start limit ($(state), result: ${result})" >&2
  printf '%s' "${trace}" >&2
  docker exec "${container}" systemctl status ms-probe --no-pager -n 0 >&2 || true
  docker exec "${container}" journalctl -u ms-probe --no-pager -n 40 -o short-precise >&2 || true
  failed=1
else
  echo "    stopped by the start limit after ${kills} kills (result: ${result})"
  stopped_at="$(date +%s)"
  if wait_active $((cooldown * 4)); then
    echo "    started again $(($(date +%s) - stopped_at)) s later, after a ${cooldown} s cool-down"
  else
    echo "    FAILED — still $(docker exec "${container}" systemctl is-active ms-probe 2>/dev/null || true) $((cooldown * 4)) s after the start limit stopped it" >&2
    docker exec "${container}" journalctl -u 'ms-recover*' --no-pager -n 20 >&2 || true
    failed=1
  fi
fi
# A configuration it refuses exits 78, which is not restarted and so never reaches the limit.
# Starting it again would refuse again, so it must stay down: that is a person's to fix.
docker exec "${container}" cp /etc/ms/probe.json /tmp/probe.json.good
docker exec "${container}" bash -c 'echo "{\"probe\": {\"spoolBatchMaxRows\": \"lots\"}}" > /etc/ms/probe.json'
docker exec "${container}" systemctl reset-failed ms-probe
docker exec "${container}" systemctl restart ms-probe 2>/dev/null || true
sleep $((cooldown * 2 + 5))
result="$(docker exec "${container}" systemctl show ms-probe -p Result --value)"
code="$(docker exec "${container}" systemctl show ms-probe -p ExecMainStatus --value)"
if is_active; then
  echo "    FAILED — a probe that refused its configuration was started again" >&2
  failed=1
elif [ "${result}" != exit-code ] || [ "${code}" != 78 ]; then
  echo "    FAILED — a refused configuration ended as result=${result} exit=${code}, not exit-code 78" >&2
  failed=1
elif docker exec "${container}" systemctl list-timers --all --no-legend 'ms-recover-*' | grep -q .; then
  echo "    FAILED — a retry was scheduled for a probe that refused its configuration" >&2
  failed=1
else
  echo "    refused its configuration (exit 78): still down $((cooldown * 2 + 5)) s later, nothing scheduled"
fi
docker exec "${container}" cp /tmp/probe.json.good /etc/ms/probe.json
docker exec "${container}" rm -rf /etc/systemd/system/ms-recover@.service.d
docker exec "${container}" systemctl daemon-reload
docker exec "${container}" systemctl reset-failed ms-probe
docker exec "${container}" systemctl start ms-probe
wait_active 30 || { echo "    FAILED — ms-probe did not start again on its own configuration" >&2; failed=1; }

# --- watching the core from outside (H-25) ----------------------------------------------------
#
# `administration.md`, "Watching the core from outside", set up the way an operator would. The
# blocks it says to paste are taken out of the document (`ms_doc_block`) and installed as they
# are written, so an edit to the runbook that breaks one breaks this. Two things differ from a
# real setup, and neither is in what is being tested: `mail` is a stub that writes down what it
# was given, because the box has no mail to send; and the check "from another machine" runs on
# this box against 127.0.0.1, which is the same request from somewhere less useful.
runbook="${repo_root}/docs/administration.md"
box_mail=/var/log/smoke-mail.log
core_up() { [ "$(docker exec "${container}" systemctl is-active ms-core 2>/dev/null || true)" = active ]; }
wait_core() {
  for _ in $(seq 1 "$1"); do core_up && return 0; sleep 1; done
  return 1
}
# The runbook's one block with LINE in it, into the box at DEST with MODE, through any sed
# expressions that follow.
runbook_to_box() {
  local line="$1" dest="$2" mode="$3"
  shift 3
  if ! ms_doc_block "${runbook}" "${line}" >"${logs}/block"; then
    echo "    FAILED — administration.md has no single block with '${line}'" >&2
    failed=1
    return 1
  fi
  [ "$#" -eq 0 ] || sed "$@" "${logs}/block" >"${logs}/block.edited"
  [ "$#" -eq 0 ] || mv "${logs}/block.edited" "${logs}/block"
  docker cp "${logs}/block" "${container}:${dest}"
  docker exec "${container}" chmod "${mode}" "${dest}"
}
# How many mails so far have TEXT in their command line or their message.
mails() {
  docker exec "${container}" sh -c 'cat "$1" 2>/dev/null | grep -c -F -- "$2" || true' _ \
    "${box_mail}" "$1"
}
docker cp "${repo_root}/scripts/smoke/mail-stub.sh" "${container}:/usr/local/bin/mail"
docker exec "${container}" chmod 755 /usr/local/bin/mail

echo "==> asserting the runbook's OnFailure= drop-in adds to the unit's, and runs when ms-core fails (H-25)"
docker exec "${container}" mkdir -p /etc/systemd/system/ms-core.service.d
if runbook_to_box '# /etc/systemd/system/ms-core-failed.service' \
     /etc/systemd/system/ms-core-failed.service 644 \
   && runbook_to_box 'OnFailure=ms-core-failed.service' \
     /etc/systemd/system/ms-core.service.d/h25-failed.conf 644; then
  docker exec "${container}" systemctl daemon-reload
  # Each name on its own: systemd lists them in its own order, not the order they were added in.
  named="$(docker exec "${container}" systemctl show ms-core -p OnFailure --value)"
  case " ${named} " in
    *" ms-recover@ms-core.service "*) ;;
    *) named="${named} (without ms-recover@ms-core.service)" ;;
  esac
  case " ${named} " in
    *" ms-core-failed.service "*) ;;
    *) named="${named} (without ms-core-failed.service)" ;;
  esac
  case "${named}" in
    *without*)
      echo "    FAILED — with the runbook's drop-in, ms-core names '${named}' in OnFailure=" >&2
      failed=1 ;;
    *) echo "    OnFailure=${named}" ;;
  esac
  # A configuration the core refuses ends the unit `failed` at once (exit 78, never restarted):
  # the quickest honest way there. The start limit gets there too, and is proved above.
  docker exec "${container}" cp -p /etc/ms/core.json /tmp/core.json.h25
  docker exec "${container}" bash -c 'echo "{\"api\": {\"port\": \"eighty-eighty\"}}" > /etc/ms/core.json'
  docker exec "${container}" systemctl restart ms-core 2>/dev/null || true
  box_host="$(docker exec "${container}" hostname)"
  for _ in $(seq 1 30); do
    [ "$(mails "ms-core has failed on ${box_host}")" -ge 1 ] && break
    sleep 1
  done
  if [ "$(mails "-s ms-core has failed on ${box_host} ops@example.com")" = 1 ] \
     && [ "$(mails 'Active: failed')" -ge 1 ]; then
    echo "    ms-core failed (exit 78): ms-core-failed.service mailed 'ms-core has failed on ${box_host}', with its status"
  else
    echo "    FAILED — ms-core-failed.service did not mail once with the failed unit's status:" >&2
    docker exec "${container}" cat "${box_mail}" >&2 2>/dev/null || true
    docker exec "${container}" journalctl -u ms-core-failed --no-pager -n 20 >&2 || true
    failed=1
  fi
  docker exec "${container}" cp -p /tmp/core.json.h25 /etc/ms/core.json
fi
docker exec "${container}" rm -rf /etc/systemd/system/ms-core.service.d \
  /etc/systemd/system/ms-core-failed.service
docker exec "${container}" systemctl daemon-reload
docker exec "${container}" systemctl reset-failed ms-core
docker exec "${container}" systemctl start ms-core || true
wait_core 60 || { echo "    FAILED — ms-core did not start again on its own configuration" >&2; failed=1; }

echo "==> asserting a core with heartbeat.url sends one after its first pass, and counts one that fails (H-25)"
# A receiver on the box, the core pointed at it with both intervals at their floor of ten seconds,
# and then the receiver taken away. The path stands in for the receiver's token, which the log
# must never carry.
hb_log=/var/log/smoke-heartbeats.log
hb_path=/ping/smoke-h25-receiver-token
docker cp "${repo_root}/scripts/smoke/heartbeat-receiver.mjs" "${container}:/tmp/heartbeat-receiver.mjs"
docker exec "${container}" systemd-run --quiet --unit=ms-smoke-heartbeat \
  "$(docker exec "${container}" bash -c 'command -v node')" /tmp/heartbeat-receiver.mjs 9109 "${hb_log}"
docker exec "${container}" cp -p /etc/ms/core.json /tmp/core.json.h25
docker exec "${container}" node -e '
  const fs = require("node:fs");
  const file = "/etc/ms/core.json";
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.heartbeat = { url: process.argv[1], intervalSeconds: 10 };
  cfg.housekeeping = { ...(cfg.housekeeping ?? {}), intervalSeconds: 10 };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "http://127.0.0.1:9109${hb_path}"
docker exec "${container}" systemctl restart ms-core || true
hb_first=''
for _ in $(seq 1 120); do
  hb_first="$(docker exec "${container}" head -1 "${hb_log}" 2>/dev/null || true)"
  [ -n "${hb_first}" ] && break
  sleep 1
done
hb_expected="GET ${hb_path} ms-core/$(docker exec "${container}" cat /opt/ms/VERSION)"
if [ "${hb_first}" = "${hb_expected}" ]; then
  echo "    the receiver was sent: ${hb_first}"
else
  echo "    FAILED — the receiver was sent '${hb_first:-nothing in 120 s}', not '${hb_expected}'" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 >&2 || true
  failed=1
fi
# Each read of the route is what failed since the read before it, so the counts are added up.
hb_failures() {
  ms_docker_curl "${container}" -sf "${api}/core-health" 2>/dev/null \
    | json '.channels.heartbeatFailures' 2>/dev/null || true
}
hb_read=''
for _ in $(seq 1 30); do
  hb_read="$(hb_failures)"
  case "${hb_read}" in [0-9]*) break ;; esac
  sleep 1
done
if [ "${hb_read}" = 0 ]; then
  echo "    GET /core-health: heartbeatFailures 0 while the receiver answers"
else
  echo "    FAILED — GET /core-health says heartbeatFailures '${hb_read}' while the receiver answers" >&2
  failed=1
fi
docker exec "${container}" systemctl stop ms-smoke-heartbeat
hb_counted=0
for _ in $(seq 1 20); do
  sleep 3
  hb_read="$(hb_failures)"
  case "${hb_read}" in [0-9]*) hb_counted=$((hb_counted + hb_read)) ;; esac
  [ "${hb_counted}" -ge 1 ] && break
done
if [ "${hb_counted}" -lt 1 ]; then
  echo "    FAILED — with the receiver gone, Core Health counted no heartbeat failure in 60 s" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 >&2 || true
  failed=1
elif ! matches 'heartbeat did not reach its receiver' docker exec "${container}" journalctl -u ms-core --no-pager; then
  echo "    FAILED — a heartbeat failure was counted with no warn line for it" >&2
  failed=1
elif matches "${hb_path}" docker exec "${container}" journalctl -u ms-core --no-pager; then
  echo "    FAILED — the core's journal carries the heartbeat URL's path, the receiver's token" >&2
  failed=1
else
  echo "    receiver stopped: heartbeatFailures ${hb_counted}, and a warn line that names no path"
fi
docker exec "${container}" cp -p /tmp/core.json.h25 /etc/ms/core.json
docker exec "${container}" systemctl restart ms-core || true
wait_core 60 || { echo "    FAILED — ms-core did not start again without the heartbeat" >&2; failed=1; }

echo "==> asserting the runbook's checks from another machine, against this core (H-25)"
# Steps 1-3 of the runbook: a token that can only read, in a header file only root can read, and
# the check — each of the two — with the URL made this core's.
check_url="http://127.0.0.1:8080/api/v1/core-health"
down_said='MonitoringSystem core is down'
back_said='MonitoringSystem core is back'
check_exit() {
  docker exec "${container}" "/usr/local/bin/$1" >/dev/null 2>&1 && echo 0 || echo "$?"
}
read_token="$(docker exec -e MS_TOKEN_NAME=core-check -e MS_TOKEN_SCOPE=read "${container}" \
  bash /tmp/api-token.sh 2>"${logs}/read-token.err" || true)"
if [ -z "${read_token}" ]; then
  echo "    FAILED — no read-scoped token for the check: $(cat "${logs}/read-token.err")" >&2
  failed=1
elif runbook_to_box '# Exits 0 only if the core answered 200 inside ten seconds.' \
       /usr/local/bin/ms-core-check 755 -e "s|^URL=.*|URL=${check_url}|" \
     && runbook_to_box '# Mails once when the core stops answering 200, and once when it answers again.' \
       /usr/local/bin/ms-core-check-once 755 -e "s|^URL=.*|URL=${check_url}|"; then
  docker exec "${container}" install -d -m 700 /etc/ms-core-check /var/lib/ms-core-check
  header() {
    docker exec "${container}" sh -c \
      'umask 077; printf "Authorization: Bearer %s\n" "$1" >/etc/ms-core-check/header' _ "$1"
  }
  header "${read_token}"
  check_said=''
  # Up: both pass, and nobody is told anything.
  check_said="${check_said}up $(check_exit ms-core-check) $(check_exit ms-core-check-once) $(mails "${down_said}");"
  # Down: the first tells you each time it runs, the second once.
  docker exec "${container}" systemctl stop ms-core
  check_said="${check_said} down $(check_exit ms-core-check) $(check_exit ms-core-check)"
  check_said="${check_said} $(mails "${down_said}") $(mails '(HTTP 000; 000 is no answer at all)')"
  check_said="${check_said} $(check_exit ms-core-check-once) $(check_exit ms-core-check-once)"
  check_said="${check_said} $(mails "${down_said}");"
  # Back: the second says so, once. Waited for with a request of its own, not with a check that
  # would mail every time it found the core still starting.
  docker exec "${container}" systemctl start ms-core || true
  for _ in $(seq 1 60); do
    [ "$(docker exec "${container}" curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      --header @/etc/ms-core-check/header "${check_url}" 2>/dev/null || true)" = 200 ] && break
    sleep 1
  done
  check_said="${check_said} back $(check_exit ms-core-check-once) $(mails "${back_said}")"
  check_said="${check_said} $(mails '(down since ') $(check_exit ms-core-check-once)"
  check_said="${check_said} $(mails "${back_said}") $(mails "${down_said}");"
  # A token the core does not know, as after a revocation: a 401, and said so.
  header 'mst_not-a-token-this-core-issued'
  check_said="${check_said} refused $(check_exit ms-core-check) $(mails '(HTTP 401; 000 is no answer at all)')"
  header "${read_token}"
  case "${check_said}" in
    "up 0 0 0; down 1 1 2 2 1 1 3; back 0 1 1 0 1 3; refused 1 1")
      echo "    up: both 0, no mail; down: ms-core-check mailed each run (2), the variant once;"
      echo "    back: the variant mailed once that it was back; a token it does not know: 401, mailed" ;;
    *)
      echo "    FAILED — the checks did not behave as the runbook says: ${check_said}" >&2
      docker exec "${container}" cat "${box_mail}" >&2 2>/dev/null || true
      failed=1 ;;
  esac
fi
wait_core 60 || { echo "    FAILED — ms-core did not start again after the checks" >&2; failed=1; }

echo "==> asserting a re-run starts a core whose password comes from MS_DATABASE__PASSWORD__FROM_FILE (H-30)"
# core.json's password empty on purpose, the real one in a file named by a drop-in, which only the
# unit's environment points at. `ms-setup` cannot see it either, which is why a first install
# is decided by whether core.json was just created and never by what its password says. This is not
# a first install, so it must start the core — and the core must come up on that password.
#
# **A root:ms-core 0640 file, not the `LoadCredentialEncrypted=` the unit's comments show**, and
# only because these boxes cannot run that: under Docker, systemd 252 and 255 leave a unit's
# credentials directory empty or missing, for `LoadCredential=` too and for root with no sandbox
# (measured 2026-10-04). The core reads the variable the same way whichever path it names.
docker exec "${container}" cp -p /etc/ms/core.json /tmp/core.json.with-password
docker exec "${container}" node -e '
  const fs = require("node:fs");
  const file = "/etc/ms/core.json";
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.database.password = "";
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
'
docker exec "${container}" bash -c \
  'install -m 0640 -o root -g ms-core /dev/null /etc/ms/db-password && printf %s monitoring > /etc/ms/db-password'
docker exec "${container}" mkdir -p /etc/systemd/system/ms-core.service.d
docker exec "${container}" bash -c 'printf "%s\n" "[Service]" \
  "Environment=MS_DATABASE__PASSWORD__FROM_FILE=/etc/ms/db-password" \
  > /etc/systemd/system/ms-core.service.d/h30-password-file.conf'
docker exec "${container}" systemctl daemon-reload
core_pid_before="$(docker exec "${container}" systemctl show ms-core -p MainPID --value)"
if docker exec "${container}" /opt/ms/libexec/ms-setup --components core,probe >"${logs}/credential.log" 2>&1; then
  state="$(docker exec "${container}" systemctl is-active ms-core 2>/dev/null || true)"
  core_pid_after="$(docker exec "${container}" systemctl show ms-core -p MainPID --value)"
  if [ "${state}" != active ]; then
    echo "    FAILED — ms-core is ${state} on the password file" >&2
    docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
    failed=1
  elif [ "${core_pid_after}" = "${core_pid_before}" ]; then
    echo "    FAILED — ms-setup did not restart the core (${core_pid_before})" >&2
    failed=1
  elif grep -q 'is new, so nothing was started' "${logs}/credential.log"; then
    echo "    FAILED — a re-run was taken for a first install" >&2
    failed=1
  elif ! matches '"password": ""' docker exec "${container}" cat /etc/ms/core.json; then
    echo "    FAILED — core.json's password was not empty, so this proved nothing" >&2
    failed=1
  else
    echo "    ms-setup exited 0; ms-core active on the password file (pid ${core_pid_before} -> ${core_pid_after}), core.json's password empty"
  fi
else
  echo "    FAILED — ms-setup refused with the password in a file:" >&2
  sed 's/^/      /' "${logs}/credential.log" >&2
  docker exec "${container}" journalctl -u ms-core --no-pager -n 30 || true
  failed=1
fi
docker exec "${container}" cp -p /tmp/core.json.with-password /etc/ms/core.json
docker exec "${container}" rm -rf /etc/systemd/system/ms-core.service.d /etc/ms/db-password
docker exec "${container}" systemctl daemon-reload
docker exec "${container}" systemctl reset-failed ms-core ms-probe
docker exec "${container}" systemctl restart ms-core

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

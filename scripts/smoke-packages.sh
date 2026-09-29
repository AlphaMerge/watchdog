#!/usr/bin/env bash
# Package smoke test (TASKS.md H-05): install the .deb on Debian and the .rpm on Rocky, upgrade
# each in place, and assert the things an upgrade is supposed to preserve.
#
#     ./scripts/smoke-packages.sh          # both
#     ./scripts/smoke-packages.sh deb      # one
#
# **The upgrade is the whole point.** A package that installs is easy; a package that upgrades
# without losing the configuration, without reissuing the CA, and without leaving the service
# stopped is where the two formats differ and where the mistakes are. rpm in particular installs
# the new version and *then* removes the old one, so a `%preun` written like a dpkg `prerm` stops
# a service that has already been restarted — and nothing reports it, because both scriptlets
# succeeded.
#
# Development/CI only.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/smoke-names.sh
. "${repo_root}/scripts/lib/smoke-names.sh"
# shellcheck source=scripts/lib/build-tree.sh
. "${repo_root}/scripts/lib/build-tree.sh"
# Word splitting is what turns the default "deb rpm" into two entries; arguments given on the
# command line are already separate.
if [ "$#" -gt 0 ]; then
  formats=("$@")
else
  formats=(deb rpm)
fi

# `grep -q` in a pipeline exits at the first match, the producer takes SIGPIPE and reports 141,
# and `pipefail` turns a successful match into a failed assertion. Same helper, same reason, as
# `smoke-install.sh`.
matches() {
  local pattern="$1"
  shift
  local output
  output="$("$@" 2>/dev/null || true)"
  printf '%s' "${output}" | grep -q -- "${pattern}"
}

fail() { echo "    FAIL: $*" >&2; exit 1; }

# The box this run has up, if any. **A failure has to take it down too** (`H-21`): `fail` exits
# from inside `one_format`, which removed its box only on the way out of a pass, so every failed
# assertion left a privileged systemd container running on the machine — the one CI shares with
# whoever is developing on it. `MS_SMOKE_KEEP=1` keeps it to look at, as in `smoke-install.sh`.
box=''
cleanup() {
  [ -n "${box}" ] || return 0
  if [ "${MS_SMOKE_KEEP:-0}" = "1" ]; then
    echo "==> kept ${box} (docker rm -f ${box} removes it)"
    return 0
  fi
  docker rm -f "${box}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Reuse a staged tree if one is already there. In CI `scripts/package.sh` has run in this job
# already, and rebuilding would be a second full build to produce identical bits — the same
# reason `smoke-install.sh` takes a tarball on the command line.
version="$(node -p "require('${repo_root}/package.json').version" 2>/dev/null \
  || sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "${repo_root}/package.json" | head -1)"
# What the installed build must say it is (`H-13`): this checkout, as it stands. Worked out on the
# host, as `smoke-install.sh` does it — `git` inside the toolchain container cannot reach a
# worktree's repository, whose `.git` names a path on the host (`H-11`). **Asked of a reused
# staged tree too**: one packaged from an older commit, tested as if it were this one, is the
# exact claim this check exists to refuse. Empty only where there is no repository to ask.
#
# **Fails closed** (`H-20`): a `git` that can see the repository and then errors is not a clean
# tree, and a tree edited while this script built it is refused rather than stamped.
build_commit=""
build_dirty=0
build_state=""
if git -C "${repo_root}" rev-parse --verify HEAD >/dev/null 2>&1; then
  build_state="$(ms_tree_state "${repo_root}")" || {
    echo "git cannot say whether this tree is clean, so no package can be compared with it" >&2
    exit 1
  }
  read -r build_commit build_dirty _ <<<"${build_state}"
fi
if [ -d "${repo_root}/build/ms-${version}" ] && [ "${MS_SMOKE_REBUILD:-0}" != "1" ]; then
  echo "==> using the staged tree already at build/ms-${version}"
else
  echo "==> building the release tree"
  # In the toolchain container unless told otherwise, for the reason `smoke-install.sh` gives: a
  # host npm can be present and wrong, and `command -v npm` cannot tell.
  if [ "${MS_SMOKE_HOST_NPM:-0}" = "1" ]; then
    MS_BUILD_COMMIT="${build_commit}" MS_BUILD_DIRTY="${build_dirty}" \
      "${repo_root}/scripts/package.sh" >/dev/null
  else
    "${repo_root}/scripts/dev.sh" \
      "MS_BUILD_COMMIT=${build_commit} MS_BUILD_DIRTY=${build_dirty} ./scripts/package.sh" >/dev/null
  fi
  if [ -n "${build_state}" ] && [ "$(ms_tree_state "${repo_root}" || true)" != "${build_state}" ]; then
    echo "the tree changed while it was being packaged, so the package is not what its stamp" \
      "says; run this again on a tree nobody is editing" >&2
    exit 1
  fi
fi

one_format() {
  local format="$1" image container pkg install_cmd upgrade_cmd remove_cmd query_cmd
  case "${format}" in
    deb)
      image=ms-smoke:bookworm
      container="$(ms_smoke_name deb)"
      docker build -q -t "${image}" -f "${repo_root}/scripts/smoke/Dockerfile" "${repo_root}/scripts/smoke" >/dev/null
      "${repo_root}/scripts/package-deb.sh" >/dev/null
      pkg="$(ls -t "${repo_root}"/release/ms_*.deb | head -1)"
      install_cmd='dpkg -i /pkg/PKG'
      upgrade_cmd='dpkg -i /pkg/PKG'
      remove_cmd='dpkg -P ms'
      query_cmd='dpkg -s ms'
      ;;
    rpm)
      image=ms-smoke:rocky
      container="$(ms_smoke_name rpm)"
      docker build -q -t "${image}" -f "${repo_root}/scripts/smoke/Dockerfile.rocky" "${repo_root}/scripts/smoke" >/dev/null
      "${repo_root}/scripts/package-rpm.sh" >/dev/null
      pkg="$(ls -t "${repo_root}"/release/ms-*.rpm | head -1)"
      install_cmd='rpm -i /pkg/PKG'
      # Re-installing the same version is how the upgrade path is exercised without cutting a
      # second release; rpm calls that a conflict unless told otherwise, dpkg does not.
      upgrade_cmd='rpm -U --force /pkg/PKG'
      remove_cmd='rpm -e ms'
      query_cmd='rpm -q ms'
      ;;
    *) echo "unknown format: ${format}" >&2; exit 2 ;;
  esac

  echo
  echo "======================================================================"
  echo "  ${format}: ${image}"
  echo "======================================================================"

  docker rm -f "${container}" >/dev/null 2>&1 || true
  box="${container}"

  # A real systemd, because the scriptlets enable and start units and a container without pid 1
  # would let a broken unit file pass. Same shape as `smoke-install.sh`.
  # The labels are two separate arguments by design, so this expansion must split.
  # shellcheck disable=SC2046
  docker run -d --name "${container}" \
    $(ms_smoke_labels) \
    --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock \
    -v "${repo_root}/release:/pkg:ro" \
    "${image}" >/dev/null

  # **`MS_SETUP_NO_START=1` for both**, and the reason is a division of labour rather than a
  # dodge: what a *package* is responsible for is files, users, PKI and scriptlets that behave
  # differently on an upgrade than on a removal. Whether the services then reach "active" is
  # `smoke-install.sh`, and since H-05 all three installers run the same `ms-setup` — so proving
  # it there proves it here. It also keeps the two boxes comparable: TimescaleDB ships no aarch64
  # RPMs for EL9, so a Rocky box with a working database cannot exist on an arm64 machine, and a
  # test that only ran on x86_64 would be a test that did not run.
  local in="docker exec -e MS_SETUP_NO_START=1 ${container}"
  # Wait for systemd rather than sleeping at it.
  for _ in $(seq 1 30); do
    ${in} systemctl is-system-running >/dev/null 2>&1 && break
    sleep 1
  done

  # Node comes with the image, from the official tarball — which is exactly the situation the
  # packages describe when they make it a recommendation rather than a hard dependency.
  ${in} node -v >/dev/null || fail "node is not on PATH in ${image}"

  echo "==> installing the package"
  ${in} bash -c "${install_cmd/PKG/$(basename "${pkg}")}" 2>&1 | sed 's/^/    /' | tail -6

  ${in} bash -c "${query_cmd}" >/dev/null 2>&1 || fail "the package is not registered as installed"
  echo "    package: registered"

  # --- what a fresh install must have produced --------------------------------------------
  echo "==> asserting the install did its work"
  ${in} test -f /etc/ms/core.json || fail "no /etc/ms/core.json"
  ${in} test -f /etc/ms/probe.json || fail "no /etc/ms/probe.json"
  ${in} test -f /etc/ms/tls/ca.crt || fail "no probe-channel CA"
  ${in} test -f /etc/ms/access-key || fail "no access key"
  ${in} id ms-core >/dev/null 2>&1 || fail "no ms-core service user"
  ${in} id ms-probe >/dev/null 2>&1 || fail "no ms-probe service user"
  echo "    configuration, PKI, access key and service users: present"

  # --- which build this is ------------------------------------------------------------------
  # **Provenance, asked of the launchers an operator runs** (`H-13`). The field test's first line
  # is "say which build you are testing", and the answer has to be what this package says, not
  # what a manifest beside it claims — so each service is asked through `/opt/ms/bin`, the way
  # the unit starts it. `--help` reads the stamp and nothing else, which is what lets these boxes
  # ask without a database. Compared with this checkout's commit, not merely checked for "a
  # commit": a package reporting somebody else's would satisfy that.
  echo "==> asserting the installed package says which build it is"
  local stamped short suffix expected core_says probe_says
  stamped="$(${in} cat /opt/ms/app/core/build.json 2>/dev/null | tr -d ' \n' || true)"
  matches '"profile":"v1"' printf '%s' "${stamped}" \
    || fail "the package is not the v1 candidate: ${stamped:-no build.json}"
  if [ -n "${build_commit}" ]; then
    local dirty_json=false
    [ "${build_dirty}" = "1" ] && dirty_json=true
    matches "\"commit\":\"${build_commit}\",\"dirty\":${dirty_json}" printf '%s' "${stamped}" \
      || fail "the package says '${stamped}', and this checkout is ${build_commit} (dirty: \
${dirty_json}) — a staged tree from another commit is rebuilt with MS_SMOKE_REBUILD=1"
  else
    echo "    (no repository to ask: compared with the package's own manifest only)"
  fi
  short="$(printf '%s' "${stamped}" | sed -n 's/.*"commit":"\([0-9a-f]\{12\}\).*/\1/p')"
  [ -n "${short}" ] || fail "the package names no commit: ${stamped}"
  suffix=""
  matches '"dirty":true' printf '%s' "${stamped}" && suffix=", with uncommitted changes"
  expected="${version} (v1 profile, commit ${short}${suffix})"
  core_says="$(${in} /opt/ms/bin/ms-core --help 2>&1 | head -1 || true)"
  # `ms-probe` prints its usage for an unfinished `config` verb, and exits 2 for it.
  probe_says="$(${in} /opt/ms/bin/ms-probe config 2>&1 | head -1 || true)"
  [ "${core_says}" = "ms-core ${expected}" ] \
    || fail "ms-core says '${core_says}', expected 'ms-core ${expected}'"
  [ "${probe_says}" = "ms-probe ${expected}" ] \
    || fail "ms-probe says '${probe_says}', expected 'ms-probe ${expected}'"
  echo "    ${core_says}"
  echo "    ${probe_says}"

  # The fonts a PDF report is drawn with (`E-06`, `E-12`). They are the files the core needs at
  # runtime that `tsc` does not produce, so they are the ones a packaging change can quietly drop —
  # and the symptom would be an installation that renders every format except the one somebody
  # scheduled, months later, at three in the morning. Without the second, the symptom is quieter
  # still: a Japanese sensor name written as `U+6771` instead of as itself.
  for font in DejaVuSans.ttf LICENSE-DejaVu.txt wqy-microhei.ttc COPYRIGHT-WenQuanYi.txt LICENSE-Apache-2.0.txt; do
    ${in} test -f "/opt/ms/app/core/assets/fonts/${font}" || fail "the report font file ${font} is missing"
  done
  echo "    report fonts and their licences: present"

  # Not asserted active: these boxes have no database, by the decision above. What a package
  # owns is that the unit is installed and enabled, which is what these two check.
  # In /usr/lib, as a package file, and not in /etc, where an operator's drop-ins go (`H-21`).
  ${in} test -f /usr/lib/systemd/system/ms-core.service || fail "ms-core.service was not installed"
  ${in} test ! -e /etc/systemd/system/ms-core.service \
    || fail "ms-core.service was written into /etc/systemd/system, where it overrides the package's"
  matches 'enabled' ${in} systemctl is-enabled ms-core.service || fail "ms-core.service is not enabled"
  matches 'enabled' ${in} systemctl is-enabled ms-probe.service || fail "ms-probe.service is not enabled"
  echo "    units: installed and enabled"

  # --- the upgrade ---------------------------------------------------------------------------
  echo "==> marking the installation, then upgrading over it"
  # A value only this installation has, in the file an upgrade must not touch.
  ${in} bash -c "node -e '
    const fs = require(\"node:fs\");
    const cfg = JSON.parse(fs.readFileSync(\"/etc/ms/core.json\", \"utf8\"));
    cfg.database.password = \"set-by-the-operator\";
    fs.writeFileSync(\"/etc/ms/core.json\", JSON.stringify(cfg, null, 2));
  '"
  local ca_before key_before
  ca_before="$(${in} sha256sum /etc/ms/tls/ca.crt | cut -d' ' -f1)"
  key_before="$(${in} sha256sum /etc/ms/access-key | cut -d' ' -f1)"

  # **What the operator did to the units, and what an earlier release left** (`H-21`). A drop-in
  # is the operator's and must survive; a unit an earlier release put in /etc, exactly as it
  # shipped it, must go, or it goes on overriding every unit the package installs after it.
  ${in} mkdir -p /etc/systemd/system/ms-probe.service.d
  ${in} bash -c 'printf "[Service]\nEnvironment=MS_H21_DROP_IN=kept\n" > /etc/systemd/system/ms-probe.service.d/h21.conf'
  docker cp "${repo_root}/scripts/smoke/legacy-units/ms-probe.service" \
    "${container}:/etc/systemd/system/ms-probe.service"
  ${in} systemctl daemon-reload

  # **A running service, so that the upgrade has something to stop.** The probe starts without a
  # core — it spools — which is what lets these database-less boxes run one. The package must stop
  # it before its files are unpacked: it used to keep running over the new tree until `postinst`,
  # and with MS_SETUP_NO_START nothing restarts it, so it stays stopped.
  ${in} systemctl start ms-probe.service || {
    ${in} journalctl -u ms-probe --no-pager -n 30 || true
    fail "ms-probe would not start before the upgrade"
  }

  ${in} bash -c "${upgrade_cmd/PKG/$(basename "${pkg}")}" 2>&1 | sed 's/^/    /' | tail -4

  ${in} bash -c "${query_cmd}" >/dev/null 2>&1 || fail "the package is gone after an upgrade"

  matches 'set-by-the-operator' ${in} cat /etc/ms/core.json \
    || fail "the upgrade overwrote /etc/ms/core.json"
  echo "    configuration: preserved through the upgrade"

  local ca_after key_after
  ca_after="$(${in} sha256sum /etc/ms/tls/ca.crt | cut -d' ' -f1)"
  key_after="$(${in} sha256sum /etc/ms/access-key | cut -d' ' -f1)"
  [ "${ca_before}" = "${ca_after}" ] || fail "the upgrade reissued the probe-channel CA"
  [ "${key_before}" = "${key_after}" ] || fail "the upgrade regenerated the access key"
  echo "    CA and access key: unchanged"

  # **The backup, and only for the file that already existed.** An upgrade takes a timestamped
  # copy before it touches anything, and leaves the release's own example as .json.new.
  local backups
  backups="$(${in} bash -c 'ls /etc/ms/core.json.*.bak 2>/dev/null | wc -l' | tr -d ' \r')"
  [ "${backups}" -ge 1 ] || fail "the upgrade took no backup of core.json"
  ${in} test -f /etc/ms/core.json.new || fail "the upgrade left no .json.new to diff against"
  echo "    backup: ${backups} timestamped copy(ies), and a .json.new beside it"

  matches '600' ${in} bash -c 'stat -c %a /etc/ms/core.json.*.bak | head -1' \
    || fail "a configuration backup is not 0600 — it holds the database password"
  echo "    backup permissions: 600"

  # **The units must still be enabled after an upgrade.** This is the rpm trap: %preun runs for
  # the old package *after* the new one is installed, so a scriptlet that disables unconditionally
  # leaves an upgraded host with nothing enabled and no error anywhere.
  matches 'enabled' ${in} systemctl is-enabled ms-core.service \
    || fail "ms-core.service is no longer enabled after the upgrade"
  matches 'enabled' ${in} systemctl is-enabled ms-probe.service \
    || fail "ms-probe.service is no longer enabled after the upgrade"
  echo "    units: still enabled after the upgrade"

  local probe_state fragment environment
  probe_state="$(${in} systemctl is-active ms-probe.service 2>/dev/null || true)"
  [ "${probe_state}" = "inactive" ] \
    || fail "ms-probe is ${probe_state} after the upgrade — it ran on while the files were replaced"
  echo "    ms-probe: stopped before the unpack, and left stopped (MS_SETUP_NO_START)"
  ${in} test ! -e /etc/systemd/system/ms-probe.service \
    || fail "the unit an earlier release left in /etc/systemd/system is still there"
  # Compared resolved: on a merged-/usr Debian systemd names /lib/systemd/system, which is the
  # same file through the /lib symlink, and RHEL names /usr/lib.
  fragment="$(${in} systemctl show ms-probe.service -p FragmentPath --value)"
  [ "$(${in} readlink -f "${fragment}")" = "$(${in} readlink -f /usr/lib/systemd/system/ms-probe.service)" ] \
    || fail "ms-probe runs from ${fragment}, not the package's unit"
  environment="$(${in} systemctl show ms-probe.service -p Environment --value)"
  case "${environment}" in
    *MS_H21_DROP_IN=kept*) ;;
    *) fail "the operator's drop-in did not survive the upgrade (Environment=${environment})" ;;
  esac
  echo "    units: the earlier release's is gone, and the operator's drop-in applies"

  # --- removal -------------------------------------------------------------------------------
  echo "==> asserting removal stops the services and keeps the data"
  ${in} bash -c "${remove_cmd}" >/dev/null 2>&1 || fail "could not remove the package"
  ${in} test ! -f /usr/lib/systemd/system/ms-core.service || fail "the unit file survived removal"
  ${in} test -f /etc/systemd/system/ms-probe.service.d/h21.conf \
    || fail "removal deleted the operator's drop-in"
  ${in} test ! -d /opt/ms/app || fail "/opt/ms/app survived removal"
  echo "    application and units: gone"

  # The data is deliberately left: the vault key is unrecoverable, so removing it as a side
  # effect of removing the application would destroy every stored credential with it.
  ${in} test -f /etc/ms/core.json || fail "removal deleted /etc/ms/core.json"
  ${in} test -f /etc/ms/tls/ca.crt || fail "removal deleted the probe-channel CA"
  ${in} test -d /var/lib/ms-core || fail "removal deleted /var/lib/ms-core"
  echo "    configuration, PKI and state: left in place, as documented"

  docker rm -f "${container}" >/dev/null 2>&1 || true
  box=''
  echo "==> ${format} passed"
}

for format in "${formats[@]}"; do
  one_format "${format}"
done

echo
echo "==> package smoke test passed"

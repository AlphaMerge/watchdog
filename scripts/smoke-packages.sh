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

# Reuse a staged tree if one is already there. In CI `scripts/package.sh` has run in this job
# already, and rebuilding would be a second full build to produce identical bits — the same
# reason `smoke-install.sh` takes a tarball on the command line.
version="$(node -p "require('${repo_root}/package.json').version" 2>/dev/null \
  || sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "${repo_root}/package.json" | head -1)"
if [ -d "${repo_root}/build/ms-${version}" ] && [ "${MS_SMOKE_REBUILD:-0}" != "1" ]; then
  echo "==> using the staged tree already at build/ms-${version}"
else
  echo "==> building the release tree"
  if [ "${MS_SMOKE_HOST_NPM:-0}" = "1" ] || command -v npm >/dev/null 2>&1; then
    "${repo_root}/scripts/package.sh" >/dev/null
  else
    "${repo_root}/scripts/dev.sh" "./scripts/package.sh" >/dev/null
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

  # The font a PDF report is drawn with (`E-06`). It is the one file the core needs at runtime
  # that `tsc` does not produce, so it is the one that a packaging change can quietly drop —
  # and the symptom would be an installation that renders every format except the one somebody
  # scheduled, months later, at three in the morning.
  ${in} test -f /opt/ms/app/core/assets/fonts/DejaVuSans.ttf || fail "the report font is missing"
  echo "    report font: present"

  # Not asserted active: these boxes have no database, by the decision above. What a package
  # owns is that the unit is installed and enabled, which is what these two check.
  ${in} test -f /etc/systemd/system/ms-core.service || fail "ms-core.service was not installed"
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

  # --- removal -------------------------------------------------------------------------------
  echo "==> asserting removal stops the services and keeps the data"
  ${in} bash -c "${remove_cmd}" >/dev/null 2>&1 || fail "could not remove the package"
  ${in} test ! -f /etc/systemd/system/ms-core.service || fail "the unit file survived removal"
  ${in} test ! -d /opt/ms/app || fail "/opt/ms/app survived removal"
  echo "    application and units: gone"

  # The data is deliberately left: the vault key is unrecoverable, so removing it as a side
  # effect of removing the application would destroy every stored credential with it.
  ${in} test -f /etc/ms/core.json || fail "removal deleted /etc/ms/core.json"
  ${in} test -f /etc/ms/tls/ca.crt || fail "removal deleted the probe-channel CA"
  ${in} test -d /var/lib/ms-core || fail "removal deleted /var/lib/ms-core"
  echo "    configuration, PKI and state: left in place, as documented"

  docker rm -f "${container}" >/dev/null 2>&1 || true
  echo "==> ${format} passed"
}

for format in "${formats[@]}"; do
  one_format "${format}"
done

echo
echo "==> package smoke test passed"

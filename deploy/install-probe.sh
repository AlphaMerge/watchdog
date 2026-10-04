#!/usr/bin/env bash
# MonitoringSystem remote probe installer for Linux (systemd) — TASKS.md R-07.
#
# Run from inside an unpacked probe-only tarball:
#
#     sudo ./install-probe.sh --enrolment web-dc2.enrol
#     sudo ./install-probe.sh --enrolment web-dc2.enrol --name web-dc2 --no-start
#
# The bundle comes from the core host:  sudo /opt/ms/bin/ms-enrol web-dc2 --out web-dc2.enrol
#
# **This is a separate installer from `install.sh`, not a flag on it.** `install.sh --probe-only`
# already existed, and it installs from the full release tarball — so putting a probe on a remote
# host meant shipping the core, the web UI and the core's dependencies to a machine that will
# never run them, and then trusting a flag not to start them. A probe host should receive a probe.
#
# Re-running upgrades in place, exactly as `install.sh` does and through the same two scripts
# (`H-21`): the new build is asked whether it can read /etc/ms/probe.json before the running probe
# is stopped, the release it replaces is kept at /opt/ms/previous, the configuration gets its
# timestamped .bak, and `ms-setup` does the rest. Configuration under /etc/ms is never
# overwritten, and an enrolment already on disk is kept unless a new bundle is given.
set -euo pipefail

PREFIX=/opt/ms
CONFDIR=/etc/ms
enrolment=''
display_name=''
start_service=1

die() { echo "error: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enrolment|--enrollment) enrolment="$2"; shift ;;
    --name)       display_name="$2"; shift ;;
    --no-start)   start_service=0 ;;
    --prefix)     PREFIX="$2"; shift ;;
    --confdir)    CONFDIR="$2"; shift ;;
    -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(cat "${here}/VERSION")"

[ "$(id -u)" -eq 0 ] || die "must run as root"

# This script runs as root and removes directories under $PREFIX. Refuse anything that could
# turn `rm -rf "${PREFIX}/bin"` into `rm -rf /bin`.
case "${PREFIX}" in
  /|'') die "refusing to install to '${PREFIX}'" ;;
  /*) : ;;
  *) die "--prefix must be an absolute path (got '${PREFIX}')" ;;
esac
command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)"
command -v node >/dev/null 2>&1 || die "Node.js is required on PATH"
# The ICMP sensors run the system `ping` (ADR-001 Decision 6); the packages depend on it (`H-31`).
command -v ping >/dev/null 2>&1 \
  || die "ping is required by the probe's ICMP sensors (Debian, Ubuntu: iputils-ping; RHEL: iputils)"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

[ -x "${here}/deploy/place-release.sh" ] || die "this does not look like an unpacked release (no deploy/place-release.sh)"

# **The enrolment is checked before anything is written.** A bundle that turns out to be
# unreadable halfway through would otherwise leave a half-installed service pointing at a CA that
# is not there, which starts, fails to connect, and reports a TLS error rather than the truth.
if [ -n "${enrolment}" ]; then
  [ -f "${enrolment}" ] || die "no such enrolment bundle: ${enrolment}"
  node -e '
    const { readFileSync } = require("node:fs");
    let bundle;
    try {
      bundle = JSON.parse(readFileSync(process.argv[1], "utf8"));
    } catch (error) {
      console.error(`the enrolment bundle is not readable JSON: ${error.message}`);
      process.exit(1);
    }
    const missing = [];
    if (bundle.bundleVersion !== 1) missing.push(`bundleVersion ${String(bundle.bundleVersion)} is not supported by this installer`);
    if (!bundle.core?.host) missing.push("core.host");
    if (!bundle.core?.port) missing.push("core.port");
    if (!bundle.accessKey) missing.push("accessKey");
    for (const field of ["ca", "cert", "key"]) {
      if (!bundle.tls?.[field]) missing.push(`tls.${field}`);
    }
    if (missing.length > 0) {
      console.error(`the enrolment bundle is incomplete: ${missing.join(", ")}`);
      process.exit(1);
    }
  ' "${enrolment}" || die "refusing to install with an unusable enrolment bundle"
  # Absolute, because setup reads it after placement and nothing guarantees the same directory.
  enrolment="$(cd "$(dirname "${enrolment}")" && pwd)/$(basename "${enrolment}")"
elif [ ! -f "${CONFDIR}/probe.json" ]; then
  die "no enrolment bundle given and no existing ${CONFDIR}/probe.json — run 'ms-enrol <name>' on the core host and pass the result with --enrolment"
fi

echo "==> installing MonitoringSystem probe ${version} to ${PREFIX}"

# --- application ---------------------------------------------------------------------------
place_args=(--from "${here}" --prefix "${PREFIX}" --confdir "${CONFDIR}" --components probe)
[ "${start_service}" -eq 1 ] || place_args+=(--no-start)
"${here}/deploy/place-release.sh" "${place_args[@]}"

# --- everything else -----------------------------------------------------------------------
#
# **The same `ms-setup` every other installer runs** (`H-05`), given the bundle. This installer
# used to do its own copy of that work and lost two parts of it on the way: the `config check`
# before the restart, and the .bak before a re-enrolment rewrote probe.json. The service user, the
# bundle's certificates, the configuration, the unit and the start are all setup's now.
setup_args=(--prefix "${PREFIX}" --confdir "${CONFDIR}" --components probe)
[ -z "${enrolment}" ] || setup_args+=(--enrolment "${enrolment}")
[ -z "${display_name}" ] || setup_args+=(--name "${display_name}")
[ "${start_service}" -eq 1 ] || setup_args+=(--no-start)
"${PREFIX}/libexec/ms-setup" "${setup_args[@]}"

core_host="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).core.host' "${CONFDIR}/probe.json")"

cat <<SUMMARY

MonitoringSystem probe ${version} installed.

  configuration   ${CONFDIR}/probe.json
  application     ${PREFIX}
  logs            journalctl -u ms-probe -f

This probe is connecting to ${core_host} and will wait there: a probe that has
reached the core is not yet a probe that may scan. Approve it by name on the
core's probes page, and delete the enrolment bundle from both machines.
SUMMARY

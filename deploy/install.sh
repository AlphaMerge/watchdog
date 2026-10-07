#!/usr/bin/env bash
# MonitoringSystem installer for Linux (systemd).
#
# Run from inside an unpacked release tarball:
#     sudo ./install.sh                 # install both services
#     sudo ./install.sh --probe-only    # remote probe host
#     sudo ./install.sh --no-start      # install but do not start
#
# Creates the service users, lays out /opt/ms, /etc/ms and /var/lib, installs the units and
# starts the services — except on a first installation of a core, whose core.json has no
# database password yet, which starts nothing and says what to set. Re-running upgrades in place:
# configuration under /etc/ms is never overwritten, the new build is asked whether it can read
# that configuration before anything running is stopped, and the release it replaces is kept.
#
# `--no-start` installs and leaves both services stopped — including ones that were running.
set -euo pipefail

PREFIX=/opt/ms
CONFDIR=/etc/ms
components=(core probe)
start_services=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe-only) components=(probe) ;;
    --core-only)  components=(core) ;;
    --no-start)   start_services=0 ;;
    --prefix)     PREFIX="$2"; shift ;;
    -h|--help)    sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(cat "${here}/VERSION")"

die() { echo "error: $*" >&2; exit 1; }

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
command -v openssl >/dev/null 2>&1 || die "openssl is required (used to issue the probe-channel certificates)"
# The ICMP sensors run the system `ping` (ADR-001 Decision 6), and the packages depend on it for
# the same reason (`H-31`). A host that runs no probe has no use for one.
case " ${components[*]} " in
  *" probe "*) command -v ping >/dev/null 2>&1 \
    || die "ping is required by the probe's ICMP sensors (Debian, Ubuntu: iputils-ping; RHEL: iputils)" ;;
esac
[ -x "${here}/deploy/place-release.sh" ] || die "this does not look like an unpacked release (no deploy/place-release.sh)"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

echo "==> installing MonitoringSystem ${version} to ${PREFIX}"

# Which services are up now, so that one this installer stops and `ms-setup` does not start — the
# probe under `--core-only` — is started again rather than left down by an upgrade of the other.
was_running=()
for svc in core probe; do
  case "$(systemctl is-active "ms-${svc}" 2>/dev/null || true)" in
    active|activating|reloading) was_running+=("${svc}") ;;
  esac
done

# --- application ---------------------------------------------------------------------------
#
# **Copied in beside the running release, checked, and only then swapped in** (`H-21`), by the
# script `install-probe.sh` uses too. This used to delete /opt/ms/app and copy the new one over
# it with both services running, and a configuration this build refuses is now refused before
# anything that is running has been touched.
place_args=(--from "${here}" --prefix "${PREFIX}" --confdir "${CONFDIR}"
            --components "$(IFS=,; echo "${components[*]}")")
[ "${start_services}" -eq 1 ] || place_args+=(--no-start)
"${here}/deploy/place-release.sh" "${place_args[@]}"

# --- everything that is not file placement --------------------------------------------------
#
# **The same script the `.deb` and the `.rpm` run** (`H-05`): the service users, the
# probe-channel PKI, the access key, the configuration that survives an upgrade, the units, and
# the `config check` that runs before anything is restarted. Three installers that each did this
# their own way would be three chances for the one nobody smoke-tests to be wrong.
#
# **And it says what it did with the services** (`H-35`), in one word in a file, because the
# summary below has to follow it: a first installation started nothing and needs a password, an
# upgrade restarted both, and `--no-start` left them as asked. The summary used to give the
# first-installation note to every run that had a core, an upgrade that had just restarted both
# included.
outcome_file="$(mktemp "${TMPDIR:-/tmp}/ms-setup-outcome.XXXXXX")"
trap 'rm -f "${outcome_file}"' EXIT
setup_args=(--prefix "${PREFIX}" --confdir "${CONFDIR}" --components "$(IFS=,; echo "${components[*]}")"
            --outcome "${outcome_file}")
[ "${start_services}" -eq 1 ] || setup_args+=(--no-start)
"${PREFIX}/libexec/ms-setup" "${setup_args[@]}"
outcome="$(cat "${outcome_file}")"

if [ "${start_services}" -eq 1 ]; then
  for svc in ${was_running[@]+"${was_running[@]}"}; do
    case " ${components[*]} " in *" ${svc} "*) continue ;; esac
    echo "==> starting ms-${svc} again"
    systemctl start "ms-${svc}.service"
  done
fi

services="${components[*]/#/ms-}"
case "${outcome}" in
  started)       said="${services}: started" ;;
  # Under `--no-start` too: core.json is new all the same, and has no password yet.
  first-install)
    if [ "${start_services}" -eq 1 ]; then
      said="${services}: not started, a first installation (below)"
    else
      said="${services}: not started (--no-start), and a first installation (below)"
    fi ;;
  not-started)   said="${services}: not started (--no-start)" ;;
  *)             said="as ms-setup said above" ;;
esac

cat <<SUMMARY

MonitoringSystem ${version} installed.

  configuration   ${CONFDIR}/{$(IFS=,; echo "${components[*]}")}.json
  application     ${PREFIX}
  services        ${said}
  logs            journalctl -u ms-core -u ms-probe -f
SUMMARY
# Only what this run left to do. On a first installation this is the one place that says the
# password is missing whatever stopped the start: `ms-setup` says it only for a start it declined.
case "${outcome}" in
  first-install) cat <<NEXT

This is a first installation, so nothing was started: ${CONFDIR}/core.json is new and has
no database password yet. Set the database connection in it, then
  systemctl reset-failed ${services}
  systemctl start ${services}
NEXT
    ;;
  not-started) cat <<NEXT

When this machine is meant to come up:
  systemctl reset-failed ${services}
  systemctl start ${services}
NEXT
    ;;
esac

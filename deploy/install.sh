#!/usr/bin/env bash
# MonitoringSystem installer for Linux (systemd).
#
# Run from inside an unpacked release tarball:
#     sudo ./install.sh                 # install both services
#     sudo ./install.sh --probe-only    # remote probe host
#     sudo ./install.sh --no-start      # install but do not start
#
# Creates the service users, lays out /opt/ms, /etc/ms and /var/lib, installs the units and
# starts the services. Re-running upgrades in place: configuration under /etc/ms is never
# overwritten.
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
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
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

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "${node_major}" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

echo "==> installing MonitoringSystem ${version} to ${PREFIX}"

# --- application ---------------------------------------------------------------------------
install -d -m 0755 "${PREFIX}"
rm -rf "${PREFIX:?}/app" "${PREFIX:?}/bin" "${PREFIX:?}/web"
cp -R "${here}/app" "${PREFIX}/app"
cp -R "${here}/bin" "${PREFIX}/bin"
chmod +x "${PREFIX}"/bin/*
# The web UI, served by ms-core from api.webRoot. Optional: a tarball built without it, or a
# deliberately headless install, simply leaves webRoot empty and no UI is served.
if [ -d "${here}/web" ]; then
  cp -R "${here}/web" "${PREFIX}/web"
fi
printf '%s\n' "${version}" > "${PREFIX}/VERSION"


# The example configuration, the units and the docs, where `ms-setup` expects to find them —
# the packages get these from dpkg/rpm, and the tarball puts them there itself so that setup
# reads one layout regardless of which installer ran.
install -d -m 0755 "${PREFIX}/etc" "${PREFIX}/deploy/systemd" "${PREFIX}/libexec"
cp "${here}"/etc/*.json "${PREFIX}/etc/"
cp "${here}"/deploy/systemd/*.service "${PREFIX}/deploy/systemd/"
if [ -d "${here}/../docs" ]; then
  rm -rf "${PREFIX:?}/docs"
  cp -R "${here}/../docs" "${PREFIX}/docs"
fi
install -m 0755 "${here}/deploy/setup.sh" "${PREFIX}/libexec/ms-setup"

# --- everything that is not file placement --------------------------------------------------
#
# **The same script the `.deb` and the `.rpm` run** (`H-05`): the service users, the
# probe-channel PKI, the access key, the configuration that survives an upgrade, and the
# `config check` that runs before anything is restarted. Three installers that each did this
# their own way would be three chances for the one nobody smoke-tests to be wrong.
setup_args=(--prefix "${PREFIX}" --confdir "${CONFDIR}" --components "$(IFS=,; echo "${components[*]}")")
[ "${start_services}" -eq 1 ] || setup_args+=(--no-start)
"${PREFIX}/libexec/ms-setup" "${setup_args[@]}"

cat <<SUMMARY

MonitoringSystem ${version} installed.

  configuration   ${CONFDIR}/{$(IFS=,; echo "${components[*]}")}.json
  application     ${PREFIX}
  logs            journalctl -u ms-core -u ms-probe -f

Next: set the database connection in ${CONFDIR}/core.json, then
  systemctl restart ms-core
SUMMARY

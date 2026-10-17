#!/usr/bin/env bash
# Removes a tarball installation, as `dpkg -P ms` and `rpm -e ms` remove a package (`H-39`).
#
#     sudo /opt/ms/libexec/ms-uninstall [--prefix /opt/ms]
#
# **What goes**: both services, stopped and disabled, with any retry `ms-recover` had scheduled;
# the release under the prefix and the one it replaced at `previous`; the units the setup put in
# /usr/lib/systemd/system; and the probe's ping drop-in in /etc/sysctl.d while it is still exactly
# as the setup wrote it — through the same text the packages carry, `remove-ping-conf.sh`, read from
# beside this script before anything is removed and run after the release has gone, which is when
# it can tell whether anything installed still needs the file.
#
# **What stays, as for a package**: /etc/ms, /var/lib/ms-*, the database, the service users and
# your drop-ins under /etc/systemd/system/ms-*.service.d. They hold the configuration, the
# credential-vault key and every reading ever taken, and the vault key cannot be recovered.
# Anything under the prefix that no release put there is yours, and stays too.
#
# **Not for a package.** A `.deb` or an `.rpm` is removed by its package manager, which knows its
# files and keeps its own records of them; this refuses an installation one of them owns.
set -euo pipefail

PREFIX=/opt/ms
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)  PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
# Runs as root and removes directories under $PREFIX, as the installer does: the same refusals.
case "${PREFIX}" in
  /|'') die "refusing to remove '${PREFIX}'" ;;
  /*) : ;;
  *) die "--prefix must be an absolute path (got '${PREFIX}')" ;;
esac
command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)"
# The variable exists for `deploy-scripts.test.ts`, as it does for ms-setup; nothing else sets it.
UNIT_DIR="${MS_SETUP_UNIT_DIR:-/usr/lib/systemd/system}"

[ -f "${PREFIX}/VERSION" ] || die "there is no installation at ${PREFIX} (no ${PREFIX}/VERSION)"
version="$(cat "${PREFIX}/VERSION")"

# Asked of the one file every installation has, by exit status: both tools print something on
# stdout for a file nobody owns as well.
if command -v dpkg-query >/dev/null 2>&1 \
  && owner="$(dpkg-query -S "${PREFIX}/libexec/ms-setup" 2>/dev/null)"; then
  owner="${owner%%:*}"
  die "${PREFIX} is the ${owner} package's; remove it with: dpkg -P ${owner}"
fi
if command -v rpm >/dev/null 2>&1 \
  && owner="$(rpm -qf --queryformat '%{NAME}\n' "${PREFIX}/libexec/ms-setup" 2>/dev/null)"; then
  die "${PREFIX} is the ${owner} package's; remove it with: rpm -e ${owner}"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "${here}/remove-ping-conf.sh" ] || die "no remove-ping-conf.sh beside ${BASH_SOURCE[0]}"
# In memory before the release goes: this script and that file are in it.
ping_fragment="$(cat "${here}/remove-ping-conf.sh")"

echo "==> stopping and disabling ms-core and ms-probe"
for svc in core probe; do
  # A retry scheduled by ms-recover (`H-23`) would otherwise start a unit that is gone.
  systemctl stop "ms-recover-ms-${svc}-retry.timer" >/dev/null 2>&1 || true
  systemctl stop "ms-${svc}.service" >/dev/null 2>&1 || true
  systemctl disable "ms-${svc}.service" >/dev/null 2>&1 || true
done

echo "==> removing ${version} from ${PREFIX}"
# Named rather than globbed, as place-release.sh names them, with the release it kept and the
# copy an interrupted install can leave.
for entry in app bin web docs etc deploy libexec VERSION previous .incoming; do
  rm -rf "${PREFIX:?}/${entry}"
done
if rmdir "${PREFIX}" 2>/dev/null; then
  :
elif [ -d "${PREFIX}" ]; then
  echo "    ${PREFIX} is kept: no release put what is left in it there"
fi

echo "==> removing the units from ${UNIT_DIR}"
rm -f "${UNIT_DIR}/ms-core.service" "${UNIT_DIR}/ms-probe.service" "${UNIT_DIR}/ms-recover@.service"
systemctl daemon-reload

# What a package's purge or erase runs, here after the release has gone, as there. It decides by
# itself, says what it did, and cannot fail.
sh -c "${ping_fragment}" || true

cat <<DONE

MonitoringSystem ${version} was removed from ${PREFIX}.

Left in place, as they hold the configuration, the credential-vault key and the data:
  /etc/ms, /var/lib/ms-core, /var/lib/ms-probe, the database, the ms-core and ms-probe
  service users, and any drop-ins under /etc/systemd/system/ms-*.service.d.
DONE

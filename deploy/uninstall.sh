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
# files and keeps its own records of them; this refuses while either package is installed.
set -euo pipefail

PREFIX=/opt/ms
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)  PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
# **One spelling of the prefix** (`H-39` review): `/opt/ms/` and `/opt//ms` are /opt/ms, and so is
# a link to it, so that every check below is asked of the directory that would be removed.
PREFIX="$(printf '%s' "${PREFIX}" | tr -s /)"
[ "${PREFIX}" = / ] || PREFIX="${PREFIX%/}"
# Runs as root and removes directories under $PREFIX, as the installer does: the same refusals,
# before and after the link is followed.
case "${PREFIX}" in
  /|'') die "refusing to remove '${PREFIX}'" ;;
  /*) : ;;
  *) die "--prefix must be an absolute path (got '${PREFIX}')" ;;
esac
if [ -e "${PREFIX}" ] && command -v readlink >/dev/null 2>&1; then
  PREFIX="$(readlink -f -- "${PREFIX}" 2>/dev/null || printf '%s' "${PREFIX}")"
  [ "${PREFIX}" != / ] || die "refusing to remove '/'"
fi
command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)"
# The variables exist for `deploy-scripts.test.ts`, as they do for ms-setup; nothing else sets them.
UNIT_DIR="${MS_SETUP_UNIT_DIR:-/usr/lib/systemd/system}"
LEGACY_UNIT_DIR="${MS_SETUP_LEGACY_UNIT_DIR:-/etc/systemd/system}"

# **By package name, not by path** (`H-39` review). A path as spelled could miss — this asked dpkg
# about `/opt/ms//libexec/ms-setup` for `--prefix /opt/ms/`, was told nobody owns it, and went on
# to stop the package's services and delete its unit files. Either package installed, at any
# prefix, owns the units this removes; one removed and not purged (`rc`) owns nothing here.
if command -v dpkg-query >/dev/null 2>&1; then
  for pkg in ms ms-probe; do
    # shellcheck disable=SC2016 # dpkg-query's own field syntax, for dpkg-query to expand
    status="$(dpkg-query -W -f='${db:Status-Status}' "${pkg}" 2>/dev/null || true)"
    case "${status}" in
      ''|not-installed|config-files) ;;
      *) die "the ${pkg} package is installed (${status}), and its files are its package manager's; remove it with: dpkg -P ${pkg}" ;;
    esac
  done
fi
if command -v rpm >/dev/null 2>&1; then
  for pkg in ms ms-probe; do
    if rpm -q --quiet "${pkg}" 2>/dev/null; then
      die "the ${pkg} package is installed, and its files are its package manager's; remove it with: rpm -e ${pkg}"
    fi
  done
fi

[ -f "${PREFIX}/VERSION" ] || die "there is no installation at ${PREFIX} (no ${PREFIX}/VERSION)"
version="$(cat "${PREFIX}/VERSION")"

# **Only a prefix a release filled** (`H-39` review). Below, `app bin web docs etc deploy libexec`
# and `previous` go whole. A VERSION alone does not make a prefix ours: an installer that failed
# part-way into /usr/local leaves one there, beside /usr/local/bin and /usr/local/etc, and an
# installer before this release moved what was there into `previous`. So every installation has
# libexec/ms-setup, and what a release puts in bin, libexec, etc and deploy has the names below —
# in the release and in the one kept at `previous` — or nothing is removed at all. The lists are
# `place-release.sh`'s, which says why they only grow.
[ -f "${PREFIX}/libexec/ms-setup" ] \
  || die "${PREFIX} has no libexec/ms-setup, which every installation has, so nothing was removed"
RELEASE_BIN='ms-backup ms-core ms-enrol ms-probe ms-recover ms-restore'
RELEASE_LIBEXEC='ms-setup ms-uninstall remove-ping-conf.sh'
RELEASE_ETC='core.json probe.json'
RELEASE_DEPLOY='systemd'
# The first entry of DIR whose name is not among the ALLOWED, or nothing.
foreign_in() {
  local dir="$1" allowed=" $2 " path
  [ -d "${dir}" ] || return 0
  for path in "${dir}"/* "${dir}"/.[!.]*; do
    [ -e "${path}" ] || [ -L "${path}" ] || continue
    case "${allowed}" in
      *" ${path##*/} "*) ;;
      *) printf '%s\n' "${path}"; return 0 ;;
    esac
  done
  return 0
}
for under in '' previous/; do
  for sub in bin libexec etc deploy; do
    case "${sub}" in
      bin) allowed="${RELEASE_BIN}" ;;
      libexec) allowed="${RELEASE_LIBEXEC}" ;;
      etc) allowed="${RELEASE_ETC}" ;;
      deploy) allowed="${RELEASE_DEPLOY}" ;;
    esac
    foreign="$(foreign_in "${PREFIX}/${under}${sub}" "${allowed}")"
    [ -z "${foreign}" ] \
      || die "${foreign} is not something a release puts there, so ${PREFIX} is not only a MonitoringSystem installation; nothing was removed"
  done
done

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
# Neither this nor the fragment may stop the removal short of its summary: the files are gone.
systemctl daemon-reload || true

# What a package's purge or erase runs, here after the release has gone, as there. It decides by
# itself, says what it did, and cannot fail.
sh -c "${ping_fragment}" || true

# **A unit an earlier release left in /etc, edited, is the operator's** (`H-39` review): `ms-setup`
# keeps such a file where it is and says so (`H-21`), and it overrides the unit just removed whole,
# so systemd still knows the service by it. It is named, not removed.
kept=''
for svc in core probe; do
  if [ -f "${LEGACY_UNIT_DIR}/ms-${svc}.service" ] && [ ! -L "${LEGACY_UNIT_DIR}/ms-${svc}.service" ]; then
    kept="${kept}  ${LEGACY_UNIT_DIR}/ms-${svc}.service, an edited unit from an earlier release
    that ms-setup kept: remove it yourself, then 'systemctl daemon-reload'.
"
  fi
done

cat <<DONE

MonitoringSystem ${version} was removed from ${PREFIX}.

Left in place, as they hold the configuration, the credential-vault key and the data:
  /etc/ms, /var/lib/ms-core, /var/lib/ms-probe, the database, the ms-core and ms-probe
  service users, and any drop-ins under /etc/systemd/system/ms-*.service.d.
DONE
if [ -n "${kept}" ]; then
  printf '\nLeft in place, as yours:\n%s' "${kept}"
fi

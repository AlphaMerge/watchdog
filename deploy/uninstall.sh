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
# Anything under the prefix that no release put there is yours: it stays, and is named.
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
# The prefix as given, for a link (`H-39`'s second review): the link and the directory it leads
# to are both kept, so that the next install through the link finds a directory there.
given="${PREFIX}"
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
# prefix, owns the units this removes; one removed and not purged (`rc`) owns nothing here. **A
# database that cannot be read answers nothing** (`H-39`'s second review): dpkg-query exits 2
# rather than 1, and rpm says something other than its "not installed", and either refuses.
if command -v dpkg-query >/dev/null 2>&1; then
  for pkg in ms ms-probe; do
    rc=0
    # shellcheck disable=SC2016 # dpkg-query's own field syntax, for dpkg-query to expand
    status="$(dpkg-query -W -f='${db:Status-Status}' "${pkg}" 2>/dev/null)" || rc=$?
    [ "${rc}" -le 1 ] \
      || die "could not read the dpkg database (dpkg-query exited ${rc}), so whether the ${pkg} package is installed is not known; repair it (dpkg --audit) and run this again. Nothing was removed"
    case "${status}" in
      ''|not-installed|config-files) ;;
      *) die "the ${pkg} package is installed (${status}), and its files are its package manager's; remove it with: dpkg -P ${pkg}" ;;
    esac
  done
fi
if command -v rpm >/dev/null 2>&1; then
  for pkg in ms ms-probe; do
    if said="$(LC_ALL=C rpm -q "${pkg}" 2>&1)"; then
      die "the ${pkg} package is installed, and its files are its package manager's; remove it with: rpm -e ${pkg}"
    fi
    # **rpm's answer is its last line** (`H-39`'s round-2 check). It can warn before it — of a
    # database in its old format, on an EL9 host that was upgraded — and still have read it; an
    # `error:` anywhere is a database it could not read.
    case "${said}" in
      *error:*) die "could not ask rpm whether the ${pkg} package is installed (${said}); nothing was removed" ;;
    esac
    [ "$(printf '%s\n' "${said}" | tail -n 1)" = "package ${pkg} is not installed" ] \
      || die "could not ask rpm whether the ${pkg} package is installed (${said}); nothing was removed"
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
#
# **Or what a run of this script stopped in libexec left** (`H-39`'s round-2 check): VERSION and
# part of libexec, every tree gone. It removes libexec before VERSION, so nothing else leaves
# that, and a run finishes it.
if [ ! -f "${PREFIX}/libexec/ms-setup" ]; then
  trees=''
  for entry in app bin web docs etc deploy previous; do
    if [ -e "${PREFIX}/${entry}" ] || [ -L "${PREFIX}/${entry}" ]; then trees=1; fi
  done
  { [ -d "${PREFIX}/libexec" ] && [ -z "${trees}" ]; } \
    || die "${PREFIX} has no libexec/ms-setup, which every installation has, so nothing was removed"
fi
# **An `app` with a release's build stamp** (`H-39`'s second review): every release's `app` holds
# a `<component>/build.json` (`package.sh`, since rc.1), and an operator's `app` does not.
if [ -e "${PREFIX}/app" ]; then
  stamped=''
  for build in "${PREFIX}"/app/*/build.json; do
    if [ -f "${build}" ]; then stamped=1; fi
  done
  [ -n "${stamped}" ] \
    || die "${PREFIX}/app has no <component>/build.json, which every release's has, so it is not a release's; nothing was removed"
fi
RELEASE_BIN='ms-backup ms-core ms-enrol ms-probe ms-recover ms-restore'
RELEASE_LIBEXEC='ms-setup ms-uninstall remove-ping-conf.sh'
RELEASE_ETC='core.json probe.json'
RELEASE_DEPLOY='systemd'
# The first entry of DIR whose name is not among the ALLOWED, or nothing. The three patterns are
# every name there is: `..keep` matches neither of the first two (`H-39`'s second review).
foreign_in() {
  local dir="$1" allowed=" $2 " path
  [ -d "${dir}" ] || return 0
  for path in "${dir}"/* "${dir}"/.[!.]* "${dir}"/..?*; do
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
# These two name `rm -rf`, so they come once the prefix is known to hold only a release's
# (`H-39`'s round-2 check), never a directory with the operator's files in it.
#
# **Not a release kept inside an installation** (`H-39`'s second review): the one at `previous`,
# or the one installation.md's going back sets aside at `rolled-back`, has a VERSION, a
# libexec/ms-setup and a release's names, and the services and units below are the installation's
# around it.
parent="${PREFIX%/*}"
while [ -n "${parent}" ]; do
  [ ! -f "${parent}/libexec/ms-setup" ] \
    || die "${PREFIX} is inside the installation at ${parent}, whose services and units this would stop and remove; a release kept there is removed with: rm -rf ${PREFIX}. Nothing was removed"
  parent="${parent%/*}"
done
# **Nor one the units do not run from**, where that can be told: a unit whose ExecStart= is
# another installation's launcher is that installation's. The units name /opt/ms whatever the
# prefix, so one that names a directory with no installation in it says nothing, and one that
# names a link to this prefix names this prefix.
for svc in core probe; do
  unit="${UNIT_DIR}/ms-${svc}.service"
  [ -f "${unit}" ] || continue
  runs="$(sed -n '/^ExecStart=/{s/^ExecStart=[-@+!:]*//;s/[[:space:]].*//;p;q;}' "${unit}")"
  case "${runs}" in */bin/*) ;; *) continue ;; esac
  home="${runs%/bin/*}"
  [ -f "${home}/libexec/ms-setup" ] || continue
  [ "$(readlink -f -- "${home}" 2>/dev/null || printf '%s' "${home}")" != "${PREFIX}" ] || continue
  die "${unit} runs ${runs}, which is the installation at ${home}, not ${PREFIX}; nothing was removed; a copy is removed with: rm -rf ${PREFIX}"
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

# **In an order a run stopped part-way leaves for the next one to finish** (`H-39`'s second
# review): an SSH session dropped in the middle of `previous`, a file `chattr +i` keeps. The
# units go first, so that none is left naming a launcher that has gone. The trees are each renamed
# into `.incoming` — the name both scripts know for a copy that is not a release — and removed
# from there: a rename is all or nothing, and `rm` can take `app`'s build stamp, which the check
# above asks for, among its first files. VERSION and libexec/ms-setup, which a run needs to know
# an installation, go last. Named rather than globbed, as place-release.sh names them, with the
# release it kept.
echo "==> removing the units from ${UNIT_DIR}"
rm -f "${UNIT_DIR}/ms-core.service" "${UNIT_DIR}/ms-probe.service" "${UNIT_DIR}/ms-recover@.service"
# Neither this nor the fragment may stop the removal short of its summary: the files are gone.
systemctl daemon-reload || true

echo "==> removing ${version} from ${PREFIX}"
rm -rf "${PREFIX:?}/.incoming"
mkdir -m 0700 "${PREFIX}/.incoming"
for entry in previous app bin web docs etc deploy; do
  if [ -e "${PREFIX}/${entry}" ] || [ -L "${PREFIX}/${entry}" ]; then
    mv "${PREFIX}/${entry}" "${PREFIX}/.incoming/${entry}"
  fi
done
rm -rf "${PREFIX:?}/.incoming"
# Two commands: `rm` goes on to the next name after one it cannot remove, and a libexec that kept
# a file must keep VERSION too, or no run of this script would take the prefix for one to finish.
rm -rf "${PREFIX:?}/libexec"
rm -f "${PREFIX:?}/VERSION"
# What is left in the prefix is the operator's, and each is named.
left_in_prefix() {
  local left
  for left in "${PREFIX}"/* "${PREFIX}"/.[!.]* "${PREFIX}"/..?*; do
    if [ -e "${left}" ] || [ -L "${left}" ]; then echo "      ${left}"; fi
  done
}
if [ -L "${given}" ]; then
  echo "    ${given} is a link to ${PREFIX}, and both are kept, for the next install or for you to remove"
  left="$(left_in_prefix)"
  [ -z "${left}" ] || printf '    with what no release put there:\n%s\n' "${left}"
elif rmdir "${PREFIX}" 2>/dev/null; then
  :
elif [ -d "${PREFIX}" ]; then
  echo "    ${PREFIX} is kept: no release put what is left in it there:"
  left_in_prefix
fi

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

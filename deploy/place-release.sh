#!/usr/bin/env bash
# Put an unpacked release under the prefix, and never run a service on a half-replaced tree
# (TASKS.md H-21).
#
#     place-release.sh --from DIR [--prefix /opt/ms] [--confdir /etc/ms]
#                      [--components core,probe] [--no-start]
#
# Run by `install.sh` and `install-probe.sh` from inside the unpacked tarball, before `ms-setup`.
# The .deb and the .rpm have a package manager to place their files, and stop the services before
# it starts (their `preinst` and `%pre`), so they do not come through here.
#
# **The order is the whole point**, and it is the reverse of what the installers did before:
#
#   1. Copy the release in beside the running one, under ${PREFIX}/.incoming. A copy that fails
#      part-way — a full disk — fails here, and nothing that is running has been touched.
#   2. Ask the *new* build whether it can read the configuration on disk, with the new launcher,
#      while the old services are still running on the old tree. A refusal removes the copy and
#      leaves the installation exactly as it was, so "the old version is still running" is true.
#      A pass goes ahead and says nothing here, warnings or none: `ms-setup` asks again once the
#      release is in, and is the one place that shows them (`H-27`).
#   3. Stop the services, move the release in — renames, not copies, so the window is short and
#      cannot fail half-way for want of space — and keep the one it replaces at
#      ${PREFIX}/previous, which is what a rollback starts from.
#
# `ms-setup` then does everything else and starts the services again.
#
# The installers used to `rm -rf` the live tree and copy the new one over it while both services
# ran. Every process-isolated check and every first use of a lazily loaded module in that window
# failed as a real scan failure — a Down and an alarm for a device nobody touched — and a copy
# that died part-way left no previous version at all.
set -euo pipefail

FROM=''
PREFIX=/opt/ms
CONFDIR=/etc/ms
components=(core probe)
start_services=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from)       FROM="$2"; shift ;;
    --prefix)     PREFIX="$2"; shift ;;
    --confdir)    CONFDIR="$2"; shift ;;
    --components) IFS=',' read -r -a components <<< "$2"; shift ;;
    --no-start)   start_services=0 ;;
    -h|--help)    sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

[ -n "${FROM}" ] && [ -f "${FROM}/VERSION" ] || die "--from must name an unpacked release"
# Runs as root and removes directories under $PREFIX. Refuse anything that could turn
# `rm -rf "${PREFIX}/previous"` into something else.
case "${PREFIX}" in
  /|'') die "refusing to install to '${PREFIX}'" ;;
  /*) : ;;
  *) die "--prefix must be an absolute path (got '${PREFIX}')" ;;
esac

version="$(cat "${FROM}/VERSION")"
installed=''
[ -f "${PREFIX}/VERSION" ] && installed="$(cat "${PREFIX}/VERSION")"

# What the prefix holds that belongs to a release. Named rather than globbed: anything else an
# operator keeps under /opt/ms is left where it is.
RELEASE_ENTRIES=(app bin web docs etc deploy libexec VERSION)

# --- 1. copy -----------------------------------------------------------------------------------
incoming="${PREFIX}/.incoming"
install -d -m 0755 "${PREFIX}"
rm -rf "${incoming}"
trap 'rm -rf "${incoming}"' EXIT
mkdir -m 0755 "${incoming}"

echo "==> copying ${version} into place beside what is running"
cp -R "${FROM}/app" "${incoming}/app"
cp -R "${FROM}/bin" "${incoming}/bin"
chmod +x "${incoming}"/bin/*
# The web UI, served by ms-core from api.webRoot. Optional: a tarball built without it, or a
# probe-only one, has none.
[ -d "${FROM}/web" ] && cp -R "${FROM}/web" "${incoming}/web"
# The release's own documentation, which is what the units' `Documentation=` points at. Never
# `../docs`: that is whatever happens to sit beside wherever the tarball was unpacked.
[ -d "${FROM}/docs" ] && cp -R "${FROM}/docs" "${incoming}/docs"
# The example configuration, the units and the setup script, where `ms-setup` expects them — the
# packages get these from dpkg/rpm, so setup reads one layout whichever installer ran.
install -d -m 0755 "${incoming}/etc" "${incoming}/deploy/systemd" "${incoming}/libexec"
cp "${FROM}"/etc/*.json "${incoming}/etc/"
cp "${FROM}"/deploy/systemd/*.service "${incoming}/deploy/systemd/"
install -m 0755 "${FROM}/deploy/setup.sh" "${incoming}/libexec/ms-setup"
# How a tarball installation is removed (`H-39`), which a package leaves to its package manager,
# with the fragment a package's purge runs for the probe's ping drop-in beside it, where the
# uninstaller reads it.
install -m 0755 "${FROM}/deploy/uninstall.sh" "${incoming}/libexec/ms-uninstall"
install -m 0644 "${FROM}/deploy/remove-ping-conf.sh" "${incoming}/libexec/remove-ping-conf.sh"
printf '%s\n' "${version}" > "${incoming}/VERSION"

# --- 2. ask the new build ------------------------------------------------------------------
#
# The same question `ms-setup` asks, asked here while the answer can still leave everything as it
# was. `--no-start` skips it, as setup does: that mode is for a machine being staged, whose
# configuration is not necessarily the one on disk yet.
if [ "${start_services}" -eq 1 ]; then
  config_bad=0
  for svc in "${components[@]}"; do
    [ -f "${CONFDIR}/${svc}.json" ] || continue
    [ -x "${incoming}/bin/ms-${svc}" ] || continue
    # **A pass is kept to itself, warnings and all** (`H-27`). A check that passes can still warn
    # (`B-08`), and somebody upgrading has to be shown it — once. `ms-setup` runs after this for
    # every tarball install and is all a package runs, so it is the one place that prints a
    # passing check's warnings; printed here as well (`H-26`), a tarball upgrade showed each one
    # twice. Only a refusal is this script's to report, because only here can it still leave
    # everything as it was.
    if ! out="$("${incoming}/bin/ms-${svc}" config check --config "${CONFDIR}/${svc}.json" 2>&1)"; then
      echo "==> ${CONFDIR}/${svc}.json is not valid for ${version}:" >&2
      printf '%s\n' "${out}" | sed 's/^/    /' >&2
      config_bad=1
    fi
  done
  if [ "${config_bad}" -ne 0 ]; then
    {
      echo
      if [ -n "${installed}" ]; then
        echo "Nothing was changed: ${installed} is still what is installed in ${PREFIX}, and every"
        echo "service is as it was:"
        echo
        for svc in core probe; do
          printf '    ms-%-7s %s\n' "${svc}" "$(systemctl is-active "ms-${svc}" 2>/dev/null || true)"
        done
      else
        echo "Nothing was installed."
      fi
      echo
      echo "Fix the configuration and run the installer again. The example this release ships is"
      echo "at ${FROM}/etc/, for the diff."
    } >&2
    exit 1
  fi
fi

# --- 3. stop, swap -------------------------------------------------------------------------
#
# Both services when a release is already here, whichever components are being installed: they
# run from one tree, so `--core-only` replaces the probe's code as much as the core's. The
# installer starts again whatever it stopped.
if [ -n "${installed}" ]; then
  for svc in probe core; do
    case "$(systemctl is-active "ms-${svc}" 2>/dev/null || true)" in
      inactive|failed|'') continue ;;
    esac
    echo "==> stopping ms-${svc} (${installed})"
    systemctl stop "ms-${svc}.service" \
      || die "ms-${svc} did not stop, so nothing was replaced; ${installed} is still installed"
  done
fi

echo "==> moving ${version} into ${PREFIX}"
if [ -n "${installed}" ] || [ -d "${PREFIX}/app" ]; then
  rm -rf "${PREFIX}/previous"
  mkdir -m 0755 "${PREFIX}/previous"
  for entry in "${RELEASE_ENTRIES[@]}"; do
    if [ -e "${PREFIX}/${entry}" ]; then mv "${PREFIX}/${entry}" "${PREFIX}/previous/${entry}"; fi
  done
fi
for entry in "${RELEASE_ENTRIES[@]}"; do
  if [ -e "${incoming}/${entry}" ]; then mv "${incoming}/${entry}" "${PREFIX}/${entry}"; fi
done
rmdir "${incoming}"
trap - EXIT
[ -z "${installed}" ] || echo "    ${installed} is kept at ${PREFIX}/previous"

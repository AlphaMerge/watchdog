#!/usr/bin/env bash
# Build a .deb from the staged release tree (TASKS.md H-05).
#
#     ./scripts/package-deb.sh                  # ms_<version>_<arch>.deb
#     ./scripts/package-deb.sh --probe-only     # ms-probe_<version>_<arch>.deb
#     ./scripts/package-deb.sh --stage DIR      # package a tree already staged
#
# **This packages what `package.sh` staged; it does not build a second time.** The .deb, the .rpm
# and the tarball are then the same bits by construction rather than by two build scripts being
# kept in step — which is the failure nobody notices until a package behaves differently from the
# tarball it was supposed to mirror.
#
# **The configuration is not in the package**, deliberately. `/etc/ms/*.json` is created by
# `ms-setup` on first install and never overwritten afterwards, so shipping it as a dpkg conffile
# would put dpkg's three-way merge prompt in front of an operator for a file the installer
# already knows how to leave alone. The rule "configuration survives an upgrade" lives in one
# script, and this package runs that script.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

probe_only=0
stage=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe-only) probe_only=1 ;;
    --stage)      stage="$2"; shift ;;
    -h|--help)    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# dpkg-deb lives on Debian, and this is developed on macOS. Re-exec in a container rather than
# making the whole thing unusable off a Debian box — the same bargain `scripts/dev.sh` makes.
if ! command -v dpkg-deb >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then
    echo "==> no dpkg-deb here; building in debian:bookworm"
    forward=()
    [ "${probe_only}" -eq 1 ] && forward+=(--probe-only)
    [ -n "${stage}" ] && forward+=(--stage "${stage}")
    # `${a[@]+"${a[@]}"}` rather than `"${a[@]}"`: under `set -u`, bash 3.2 — which is what
    # macOS ships, and this re-exec exists for macOS — treats an empty array as unbound.
    exec docker run --rm -v "${repo_root}:/workspace" -w /workspace debian:bookworm \
      bash scripts/package-deb.sh ${forward[@]+"${forward[@]}"}
  fi
  echo "error: dpkg-deb is required (or Docker, to borrow one)" >&2
  exit 1
fi

version="${MS_BUILD_VERSION:-$(node -p "require('${repo_root}/package.json').version" 2>/dev/null || sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "${repo_root}/package.json" | head -1)}"

# **The package's version is not the release's when the release is a pre-release.** Semver writes
# a candidate `1.0.0-rc.1`; rpm refuses a `-` in `Version:` outright, and dpkg reads everything
# after the last `-` as a packaging revision, so `1.0.0-rc.1` sorts *after* `1.0.0` and the
# release would be refused as a downgrade of its own candidate. Both formats spell a
# pre-release with `~`, which sorts before anything, so `1.0.0~rc.1` < `1.0.0`. The staged tree,
# the tarball and `VERSION` keep the release's own spelling; only what the package manager
# compares changes.
# Through a variable: bash 5 tilde-expands a bare `~` in the replacement to $HOME, and an
# escaped one keeps its backslash in bash 3.2.
tilde="~"
pkg_version="${version/-/${tilde}}"

if [ "${probe_only}" -eq 1 ]; then
  name="ms-probe"
  services=(probe)
  description="MonitoringSystem remote probe"
else
  name="ms"
  services=(core probe)
  description="MonitoringSystem core and local probe"
fi

[ -n "${stage}" ] || stage="${repo_root}/build/${name}-${version}"
[ -d "${stage}" ] || {
  echo "error: no staged tree at ${stage}" >&2
  echo "       run: ./scripts/package.sh $([ "${probe_only}" -eq 1 ] && echo --probe-only)" >&2
  exit 1
}

case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64)  arch=amd64 ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

root="${repo_root}/build/deb/${name}_${pkg_version}_${arch}"
out="${repo_root}/release/${name}_${pkg_version}_${arch}.deb"
rm -rf "${root}"
mkdir -p "${root}/DEBIAN" "${root}/opt/ms" "${repo_root}/release"

echo "==> laying out ${name} ${version} (${arch})"
cp -R "${stage}/app" "${root}/opt/ms/app"
cp -R "${stage}/bin" "${root}/opt/ms/bin"
[ -d "${stage}/web" ] && cp -R "${stage}/web" "${root}/opt/ms/web"
[ -d "${stage}/docs" ] && cp -R "${stage}/docs" "${root}/opt/ms/docs"
install -d -m 0755 "${root}/opt/ms/etc" "${root}/opt/ms/deploy/systemd" "${root}/opt/ms/libexec"
cp "${stage}"/etc/*.json "${root}/opt/ms/etc/"
cp "${stage}"/deploy/systemd/*.service "${root}/opt/ms/deploy/systemd/"
# **The units are package files, where an upgrade replaces them and dpkg removes them** (`H-21`).
# An operator's changes go in a drop-in (`systemctl edit`), under /etc, which dpkg never touches.
install -d -m 0755 "${root}/usr/lib/systemd/system"
cp "${stage}"/deploy/systemd/*.service "${root}/usr/lib/systemd/system/"
install -m 0755 "${repo_root}/deploy/setup.sh" "${root}/opt/ms/libexec/ms-setup"
printf '%s\n' "${version}" > "${root}/opt/ms/VERSION"
chmod +x "${root}"/opt/ms/bin/*

# **Normalise the modes we control.** The staged tree comes through a bind mount on a developer
# machine, and what a mode reads as on the other side of that is not something to leave to
# chance — rpm noticed docs arriving executable and quietly corrected them, which is a warning
# today and a difference between two builds of the same version tomorrow. `app/node_modules` is
# left alone: it has its own executables, and normalising it would break them.
find "${root}/opt/ms/docs" "${root}/opt/ms/etc" "${root}/opt/ms/deploy" "${root}/usr" -type f -exec chmod 0644 {} + 2>/dev/null || true
find "${root}/opt/ms/docs" "${root}/opt/ms/etc" "${root}/opt/ms/deploy" "${root}/usr" -type d -exec chmod 0755 {} + 2>/dev/null || true
chmod 0644 "${root}/opt/ms/VERSION"

installed_kb="$(du -sk "${root}/opt" | cut -f1)"

# **Node is Recommends, not Depends, and that is a judgement rather than a shortcut.** No Debian
# release ships a `nodejs` at the version this needs, so most installations get theirs from
# NodeSource, from a tarball or from a version manager — none of which satisfy a `Depends` on the
# distribution's package. A hard dependency would therefore make the .deb uninstallable on the
# machines it is actually for. `ms-setup` checks the real thing at configure time and fails with
# the version it found, which is a better error than apt refusing to consider the package.
#
# **`ping` is Depends, and the opposite judgement for the opposite reason** (`H-31`). ICMP is the
# default availability check and it runs the system binary (ADR-001 Decision 6), so a probe
# without one marks every ping sensor Down — and unlike Node, the distribution's own package is
# the one that works: `iputils-ping` is in every Debian and Ubuntu archive. A Recommends would
# not have caught the case that was actually met (`H-15`: Ubuntu's container image has no
# `ping`), because `dpkg -i` ignores it. Not `| inetutils-ping`: every flag the probe passes and
# every line it parses comes from iputils (`packages/sensors/src/support/ping.ts` and its
# fixtures), none from GNU inetutils' ping, and the smoke tests prove iputils' under the unit's
# sandbox. An alternative nobody has run would be first tried by an operator.
cat > "${root}/DEBIAN/control" <<CONTROL
Package: ${name}
Version: ${pkg_version}
Section: net
Priority: optional
Architecture: ${arch}
Maintainer: MonitoringSystem <noreply@example.invalid>
Depends: openssl, systemd, adduser, iputils-ping
Recommends: nodejs (>= 22)
Installed-Size: ${installed_kb}
Description: ${description}
 A PRTG-class infrastructure monitoring system: a core holding the
 configuration, the API and the web UI, and probes that run the checks.
 .
 Configuration lives in /etc/ms and is created on first install. It is never
 overwritten by an upgrade; each upgrade leaves a timestamped backup and the
 release's own example beside it as .json.new.
CONTROL

if [ "${probe_only}" -eq 1 ]; then
  # A host cannot hold both: they ship the same paths under /opt/ms, and a probe host that had
  # the full package installed over it would acquire a core it was never meant to run.
  echo "Conflicts: ms" >> "${root}/DEBIAN/control"
  echo "Provides: ms-probe" >> "${root}/DEBIAN/control"
fi

# `postinst` runs on install *and* on upgrade, which is why `ms-setup` has to be idempotent: the
# CA it issued the first time must survive, and so must the configuration somebody has edited.
cat > "${root}/DEBIAN/postinst" <<POSTINST
#!/bin/sh
set -e
case "\$1" in
  configure)
    /opt/ms/libexec/ms-setup --components "$(IFS=,; echo "${services[*]}")"
    ;;
esac
exit 0
POSTINST

# **Stopped before the unpack, not after it** (`H-21`). dpkg renames each new file over the old
# one and deletes the files the new version dropped, and with apt the `configure` that restarts
# anything can come long after, at the end of a multi-package run — so the old processes used to
# run over a new tree for all that time, loading the new modules into the old code and failing
# checks on the ones that had gone, and indefinitely if `postinst` then refused the configuration.
# The new version's `preinst` runs before its files are unpacked, which makes it the one script
# that can stop the services in time, and it runs on the very first upgrade to this version.
# `ms-setup` in `postinst` starts them again.
cat > "${root}/DEBIAN/preinst" <<PREINST
#!/bin/sh
set -e
case "\$1" in
  upgrade)
    for svc in $(IFS=' '; echo "${services[*]}"); do
      systemctl stop "ms-\${svc}.service" >/dev/null 2>&1 || true
    done
    ;;
esac
exit 0
PREINST

# On removal only: an upgrade's stop is `preinst`'s, above, and the old version's prerm gets
# "upgrade" here and must leave the services to it.
cat > "${root}/DEBIAN/prerm" <<PRERM
#!/bin/sh
set -e
case "\$1" in
  remove|deconfigure)
    for svc in $(IFS=' '; echo "${services[*]}"); do
      systemctl stop "ms-\${svc}.service" >/dev/null 2>&1 || true
      systemctl disable "ms-\${svc}.service" >/dev/null 2>&1 || true
    done
    ;;
esac
exit 0
PRERM

# **Purge leaves /etc/ms, /var/lib/ms-* and the database alone**, and that is the same decision
# the uninstall section of docs/installation.md documents: those hold the configuration, the
# credential-vault key and every reading ever taken. Removing them as a side effect of removing
# the application would destroy data nobody asked to destroy — and the vault key in particular is
# unrecoverable, so every stored credential would go with it. The units are package files and go
# with the package; an operator's drop-ins under /etc/systemd/system are theirs, and stay.
cat > "${root}/DEBIAN/postrm" <<POSTRM
#!/bin/sh
set -e
case "\$1" in
  remove|purge)
    systemctl daemon-reload >/dev/null 2>&1 || true
    ;;
esac
if [ "\$1" = purge ]; then
  echo "note: /etc/ms, /var/lib/ms-core and /var/lib/ms-probe were left in place." >&2
  echo "      They hold the configuration, the credential-vault key and the spool." >&2
fi
exit 0
POSTRM

chmod 0755 "${root}/DEBIAN/preinst" "${root}/DEBIAN/postinst" "${root}/DEBIAN/prerm" \
  "${root}/DEBIAN/postrm"

echo "==> building ${out}"
dpkg-deb --root-owner-group --build "${root}" "${out}" >/dev/null
dpkg-deb --info "${out}" | sed -n '2,8p'
echo "==> done: ${out}"

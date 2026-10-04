#!/usr/bin/env bash
# Build an .rpm from the staged release tree (TASKS.md H-05).
#
#     ./scripts/package-rpm.sh                  # ms-<version>.<arch>.rpm
#     ./scripts/package-rpm.sh --probe-only     # ms-probe-<version>.<arch>.rpm
#     ./scripts/package-rpm.sh --stage DIR      # package a tree already staged
#
# The .rpm counterpart of `package-deb.sh`, and deliberately its mirror: same staged tree, same
# layout under /opt/ms, same `ms-setup` doing the work. Where the two package formats differ is
# only in how they spell "run this on install but not on upgrade", and getting *that* wrong is
# the classic packaging bug — an rpm `%preun` that stops the service on an upgrade leaves the
# machine with nothing running and no error to show for it, because rpm removes the old package
# after installing the new one.
#
# **`$1` is the count of versions that will remain**, which is why every scriptlet below tests
# for `0` rather than for a verb. On an upgrade `%preun` sees 1 and must do nothing.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

probe_only=0
stage=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe-only) probe_only=1 ;;
    --stage)      stage="$2"; shift ;;
    -h|--help)    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# rpmbuild is not on Debian or macOS by default; borrow a Rocky box the way package-deb.sh
# borrows a Debian one. The image needs rpm-build, which the base does not carry.
if ! command -v rpmbuild >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then
    echo "==> no rpmbuild here; building in rockylinux:9"
    forward=''
    [ "${probe_only}" -eq 1 ] && forward='--probe-only'
    [ -n "${stage}" ] && forward="${forward} --stage ${stage}"
    exec docker run --rm -v "${repo_root}:/workspace" -w /workspace rockylinux:9 \
      bash -c "dnf install -y -q rpm-build >/dev/null 2>&1 && exec bash scripts/package-rpm.sh ${forward}"
  fi
  echo "error: rpmbuild is required (or Docker, to borrow one)" >&2
  exit 1
fi

version="${MS_BUILD_VERSION:-$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "${repo_root}/package.json" | head -1)}"

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
  summary="MonitoringSystem remote probe"
else
  name="ms"
  services=(core probe)
  summary="MonitoringSystem core and local probe"
fi

[ -n "${stage}" ] || stage="${repo_root}/build/${name}-${version}"
[ -d "${stage}" ] || {
  echo "error: no staged tree at ${stage}" >&2
  echo "       run: ./scripts/package.sh $([ "${probe_only}" -eq 1 ] && echo --probe-only)" >&2
  exit 1
}

arch="$(uname -m)"
# **Outside the repository, deliberately.** On a developer machine `build/` is a bind mount from
# macOS, and a `chmod` from inside the container does not always survive it — which showed up as
# rpm quietly stripping an executable bit from every document in the payload, and would show up
# tomorrow as two builds of one version differing. Building in the container's own filesystem
# makes the modes mean what they say; only the finished package is copied back.
top="${MS_RPM_TOPDIR:-/tmp/ms-rpmbuild}"
rm -rf "${top}"
mkdir -p "${top}"/{BUILD,RPMS,SOURCES,SPECS} "${repo_root}/release"

echo "==> laying out ${name} ${version} (${arch})"
payload="${top}/SOURCES/${name}-${pkg_version}"
mkdir -p "${payload}/opt/ms"
cp -R "${stage}/app" "${payload}/opt/ms/app"
cp -R "${stage}/bin" "${payload}/opt/ms/bin"
[ -d "${stage}/web" ] && cp -R "${stage}/web" "${payload}/opt/ms/web"
[ -d "${stage}/docs" ] && cp -R "${stage}/docs" "${payload}/opt/ms/docs"
install -d -m 0755 "${payload}/opt/ms/etc" "${payload}/opt/ms/deploy/systemd" "${payload}/opt/ms/libexec"
cp "${stage}"/etc/*.json "${payload}/opt/ms/etc/"
cp "${stage}"/deploy/systemd/*.service "${payload}/opt/ms/deploy/systemd/"
# **The units are package files, where an upgrade replaces them and rpm removes them** (`H-21`).
# An operator's changes go in a drop-in (`systemctl edit`), under /etc, which rpm never touches.
install -d -m 0755 "${payload}/usr/lib/systemd/system"
cp "${stage}"/deploy/systemd/*.service "${payload}/usr/lib/systemd/system/"
install -m 0755 "${repo_root}/deploy/setup.sh" "${payload}/opt/ms/libexec/ms-setup"
printf '%s\n' "${version}" > "${payload}/opt/ms/VERSION"
chmod +x "${payload}"/opt/ms/bin/*

# **Normalise the modes we control.** The staged tree comes through a bind mount on a developer
# machine, and what a mode reads as on the other side of that is not something to leave to
# chance — rpm noticed docs arriving executable and quietly corrected them, which is a warning
# today and a difference between two builds of the same version tomorrow. `app/node_modules` is
# left alone: it has its own executables, and normalising it would break them.
#
# rpm still reports a handful of files under `app/node_modules` whose executable bit it strips —
# a README, a LICENSE, a benchmark script that some upstream published with `+x`. It only strips
# from files with no shebang, so nothing that is ever executed is touched; the `.bin` shims all
# have one and are left alone. Expected output, not something to chase.
find "${payload}/opt/ms/docs" "${payload}/opt/ms/etc" "${payload}/opt/ms/deploy" "${payload}/usr" -type f -exec chmod 0644 {} + 2>/dev/null || true
find "${payload}/opt/ms/docs" "${payload}/opt/ms/etc" "${payload}/opt/ms/deploy" "${payload}/usr" -type d -exec chmod 0755 {} + 2>/dev/null || true
chmod 0644 "${payload}/opt/ms/VERSION"

(cd "${top}/SOURCES" && tar -czf "${name}-${pkg_version}.tar.gz" "${name}-${pkg_version}")

conflicts=''
[ "${probe_only}" -eq 1 ] && conflicts="Conflicts:      ms"

cat > "${top}/SPECS/${name}.spec" <<SPEC
Name:           ${name}
Version:        ${pkg_version}
Release:        1
Summary:        ${summary}
License:        Proprietary
URL:            https://example.invalid/monitoringsystem
Source0:        ${name}-${pkg_version}.tar.gz
BuildArch:      ${arch}
Requires:       openssl, systemd, shadow-utils, iputils
${conflicts}

# The payload is already built; there is nothing here for rpm's debug machinery to strip, and
# letting it try produces an empty-debuginfo error on a package of JavaScript.
%global debug_package %{nil}
# The launchers and the setup script are shell; rpm's dependency generator would otherwise
# demand /usr/bin/env as a package.
AutoReqProv:    no

%description
A PRTG-class infrastructure monitoring system: a core holding the configuration,
the API and the web UI, and probes that run the checks.

Configuration lives in /etc/ms and is created on first install. It is never
overwritten by an upgrade; each upgrade leaves a timestamped backup and the
release's own example beside it as .json.new.

Node.js 22 or newer must be on PATH. It is not expressed as a dependency because
no enterprise release ships one that new, so the version that satisfies this
normally comes from NodeSource or a tarball rather than from the distribution --
a hard Requires would make this package uninstallable on the hosts it is for.
The post-install checks for it and says what it found.

iputils is required, unlike Node: the ICMP sensors run the system ping, ICMP is
the default availability check, and the distribution's own package is the one
they are written and tested against.

%prep
%setup -q

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}
cp -a opt usr %{buildroot}/

%files
%defattr(-,root,root,-)
/opt/ms
$(for svc in "${services[@]}"; do printf '/usr/lib/systemd/system/ms-%s.service\n' "${svc}"; done)
/usr/lib/systemd/system/ms-recover@.service

%pre
# **Stopped before the new files go in, on an upgrade** (\$1 = 2) (\`H-21\`). rpm renames each new
# file into place and then erases what the old package had that this one does not, so the old
# processes used to run over a mixed and then a new tree — and a %post that failed is only a
# warning to rpm, so the transaction went on and they stayed there. %post starts them again.
if [ "\$1" -gt 1 ]; then
$(for svc in "${services[@]}"; do
  printf '  systemctl stop "ms-%s.service" >/dev/null 2>&1 || :\n' "${svc}"
done)
fi

%post
# Runs on install (\$1 = 1) and on upgrade (\$1 = 2). \`ms-setup\` is idempotent for exactly this
# reason: the CA it issued the first time must survive, and so must an edited configuration.
/opt/ms/libexec/ms-setup --components $(IFS=,; echo "${services[*]}")

%preun
# **\$1 is how many versions will remain afterwards.** On an upgrade that is 1 and this must do
# nothing: rpm installs the new package and only then removes the old one, so stopping here
# would stop the service that %post has already restarted, and leave the host down silently.
if [ "\$1" -eq 0 ]; then
$(for svc in "${services[@]}"; do
  printf '  systemctl stop "ms-%s.service" >/dev/null 2>&1 || :\n' "${svc}"
  printf '  systemctl disable "ms-%s.service" >/dev/null 2>&1 || :\n' "${svc}"
done)
fi

%postun
# Same rule, same reason. /etc/ms, /var/lib/ms-* and the database are left alone on purpose:
# they hold the configuration, the credential-vault key and every reading ever taken, and the
# vault key is unrecoverable — removing it as a side effect of removing the application would
# destroy every stored credential with it. The units are package files and go with it; an
# operator's drop-ins are theirs, and stay.
if [ "\$1" -eq 0 ]; then
  systemctl daemon-reload >/dev/null 2>&1 || :
  echo "note: /etc/ms and /var/lib/ms-* were left in place." >&2
fi
SPEC

echo "==> building"
rpmbuild --define "_topdir ${top}" -bb "${top}/SPECS/${name}.spec" >/dev/null

built="$(find "${top}/RPMS" -name '*.rpm' | head -1)"
[ -n "${built}" ] || { echo "error: rpmbuild produced no package" >&2; exit 1; }
out="${repo_root}/release/$(basename "${built}")"
cp "${built}" "${out}"
rpm -qip "${out}" | sed -n '1,8p'
echo "==> done: ${out}"

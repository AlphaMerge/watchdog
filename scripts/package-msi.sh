#!/usr/bin/env bash
# Build a Windows .msi from the staged release tree (TASKS.md H-06).
#
#     ./scripts/package-msi.sh                  # ms-<version>-x64.msi
#     ./scripts/package-msi.sh --probe-only     # ms-probe-<version>-x64.msi
#     ./scripts/package-msi.sh --stage DIR      # package a tree already staged
#
# **Built with "wixl", msitools' WiX compiler, which runs on Linux** — so the MSI comes off the
# same machine and the same staged tree as the tarball, the .deb and the .rpm. That is the point:
# four artefacts, the same bits, by construction rather than by four scripts kept in step.
#
# ## What a successful build here does not prove
#
# **Nothing here installs it.** The MSI is structurally valid and its contents are verified below,
# but service registration, the firewall rules, the upgrade path and the uninstall all execute on
# Windows and are unverified until someone runs them on Windows Server. That is what "H-06" still
# needs. Do not read a green build as a working installer.
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

# wixl is Debian's msitools; this is developed on macOS. Borrow a box, the same bargain
# "package-deb.sh" and "package-rpm.sh" make.
if ! command -v wixl >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then
    echo "==> no wixl here; building in debian:bookworm"
    forward=()
    [ "${probe_only}" -eq 1 ] && forward+=(--probe-only)
    [ -n "${stage}" ] && forward+=(--stage "${stage}")
    exec docker run --rm -v "${repo_root}:/workspace" -w /workspace debian:bookworm bash -c \
      'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq wixl msitools python3 >/dev/null 2>&1 && exec bash scripts/package-msi.sh "$@"' \
      -- ${forward[@]+"${forward[@]}"}
  fi
  echo "error: wixl is required (Debian: apt install wixl), or Docker to borrow one" >&2
  exit 1
fi

version="${MS_BUILD_VERSION:-$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "${repo_root}/package.json" | head -1)}"

if [ "${probe_only}" -eq 1 ]; then
  name="ms-probe"
  services=(probe)
  title="MonitoringSystem Probe"
  # **A stable UpgradeCode, and a different one per package shape.** MSI decides "is this an
  # upgrade of what is already installed" by UpgradeCode, so it must never change between
  # releases — and the probe-only package must not claim to upgrade the full one, which would
  # hand a probe host a core it never asked for.
  upgrade_code="6F2B7E14-6C4A-4E39-9E4C-2D8B0C1A7F51"
else
  name="ms"
  services=(core probe)
  title="MonitoringSystem"
  upgrade_code="1C9A5D30-88B1-4B77-9A2E-7D4F6E0B3A92"
fi

[ -n "${stage}" ] || stage="${repo_root}/build/${name}-${version}"
[ -d "${stage}" ] || {
  echo "error: no staged tree at ${stage}" >&2
  echo "       run: ./scripts/package.sh $([ "${probe_only}" -eq 1 ] && echo --probe-only)" >&2
  exit 1
}

# Outside the repository, for the reason "package-rpm.sh" gives: on a developer machine "build/"
# is a bind mount from macOS and a mode set inside the container does not always survive it.
top="${MS_MSI_TOPDIR:-/tmp/ms-msibuild}"
rm -rf "${top}"
mkdir -p "${top}/payload" "${repo_root}/release"
payload="${top}/payload"

# **The application ships as one archive rather than as thirteen thousand MSI components**, and
# that is forced rather than chosen: "wixl" segfaults somewhere above ten thousand components,
# while a hundred build in under a second. It is also how large Node applications are normally
# packaged, and it makes the MSI a few files instead of a file table nothing can open quickly.
#
# The cost is real and worth naming: Windows Installer no longer tracks the application file by
# file, so its repair cannot restore one and its uninstall does not remove them individually.
# "ms-teardown.ps1" removes the expanded tree, and the MSI removes what it does track.
echo "==> laying out ${name} ${version}"
staging="${top}/app-tree"
mkdir -p "${staging}"
cp -R "${stage}/app" "${staging}/app"
cp -R "${stage}/bin" "${staging}/bin"
[ -d "${stage}/web" ] && cp -R "${stage}/web" "${staging}/web"
[ -d "${repo_root}/docs" ] && cp -R "${repo_root}/docs" "${staging}/docs"
python3 -c "
import shutil, sys
shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])
" "${payload}/app" "${staging}"
echo "    application archive: $(du -h "${payload}/app.zip" | cut -f1)"
mkdir -p "${payload}/etc"
cp "${stage}"/etc/*.json "${payload}/etc/"
for svc in "${services[@]}"; do
  # WinSW reads its definition from a file named after the executable beside it, so "ms-core.xml"
  # pairs with the "ms-core.exe" copy of WinSW that "ms-setup.ps1" puts there.
  cp "${repo_root}/deploy/winsw/ms-${svc}.xml" "${payload}/ms-${svc}.xml"
done
cp "${repo_root}/deploy/windows/ms-setup.ps1" "${payload}/ms-setup.ps1"
cp "${repo_root}/deploy/windows/ms-teardown.ps1" "${payload}/ms-teardown.ps1"
printf '%s\n' "${version}" > "${payload}/VERSION"
find "${payload}" -type f -exec chmod 0644 {} + 2>/dev/null || true
find "${payload}" -type d -exec chmod 0755 {} + 2>/dev/null || true

echo "==> generating the component list"
tree_wxs="${top}/tree.wxs"
refs_wxs="${top}/refs.wxs"
python3 "${repo_root}/scripts/windows/wxs-tree.py" "${payload}" "${tree_wxs}" "${refs_wxs}"

echo "==> writing the WiX source"
components_csv="$(IFS=,; echo "${services[*]}")"
wxs="${top}/${name}.wxs"
{
  cat <<HEADER
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${title}" Language="1033" Version="${version}.0"
           Manufacturer="MonitoringSystem" UpgradeCode="${upgrade_code}">
    <Package InstallerVersion="200" Compressed="yes" InstallScope="perMachine"
             Description="${title} ${version}" />
    <Media Id="1" Cabinet="ms.cab" EmbedCab="yes" />

    <!-- An upgrade replaces what is installed rather than sitting beside it. Removing the old
         product immediately after InstallInitialize is what stops a half-replaced installation:
         the previous files are gone before the new ones land. -->
    <Upgrade Id="${upgrade_code}">
      <UpgradeVersion Minimum="0.0.0.0" IncludeMinimum="yes" Maximum="${version}.0"
                      IncludeMaximum="no" Property="OLDERVERSIONBEINGUPGRADED" />
    </Upgrade>
    <!-- **The MSI lays down files; "ms-setup.ps1" does everything else**, exactly as the .deb's
         postinst and the .rpm's %post call ms-setup on Linux. Registering a service and opening a
         firewall port from MSI tables would be a third implementation of a thing that already has
         one, and the third is the one nobody runs.

         Deferred and not impersonated, because both need the elevated context the installer runs
         in; "Return="check"" so a setup that fails fails the install rather than leaving a host
         with files and no services. -->
    <!-- "Property" rather than "Directory": wixl implements the property-named-executable form
         and silently drops a "Directory" one, leaving an MSI that installs files and runs
         nothing. The build below fails if either row is missing, because that failure is
         otherwise invisible. -->
    <Property Id="POWERSHELL" Value="powershell.exe" />
    <CustomAction Id="RunSetup" Property="POWERSHELL" Execute="deferred" Impersonate="no"
                  Return="check"
                  ExeCommand="-NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLDIR]ms-setup.ps1&quot; -Components ${components_csv}" />
    <CustomAction Id="RunTeardown" Property="POWERSHELL" Execute="deferred" Impersonate="no"
                  Return="ignore"
                  ExeCommand="-NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLDIR]ms-teardown.ps1&quot; -Components ${components_csv}" />

    <InstallExecuteSequence>
      <RemoveExistingProducts After="InstallInitialize" />
      <!-- Teardown before the files go, so the scripts it needs are still on disk; setup after
           they arrive. "REMOVE=\"ALL\"" distinguishes an uninstall from the removal half of an
           upgrade, where stopping the services would fight the install that follows. -->
      <Custom Action="RunTeardown" Before="RemoveFiles">REMOVE="ALL"</Custom>
      <Custom Action="RunSetup" After="InstallFiles">NOT REMOVE</Custom>
    </InstallExecuteSequence>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFilesFolder">
        <Directory Id="INSTALLDIR" Name="MonitoringSystem">
HEADER
  cat "${tree_wxs}"
  cat <<'MIDDLE'
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="Complete" Level="1">
MIDDLE
  cat "${refs_wxs}"
  cat <<'FOOTER'
    </Feature>
  </Product>
</Wix>
FOOTER
} > "${wxs}"

echo "==> compiling"
out="${repo_root}/release/${name}-${version}-x64.msi"
# From inside the payload, because "Source" is relative to wixl's working directory — it refuses
# an absolute path with a GLib assertion rather than an error that names the problem.
(cd "${payload}" && wixl -a x64 -o "${out}" "${wxs}")

echo "==> verifying what came out"
files_in_msi="$(msiinfo export "${out}" File | grep -c . || true)"
echo "    tables:      $(msiinfo tables "${out}" | tr '\n' ' ')"
echo "    files:       ${files_in_msi}"
echo "    UpgradeCode: $(msiinfo export "${out}" Property | awk -F'\t' '$1=="UpgradeCode"{print $2}')"
echo "    version:     $(msiinfo export "${out}" Property | awk -F'\t' '$1=="ProductVersion"{print $2}')"

# The pieces an operator's install depends on. A package that built but shipped no setup script
# would look fine here and fail on the far side, which is the whole class of problem this catches.
for wanted in ms-setup.ps1 ms-teardown.ps1 VERSION; do
  msiinfo export "${out}" File | grep -q "${wanted}" \
    || { echo "    MISSING from the package: ${wanted}" >&2; exit 1; }
done
echo "    setup, teardown and VERSION: present"

# **wixl drops what it cannot compile and still writes an MSI.** A "Directory"-form custom action
# produced a GLib assertion on stderr, exit status zero, and a package that installs files and
# registers nothing — which is the exact shape of a defect that ships. So the rows are asserted
# rather than assumed.
for action in RunSetup RunTeardown; do
  msiinfo export "${out}" CustomAction | grep -q "^${action}\b" \
    || { echo "    MISSING custom action: ${action} — wixl dropped it" >&2; exit 1; }
  msiinfo export "${out}" InstallExecuteSequence | grep -q "^${action}\b" \
    || { echo "    ${action} is not sequenced; it would never run" >&2; exit 1; }
done
echo "    custom actions: RunSetup and RunTeardown present and sequenced"
echo "==> done: ${out}"
echo
echo "NOT VERIFIED: nothing here installed this. Service registration, firewall rules, the"
echo "upgrade path and the uninstall run on Windows and remain unproven (H-06)."

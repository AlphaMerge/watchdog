#!/usr/bin/env bash
# Build a versioned release tarball.
#
# Layout inside the tarball:
#   bin/ms-core, bin/ms-probe     launcher scripts
#   app/{core,probe,shared}/dist  compiled JavaScript
#   app/*/build.json              which build this is: version, commit, uncommitted changes (H-11),
#                                 its profile (H-12), and the hash of the lock it installed (H-20)
#   app/package-lock.json         the committed lock, cut down to what the runtime reaches (H-20)
#   app/node_modules              production dependencies, including native addons, as locked
#   bin/ms-backup, bin/ms-restore the backup and restore procedure (H-04)
#   deploy/systemd/*.service      unit files
#   deploy/winsw/*.xml            Windows service definitions
#   deploy/setup.sh               the post-install every installer runs (H-05)
#   deploy/place-release.sh       copy, check, stop, swap — the tarball installers' upgrade (H-21)
#   deploy/uninstall.sh           the tarball's removal, installed as libexec/ms-uninstall (H-39)
#   deploy/remove-ping-conf.sh    the probe's ping drop-in, taken away by a removal (H-34)
#   docs/                         this release's documentation, which the units point at
#   etc/{core,probe}.json         example configuration
#   install.sh                    Linux installer
#
# With --probe-only, a package for a remote probe host (TASKS.md R-07): the probe, the sensor
# catalogue it executes, and nothing else. `install.sh --probe-only` already existed, but it
# installs from the full tarball — so a remote probe host received the core service, the web UI
# and the core's own dependencies, and was trusted not to start them.
#
# **The win is what cannot happen, not the megabytes.** Measured on linux/aarch64 at 0.1.0 it is
# 12M against 16M, because most of the weight is the sensor catalogue's dependencies and the
# probe is precisely what needs those — `pg` ships either way, since the probe runs the
# PostgreSQL *sensor*. What the probe host no longer has is a core it could be pointed at, a
# core.json to misconfigure, a web root to serve, and Fastify.
#
# Native addons are shipped as installed, not bundled: esbuild cannot inline a .node binary.
# Build on the same OS and architecture as the target.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/build-tree.sh
. "${repo_root}/scripts/lib/build-tree.sh"
version="${MS_BUILD_VERSION:-$(node -p "require('${repo_root}/package.json').version")}"

# Which commit this is (`H-11`). Every build said `0.1.0` until this existed, so nothing could
# tell two builds apart. `git` answers from a checkout; a worktree seen from inside the toolchain
# container cannot reach its repository (its `.git` names a path on the host), so the caller can
# say it instead with MS_BUILD_COMMIT — and MS_BUILD_DIRTY=1 if that tree had uncommitted changes.
# When neither works the manifest says the commit is unknown, rather than guessing one.
#
# **Fails closed** (`H-20`). A `git` that can see this repository and then cannot say whether its
# tree is clean stops the build. It used to have its stderr discarded, its empty output read as
# clean, and `dirty: false` stamped on whatever was there. MS_BUILD_DIRTY is `0` or `1` and nothing
# else, because `true` used to mean clean. Untracked files count: a new source file nobody added
# is compiled into `dist` all the same. Ignored files do not: `dist` and `build/` are this
# script's output.
commit="${MS_BUILD_COMMIT:-}"
dirty="${MS_BUILD_DIRTY:-0}"
case "${dirty}" in
  0 | 1) ;;
  *)
    echo "error: MS_BUILD_DIRTY must be 0 or 1, not '${dirty}'" >&2
    exit 1
    ;;
esac
tree_state=""
if [ -z "${commit}" ] && git -C "${repo_root}" rev-parse --verify HEAD >/dev/null 2>&1; then
  if ! tree_state="$(ms_tree_state "${repo_root}")"; then
    echo "error: git can see this repository but cannot say whether its tree is clean," \
      "so this build could not say what it is" >&2
    exit 1
  fi
  read -r commit tree_dirty _ <<<"${tree_state}"
  if [ "${tree_dirty}" = "1" ]; then dirty=1; fi
fi

# **Asked again after each step that reads the tree** (`H-20`). A build takes minutes, and an
# edit made during it is compiled into `dist` or not depending on timing, under a stamp taken
# before it. Being dirty both times proves nothing, so this compares the fingerprint.
still_the_stamped_tree() {
  [ -n "${tree_state}" ] || return 0
  local now
  if ! now="$(ms_tree_state "${repo_root}")"; then
    echo "error: git could not read the tree again after ${1}" >&2
    exit 1
  fi
  if [ "${now}" != "${tree_state}" ]; then
    echo "error: the tree changed while it was being ${1}, so this package is not what its" \
      "stamp says; build it again from a tree nobody is editing" >&2
    exit 1
  fi
}
if [ -n "${commit}" ] && ! [[ "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: the commit must be a full 40-character id, not '${commit}'" >&2
  exit 1
fi

# What this build contains (`H-12`). `v1` is the release candidate — no flow, maps, reports or
# libraries, and no sensor types a Linux probe cannot run — and it is the default, so cutting a
# candidate needs nobody to remember a flag. `full` is everything on `main`. Stamped here and
# nowhere else: the services refuse a manifest without one rather than guessing.
profile="${MS_BUILD_PROFILE:-v1}"
case "${profile}" in
  v1 | full) ;;
  *)
    echo "error: MS_BUILD_PROFILE must be v1 or full, not '${profile}'" >&2
    exit 1
    ;;
esac
arch="$(uname -m)"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"

probe_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe-only) probe_only=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "${probe_only}" -eq 1 ]; then
  # @ms/sensors comes too: the probe *is* what executes the checks, and a probe without the
  # catalogue starts, connects, accepts assignments and fails every one of them.
  packages=(shared sensors probe)
  services=(probe)
  name="ms-probe"
else
  packages=(shared sensors core probe)
  services=(core probe)
  name="ms"
fi

stage="${repo_root}/build/${name}-${version}"
out="${repo_root}/release/${name}-${version}-${os}-${arch}.tar.gz"

if [ -z "${commit}" ]; then
  echo "warning: this build cannot say which commit it is — set MS_BUILD_COMMIT" >&2
  echo "==> building ${version} (${profile}) at an unknown commit for ${os}/${arch}"
elif [ "${dirty}" = "1" ]; then
  echo "==> building ${version} (${profile}) at ${commit} with uncommitted changes, for ${os}/${arch}"
else
  echo "==> building ${version} (${profile}) at ${commit} for ${os}/${arch}"
fi
rm -rf "${stage}"
mkdir -p "${stage}" "${repo_root}/release"

# **From clean** (`H-20`). `tsc -b` is incremental and trusts timestamps: a mutation restored
# without touching its source left an output newer than the source, which `tsc` then called up to
# date, and `package.sh` shipped the mutant stamped `dirty: false`. It also never deletes the
# output of a source that has gone. `clean` removes every `dist`, so what ships is compiled from
# what is there now.
npm --prefix "${repo_root}" run clean
npm --prefix "${repo_root}" run build
still_the_stamped_tree compiled

echo "==> staging application"
for pkg in "${packages[@]}"; do
  mkdir -p "${stage}/app/${pkg}"
  cp -R "${repo_root}/packages/${pkg}/dist" "${stage}/app/${pkg}/dist"
  cp "${repo_root}/packages/${pkg}/package.json" "${stage}/app/${pkg}/package.json"
  # Files a package needs at runtime that are not JavaScript — today that is the font a PDF report
  # is drawn with (`E-06`, `ADR-006` Decision 2), resolved relative to `dist`. Without it the core
  # starts, serves and renders HTML, CSV and XML, and fails on the first PDF; `tsc` does not copy
  # non-TypeScript files, so this is the line that puts it in the tarball.
  if [ -d "${repo_root}/packages/${pkg}/assets" ]; then
    cp -R "${repo_root}/packages/${pkg}/assets" "${stage}/app/${pkg}/assets"
  fi
  # Tests, declarations and build metadata are development artefacts. Source maps stay: a
  # stack trace in journalctl that points at the TypeScript line is worth the few hundred KB.
  rm -rf "${stage}/app/${pkg}/dist/test"
  find "${stage}/app/${pkg}/dist" \
    \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.tsbuildinfo' \) -delete
done

echo "==> installing production dependencies"
# A workspace-free manifest so `npm install --omit=dev` resolves only what the services need.
node - "$repo_root" "$stage" "$version" "${packages[*]}" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [, , repoRoot, stage, version, packageList] = process.argv;

const merged = {};
for (const pkg of packageList.split(' ')) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'));
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    // Workspace siblings are staged directly, not fetched.
    if (name.startsWith('@ms/')) continue;
    if (merged[name] !== undefined && merged[name] !== range) {
      throw new Error(`dependency conflict on ${name}: ${merged[name]} vs ${range}`);
    }
    merged[name] = range;
  }
}

writeFileSync(
  join(stage, 'app', 'package.json'),
  `${JSON.stringify({ name: 'ms-runtime', version, private: true, type: 'module', dependencies: merged }, null, 2)}\n`,
);
NODE

# **Exactly what the committed lock says** (`H-20`). This was `npm install` from caret ranges with
# no lock, and the candidate of 2026-09-28 shipped 29 of its 234 runtime packages at versions no
# suite had run against: `fastify` 5.12.5 for the lock's 5.12.1, and `@azure/msal-node` a major
# version on. `stage-lock.mjs` cuts the committed lock down to what these workspaces reach, `npm ci`
# installs that and nothing else, and `verify` then reads every installed version back against the
# committed lock, so a later change to this step cannot bring the drift back quietly.
lock="$(node "${repo_root}/scripts/lib/stage-lock.mjs" stage \
  "${repo_root}/package-lock.json" "${stage}/app" "${packages[@]}")"
(cd "${stage}/app" && npm ci --omit=dev --no-audit --no-fund --silent)
node "${repo_root}/scripts/lib/stage-lock.mjs" verify \
  "${repo_root}/package-lock.json" "${stage}/app" "${packages[@]}"

# Which build this is, beside `dist` where each service's `src/version.ts` reads it (`H-11`). A
# file rather than the launcher's environment, because WinSW starts `node.exe` on `main.js`
# directly and never runs the launcher. Written after the install, because it records the lock the
# install used (`H-20`).
for pkg in "${packages[@]}"; do
  node -e '
    const [, file, version, commit, dirty, profile, lock] = process.argv;
    const manifest = {
      version,
      commit: commit === "" ? null : commit,
      dirty: dirty === "1",
      profile,
      lock,
    };
    require("node:fs").writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  ' "${stage}/app/${pkg}/build.json" "${version}" "${commit}" "${dirty}" "${profile}" "${lock}"
done

# The workspace siblings are resolved from node_modules by both services; link the staged
# copies in. @ms/sensors carries the sensor-type catalogue, which the core reads for schemas and
# the probe's pool workers load by path.
mkdir -p "${stage}/app/node_modules/@ms"
ln -sfn ../../shared "${stage}/app/node_modules/@ms/shared"
ln -sfn ../../sensors "${stage}/app/node_modules/@ms/sensors"

echo "==> staging launchers, units and examples"
mkdir -p "${stage}/bin" "${stage}/deploy" "${stage}/etc"
for svc in "${services[@]}"; do
  # **The installed configuration unless told otherwise** (`H-21`). The unit sets MS_CONFIG_FILE
  # and a hand-run `ms-core config check` or `migrate status` did not, so it read the schema's
  # defaults: "valid" for a core.json the restart then refused, and a status taken of a database
  # that was not this installation's. `--config` still wins, as it does over the variable.
  #
  # **The probe's libuv thread pool at 16, unless the operator set it** (`P-426`): 8 lanes for name
  # lookups, of which the probe's resolver takes at most 6, so a resolver that stops answering
  # cannot hold the lanes the probe's link to the core resolves on. libuv reads it once, when the
  # pool first starts, which is before any line of the probe could set it. The unit sets it too,
  # for a probe started without this launcher.
  threadpool=''
  if [ "${svc}" = probe ]; then
    threadpool='export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"'
  fi
  cat > "${stage}/bin/ms-${svc}" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
here="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export MS_BUILD_VERSION="${version}"
export MS_CONFIG_FILE="\${MS_CONFIG_FILE:-/etc/ms/${svc}.json}"
${threadpool}
exec "\${MS_NODE:-node}" "\${here}/../app/${svc}/dist/src/main.js" "\$@"
LAUNCHER
  chmod +x "${stage}/bin/ms-${svc}"
done

if [ "${probe_only}" -eq 0 ]; then
  # The web UI, built to static assets and served by ms-core itself (ADR-001 Decision 8).
  # `api.webRoot` in core.json points at where install.sh puts this.
  echo "==> staging the web UI"
  npm --prefix "${repo_root}" run build:web
  still_the_stamped_tree "built into the web UI"
  cp -R "${repo_root}/packages/web/dist" "${stage}/web"
fi

mkdir -p "${stage}/deploy/systemd" "${stage}/deploy/winsw"
# The shared post-install (`H-05`). `install.sh` copies it to ${PREFIX}/libexec/ms-setup, and the
# .deb and .rpm ship it to the same place, so all three run one script rather than three.
cp "${repo_root}/deploy/setup.sh" "${stage}/deploy/setup.sh"
# How both tarball installers put a release in place without touching the running one until the
# new build has accepted the configuration (`H-21`).
cp "${repo_root}/deploy/place-release.sh" "${stage}/deploy/place-release.sh"
# What removes a tarball installation (`H-39`), and the fragment for the probe's ping drop-in it
# runs, the one the packages' purge and erase carry. `place-release.sh` puts both in libexec.
cp "${repo_root}/deploy/uninstall.sh" "${stage}/deploy/uninstall.sh"
cp "${repo_root}/deploy/remove-ping-conf.sh" "${stage}/deploy/remove-ping-conf.sh"
chmod +x "${stage}/deploy/setup.sh" "${stage}/deploy/place-release.sh" "${stage}/deploy/uninstall.sh"
# The release's own documentation, staged here so that the tarball, the .deb and the .rpm all
# install the same copy — the packages used to take the repository's and the tarball none, and
# install.sh then copied whatever `docs` sat beside the directory it was unpacked in.
rm -rf "${stage}/docs"
cp -R "${repo_root}/docs" "${stage}/docs"
# What starts a service again after the start limit stopped it for crashing (`H-23`): the unit
# both services name in OnFailure=, and the script it runs. A probe host needs it as much as a
# core does, more: nobody is there to start it by hand.
cp "${repo_root}/deploy/systemd/ms-recover@.service" "${stage}/deploy/systemd/ms-recover@.service"
cp "${repo_root}/deploy/recover.sh" "${stage}/bin/ms-recover"
chmod +x "${stage}/bin/ms-recover"
for svc in "${services[@]}"; do
  cp "${repo_root}/deploy/systemd/ms-${svc}.service" "${stage}/deploy/systemd/ms-${svc}.service"
  cp "${repo_root}/deploy/winsw/ms-${svc}.xml" "${stage}/deploy/winsw/ms-${svc}.xml"
  cp "${repo_root}/deploy/examples/${svc}.json" "${stage}/etc/${svc}.json"
done

if [ "${probe_only}" -eq 1 ]; then
  # The probe host's own installer and nothing that could install a core (R-07).
  cp "${repo_root}/deploy/install-probe.sh" "${stage}/install-probe.sh"
  cp "${repo_root}/deploy/install-probe.ps1" "${stage}/install-probe.ps1"
  chmod +x "${stage}/install-probe.sh"
else
  cp "${repo_root}/deploy/install.sh" "${stage}/install.sh"
  # The enrolment tool belongs on the core, because the CA does (R-07).
  cp "${repo_root}/deploy/enrol-probe.sh" "${stage}/bin/ms-enrol"
  # Backup and restore go in `bin`, not beside the installer (`H-04`): they are run for the
  # life of the installation, long after the unpacked tarball has been deleted, and a procedure
  # whose first step is "find the release you installed from" is one nobody runs.
  cp "${repo_root}/deploy/backup.sh" "${stage}/bin/ms-backup"
  cp "${repo_root}/deploy/restore.sh" "${stage}/bin/ms-restore"
  chmod +x "${stage}/install.sh" "${stage}/bin/ms-enrol" "${stage}/bin/ms-backup" \
           "${stage}/bin/ms-restore"
fi
printf '%s\n' "${version}" > "${stage}/VERSION"

# The lock that ships is the one stamped (`H-20`), checked last, when nothing else will write here.
shipped="$(node -e '
  const text = require("node:fs").readFileSync(process.argv[1]);
  process.stdout.write("sha256:" + require("node:crypto").createHash("sha256").update(text).digest("hex"));
' "${stage}/app/package-lock.json")"
if [ "${shipped}" != "${lock}" ]; then
  echo "error: app/package-lock.json is ${shipped}, and build.json says ${lock}" >&2
  exit 1
fi
still_the_stamped_tree packaged

echo "==> creating ${out}"
tar -czf "${out}" -C "${repo_root}/build" "${name}-${version}"
echo "==> done: ${out}"

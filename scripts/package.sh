#!/usr/bin/env bash
# Build a versioned release tarball.
#
# Layout inside the tarball:
#   bin/ms-core, bin/ms-probe     launcher scripts
#   app/{core,probe,shared}/dist  compiled JavaScript
#   app/node_modules              production dependencies, including native addons
#   bin/ms-backup, bin/ms-restore the backup and restore procedure (H-04)
#   deploy/systemd/*.service      unit files
#   deploy/winsw/*.xml            Windows service definitions
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
version="${MS_BUILD_VERSION:-$(node -p "require('${repo_root}/package.json').version")}"
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

echo "==> building ${version} for ${os}/${arch}"
rm -rf "${stage}"
mkdir -p "${stage}" "${repo_root}/release"

npm --prefix "${repo_root}" run build

echo "==> staging application"
for pkg in "${packages[@]}"; do
  mkdir -p "${stage}/app/${pkg}"
  cp -R "${repo_root}/packages/${pkg}/dist" "${stage}/app/${pkg}/dist"
  cp "${repo_root}/packages/${pkg}/package.json" "${stage}/app/${pkg}/package.json"
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

(cd "${stage}/app" && npm install --omit=dev --no-audit --no-fund --silent)

# The workspace siblings are resolved from node_modules by both services; link the staged
# copies in. @ms/sensors carries the sensor-type catalogue, which the core reads for schemas and
# the probe's pool workers load by path.
mkdir -p "${stage}/app/node_modules/@ms"
ln -sfn ../../shared "${stage}/app/node_modules/@ms/shared"
ln -sfn ../../sensors "${stage}/app/node_modules/@ms/sensors"

echo "==> staging launchers, units and examples"
mkdir -p "${stage}/bin" "${stage}/deploy" "${stage}/etc"
for svc in "${services[@]}"; do
  cat > "${stage}/bin/ms-${svc}" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
here="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export MS_BUILD_VERSION="${version}"
exec "\${MS_NODE:-node}" "\${here}/../app/${svc}/dist/src/main.js" "\$@"
LAUNCHER
  chmod +x "${stage}/bin/ms-${svc}"
done

if [ "${probe_only}" -eq 0 ]; then
  # The web UI, built to static assets and served by ms-core itself (ADR-001 Decision 8).
  # `api.webRoot` in core.json points at where install.sh puts this.
  echo "==> staging the web UI"
  npm --prefix "${repo_root}" run build:web
  cp -R "${repo_root}/packages/web/dist" "${stage}/web"
fi

mkdir -p "${stage}/deploy/systemd" "${stage}/deploy/winsw"
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

echo "==> creating ${out}"
tar -czf "${out}" -C "${repo_root}/build" "${name}-${version}"
echo "==> done: ${out}"

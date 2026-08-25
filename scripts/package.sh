#!/usr/bin/env bash
# Build a versioned release tarball.
#
# Layout inside the tarball:
#   bin/ms-core, bin/ms-probe     launcher scripts
#   app/{core,probe,shared}/dist  compiled JavaScript
#   app/node_modules              production dependencies, including native addons
#   deploy/systemd/*.service      unit files
#   deploy/winsw/*.xml            Windows service definitions
#   etc/{core,probe}.json         example configuration
#   install.sh                    Linux installer
#
# Native addons are shipped as installed, not bundled: esbuild cannot inline a .node binary.
# Build on the same OS and architecture as the target.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${MS_BUILD_VERSION:-$(node -p "require('${repo_root}/package.json').version")}"
arch="$(uname -m)"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
stage="${repo_root}/build/ms-${version}"
out="${repo_root}/release/ms-${version}-${os}-${arch}.tar.gz"

echo "==> building ${version} for ${os}/${arch}"
rm -rf "${stage}"
mkdir -p "${stage}" "${repo_root}/release"

npm --prefix "${repo_root}" run build

echo "==> staging application"
for pkg in shared sensors core probe; do
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
node - "$repo_root" "$stage" "$version" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [, , repoRoot, stage, version] = process.argv;

const merged = {};
for (const pkg of ['shared', 'sensors', 'core', 'probe']) {
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
for svc in core probe; do
  cat > "${stage}/bin/ms-${svc}" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
here="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export MS_BUILD_VERSION="${version}"
exec "\${MS_NODE:-node}" "\${here}/../app/${svc}/dist/src/main.js" "\$@"
LAUNCHER
  chmod +x "${stage}/bin/ms-${svc}"
done

# The web UI, built to static assets and served by ms-core itself (ADR-001 Decision 8).
# `api.webRoot` in core.json points at where install.sh puts this.
echo "==> staging the web UI"
npm --prefix "${repo_root}" run build:web
cp -R "${repo_root}/packages/web/dist" "${stage}/web"

cp -R "${repo_root}/deploy/systemd" "${stage}/deploy/systemd"
cp -R "${repo_root}/deploy/winsw" "${stage}/deploy/winsw"
cp "${repo_root}/deploy/examples/core.json" "${stage}/etc/core.json"
cp "${repo_root}/deploy/examples/probe.json" "${stage}/etc/probe.json"
cp "${repo_root}/deploy/install.sh" "${stage}/install.sh"
chmod +x "${stage}/install.sh"
printf '%s\n' "${version}" > "${stage}/VERSION"

echo "==> creating ${out}"
tar -czf "${out}" -C "${repo_root}/build" "ms-${version}"
echo "==> done: ${out}"

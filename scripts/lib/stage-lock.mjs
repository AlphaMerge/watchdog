// The committed lockfile, cut down to what a package's runtime installs (`H-20`).
//
//     node scripts/lib/stage-lock.mjs stage  <package-lock.json> <app-dir> <workspace>...
//     node scripts/lib/stage-lock.mjs hash   <package-lock.json> <app-dir> <workspace>...
//     node scripts/lib/stage-lock.mjs verify <package-lock.json> <app-dir> <workspace>...
//
// Each reads `<app-dir>/package.json`, which `package.sh` writes from the workspaces' own
// dependencies. `stage` writes `<app-dir>/package-lock.json` and prints `sha256:<hex>` of what it
// wrote; `npm ci` then installs exactly that, and `build.json` records the hash. `hash` prints
// what `stage` would, and writes nothing. `verify` compares what is installed under
// `<app-dir>/node_modules` with the lock derived from `<package-lock.json>` again, and exits 1
// naming every package that is missing, another version, or not locked at all. It refuses first,
// with the count, an application tree holding anything a Mac's tar added.
//
// **`verify` never reads the staged file.** It derives the lock from the committed one again, so
// a staged lock edited after it was written, or a later change to how `package.sh` installs,
// cannot make the build agree with itself about the wrong versions.
//
// **Why a lock of its own.** `package.sh` used to write a fresh `package.json` from caret ranges
// and run `npm install` beside it with no lock, so two packagings of one commit on different days
// could ship a different `fastify`, `pg` or `ssh2` under an identical `build.json`. The staged
// application is not the workspace, though: it has no `packages/`, no web UI and no development
// tools, so the root lock cannot be handed to `npm ci` as it is. This keeps every entry the
// runtime reaches, exactly as locked (version, `resolved`, `integrity`), and nothing else.
//
// **The workspace's layout, lifted.** npm nests a dependency under `packages/<name>/node_modules`
// when the root's copy is another version: `ajv` is 6 at the root, for eslint, and 8 under core
// and sensors. In the staged application those workspaces are gone, so their nested entries move
// to its top level. Every entry is resolved from where it sat, the way Node resolves it, and a
// path the staged tree would need for two different packages is refused with both named, rather
// than resolved to whichever came first.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Siblings `package.sh` stages and links itself; never fetched. */
const WORKSPACE_SCOPE = '@ms/';

/**
 * Where `name` resolves from the entry at `from`, in the root lock's layout: `from`'s own
 * `node_modules`, then each enclosing one, then the root's. A workspace directory's parent is the
 * root.
 */
function resolveIn(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (base === '') return undefined;
    const at = base.lastIndexOf('/node_modules/');
    base = at >= 0 ? base.slice(0, at) : '';
  }
}

/** A workspace's nested entries sit at the top of the staged tree; everything else stays put. */
function stagedPath(path) {
  const nested = /^packages\/[^/]+\/(node_modules\/.+)$/u.exec(path);
  return nested === null ? path : nested[1];
}

function sameLocked(a, b) {
  return a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity;
}

/**
 * The staged lock for an application whose `package.json` declares `dependencies`, drawn from
 * the workspaces named in `workspaces` (`packages/<name>` in the root lock).
 *
 * Throws, naming the package, when the runtime needs something the lock does not have, needs
 * something the lock marks as for development only, or needs two different packages at one path.
 */
export function stageLock(root, { name, version, dependencies }, workspaces) {
  if (root?.lockfileVersion !== 3 || typeof root.packages !== 'object') {
    throw new Error('package-lock.json is not a version 3 lockfile');
  }
  const packages = root.packages;
  const staged = { '': { name, version, dependencies } };
  const origin = new Map(); // staged path -> the root lock path it came from
  const queue = [];

  const need = (from, dependency, optional, why) => {
    if (dependency.startsWith(WORKSPACE_SCOPE)) return;
    const found = resolveIn(packages, from, dependency);
    const entry = found === undefined ? undefined : packages[found];
    if (entry === undefined || entry.link === true) {
      if (optional) return;
      throw new Error(`${dependency}, needed by ${why}, is not in package-lock.json`);
    }
    if (entry.dev === true) {
      if (optional) return;
      throw new Error(
        `${found} is locked as a development dependency, and ${why} needs it at runtime`,
      );
    }
    const path = stagedPath(found);
    const already = origin.get(path);
    if (already !== undefined) {
      if (already === found || sameLocked(packages[already], entry)) return;
      throw new Error(
        `the runtime needs ${found} (${entry.version}) and ${already} ` +
          `(${packages[already].version}) at the same place, ${path}`,
      );
    }
    origin.set(path, found);
    const { dev: _dev, devOptional, ...kept } = entry;
    staged[path] = devOptional === true ? { ...kept, optional: true } : kept;
    queue.push(found);
  };

  for (const workspace of workspaces) {
    const manifest = packages[`packages/${workspace}`];
    if (manifest === undefined)
      throw new Error(`packages/${workspace} is not in package-lock.json`);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      need(`packages/${workspace}`, dependency, false, `@ms/${workspace}`);
    }
  }
  for (const dependency of Object.keys(dependencies)) {
    if (!origin.has(`node_modules/${dependency}`)) {
      throw new Error(`${dependency} is in package.json but no workspace depends on it`);
    }
  }
  while (queue.length > 0) {
    const from = queue.shift();
    const entry = packages[from];
    for (const dependency of Object.keys(entry.dependencies ?? {})) {
      need(from, dependency, false, from);
    }
    for (const dependency of Object.keys(entry.optionalDependencies ?? {})) {
      need(from, dependency, true, from);
    }
    for (const dependency of Object.keys(entry.peerDependencies ?? {})) {
      need(from, dependency, entry.peerDependenciesMeta?.[dependency]?.optional === true, from);
    }
  }

  const ordered = Object.fromEntries(
    Object.entries(staged).sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : 1)),
  );
  return { name, version, lockfileVersion: 3, requires: true, packages: ordered };
}

/** The staged lock as `stage` writes it, byte for byte: what the hash is of. */
export function lockText(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** What `package.sh` stamps: the hash of the file exactly as written. */
export function lockHash(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Every difference between what is installed under `appDir` and `lock`, as sentences. Empty when
 * they agree.
 *
 * A locked package that is not installed is a difference unless the lock marks it optional: an
 * optional native package for another platform is skipped by `npm ci`, as it should be. A package
 * installed and not locked is a difference too. Symbolic links are not looked at, because the
 * workspace siblings `package.sh` links in are not dependencies.
 */
export function installedDifferences(lock, appDir) {
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    let installed;
    try {
      installed = JSON.parse(readFileSync(join(appDir, path, 'package.json'), 'utf8')).version;
    } catch {
      if (entry.optional !== true)
        problems.push(`${path} is locked at ${entry.version} and not installed`);
      continue;
    }
    if (installed !== entry.version) {
      problems.push(`${path} is ${installed}, and the lock says ${entry.version}`);
    }
  }
  const walk = (dir, relative) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const found of names) {
      if (found.name.startsWith('.') || !found.isDirectory()) continue;
      if (found.name.startsWith('@')) {
        walk(join(dir, found.name), `${relative}/${found.name}`);
        continue;
      }
      const path = `${relative}/${found.name}`.replace(/^\//u, '');
      if (lock.packages[path] === undefined) problems.push(`${path} is installed and not locked`);
      walk(join(dir, found.name, 'node_modules'), `${path}/node_modules`);
    }
  };
  walk(join(appDir, 'node_modules'), 'node_modules');
  return problems;
}

/**
 * Every entry under `dir` that a Mac's tar or zip added, as a path relative to `dir`: an
 * AppleDouble `._<name>`, written beside each file that has extended attributes, or a `__MACOSX`
 * directory, which is not looked inside. Symbolic links are not followed.
 *
 * None of them belongs in a release, and one is enough to stop the core. A release repacked on a
 * Mac for `H-20`'s own smoke test carried 17,847 of them, which macOS `tar -t` does not list and
 * GNU tar unpacks as files, and node-gyp-build loaded `._argon2.armv8.glibc.node` ahead of the
 * real one: the core died at start, before the check the run was for.
 */
export function macMetadataIn(dir) {
  const found = [];
  const walk = (at, relative) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name.startsWith('._') || entry.name === '__MACOSX') found.push(path);
      else if (entry.isDirectory()) walk(join(at, entry.name), path);
    }
  };
  walk(dir, '');
  return found.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, rootLock, appDir, ...workspaces] = process.argv.slice(2);
  if (
    !['stage', 'hash', 'verify'].includes(mode ?? '') ||
    rootLock === undefined ||
    appDir === undefined ||
    workspaces.length === 0
  ) {
    process.stderr.write(
      'usage: stage-lock.mjs stage|hash|verify <package-lock.json> <app-dir> <workspace>...\n',
    );
    process.exit(2);
  }
  const app = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  const lock = stageLock(
    JSON.parse(readFileSync(rootLock, 'utf8')),
    { name: app.name, version: app.version, dependencies: app.dependencies ?? {} },
    workspaces,
  );
  const text = lockText(lock);
  if (mode === 'verify') {
    const mac = macMetadataIn(appDir);
    if (mac.length > 0) {
      process.stderr.write(
        `${appDir} holds ${String(mac.length)} entries a Mac's tar added (._* or __MACOSX), ` +
          `the first ${String(mac[0])}: pack it on Linux, or with COPYFILE_DISABLE=1\n`,
      );
      process.exit(1);
    }
    const problems = installedDifferences(lock, appDir);
    if (problems.length > 0) {
      process.stderr.write(
        `the installed dependencies are not the locked ones:\n  ${problems.join('\n  ')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${String(Object.keys(lock.packages).length - 1)} packages, as locked\n`);
  } else {
    if (mode === 'stage') writeFileSync(join(appDir, 'package-lock.json'), text);
    process.stdout.write(`${lockHash(text)}\n`);
  }
}

import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * A package says exactly which code it is (`H-20`).
 *
 * `H-11` stamped each package with its commit, so that a field-test report names one body of
 * code. Three things broke that, and each is run here as the real script:
 *
 * - **`dist` was not rebuilt from the tree that was stamped.** `tsc -b` trusts timestamps and
 *   never deletes the output of a source that has gone.
 * - **Dirty detection failed open.** A `git status` that errored read as clean, `MS_BUILD_DIRTY`
 *   of `true` meant clean, and nothing asked again after a build of several minutes.
 * - **Dependencies were not pinned.** `npm install` from caret ranges with no lock: the candidate
 *   of 2026-09-28 shipped 29 of its 234 runtime packages at versions no suite had run against.
 *
 * `package.sh` runs here for real, in a repository made for the test, with `npm` replaced by a
 * stub that does what `npm` would to the files and records what it was asked. What it cannot show
 * is the real `npm ci` against the registry, and the smoke install is where that is proved.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const hasGit = spawnSync('git', ['--version']).status === 0;
const linux = process.platform === 'linux';

interface LockEntry {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly devOptional?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

interface Lock {
  readonly name?: string;
  readonly version?: string;
  readonly lockfileVersion: number;
  readonly requires?: boolean;
  readonly packages: Readonly<Record<string, LockEntry>>;
}

interface App {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

interface Stager {
  stageLock(root: Lock, app: App, workspaces: readonly string[]): Lock;
  lockText(lock: Lock): string;
  lockHash(text: string): string;
  installedDifferences(lock: Lock, appDir: string): string[];
  macMetadataIn(dir: string): string[];
}

const stager = (await import(
  pathToFileURL(join(repoRoot, 'scripts', 'lib', 'stage-lock.mjs')).href
)) as Stager;

const scratch = mkdtempSync(join(tmpdir(), 'ms-provenance-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let made = 0;
function freshDir(label: string): string {
  made += 1;
  const dir = join(scratch, `${label}-${String(made)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file: string, text: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, mode === undefined ? undefined : { mode });
}

/** `git` with nobody's configuration but the test's, as the scripts would see it on a runner. */
function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(files: Readonly<Record<string, string>>): string {
  const dir = freshDir('repo');
  for (const [path, text] of Object.entries(files)) write(join(dir, path), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** A directory of executables to put at the front of PATH. */
function stubs(files: Readonly<Record<string, string>>): string {
  const bin = freshDir('bin');
  for (const [name, body] of Object.entries(files)) {
    write(join(bin, name), `#!/usr/bin/env bash\n${body}`, 0o755);
  }
  return bin;
}

/** A `git` that answers everything but `status`, which it fails the way a locked index does. */
const BROKEN_STATUS_GIT = `
real="$(PATH="\${STUB_REAL_PATH}" command -v git)"
for arg in "$@"; do
  if [ "$arg" = status ]; then echo "fatal: Unable to create '.git/index.lock': File exists." >&2; exit 128; fi
done
exec "$real" "$@"
`;

/**
 * Asked the way every caller asks, as the condition of an `if`. Bash switches `set -e` off there,
 * inside the function too, and a first version that relied on it printed a clean state after
 * `git status` had failed.
 */
function treeState(
  dir: string,
  path: string = process.env['PATH'] ?? '',
  cwd?: string,
): SpawnSyncReturns<string> {
  const script = '. "$1"; if state="$(ms_tree_state "$2")"; then echo "$state"; else exit 3; fi';
  return spawnSync(
    'bash',
    ['-c', script, 'tree', join(repoRoot, 'scripts/lib/build-tree.sh'), dir],
    {
      encoding: 'utf8',
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, PATH: path, STUB_REAL_PATH: process.env['PATH'] ?? '' },
    },
  );
}

function stateOf(dir: string): { commit: string; dirty: string; fingerprint: string } {
  const result = treeState(dir);
  assert.equal(result.status, 0, result.stderr);
  const [commit = '', dirty = '', fingerprint = ''] = result.stdout.trim().split(' ');
  return { commit, dirty, fingerprint };
}

describe('what a checkout is (`H-20`)', { skip: hasGit ? false : 'git is not installed' }, () => {
  it('names the commit, and is clean when only ignored files differ', () => {
    const dir = repository({ '.gitignore': 'dist/\n', 'a.ts': 'one\n' });
    write(join(dir, 'dist', 'a.js'), 'compiled\n');
    const state = stateOf(dir);
    assert.equal(state.commit, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(state.dirty, '0');
    assert.match(state.fingerprint, /^[0-9a-f]{40}$/u);
  });

  it('answers from inside a checkout git cannot open, as the toolchain container sees a worktree', () => {
    // A worktree's `.git` is a file naming a path on the host. Inside the container that path is
    // not there, and git gives up on any command run beneath it, even one that needs no
    // repository. Every git the fingerprint runs names the repository it means.
    const dir = repository({ 'a.ts': 'one\n' });
    const worktree = freshDir('worktree');
    write(join(worktree, '.git'), 'gitdir: /no/such/host/path/.git/worktrees/w\n');
    const result = treeState(dir, process.env['PATH'] ?? '', worktree);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${stateOf(dir).commit} 0 ${stateOf(dir).fingerprint}`);
  });

  it('is dirty for an untracked file, which is compiled all the same', () => {
    const dir = repository({ 'a.ts': 'one\n' });
    write(join(dir, 'new.ts'), 'nobody added me\n');
    assert.equal(stateOf(dir).dirty, '1');
  });

  it('changes its fingerprint when a file already modified is edited again', () => {
    // `git status` reads ` M a.ts` both times. Being dirty before a build and after it says
    // nothing about whether the build compiled the tree that was stamped.
    const dir = repository({ 'a.ts': 'one\n', 'b.ts': 'two\n' });
    write(join(dir, 'a.ts'), 'edited\n');
    write(join(dir, 'u.ts'), 'untracked\n');
    const before = stateOf(dir);
    write(join(dir, 'a.ts'), 'edited again\n');
    const modified = stateOf(dir);
    assert.notEqual(modified.fingerprint, before.fingerprint, 'a modified file edited again');
    write(join(dir, 'u.ts'), 'untracked, edited\n');
    assert.notEqual(stateOf(dir).fingerprint, modified.fingerprint, 'an untracked file edited');
    assert.equal(stateOf(dir).fingerprint, stateOf(dir).fingerprint, 'and stable when nothing is');
  });

  it('fails, printing nothing, when git cannot say', () => {
    const dir = repository({ 'a.ts': 'one\n' });
    const bin = stubs({ git: BROKEN_STATUS_GIT });
    const result = treeState(dir, `${bin}:${process.env['PATH'] ?? ''}`);
    assert.equal(result.status, 3, 'refused, inside an if');
    assert.equal(result.stdout, '', 'no state at all rather than a clean one');
    assert.match(result.stderr, /index\.lock/u, "git's own words, not discarded");
  });
});

/** A root lock in the shape npm writes, for workspaces `core` and `probe`. */
function rootLock(extra: Readonly<Record<string, LockEntry>> = {}): Lock {
  const at = (name: string, version: string, more: Partial<LockEntry> = {}): LockEntry => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}${version}`,
    ...more,
  });
  return {
    name: 'monitoring-system',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'monitoring-system', version: '0.1.0' },
      'packages/core': {
        name: '@ms/core',
        version: '0.1.0',
        dependencies: { '@ms/shared': '*', ajv: '^8.0.0', fastify: '^5.0.0' },
      },
      'packages/probe': {
        name: '@ms/probe',
        version: '0.1.0',
        dependencies: { fastify: '^5.0.0' },
      },
      'node_modules/@ms/shared': { link: true, resolved: 'packages/shared' },
      // eslint's ajv at the root, and core's own nested beneath it: the case that is real.
      'node_modules/ajv': at('ajv', '6.12.6', { dev: true }),
      'packages/core/node_modules/ajv': at('ajv', '8.17.1', {
        dependencies: { 'fast-uri': '^3.0.0' },
      }),
      'node_modules/fast-uri': at('fast-uri', '3.0.6'),
      'node_modules/fastify': at('fastify', '5.2.0', {
        dependencies: { 'light-my-request': '^6.0.0', pino: '^9.0.0' },
        optionalDependencies: { 'absent-native': '^1.0.0' },
        peerDependencies: { typescript: '*' },
        peerDependenciesMeta: { typescript: { optional: true } },
      }),
      'node_modules/fastify/node_modules/light-my-request': at('light-my-request', '6.1.0'),
      'node_modules/light-my-request': at('light-my-request', '5.0.0', { dev: true }),
      'node_modules/pino': at('pino', '9.4.0', { devOptional: true }),
      'node_modules/typescript': at('typescript', '5.6.0', { dev: true }),
      ...extra,
    },
  };
}

const RUNTIME: App = {
  name: 'ms-runtime',
  version: '0.1.0',
  dependencies: { ajv: '^8.0.0', fastify: '^5.0.0' },
};

describe('the staged lock (`H-20`)', () => {
  it('keeps exactly what the runtime reaches, as locked, with the workspaces lifted', () => {
    const staged = stager.stageLock(rootLock(), RUNTIME, ['core', 'probe']);
    assert.deepEqual(Object.keys(staged.packages), [
      '',
      'node_modules/ajv',
      'node_modules/fast-uri',
      'node_modules/fastify',
      'node_modules/fastify/node_modules/light-my-request',
      'node_modules/pino',
    ]);
    assert.deepEqual(staged.packages[''], RUNTIME);
    // Core's ajv 8, lifted from under the workspace; eslint's 6 at the root is not needed.
    assert.equal(staged.packages['node_modules/ajv']?.version, '8.17.1');
    assert.equal(
      staged.packages['node_modules/fastify/node_modules/light-my-request']?.version,
      '6.1.0',
      'nested where npm nested it, not the root copy',
    );
    // Needed at runtime by one path and optional there, so optional, never dev.
    assert.deepEqual(
      {
        dev: staged.packages['node_modules/pino']?.dev,
        optional: staged.packages['node_modules/pino']?.optional,
      },
      { dev: undefined, optional: true },
    );
    assert.equal(
      staged.packages['node_modules/typescript'],
      undefined,
      'an optional peer only dev has',
    );
    assert.equal(staged.lockfileVersion, 3);
  });

  it('is the same bytes every time, so its hash identifies it', () => {
    const one = stager.lockText(stager.stageLock(rootLock(), RUNTIME, ['core', 'probe']));
    const two = stager.lockText(stager.stageLock(rootLock(), RUNTIME, ['probe', 'core']));
    assert.equal(one, two);
    assert.equal(stager.lockHash(one), `sha256:${createHash('sha256').update(one).digest('hex')}`);
  });

  it('refuses what it cannot stage honestly, naming the package', () => {
    const cases: [string, () => unknown, RegExp][] = [
      [
        'two versions at one path',
        () =>
          stager.stageLock(
            rootLock({
              'packages/probe': {
                name: '@ms/probe',
                version: '0.1.0',
                dependencies: { ajv: '^8.0.0' },
              },
              'packages/probe/node_modules/ajv': {
                version: '8.12.0',
                resolved: 'x',
                integrity: 'y',
              },
            }),
            RUNTIME,
            ['core', 'probe'],
          ),
        /ajv \(8\.1[27]\.\d\) and packages\/\w+\/node_modules\/ajv \(8\.1[27]\.\d\) at the same place, node_modules\/ajv/u,
      ],
      [
        'a runtime dependency locked for development',
        () =>
          stager.stageLock(
            rootLock({ 'node_modules/fast-uri': { version: '3.0.6', dev: true } }),
            RUNTIME,
            ['core'],
          ),
        /node_modules\/fast-uri is locked as a development dependency/u,
      ],
      [
        'a dependency the lock does not have',
        () =>
          stager.stageLock(
            rootLock({ 'node_modules/fast-uri': { version: '3.0.6', link: true } }),
            RUNTIME,
            ['core'],
          ),
        /fast-uri, needed by packages\/core\/node_modules\/ajv, is not in package-lock\.json/u,
      ],
      [
        'a package.json no workspace agrees with',
        () =>
          stager.stageLock(
            rootLock(),
            { ...RUNTIME, dependencies: { ...RUNTIME.dependencies, ssh2: '^1.0.0' } },
            ['core', 'probe'],
          ),
        /ssh2 is in package\.json but no workspace depends on it/u,
      ],
      [
        'a lock that is not version 3',
        () => stager.stageLock({ ...rootLock(), lockfileVersion: 2 }, RUNTIME, ['core']),
        /not a version 3 lockfile/u,
      ],
    ];
    for (const [what, stage, error] of cases) assert.throws(stage, error, what);
  });

  it('stages the committed lock for both packages, with nothing for development in it', () => {
    const committed = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as Lock;
    for (const workspaces of [
      ['shared', 'sensors', 'core', 'probe'],
      ['shared', 'sensors', 'probe'],
    ]) {
      const dependencies: Record<string, string> = {};
      for (const workspace of workspaces) {
        const manifest = JSON.parse(
          readFileSync(join(repoRoot, 'packages', workspace, 'package.json'), 'utf8'),
        ) as { dependencies?: Record<string, string> };
        for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
          if (!name.startsWith('@ms/')) dependencies[name] = range;
        }
      }
      const staged = stager.stageLock(
        committed,
        { name: 'ms-runtime', version: '0.1.0', dependencies },
        workspaces,
      );
      const entries = Object.entries(staged.packages).filter(([path]) => path !== '');
      assert.ok(entries.length > 50, `${workspaces.join(' ')}: ${String(entries.length)} entries`);
      for (const [path, entry] of entries) {
        assert.ok(entry.dev !== true && entry.devOptional !== true, `${path} is for development`);
        assert.ok(
          entry.integrity !== undefined && entry.resolved !== undefined,
          `${path} is pinned`,
        );
      }
    }
  });
});

describe('what was installed, read back against the lock (`H-20`)', () => {
  function installed(packages: Readonly<Record<string, string>>): string {
    const app = freshDir('app');
    for (const [path, version] of Object.entries(packages)) {
      write(join(app, path, 'package.json'), JSON.stringify({ name: path, version }));
    }
    return app;
  }
  const lock = stager.stageLock(rootLock(), RUNTIME, ['core', 'probe']);
  const exact = {
    'node_modules/ajv': '8.17.1',
    'node_modules/fast-uri': '3.0.6',
    'node_modules/fastify': '5.2.0',
    'node_modules/fastify/node_modules/light-my-request': '6.1.0',
    'node_modules/pino': '9.4.0',
  };

  it('agrees with an install that is exactly the lock, whatever links sit beside it', () => {
    const app = installed(exact);
    // What `package.sh` links in after the install: a workspace sibling, not a dependency.
    mkdirSync(join(app, 'node_modules', '@ms'), { recursive: true });
    symlinkSync(join(app, 'node_modules', 'fastify'), join(app, 'node_modules', '@ms', 'shared'));
    write(join(app, 'node_modules', '.package-lock.json'), '{}');
    assert.deepEqual(stager.installedDifferences(lock, app), []);
    // An optional package for another platform, skipped by npm ci, is not a difference.
    const { 'node_modules/pino': _pino, ...withoutOptional } = exact;
    assert.deepEqual(stager.installedDifferences(lock, installed(withoutOptional)), []);
  });

  it('names every version that is not the locked one, every missing one and every stray', () => {
    const app = installed({
      ...exact,
      'node_modules/fastify': '5.2.5',
      'node_modules/stray': '1.0.0',
      'node_modules/@scope/also-stray': '1.0.0',
    });
    rmSync(join(app, 'node_modules', 'fast-uri'), { recursive: true });
    assert.deepEqual(stager.installedDifferences(lock, app).sort(), [
      'node_modules/@scope/also-stray is installed and not locked',
      'node_modules/fast-uri is locked at 3.0.6 and not installed',
      'node_modules/fastify is 5.2.5, and the lock says 5.2.0',
      'node_modules/stray is installed and not locked',
    ]);
  });
});

/**
 * Counted the way `smoke-install.sh` counts, under its `set -euo pipefail` and inside a command
 * substitution, from a listing on stdin.
 */
function macCount(listing: string, redirect = ''): SpawnSyncReturns<string> {
  const script =
    'set -euo pipefail; . "$1"; ' +
    `if n="$(ms_mac_metadata_count ${redirect})"; then echo "$n"; else exit 3; fi`;
  return spawnSync('bash', ['-c', script, 'count', join(repoRoot, 'scripts/lib/mac-metadata.sh')], {
    encoding: 'utf8',
    input: listing,
  });
}

describe("what a Mac's tar leaves in a release (`H-20`)", () => {
  const listing = [
    'ms-0.1.0/',
    'ms-0.1.0/._app',
    'ms-0.1.0/app/node_modules/argon2/prebuilds/linux-arm64/argon2.armv8.glibc.node',
    'ms-0.1.0/app/node_modules/argon2/prebuilds/linux-arm64/._argon2.armv8.glibc.node',
    '__MACOSX/',
    '__MACOSX/ms-0.1.0/._bin',
    // Names that only look like it.
    'ms-0.1.0/app/node_modules/x/.npmignore',
    'ms-0.1.0/app/node_modules/x/_private.js',
    'ms-0.1.0/app/node_modules/x/a._b.js',
    'ms-0.1.0/app/node_modules/x/__MACOSX-notes.md',
    '',
  ].join('\n');

  it('counts every AppleDouble entry and everything in __MACOSX, and nothing else', () => {
    const result = macCount(listing);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '4');
  });

  it('prints 0 for a clean listing, which grep reports as no match and is not a failure', () => {
    const clean = listing
      .split('\n')
      .filter((line) => !/(^|\/)(\._|__MACOSX)/u.test(line))
      .join('\n');
    const result = macCount(clean);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0');
  });

  it('fails when the listing cannot be read', { skip: linux ? false : 'GNU grep' }, () => {
    // A directory on stdin: GNU grep says so and exits 2.
    const result = macCount('', '< /');
    assert.equal(result.status, 3, result.stdout);
  });

  it('counts what GNU tar lists from a real tarball', { skip: linux ? false : 'GNU tar' }, () => {
    const dir = freshDir('mac-tar');
    write(join(dir, 'ms-0.1.0', 'app', 'x.node'), 'ELF');
    write(join(dir, 'ms-0.1.0', 'app', '._x.node'), 'AppleDouble');
    write(join(dir, 'ms-0.1.0', '__MACOSX', 'app', '._y'), 'AppleDouble');
    const tarball = join(dir, 'release.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', dir, 'ms-0.1.0']).status, 0);
    const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    // `app/._x.node`, and `__MACOSX/`, `__MACOSX/app/` and `__MACOSX/app/._y`.
    assert.equal(macCount(listed.stdout).stdout.trim(), '4');
  });

  it('finds them in an unpacked tree, without looking inside __MACOSX or following links', () => {
    const app = freshDir('mac-tree');
    write(join(app, 'node_modules', 'argon2', 'prebuilds', 'argon2.node'), 'ELF');
    write(join(app, 'node_modules', 'argon2', 'prebuilds', '._argon2.node'), 'AppleDouble');
    write(join(app, '._node_modules'), 'AppleDouble');
    write(join(app, '__MACOSX', 'node_modules', '._argon2'), 'AppleDouble');
    write(join(app, 'node_modules', 'x', '.npmignore'), '');
    const elsewhere = freshDir('mac-elsewhere');
    write(join(elsewhere, '._outside'), 'AppleDouble');
    symlinkSync(elsewhere, join(app, 'node_modules', 'linked'));
    assert.deepEqual(stager.macMetadataIn(app), [
      '._node_modules',
      '__MACOSX',
      'node_modules/argon2/prebuilds/._argon2.node',
    ]);
  });

  it('makes verify refuse the tree, with the count, before it reads a version', () => {
    const dir = freshDir('mac-verify');
    const lockFile = join(dir, 'package-lock.json');
    writeFileSync(lockFile, JSON.stringify(rootLock()));
    const app = join(dir, 'app');
    write(join(app, 'package.json'), JSON.stringify(RUNTIME));
    const exact = {
      'node_modules/ajv': '8.17.1',
      'node_modules/fast-uri': '3.0.6',
      'node_modules/fastify': '5.2.0',
      'node_modules/fastify/node_modules/light-my-request': '6.1.0',
    };
    for (const [path, version] of Object.entries(exact)) {
      write(join(app, path, 'package.json'), JSON.stringify({ name: path, version }));
    }
    const verify = (): SpawnSyncReturns<string> =>
      spawnSync(
        'node',
        [join(repoRoot, 'scripts/lib/stage-lock.mjs'), 'verify', lockFile, app, 'core', 'probe'],
        { encoding: 'utf8' },
      );
    const agreed = verify();
    assert.equal(agreed.status, 0, agreed.stderr);
    assert.match(agreed.stdout, /^5 packages, as locked$/mu);

    write(join(app, 'node_modules', 'fastify', '._index.js'), 'AppleDouble');
    write(join(app, '__MACOSX', 'node_modules', '._fastify'), 'AppleDouble');
    const refused = verify();
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /holds 2 entries a Mac's tar added \(\._\* or __MACOSX\), the first __MACOSX:/u,
    );
    assert.doesNotMatch(refused.stderr, /not the locked ones/u);
  });
});

/**
 * `npm`, as `package.sh` uses it, doing to the files what the real one would. `STUB_EDIT` names
 * what to do wrong: `during-build`, `during-web` and `during-install` edit a tracked file while
 * that step runs; `wrong-version` installs another version than the lock's; `lock-after-staging`
 * edits the staged lock before installing from it; `lock-after-stamping` edits it once
 * `build.json` has recorded it.
 */
const NPM_STUB = `
echo "npm $*" >> "$STUB_LOG"
if [ "$1" = --prefix ]; then root="$2"; shift 2; fi
case "$1 \${2:-}" in
  "run clean") rm -rf "$root"/packages/*/dist; exit 0 ;;
  "run build")
    for pkg in shared sensors core probe; do
      mkdir -p "$root/packages/$pkg/dist/src"
      echo "export const built = '$pkg';" > "$root/packages/$pkg/dist/src/main.js"
    done
    [ "\${STUB_EDIT:-}" = during-build ] && echo "edited mid-build" >> "$root/README"
    exit 0 ;;
  "run build:web")
    mkdir -p "$root/packages/web/dist"
    echo '<div id="root"></div>' > "$root/packages/web/dist/index.html"
    [ "\${STUB_EDIT:-}" = during-web ] && echo "edited mid-build" >> "$root/README"
    [ "\${STUB_EDIT:-}" = lock-after-stamping ] && echo >> "$root/build/ms-9.9.9/app/package-lock.json"
    exit 0 ;;
esac
if [ "$1" = ci ]; then
  [ "\${STUB_EDIT:-}" = during-install ] && echo "# edited mid-install" >> "$STUB_ROOT/deploy/install.sh"
  node -e '
    const fs = require("node:fs");
    const edit = process.env.STUB_EDIT ?? "";
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    if (edit === "lock-after-staging") {
      lock.packages["node_modules/left-pad"].version = "1.3.1";
      fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\\n");
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === "") continue;
      fs.mkdirSync(path, { recursive: true });
      const version = edit === "wrong-version" ? "9.9.9" : entry.version;
      fs.writeFileSync(path + "/package.json", JSON.stringify({ name: path, version }));
    }'
  exit 0
fi
echo "stub npm: nothing to do for $*" >&2
exit 1
`;

/** A repository with everything `package.sh` reads, and one runtime dependency. */
function packagingRepository(): string {
  const workspace = (name: string, dependencies: Record<string, string> = {}): string =>
    JSON.stringify({ name: `@ms/${name}`, version: '0.1.0', dependencies });
  const lock: Lock = {
    name: 'monitoring-system',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'monitoring-system', version: '0.1.0' },
      'packages/shared': { name: '@ms/shared', version: '0.1.0' },
      'packages/sensors': { name: '@ms/sensors', version: '0.1.0' },
      'packages/core': {
        name: '@ms/core',
        version: '0.1.0',
        dependencies: { 'left-pad': '^1.3.0' },
      },
      'packages/probe': { name: '@ms/probe', version: '0.1.0' },
      'node_modules/left-pad': {
        version: '1.3.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: 'sha512-left-pad',
      },
    },
  };
  const dir = repository({
    '.gitignore': 'node_modules/\ndist/\n/build/\n/release/\n',
    README: 'a repository to package\n',
    'docs/README.md': 'what ships beside the package\n',
    'package.json': JSON.stringify({ name: 'monitoring-system', version: '0.1.0', private: true }),
    'package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
    'packages/shared/package.json': workspace('shared'),
    'packages/sensors/package.json': workspace('sensors'),
    'packages/core/package.json': workspace('core', { 'left-pad': '^1.3.0' }),
    'packages/probe/package.json': workspace('probe'),
  });
  // The real `deploy/`, whatever `package.sh` copies out of it this week.
  cpSync(join(repoRoot, 'deploy'), join(dir, 'deploy'), { recursive: true });
  for (const file of ['package.sh', 'lib/build-tree.sh', 'lib/stage-lock.mjs']) {
    cpSync(join(repoRoot, 'scripts', file), join(dir, 'scripts', file));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'the scripts');
  return dir;
}

interface Packaged {
  readonly result: SpawnSyncReturns<string>;
  readonly log: string;
  readonly stage: string;
}

function packageIn(
  dir: string,
  env: NodeJS.ProcessEnv = {},
  extraStubs: Readonly<Record<string, string>> = {},
  args: readonly string[] = [],
): Packaged {
  const log = join(dir, '..', `${String(made)}-npm.log`);
  writeFileSync(log, '');
  const bin = stubs({ npm: NPM_STUB, ...extraStubs });
  const result = spawnSync('bash', [join(dir, 'scripts', 'package.sh'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      STUB_LOG: log,
      STUB_REAL_PATH: process.env['PATH'] ?? '',
      STUB_ROOT: dir,
      MS_BUILD_VERSION: '9.9.9',
      ...env,
    },
  });
  return { result, log: readFileSync(log, 'utf8'), stage: join(dir, 'build', 'ms-9.9.9') };
}

function manifestOf(stage: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stage, 'app', 'core', 'build.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe(
  'package.sh (`H-20`)',
  { skip: hasGit && linux ? false : 'needs git, and the Linux tools package.sh uses' },
  () => {
    it('builds from clean, installs the lock, checks it, and stamps the commit and the lock', () => {
      const dir = packagingRepository();
      // A compiled file whose source is gone, left from an earlier build: `tsc -b` would keep it.
      write(join(dir, 'packages', 'core', 'dist', 'src', 'deleted-long-ago.js'), 'stale\n');
      const { result, log, stage } = packageIn(dir);
      assert.equal(result.status, 0, result.stderr);

      const asked = log.trim().split('\n');
      assert.ok(
        asked.indexOf(`npm --prefix ${dir} run clean`) >= 0 &&
          asked.indexOf(`npm --prefix ${dir} run clean`) <
            asked.indexOf(`npm --prefix ${dir} run build`),
        `clean before build: ${asked.join(' | ')}`,
      );
      assert.ok(
        asked.some((line) => line.startsWith('npm ci --omit=dev')),
        'npm ci, not install',
      );
      assert.ok(!asked.some((line) => /\binstall\b/u.test(line)), 'never npm install');
      assert.equal(
        existsSync(join(stage, 'app', 'core', 'dist', 'src', 'deleted-long-ago.js')),
        false,
      );

      const shipped = readFileSync(join(stage, 'app', 'package-lock.json'));
      assert.deepEqual(manifestOf(stage), {
        version: '9.9.9',
        commit: git(dir, 'rev-parse', 'HEAD'),
        dirty: false,
        profile: 'v1',
        lock: `sha256:${createHash('sha256').update(shipped).digest('hex')}`,
      });
      assert.match(result.stdout, /1 packages, as locked/u);
    });

    it('stamps an untracked file as uncommitted changes', () => {
      const dir = packagingRepository();
      write(join(dir, 'packages', 'core', 'src', 'nobody-added.ts'), 'export {};\n');
      const { result, stage } = packageIn(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(manifestOf(stage)['dirty'], true);
    });

    it('refuses a tree edited while it was being compiled', () => {
      const dir = packagingRepository();
      const { result } = packageIn(dir, { STUB_EDIT: 'during-build' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /the tree changed while it was being compiled/u);
      assert.deepEqual(
        existsSync(join(dir, 'release')) ? readdirSync(join(dir, 'release')) : [],
        [],
      );
    });

    it('refuses a tree edited while the web UI was built, or while anything else was copied', () => {
      // After compiling, the web build reads the tree, and so do the copies of `deploy/` and
      // `docs/` that follow the install. The last question covers those, and is the only one
      // after compiling for a probe package, which has no web UI.
      const web = packageIn(packagingRepository(), { STUB_EDIT: 'during-web' }).result;
      assert.notEqual(web.status, 0);
      assert.match(web.stderr, /the tree changed while it was being built into the web UI/u);
      const probe = packageIn(packagingRepository(), { STUB_EDIT: 'during-install' }, {}, [
        '--probe-only',
      ]).result;
      assert.notEqual(probe.status, 0);
      assert.match(probe.stderr, /the tree changed while it was being packaged/u);
    });

    it('refuses a package whose lock is not the one build.json recorded', () => {
      const { result } = packageIn(packagingRepository(), { STUB_EDIT: 'lock-after-stamping' });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /app\/package-lock\.json is sha256:\w+, and build\.json says sha256:/u,
      );
    });

    it('refuses, before building anything, when git cannot say whether the tree is clean', () => {
      const dir = packagingRepository();
      const { result, log } = packageIn(dir, {}, { git: BROKEN_STATUS_GIT });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot say whether its tree is clean/u);
      assert.match(result.stderr, /index\.lock/u, "git's reason is shown, not discarded");
      assert.equal(log, '', 'nothing was built');
    });

    it('refuses an MS_BUILD_DIRTY that is not 0 or 1, which used to read as clean', () => {
      const dir = packagingRepository();
      const commit = git(dir, 'rev-parse', 'HEAD');
      for (const value of ['true', 'yes', 'dirty']) {
        const { result, log } = packageIn(dir, { MS_BUILD_COMMIT: commit, MS_BUILD_DIRTY: value });
        assert.equal(result.status, 1, value);
        assert.match(result.stderr, /MS_BUILD_DIRTY must be 0 or 1/u, value);
        assert.equal(log, '', value);
      }
    });

    it('fails the build when what npm installed is not what is locked', () => {
      const dir = packagingRepository();
      const { result } = packageIn(dir, { STUB_EDIT: 'wrong-version' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /node_modules\/left-pad is 9\.9\.9, and the lock says 1\.3\.0/u);
    });

    it('fails the build when the staged lock changed before npm installed from it', () => {
      // The check reads the committed lock again rather than the staged file, so a staged lock
      // that was edited, and the install that followed it, cannot agree with each other and pass.
      const dir = packagingRepository();
      const { result } = packageIn(dir, { STUB_EDIT: 'lock-after-staging' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /node_modules\/left-pad is 1\.3\.1, and the lock says 1\.3\.0/u);
    });

    it('ships launchers whose own variables a config check does not report (`H-32`)', () => {
      // `/opt/ms/bin/ms-core` exports MS_BUILD_VERSION, and every start and every `config check`
      // on every installation listed it as a variable the operator set and the configuration
      // ignored. The launcher here is the one package.sh wrote, unchanged, in front of this
      // checkout's compiled services — the stub build's `main.js` is one line — and it checks the
      // example configuration the package ships.
      const { result, stage } = packageIn(packagingRepository());
      assert.equal(result.status, 0, result.stderr);
      const installed = mkdtempSync(join(tmpdir(), 'ms-launcher-'));
      mkdirSync(join(installed, 'bin'));
      mkdirSync(join(installed, 'app'));
      for (const svc of ['core', 'probe']) {
        cpSync(join(stage, 'bin', `ms-${svc}`), join(installed, 'bin', `ms-${svc}`));
        symlinkSync(join(repoRoot, 'packages', svc), join(installed, 'app', svc));
        const check = (env: NodeJS.ProcessEnv): SpawnSyncReturns<string> =>
          spawnSync(
            join(installed, 'bin', `ms-${svc}`),
            ['config', 'check', '--config', join(stage, 'etc', `${svc}.json`)],
            {
              encoding: 'utf8',
              timeout: 60_000,
              env: { PATH: process.env['PATH'] ?? '', HOME: installed, ...env },
            },
          );

        const clean = check({});
        assert.equal(clean.status, 0, `${svc}: ${clean.stdout}${clean.stderr}`);
        // The launcher's own version, which nothing else here sets: so the launcher ran.
        assert.match(
          clean.stdout,
          new RegExp(`^configuration is valid for ms-${svc} 9\\.9\\.9$`, 'mu'),
        );
        assert.doesNotMatch(clean.stdout, /ignored MS_/u, svc);

        // And a variable an operator misspelt is still named, beside the launcher's.
        const typo = check({ MS_DATABSE__PASSWORD: 'a typo' });
        assert.equal(typo.status, 0, `${svc}: ${typo.stdout}${typo.stderr}`);
        assert.match(typo.stdout, /^ {2}ignored MS_\* {4}MS_DATABSE__PASSWORD$/mu, svc);
      }
    });
  },
);

describe('the clean step package.sh relies on', () => {
  it('removes every package’s dist, not only what tsc would write', () => {
    // `tsc -b --clean` deletes the outputs it would produce, so the output of a deleted source
    // survives it. What package.sh calls has to remove the directories.
    const scripts = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    assert.match(scripts['clean'] ?? '', /rm -rf packages\/\*\/dist/u);
  });
});

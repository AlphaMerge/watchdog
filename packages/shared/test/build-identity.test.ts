import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  DEVELOPMENT_PROFILE,
  DEVELOPMENT_VERSION,
  describeBuild,
  isExactBuild,
  parseBuildManifest,
  readBuildStamp,
} from '../src/index.js';

/**
 * Which build this is (`H-11`).
 *
 * Every build said `0.1.0`. The failure worth guarding against now is the quiet one: a manifest
 * that is present and wrong being read as "unknown" or, worse, as something it is not — a short
 * or mistyped commit that names no code, accepted because it looked like one.
 *
 * And what it contains (`H-12`): a v1 build must never become the full one because its stamp
 * went missing, or because somebody set an environment variable.
 */

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const LOCK = `sha256:${'ab'.repeat(32)}`;

describe('the build manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-build-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const at = (name: string): URL => pathToFileURL(join(dir, name));

  it('reads what the packaging step wrote', () => {
    writeFileSync(
      join(dir, 'exact.json'),
      JSON.stringify({
        version: '1.0.0-rc.1',
        commit: COMMIT,
        dirty: false,
        profile: 'v1',
        lock: LOCK,
      }),
    );
    assert.deepEqual(readBuildStamp(at('exact.json'), {}), {
      version: '1.0.0-rc.1',
      commit: COMMIT,
      dirty: false,
      profile: 'v1',
      lock: LOCK,
    });
  });

  it('takes the profile from the manifest and never from the environment', () => {
    writeFileSync(
      join(dir, 'v1.json'),
      JSON.stringify({
        version: '1.0.0-rc.1',
        commit: COMMIT,
        dirty: false,
        profile: 'v1',
        lock: LOCK,
      }),
    );
    // The overlay an operator could set: it must not turn a v1 package into the full one.
    const stamp = readBuildStamp(at('v1.json'), {
      MS_BUILD_PROFILE: 'full',
      MS_BUILD_VERSION: '9.9.9',
    });
    assert.equal(stamp.profile, 'v1');
    assert.equal(stamp.version, '1.0.0-rc.1');
  });

  it('is a working tree when there is no manifest, and does not guess a commit', () => {
    assert.deepEqual(readBuildStamp(at('absent.json'), {}), {
      version: DEVELOPMENT_VERSION,
      commit: null,
      dirty: false,
      profile: DEVELOPMENT_PROFILE,
      lock: null,
    });
    // A harness may still label a run; that is a version, never a commit.
    assert.deepEqual(readBuildStamp(at('absent.json'), { MS_BUILD_VERSION: '9.9.9' }), {
      version: '9.9.9',
      commit: null,
      dirty: false,
      profile: DEVELOPMENT_PROFILE,
      lock: null,
    });
  });

  it('builds everything from a working tree, unless a test asks for v1', () => {
    assert.equal(DEVELOPMENT_PROFILE, 'full');
    assert.equal(readBuildStamp(at('absent.json'), { MS_BUILD_PROFILE: 'v1' }).profile, 'v1');
    assert.throws(
      () => readBuildStamp(at('absent.json'), { MS_BUILD_PROFILE: 'V1' }),
      /MS_BUILD_PROFILE names a profile this build does not know: "V1"/,
    );
  });

  it('refuses a manifest that is present and damaged, rather than starting unidentified', () => {
    writeFileSync(join(dir, 'torn.json'), '{"version": "1.0.0", "commi');
    assert.throws(() => readBuildStamp(at('torn.json'), {}), /torn\.json is not JSON/);
  });

  it('refuses what is not a build identity', () => {
    const v1 = { profile: 'v1', lock: LOCK };
    const cases: [unknown, RegExp][] = [
      [[], /expected an object/],
      [{ commit: COMMIT, dirty: false, ...v1 }, /no version/],
      [{ version: ' ', commit: COMMIT, dirty: false, ...v1 }, /no version/],
      // Short, upper-case and padded ids all look like commits and name none exactly.
      [{ version: '1', commit: COMMIT.slice(0, 12), dirty: false, ...v1 }, /not a full commit id/],
      [{ version: '1', commit: COMMIT.toUpperCase(), dirty: false, ...v1 }, /not a full commit id/],
      [{ version: '1', commit: ` ${COMMIT}`, dirty: false, ...v1 }, /not a full commit id/],
      [{ version: '1', commit: COMMIT, ...v1 }, /whether the tree was modified/],
      [{ version: '1', commit: COMMIT, dirty: 'no', ...v1 }, /whether the tree was modified/],
      // A package from before `H-12`, and one naming a profile nobody defined. Neither is `full`.
      [{ version: '1', commit: COMMIT, dirty: false, lock: LOCK }, /which profile it was built as/],
      [
        { version: '1', commit: COMMIT, dirty: false, profile: 'v2', lock: LOCK },
        /profile .* not know: "v2"/,
      ],
      [{ version: '1', commit: COMMIT, dirty: false, profile: null, lock: LOCK }, /not know: null/],
      // A package from before `H-20`, and locks that are not a sha256 of anything (`H-20`).
      [{ version: '1', commit: COMMIT, dirty: false, profile: 'v1' }, /which lock .*: undefined/],
      [{ version: '1', commit: COMMIT, dirty: false, profile: 'v1', lock: null }, /which lock/],
      [{ ...v1, version: '1', commit: COMMIT, dirty: false, lock: LOCK.slice(7) }, /which lock/],
      [{ ...v1, version: '1', commit: COMMIT, dirty: false, lock: `${LOCK}0` }, /which lock/],
      [
        { ...v1, version: '1', commit: COMMIT, dirty: false, lock: LOCK.toUpperCase() },
        /which lock/,
      ],
    ];
    for (const [manifest, error] of cases) {
      assert.throws(
        () => parseBuildManifest(JSON.stringify(manifest), 'm.json'),
        error,
        JSON.stringify(manifest),
      );
    }
  });

  it('accepts an unknown commit, which is an honest answer', () => {
    assert.deepEqual(
      parseBuildManifest(
        JSON.stringify({
          version: '1.0.0',
          commit: null,
          dirty: false,
          profile: 'full',
          lock: LOCK,
        }),
        'm',
      ),
      { version: '1.0.0', commit: null, dirty: false, profile: 'full', lock: LOCK },
    );
  });
});

describe('an exact build', () => {
  it('is a commit with nothing on top of it', () => {
    assert.equal(isExactBuild({ version: '1.0.0', commit: COMMIT, dirty: false }), true);
    // Uncommitted changes: the commit names the nearest code, not this code.
    assert.equal(isExactBuild({ version: '1.0.0', commit: COMMIT, dirty: true }), false);
    assert.equal(isExactBuild({ version: '1.0.0', commit: null, dirty: false }), false);
  });
});

describe('describing a build', () => {
  it('says what it knows, and says when it does not', () => {
    assert.equal(
      describeBuild({
        version: '1.0.0-rc.1',
        commit: COMMIT,
        dirty: false,
        profile: 'v1',
        lock: LOCK,
      }),
      '1.0.0-rc.1 (v1 profile, commit 0123456789ab)',
    );
    assert.equal(
      describeBuild({
        version: '1.0.0-rc.1',
        commit: COMMIT,
        dirty: true,
        profile: 'v1',
        lock: LOCK,
      }),
      '1.0.0-rc.1 (v1 profile, commit 0123456789ab, with uncommitted changes)',
    );
    assert.equal(
      describeBuild({
        version: DEVELOPMENT_VERSION,
        commit: null,
        dirty: false,
        profile: 'full',
        lock: null,
      }),
      '0.0.0-dev (full profile, commit unknown)',
    );
  });
});

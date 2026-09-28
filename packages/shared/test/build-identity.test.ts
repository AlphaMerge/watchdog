import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  DEVELOPMENT_VERSION,
  describeBuild,
  isExactBuild,
  parseBuildManifest,
  readBuildIdentity,
} from '../src/index.js';

/**
 * Which build this is (`H-11`).
 *
 * Every build said `0.1.0`. The failure worth guarding against now is the quiet one: a manifest
 * that is present and wrong being read as "unknown" or, worse, as something it is not — a short
 * or mistyped commit that names no code, accepted because it looked like one.
 */

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('the build manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-build-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const at = (name: string): URL => pathToFileURL(join(dir, name));

  it('reads what the packaging step wrote', () => {
    writeFileSync(
      join(dir, 'exact.json'),
      JSON.stringify({ version: '1.0.0-rc.1', commit: COMMIT, dirty: false }),
    );
    assert.deepEqual(readBuildIdentity(at('exact.json'), {}), {
      version: '1.0.0-rc.1',
      commit: COMMIT,
      dirty: false,
    });
  });

  it('is a working tree when there is no manifest, and does not guess a commit', () => {
    assert.deepEqual(readBuildIdentity(at('absent.json'), {}), {
      version: DEVELOPMENT_VERSION,
      commit: null,
      dirty: false,
    });
    // A harness may still label a run; that is a version, never a commit.
    assert.deepEqual(readBuildIdentity(at('absent.json'), { MS_BUILD_VERSION: '9.9.9' }), {
      version: '9.9.9',
      commit: null,
      dirty: false,
    });
  });

  it('refuses a manifest that is present and damaged, rather than starting unidentified', () => {
    writeFileSync(join(dir, 'torn.json'), '{"version": "1.0.0", "commi');
    assert.throws(() => readBuildIdentity(at('torn.json'), {}), /torn\.json is not JSON/);
  });

  it('refuses what is not a build identity', () => {
    const cases: [unknown, RegExp][] = [
      [[], /expected an object/],
      [{ commit: COMMIT, dirty: false }, /no version/],
      [{ version: ' ', commit: COMMIT, dirty: false }, /no version/],
      // Short, upper-case and padded ids all look like commits and name none exactly.
      [{ version: '1.0.0', commit: COMMIT.slice(0, 12), dirty: false }, /not a full commit id/],
      [{ version: '1.0.0', commit: COMMIT.toUpperCase(), dirty: false }, /not a full commit id/],
      [{ version: '1.0.0', commit: ` ${COMMIT}`, dirty: false }, /not a full commit id/],
      [{ version: '1.0.0', commit: COMMIT }, /whether the tree was modified/],
      [{ version: '1.0.0', commit: COMMIT, dirty: 'no' }, /whether the tree was modified/],
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
      parseBuildManifest(JSON.stringify({ version: '1.0.0', commit: null, dirty: false }), 'm'),
      { version: '1.0.0', commit: null, dirty: false },
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
      describeBuild({ version: '1.0.0-rc.1', commit: COMMIT, dirty: false }),
      '1.0.0-rc.1 (commit 0123456789ab)',
    );
    assert.equal(
      describeBuild({ version: '1.0.0-rc.1', commit: COMMIT, dirty: true }),
      '1.0.0-rc.1 (commit 0123456789ab, with uncommitted changes)',
    );
    assert.equal(
      describeBuild({ version: DEVELOPMENT_VERSION, commit: null, dirty: false }),
      '0.0.0-dev (commit unknown)',
    );
  });
});

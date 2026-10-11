import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { BuildStamp } from '@ms/shared';
import { passIsDue, recordPass, rulesDigest } from '../src/db/startup-pass.js';
import { declaredPrimaryRules } from '../src/state/declared-primary.js';

/**
 * The start-up pass markers without a database (`P-333`). What each pass does with them is
 * `declared-limits.test.ts` and `declared-primary.test.ts`.
 */

const exact: BuildStamp = {
  version: '1.0.0',
  commit: 'a'.repeat(40),
  dirty: false,
  profile: 'v1',
  lock: 'sha256:abc',
};

describe('the declared-primary marker is the exact build (P-333)', () => {
  it('is nothing for a build that cannot say exactly what it is', () => {
    assert.equal(declaredPrimaryRules({ ...exact, commit: null }), null, 'a working tree');
    assert.equal(declaredPrimaryRules({ ...exact, dirty: true }), null, 'uncommitted changes');
  });

  it('changes with the commit, the profile and the lock, and not with the version alone', () => {
    const rules = declaredPrimaryRules(exact);
    assert.ok(rules !== null);
    for (const [what, build] of [
      ['commit', { ...exact, commit: 'b'.repeat(40) }],
      ['profile', { ...exact, profile: 'full' }],
      ['lock', { ...exact, lock: 'sha256:def' }],
    ] as const) {
      assert.notEqual(declaredPrimaryRules(build), rules, what);
    }
    assert.equal(declaredPrimaryRules({ ...exact, version: '1.0.1' }), rules);
    assert.ok(rules.length <= 200, 'fits the column');
  });
});

describe('a pass with no rules to record (P-333)', () => {
  const never = {
    query: () => Promise.reject(new Error('asked the database')),
  };

  it('is due, and records nothing, without asking the database', async () => {
    const pass = { name: 'declared-primary', rules: null };
    assert.equal(await passIsDue(never, pass), true);
    await recordPass(never, pass);
  });

  it('digests to a short string that differs with the value', () => {
    assert.match(rulesDigest([1, 'a']), /^sha256:[\w-]{43}$/u);
    assert.notEqual(rulesDigest([1, 'a']), rulesDigest([1, 'b']));
  });
});

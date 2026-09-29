import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSplittable,
  CREDENTIAL_KINDS,
  isRestricted,
  restrictionOf,
  widenedFields,
  type CredentialKindDefinition,
} from '../src/credentials/index.js';
import { acceptedHostKeys } from '../src/support/ssh/credentials.js';

/**
 * Where a credential set may go (`A-41b`): what bounds it, and which writes widen the bound.
 */

describe('what bounds a credential set (A-41b)', () => {
  it('gives every kind allowed targets, and binds every secret to them', () => {
    for (const kind of CREDENTIAL_KINDS) {
      const properties = (kind.schema as { properties: Record<string, unknown> }).properties;
      assert.ok('allowedTargets' in properties, kind.id);
      assert.doesNotThrow(() => {
        assertSplittable(kind);
      }, kind.id);
    }
  });

  it('refuses a kind that leaves a secret unbound, binds one to nothing it declares, or binds a non-secret', () => {
    const ssh = CREDENTIAL_KINDS.find((kind) => kind.id === 'ssh') as CredentialKindDefinition;
    const unbound = { ...ssh, secretDestinations: { password: ['allowedTargets'] } };
    assert.throws(() => {
      assertSplittable(unbound);
    }, /does not bind its secret "privateKey"/);
    const unrelated = {
      ...ssh,
      secretDestinations: { ...ssh.secretDestinations, password: ['hostKeys'] },
    };
    assert.throws(() => {
      assertSplittable(unrelated);
    }, /"password" to allowedTargets/);
    const undeclared = {
      ...ssh,
      secretDestinations: { ...ssh.secretDestinations, password: ['allowedTargets', 'port'] },
    };
    assert.throws(() => {
      assertSplittable(undeclared);
    }, /binds "password" to port/);
    const extra = {
      ...ssh,
      secretDestinations: { ...ssh.secretDestinations, username: ['allowedTargets'] },
    };
    assert.throws(() => {
      assertSplittable(extra);
    }, /"username" .* not one of its secrets/);
  });

  it('reads the targets, and SSH’s keys only when some are listed and checked strictly', () => {
    assert.deepEqual(restrictionOf('snmp', {}), { targets: [], hostKeys: null });
    assert.deepEqual(restrictionOf('snmp', { allowedTargets: [' 10.0.0.0/8 ', ''] }), {
      targets: ['10.0.0.0/8'],
      hostKeys: null,
    });
    // The one fingerprint a set held before A-41b is the probe's to check, and delegates nothing.
    assert.equal(restrictionOf('ssh', { hostKeyFingerprint: 'SHA256:a' }).hostKeys, null);
    assert.deepEqual(
      restrictionOf('ssh', { hostKeyFingerprint: 'SHA256:a', hostKeys: ['SHA256:b'] }).hostKeys,
      ['SHA256:a', 'SHA256:b'],
    );
    assert.equal(
      restrictionOf('ssh', { hostKeys: ['SHA256:b'], hostKeyPolicy: 'accept-any' }).hostKeys,
      null,
    );
    assert.equal(restrictionOf('http', { hostKeys: ['SHA256:b'] }).hostKeys, null);
    assert.equal(isRestricted(restrictionOf('ssh', { hostKeys: ['SHA256:b'] })), true);
    assert.equal(isRestricted(restrictionOf('mail', { allowedTargets: ['a.test'] })), true);
    assert.equal(isRestricted(restrictionOf('mail', { allowedTargets: [] })), false);
  });

  it('puts the set’s keys together in one place, each once', () => {
    assert.deepEqual(
      acceptedHostKeys({
        hostKeyFingerprint: ' SHA256:a ',
        hostKeys: ['SHA256:b', 'SHA256:a', '', 7, ' SHA256:c'],
      }),
      ['SHA256:a', 'SHA256:b', 'SHA256:c'],
    );
    assert.deepEqual(acceptedHostKeys({}), []);
  });
});

describe('which writes widen where a set may go (A-41b)', () => {
  const targets = (...entries: string[]) => ({ allowedTargets: entries });
  const cases: readonly (readonly [
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    readonly string[],
  ])[] = [
    ['adding targets to a set with none narrows it', {}, targets('10.0.0.0/8'), []],
    ['removing one narrows it', targets('a.test', 'b.test'), targets('a.test'), []],
    [
      'the same entries, spelt differently, move nothing',
      targets('A.Test.'),
      targets('a.test'),
      [],
    ],
    [
      'an IPv4 address rewritten as IPv6 is the same entry',
      targets('10.0.0.1'),
      targets('::ffff:10.0.0.1'),
      [],
    ],
    ['adding one widens it', targets('a.test'), targets('a.test', 'b.test'), ['allowedTargets']],
    ['emptying the list widens it', targets('a.test'), targets(), ['allowedTargets']],
    ['leaving the list out widens it', targets('a.test'), {}, ['allowedTargets']],
    [
      'an entry inside an old range still widens it',
      targets('10.0.0.0/8'),
      targets('10.1.0.0/16'),
      ['allowedTargets'],
    ],
    ['a set with none has nothing to widen', {}, {}, []],
  ];
  for (const [name, before, after, widened] of cases) {
    it(name, () => {
      assert.deepEqual(widenedFields('database', before, after), widened);
    });
  }

  const KEYS = ['hostKeys', 'hostKeyFingerprint', 'hostKeyPolicy'];
  const keyCases: readonly (readonly [
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    readonly string[],
  ])[] = [
    ['listing keys where there were none narrows it', {}, { hostKeys: ['SHA256:a'] }, []],
    [
      'removing a key narrows it',
      { hostKeys: ['SHA256:a', 'SHA256:b'] },
      { hostKeys: ['SHA256:a'] },
      [],
    ],
    [
      'adding a key widens it',
      { hostKeys: ['SHA256:a'] },
      { hostKeys: ['SHA256:a', 'SHA256:b'] },
      KEYS,
    ],
    [
      'adding the one fingerprint widens it too',
      { hostKeys: ['SHA256:a'] },
      { hostKeys: ['SHA256:a'], hostKeyFingerprint: 'SHA256:b' },
      KEYS,
    ],
    [
      'turning strict checking off widens it',
      { hostKeys: ['SHA256:a'] },
      { hostKeys: ['SHA256:a'], hostKeyPolicy: 'accept-any' },
      KEYS,
    ],
    ['emptying the list widens it', { hostKeys: ['SHA256:a'] }, { hostKeys: [] }, KEYS],
    [
      'a fingerprint changed without a list is the probe’s check, not a bound',
      { hostKeyFingerprint: 'SHA256:a' },
      { hostKeyFingerprint: 'SHA256:b' },
      [],
    ],
  ];
  for (const [name, before, after, widened] of keyCases) {
    it(`SSH: ${name}`, () => {
      assert.deepEqual(widenedFields('ssh', before, after), widened);
    });
  }
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  capabilitiesFor,
  describeSkew,
  explainSkew,
  missingCapabilities,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  versionFor,
} from '../src/index.js';

/**
 * Version skew (`R-06`).
 *
 * **The interesting case is the middle one.** Incompatible is loud by construction — the link
 * closes — and current is silence. `outdated` is the one this exists for: a probe that connects,
 * heartbeats, passes every health check the system has, and is refused every feature it would
 * need to do any work. Nothing about that is visible unless something says it, so what is under
 * test here is mostly that something says it, in words, naming both versions.
 */

describe('what a protocol version can do', () => {
  it('grants nothing to a version below the first capability', () => {
    const capabilities = capabilitiesFor(1);
    assert.deepEqual(capabilities, {
      configPush: false,
      discoverySweep: false,
      identification: false,
      approval: false,
    });
  });

  it('grants everything to this build’s own version', () => {
    const capabilities = capabilitiesFor(PROTOCOL_VERSION);
    assert.equal(
      Object.values(capabilities).every((granted) => granted),
      true,
      'a peer speaking exactly what this build speaks is not missing anything',
    );
  });

  it('is cumulative: a later version keeps every earlier capability', () => {
    for (let version = MIN_PROTOCOL_VERSION; version < PROTOCOL_VERSION; version += 1) {
      const lower = capabilitiesFor(version);
      const higher = capabilitiesFor(version + 1);
      for (const [name, granted] of Object.entries(lower)) {
        if (!granted) continue;
        assert.equal(
          higher[name as keyof typeof higher],
          true,
          `protocol ${String(version + 1)} lost ${name}, which ${String(version)} had`,
        );
      }
    }
  });

  it('grants nothing to a version that is not a whole number', () => {
    // The wire schema says integer, so this is a peer that lied or a value read from somewhere
    // that did not validate. Granting a capability on `3.5 >= 3` would be the wrong direction to
    // be wrong in.
    assert.equal(capabilitiesFor(3.5).configPush, false);
    assert.equal(capabilitiesFor(Number.NaN).configPush, false);
  });

  it('agrees with the version each capability says it needs', () => {
    for (const name of ['configPush', 'discoverySweep', 'identification', 'approval'] as const) {
      const needed = versionFor(name);
      assert.equal(capabilitiesFor(needed)[name], true, `${name} should exist at ${String(needed)}`);
      assert.equal(
        capabilitiesFor(needed - 1)[name],
        false,
        `${name} should not exist at ${String(needed - 1)}`,
      );
    }
  });

  it('names what is missing oldest first, so the worst news comes first', () => {
    const missing = missingCapabilities(1);
    assert.equal(missing.length, 4);
    assert.match(missing[0] ?? '', /sensors to scan/, 'scanning nothing outranks everything else');
  });

  it('names nothing as missing for the current version', () => {
    assert.deepEqual(missingCapabilities(PROTOCOL_VERSION), []);
  });
});

describe('describing a version skew', () => {
  it('says nothing is wrong when the peer matches', () => {
    const skew = describeSkew(PROTOCOL_VERSION);
    assert.equal(skew.kind, 'current');
  });

  it('calls a compatible-but-old peer outdated, not incompatible', () => {
    // This is the distinction the whole ticket rests on. Such a peer connects and works; it is
    // simply refused features, and closing its link would be a worse outcome than the skew.
    const skew = describeSkew(2);
    assert.equal(skew.kind, 'outdated');
    assert.equal(skew.missing.length > 0, true);
  });

  it('refuses a peer older than this build understands', () => {
    const skew = describeSkew(MIN_PROTOCOL_VERSION - 1);
    assert.equal(skew.kind, 'incompatible');
  });

  it('refuses a peer from the future rather than guessing', () => {
    // The newer end knows messages this build has never seen. Treating its silence about them
    // as agreement is how a version skew becomes a data-loss bug, so the refusal says which end
    // to upgrade.
    const skew = describeSkew(PROTOCOL_VERSION + 1);
    assert.equal(skew.kind, 'incompatible');
    assert.match(explainSkew(skew), /upgrade this end/);
  });

  it('refuses a version that is not a whole number', () => {
    assert.equal(describeSkew(2.5).kind, 'incompatible');
  });

  it('names both versions in every explanation, because one on its own is unactionable', () => {
    const outdated = explainSkew(describeSkew(2));
    assert.match(outdated, /protocol 2/);
    assert.match(outdated, new RegExp(String(PROTOCOL_VERSION)));
    assert.match(outdated, /cannot be sent sensors to scan/);
  });

  it('explains an absence of evidence as an absence, not as protocol zero', () => {
    assert.match(explainSkew({ kind: 'unknown' }), /has not connected/);
  });

  it('explains a current peer without implying anything is wrong', () => {
    assert.match(explainSkew(describeSkew(PROTOCOL_VERSION)), /the same as this build/);
  });

  it('lists several missing capabilities readably rather than as a bare join', () => {
    const skew = describeSkew(3);
    assert.equal(skew.kind, 'outdated');
    assert.match(explainSkew(skew), /, nor /, 'more than one gap reads as a sentence');
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  capabilitiesFor,
  describeSkew,
  explainSkew,
  healthForPeer,
  isProtocolCompatible,
  missingCapabilities,
  negotiatedVersion,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  versionFor,
  type ProbeHealthReport,
} from '../src/index.js';
import { PROBE_HEALTH_FIELDS } from '../src/protocol/messages.js';

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
    // **Every capability listed, not a subset**, which is the point of `deepEqual` here: a new
    // one added to the interface and forgotten in `capabilitiesFor` would be `undefined` for
    // every peer, and `undefined` is falsy — so a subset check would pass while a probe was
    // refused a feature it should have had.
    assert.deepEqual(capabilities, {
      configPush: false,
      discoverySweep: false,
      identification: false,
      approval: false,
      healthReporting: false,
      onDemandQuery: false,
      chunkedPushFinal: false,
      resultSendTime: false,
      machineMemory: false,
      memoryLimit: false,
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
    for (const name of [
      'configPush',
      'discoverySweep',
      'identification',
      'approval',
      'healthReporting',
    ] as const) {
      const needed = versionFor(name);
      assert.equal(
        capabilitiesFor(needed)[name],
        true,
        `${name} should exist at ${String(needed)}`,
      );
      assert.equal(
        capabilitiesFor(needed - 1)[name],
        false,
        `${name} should not exist at ${String(needed - 1)}`,
      );
    }
  });

  it('names what is missing oldest first, so the worst news comes first', () => {
    const missing = missingCapabilities(1);
    // Every capability there is: a protocol-1 peer has none of them. Counted from the table
    // rather than written as a literal, so adding one does not make this a two-line change with
    // a number nobody looks at.
    assert.equal(missing.length, Object.keys(capabilitiesFor(PROTOCOL_VERSION)).length);
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

  it('serves a peer from the future at this build-s version, and says which end to upgrade', () => {
    // **`P-178` reversed this, and the reason is worth keeping.** It used to be `incompatible`:
    // the newer end knows messages this build has never seen, and treating its silence about
    // them as agreement is how a skew becomes a data-loss bug. That held while version numbers
    // were compared inline at each send site. Every feature is gated through `capabilitiesFor`
    // now, and both ends gate on the *negotiated* version — so the newer end never sends the
    // older one a field it cannot parse, and the refusal had stopped protecting anything while
    // costing a lockstep fleet upgrade on every bump.
    const skew = describeSkew(PROTOCOL_VERSION + 1);
    assert.equal(skew.kind, 'ahead');
    assert.match(explainSkew(skew), /newer than this build/);
    assert.match(explainSkew(skew), /until this end is upgraded/);
  });

  it('still refuses a peer below the floor, which is a real one', () => {
    // The floor is not a feature gate: below `MIN_PROTOCOL_VERSION` there is no shared language
    // to negotiate down to.
    assert.equal(describeSkew(MIN_PROTOCOL_VERSION - 1).kind, 'incompatible');
    assert.equal(isProtocolCompatible(MIN_PROTOCOL_VERSION - 1), false);
    assert.equal(isProtocolCompatible(PROTOCOL_VERSION + 5), true, 'but ahead is compatible');
  });

  it('negotiates down to the older of the two versions, at both ends', () => {
    // The number every capability gate reads. Both ends compute it independently from the
    // other's declared version, so they arrive at the same answer with no extra round trip.
    assert.equal(negotiatedVersion(PROTOCOL_VERSION + 3), PROTOCOL_VERSION, 'a newer peer');
    assert.equal(negotiatedVersion(MIN_PROTOCOL_VERSION), MIN_PROTOCOL_VERSION, 'an older peer');
    assert.equal(negotiatedVersion(PROTOCOL_VERSION), PROTOCOL_VERSION, 'the same build');
    assert.equal(
      negotiatedVersion(0),
      MIN_PROTOCOL_VERSION,
      'and nonsense floors rather than throws',
    );
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

describe('the health a peer can be sent', () => {
  // `P-208`. The first health field since `P-178` served a newer probe at an older core's version
  // instead of refusing it, so the first time a probe has had to leave health fields out. An older
  // core's schema is `additionalProperties: false`: a field it does not know is a rejected
  // heartbeat, every two seconds, rather than an ignored key.
  const health = {
    memoryMb: 210.4,
    memoryAvailablePercent: 23.4,
    memoryAvailableMb: 1_860,
    memoryLimitUsagePercent: 55.2,
    memoryLimitMb: 4_096,
  };

  it('leaves the machine’s memory and the limit out for a core older than protocol 17', () => {
    const sent = healthForPeer(health, 16);
    assert.deepEqual(sent, { memoryMb: 210.4 });
    assert.equal('memoryAvailablePercent' in sent, false);
  });

  it('strips only the newest version’s fields for a core one version behind', () => {
    // `P-210`: a core at 17 knows the machine's memory and not the limit, and must still get the
    // first — stripping everything newer than the oldest gated field would throw away 17's pair.
    assert.deepEqual(healthForPeer(health, 17), {
      memoryMb: 210.4,
      memoryAvailablePercent: 23.4,
      memoryAvailableMb: 1_860,
    });
  });

  it('sends everything to a core that knows it', () => {
    assert.deepEqual(healthForPeer(health, 18), health);
    assert.deepEqual(healthForPeer(health, PROTOCOL_VERSION), health);
  });

  it('never sends a core a health field older than it is, for every version and every field', () => {
    // `P-224`. An upgrade that reaches the probes before the core must not cost the link: a newer
    // probe speaks the core's version (`P-178`) and `healthForPeer` takes out what that version
    // lacks, so the core never sees a field it would refuse. The core refuses one still — a value
    // out of range is a gap since `P-224`, but a field it does not know is a skew — so a field
    // added to the schema without a gate would cost every heartbeat and the link with it. This
    // fails for that field: add it to `SINCE` at its version, and gate it.
    const SINCE: Readonly<Record<string, number>> = {
      memoryAvailablePercent: 17,
      memoryAvailableMb: 17,
      memoryLimitUsagePercent: 18,
      memoryLimitMb: 18,
    };
    // The rest predate `P-178`, and a core older than that refuses a newer probe at the handshake,
    // in words, so it is never sent a heartbeat at all. Pinned by count, so that a new field is
    // not quietly taken for one of them.
    assert.equal(
      PROBE_HEALTH_FIELDS.filter((field) => SINCE[field] === undefined).length,
      49,
      'a new health field: give it a version in SINCE, and gate it in healthForPeer',
    );
    const knownAt = (version: number): Set<string> =>
      new Set(PROBE_HEALTH_FIELDS.filter((field) => (SINCE[field] ?? 16) <= version));
    const every = Object.fromEntries(
      PROBE_HEALTH_FIELDS.map((field) => [field, 1]),
    ) as ProbeHealthReport;
    for (let version = 16; version <= PROTOCOL_VERSION; version++) {
      const unknown = Object.keys(healthForPeer(every, version)).filter(
        (field) => !knownAt(version).has(field),
      );
      assert.deepEqual(unknown, [], `sent to a core at protocol ${String(version)}`);
    }
  });

  it('names the missing capability in words for an older probe', () => {
    assert.ok(missingCapabilities(16).includes('report how much memory its machine has left'));
    assert.equal(versionFor('machineMemory'), 17);
    assert.ok(missingCapabilities(17).includes('report how close it is to its own memory limit'));
    assert.equal(versionFor('memoryLimit'), 18);
  });
});

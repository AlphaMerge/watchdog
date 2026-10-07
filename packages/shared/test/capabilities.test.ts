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
  parseProbeToCore,
  resultForPeer,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  pinningCapabilityFor,
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
      poolMemory: false,
      memorySinceLastReport: false,
      logOutput: false,
      credentialHostKeys: false,
      flowCounters: false,
      credentialAddressPinning: false,
      flowOverwritten: false,
      listenerOverwritten: false,
      databaseAddressPinning: false,
      targetPolicyException: false,
      childStartup: false,
      workerStartup: false,
      listenerEarlier: false,
      scriptGroups: false,
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
    poolCeiling: 77,
    poolMemoryCap: 77,
    poolHeldBack: 179,
    logDropped: 1_204,
    logBacklogBytes: 8_388_000,
    flowReceived: 4_812,
    flowRejected: 3,
    flowMalformed: 2,
    flowMissed: 61,
    flowUndecodable: 7,
    flowOverwritten: 250,
    trapOverwritten: 1_300,
    syslogOverwritten: 75,
    childStartupFailed: 3,
    childStartupMs: { p50: 40, p95: 9_500, p99: 14_800, max: 30_000 },
    workerStartupFailed: 4,
    trapEarlier: 357,
    syslogEarlier: 1_200,
    flowEarlier: 9_000,
    scriptGroupsEnded: 2,
    scriptGroupsRefused: 1,
    scriptGroupsRecycled: 3,
  };
  /** `health` as a core at 30 is sent it: everything but 31's six fields (`P-270`, `P-275`). */
  const {
    trapEarlier: _trapEarlier,
    syslogEarlier: _syslogEarlier,
    flowEarlier: _flowEarlier,
    scriptGroupsEnded: _ended,
    scriptGroupsRefused: _refused,
    scriptGroupsRecycled: _recycled,
    ...withoutEarlierAndGroups
  } = health;
  /** `health` as a core at 29 is sent it: that, less 30's one field (`P-263`). */
  const { workerStartupFailed: _workers, ...withoutWorkerStartup } = withoutEarlierAndGroups;
  /** `health` as a core at 26 to 28 is sent it: that, less 29's two fields (`P-260`). */
  const {
    childStartupFailed: _failed,
    childStartupMs: _startup,
    ...withoutStartup
  } = withoutWorkerStartup;
  /** `health` as a core at 25 is sent it: that, less 26's two fields (`B-14`). */
  const {
    trapOverwritten: _traps,
    syslogOverwritten: _syslog,
    ...withoutListeners
  } = withoutStartup;
  /** `health` as a core at 23 or 24 is sent it: that, less 25's one field (`B-11`). */
  const { flowOverwritten: _overwritten, ...withoutOverwritten } = withoutListeners;
  /** `health` as a core at 21 or 22 is sent it: that, less 23's flow counters (`B-07`). */
  const {
    flowReceived: _received,
    flowRejected: _rejected,
    flowMalformed: _malformed,
    flowMissed: _missed,
    flowUndecodable: _undecodable,
    ...withoutFlow
  } = withoutOverwritten;

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

  it('leaves the pool’s memory cap out for a core at 18, and keeps 18’s limit', () => {
    // `P-236`: stripped on its own, so a core at 18 still gets the limit it knows.
    const sent = healthForPeer(health, 18);
    assert.equal('poolCeiling' in sent, false);
    assert.equal('poolMemoryCap' in sent, false);
    assert.equal('poolHeldBack' in sent, false);
    assert.equal(sent.memoryLimitUsagePercent, 55.2);
  });

  it('leaves the log output’s counts out for a core at 20, and keeps 19’s pool fields', () => {
    // `P-216` part 3, stripped on its own like every version before it.
    const sent = healthForPeer(health, 20);
    assert.equal('logDropped' in sent, false);
    assert.equal('logBacklogBytes' in sent, false);
    assert.equal(sent.poolHeldBack, 179);
  });

  it('leaves the flow collector’s counters out for a core at 22, and keeps 21’s log fields', () => {
    // `B-07`. The fields have been in the schema since 16 and were never sent, so a core below 23
    // may be one built before them — and that core refuses the heartbeat, not the field.
    for (const version of [16, 21, 22]) {
      const sent = healthForPeer(health, version);
      for (const field of [
        'flowReceived',
        'flowRejected',
        'flowMalformed',
        'flowMissed',
        'flowUndecodable',
      ]) {
        assert.equal(field in sent, false, `${field} sent to a core at ${String(version)}`);
      }
    }
    assert.deepEqual(healthForPeer(health, 21), withoutFlow);
    assert.deepEqual(healthForPeer(health, 22), withoutFlow);
  });

  it('sends the flow collector’s counters to a core at 23, each as it was reported', () => {
    const sent = healthForPeer(health, 23);
    assert.equal(sent.flowReceived, 4_812);
    assert.equal(sent.flowRejected, 3);
    assert.equal(sent.flowMalformed, 2);
    assert.equal(sent.flowMissed, 61);
    assert.equal(sent.flowUndecodable, 7);
  });

  it('leaves what the flow buffer overwrote out for a core at 24, and keeps 23’s five', () => {
    // `B-11`, stripped on its own: a core at 23 or 24 knows the five counters and not this.
    for (const version of [16, 22, 23, 24]) {
      assert.equal(
        'flowOverwritten' in healthForPeer(health, version),
        false,
        `flowOverwritten sent to a core at ${String(version)}`,
      );
    }
    assert.deepEqual(healthForPeer(health, 23), withoutOverwritten);
    assert.deepEqual(healthForPeer(health, 24), withoutOverwritten);
    assert.equal(healthForPeer(health, 25).flowOverwritten, 250);
  });

  it('strips what the flow buffer overwrote from a report that carries nothing else gated', () => {
    // Not a side effect of the five going: a report with only this one field loses it too.
    assert.deepEqual(healthForPeer({ memoryMb: 1, flowOverwritten: 9 }, 24), { memoryMb: 1 });
    assert.deepEqual(healthForPeer({ memoryMb: 1, flowOverwritten: 9 }, 25), {
      memoryMb: 1,
      flowOverwritten: 9,
    });
  });

  it('is a field this build’s health schema knows, as a count', () => {
    // The other end of the gate: a core at 25 is sent the field, so its schema must take it.
    const heartbeat = (flowOverwritten: unknown): unknown => ({
      type: 'heartbeat',
      seq: 1,
      sentAt: 'now',
      health: { flowOverwritten },
    });
    const read = (sent: unknown): unknown => {
      const parsed = parseProbeToCore(heartbeat(sent));
      return parsed.type === 'heartbeat' ? parsed.health?.flowOverwritten : 'not a heartbeat';
    };
    assert.equal(read(250), 250);
    assert.equal(read(0), 0);
    // A value no count can be is a gap on the channel and the heartbeat is kept (`P-224`).
    assert.equal(read(-1), undefined);
    assert.equal(read(1.5), undefined);
  });

  it('leaves what the trap and syslog buffers overwrote out for a core at 25, and keeps 25’s field', () => {
    // `B-14`, stripped on its own: a core at 25 knows `flowOverwritten` and neither of these.
    for (const version of [16, 22, 24, 25]) {
      const sent = healthForPeer(health, version);
      for (const field of ['trapOverwritten', 'syslogOverwritten']) {
        assert.equal(field in sent, false, `${field} sent to a core at ${String(version)}`);
      }
    }
    assert.deepEqual(healthForPeer(health, 25), withoutListeners);
    assert.equal(healthForPeer(health, 25).flowOverwritten, 250);
    assert.equal(healthForPeer(health, 26).trapOverwritten, 1_300);
    assert.equal(healthForPeer(health, 26).syslogOverwritten, 75);
  });

  it('strips each of the two from a report that carries nothing else gated', () => {
    // Not a side effect of another field going, and neither one rides on the other: a probe
    // running one listener sends one of them.
    assert.deepEqual(healthForPeer({ memoryMb: 1, trapOverwritten: 9 }, 25), { memoryMb: 1 });
    assert.deepEqual(healthForPeer({ memoryMb: 1, syslogOverwritten: 9 }, 25), { memoryMb: 1 });
    assert.deepEqual(healthForPeer({ memoryMb: 1, trapOverwritten: 9 }, 26), {
      memoryMb: 1,
      trapOverwritten: 9,
    });
    assert.deepEqual(healthForPeer({ memoryMb: 1, syslogOverwritten: 9 }, 26), {
      memoryMb: 1,
      syslogOverwritten: 9,
    });
  });

  it('knows both listener fields in this build’s health schema, as counts', () => {
    // The other end of the gate: a core at 26 is sent them, so its schema must take them.
    for (const field of ['trapOverwritten', 'syslogOverwritten'] as const) {
      const read = (sent: unknown): unknown => {
        const parsed = parseProbeToCore({
          type: 'heartbeat',
          seq: 1,
          sentAt: 'now',
          health: { memoryMb: 12, [field]: sent },
        });
        if (parsed.type !== 'heartbeat') return 'not a heartbeat';
        // The heartbeat is kept whatever the count is, with the rest of its health (`P-224`).
        assert.equal(parsed.health?.memoryMb, 12, `${field} cost the heartbeat its health`);
        return parsed.health[field];
      };
      assert.equal(read(1_300), 1_300, field);
      assert.equal(read(0), 0, field);
      // A value no count can be is a gap on the channel.
      assert.equal(read(-1), undefined, field);
      assert.equal(read(1.5), undefined, field);
      assert.equal(read('7'), undefined, field);
    }
  });

  it('leaves the child start-up fields out for a core at 28, and keeps 26’s', () => {
    // `P-260`, stripped together and on their own: a core at 26 to 28 knows everything else.
    for (const version of [16, 25, 26, 27, 28]) {
      const sent = healthForPeer(health, version);
      for (const field of ['childStartupFailed', 'childStartupMs']) {
        assert.equal(field in sent, false, `${field} sent to a core at ${String(version)}`);
      }
    }
    for (const version of [26, 27, 28]) {
      assert.deepEqual(healthForPeer(health, version), withoutStartup, String(version));
    }
    assert.equal(healthForPeer(health, 28).trapOverwritten, 1_300);
    assert.deepEqual(healthForPeer({ memoryMb: 1, childStartupFailed: 2 }, 28), { memoryMb: 1 });
    assert.deepEqual(
      healthForPeer({ memoryMb: 1, childStartupMs: { p50: 1, p95: 2, p99: 3, max: 4 } }, 28),
      { memoryMb: 1 },
    );
    assert.equal(healthForPeer(health, 29).childStartupFailed, 3);
    assert.deepEqual(healthForPeer(health, 29).childStartupMs, health.childStartupMs);
  });

  it('leaves the workers not started out for a core at 29, and keeps 29’s', () => {
    // `P-263`, stripped on its own: a core at 29 knows everything else.
    for (const version of [16, 26, 28, 29]) {
      assert.equal(
        'workerStartupFailed' in healthForPeer(health, version),
        false,
        `workerStartupFailed sent to a core at ${String(version)}`,
      );
    }
    assert.deepEqual(healthForPeer(health, 29), withoutWorkerStartup);
    assert.equal(healthForPeer(health, 29).childStartupFailed, 3);
    assert.deepEqual(healthForPeer({ memoryMb: 1, workerStartupFailed: 2 }, 29), { memoryMb: 1 });
    assert.deepEqual(healthForPeer({ memoryMb: 1, workerStartupFailed: 2 }, 30), {
      memoryMb: 1,
      workerStartupFailed: 2,
    });
    assert.equal(healthForPeer(health, 30).workerStartupFailed, 4);
  });

  it('leaves 31’s listener and script-group counts out for a core at 30, and keeps 30’s', () => {
    // `P-270` and `P-275`: two capabilities at one version, each stripped on its own.
    const fields = [
      'trapEarlier',
      'syslogEarlier',
      'flowEarlier',
      'scriptGroupsEnded',
      'scriptGroupsRefused',
      'scriptGroupsRecycled',
    ];
    for (const version of [16, 26, 29, 30]) {
      const sent = healthForPeer(health, version);
      for (const field of fields) {
        assert.equal(field in sent, false, `${field} sent to a core at ${String(version)}`);
      }
    }
    assert.deepEqual(healthForPeer(health, 30), withoutEarlierAndGroups);
    assert.equal(healthForPeer(health, 30).workerStartupFailed, 4);
    assert.equal(healthForPeer(health, 30).trapOverwritten, 1_300);
    const sent = healthForPeer(health, 31);
    for (const field of fields) {
      assert.equal(sent[field as keyof typeof sent], health[field as keyof typeof health], field);
    }
    // Each capability alone: a report with only one set loses only that set below 31.
    assert.deepEqual(healthForPeer({ memoryMb: 1, trapEarlier: 2 }, 30), { memoryMb: 1 });
    assert.deepEqual(healthForPeer({ memoryMb: 1, scriptGroupsRefused: 2 }, 30), { memoryMb: 1 });
    assert.deepEqual(healthForPeer({ memoryMb: 1, flowEarlier: 2, scriptGroupsEnded: 1 }, 31), {
      memoryMb: 1,
      flowEarlier: 2,
      scriptGroupsEnded: 1,
    });
  });

  it('knows 31’s six counts in this build’s health schema, as counts', () => {
    // The other end of the gate: a core at 31 is sent them, so its schema must take them.
    const read = (field: string, sent: unknown): unknown => {
      const parsed = parseProbeToCore({
        type: 'heartbeat',
        seq: 1,
        sentAt: 'now',
        health: { memoryMb: 12, [field]: sent },
      });
      if (parsed.type !== 'heartbeat') return 'not a heartbeat';
      assert.equal(parsed.health?.memoryMb, 12, `${field} cost the heartbeat its health`);
      return (parsed.health as Record<string, unknown>)[field];
    };
    for (const field of [
      'trapEarlier',
      'syslogEarlier',
      'flowEarlier',
      'scriptGroupsEnded',
      'scriptGroupsRefused',
      'scriptGroupsRecycled',
    ]) {
      assert.equal(read(field, 7), 7, field);
      assert.equal(read(field, 0), 0, field);
      // A value no count can be is a gap on the channel, and the heartbeat is kept (`P-224`).
      assert.equal(read(field, -1), undefined, field);
      assert.equal(read(field, 1.5), undefined, field);
    }
  });

  it('knows the workers not started in this build’s health schema, as a count', () => {
    // The other end of the gate: a core at 30 is sent it, so its schema must take it.
    const read = (sent: unknown): unknown => {
      const parsed = parseProbeToCore({
        type: 'heartbeat',
        seq: 1,
        sentAt: 'now',
        health: { memoryMb: 12, workerStartupFailed: sent },
      });
      if (parsed.type !== 'heartbeat') return 'not a heartbeat';
      assert.equal(parsed.health?.memoryMb, 12, 'the count cost the heartbeat its health');
      return parsed.health.workerStartupFailed;
    };
    assert.equal(read(4), 4);
    assert.equal(read(0), 0);
    // A value no count can be is a gap on the channel, and the heartbeat is kept (`P-224`).
    assert.equal(read(-1), undefined);
    assert.equal(read(1.5), undefined);
  });

  it('knows both child start-up fields in this build’s health schema', () => {
    // The other end of the gate: a core at 29 is sent them, so its schema must take them.
    const read = (field: 'childStartupFailed' | 'childStartupMs', sent: unknown): unknown => {
      const parsed = parseProbeToCore({
        type: 'heartbeat',
        seq: 1,
        sentAt: 'now',
        health: { memoryMb: 12, [field]: sent },
      });
      if (parsed.type !== 'heartbeat') return 'not a heartbeat';
      assert.equal(parsed.health?.memoryMb, 12, `${field} cost the heartbeat its health`);
      return parsed.health[field];
    };
    assert.equal(read('childStartupFailed', 4), 4);
    assert.equal(read('childStartupFailed', 0), 0);
    assert.equal(read('childStartupFailed', -1), undefined);
    assert.equal(read('childStartupFailed', 1.5), undefined);
    const times = { p50: 21, p95: 450, p99: 14_800, max: 30_000 };
    assert.deepEqual(read('childStartupMs', times), times);
    // A bundle with a part missing, or a negative time, is a gap and the heartbeat is kept.
    assert.equal(read('childStartupMs', { p50: 21, p95: 450, p99: 900 }), undefined);
    assert.equal(read('childStartupMs', { ...times, max: -1 }), undefined);
  });

  it('sends everything to a core that knows it', () => {
    assert.equal(PROTOCOL_VERSION, 31);
    assert.deepEqual(healthForPeer(health, 31), health);
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
      poolCeiling: 19,
      poolMemoryCap: 19,
      poolHeldBack: 19,
      logDropped: 21,
      logBacklogBytes: 21,
      // `B-07`: in the schema since 16, and 23 is the first version any probe sends them at.
      flowReceived: 23,
      flowRejected: 23,
      flowMalformed: 23,
      flowMissed: 23,
      flowUndecodable: 23,
      // `B-11`: a new field, at the version that adds it.
      flowOverwritten: 25,
      // `B-14`: two new fields, at the version that adds them.
      trapOverwritten: 26,
      syslogOverwritten: 26,
      // `P-260`: two new fields, at the version that adds them.
      childStartupFailed: 29,
      childStartupMs: 29,
      // `P-263`: one new field, at the version that adds it.
      workerStartupFailed: 30,
      // `P-270` and `P-275`: six new fields under two capabilities, at the version that adds them.
      trapEarlier: 31,
      syslogEarlier: 31,
      flowEarlier: 31,
      scriptGroupsEnded: 31,
      scriptGroupsRefused: 31,
      scriptGroupsRecycled: 31,
    };
    // The rest predate `P-178`, and a core older than that refuses a newer probe at the handshake,
    // in words, so it is never sent a heartbeat at all. Pinned by count, so that a new field is
    // not quietly taken for one of them.
    assert.equal(
      PROBE_HEALTH_FIELDS.filter((field) => SINCE[field] === undefined).length,
      44,
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
    assert.ok(missingCapabilities(18).includes('report how far memory lets its check pool grow'));
    assert.equal(versionFor('poolMemory'), 19);
    // `P-219`: a meaning rather than a field, so nothing is stripped and the version says it.
    assert.equal(versionFor('memorySinceLastReport'), 20);
    assert.ok(
      missingCapabilities(19).includes(
        'report each memory low once, rather than the last thirty seconds',
      ),
    );
    assert.equal(capabilitiesFor(20).memorySinceLastReport, true);
    assert.equal(versionFor('logOutput'), 21);
    assert.equal(versionFor('credentialHostKeys'), 22);
    assert.equal(versionFor('flowCounters'), 23);
    assert.ok(
      missingCapabilities(22).includes(
        'report what its flow collector received and what it missed',
      ),
    );
    // `A-41c`: no field towards the probe either. Below 24 the core withholds the set.
    assert.equal(versionFor('credentialAddressPinning'), 24);
    assert.equal(capabilitiesFor(23).credentialAddressPinning, false);
    assert.equal(capabilitiesFor(24).credentialAddressPinning, true);
    // `B-11`: one health field, stripped below 25.
    assert.equal(versionFor('flowOverwritten'), 25);
    assert.equal(capabilitiesFor(24).flowOverwritten, false);
    assert.equal(capabilitiesFor(25).flowOverwritten, true);
    assert.ok(
      missingCapabilities(24).includes(
        'report the flows its collector overwrote before a sensor read them',
      ),
    );
    // `B-14`: two health fields under one capability, stripped below 26.
    assert.equal(versionFor('listenerOverwritten'), 26);
    assert.equal(capabilitiesFor(25).listenerOverwritten, false);
    assert.equal(capabilitiesFor(26).listenerOverwritten, true);
    assert.ok(
      missingCapabilities(25).includes(
        'report the traps and syslog messages its listeners overwrote before a sensor read them',
      ),
    );
    assert.ok(
      missingCapabilities(23).includes(
        'check a named device against the addresses its credentials allow, and connect to the ' +
          'address it checked',
      ),
    );
    assert.ok(missingCapabilities(20).includes('report the log lines it could not write'));
  });

  it('a database set is pinned from 27, and every other kind from 24 (A-62)', () => {
    // No field on the wire: below 27 the core withholds the set from a database sensor.
    assert.equal(versionFor('databaseAddressPinning'), 27);
    assert.equal(capabilitiesFor(26).databaseAddressPinning, false);
    assert.equal(capabilitiesFor(27).databaseAddressPinning, true);
    assert.equal(pinningCapabilityFor('database'), 'databaseAddressPinning');
    for (const kind of ['snmp', 'ssh', 'http', 'mail', 'windows', '']) {
      assert.equal(pinningCapabilityFor(kind), 'credentialAddressPinning', kind);
    }
    assert.ok(
      missingCapabilities(26).includes(
        'check a named database server against the addresses its credentials allow, and ' +
          'connect to the address it checked',
      ),
    );
    assert.deepEqual(missingCapabilities(27), [
      'connect to an address one device is excepted for, although its target policy refuses it',
      'report the script checks it could not start, and how long one takes to start',
      'report the check workers it could not start',
      'report what its listeners heard that a restart or a cut push kept out of a first scan',
      'report the script process groups it ended, or refused to end, after a check process died',
    ]);
    // Stripping what a peer does not know is by capability: 27 has no health field, so a core
    // at 26 is sent what a core at 27 is.
    const health = { memoryMb: 1, trapOverwritten: 9, syslogOverwritten: 2 };
    assert.deepEqual(healthForPeer(health, 26), healthForPeer(health, 27));
  });
});

const DESCRIBED_EXCEPTION =
  'connect to an address one device is excepted for, although its target policy refuses it';

describe('one device’s exception to the target policy (`A-64`)', () => {
  it('is understood from 28, and by nothing older', () => {
    // A field in `target`, which is a closed schema on the probe: below 28 it is not sent at all.
    assert.equal(versionFor('targetPolicyException'), 28);
    assert.equal(capabilitiesFor(27).targetPolicyException, false);
    assert.equal(capabilitiesFor(28).targetPolicyException, true);
    assert.equal(missingCapabilities(28).includes(DESCRIBED_EXCEPTION), false);
  });
});

describe('the child start-up counters (`P-260`)', () => {
  it('are reported from 29, and by nothing older', () => {
    // Two health fields under one capability, stripped below 29.
    assert.equal(versionFor('childStartup'), 29);
    assert.equal(capabilitiesFor(28).childStartup, false);
    assert.equal(capabilitiesFor(29).childStartup, true);
    assert.deepEqual(missingCapabilities(28), [
      'report the script checks it could not start, and how long one takes to start',
      'report the check workers it could not start',
      'report what its listeners heard that a restart or a cut push kept out of a first scan',
      'report the script process groups it ended, or refused to end, after a check process died',
    ]);
  });
});

describe('the check workers not started (`P-263`)', () => {
  it('are reported from 30, and by nothing older', () => {
    // One health field under one capability, stripped below 30.
    assert.equal(versionFor('workerStartup'), 30);
    assert.equal(capabilitiesFor(29).workerStartup, false);
    assert.equal(capabilitiesFor(30).workerStartup, true);
    assert.deepEqual(missingCapabilities(29), [
      'report the check workers it could not start',
      'report what its listeners heard that a restart or a cut push kept out of a first scan',
      'report the script process groups it ended, or refused to end, after a check process died',
    ]);
  });
});

describe('the listener and script-group counts (`P-270`, `P-275`)', () => {
  it('are reported from 31, and by nothing older', () => {
    // Two capabilities at one version, three health fields each, stripped below 31.
    assert.equal(versionFor('listenerEarlier'), 31);
    assert.equal(versionFor('scriptGroups'), 31);
    assert.equal(capabilitiesFor(30).listenerEarlier, false);
    assert.equal(capabilitiesFor(30).scriptGroups, false);
    assert.equal(capabilitiesFor(31).listenerEarlier, true);
    assert.equal(capabilitiesFor(31).scriptGroups, true);
    assert.deepEqual(missingCapabilities(30), [
      'report what its listeners heard that a restart or a cut push kept out of a first scan',
      'report the script process groups it ended, or refused to end, after a check process died',
    ]);
    assert.deepEqual(missingCapabilities(31), []);
  });
});

describe('the check result a peer can be sent (`A-41c`)', () => {
  const plain = {
    sensorId: 7,
    at: '2026-10-02T00:00:00.000Z',
    outcome: 'error' as const,
    message: 'Not scanned: outside the allowed targets',
    durationMs: 3,
    channels: [],
  };

  it('keeps `withheld` for a core at 24 and takes it out below', () => {
    const refused = { ...plain, withheld: true as const };
    assert.deepEqual(resultForPeer(refused, 24), refused);
    assert.deepEqual(resultForPeer(refused, 25), refused);
    assert.deepEqual(resultForPeer(refused, 23), plain);
    assert.equal('withheld' in resultForPeer(refused, 22), false);
  });

  it('hands back the very result when there is nothing to take out', () => {
    assert.equal(resultForPeer(plain, 3), plain);
    assert.equal(resultForPeer(plain, 24), plain);
  });

  it('is a field both schemas know, and only as true', () => {
    const batch = (result: unknown): unknown => ({
      type: 'results',
      batchId: 'b',
      results: [result],
    });
    assert.doesNotThrow(() => parseProbeToCore(batch({ ...plain, withheld: true })));
    assert.doesNotThrow(() => parseProbeToCore(batch(plain)));
    assert.throws(() => parseProbeToCore(batch({ ...plain, withheld: false })));
    assert.throws(() => parseProbeToCore(batch({ ...plain, withheld: 'yes' })));
  });
});

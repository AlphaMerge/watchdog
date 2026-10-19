import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SensorReference, SensorType } from '../src/contract.js';
import { coreFactory, coreHealth, probeHealth, standardCatalogue } from '../src/index.js';

/**
 * The two sensors this system points at itself (`P-12`, `P-13`).
 *
 * `CLAUDE.md` makes self-monitoring a rule rather than a feature, and these are where it lands.
 * What is asserted here is the part a catalogue-wide check cannot: **which** channel each is
 * judged by, and that neither can be scanned by a probe.
 */

describe('the self-monitoring sensor types', () => {
  it('judges Core Health by the ingestion queue', () => {
    // Zero whenever the core is keeping up, climbing whenever anything downstream of a probe is
    // not — the one number that means "the core is failing at its job" rather than "one of its
    // parts is busy". A PRTG-style opaque 0–100 health score would be the alternative, and an
    // operator cannot act on one.
    const primary = coreHealth.channels({}).filter((channel) => channel.isPrimary === true);
    assert.deepEqual(
      primary.map((channel) => channel.key),
      ['ingestQueue'],
    );
  });

  it('judges Probe Health by the link, not by how badly the probe is working', () => {
    // **This is where the single alarm for a lost probe comes from** (`R-05`). Everything else
    // on this sensor is a degree of "working badly"; `connected` is the difference between a
    // probe that is monitoring and one that is not.
    const primary = probeHealth.channels({}).filter((channel) => channel.isPrimary === true);
    assert.deepEqual(
      primary.map((channel) => channel.key),
      ['connected'],
    );
  });

  it('reads both status channels through a lookup rather than a threshold', () => {
    // A status code is not a measurement (`M-06`): "not connected" is a state, and "below 0.5"
    // is not a sentence anybody should have to write or read.
    const channels = probeHealth.channels({});
    assert.equal(channels.find((one) => one.key === 'connected')?.lookup, 'ms.probe.link');
    assert.equal(channels.find((one) => one.key === 'protocol')?.lookup, 'ms.probe.protocol');
  });

  it('carries what a flow collector’s buffer overwrote unread as a number and not an alarm', () => {
    // `B-11`. The flow sensor that was behind already fails its scan with the count, so a limit
    // or a lookup here would turn Probe Health as well: two alarms for one buffer too small.
    const overwritten = probeHealth.channels({}).find((one) => one.key === 'flowOverwritten');
    assert.deepEqual(overwritten, {
      key: 'flowOverwritten',
      name: 'Flows overwritten unread',
      unit: 'flows',
      // A running total on the wire, as `flowMissed` is, recorded as a rate.
      counter: { bits: 64 },
    });
  });

  it('carries what the trap and syslog buffers overwrote unread as numbers and not alarms', () => {
    // `B-14`. The trap or syslog sensor that was behind already fails its scan with the count,
    // so a limit or a lookup here would turn Probe Health as well: two alarms for one buffer.
    const channels = probeHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'trapOverwritten'),
      {
        key: 'trapOverwritten',
        name: 'Traps overwritten unread',
        unit: 'traps',
        counter: { bits: 64 },
      },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'syslogOverwritten'),
      {
        key: 'syslogOverwritten',
        name: 'Syslog overwritten unread',
        unit: 'messages',
        counter: { bits: 64 },
      },
    );
  });

  it('carries the child checks that never started, and how long a start takes, without limits', () => {
    // `P-260`. The sensor whose check never started already fails with a message naming the
    // start-up, so a limit here would turn Probe Health as well: two alarms for one slow start.
    const channels = probeHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'childStartupFailed'),
      {
        key: 'childStartupFailed',
        name: 'Child checks not started',
        unit: 'checks',
        counter: { bits: 64 },
      },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'childStartup'),
      { key: 'childStartup', name: 'Child process start-up (p95)', unit: 'ms' },
    );
  });

  it('carries the workers the pool could not start as a counter, without limits', () => {
    // `P-263`. No check is lost to a worker that hangs while loading, since checks go only to
    // ready workers; a probe short of them shows in `checkWait` and `refused`, which have limits.
    assert.deepEqual(
      probeHealth.channels({}).find((one) => one.key === 'workerStartupFailed'),
      {
        key: 'workerStartupFailed',
        name: 'Workers not started',
        unit: 'workers',
        counter: { bits: 64 },
      },
    );
  });

  it('carries the name lookups as a gauge and a counter, without limits, beside the sessions (`A-66`)', () => {
    // Each check whose lookup was given up already fails naming the resolver, so a limit here
    // would be a second alarm for one resolver outage.
    const channels = probeHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'lookupsInFlight'),
      { key: 'lookupsInFlight', name: 'Name lookups in flight', unit: 'lookups' },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'lookupsGivenUp'),
      {
        key: 'lookupsGivenUp',
        name: 'Name lookups given up',
        unit: 'lookups',
        counter: { bits: 64 },
      },
    );
    const keys = channels.map((one) => one.key);
    assert.equal(keys.indexOf('lookupsInFlight'), keys.indexOf('sessionsOpened') + 1);
    assert.equal(keys.indexOf('lookupsGivenUp'), keys.indexOf('lookupsInFlight') + 1);
  });

  it('carries the name answers loaded at start as a gauge, without limits, after the lookups (`P-438`)', () => {
    // A probe that started cold is not an outage, and the checks it cannot answer already alarm.
    const channels = probeHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'answersLoaded'),
      { key: 'answersLoaded', name: 'Name answers loaded at start', unit: 'answers' },
    );
    const keys = channels.map((one) => one.key);
    assert.equal(keys.indexOf('answersLoaded'), keys.indexOf('lookupsGivenUp') + 1);
  });

  it('warns on the checks given up over five minutes, at a hundred, after the answers loaded (`P-441`)', () => {
    // One Warning for the probe, beside every check that already fails naming the resolver.
    const channels = probeHealth.channels({});
    const recent = channels.find((one) => one.key === 'lookupsGivenUpRecently');
    assert.deepEqual(recent, {
      key: 'lookupsGivenUpRecently',
      name: 'Name lookups given up (5 min)',
      unit: 'lookups',
      limits: {
        upperWarning: 99.5,
        warningMessage:
          'the probe’s resolver is giving checks up for want of an answer: DNS is not answering it',
      },
    });
    // A count the core takes, never a counter: a rate would gap on a restart's burst.
    assert.equal('counter' in recent, false);
    const keys = channels.map((one) => one.key);
    assert.equal(keys.indexOf('lookupsGivenUpRecently'), keys.indexOf('answersLoaded') + 1);
  });

  it('carries how the probe resolves names, its one alarm through the helper’s latch (`P-432`)', () => {
    const channels = probeHealth.channels({});
    const find = (key: string) => channels.find((one) => one.key === key);
    assert.deepEqual(find('nameResolverMode'), {
      key: 'nameResolverMode',
      name: 'Name resolver',
      lookup: 'ms.probe.name-resolver',
    });
    assert.deepEqual(find('lookupHelperTrouble'), {
      key: 'lookupHelperTrouble',
      name: 'Lookup helper',
      lookup: 'ms.probe.lookup-helper',
    });
    // The rest have no limit and no lookup: what the field test reads, never an alarm.
    for (const [key, unit, counter] of [
      ['nameCheckOnSeconds', 's', true],
      ['namePassedStuck', 'lookups', true],
      ['nameHelperStuck', 'lookups', true],
      ['nameQuestionsOpen', 'questions', false],
    ] as const) {
      const channel = find(key);
      assert.ok(channel !== undefined, key);
      assert.equal(channel.unit, unit, key);
      assert.equal(channel.limits, undefined, key);
      assert.equal(channel.lookup, undefined, key);
      assert.deepEqual(channel.counter, counter ? { bits: 64 } : undefined, key);
    }
    const keys = channels.map((one) => one.key);
    assert.deepEqual(
      keys.slice(keys.indexOf('nameResolverMode'), keys.indexOf('nameResolverMode') + 6),
      [
        'nameResolverMode',
        'lookupHelperTrouble',
        'nameCheckOnSeconds',
        'namePassedStuck',
        'nameHelperStuck',
        'nameQuestionsOpen',
      ],
    );
  });

  it('carries what each listener kept out of a first scan as a counter, without limits (`P-270`)', () => {
    // Not a loss: the sensor's message names it, and a limit would alarm on every reconnect after
    // an outage the link channels already alarm on. Each beside its listener's overwritten count.
    const channels = probeHealth.channels({});
    const keys = channels.map((one) => one.key);
    for (const [key, name, unit, beside] of [
      ['trapEarlier', 'Traps before a first scan', 'traps', 'syslogOverwritten'],
      ['syslogEarlier', 'Syslog before a first scan', 'messages', 'trapEarlier'],
      ['flowEarlier', 'Flows before a first scan', 'flows', 'flowOverwritten'],
    ] as const) {
      assert.deepEqual(
        channels.find((one) => one.key === key),
        { key, name, unit, counter: { bits: 64 } },
      );
      assert.equal(keys.indexOf(key), keys.indexOf(beside) + 1, `${key} after ${beside}`);
    }
  });

  it('warns on a refused script group over five minutes, and on nothing else a dead check process left (`P-275`, `P-284`)', () => {
    // A refused group is a check process naming one that is not its own child: a forged line, in
    // all but a rare race. The counter has no limit since `P-284`, because its rate gaps on the
    // first record after a restart or a long link gap; the warning is the core's five-minute count
    // beside it, which sees that record. An ended group is already the failed sensor's news, and
    // one left alone is mostly a reused pid.
    const channels = probeHealth.channels({});
    const counter = { bits: 64 } as const;
    assert.deepEqual(
      channels.find((one) => one.key === 'scriptGroupsEnded'),
      { key: 'scriptGroupsEnded', name: 'Script groups ended', unit: 'groups', counter },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'scriptGroupsRefused'),
      { key: 'scriptGroupsRefused', name: 'Script groups refused', unit: 'groups', counter },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'scriptGroupsRecycled'),
      { key: 'scriptGroupsRecycled', name: 'Script groups left alone', unit: 'groups', counter },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'scriptGroupsRefusedRecently'),
      {
        key: 'scriptGroupsRefusedRecently',
        name: 'Script groups refused (5 min)',
        unit: 'groups',
        // A count, not a counter: one refusal is 1, and nothing is 0 once the window has passed.
        limits: {
          upperWarning: 0.5,
          warningMessage:
            'a check process named process groups that are not its own, and this probe left them alone',
        },
      },
    );
    const keys = channels.map((one) => one.key);
    const from = keys.indexOf('childStartup');
    assert.deepEqual(keys.slice(from + 1, from + 5), [
      'scriptGroupsEnded',
      'scriptGroupsRefused',
      'scriptGroupsRefusedRecently',
      'scriptGroupsRecycled',
    ]);
  });

  it('counts the readings a probe could not send, and is Down only on whole results lost (`P-283`)', () => {
    // Channels taken out of results are one sensor's own output, so no limit: a warning would hold
    // the whole probe for one script's bug. Whole results the drain discarded are readings that
    // exist nowhere, as `spoolDropped`'s are: an error, on the core's five-minute count of both.
    const channels = probeHealth.channels({});
    const counter = { bits: 64 } as const;
    assert.deepEqual(
      channels.find((one) => one.key === 'resultChannelsDropped'),
      {
        key: 'resultChannelsDropped',
        name: 'Readings dropped as unsendable',
        unit: 'readings',
        counter,
      },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'spoolRejected'),
      { key: 'spoolRejected', name: 'Results refused as invalid', unit: 'results', counter },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'spoolOversized'),
      { key: 'spoolOversized', name: 'Results too large to send', unit: 'results', counter },
    );
    assert.deepEqual(
      channels.find((one) => one.key === 'resultsDiscarded'),
      {
        key: 'resultsDiscarded',
        name: 'Results discarded unsent (5 min)',
        unit: 'results',
        limits: {
          upperError: 0.5,
          errorMessage:
            'the spool discarded results it could not send, and those readings are lost',
        },
      },
    );
    const keys = channels.map((one) => one.key);
    assert.equal(keys.indexOf('resultChannelsDropped'), keys.indexOf('scriptGroupsRecycled') + 1);
    const from = keys.indexOf('spoolCorrupt');
    assert.ok(from >= 0, 'spoolCorrupt is declared');
    assert.deepEqual(keys.slice(from + 1, from + 4), [
      'spoolRejected',
      'spoolOversized',
      'resultsDiscarded',
    ]);
  });

  it('carries a probe’s late refusals as a number of their own and not an alarm', () => {
    // `A-56`. A refusal that arrived after the probe's configuration moved on is dropped and
    // nothing is wrong: a limit or a lookup would be an alarm for a change somebody made on
    // purpose. Declared beside the refused reports, which it is not counted among.
    const channels = probeHealth.channels({});
    const late = channels.find((one) => one.key === 'lateRefusals');
    assert.deepEqual(late, {
      key: 'lateRefusals',
      name: 'Refusals delivered late',
      unit: 'results',
      counter: { bits: 64 },
    });
    const keys = channels.map((one) => one.key);
    const from = keys.indexOf('reportsRefused');
    assert.deepEqual(keys.slice(from, from + 3), [
      'reportsRefused',
      'reportsForeign',
      'lateRefusals',
    ]);
  });

  it('carries the results dropped for withheld sensors as a number beside the late refusals, and not an alarm (`A-72`)', () => {
    const channels = probeHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'resultsWithheld'),
      {
        key: 'resultsWithheld',
        name: 'Results for sensors withheld',
        unit: 'results',
        counter: { bits: 64 },
      },
    );
    const keys = channels.map((one) => one.key);
    assert.equal(keys.indexOf('resultsWithheld'), keys.indexOf('lateRefusals') + 1);
  });

  it('warns on a protocol version flap, and only from a second change (`A-72`)', () => {
    // The one warning in place of a page and a recovery for every named sensor at every change:
    // 0 for no flap, and a flap is two changes or more. No lookup and no error: the probe is
    // working, and its sensors are held where they stood.
    const channels = probeHealth.channels({});
    const flap = channels.find((one) => one.key === 'protocolFlap');
    assert.deepEqual(flap, {
      key: 'protocolFlap',
      name: 'Protocol version changes in a flap',
      unit: 'changes',
      limits: {
        upperWarning: 1.5,
        warningMessage:
          "this probe's protocol version changed more than once in an hour; the sensors its version decides hold where they stood until it has held one version for an hour",
      },
    });
    const keys = channels.map((one) => one.key);
    assert.equal(keys.indexOf('protocolFlap'), keys.indexOf('protocol') + 1);
  });

  it('carries the late-refusal record’s given-up writes as a number on Core Health and not an alarm', () => {
    // `A-68`. A write that gave way to a delete is made again within the minute, and the running
    // core has lost nothing meanwhile: a limit or a lookup would be an alarm for a group somebody
    // deleted on purpose. Declared beside the sensors withheld for credentials.
    const channels = coreHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'lateRefusalWritesGivenUp'),
      {
        key: 'lateRefusalWritesGivenUp',
        name: 'Late-refusal record writes given up',
        unit: 'writes',
        counter: { bits: 64 },
      },
    );
    const keys = channels.map((one) => one.key);
    const from = keys.indexOf('credentialsWithheld');
    assert.ok(from >= 0);
    assert.deepEqual(keys.slice(from, from + 2), [
      'credentialsWithheld',
      'lateRefusalWritesGivenUp',
    ]);
  });

  it('carries the probe hellos refused unproven as a counter on Core Health and not an alarm (P-319)', () => {
    // A probe reinstalled without its key retries into these until somebody looks: a job, not an
    // outage, so no limit. Declared beside the other refusals of something that reached a port.
    const channels = coreHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'probeHellosUnproven'),
      {
        key: 'probeHellosUnproven',
        name: 'Probe hellos refused unproven',
        unit: 'hellos',
        counter: { bits: 64 },
      },
    );
    const keys = channels.map((one) => one.key);
    const from = keys.indexOf('hostsRefused');
    assert.ok(from >= 0);
    assert.deepEqual(keys.slice(from, from + 2), ['hostsRefused', 'probeHellosUnproven']);
  });

  it('carries the sensors owed a re-decision as a level beside the probes, with no limit (P-400)', () => {
    // The delivery sweep is already re-deciding them every pass, and the log names why one
    // failed: a limit would add an alarm for what is being retried.
    const channels = coreHealth.channels({});
    assert.deepEqual(
      channels.find((one) => one.key === 'sensorsOwedRedecision'),
      { key: 'sensorsOwedRedecision', name: 'Sensors owed a re-decision', unit: 'sensors' },
    );
    const keys = channels.map((one) => one.key);
    const from = keys.indexOf('probesSilent');
    assert.ok(from >= 0);
    assert.deepEqual(keys.slice(from, from + 2), ['probesSilent', 'sensorsOwedRedecision']);
  });

  it('keeps both out of every probe’s assignment list', () => {
    // The mechanism `T-21` built. For Probe Health it is not an optimisation but the whole
    // design: a probe cannot report its own absence, so the core has to be the one asking.
    const catalogue = standardCatalogue();
    assert.equal(catalogue.declaration('ms.core.health').evaluatedBy, 'core');
    assert.equal(catalogue.declaration('ms.probe.health').evaluatedBy, 'core');
  });

  it('fails loudly if a probe ever runs one anyway', async () => {
    // Unreachable unless the assignment filter has broken — and silence there would be a sensor
    // reporting Down for ever with no explanation of why.
    const context = {} as Parameters<typeof coreHealth.execute>[0];
    await assert.rejects(() => coreHealth.execute(context), /evaluated by the core/);
    await assert.rejects(() => probeHealth.execute(context), /cannot report its own absence/);
  });
});

/**
 * What each type the core evaluates says it reads (`A-29`), which is what a write is checked
 * against. The check itself is the core's; this is the half only the type can answer.
 */
describe('what the core-evaluated types say they read', () => {
  const referencesOf = (
    type: SensorType,
    params: Record<string, unknown>,
  ): readonly SensorReference[] => {
    const named = type.references?.(params);
    assert.ok(named !== undefined, `${type.id} declares no references`);
    return named;
  };

  it('has Probe Health name the probe it reports on, or the one above it', () => {
    assert.deepEqual(referencesOf(probeHealth, { probeId: 12 }), [
      { kind: 'object', objectId: 12, expects: 'probe', param: 'probeId' },
    ]);
    assert.deepEqual(referencesOf(probeHealth, {}), [
      { kind: 'enclosing-probe', param: 'probeId' },
    ]);
  });

  it('has Core Health bar the writer rather than name anything', () => {
    assert.equal(coreHealth.requires, 'installation');
    assert.equal(coreHealth.references?.({}), undefined);
  });

  it('has a Sensor Factory name every sensor each formula reads, once per formula', () => {
    const named = referencesOf(coreFactory, {
      channels: [
        { key: 'a', name: 'A', formula: "channel(4, 'in') + channel(4, 'out') + status(9)" },
        { key: 'b', name: 'B', formula: '100' },
        { key: 'c', name: 'C', formula: "max(channel(9, 'x'), channel(11, 'y'))" },
      ],
    });
    assert.deepEqual(
      named.map((ref) => (ref.kind === 'object' ? [ref.param, ref.objectId, ref.expects] : ref)),
      [
        ['channels[0].formula', 4, 'sensor'],
        ['channels[0].formula', 9, 'sensor'],
        ['channels[2].formula', 9, 'sensor'],
        ['channels[2].formula', 11, 'sensor'],
      ],
    );
  });

  it('has a formula that does not parse name nothing, since nothing can be read out of it', () => {
    assert.deepEqual(
      referencesOf(coreFactory, { channels: [{ key: 'a', name: 'A', formula: 'channel(4,' }] }),
      [],
    );
  });
});

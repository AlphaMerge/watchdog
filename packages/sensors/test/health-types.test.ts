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

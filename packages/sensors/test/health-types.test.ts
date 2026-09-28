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

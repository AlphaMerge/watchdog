import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SensorType } from '@ms/sensors';
import {
  capabilitiesFor,
  PROTOCOL_VERSION,
  versionFor,
  type CheckResult,
  type IngestionConfig,
} from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService } from '../src/auth/access.js';
import type { Database } from '../src/db/pool.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import {
  CredentialVouching,
  LATE_REFUSAL_GRACE_MS,
  WITHHELD_CREDENTIALS,
  boundRefusal,
  storedStop,
  type SensorBeingSent,
} from '../src/objects/credential-vouching.js';
import { ObjectError } from '../src/objects/errors.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import { SensorVouching } from '../src/objects/vouching.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { ProbeRefusals } from '../src/probes/refusals.js';
import { ProbeRegistry } from '../src/probes/registry.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

/**
 * A named device against a set's address targets, as the core sees it (`A-41c`).
 *
 * Three things are the core's. Whether such a set is sent at all: only to a sensor whose type
 * connects to a checked address, and only through a probe new enough to do the check. What it
 * does with a check the probe then refuses: holds the sensor Unknown, never Down. And how that
 * pages when a whole group's names move outside at once, which is the scenario at the end.
 */

const PINNING = versionFor('credentialAddressPinning');

/** An SNMP type as the core sees one that pins: the kind it uses, and that it pins it. */
const snmpPinned: SensorType = {
  id: 'test.snmp.pinned',
  category: 'SNMP',
  costHint: 'light',
  credentialKinds: ['snmp'],
  pinnedKinds: ['snmp'],
  secretDestinations: { 'kind:snmp': ['port'] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { port: { type: 'integer', minimum: 1, maximum: 65_535 } },
  },
  channels: () => [{ key: 'uptime', name: 'Uptime', unit: 's', isPrimary: true }],
  execute: () => Promise.resolve({ channels: [] }),
};

/** A database type as the core sees one: a driver resolves the name, so it pins nothing. */
const dbQuery: SensorType = {
  id: 'test.db.query',
  category: 'Database',
  costHint: 'medium',
  credentialKinds: ['database'],
  secretDestinations: { 'kind:database': ['port'] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { port: { type: 'integer', minimum: 1, maximum: 65_535 } },
  },
  channels: () => [{ key: 'rows', name: 'Rows', unit: '', isPrimary: true }],
  execute: () => Promise.resolve({ channels: [] }),
};

/** An SSH type as the core sees one: the kind a set bounded by its host keys is. */
const sshLoad: SensorType = {
  id: 'test.ssh.load',
  category: 'SSH',
  costHint: 'medium',
  credentialKinds: ['ssh'],
  pinnedKinds: ['ssh'],
  secretDestinations: { 'kind:ssh': [] },
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  channels: () => [{ key: 'load', name: 'Load', unit: '', isPrimary: true }],
  execute: () => Promise.resolve({ channels: [] }),
};

describe('protocol 24 is what a probe must speak to be sent such a set (A-41c)', () => {
  it('is the version the capability arrived in, and this build speaks it', () => {
    assert.equal(PINNING, 24);
    assert.equal(capabilitiesFor(PROTOCOL_VERSION).credentialAddressPinning, true);
    assert.equal(capabilitiesFor(23).credentialAddressPinning, false);
    assert.equal(capabilitiesFor(24).credentialAddressPinning, true);
  });

  const ranges = { targets: ['10.20.0.0/16'], hostKeys: null };
  const table: [string, string, number, boolean, string | null][] = [
    ['a name, a type that pins, a probe at 24', 'sw.dc.test', 24, true, null],
    ['a name, a type that pins, a newer probe', 'sw.dc.test', 25, true, null],
    [
      'a name, a type that pins, a probe at 23',
      'sw.dc.test',
      23,
      true,
      WITHHELD_CREDENTIALS.probeCannotPin,
    ],
    [
      'a name, a type that pins, a probe at 22',
      'sw.dc.test',
      22,
      true,
      WITHHELD_CREDENTIALS.probeCannotPin,
    ],
    [
      'a name, a type that pins, a probe never heard from',
      'sw.dc.test',
      0,
      true,
      WITHHELD_CREDENTIALS.probeCannotPin,
    ],
    [
      'a name, a type that cannot pin, a probe at 24',
      'sw.dc.test',
      24,
      false,
      WITHHELD_CREDENTIALS.undecided,
    ],
    [
      'a name, a type that cannot pin, an old probe: the type is the reason given',
      'sw.dc.test',
      22,
      false,
      WITHHELD_CREDENTIALS.undecided,
    ],
    ['an address inside, an old probe: nothing to resolve', '10.20.0.9', 21, true, null],
    ['an address outside, whatever pins', '192.0.2.9', 24, true, WITHHELD_CREDENTIALS.outside],
  ];
  for (const [name, host, version, pins, expected] of table) {
    it(name, () => {
      assert.equal(boundRefusal(ranges, host, version, pins), expected);
    });
  }

  it('withholds a name facing only addresses from a caller that does not say the type pins', () => {
    assert.equal(boundRefusal(ranges, 'sw.dc.test', 24), WITHHELD_CREDENTIALS.undecided);
  });

  it('a name a name entry covers needs no pin, and no probe version', () => {
    const named = { targets: ['10.20.0.0/16', '*.dc.test'], hostKeys: null };
    assert.equal(boundRefusal(named, 'sw.dc.test', 3, false), null);
  });

  it('a set bounded by its keys too is still held from a probe that cannot check them', () => {
    const both = { targets: ['10.20.0.0/16'], hostKeys: ['SHA256:a'] };
    assert.equal(boundRefusal(both, 'sw.dc.test', 24, true), null);
    assert.equal(boundRefusal(both, 'sw.dc.test', 21, true), WITHHELD_CREDENTIALS.probeCannotPin);
  });

  it('says why in each sentence, and what sends the set again', () => {
    assert.match(WITHHELD_CREDENTIALS.undecided, /a driver that resolves the name itself/);
    assert.match(WITHHELD_CREDENTIALS.probeCannotPin, /Upgrading the probe to protocol 24 sends/);
    for (const reason of [WITHHELD_CREDENTIALS.undecided, WITHHELD_CREDENTIALS.probeCannotPin]) {
      assert.match(reason, /^Not scanned: .* sends them again/);
    }
  });
});

// ---------------------------------------------------------------------------------------------

const REFUSED =
  'Not scanned: sw.dc.test resolves to 192.0.2.77, which is outside the allowed targets.';

function refused(sensorId: number, at: string, message = REFUSED): CheckResult {
  return { sensorId, at, outcome: 'error', message, durationMs: 1, channels: [], withheld: true };
}

function measured(sensorId: number, at: string, outcome: 'ok' | 'error' = 'ok'): CheckResult {
  return { sensorId, at, outcome, message: outcome, durationMs: 1, channels: [] };
}

/** A sensor as a configuration sends it when its set's targets leave the name to the probe. */
function leftToProbe(sensorId: number): SensorBeingSent {
  return {
    sensorId,
    sensorType: 'test.snmp.pinned',
    params: { port: 161 },
    host: 'sw.dc.test',
    ipVersion: 'auto',
    owners: new Map([['snmp', 900]]),
    restrictions: new Map([['snmp', { targets: ['10.20.0.0/16'], hostKeys: null }]]),
  };
}

describe('what a probe refuses to scan is held, not counted as a failed scan (A-41c)', () => {
  /**
   * A `CredentialVouching` with nothing behind it but a record of what it asked of the set.
   * Probes 7 and 8 have each been sent sensors 1 to 3 with a set that leaves the name to them.
   */
  async function holder(): Promise<{
    credentials: CredentialVouching;
    /** What the set was told to hold for a probe, each time it was told and took it. */
    settled: { owner: string; refused: Map<number, string> }[];
    /** What was let go without being re-decided. */
    released: { owner: string; sensorIds: number[] }[];
    /** What became of each release: `undo` or `evaluated`. */
    outcomes: string[];
    control: { failSettle: boolean };
    /** When each settle said its change was decided. */
    stamps: (Date | undefined)[];
    /** The clock the grace for a late refusal runs on (`A-53`), in milliseconds. */
    clock: { ms: number };
  }> {
    const clock = { ms: 5_000_000 };
    const stamps: (Date | undefined)[] = [];
    const settled: { owner: string; refused: Map<number, string> }[] = [];
    const released: { owner: string; sensorIds: number[] }[] = [];
    const outcomes: string[] = [];
    const control = { failSettle: false };
    const none = (): Promise<never> => Promise.reject(new Error('no transaction in this test'));
    const credentials = new CredentialVouching({
      // Nobody has vouched for anything: a restricted set is decided by its bounds alone.
      db: { query: () => Promise.resolve([]), tx: none },
      logger: silent,
      sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned])),
      rights: () => Promise.resolve(new Map()),
      now: () => clock.ms,
      vouching: {
        // What the core withholds itself, which is not what these tests are about.
        settle: () => Promise.resolve(0),
        settleOrThrow: (owner, refusedNow, at) => {
          if (control.failSettle) return Promise.reject(new Error('deadlock detected'));
          settled.push({ owner, refused: new Map(refusedNow) });
          stamps.push(at);
          return Promise.resolve(0);
        },
        release: (owner, sensorIds) => {
          released.push({ owner, sensorIds: [...sensorIds] });
          return {
            released: [...sensorIds],
            undo: () => {
              outcomes.push('undo');
            },
            evaluated: () => {
              outcomes.push('evaluated');
              return Promise.resolve();
            },
          };
        },
      },
    });
    for (const probeId of [7, 8]) {
      await credentials.withhold(probeId, [1, 2, 3].map(leftToProbe), PINNING);
    }
    return { credentials, settled, released, outcomes, control, stamps, clock };
  }

  const T = (seconds: number): string => new Date(1_790_000_000_000 + seconds * 1000).toISOString();

  it('passes a batch with no refusal straight through, and settles nothing', async () => {
    const { credentials, settled } = await holder();
    const batch = [measured(1, T(0)), measured(2, T(0), 'error')];
    const reported = await credentials.reported(7, batch);
    assert.equal(reported.results, batch);
    assert.equal(reported.unearned, 0);
    assert.equal(settled.length, 0);
    assert.equal(credentials.stats().withheld, 0);
  });

  it('takes a refused check out of the batch and holds its sensor, under the probe’s own name', async () => {
    const { credentials, settled } = await holder();
    const reported = await credentials.reported(7, [refused(1, T(0)), measured(2, T(0))]);
    assert.deepEqual(
      reported.results.map((result) => result.sensorId),
      [2],
    );
    assert.equal(reported.unearned, 0);
    assert.deepEqual(settled, [{ owner: 'credentials-probe:7', refused: new Map([[1, REFUSED]]) }]);
    assert.equal(credentials.stats().withheld, 1);
  });

  it('does not settle again for the same words at the next scan, and still takes the result', async () => {
    const { credentials, settled } = await holder();
    await credentials.reported(7, [refused(1, T(0))]);
    assert.deepEqual((await credentials.reported(7, [refused(1, T(60))])).results, []);
    assert.equal(settled.length, 1);
    // Other words are news: the name resolves somewhere else now.
    await credentials.reported(7, [refused(1, T(120), 'Not scanned: somewhere else.')]);
    assert.equal(settled.length, 2);
    assert.equal(settled[1]?.refused.get(1), 'Not scanned: somewhere else.');
  });

  it('lets a sensor go at its next result that is not a refusal, without re-deciding it', async () => {
    const { credentials, settled, released, outcomes } = await holder();
    await credentials.reported(7, [refused(1, T(0))]);
    const reported = await credentials.reported(7, [measured(1, T(60))]);
    assert.equal(reported.results.length, 1, 'the result is the machine’s, and decides the sensor');
    // Released, not settled: a settle re-decides the sensor from what it read before the hold.
    assert.deepEqual(released, [{ owner: 'credentials-probe:7', sensorIds: [1] }]);
    assert.equal(settled.length, 1, 'only the hold was settled');
    assert.equal(credentials.stats().withheld, 0);
    await reported.stored(true);
    assert.deepEqual(outcomes, ['evaluated']);
    // A failed scan lets it go too: the probe did ask the device this time.
    await credentials.reported(7, [refused(1, T(120))]);
    await credentials.reported(7, [measured(1, T(180), 'error')]);
    assert.equal(credentials.stats().withheld, 0);
  });

  it('holds the sensor again when the result that let it go was not stored', async () => {
    const { credentials, released, outcomes } = await holder();
    await credentials.reported(7, [refused(1, T(0))]);
    const reported = await credentials.reported(7, [measured(1, T(60))]);
    assert.equal(credentials.stats().withheld, 0);
    await reported.stored(false);
    assert.deepEqual(outcomes, ['undo']);
    assert.equal(credentials.stats().withheld, 1, 'held as it was, for the batch to come again');
    // And the batch, sent again, lets it go again.
    const again = await credentials.reported(7, [measured(1, T(60))]);
    assert.equal(released.length, 2);
    await again.stored(true);
    assert.equal(credentials.stats().withheld, 0);
  });

  it('is not let go by a reading older than the refusal: a spool replays', async () => {
    const { credentials, settled, released } = await holder();
    await credentials.reported(7, [refused(1, T(60))]);
    const reported = await credentials.reported(7, [measured(1, T(30))]);
    assert.equal(reported.results.length, 1, 'the old reading is still the machine’s to judge');
    assert.equal(settled.length, 1);
    assert.equal(released.length, 0);
    assert.equal(credentials.stats().withheld, 1);
  });

  it('holds nothing for a refusal older than the last result the machine took', async () => {
    const { credentials, settled } = await holder();
    const last = (): Date => new Date(T(100));
    assert.deepEqual((await credentials.reported(7, [refused(1, T(60))], last)).results, []);
    assert.deepEqual((await credentials.reported(7, [refused(1, T(100))], last)).results, []);
    assert.equal(settled.length, 0);
    await credentials.reported(7, [refused(1, T(101))], last);
    assert.equal(settled.length, 1);
  });

  it('reads one batch in the order it happened, whatever order it arrived in', async () => {
    const first = await holder();
    await first.credentials.reported(7, [measured(1, T(60)), refused(1, T(0))]);
    assert.equal(first.credentials.stats().withheld, 0, 'refused, then measured: let go');
    assert.equal(first.settled.length, 0, 'and never held: the reading decides it');
    assert.equal(first.released.length, 0);

    const second = await holder();
    const reported = await second.credentials.reported(7, [refused(1, T(60)), measured(1, T(0))]);
    assert.equal(second.credentials.stats().withheld, 1, 'measured, then refused: held');
    assert.equal(reported.results.length, 1);
  });

  it('keeps a hold a later refusal in the same batch renews, in its newer words', async () => {
    const { credentials, settled, released } = await holder();
    await credentials.reported(7, [refused(1, T(0))]);
    await credentials.reported(7, [
      measured(1, T(60)),
      refused(1, T(120), 'Not scanned: somewhere else.'),
    ]);
    assert.equal(released.length, 0, 'let go and refused again is still held');
    assert.equal(settled.at(-1)?.refused.get(1), 'Not scanned: somewhere else.');
    assert.equal(credentials.stats().withheld, 1);
  });

  it('stamps a hold as the probe measured it, and never ahead of this core’s clock', async () => {
    // A hold stamped with the core's clock sorted after the reading that let it go, when the
    // two came out of a spool together: the history ended on Unknown for a sensor that was Up.
    const { credentials, stamps } = await holder();
    await credentials.reported(7, [refused(2, T(30)), refused(1, T(10))]);
    assert.equal(stamps[0]?.toISOString(), T(10), 'the earliest refusal that is news');
    // The same words later are not news; other words are, at their own time.
    await credentials.reported(7, [
      refused(1, T(60)),
      refused(2, T(90), 'Not scanned: elsewhere.'),
    ]);
    assert.equal(stamps[1]?.toISOString(), T(90));

    // A probe whose clock runs a day ahead. A refusal passes no gate for that, so it is held
    // here to the core's own time.
    const ahead = new Date(Date.now() + 86_400_000).toISOString();
    const before = Date.now();
    await credentials.reported(7, [refused(3, ahead)]);
    const stamped = stamps[2]?.getTime() ?? Number.NaN;
    assert.ok(stamped >= before && stamped <= Date.now(), 'not tomorrow');
  });

  it('leaves a refusal whose time cannot be read to the machine’s own gate', async () => {
    const { credentials, settled } = await holder();
    const reported = await credentials.reported(7, [refused(1, 'not a time')]);
    assert.equal(reported.results.length, 1);
    assert.equal(settled.length, 0);
  });

  it('keeps each probe’s refusals apart, and lets a sensor’s new probe let go what its old one refused', async () => {
    const { credentials, settled, released } = await holder();
    await credentials.reported(7, [refused(1, T(0))]);
    await credentials.reported(8, [refused(2, T(0))]);
    assert.deepEqual(
      settled.map((one) => one.owner),
      ['credentials-probe:7', 'credentials-probe:8'],
    );
    assert.equal(credentials.stats().withheld, 2);
    // A result is admitted only from the probe a sensor is under now. Sensor 1 reported by probe
    // 8 has moved there, and probe 7 may never be sent another configuration to drop it by.
    const reported = await credentials.reported(8, [measured(1, T(60))]);
    assert.deepEqual(released, [{ owner: 'credentials-probe:7', sensorIds: [1] }]);
    assert.equal(credentials.stats().withheld, 1, 'probe 8 still refuses sensor 2');
    await reported.stored(false);
    assert.equal(credentials.stats().withheld, 2, 'and not stored, probe 7 holds it again');
  });

  it('drops what a probe refused once the sensor is no longer sent to it', async () => {
    const { credentials, settled } = await holder();
    await credentials.reported(7, [refused(1, T(0))]);
    // A configuration with no credentialed sensor in it: paused, moved away or deleted.
    await credentials.withhold(7, []);
    assert.equal(credentials.stats().withheld, 0);
    assert.deepEqual(settled.at(-1), { owner: 'credentials-probe:7', refused: new Map() });
  });

  describe('what it holds and what the set holds move together', () => {
    it('holds nothing when the set could not take a refusal, and says so to the caller', async () => {
      const { credentials, settled, control } = await holder();
      control.failSettle = true;
      await assert.rejects(credentials.reported(7, [refused(1, T(0))]), /deadlock detected/);
      // Written here first, every later refusal carried the same words, changed nothing, and was
      // never settled: the sensor kept its stored state with no result reaching the machine.
      assert.equal(credentials.stats().withheld, 0);

      control.failSettle = false;
      // The batch again, as the probe sends it after the nack: held this time.
      assert.deepEqual((await credentials.reported(7, [refused(1, T(0))])).results, []);
      assert.deepEqual(settled, [
        { owner: 'credentials-probe:7', refused: new Map([[1, REFUSED]]) },
      ]);
      assert.equal(credentials.stats().withheld, 1);
    });

    it('keeps the words it had when the set could not take the new ones', async () => {
      const { credentials, settled, control } = await holder();
      await credentials.reported(7, [refused(1, T(0))]);
      control.failSettle = true;
      await assert.rejects(credentials.reported(7, [refused(1, T(60), 'Not scanned: elsewhere.')]));
      control.failSettle = false;
      // Still news, because the failed attempt was not recorded as said.
      await credentials.reported(7, [refused(1, T(60), 'Not scanned: elsewhere.')]);
      assert.equal(settled.length, 2);
      assert.equal(settled[1]?.refused.get(1), 'Not scanned: elsewhere.');
    });

    it('goes on holding what a configuration could not let go, and lets it go at the next', async () => {
      const { credentials, control } = await holder();
      await credentials.reported(7, [refused(1, T(0))]);
      control.failSettle = true;
      await credentials.withhold(7, []);
      assert.equal(credentials.stats().withheld, 1, 'the set still holds it, and so does this');
      control.failSettle = false;
      await credentials.withhold(7, []);
      assert.equal(credentials.stats().withheld, 0);
    });
  });

  describe('a mark is honoured only where the probe could have refused', () => {
    it('takes a marked result for a sensor the probe was not left to check as the error it is', async () => {
      const { credentials, settled } = await holder();
      // Sensor 9 was sent to probe 7 with no set that leaves its name to the probe.
      const reported = await credentials.reported(7, [refused(9, T(0)), refused(1, T(0))]);
      assert.equal(reported.unearned, 1);
      assert.deepEqual(
        reported.results,
        [measured(9, T(0), 'error')].map((one) => ({
          ...one,
          message: REFUSED,
        })),
      );
      assert.equal('withheld' in (reported.results[0] ?? {}), false, 'the mark is gone');
      assert.deepEqual(settled, [
        { owner: 'credentials-probe:7', refused: new Map([[1, REFUSED]]) },
      ]);
      assert.equal(credentials.stats().withheld, 1);
    });

    it('takes a marked result that measured something as the result it is', async () => {
      const { credentials, settled } = await holder();
      const ok: CheckResult = { ...refused(1, T(0)), outcome: 'ok' };
      const readings: CheckResult = { ...refused(2, T(0)), channels: [{ key: 'a', value: 1 }] };
      const reported = await credentials.reported(7, [ok, readings]);
      assert.equal(reported.unearned, 2);
      assert.equal(reported.results.length, 2, 'neither reading is dropped');
      assert.equal(settled.length, 0);
      assert.equal(credentials.stats().withheld, 0);
    });

    it('lets a result that carries a mark it has no claim to release a hold, as any result does', async () => {
      const { credentials, released } = await holder();
      await credentials.reported(7, [refused(1, T(0))]);
      await credentials.reported(7, [{ ...refused(1, T(60)), outcome: 'ok' }]);
      assert.equal(released.length, 1);
      assert.equal(credentials.stats().withheld, 0);
    });

    it('honours nothing from a probe too old to have been sent such a set', async () => {
      const { credentials, settled, clock } = await holder();
      // The same sensors, to a probe at 23: the core withholds them itself, and none is left.
      await credentials.withhold(7, [1, 2, 3].map(leftToProbe), PINNING - 1);
      // Past the grace for what the probe at 24 refused before it was replaced (`A-53`).
      clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      const reported = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(reported.unearned, 1);
      assert.equal(reported.late, 0);
      assert.equal(reported.results.length, 1);
      assert.equal(settled.length, 0);
    });

    it('honours nothing once a configuration no longer sends the sensor, and its grace has run out', async () => {
      const { credentials, clock } = await holder();
      await credentials.withhold(7, [leftToProbe(2)], PINNING);
      clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      const reported = await credentials.reported(7, [refused(1, T(0)), refused(2, T(0))]);
      assert.equal(reported.unearned, 1);
      assert.equal(reported.late, 0);
      assert.deepEqual(
        reported.results.map((one) => one.sensorId),
        [1],
      );
    });
  });

  describe('a refusal is judged against the configuration it was made under (A-53)', () => {
    /** Probe 7's next configuration: sensor 1 is no longer left to it, 2 and 3 still are. */
    const stopLeaving = (credentials: CredentialVouching): Promise<unknown> =>
      credentials.withhold(7, [2, 3].map(leftToProbe), PINNING);

    it('drops a refusal that arrives after the configuration stopped leaving the sensor: no failed scan, no hold', async () => {
      const { credentials, settled, released } = await holder();
      await stopLeaving(credentials);
      const reported = await credentials.reported(7, [refused(1, T(0)), refused(2, T(0))]);
      assert.deepEqual(reported.results, [], 'nothing for the machine to count as a failure');
      assert.equal(reported.late, 1);
      assert.equal(reported.unearned, 0);
      // Sensor 2 is still the probe's to refuse, and is held; sensor 1 is not held by this.
      assert.deepEqual(settled, [
        { owner: 'credentials-probe:7', refused: new Map([[2, REFUSED]]) },
      ]);
      assert.equal(credentials.stats().withheld, 1);
      assert.equal(released.length, 0);
    });

    it('drops one that is the whole batch, and one whose time cannot be read', async () => {
      const { credentials, settled } = await holder();
      await stopLeaving(credentials);
      const reported = await credentials.reported(7, [refused(1, T(0)), refused(1, 'not a time')]);
      assert.deepEqual(reported.results, []);
      assert.equal(reported.late, 2);
      assert.equal(settled.length, 0);
      assert.equal(credentials.stats().withheld, 0);
    });

    it('takes a failed scan after the change as the failed scan it is', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      const failed = measured(1, T(5), 'error');
      const reported = await credentials.reported(7, [refused(1, T(0)), failed]);
      assert.deepEqual(reported.results, [failed]);
      assert.equal(reported.late, 1);
      assert.equal(reported.unearned, 0);
    });

    it('is bounded: to the last millisecond of the grace, and not one after', async () => {
      const { credentials, clock } = await holder();
      await stopLeaving(credentials);
      clock.ms += LATE_REFUSAL_GRACE_MS;
      const inside = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(inside.late, 1);
      assert.deepEqual(inside.results, []);

      clock.ms += 1;
      const after = await credentials.reported(7, [refused(1, T(1))]);
      assert.equal(after.late, 0);
      assert.equal(after.unearned, 1, 'a mark the probe has no claim to any more');
      assert.deepEqual(after.results, [{ ...measured(1, T(1), 'error'), message: REFUSED }]);
    });

    it('takes the bound it is given', async () => {
      const clock = { ms: 0 };
      const credentials = new CredentialVouching({
        db: { query: () => Promise.resolve([]), tx: () => Promise.reject(new Error('none')) },
        logger: silent,
        sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned])),
        rights: () => Promise.resolve(new Map()),
        now: () => clock.ms,
        lateRefusalGraceMs: 2_000,
      });
      await credentials.withhold(7, [leftToProbe(1)], PINNING);
      await credentials.withhold(7, [], PINNING);
      clock.ms = 2_000;
      assert.equal((await credentials.reported(7, [refused(1, T(0))])).late, 1);
      clock.ms = 2_001;
      assert.equal((await credentials.reported(7, [refused(1, T(0))])).late, 0);
    });

    it('is ten minutes unless told otherwise', () => {
      assert.equal(LATE_REFUSAL_GRACE_MS, 600_000);
    });

    it('counts the grace from the configuration that stopped leaving the sensor, not from a later one', async () => {
      const { credentials, clock } = await holder();
      await stopLeaving(credentials);
      // The same configuration again, built for another reason, six minutes on.
      clock.ms += 360_000;
      await stopLeaving(credentials);
      clock.ms += LATE_REFUSAL_GRACE_MS - 360_000;
      assert.equal((await credentials.reported(7, [refused(1, T(0))])).late, 1, 'still inside');
      clock.ms += 1;
      const after = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(after.late, 0, 'the later configuration did not start it again');
      assert.equal(after.unearned, 1);
    });

    it('forgets at the first configuration after the grace, and remembers until then', async () => {
      const { credentials, clock } = await holder();
      await stopLeaving(credentials);
      clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      await stopLeaving(credentials);
      // A clock set back does not bring it back: the entry is gone, not merely out of date.
      clock.ms -= LATE_REFUSAL_GRACE_MS;
      const reported = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(reported.late, 0);
      assert.equal(reported.unearned, 1);
    });

    it('starts again when the sensor is left to the probe and then is not', async () => {
      const { credentials, clock, settled } = await holder();
      await stopLeaving(credentials);
      clock.ms += 300_000;
      // Left again: a refusal is the probe's to make, and holds the sensor as any does.
      await credentials.withhold(7, [1, 2, 3].map(leftToProbe), PINNING);
      const held = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(held.late, 0);
      assert.equal(settled.length, 1);

      clock.ms += 240_000;
      await stopLeaving(credentials);
      // Ten minutes after the first time it stopped, and one after the second.
      clock.ms += 60_001;
      assert.equal((await credentials.reported(7, [refused(1, T(60))])).late, 1);
      clock.ms += LATE_REFUSAL_GRACE_MS;
      assert.equal((await credentials.reported(7, [refused(1, T(120))])).late, 0);
    });

    it('is only for the probe whose configuration changed, and only for a sensor it was left', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      // Probe 8 is still left sensor 1: its refusal is honoured, as a hold.
      const eight = await credentials.reported(8, [refused(1, T(0))]);
      assert.equal(eight.late, 0);
      assert.equal(credentials.stats().withheld, 1);
      // Sensor 9 was never left to probe 7, before or after.
      const seven = await credentials.reported(7, [refused(9, T(0))]);
      assert.equal(seven.late, 0);
      assert.equal(seven.unearned, 1);
      assert.equal(seven.results.length, 1);
    });

    it('drops only what a refusal looks like: a mark beside a reading or an ok is the result it is', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      const ok: CheckResult = { ...refused(1, T(0)), outcome: 'ok' };
      const readings: CheckResult = { ...refused(1, T(1)), channels: [{ key: 'a', value: 1 }] };
      const reported = await credentials.reported(7, [ok, readings]);
      assert.equal(reported.late, 0);
      assert.equal(reported.unearned, 2);
      assert.equal(reported.results.length, 2);
      assert.equal(
        reported.results.some((one) => 'withheld' in one),
        false,
      );
    });

    it('lets no hold go, another probe’s included: it measured nothing', async () => {
      const { credentials, released } = await holder();
      await credentials.reported(8, [refused(1, T(0))]);
      await stopLeaving(credentials);
      const reported = await credentials.reported(7, [refused(1, T(60))]);
      assert.equal(reported.late, 1);
      assert.equal(released.length, 0);
      assert.equal(credentials.stats().withheld, 1, 'probe 8 still holds it');
    });

    it('neither renews nor lets go a hold the probe already had on a sensor it is still sent', async () => {
      const { credentials, settled, released } = await holder();
      await credentials.reported(7, [refused(1, T(0))]);
      // Still sent, and no longer left: a name entry now covers the device.
      const covered: SensorBeingSent = {
        ...leftToProbe(1),
        restrictions: new Map([['snmp', { targets: ['*.dc.test'], hostKeys: null }]]),
      };
      await credentials.withhold(7, [covered, leftToProbe(2), leftToProbe(3)], PINNING);
      assert.equal(credentials.stats().withheld, 1, 'held until a result says otherwise');
      const late = await credentials.reported(7, [refused(1, T(60), 'Not scanned: other words.')]);
      assert.equal(late.late, 1);
      assert.equal(settled.length, 1, 'the words it was held in are not replaced');
      assert.equal(released.length, 0);

      // The scan under the new configuration lets it go, and decides it.
      const up = await credentials.reported(7, [measured(1, T(120))]);
      assert.equal(up.results.length, 1);
      assert.equal(released.length, 1);
      assert.equal(credentials.stats().withheld, 0);
    });

    it('forgets with the probe', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      // Nothing in the tree: probe 7 is gone.
      await credentials.reconcile();
      const reported = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(reported.late, 0);
      assert.equal(reported.unearned, 1);
    });
  });
});

describe('what a configuration stopped leaving to a probe is stored, and read back at start (A-61)', () => {
  /** The wall clock at the start of each case, in milliseconds. */
  const WALL = 1_790_000_000_000;
  const T = (seconds: number): string => new Date(WALL + seconds * 1000).toISOString();

  /** A row of `late_refusal_grace`, as `restore` reads one. */
  interface StoredRow {
    probe_id: string;
    sensor_id: string;
    stopped_ms: string;
  }
  /** What one write had the table hold for a probe. */
  interface Written {
    probeId: number;
    sensorIds: number[];
    stoppedAtMs: number[];
  }

  /** A row for probe 7's sensor 1, stored `offsetMs` from the wall clock's reading at start. */
  const storedAt = (offsetMs: number, sensorId = 1): StoredRow => ({
    probe_id: '7',
    sensor_id: String(sensorId),
    stopped_ms: String(WALL + offsetMs),
  });

  /**
   * A core over a table that holds `stored`, with both of its clocks in the test's hands. Nothing
   * has been sent to any probe: `leave` sends probe 7 the sensors it is left.
   */
  function core(stored: readonly StoredRow[] = []): {
    credentials: CredentialVouching;
    clock: { ms: number; wall: number };
    control: { failWrite: boolean; failRead: boolean; writeDelaysMs: number[] };
    /** When each write to the table began and ended, in the order it happened. */
    order: string[];
    written: Written[];
    leave: (sensorIds: readonly number[]) => Promise<unknown>;
    /** How many of these refusals from probe 7 for sensor 1 are taken as late. */
    late: (sensorId?: number, probeId?: number) => Promise<number>;
  } {
    const clock = { ms: 5_000_000, wall: WALL };
    const control = { failWrite: false, failRead: false, writeDelaysMs: [] as number[] };
    const written: Written[] = [];
    const order: string[] = [];
    const credentials = new CredentialVouching({
      db: {
        query: async <R>(sql: string, values: readonly unknown[] = []): Promise<R[]> => {
          if (sql.includes('INSERT INTO late_refusal_grace')) {
            const [probeId, sensorIds, stoppedAtMs] = values as [number, number[], number[]];
            order.push(`begin ${sensorIds.join(',')}`);
            const delay = control.writeDelaysMs.shift() ?? 0;
            if (delay > 0) await new Promise((done) => setTimeout(done, delay));
            order.push(`end ${sensorIds.join(',')}`);
            if (control.failWrite) throw new Error('connection terminated');
            written.push({ probeId, sensorIds: [...sensorIds], stoppedAtMs: [...stoppedAtMs] });
            return [];
          }
          if (sql.includes('FROM late_refusal_grace')) {
            if (control.failRead) throw new Error('relation "late_refusal_grace" does not exist');
            return [...stored] as R[];
          }
          return [];
        },
        tx: () => Promise.reject(new Error('no transaction in this test')),
      },
      logger: silent,
      sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned])),
      rights: () => Promise.resolve(new Map()),
      now: () => clock.ms,
      wallNow: () => clock.wall,
    });
    return {
      credentials,
      clock,
      control,
      written,
      order,
      leave: (sensorIds) => credentials.withhold(7, sensorIds.map(leftToProbe), PINNING),
      late: async (sensorId = 1, probeId = 7) =>
        (await credentials.reported(probeId, [refused(sensorId, T(0))])).late,
    };
  }

  describe('how a stored time becomes what is left of a grace', () => {
    const GRACE = LATE_REFUSAL_GRACE_MS;
    const cases: {
      name: string;
      stored: string;
      /** What the start makes of it, and how long a refusal is still late after it. */
      verdict: 'kept' | 'ahead' | 'spent';
      leftMs?: number;
    }[] = [
      { name: 'this instant', stored: String(WALL), verdict: 'kept', leftMs: GRACE },
      { name: 'two minutes ago', stored: String(WALL - 120_000), verdict: 'kept', leftMs: 480_000 },
      { name: 'the last millisecond', stored: String(WALL - GRACE), verdict: 'kept', leftMs: 0 },
      { name: 'one millisecond past', stored: String(WALL - GRACE - 1), verdict: 'spent' },
      {
        name: 'a day ago: down that long, or set forward',
        stored: String(WALL - 86_400_000),
        verdict: 'spent',
      },
      { name: 'the epoch', stored: '0', verdict: 'spent' },
      {
        name: 'one millisecond ahead: set back',
        stored: String(WALL + 1),
        verdict: 'ahead',
        leftMs: GRACE,
      },
      {
        name: 'an hour ahead: set back',
        stored: String(WALL + 3_600_000),
        verdict: 'ahead',
        leftMs: GRACE,
      },
      { name: 'a century ahead', stored: String(WALL + 3.2e12), verdict: 'ahead', leftMs: GRACE },
      { name: 'infinity', stored: 'Infinity', verdict: 'spent' },
      { name: 'minus infinity', stored: '-Infinity', verdict: 'spent' },
      { name: 'not a number', stored: 'NaN', verdict: 'spent' },
      { name: 'not a time at all', stored: 'yesterday', verdict: 'spent' },
    ];

    for (const one of cases) {
      it(`stored ${one.name}: ${one.verdict}`, async () => {
        const stop = storedStop(Number(one.stored), WALL, GRACE);
        assert.equal(stop.verdict, one.verdict);
        if (stop.verdict !== 'spent') {
          assert.equal(stop.elapsedMs, GRACE - (one.leftMs ?? Number.NaN));
          assert.ok(stop.elapsedMs >= 0 && stop.elapsedMs <= GRACE, 'never more than the grace');
        }

        // And the same through a start: what it counts, what it writes, how long it lasts.
        const { credentials, clock, written, late } = core([
          { probe_id: '7', sensor_id: '1', stopped_ms: one.stored },
        ]);
        assert.deepEqual(await credentials.restore(), {
          restored: one.verdict === 'spent' ? 0 : 1,
          ahead: one.verdict === 'ahead' ? 1 : 0,
          spent: one.verdict === 'spent' ? 1 : 0,
        });
        if (one.leftMs === undefined) {
          assert.equal(await late(), 0, 'the failed scan it was before anything was stored');
          assert.deepEqual(written, [{ probeId: 7, sensorIds: [], stoppedAtMs: [] }], 'removed');
          return;
        }
        // Written down again as now when it was ahead, and left alone when it was not.
        assert.deepEqual(
          written,
          one.verdict === 'ahead' ? [{ probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] }] : [],
        );
        clock.ms += one.leftMs;
        assert.equal(await late(), 1, 'to the last millisecond of what was left');
        clock.ms += 1;
        assert.equal(await late(), 0, 'and not one after: never more than the grace');
      });
    }

    it('does not take the clock it starts at on trust either', () => {
      assert.deepEqual(storedStop(WALL, Number.NaN, GRACE), { verdict: 'spent' });
      assert.deepEqual(storedStop(WALL, Number.POSITIVE_INFINITY, GRACE), { verdict: 'spent' });
    });

    it('takes the bound it is given', () => {
      assert.deepEqual(storedStop(WALL - 2_000, WALL, 2_000), {
        verdict: 'kept',
        elapsedMs: 2_000,
      });
      assert.deepEqual(storedStop(WALL - 2_001, WALL, 2_000), { verdict: 'spent' });
    });
  });

  describe('what a start takes up is an entry like any other', () => {
    it('is for the probe and the sensor the row names, and for no other', async () => {
      const { credentials, late } = core([storedAt(-60_000)]);
      await credentials.restore();
      assert.equal(await late(1, 7), 1);
      assert.equal(await late(2, 7), 0, 'another sensor of the same probe');
      assert.equal(await late(1, 8), 0, 'the same sensor from another probe');
    });

    it('drops only what a refusal looks like, as before the restart', async () => {
      const { credentials } = core([storedAt(-60_000)]);
      await credentials.restore();
      const ok: CheckResult = { ...refused(1, T(0)), outcome: 'ok' };
      const readings: CheckResult = { ...refused(1, T(1)), channels: [{ key: 'a', value: 1 }] };
      const failed = measured(1, T(2), 'error');
      const reported = await credentials.reported(7, [ok, readings, failed, refused(1, T(3))]);
      assert.equal(reported.late, 1);
      assert.equal(reported.unearned, 2);
      assert.equal(reported.results.length, 3, 'a failed scan after the restart is a failed scan');
    });

    it('is not started again by the configuration the restarted core builds', async () => {
      const { credentials, clock, written, leave, late } = core([storedAt(-120_000)]);
      await credentials.restore();
      // The probe redials and is sent its configuration: sensor 1 is not left to it, as stored.
      await leave([2, 3]);
      assert.deepEqual(written, [], 'nothing moved, so nothing is written');
      clock.ms += 480_000;
      assert.equal(await late(), 1);
      clock.ms += 1;
      assert.equal(await late(), 0, 'eight minutes after the start, ten after it stopped');
    });

    it('goes when the sensor is left to the probe again, from the table too', async () => {
      const { credentials, written, leave, late } = core([storedAt(-60_000), storedAt(-60_000, 2)]);
      await credentials.restore();
      await leave([1, 3]);
      assert.equal(written.length, 1);
      assert.deepEqual(written[0]?.sensorIds, [2], 'sensor 1 is gone, sensor 2 stays');
      assert.equal(await late(1), 0, 'the probe’s to refuse again');
      assert.equal(await late(2), 1);
    });

    it('does not start a core that cannot read the record', async () => {
      const { credentials, control } = core([storedAt(-60_000)]);
      control.failRead = true;
      await assert.rejects(credentials.restore(), /late_refusal_grace/);
    });

    it('reads an empty table as nothing, and writes nothing', async () => {
      const { credentials, written } = core();
      assert.deepEqual(await credentials.restore(), { restored: 0, ahead: 0, spent: 0 });
      assert.deepEqual(written, []);
    });

    it('keeps one probe’s rows when another’s are spent', async () => {
      const { credentials, written, late } = core([
        storedAt(-60_000),
        { probe_id: '8', sensor_id: '1', stopped_ms: String(WALL - LATE_REFUSAL_GRACE_MS - 1) },
      ]);
      assert.deepEqual(await credentials.restore(), { restored: 1, ahead: 0, spent: 1 });
      assert.deepEqual(written, [{ probeId: 8, sensorIds: [], stoppedAtMs: [] }]);
      assert.equal(await late(1, 7), 1);
      assert.equal(await late(1, 8), 0);
    });
  });

  describe('what is written, and when', () => {
    it('writes when a configuration stops leaving a sensor, and nothing when one changes nothing', async () => {
      const { written, leave } = core();
      await leave([1, 2, 3]);
      assert.deepEqual(written, [], 'nothing has stopped being left');
      await leave([2, 3]);
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] }]);
      await leave([2, 3]);
      await leave([2, 3]);
      assert.equal(written.length, 1, 'the same configuration again writes nothing');
    });

    it('writes each time as the wall clock would have read it when the sensor stopped being left', async () => {
      const { clock, written, leave } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      clock.ms += 120_000;
      clock.wall += 120_000;
      await leave([3]);
      assert.deepEqual(written.at(-1), {
        probeId: 7,
        sensorIds: [1, 2],
        stoppedAtMs: [WALL, WALL + 120_000],
      });
      // A wall clock set forward an hour meanwhile: what has run is what the monotonic one says.
      clock.ms += 60_000;
      clock.wall += 3_660_000;
      await leave([]);
      assert.deepEqual(written.at(-1), {
        probeId: 7,
        sensorIds: [1, 2, 3],
        stoppedAtMs: [WALL + 3_600_000, WALL + 3_720_000, WALL + 3_780_000],
      });
    });

    it('takes the row away when the sensor is left again, and at the first configuration after its grace', async () => {
      const { clock, written, leave } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      await leave([1, 2, 3]);
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [], stoppedAtMs: [] });
      await leave([2, 3]);
      assert.equal(written.length, 3);
      clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      await leave([2, 3]);
      assert.equal(written.length, 4);
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [], stoppedAtMs: [] });
    });

    it('still judges by what it holds when a write fails, and writes again at the next configuration', async () => {
      const { control, written, leave, late } = core();
      await leave([1, 2, 3]);
      control.failWrite = true;
      await leave([2, 3]);
      assert.deepEqual(written, []);
      assert.equal(await late(), 1, 'the running core has lost nothing');
      control.failWrite = false;
      await leave([2, 3]);
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] }]);
      await leave([2, 3]);
      assert.equal(written.length, 1, 'and once it has landed, not again');
    });

    it('writes one after another, so the last to land is the latest', async () => {
      const { control, written, order, leave } = core();
      await leave([1, 2, 3]);
      // The first write is slow, and another configuration is built while it is on its way.
      control.writeDelaysMs.push(40, 0);
      const first = leave([2, 3]);
      await new Promise((done) => setTimeout(done, 5));
      assert.deepEqual(order, ['begin 1']);
      await Promise.all([first, leave([3])]);
      // The second did not begin until the first had landed, and it is what the table holds.
      assert.deepEqual(order, ['begin 1', 'end 1', 'begin 1,2', 'end 1,2']);
      assert.deepEqual(written.at(-1)?.sensorIds, [1, 2]);
    });

    it('writes nothing a probe sends: a batch of marked results touches no row', async () => {
      const { credentials, written, leave } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      const before = written.length;
      await credentials.reported(7, [
        refused(1, T(0)),
        refused(2, T(0)),
        refused(9, T(0)),
        measured(3, T(0), 'error'),
      ]);
      await credentials.reported(8, [refused(1, T(0))]);
      assert.equal(written.length, before);
    });
  });

  describe('the running core', () => {
    it('reads the record before the probe endpoint exists, and prunes it on a timer', async () => {
      // `main.ts` is not started by any test. What can be held to is its order: a result
      // reaches `reported` only through the endpoint, which is built after the record is read.
      const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
      const main = await readFile(join(repoRoot, 'packages', 'core', 'src', 'main.ts'), 'utf8');
      const adopted = main.indexOf('await credentialVouching.adopt();');
      const restored = main.indexOf('await credentialVouching.restore();');
      const endpoint = main.indexOf('new ProbeEndpoint(');
      const ingestion = main.indexOf('credentialRefusals: credentialVouching');
      for (const [what, where] of Object.entries({ adopted, restored, endpoint, ingestion })) {
        assert.ok(where >= 0, `main.ts no longer has what this looks for: ${what}`);
      }
      assert.ok(adopted < restored, 'after the vouchers are adopted');
      assert.ok(restored < ingestion, 'before anything that judges a result is built');
      assert.ok(restored < endpoint, 'before the probe endpoint is built');
      assert.match(main, /run: \(\) => credentialVouching\.prune\(\),\n\s+intervalMs: 60_000,/);
      assert.match(main, /lateRefusalPrune\.start\(\);/);
    });
  });

  describe('pruned past the grace, without waiting for a configuration', () => {
    it('drops an entry one millisecond past its grace, here and in the table, and not before', async () => {
      const { credentials, clock, written, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      await credentials.prune();
      clock.ms += LATE_REFUSAL_GRACE_MS;
      await credentials.prune();
      assert.equal(written.length, 1, 'inside the grace there is nothing to prune or to write');
      assert.equal(await late(), 1);

      clock.ms += 1;
      await credentials.prune();
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [], stoppedAtMs: [] });
      assert.equal(written.length, 2);
      // Gone, not merely out of date: a clock set back does not bring it back.
      clock.ms -= LATE_REFUSAL_GRACE_MS;
      assert.equal(await late(), 0);
      await credentials.prune();
      assert.equal(written.length, 2, 'and nothing more to write');
    });

    it('keeps what is still inside its grace when it drops what is not', async () => {
      const { credentials, clock, written, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      clock.ms += 300_000;
      clock.wall += 300_000;
      await leave([3]);
      clock.ms += 300_001;
      clock.wall += 300_001;
      await credentials.prune();
      assert.deepEqual(written.at(-1), {
        probeId: 7,
        sensorIds: [2],
        stoppedAtMs: [WALL + 300_000],
      });
      assert.equal(await late(1), 0);
      assert.equal(await late(2), 1);
    });

    it('prunes what a start took up, for a probe that never redials', async () => {
      const { credentials, clock, written } = core([storedAt(-120_000)]);
      await credentials.restore();
      clock.ms += 480_001;
      await credentials.prune();
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [], stoppedAtMs: [] }]);
    });

    it('writes again what an earlier write could not', async () => {
      const { credentials, control, written, leave } = core();
      await leave([1, 2, 3]);
      control.failWrite = true;
      await leave([2, 3]);
      await credentials.prune();
      assert.deepEqual(written, []);
      control.failWrite = false;
      await credentials.prune();
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] }]);
      await credentials.prune();
      assert.equal(written.length, 1);
    });
  });
});

describe('a set that says when it did not land, and lets go without re-deciding (A-41c)', () => {
  function vouchingOf(): {
    vouching: SensorVouching;
    calls: string[];
    control: { failTx: boolean };
  } {
    const calls: string[] = [];
    const control = { failTx: false };
    const q = { query: () => Promise.resolve([]) };
    const vouching = new SensorVouching({
      db: {
        query: () => Promise.resolve([]),
        tx: (fn) => (control.failTx ? Promise.reject(new Error('deadlock detected')) : fn(q)),
      },
      logger: silent,
      sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned])),
      sight: () => Promise.reject(new Error('nobody is asked in this test')),
      states: {
        reevaluate: (_q, sensorIds, at) => {
          calls.push(`reevaluate ${sensorIds.join(',')} at ${at.toISOString()}`);
          return Promise.resolve(sensorIds.length);
        },
        forgetSensors: (sensorIds) => {
          calls.push(`forget ${sensorIds.join(',')}`);
        },
      },
      dependencies: {
        holdWithheld: () => Promise.resolve(),
        returnWithheld: (_q, sensorIds) => {
          calls.push(`return ${sensorIds.join(',')}`);
          return Promise.resolve();
        },
        recompute: () => {
          calls.push('recompute');
          return Promise.resolve({ moved: 0 });
        },
      },
    });
    return { vouching, calls, control };
  }

  it('throws from settleOrThrow when the write fails, with the set as it was', async () => {
    const { vouching, control } = vouchingOf();
    control.failTx = true;
    await assert.rejects(
      vouching.settleOrThrow('credentials-probe:7', new Map([[1, 'refused']])),
      /deadlock detected/,
    );
    assert.equal(vouching.withheld().has(1), false, 'put back: nothing is held');
    // The sweep's settle swallows the same failure, because its next sweep settles again.
    assert.equal(await vouching.settle('credentials-probe:7', new Map([[1, 'refused']])), 0);
    assert.equal(vouching.withheld().has(1), false);

    control.failTx = false;
    assert.equal(await vouching.settleOrThrow('credentials-probe:7', new Map([[1, 'refused']])), 1);
    assert.equal(vouching.withheld().get(1), 'refused');
  });

  it('re-decides at the time it is told the change was decided', async () => {
    const { vouching, calls } = vouchingOf();
    const at = new Date('2026-09-30T08:00:00.000Z');
    await vouching.settleOrThrow('credentials-probe:7', new Map([[1, 'refused']]), at);
    assert.equal(calls[0], 'reevaluate 1 at 2026-09-30T08:00:00.000Z');
  });

  it('lets go without re-deciding, and drops what is cached about the sensor', async () => {
    const { vouching, calls } = vouchingOf();
    await vouching.settleOrThrow(
      'credentials-probe:7',
      new Map([
        [1, 'refused'],
        [2, 'refused'],
      ]),
    );
    calls.length = 0;

    const hold = vouching.release('credentials-probe:7', [1, 5]);
    assert.deepEqual(hold.released, [1]);
    assert.equal(vouching.withheld().has(1), false);
    assert.equal(vouching.withheld().has(2), true, 'the other stays held');
    assert.deepEqual(calls, ['forget 1'], 'nothing re-decided, and the cache dropped');

    await hold.evaluated();
    assert.deepEqual(calls, ['forget 1', 'return 1', 'recompute']);
  });

  it('puts a release back as it was held', async () => {
    const { vouching, calls } = vouchingOf();
    await vouching.settleOrThrow('credentials-probe:7', new Map([[1, 'refused']]));
    const hold = vouching.release('credentials-probe:7', [1]);
    calls.length = 0;
    hold.undo();
    assert.equal(vouching.withheld().get(1), 'refused');
    assert.deepEqual(calls, ['forget 1'], 'the cache must not go on saying it is let go');
  });

  it('does not count a sensor another owner still withholds as released', async () => {
    const { vouching } = vouchingOf();
    await vouching.settleOrThrow('credentials-probe:7', new Map([[1, 'refused by the probe']]));
    await vouching.settle('credentials:7', new Map([[1, 'withheld by the core']]));
    const hold = vouching.release('credentials-probe:7', [1]);
    assert.deepEqual(hold.released, []);
    assert.equal(vouching.withheld().get(1), 'withheld by the core');
  });

  it('settles what depends on a released sensor at the next release when the write failed', async () => {
    const { vouching, calls, control } = vouchingOf();
    await vouching.settleOrThrow(
      'credentials-probe:7',
      new Map([
        [1, 'refused'],
        [2, 'refused'],
      ]),
    );
    const first = vouching.release('credentials-probe:7', [1]);
    control.failTx = true;
    await first.evaluated();
    control.failTx = false;
    calls.length = 0;
    const second = vouching.release('credentials-probe:7', [2]);
    await second.evaluated();
    assert.deepEqual(calls, ['forget 2', 'return 1,2', 'recompute']);
  });

  it('has nothing to release for an owner that holds none of them', async () => {
    const { vouching, calls } = vouchingOf();
    const hold = vouching.release('credentials-probe:7', [1]);
    assert.deepEqual(hold.released, []);
    await hold.evaluated();
    hold.undo();
    assert.deepEqual(calls, []);
  });
});

describe('a move or a delete is told to whatever holds sensors against a probe (A-41c)', () => {
  it('calls after the commit, once for a move and once for a delete, and not for anything else', async () => {
    let called = 0;
    const invalidator = new ResultCacheInvalidator({
      channels: { forget: () => 0, clear: () => undefined },
      afterMoveOrDelete: () => {
        called += 1;
      },
      logger: silent,
    });
    const commits: (() => void)[] = [];
    const q = {
      query: () => Promise.resolve([]),
      afterCommit: (fn: () => void) => {
        commits.push(fn);
      },
    };
    const mutation = (action: string): never => ({ action, objectId: 5 }) as never;
    await invalidator.record(q, testActor, [mutation('object.moved')], new Date());
    assert.equal(called, 0, 'not inside the transaction: the tree it reads has not moved yet');
    for (const commit of commits.splice(0)) commit();
    assert.equal(called, 1);

    await invalidator.record(q, testActor, [mutation('object.deleted')], new Date());
    for (const commit of commits.splice(0)) commit();
    assert.equal(called, 2);

    await invalidator.record(q, testActor, [mutation('setting.set')], new Date());
    for (const commit of commits.splice(0)) commit();
    assert.equal(called, 2);
  });
});

// ---------------------------------------------------------------------------------------------

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

const DEVICES = 6;
const T0 = new Date(Date.now() - 3_600_000);
const later = (seconds: number): Date => new Date(Date.now() + seconds * 1000);

describe(
  'a named device, a set bounded by addresses, and the probe that checks it (A-41c)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let dispatcher: NotificationDispatcher;
    let vouching: SensorVouching;
    let credentials: CredentialVouching;
    let config: ProbeConfigService;
    const seen: OutgoingMessage[] = [];

    const gate = catalogueSensorTypeGate(testCatalogue([snmpPinned, dbQuery, sshLoad]));
    let site = 0;
    let batch = 0;
    /** How far the clock `credentials` reads is ahead of the real one: a test moves it on. */
    const ahead = { ms: 0 };

    async function count(sql: string, values: unknown[] = []): Promise<number> {
      const [row] = await db.query<{ n: string }>(sql, values);
      return Number(row?.n);
    }

    const requests = (): Promise<number> =>
      count('SELECT count(*)::text AS n FROM notification_request');

    const downs = (sensorIds: readonly number[]): Promise<number> =>
      count(
        `SELECT count(*)::text AS n FROM sensor_state
         WHERE sensor_id = ANY($1::bigint[]) AND state::text LIKE 'down%'`,
        [sensorIds],
      );

    /** Results straight into the machine, for what was measured before the scenario starts. */
    async function ingest(results: readonly SensorResult[]): Promise<void> {
      const service = h.states ?? assert.fail('no state service');
      const decisions = await service.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    /** A probe's batch, through the ingestion service a probe's batch really goes through. */
    async function fromProbe(
      results: readonly CheckResult[],
      probeObjectId: number = site,
      refusals?: ProbeRefusals,
      /** A core that is shutting down: it takes nothing, and the probe sends the batch again. */
      shuttingDown = false,
    ): Promise<unknown> {
      // With the alarm engine, as the running core's ingestor has: a transition a result makes
      // arms and stands down the same chains one made by a re-decision does.
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms: engine });
      const ingestion = new IngestionService({
        db,
        logger: silent,
        ingestor,
        credentialRefusals: credentials,
        ...(refusals === undefined ? {} : { refusals }),
        ...(h.states === undefined ? {} : { states: h.states }),
      });
      batch += 1;
      if (shuttingDown) await ingestor.stop();
      const reply = await ingestion.acceptProbeResults(
        { gid: `gid-${String(probeObjectId)}`, probeObjectId },
        { type: 'results', batchId: `b${String(batch)}`, results: [...results] },
      );
      await ingestor.stop();
      return reply;
    }

    async function stateOf(sensorId: number): Promise<{ state: string; message: string }> {
      const [row] = await db.query<{ state: string; message: string }>(
        'SELECT state::text AS state, message FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      return row ?? assert.fail(`sensor ${String(sensorId)} has no runtime`);
    }

    async function drain(now: Date): Promise<void> {
      for (let round = 0; round < 40; round += 1) {
        if ((await dispatcher.dispatch(now)) === 0) return;
      }
      assert.fail('the queue never drained');
    }

    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await h.service.create(testActor, input as never)).id;

    const sentTo = async (version: number, sensorId: number, probe = site): Promise<boolean> =>
      (await config.assignmentsFor(probe, version)).sensors.some(
        (one) => one.sensorId === sensorId,
      );

    /** A device named by host name under `probe`, in a group whose SNMP set names only a range. */
    async function named(
      probe: number,
      name: string,
    ): Promise<{ group: number; device: number; sensor: number }> {
      const group = await create({ kind: 'group', parentId: probe, name: `${name} group` });
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: `${name}-secret`,
        allowedTargets: ['10.20.0.0/16'],
      });
      const device = await create({
        kind: 'device',
        parentId: group,
        name,
        host: `${name}.dc.test`,
      });
      const sensor = await create({
        kind: 'sensor',
        parentId: device,
        name: `${name} uptime`,
        sensorType: 'test.snmp.pinned',
        params: { port: 161 },
      });
      return { group, device, sensor };
    }

    const history = (sensorId: number): Promise<{ state: string; previous: string | null }[]> =>
      db.query<{ state: string; previous: string | null }>(
        `SELECT state::text AS state, previous_state::text AS previous
         FROM sensor_state WHERE sensor_id = $1 ORDER BY time, state`,
        [sensorId],
      );

    const at = (secondsFromNow: number): string =>
      new Date(Date.now() + secondsFromNow * 1000).toISOString();

    before(async () => {
      scratch = await createScratchDatabase('credential_pinning');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        withheldSensors: () => vouching.withheld(),
        types: [snmpPinned, dbQuery, sshLoad],
      });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      const triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      const contexts = new MessageContextLoader({
        settings: h.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'Pinning',
      });
      const templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
      dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [
          {
            method: 'email',
            send: (message: OutgoingMessage) => {
              seen.push(message);
              return Promise.resolve({ ok: true, detail: 'recorded' } as const);
            },
          },
        ],
        retry: { firstDelayMs: 0, maxDelayMs: 0 },
        leaseMs: 0,
      });
      const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      vouching = new SensorVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        sight: (principal, q) => access.visibilityFor(principal, q),
        states: h.states ?? assert.fail('no state service'),
      });
      credentials = new CredentialVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        rights: (principal, objectIds, q) => access.resolveManyFor(principal, objectIds, q),
        vouching,
        now: () => performance.now() + ahead.ms,
      });
      config = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
        vault: h.vault,
        credentialKindsFor: (sensorType) => gate.credentialKinds(sensorType),
        credentialCheck: credentials,
      });

      site = await create({ kind: 'probe', parentId: h.rootId, name: 'site' });

      // What an installation that wants to hear about trouble has: a digest of a minute, on
      // Down and on Unknown, at the root.
      for (const state of ['down', 'unknown'] as const) {
        const template = await templates.create(testActor, {
          name: `Pinning ${state}`,
          method: 'email',
          settings: {},
          subject: '%sensor is %status',
          body: '%lastmessage',
          recipients: [{ kind: 'address', value: 'noc@example.test' }],
          summaryWindowSeconds: 60,
        });
        await triggers.create(testActor, h.rootId, {
          kind: 'state',
          settings: {
            state,
            initialLatencySeconds: 0,
            initialTemplateId: template.id,
            recoveryTemplateId: template.id,
          },
        });
      }
    });

    after(async () => {
      await scratch.drop();
    });

    // First, so that the pages it counts are its own: the tests after it leave sensors Unknown
    // on this probe too, and the triggers are at the root.
    it('a group whose names move outside pages once per sensor as Unknown, never Down, in one digest', async () => {
      const group = await create({ kind: 'group', parentId: site, name: 'racks' });
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: 'racks-secret',
        allowedTargets: ['10.20.0.0/16'],
      });
      const uptime: number[] = [];
      const pings: number[] = [];
      for (let index = 0; index < DEVICES; index += 1) {
        const device = await create({
          kind: 'device',
          parentId: group,
          name: `rack-${String(index)}`,
          host: `rack-${String(index)}.dc.test`,
        });
        uptime.push(
          await create({
            kind: 'sensor',
            parentId: device,
            name: `rack-${String(index)} uptime`,
            sensorType: 'test.snmp.pinned',
            params: { port: 161 },
          }),
        );
        pings.push(
          await create({
            kind: 'sensor',
            parentId: device,
            name: `rack-${String(index)} ping`,
            sensorType: 'icmp.ping',
          }),
        );
      }
      await ingest(
        [...uptime, ...pings].map((sensorId) => ({
          sensorId,
          at: T0,
          outcome: 'ok' as const,
          message: 'fine',
        })),
      );
      for (const id of uptime) assert.equal(await sentTo(24, id), true);
      const asked = await requests();
      // What the core itself withholds on this probe, from the test before: not this test's.
      const withheldBefore = credentials.stats().withheld;
      seen.length = 0;

      // The names now resolve outside the targets. The probe refuses each check and sends the
      // devices nothing; the pings, which use no credential, go on answering.
      const now = new Date().toISOString();
      const sentence = (index: number): string =>
        `Not scanned: rack-${String(index)}.dc.test resolves to 192.0.2.${String(index)}, which ` +
        'is outside the allowed targets of the snmp credentials it would use, so they are not sent.';
      const reply = await fromProbe([
        ...uptime.map((sensorId, index) => refused(sensorId, now, sentence(index))),
        ...pings.map((sensorId) => ({ ...measured(sensorId, now), message: '4/4 replies' })),
      ]);
      assert.equal((reply as { type: string }).type, 'results-ack');

      for (const [index, id] of uptime.entries()) {
        assert.deepEqual(await stateOf(id), { state: 'unknown', message: sentence(index) });
      }
      for (const id of pings) assert.equal((await stateOf(id)).state, 'up');
      assert.equal(await downs(uptime), 0, 'a refused check is not a failed scan');
      assert.equal(credentials.stats().withheld, withheldBefore + DEVICES);

      // One page per sensor from the Unknown trigger, none from the Down trigger, and one
      // digest when the window closes: what narrowing a set raises (`A-41b`), and no more.
      assert.equal(await scheduler.sweep(later(120)), DEVICES);
      assert.equal(await requests(), asked + DEVICES);
      await drain(later(121));
      assert.equal(seen.length, 0, 'nothing sent before the window closes');
      await drain(later(300));
      assert.equal(seen.length, 1, `${String(DEVICES)} refused sensors, one message`);
      assert.deepEqual(
        [...(seen[0]?.about ?? [])].sort((a, b) => a - b),
        [...uptime].sort((a, b) => a - b),
      );

      // A batch that is nothing but refusals is acknowledged, and changes nothing more.
      const again = await fromProbe(
        uptime.map((sensorId, index) =>
          refused(sensorId, new Date(Date.now() + 1_000).toISOString(), sentence(index)),
        ),
      );
      assert.deepEqual(again, {
        type: 'results-ack',
        batchId: `b${String(batch)}`,
        storedSamples: 0,
        retryAfterMs: 0,
      });
      assert.equal(await requests(), asked + DEVICES, 'the same refusal again raises nothing');

      // The probe is still sent them: it is the one that finds out when the names come back.
      for (const id of uptime) {
        assert.equal(await sentTo(24, id), true);
        assert.equal(vouching.withheld().has(id), true, 'and a new configuration lets none go');
      }

      // The names resolve inside again, and each sensor is Up at the scan that found out, with
      // no Down on the way.
      const back = new Date(Date.now() + 2_000).toISOString();
      await fromProbe(
        uptime.map((sensorId) => ({ ...measured(sensorId, back), message: 'up 9 d' })),
      );
      for (const id of uptime) {
        assert.deepEqual(await stateOf(id), { state: 'up', message: 'up 9 d' });
        assert.equal(vouching.withheld().has(id), false);
      }
      assert.equal(await downs(uptime), 0);
      assert.equal(credentials.stats().withheld, withheldBefore);

      // A refusal replayed from the spool, older than that reading, holds nothing.
      await fromProbe([refused(uptime[0] ?? 0, now, sentence(0))]);
      assert.equal(vouching.withheld().has(uptime[0] ?? 0), false);
      assert.equal((await stateOf(uptime[0] ?? 0)).state, 'up');
    });

    it('sends the set to a type that pins through a probe at 24, and to nothing else', async () => {
      const group = await create({ kind: 'group', parentId: site, name: 'gate' });
      const device = await create({
        kind: 'device',
        parentId: group,
        name: 'named switch',
        host: 'sw.gate.test',
      });
      const pinned = await create({
        kind: 'sensor',
        parentId: device,
        name: 'pinned',
        sensorType: 'test.snmp.pinned',
        params: { port: 161 },
      });
      const traffic = await create({
        kind: 'sensor',
        parentId: device,
        name: 'by name',
        sensorType: 'snmp.traffic',
        params: { port: 161 },
      });
      const query = await create({
        kind: 'sensor',
        parentId: device,
        name: 'query',
        sensorType: 'test.db.query',
        params: { port: 5432 },
      });

      // The write counts only what the core itself withholds: the two a probe cannot pin. The
      // pinned one is the probe's to decide, at each scan.
      const snmp = await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: 'gate-secret',
        allowedTargets: ['10.20.0.0/16'],
      });
      assert.equal(snmp.withholds, 1);
      // And it is this write that put it there (`A-55`): none before, one newly.
      assert.equal(snmp.withheldBefore, 0);
      assert.equal(snmp.newlyWithheld, 1);
      // For the reason that it cannot be pinned, and not for where its device is (`A-59`).
      assert.deepEqual(snmp.byReason, {
        outside: { withholds: 0, withheldBefore: 0, newlyWithheld: 0, noLongerWithheld: 0 },
        unpinnable: { withholds: 1, withheldBefore: 0, newlyWithheld: 1, noLongerWithheld: 0 },
      });
      const database = await h.service.setCredential(testActor, group, 'database', {
        username: 'monitor',
        password: 'gate-password',
        allowedTargets: ['10.20.0.0/16'],
      });
      assert.equal(database.withholds, 1);
      // Saved again as it stands: the sensor that cannot pin is outside as it was, the save
      // put none there, and the one the probe decides is on neither side.
      const again = await h.service.setCredential(
        testActor,
        group,
        'snmp',
        { allowedTargets: ['10.20.0.0/16'] },
        { kind: 'none' },
        { preview: true },
      );
      assert.deepEqual(
        [again.withholds, again.withheldBefore, again.newlyWithheld, again.noLongerWithheld],
        [1, 1, 0, 0],
      );

      // A probe at 24 is sent the pinned sensor, with the targets it has to check against.
      const sensors = (await config.assignmentsFor(site, 24)).sensors;
      const assignment = sensors.find((one) => one.sensorId === pinned);
      assert.ok(assignment !== undefined, 'the pinned sensor is sent');
      assert.deepEqual(assignment.target, { host: 'sw.gate.test', ipVersion: 'auto' });
      assert.deepEqual(assignment.credentials?.['snmp']?.['allowedTargets'], ['10.20.0.0/16']);
      assert.equal(assignment.credentials['snmp']['community'], 'gate-secret');
      assert.equal(vouching.withheld().has(pinned), false);

      // The transports that cannot pin stay withheld, as before, and say why.
      for (const id of [traffic, query]) {
        assert.equal(
          sensors.some((one) => one.sensorId === id),
          false,
        );
        assert.deepEqual(await stateOf(id), {
          state: 'unknown',
          message: WITHHELD_CREDENTIALS.undecided,
        });
      }

      // A probe one version short is sent nothing it would connect to by name.
      for (const older of [23, 22, 3]) {
        assert.equal(await sentTo(older, pinned), false, `protocol ${String(older)}`);
        assert.deepEqual(await stateOf(pinned), {
          state: 'unknown',
          message: WITHHELD_CREDENTIALS.probeCannotPin,
        });
      }
      assert.equal(await sentTo(24, pinned), true);
      assert.equal(vouching.withheld().has(pinned), false);

      // "Check now" asks as the probe on the line. Nobody is, here: nothing is built, and
      // nothing is said about how old a probe is (`A-52`).
      assert.deepEqual(await config.assignmentFor(pinned), {
        probeObjectId: site,
        peerVersion: 0,
        assignment: null,
      });
      // What no probe would change is refused in its own words, connected or not.
      await assert.rejects(
        config.assignmentFor(query),
        (error: unknown) =>
          error instanceof ObjectError && error.message === WITHHELD_CREDENTIALS.undecided,
      );
    });

    it('check now is decided against the probe on the line, not the one that last said hello', async () => {
      const { sensor } = await named(site, 'checknow');
      const cannotPin = (error: unknown): boolean =>
        error instanceof ObjectError && error.message === WITHHELD_CREDENTIALS.probeCannotPin;

      // The site's probe enrols, is approved, and connects at protocol 23: one short.
      const registry = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        enrolmentKeys: ['shared-key'],
      });
      const hello = (
        over: Record<string, unknown> = {},
      ): Parameters<ProbeRegistry['admit']>[0] => ({
        gid: '',
        displayName: 'site',
        agentVersion: '0.1.0',
        protocolVersion: PINNING - 1,
        accessKey: 'shared-key',
        remoteAddress: '10.4.2.9',
        ...over,
      });
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, site, testActor);
      const connected = await registry.admit(hello({ gid: first.gid }));
      assert.equal(connected.kind, 'approved');
      assert.equal((await registry.get(first.gid))?.protocolVersion, PINNING - 1);

      // An upgraded binary is started beside it with the wrong key. It claims 24 and is refused;
      // the older probe keeps the connection.
      const beside = await registry.admit(
        hello({ gid: first.gid, protocolVersion: PINNING, accessKey: 'wrong' }),
      );
      assert.ok(beside.kind === 'refused');
      assert.equal(beside.code, 'bad-access-key');
      assert.equal(
        (await registry.get(first.gid))?.protocolVersion,
        PINNING - 1,
        'a refused hello does not change what the probe is recorded as speaking',
      );

      // Check now: the session is the older probe's, so the set is not sent.
      const live = (): number => PINNING - 1;
      await assert.rejects(config.assignmentFor(sensor, live), cannotPin);

      // And it is the session that decides, whatever the row says. This is the row as the
      // refused hello used to leave it, when the query was built from it and sent to the probe
      // at 23, secret and all.
      await db.query('UPDATE probe_registration SET protocol_version = $2 WHERE gid = $1', [
        first.gid,
        PINNING,
      ]);
      await assert.rejects(config.assignmentFor(sensor, live), cannotPin);
      // Nobody on the line: no set is sent, because nothing is. It is not the probe's age (`A-52`).
      assert.deepEqual(await config.assignmentFor(sensor), {
        probeObjectId: site,
        peerVersion: 0,
        assignment: null,
      });

      // A probe at 24 on the line is asked, with the set, and the query says who it is for.
      const found = await config.assignmentFor(sensor, () => PINNING);
      assert.equal(found?.peerVersion, PINNING);
      assert.equal(found.assignment?.credentials?.['snmp']?.['community'], 'checknow-secret');
    });

    it('a set bounded by its SSH keys is decided against the probe on the line too (A-41b)', async () => {
      const group = await create({ kind: 'group', parentId: site, name: 'keys' });
      await h.service.setCredential(testActor, group, 'ssh', {
        username: 'monitor',
        password: 'keys-password',
        hostKeys: ['SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'],
      });
      const device = await create({
        kind: 'device',
        parentId: group,
        name: 'by keys',
        host: '10.20.0.77',
      });
      const sensor = await create({
        kind: 'sensor',
        parentId: device,
        name: 'load',
        sensorType: 'test.ssh.load',
      });
      const hostKeys = versionFor('credentialHostKeys');
      await assert.rejects(
        config.assignmentFor(sensor, () => hostKeys - 1),
        (error: unknown) =>
          error instanceof ObjectError && error.message === WITHHELD_CREDENTIALS.probeTooOld,
      );
      // Nobody on the line: not the too-old sentence either, and nothing built (`A-52`).
      assert.deepEqual(await config.assignmentFor(sensor), {
        probeObjectId: site,
        peerVersion: 0,
        assignment: null,
      });
      assert.equal((await config.assignmentFor(sensor, () => hostKeys))?.peerVersion, hostKeys);
    });

    it('a sensor that was Down when its probe refused it goes from Unknown to Up in one step', async () => {
      const { sensor } = await named(site, 'was-down');
      assert.equal(await sentTo(PINNING, sensor), true);

      // Down by the scheduled path, with the Down trigger's page sent.
      await fromProbe([
        { ...measured(sensor, at(-4), 'error'), message: 'no response' },
        { ...measured(sensor, at(-3), 'error'), message: 'no response' },
      ]);
      assert.deepEqual(await stateOf(sensor), { state: 'down', message: 'no response' });
      await scheduler.sweep(later(1));
      const initial = (): Promise<number> =>
        count(
          `SELECT count(*)::text AS n FROM notification_request
           WHERE sensor_id = $1 AND reason = 'initial'`,
          [sensor],
        );
      assert.equal(await initial(), 1, 'one page: Down');

      // Its name is repointed outside the targets: Unknown, and the Unknown trigger's page.
      await fromProbe([refused(sensor, at(-2))]);
      assert.deepEqual(await stateOf(sensor), { state: 'unknown', message: REFUSED });
      await scheduler.sweep(later(2));
      assert.equal(await initial(), 2, 'and one: Unknown');
      assert.equal(await downs([sensor]), 1);

      // The name and the device are both put right. The result that says so decides the sensor.
      // Let go first and re-decided, it returned to what it last read, which was Down: a
      // transition, a Down row of no length and an alarm for an outage nobody saw then.
      const reply = await fromProbe([{ ...measured(sensor, at(-1)), message: 'up 3 d' }]);
      assert.equal((reply as { type: string }).type, 'results-ack');
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 3 d' });
      assert.equal(vouching.withheld().has(sensor), false);

      assert.equal(await downs([sensor]), 1, 'no Down between Unknown and Up');
      assert.deepEqual((await history(sensor)).slice(-2), [
        { state: 'unknown', previous: 'down' },
        { state: 'up', previous: 'unknown' },
      ]);
      await scheduler.sweep(later(3));
      assert.equal(await initial(), 2, 'and no page for one');
    });

    it('holds a sensor again when the batch that let it go is refused, and lets it go when it comes again', async () => {
      const { sensor } = await named(site, 'resent');
      assert.equal(await sentTo(PINNING, sensor), true);
      await fromProbe([refused(sensor, at(-4))]);
      const held = credentials.stats().withheld;

      // The reading that would let it go arrives at a core that stores nothing.
      const reading = { ...measured(sensor, at(-2)), message: 'up 5 d' };
      const nack = await fromProbe([reading], site, undefined, true);
      assert.equal((nack as { type: string }).type, 'results-nack');
      assert.equal(vouching.withheld().has(sensor), true, 'not let go for a result nobody stored');
      assert.equal(credentials.stats().withheld, held);
      assert.deepEqual(await stateOf(sensor), { state: 'unknown', message: REFUSED });

      // The probe sends it again, and it is stored.
      await fromProbe([reading]);
      assert.equal(vouching.withheld().has(sensor), false);
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 5 d' });
      assert.equal(credentials.stats().withheld, held - 1);
    });

    it('decides a released sensor from the result, not from what was cached while it was held', async () => {
      const { sensor } = await named(site, 'cached');
      assert.equal(await sentTo(PINNING, sensor), true);
      await fromProbe([refused(sensor, at(-5))]);
      // A reading older than the refusal, out of a spool: it lets nothing go, and the machine
      // takes it while the sensor is held. What it now has cached says the sensor is withheld.
      await fromProbe([{ ...measured(sensor, at(-8)), message: 'up 1 d' }]);
      assert.deepEqual(await stateOf(sensor), { state: 'unknown', message: REFUSED });

      await fromProbe([{ ...measured(sensor, at(-1)), message: 'up 1 d' }]);
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });
    });

    it('a failed scan lets a refused sensor go to Down once, in the result’s own words', async () => {
      const { sensor } = await named(site, 'fails-after');
      assert.equal(await sentTo(PINNING, sensor), true);
      await fromProbe([{ ...measured(sensor, at(-5)), message: 'up 1 d' }]);
      await fromProbe([refused(sensor, at(-4))]);
      assert.equal((await stateOf(sensor)).state, 'unknown');

      // The name resolves inside again and the device does not answer: that is a failed scan.
      await fromProbe([{ ...measured(sensor, at(-3), 'error'), message: 'no response' }]);
      await fromProbe([{ ...measured(sensor, at(-2), 'error'), message: 'no response' }]);
      assert.deepEqual(await stateOf(sensor), { state: 'down', message: 'no response' });
      assert.equal(vouching.withheld().has(sensor), false);
      assert.equal(await downs([sensor]), 1);
    });

    it('lets go what a probe refused when its last sensor moves to another probe', async () => {
      const branch = await create({ kind: 'probe', parentId: h.rootId, name: 'branch' });
      const { group, sensor } = await named(branch, 'leaver');
      assert.equal(await sentTo(PINNING, sensor, branch), true);
      const before = credentials.stats().withheld;
      await fromProbe([refused(sensor, at(-2))], branch);
      assert.deepEqual(await stateOf(sensor), { state: 'unknown', message: REFUSED });
      assert.equal(credentials.stats().withheld, before + 1);

      // The usual way to retire a probe: everything under it goes to another.
      await h.service.move(testActor, group, site, { kind: 'none' });

      // The probe it left is sent its configuration, which is now nothing. That is the whole
      // answer for it, and what it refused goes with it.
      assert.deepEqual((await config.assignmentsFor(branch, PINNING)).sensors, []);
      assert.equal(vouching.withheld().has(sensor), false);
      assert.equal(credentials.stats().withheld, before);
      assert.notEqual((await stateOf(sensor)).message, REFUSED);
    });

    it('lets go what a probe that is not connected refused, when the sensor moves or the probe is deleted', async () => {
      const away = await create({ kind: 'probe', parentId: h.rootId, name: 'away' });
      const moved = await named(away, 'moved-off');
      const stays = await named(site, 'stays');
      const gone = await create({ kind: 'probe', parentId: h.rootId, name: 'gone' });
      const deleted = await named(gone, 'deleted-with');
      assert.equal(await sentTo(PINNING, moved.sensor, away), true);
      assert.equal(await sentTo(PINNING, stays.sensor), true);
      assert.equal(await sentTo(PINNING, deleted.sensor, gone), true);
      const before = credentials.stats().withheld;
      await fromProbe([refused(moved.sensor, at(-2))], away);
      await fromProbe([refused(stays.sensor, at(-2))]);
      await fromProbe([refused(deleted.sensor, at(-2))], gone);
      assert.equal(credentials.stats().withheld, before + 3);

      // Neither probe is connected, so no configuration is built for either after this. What
      // runs is what the audit sink calls once the move and the delete have committed.
      await h.service.move(testActor, moved.group, site, { kind: 'none' });
      await h.service.delete(testActor, gone, { kind: 'exact', descendants: 3 }, { kind: 'none' });
      await credentials.reconcile();

      assert.equal(vouching.withheld().has(moved.sensor), false, 'moved: let go');
      assert.equal(vouching.withheld().has(deleted.sensor), false, 'its probe deleted: let go');
      assert.equal(vouching.withheld().has(stays.sensor), true, 'still under its probe: held');
      assert.equal(credentials.stats().withheld, before + 1);
      assert.deepEqual(await stateOf(stays.sensor), { state: 'unknown', message: REFUSED });
    });

    it('lets a moved sensor go at its first result from the probe it is under now', async () => {
      const former = await create({ kind: 'probe', parentId: h.rootId, name: 'former' });
      const { group, sensor } = await named(former, 'rehomed');
      assert.equal(await sentTo(PINNING, sensor, former), true);
      await fromProbe([{ ...measured(sensor, at(-4)), message: 'up 2 d' }], former);
      await fromProbe([refused(sensor, at(-3))], former);
      assert.equal(vouching.withheld().has(sensor), true);

      // Moved, and nothing told about it: no configuration for the old probe, no reconcile.
      await h.service.move(testActor, group, site, { kind: 'none' });
      assert.equal(vouching.withheld().has(sensor), true);

      await fromProbe([{ ...measured(sensor, at(-1)), message: 'up 2 d' }]);
      assert.equal(vouching.withheld().has(sensor), false);
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 2 d' });
      assert.equal(await downs([sensor]), 0);
    });

    it('takes a mark on a sensor the probe was not left to check as a failed scan, and counts it', async () => {
      const device = await create({
        kind: 'device',
        parentId: site,
        name: 'plain',
        host: '10.20.0.9',
      });
      const ping = await create({
        kind: 'sensor',
        parentId: device,
        name: 'plain ping',
        sensorType: 'icmp.ping',
      });
      await fromProbe([{ ...measured(ping, at(-5)), message: '4/4 replies' }]);
      await sentTo(PINNING, ping);
      const refusals = new ProbeRefusals();

      // A probe that marks a failure of a sensor it merely owns. Honoured, the sensor would
      // stand Unknown in the probe's own words, with no failed scan counted and no alarm.
      const reply = await fromProbe(
        [
          refused(ping, at(-4), 'Not scanned: nothing to see here.'),
          refused(ping, at(-3), 'Not scanned: nothing to see here.'),
        ],
        site,
        refusals,
      );
      assert.equal((reply as { type: string }).type, 'results-ack');
      assert.deepEqual(await stateOf(ping), {
        state: 'down',
        message: 'Not scanned: nothing to see here.',
      });
      assert.equal(vouching.withheld().has(ping), false);
      assert.equal(
        refusals.countsFor(site).refused,
        2,
        'where Probe Health counts refused results',
      );
    });

    it('a previewed credential write leaves no trace in what is held, and counts as the write would', async () => {
      // `U-21`'s dry run is the write itself, rolled back. It must not move what the core holds
      // in memory about a probe's refusals, or tell anything that a move or a delete happened.
      const group = await create({ kind: 'group', parentId: site, name: 'previewed' });
      const set = {
        version: 'v2c',
        community: 'previewed-secret',
        allowedTargets: ['10.20.0.0/16'],
      };
      await h.service.setCredential(testActor, group, 'snmp', set);
      const device = await create({
        kind: 'device',
        parentId: group,
        name: 'previewed switch',
        host: 'previewed.dc.test',
      });
      const pinned = await create({
        kind: 'sensor',
        parentId: device,
        name: 'previewed uptime',
        sensorType: 'test.snmp.pinned',
        params: { port: 161 },
      });
      const byName = await create({
        kind: 'sensor',
        parentId: device,
        name: 'previewed by name',
        sensorType: 'snmp.traffic',
        params: { port: 161 },
      });
      assert.equal(await sentTo(PINNING, pinned), true);
      await fromProbe([refused(pinned, at(-2))]);
      assert.deepEqual(await stateOf(pinned), { state: 'unknown', message: REFUSED });

      let told = 0;
      const invalidator = new ResultCacheInvalidator({
        channels: { forget: () => 0, clear: () => undefined },
        afterMoveOrDelete: () => {
          told += 1;
        },
        logger: silent,
      });
      const sink = h.audit.also;
      h.audit.also = invalidator;
      const stats = credentials.stats();
      const held = new Map(vouching.withheld());
      try {
        // Narrowed to a range the device's name can never be decided against by the core: the
        // sensor that cannot pin is counted, and the one its probe checks is not, in a preview
        // exactly as in the write.
        const narrowed = { ...set, allowedTargets: ['10.20.9.0/24'] };
        const previewed = await h.service.setCredential(
          testActor,
          group,
          'snmp',
          narrowed,
          { kind: 'none' },
          { preview: true },
        );
        assert.equal(previewed.withholds, 1);
        assert.deepEqual(credentials.stats(), stats);
        assert.deepEqual(new Map(vouching.withheld()), held);
        assert.equal(told, 0, 'no after-commit hook ran for a transaction that rolled back');
        assert.deepEqual(await stateOf(pinned), { state: 'unknown', message: REFUSED });
        // And the set in force is the one before the preview.
        const sent = (await config.assignmentsFor(site, PINNING)).sensors.find(
          (one) => one.sensorId === pinned,
        );
        assert.deepEqual(sent?.credentials?.['snmp']?.['allowedTargets'], ['10.20.0.0/16']);
        assert.equal(vouching.withheld().get(pinned), REFUSED, 'still the probe’s refusal');

        const written = await h.service.setCredential(testActor, group, 'snmp', narrowed);
        assert.equal(written.withholds, previewed.withholds);
        assert.equal(told, 0, 'a credential write is not a move or a delete');
      } finally {
        h.audit.also = sink;
      }
      assert.equal(vouching.withheld().has(byName), true);
    });

    it('a sensor the core withholds itself is no longer the probe’s to refuse', async () => {
      const group = await create({ kind: 'group', parentId: site, name: 'moved' });
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: 'moved-secret',
        allowedTargets: ['10.20.0.0/16'],
      });
      const device = await create({
        kind: 'device',
        parentId: group,
        name: 'mover',
        host: 'mover.dc.test',
      });
      const uptime = await create({
        kind: 'sensor',
        parentId: device,
        name: 'mover uptime',
        sensorType: 'test.snmp.pinned',
        params: { port: 161 },
      });
      assert.equal(await sentTo(24, uptime), true);
      await fromProbe([refused(uptime, new Date().toISOString())]);
      assert.deepEqual(await stateOf(uptime), { state: 'unknown', message: REFUSED });
      const held = credentials.stats().withheld;

      // Given an address outside the targets: the core withholds it now, in its own words, and
      // counts it once.
      await h.service.update(
        testActor,
        device,
        { kind: 'device', host: '192.0.2.50' },
        { kind: 'none' },
      );
      assert.equal(await sentTo(24, uptime), false);
      assert.deepEqual(await stateOf(uptime), {
        state: 'unknown',
        message: WITHHELD_CREDENTIALS.outside,
      });
      assert.equal(credentials.stats().withheld, held);

      // And inside, it is sent and scanned again, with nothing left over from the refusal.
      await h.service.update(
        testActor,
        device,
        { kind: 'device', host: '10.20.0.50' },
        { kind: 'none' },
      );
      assert.equal(await sentTo(24, uptime), true);
      assert.equal(vouching.withheld().has(uptime), false);
    });

    it('stores which sensors a configuration stopped leaving to the probe, and reads them back by the clock it is started at (A-61)', async () => {
      const { device, sensor } = await named(site, 'stored');
      const row = async (): Promise<{ probe: number; ageMs: number }[]> =>
        (
          await db.query<{ probe_id: string; stopped_ms: string }>(
            `SELECT probe_id::text AS probe_id,
                    (extract(epoch FROM stopped_at) * 1000)::float8::text AS stopped_ms
             FROM late_refusal_grace WHERE sensor_id = $1`,
            [sensor],
          )
        ).map((one) => ({
          probe: Number(one.probe_id),
          ageMs: Date.now() - Number(one.stopped_ms),
        }));
      const near = (ms: number, expected: number): boolean => Math.abs(ms - expected) < 60_000;
      const point = (host: string): Promise<unknown> =>
        h.service.update(testActor, device, { kind: 'device', host }, { kind: 'none' });
      const restarted = (wallNow?: () => number): CredentialVouching =>
        new CredentialVouching({
          db,
          logger: silent,
          sensorTypes: gate,
          rights: () => Promise.resolve(new Map()),
          ...(wallNow === undefined ? {} : { wallNow }),
        });

      // Left to the probe: nothing is recorded, and nothing was before.
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.deepEqual(await row(), []);

      // Given an address inside the targets, the core decides it: no longer the probe's.
      await point('10.20.0.60');
      assert.equal(await sentTo(PINNING, sensor), true);
      const [first] = await row();
      assert.equal(first?.probe, site);
      assert.ok(near(first.ageMs, 0), `stored as now, and it reads ${String(first.ageMs)} ms old`);
      const stamp = async (): Promise<string | undefined> =>
        (
          await db.query<{ at: string }>(
            'SELECT stopped_at::text AS at FROM late_refusal_grace WHERE sensor_id = $1',
            [sensor],
          )
        )[0]?.at;
      const written = await stamp();
      // A configuration built again for another reason moves nothing.
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.equal(await stamp(), written);

      // Named again, it is the probe's to check, and the row goes.
      await point('stored.dc.test');
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.deepEqual(await row(), []);

      await point('10.20.0.60');
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.equal((await row()).length, 1);

      // A core started with its clock an hour behind the one that wrote the row: the time is
      // ahead of it. It is given the grace from that start, and the row is written down again
      // as that clock's now, so the next start counts from there.
      const behind = await restarted(() => Date.now() - 3_600_000).restore();
      assert.ok(behind.ahead >= 1 && behind.spent === 0, JSON.stringify(behind));
      const [setBack] = await row();
      assert.ok(
        setBack !== undefined && near(setBack.ageMs, 3_600_000),
        `rewritten as an hour ago by this clock, and it reads ${String(setBack?.ageMs)} ms old`,
      );

      // And a core started by the right clock finds a row an hour old: spent, and removed.
      const later = await restarted().restore();
      assert.ok(later.spent >= 1 && later.ahead === 0, JSON.stringify(later));
      assert.deepEqual(await row(), []);
    });

    // Last: it sweeps every alarm that is due on this probe, to count its own from nothing.
    it('a refusal delivered after the configuration stopped leaving the sensor raises no Down and no page, and a failed scan after it does (A-53)', async () => {
      const { group, sensor } = await named(site, 'late');
      assert.equal(await sentTo(PINNING, sensor), true);
      await fromProbe([{ ...measured(sensor, at(-60)), message: 'up 1 d' }]);
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });

      // A name entry now covers the device, so the core decides it and the probe is left
      // nothing to check. The sensor is still sent. A check that was already running under the
      // configuration before resolved the name outside, and its refusal arrives now, twice: two
      // failed scans are what it takes to read Down (`M-03`).
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: 'late-secret',
        allowedTargets: ['10.20.0.0/16', '*.dc.test'],
      });
      assert.equal(await sentTo(PINNING, sensor), true);
      await scheduler.sweep(later(3_600));
      const asked = await requests();
      const before = await history(sensor);
      const held = credentials.stats().withheld;
      const refusals = new ProbeRefusals();

      const reply = await fromProbe(
        [refused(sensor, at(-30)), refused(sensor, at(-20))],
        site,
        refusals,
      );
      assert.deepEqual(reply, {
        type: 'results-ack',
        batchId: `b${String(batch)}`,
        storedSamples: 0,
        retryAfterMs: 0,
      });
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });
      assert.deepEqual(await history(sensor), before, 'no transition: not Warning, not Down');
      assert.equal(await downs([sensor]), 0);
      assert.equal(vouching.withheld().has(sensor), false, 'and not held Unknown either');
      assert.equal(credentials.stats().withheld, held);
      assert.equal(await scheduler.sweep(later(3_600)), 0, 'nothing to page about');
      assert.equal(await requests(), asked);
      // Dropped, and counted on Probe Health where a late refusal is, apart from what the core
      // refused from the probe (`A-56`).
      assert.equal(refusals.lateFor(site), 2);
      assert.equal(refusals.countsFor(site).refused, 0);

      // The device then does not answer the scan made under the new configuration. That is a
      // failed scan: Down, once, and the one page a Down raises.
      await fromProbe(
        [
          { ...measured(sensor, at(-10), 'error'), message: 'no response' },
          { ...measured(sensor, at(-5), 'error'), message: 'no response' },
        ],
        site,
        refusals,
      );
      assert.deepEqual(await stateOf(sensor), { state: 'down', message: 'no response' });
      assert.equal(await downs([sensor]), 1);
      assert.equal(await scheduler.sweep(later(3_600)), 1);
      assert.equal(await requests(), asked + 1);
      assert.equal(refusals.lateFor(site), 2);
      assert.equal(refusals.countsFor(site).refused, 0);

      // And the bound: past the grace, a result marked this way is the probe's failed scan, as
      // any mark on a sensor it is not left to check is.
      await fromProbe([{ ...measured(sensor, at(-4)), message: 'up 2 d' }]);
      assert.equal((await stateOf(sensor)).state, 'up');
      ahead.ms += LATE_REFUSAL_GRACE_MS + 1;
      await fromProbe([refused(sensor, at(-3)), refused(sensor, at(-2))], site, refusals);
      assert.deepEqual(await stateOf(sensor), { state: 'down', message: REFUSED });
      assert.equal(await downs([sensor]), 2);
      assert.equal(vouching.withheld().has(sensor), false);
      // Past the grace they are marks the probe has no claim to: refused, and not late.
      assert.equal(refusals.countsFor(site).refused, 2);
      assert.equal(refusals.lateFor(site), 2);
    });

    // After it, and sweeping as it does: what a core restarted inside the grace does (`A-61`).
    it('a core restarted inside the grace still takes a late refusal as late: no failed scan, no Down, no page; a failed scan after it is Down once with one page, and past the grace the mark is a failed scan', async () => {
      const { group, sensor } = await named(site, 'restarted');
      assert.equal(await sentTo(PINNING, sensor), true);
      await fromProbe([{ ...measured(sensor, at(-60)), message: 'up 1 d' }]);
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });

      // The same change as above, and the configuration that stops leaving the sensor to the
      // probe is built: the core now holds that a refusal for it may still arrive, and has
      // stored it.
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: 'restarted-secret',
        allowedTargets: ['10.20.0.0/16', '*.dc.test'],
      });
      assert.equal(await sentTo(PINNING, sensor), true);
      const stored = (): Promise<number> =>
        count('SELECT count(*)::text AS n FROM late_refusal_grace WHERE sensor_id = $1', [sensor]);
      assert.equal(await stored(), 1);

      // The core restarts: the same database, and nothing of what the one before held in
      // memory. It reads the record before it takes a result, as `main.ts` does before the
      // probe endpoint is built. The probe redials and is sent its configuration, in which the
      // sensor is not left to it.
      const running = { credentials, config };
      const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      credentials = new CredentialVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        rights: (principal, objectIds, q) => access.resolveManyFor(principal, objectIds, q),
        vouching,
        now: () => performance.now() + ahead.ms,
      });
      config = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
        vault: h.vault,
        credentialKindsFor: (sensorType) => gate.credentialKinds(sensorType),
        credentialCheck: credentials,
      });
      try {
        const restored = await credentials.restore();
        assert.ok(restored.restored >= 1, JSON.stringify(restored));
        assert.equal(restored.ahead, 0);
        assert.equal(await sentTo(PINNING, sensor), true);
        assert.equal(await stored(), 1, 'the restarted core’s configuration leaves the row alone');
        await scheduler.sweep(later(3_600));
        const asked = await requests();
        const before = await history(sensor);
        const held = credentials.stats().withheld;
        const refusals = new ProbeRefusals();

        // Two late refusals, which were one Down and one page before the record was stored.
        // One at a time, as a spool replays them: neither is a failed scan.
        await fromProbe([refused(sensor, at(-30))], site, refusals);
        await fromProbe([refused(sensor, at(-20))], site, refusals);
        assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });
        assert.deepEqual(await history(sensor), before, 'no transition: not Warning, not Down');
        assert.equal(await downs([sensor]), 0);
        assert.equal(vouching.withheld().has(sensor), false, 'and not held Unknown either');
        assert.equal(credentials.stats().withheld, held);
        assert.equal(await scheduler.sweep(later(3_600)), 0, 'nothing to page about');
        assert.equal(await requests(), asked);
        // Counted where a late refusal is, and not as marks the probe had no claim to.
        assert.equal(refusals.lateFor(site), 2);
        assert.equal(refusals.countsFor(site).refused, 0);

        // More of them inside the grace raise nothing either.
        await fromProbe([refused(sensor, at(-15)), refused(sensor, at(-12))], site, refusals);
        assert.equal(await downs([sensor]), 0);
        assert.equal(await requests(), asked);
        assert.equal(refusals.lateFor(site), 4);

        // The device then does not answer the scan made under the new configuration. That is a
        // failed scan after a restart as it was before one: Down, once, and the one page.
        await fromProbe(
          [
            { ...measured(sensor, at(-10), 'error'), message: 'no response' },
            { ...measured(sensor, at(-8), 'error'), message: 'no response' },
          ],
          site,
          refusals,
        );
        assert.deepEqual(await stateOf(sensor), { state: 'down', message: 'no response' });
        assert.equal(await downs([sensor]), 1);
        assert.equal(await scheduler.sweep(later(3_600)), 1);
        assert.equal(await requests(), asked + 1);
        // And a third, with a late refusal beside it, is the same outage: no second alarm.
        await fromProbe(
          [
            { ...measured(sensor, at(-7), 'error'), message: 'no response' },
            refused(sensor, at(-6)),
          ],
          site,
          refusals,
        );
        assert.equal(await downs([sensor]), 1);
        assert.equal(await scheduler.sweep(later(3_600)), 0);
        assert.equal(await requests(), asked + 1);
        assert.equal(refusals.lateFor(site), 5);
        assert.equal(refusals.countsFor(site).refused, 0);

        // Past the grace, counted from when the configuration stopped leaving the sensor and
        // not from the restart, a result marked this way is the failed scan it reads as.
        await fromProbe([{ ...measured(sensor, at(-5)), message: 'up 2 d' }], site, refusals);
        assert.equal((await stateOf(sensor)).state, 'up');
        ahead.ms += LATE_REFUSAL_GRACE_MS + 1;
        await fromProbe([refused(sensor, at(-4)), refused(sensor, at(-3))], site, refusals);
        assert.deepEqual(await stateOf(sensor), { state: 'down', message: REFUSED });
        assert.equal(await downs([sensor]), 2);
        assert.equal(vouching.withheld().has(sensor), false, 'a failed scan, not a hold');
        assert.equal(refusals.countsFor(site).refused, 2);
        assert.equal(refusals.lateFor(site), 5);

        // And the row does not outlive its grace, with no configuration to take it away.
        assert.equal(await stored(), 1);
        await credentials.prune();
        assert.equal(await stored(), 0);
      } finally {
        ({ credentials, config } = running);
      }
    });
  },
);

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REDIRECT_OUTSIDE_TARGETS, type CredentialRestriction, type SensorType } from '@ms/sensors';
import { pino } from 'pino';
import {
  capabilitiesFor,
  PROTOCOL_VERSION,
  versionFor,
  type CheckResult,
  type IngestionConfig,
} from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService } from '../src/auth/access.js';
import { DatabaseError, type Database } from '../src/db/pool.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { IN_PROCESS_SOURCE } from '../src/ingestion/sources.js';
import { loadLookups } from '../src/lookups/loader.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import {
  CredentialVouching,
  LATE_REFUSAL_COOL_OFF_MS,
  LATE_REFUSAL_GRACE_MS,
  LATE_REFUSAL_SAVE_LOCK_MS,
  LATE_REFUSAL_SAVE_STATEMENT_MS,
  LATE_REFUSAL_SAVE_WAIT_MS,
  PROTOCOL_FLAP_HOLD_MS,
  WITHHELD_CREDENTIALS,
  boundRefusal,
  isFlapping,
  nextVersionRecord,
  restoredVersion,
  storedStop,
  type BuildingFor,
  type SensorBeingSent,
  type VersionRecord,
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
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { everyVoucherHolds } from './support/vouching.js';

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
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
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
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
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

/** A database type as a build at 27 has them: its driver is handed a socket, so it pins (`A-62`). */
const dbPinned: SensorType = { ...dbQuery, id: 'test.db.pinned', pinnedKinds: ['database'] };

/** An SSH type as the core sees one: the kind a set bounded by its host keys is. */
const sshLoad: SensorType = {
  id: 'test.ssh.load',
  category: 'SSH',
  costHint: 'medium',
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
  credentialKinds: ['ssh'],
  pinnedKinds: ['ssh'],
  secretDestinations: { 'kind:ssh': [] },
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  channels: () => [{ key: 'load', name: 'Load', unit: '', isPrimary: true }],
  execute: () => Promise.resolve({ channels: [] }),
};

/**
 * A type that uses two kinds, both pinned (`A-72`): one set may be decided by the probe's version
 * while the other is decided by the core alone.
 */
const snmpSsh: SensorType = {
  id: 'test.snmp.ssh',
  category: 'SNMP',
  costHint: 'light',
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
  credentialKinds: ['snmp', 'ssh'],
  pinnedKinds: ['snmp', 'ssh'],
  secretDestinations: { 'kind:snmp': ['port'], 'kind:ssh': [] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { port: { type: 'integer', minimum: 1, maximum: 65_535 } },
  },
  channels: () => [{ key: 'uptime', name: 'Uptime', unit: 's', isPrimary: true }],
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

  describe('a database set needs a probe at 27: its drivers pin from there (A-62)', () => {
    const DATABASE = versionFor('databaseAddressPinning');
    const rows: [string, string, number, boolean, string, string | null][] = [
      ['a name, a probe at 27', 'db.dc.test', 27, true, 'database', null],
      [
        'a name, a probe at 26: it pins the other kinds and not this one',
        'db.dc.test',
        26,
        true,
        'database',
        WITHHELD_CREDENTIALS.probeCannotPinDatabase,
      ],
      [
        'a name, a probe at 24',
        'db.dc.test',
        24,
        true,
        'database',
        WITHHELD_CREDENTIALS.probeCannotPinDatabase,
      ],
      [
        'a name, a probe below 24: the sentence is still the database one, which names 27',
        'db.dc.test',
        23,
        true,
        'database',
        WITHHELD_CREDENTIALS.probeCannotPinDatabase,
      ],
      [
        'a name, nobody on the line',
        'db.dc.test',
        0,
        true,
        'database',
        WITHHELD_CREDENTIALS.probeCannotPinDatabase,
      ],
      ['another kind at 26 is sent as before', 'sw.dc.test', 26, true, 'ssh', null],
      ['another kind at 24 is sent as before', 'sw.dc.test', 24, true, 'snmp', null],
      [
        'another kind at 23 keeps its own sentence',
        'sw.dc.test',
        23,
        true,
        'ssh',
        WITHHELD_CREDENTIALS.probeCannotPin,
      ],
      [
        'a database type that does not pin is the type’s refusal, whatever the probe',
        'db.dc.test',
        27,
        false,
        'database',
        WITHHELD_CREDENTIALS.undecided,
      ],
      ['an address inside needs no probe version', '10.20.0.9', 21, true, 'database', null],
      [
        'an address outside is outside',
        '192.0.2.9',
        27,
        true,
        'database',
        WITHHELD_CREDENTIALS.outside,
      ],
    ];
    for (const [name, host, version, pins, kind, expected] of rows) {
      it(name, () => {
        assert.equal(boundRefusal(ranges, host, version, pins, kind), expected);
      });
    }

    it('is the version the capability arrived in, and the sentence names it', () => {
      assert.equal(DATABASE, 27);
      assert.equal(capabilitiesFor(PROTOCOL_VERSION).databaseAddressPinning, true);
      assert.match(
        WITHHELD_CREDENTIALS.probeCannotPinDatabase,
        /^Not scanned: .*Upgrading the probe to protocol 27 sends them again/,
      );
    });
  });

  it('says why in each sentence, and what sends the set again', () => {
    assert.match(WITHHELD_CREDENTIALS.undecided, /a transport that resolves the name itself/);
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
    assert.equal(reported.unearned.length, 0);
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
    assert.equal(reported.unearned.length, 0);
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
      assert.equal(reported.unearned.length, 1);
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
      assert.equal(reported.unearned.length, 2);
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
      // Not a mark it may make, and not a failed scan either: the core withholds the sensor
      // from this probe, so the result was made under a configuration before (`A-72`).
      assert.equal(reported.unearned.length, 0);
      assert.equal(reported.late.length, 0);
      assert.equal(reported.withheldDropped.length, 1);
      assert.equal(reported.results.length, 0);
      assert.equal(settled.length, 0);
    });

    it('honours nothing once a configuration no longer sends the sensor, and its grace has run out', async () => {
      const { credentials, clock } = await holder();
      await credentials.withhold(7, [leftToProbe(2)], PINNING);
      clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      const reported = await credentials.reported(7, [refused(1, T(0)), refused(2, T(0))]);
      assert.equal(reported.unearned.length, 1);
      assert.equal(reported.late.length, 0);
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
      assert.equal(reported.late.length, 1);
      assert.equal(reported.unearned.length, 0);
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
      assert.equal(reported.late.length, 2);
      assert.equal(settled.length, 0);
      assert.equal(credentials.stats().withheld, 0);
    });

    it('takes a failed scan after the change as the failed scan it is', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      const failed = measured(1, T(5), 'error');
      const reported = await credentials.reported(7, [refused(1, T(0)), failed]);
      assert.deepEqual(reported.results, [failed]);
      assert.equal(reported.late.length, 1);
      assert.equal(reported.unearned.length, 0);
    });

    it('is bounded: to the last millisecond of the grace, and not one after', async () => {
      const { credentials, clock } = await holder();
      await stopLeaving(credentials);
      clock.ms += LATE_REFUSAL_GRACE_MS;
      const inside = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(inside.late.length, 1);
      assert.deepEqual(inside.results, []);

      clock.ms += 1;
      const after = await credentials.reported(7, [refused(1, T(1))]);
      assert.equal(after.late.length, 0);
      assert.equal(after.unearned.length, 1, 'a mark the probe has no claim to any more');
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
      assert.equal((await credentials.reported(7, [refused(1, T(0))])).late.length, 1);
      clock.ms = 2_001;
      assert.equal((await credentials.reported(7, [refused(1, T(0))])).late.length, 0);
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
      assert.equal(
        (await credentials.reported(7, [refused(1, T(0))])).late.length,
        1,
        'still inside',
      );
      clock.ms += 1;
      const after = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(after.late.length, 0, 'the later configuration did not start it again');
      assert.equal(after.unearned.length, 1);
    });

    it('forgets at the first configuration after the cool-off, and remembers until then (A-68)', async () => {
      const { credentials, clock } = await holder();
      await stopLeaving(credentials);
      clock.ms += LATE_REFUSAL_GRACE_MS + LATE_REFUSAL_COOL_OFF_MS + 1;
      await stopLeaving(credentials);
      // A clock set back does not bring it back: the entry is gone, not merely out of date.
      clock.ms -= LATE_REFUSAL_GRACE_MS + LATE_REFUSAL_COOL_OFF_MS;
      const reported = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(reported.late.length, 0);
      assert.equal(reported.unearned.length, 1);
    });

    it('starts again when the sensor is left to the probe and then is not', async () => {
      const { credentials, clock, settled } = await holder();
      await stopLeaving(credentials);
      clock.ms += 300_000;
      // Left again: a refusal is the probe's to make, and holds the sensor as any does.
      await credentials.withhold(7, [1, 2, 3].map(leftToProbe), PINNING);
      const held = await credentials.reported(7, [refused(1, T(0))]);
      assert.equal(held.late.length, 0);
      assert.equal(settled.length, 1);

      clock.ms += 240_000;
      await stopLeaving(credentials);
      // Ten minutes after the first time it stopped, and one after the second.
      clock.ms += 60_001;
      assert.equal((await credentials.reported(7, [refused(1, T(60))])).late.length, 1);
      clock.ms += LATE_REFUSAL_GRACE_MS;
      assert.equal((await credentials.reported(7, [refused(1, T(120))])).late.length, 0);
    });

    it('is only for the probe whose configuration changed, and only for a sensor it was left', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      // Probe 8 is still left sensor 1: its refusal is honoured, as a hold.
      const eight = await credentials.reported(8, [refused(1, T(0))]);
      assert.equal(eight.late.length, 0);
      assert.equal(credentials.stats().withheld, 1);
      // Sensor 9 was never left to probe 7, before or after.
      const seven = await credentials.reported(7, [refused(9, T(0))]);
      assert.equal(seven.late.length, 0);
      assert.equal(seven.unearned.length, 1);
      assert.equal(seven.results.length, 1);
    });

    it('drops only what a refusal looks like: a mark beside a reading or an ok is the result it is', async () => {
      const { credentials } = await holder();
      await stopLeaving(credentials);
      const ok: CheckResult = { ...refused(1, T(0)), outcome: 'ok' };
      const readings: CheckResult = { ...refused(1, T(1)), channels: [{ key: 'a', value: 1 }] };
      const reported = await credentials.reported(7, [ok, readings]);
      assert.equal(reported.late.length, 0);
      assert.equal(reported.unearned.length, 2);
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
      assert.equal(reported.late.length, 1);
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
      assert.equal(late.late.length, 1);
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
      assert.equal(reported.late.length, 0);
      assert.equal(reported.unearned.length, 1);
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
    stopped_ms: string | null;
    /** The version the probe's last configuration left it the sensor under, or null (`A-68`). */
    left_version: number | null;
  }
  /** What one write had the table hold for a probe: the windows it remembers. */
  interface Written {
    probeId: number;
    sensorIds: number[];
    stoppedAtMs: number[];
  }
  /** And, in the same write, what the probe is left and under which version (`A-68`). */
  interface WrittenLeft {
    left: number[];
    version: number | null;
  }

  /** A row of `probe_protocol_flap`, as `restore` reads one and `#save` writes one (`A-72`). */
  interface StoredFlap {
    probe_id: string;
    version: number;
    changed_ms: string | null;
    since_ms: string | null;
    run_changes: number;
    flap_floor: number | null;
  }

  /** A row for probe 7's sensor 1, stored `offsetMs` from the wall clock's reading at start. */
  const storedAt = (offsetMs: number, sensorId = 1): StoredRow => ({
    probe_id: '7',
    sensor_id: String(sensorId),
    stopped_ms: String(WALL + offsetMs),
    left_version: null,
  });

  /** One line the core logged at `warn` or above. */
  interface Logged {
    level: number;
    msg: string;
    probeId?: number;
  }
  const WARN = 40;
  const ERROR = 50;

  /**
   * A core over a table that holds `stored`, with both of its clocks in the test's hands. Nothing
   * has been sent to any probe: `leave` sends probe 7 the sensors it is left.
   */
  function core(
    stored: readonly StoredRow[] = [],
    saveWaitMs?: number,
    /**
     * The flap hold and its table (`A-72`). Off unless asked for: the cases of `A-61` and `A-68`
     * below are the layer a flap is judged above, and alternate versions to reach it.
     */
    flap: {
      holdMs?: number;
      stored?: readonly StoredFlap[];
      onOver?: (probeIds: readonly number[]) => void;
    } = {},
  ): {
    credentials: CredentialVouching;
    clock: { ms: number; wall: number };
    control: {
      failWrite: boolean;
      /** What the next writes fail with, in place of a lost connection. */
      failWith: Error | undefined;
      failRead: boolean;
      /** The version records cannot be read (`A-72`). */
      failFlapRead: boolean;
      /** Which read of the vouchers from now fails: 1 is the next, 2 the one after (`A-68`). */
      failVouchersAt: number;
      writeDelaysMs: number[];
      /** Sensors that no longer exist: the statement writes no row for one, and says so. */
      gone: Set<number>;
      /** A probe whose write does not come back until `release` is called. */
      stalled: number | null;
      release: () => void;
    };
    /** When each write to the table began and ended, in the order it happened. */
    order: string[];
    written: Written[];
    /** What each of those writes said the probe is left, by the same index. */
    lefts: WrittenLeft[];
    /** Each write of a probe's version record, in order (`A-72`). */
    flaps: StoredFlap[];
    /** The version records as the writes that landed left them, for a core started on them. */
    flapTable: () => StoredFlap[];
    /** The timeouts each write's transaction set, before its statement. */
    bounds: unknown[];
    logged: Logged[];
    leave: (sensorIds: readonly number[], version?: number) => Promise<unknown>;
    /** The table as the writes that landed left it, for a core started on it. */
    table: () => StoredRow[];
    /** How many of these refusals from probe 7 for sensor 1 are taken as late. */
    late: (sensorId?: number, probeId?: number) => Promise<number>;
  } {
    const clock = { ms: 5_000_000, wall: WALL };
    let let_go: () => void = () => undefined;
    const released = new Promise<void>((done) => {
      let_go = done;
    });
    const control = {
      failWrite: false,
      failWith: undefined as Error | undefined,
      failRead: false,
      failFlapRead: false,
      failVouchersAt: 0,
      writeDelaysMs: [] as number[],
      gone: new Set<number>(),
      stalled: null as number | null,
      release: let_go,
    };
    const written: Written[] = [];
    const lefts: WrittenLeft[] = [];
    const flaps: StoredFlap[] = [];
    const flapRows = new Map<string, StoredFlap>(
      (flap.stored ?? []).map((row) => [row.probe_id, row]),
    );
    const order: string[] = [];
    const bounds: unknown[] = [];
    const logged: Logged[] = [];
    /** What the table holds, by probe and sensor, after every write that landed. */
    const rows = new Map<string, StoredRow>(
      stored.map((row) => [`${row.probe_id}:${row.sensor_id}`, row]),
    );
    /** Whether the statement being run is inside a transaction, which the write has to be. */
    let inside = false;
    const query = async <R>(sql: string, values: readonly unknown[] = []): Promise<R[]> => {
      // Nothing here sets a limit itself: `Database.tx` does, for the transaction (`P-229`).
      assert.ok(!sql.includes('set_config'), 'no limit is set by hand, on a session or not');
      if (sql.includes('INSERT INTO late_refusal_grace')) {
        assert.equal(inside, true, 'the write runs in the transaction its timeouts were set in');
        const [probeId, sensorIds, stoppedAtMs, leftIds, version] = values as [
          number,
          number[],
          number[],
          number[],
          number | null,
        ];
        order.push(`begin ${sensorIds.join(',')}`);
        // What exists is what existed when the statement ran, whatever happens while it is out.
        const missing = new Set(control.gone);
        if (control.stalled === probeId) await released;
        const delay = control.writeDelaysMs.shift() ?? 0;
        if (delay > 0) await new Promise((done) => setTimeout(done, delay));
        order.push(`end ${sensorIds.join(',')}`);
        if (control.failWith !== undefined) throw control.failWith;
        if (control.failWrite) throw new Error('connection terminated');
        written.push({ probeId, sensorIds: [...sensorIds], stoppedAtMs: [...stoppedAtMs] });
        lefts.push({ left: [...leftIds], version });
        const named = [...new Set([...sensorIds, ...leftIds])].filter((id) => !missing.has(id));
        for (const key of [...rows.keys()]) {
          if (key.startsWith(`${String(probeId)}:`)) rows.delete(key);
        }
        for (const sensorId of named) {
          const stopped = sensorIds.indexOf(sensorId);
          rows.set(`${String(probeId)}:${String(sensorId)}`, {
            probe_id: String(probeId),
            sensor_id: String(sensorId),
            stopped_ms: stopped < 0 ? null : String(stoppedAtMs[stopped]),
            left_version: leftIds.includes(sensorId) ? version : null,
          });
        }
        return named.map((sensorId) => ({ sensor_id: String(sensorId) })) as R[];
      }
      if (sql.includes('FROM late_refusal_grace')) {
        if (control.failRead) throw new Error('relation "late_refusal_grace" does not exist');
        return [...stored] as R[];
      }
      if (sql.includes('INSERT INTO probe_protocol_flap')) {
        assert.equal(inside, true, 'the version record is written in the same transaction');
        if (control.failWith !== undefined) throw control.failWith;
        if (control.failWrite) throw new Error('connection terminated');
        const [probeId, version, changedMs, sinceMs, changes, floor] = values as [
          number,
          number,
          number | null,
          number | null,
          number,
          number | null,
        ];
        const row: StoredFlap = {
          probe_id: String(probeId),
          version,
          changed_ms: changedMs === null ? null : String(changedMs),
          since_ms: sinceMs === null ? null : String(sinceMs),
          run_changes: changes,
          flap_floor: floor,
        };
        flaps.push(row);
        if (control.gone.has(probeId)) return [];
        flapRows.set(row.probe_id, row);
        return [{ probe_id: row.probe_id }] as R[];
      }
      if (sql.includes('FROM probe_protocol_flap')) {
        if (control.failRead || control.failFlapRead) {
          throw new Error('relation "probe_protocol_flap" does not exist');
        }
        return [...(flap.stored ?? [])] as R[];
      }
      if (sql.includes('FROM sensor_credential_voucher') && control.failVouchersAt > 0) {
        control.failVouchersAt -= 1;
        if (control.failVouchersAt === 0) throw new Error('connection terminated');
      }
      return [];
    };
    const credentials = new CredentialVouching({
      db: {
        query,
        tx: async (fn, limits) => {
          inside = true;
          bounds.push(limits);
          try {
            return await fn({ query });
          } finally {
            inside = false;
          }
        },
      },
      logger: pino(
        { level: 'warn' },
        { write: (line: string) => logged.push(JSON.parse(line) as Logged) },
      ),
      sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned, snmpSsh])),
      rights: () => Promise.resolve(new Map()),
      now: () => clock.ms,
      wallNow: () => clock.wall,
      ...(saveWaitMs === undefined ? {} : { saveWaitMs }),
      protocolFlapHoldMs: flap.holdMs ?? 0,
      ...(flap.onOver === undefined ? {} : { onProtocolFlapOver: flap.onOver }),
    });
    return {
      credentials,
      clock,
      control,
      written,
      lefts,
      flaps,
      flapTable: () => [...flapRows.values()],
      order,
      bounds,
      logged,
      leave: (sensorIds, version = PINNING) =>
        credentials.withhold(7, sensorIds.map(leftToProbe), version),
      table: () => [...rows.values()],
      late: async (sensorId = 1, probeId = 7) =>
        (await credentials.reported(probeId, [refused(sensorId, T(0))])).late.length,
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
      /**
       * Past its grace and inside the cool-off after it (`A-68`): a start takes it up, nothing
       * is late by it, and it is left in the table.
       */
      remembered?: true;
    }[] = [
      { name: 'this instant', stored: String(WALL), verdict: 'kept', leftMs: GRACE },
      { name: 'two minutes ago', stored: String(WALL - 120_000), verdict: 'kept', leftMs: 480_000 },
      { name: 'the last millisecond', stored: String(WALL - GRACE), verdict: 'kept', leftMs: 0 },
      {
        name: 'one millisecond past',
        stored: String(WALL - GRACE - 1),
        verdict: 'spent',
        remembered: true,
      },
      {
        name: 'the last millisecond of the cool-off',
        stored: String(WALL - GRACE - LATE_REFUSAL_COOL_OFF_MS),
        verdict: 'spent',
        remembered: true,
      },
      {
        name: 'one millisecond past the cool-off',
        stored: String(WALL - GRACE - LATE_REFUSAL_COOL_OFF_MS - 1),
        verdict: 'spent',
      },
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
          { probe_id: '7', sensor_id: '1', stopped_ms: one.stored, left_version: null },
        ]);
        const remembered = one.remembered === true;
        assert.deepEqual(await credentials.restore(), {
          restored: one.verdict === 'spent' ? 0 : 1,
          ahead: one.verdict === 'ahead' ? 1 : 0,
          remembered: remembered ? 1 : 0,
          spent: one.verdict === 'spent' && !remembered ? 1 : 0,
          left: 0,
          flapping: 0,
        });
        if (one.leftMs === undefined) {
          assert.equal(await late(), 0, 'the failed scan it was before anything was stored');
          assert.deepEqual(
            written,
            remembered ? [] : [{ probeId: 7, sensorIds: [], stoppedAtMs: [] }],
            remembered ? 'left where it is' : 'removed',
          );
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
      assert.equal(reported.late.length, 1);
      assert.equal(reported.unearned.length, 2);
      assert.equal(reported.results.length, 3, 'a failed scan after the restart is a failed scan');
    });

    it('is not started again by the configuration the restarted core builds', async () => {
      const { credentials, clock, written, leave, late } = core([storedAt(-120_000)]);
      await credentials.restore();
      // The probe redials and is sent its configuration: sensor 1 is not left to it, as stored.
      await leave([2, 3]);
      // What the probe is left is new to this core, and written. The time is not moved.
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [1], stoppedAtMs: [WALL - 120_000] }]);
      await leave([2, 3]);
      assert.equal(written.length, 1, 'and the same configuration again writes nothing');
      clock.ms += 480_000;
      assert.equal(await late(), 1);
      clock.ms += 1;
      assert.equal(await late(), 0, 'eight minutes after the start, ten after it stopped');
    });

    it('is only remembered once the sensor is left to the probe again, and nothing is late by it (A-68)', async () => {
      const { credentials, written, lefts, leave, late } = core([
        storedAt(-60_000),
        storedAt(-60_000, 2),
      ]);
      await credentials.restore();
      await leave([1, 3]);
      assert.equal(written.length, 1);
      assert.deepEqual(written[0]?.sensorIds, [1, 2], 'both times stay in the table');
      assert.deepEqual(lefts[0], { left: [1, 3], version: PINNING });
      assert.equal(await late(1), 0, 'the probe’s to refuse again');
      assert.equal(credentials.stats().withheld, 1, 'and its refusal holds the sensor');
      assert.equal(await late(2), 1);
    });

    it('does not start a core that cannot read the record', async () => {
      const { credentials, control } = core([storedAt(-60_000)]);
      control.failRead = true;
      await assert.rejects(credentials.restore(), /late_refusal_grace/);
    });

    it('reads an empty table as nothing, and writes nothing', async () => {
      const { credentials, written } = core();
      assert.deepEqual(await credentials.restore(), {
        restored: 0,
        ahead: 0,
        remembered: 0,
        spent: 0,
        left: 0,
        flapping: 0,
      });
      assert.deepEqual(written, []);
    });

    it('keeps one probe’s rows when another’s are spent', async () => {
      const { credentials, written, late } = core([
        storedAt(-60_000),
        {
          probe_id: '8',
          sensor_id: '1',
          stopped_ms: String(WALL - LATE_REFUSAL_GRACE_MS - LATE_REFUSAL_COOL_OFF_MS - 1),
          left_version: null,
        },
      ]);
      assert.deepEqual(await credentials.restore(), {
        restored: 1,
        ahead: 0,
        remembered: 0,
        spent: 1,
        left: 0,
        flapping: 0,
      });
      assert.deepEqual(written, [{ probeId: 8, sensorIds: [], stoppedAtMs: [] }]);
      assert.equal(await late(1, 7), 1);
      assert.equal(await late(1, 8), 0);
    });
  });

  describe('what is written, and when', () => {
    it('writes when a configuration stops leaving a sensor, and nothing when one changes nothing', async () => {
      const { written, lefts, leave } = core();
      await leave([1, 2, 3]);
      // What the probe is left is written (`A-68`); nothing has stopped being left.
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [], stoppedAtMs: [] }]);
      assert.deepEqual(lefts, [{ left: [1, 2, 3], version: PINNING }]);
      await leave([1, 2, 3]);
      assert.equal(written.length, 1, 'the same configuration again writes nothing');
      await leave([2, 3]);
      assert.deepEqual(written[1], { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] });
      assert.deepEqual(lefts[1], { left: [2, 3], version: PINNING });
      await leave([2, 3]);
      await leave([2, 3]);
      assert.equal(written.length, 2, 'the same configuration again writes nothing');
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

    it('keeps the time when the sensor is left again, and takes it away at the first configuration after its cool-off (A-68)', async () => {
      const { clock, written, lefts, leave } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      await leave([1, 2, 3]);
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] });
      assert.deepEqual(lefts.at(-1), { left: [1, 2, 3], version: PINNING });
      // Configured away again, a minute on: its grace begins again, as it always did.
      clock.ms += 60_000;
      clock.wall += 60_000;
      await leave([2, 3]);
      assert.equal(written.length, 4);
      assert.deepEqual(written.at(-1), {
        probeId: 7,
        sensorIds: [1],
        stoppedAtMs: [WALL + 60_000],
      });
      clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      await leave([2, 3]);
      assert.equal(written.length, 4, 'past its grace it is still remembered, and nothing moves');
      clock.ms += LATE_REFUSAL_COOL_OFF_MS;
      await leave([2, 3]);
      assert.equal(written.length, 5);
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [], stoppedAtMs: [] });
      assert.deepEqual(lefts.at(-1), { left: [2, 3], version: PINNING });
    });

    it('still judges by what it holds when a write fails, and writes again at the next configuration', async () => {
      const { control, written, leave, late } = core();
      await leave([1, 2, 3]);
      control.failWrite = true;
      await leave([2, 3]);
      assert.equal(written.length, 1, 'only the first configuration’s');
      assert.equal(await late(), 1, 'the running core has lost nothing');
      control.failWrite = false;
      await leave([2, 3]);
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] });
      await leave([2, 3]);
      assert.equal(written.length, 2, 'and once it has landed, not again');
    });

    it('writes one after another, so the last to land is the latest', async () => {
      const { control, written, order, leave } = core();
      await leave([1, 2, 3]);
      order.length = 0;
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

    it('writes for no result a probe sends, and once for a reconnect under another protocol version', async () => {
      const { credentials, clock, written, lefts, leave } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      assert.equal(written.length, 2);
      // Results, marked or not, from the probe and from another: no statement.
      await credentials.reported(7, [
        refused(1, T(0)),
        refused(2, T(0)),
        refused(9, T(0)),
        measured(3, T(0), 'error'),
        measured(2, T(1)),
      ]);
      await credentials.reported(8, [refused(1, T(0))]);
      assert.equal(written.length, 2, 'a result writes nothing');

      // What a probe says that does reach a configuration is the version it connects with. Below
      // the one that checks a name, it is left none of these sensors: one statement for the
      // reconnect, of no more rows than it has sensors, and none for a build that follows it.
      const reconnect = (version: number): Promise<unknown> =>
        credentials.withhold(7, [2, 3].map(leftToProbe), version);
      await reconnect(PINNING - 1);
      assert.equal(written.length, 3, 'one statement for the reconnect');
      assert.deepEqual(written[2]?.sensorIds, [1, 2, 3]);
      // Left nothing, so there is no row to carry a version, and none is sent.
      assert.deepEqual(lefts[2], { left: [], version: null });
      await reconnect(PINNING - 1);
      await reconnect(PINNING - 1);
      assert.equal(written.length, 3, 'and none for the same version again');
      // Back at the version that checks: left again, and again one statement. The times stay,
      // which is what keeps the next reconnect from beginning them again (`A-68`).
      clock.ms += 60_000;
      clock.wall += 60_000;
      await reconnect(PINNING);
      assert.equal(written.length, 4);
      assert.deepEqual(written[3], {
        probeId: 7,
        sensorIds: [1, 2, 3],
        stoppedAtMs: [WALL, WALL, WALL],
      });
      assert.deepEqual(lefts[3], { left: [2, 3], version: PINNING });
      // And down again: one statement, for what it is left, and no time in it has moved.
      clock.ms += 60_000;
      clock.wall += 60_000;
      await reconnect(PINNING - 1);
      assert.equal(written.length, 5);
      assert.deepEqual(written[4]?.stoppedAtMs, [WALL, WALL, WALL]);
      assert.deepEqual(lefts[4], { left: [], version: null });
    });
  });

  describe('a write gives way, and holds nobody back', () => {
    const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

    it('sets a lock timeout under PostgreSQL’s deadlock timeout, and a statement timeout, in its own transaction', async () => {
      const { bounds, written, leave } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      assert.equal(written.length, 2);
      // Set by `Database.tx` for the write's transaction alone, and its give-ways counted by the
      // write (`recordWritesGivenUp`) rather than by the pool, whose counts warn (`P-229`).
      const own = {
        lockTimeoutMs: 300,
        statementTimeoutMs: 2_000,
        ownLockTimeouts: true,
        ownStatementTimeouts: true,
      };
      assert.deepEqual(bounds, [own, own]);
      assert.equal(LATE_REFUSAL_SAVE_LOCK_MS, 300);
      assert.equal(LATE_REFUSAL_SAVE_STATEMENT_MS, 2_000);
      assert.equal(LATE_REFUSAL_SAVE_WAIT_MS, 3_000);
      // 300 ms is under `deadlock_timeout`, a second as PostgreSQL ships: this is what gives up.
    });

    it('does not hold another probe’s configuration behind a write that is stalled', async () => {
      const { credentials, control, written, logged } = core([], 60);
      const send = (probeId: number, sensorIds: readonly number[]): Promise<unknown> =>
        credentials.withhold(probeId, sensorIds.map(leftToProbe), PINNING);
      await send(7, [1, 2, 3]);
      await send(8, [1, 2, 3]);
      control.stalled = 7;
      let seventh = false;
      const stalled = send(7, [2, 3]).then(() => {
        seventh = true;
      });
      await settle(5);
      // Probe 8's record moves while probe 7's write is out, and is stored at once.
      await send(8, [2, 3]);
      assert.equal(seventh, false, 'probe 7 is still waiting for its own');
      assert.deepEqual(written.at(-1), { probeId: 8, sensorIds: [1], stoppedAtMs: [WALL] });
      assert.equal(written.length, 3, 'each probe’s first configuration, and this');
      assert.equal(credentials.stats().recordWritesGivenUp, 0);

      // And probe 7's configuration goes out without its write, after the bound and no later.
      const started = performance.now();
      await stalled;
      assert.ok(performance.now() - started < 1_000, 'let go at the bound');
      assert.equal(written.length, 3, 'the write has still not come back');
      assert.deepEqual(
        logged.map((line) => [line.level, line.probeId]),
        [[WARN, 7]],
      );
      // Counted for Core Health (`A-68`): a configuration went out without its record stored.
      assert.equal(credentials.stats().recordWritesGivenUp, 1);

      // Probe 7 is owed a write from then on, so the next prune asks for one, behind the one
      // that is out, and is let go at the bound as the configuration was.
      await credentials.prune();
      assert.equal(written.length, 3);
      assert.equal(credentials.stats().recordWritesGivenUp, 2, 'a second write, not waited for');

      // When the first does come back, the one asked for runs after it, and nothing is owed.
      control.stalled = null;
      control.release();
      await settle(5);
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] });
      assert.equal(written.filter((one) => one.probeId === 7).length, 3);
      const before = written.length;
      await credentials.prune();
      assert.equal(written.length, before);
      assert.equal(credentials.stats().recordWritesGivenUp, 2, 'landing late is not counted again');
    });

    it('lets a prune go at the bound too, and keeps one write waiting behind a stalled one, not one per request', async () => {
      const { credentials, control, written, order, leave } = core([], 40);
      await leave([1, 2, 3]);
      order.length = 0;
      control.stalled = 7;
      await leave([2, 3]);
      await credentials.prune();
      await credentials.prune();
      await leave([3]);
      await credentials.prune();
      assert.deepEqual(order, ['begin 1'], 'one is out, and nothing has started behind it');
      control.stalled = null;
      control.release();
      await settle(10);
      // The one that was out, and one after it with everything asked for since.
      assert.deepEqual(order, ['begin 1', 'end 1', 'begin 1,2', 'end 1,2']);
      assert.equal(written.length, 3);
      // Two writes were asked for and neither was waited out: counted once each, however many
      // callers stopped waiting for the second (`A-68`).
      assert.equal(credentials.stats().recordWritesGivenUp, 2);
    });

    /** An error as the driver raises one, before the pool has wrapped it. */
    const driverError = (code: string, message: string): Error =>
      Object.assign(new Error(message), { code });
    const gaveWay: [string, Error, number][] = [
      ['a lock it could not have', driverError('55P03', 'canceling statement'), WARN],
      ['the statement timeout', driverError('57014', 'canceling statement'), WARN],
      ['a deadlock it lost', driverError('40P01', 'deadlock detected'), WARN],
      [
        'a lock, as the pool wraps it',
        new DatabaseError('query failed', { cause: { code: '55P03', message: 'lock timeout' } }),
        WARN,
      ],
      ['a key that is not there', driverError('23503', 'violates foreign key'), ERROR],
      [
        'anything else the pool wraps',
        new DatabaseError('query failed', { cause: { code: '42P01', message: 'no relation' } }),
        ERROR,
      ],
      ['a lost connection', new Error('connection terminated'), ERROR],
    ];
    for (const [name, failure, level] of gaveWay) {
      it(`logs ${name} at ${level === WARN ? 'warn' : 'error'}, returns the configuration, and writes again`, async () => {
        const { credentials, control, written, logged, leave, late } = core();
        await leave([1, 2, 3]);
        assert.equal(credentials.stats().recordWritesGivenUp, 0);
        control.failWith = failure;
        await leave([2, 3]);
        assert.deepEqual(
          logged.map((line) => [line.level, line.probeId]),
          [[level, 7]],
        );
        // One number for both (`A-68`): gave way or failed, the row is not in the table.
        assert.equal(credentials.stats().recordWritesGivenUp, 1);
        assert.equal(await late(), 1, 'judged by what is held, written or not');
        control.failWith = undefined;
        await leave([2, 3]);
        assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] });
        assert.equal(written.length, 2);
        assert.equal(logged.length, 1);
        assert.equal(credentials.stats().recordWritesGivenUp, 1, 'made again, and it landed');
      });
    }

    it('drops an entry whose sensor is gone, and does not write it again every minute', async () => {
      const { credentials, control, written, leave, late } = core();
      await leave([1, 2, 3]);
      // The first write fails, and sensor 1 is deleted before the next.
      control.failWrite = true;
      await leave([2]);
      control.failWrite = false;
      control.gone.add(1);
      await credentials.prune();
      assert.deepEqual(
        written.map((one) => one.sensorIds),
        [[], [1, 3]],
      );
      assert.equal(await late(1), 0, 'nothing is held for a sensor that is not there');
      assert.equal(await late(3), 1, 'and what is there is kept');
      await credentials.prune();
      await credentials.prune();
      assert.equal(written.length, 2, 'stored, so nothing is owed');
      // The next write is of what is left, and no longer names it.
      await leave([]);
      assert.deepEqual(written.at(-1)?.sensorIds, [3, 2]);
    });

    it('drops every entry of a probe that is gone', async () => {
      const { credentials, control, written, leave, late } = core();
      await leave([1, 2, 3]);
      control.gone = new Set([1, 2, 3]);
      await leave([]);
      assert.equal(written.length, 2);
      assert.equal(await late(1), 0);
      assert.equal(await late(2), 0);
      await credentials.prune();
      assert.equal(written.length, 2);
    });

    it('keeps an entry that was recorded again while the write that missed it was out', async () => {
      const { control, clock, written, leave, late } = core();
      await leave([1, 2, 3]);
      // Sensor 1's write is out, reporting it gone, while it is left again and then is not.
      control.writeDelaysMs.push(30);
      control.gone.add(1);
      const first = leave([2, 3]);
      await settle(5);
      control.gone.clear();
      clock.ms += 1_000;
      clock.wall += 1_000;
      await Promise.all([first, leave([1, 2, 3]), leave([2, 3])]);
      assert.equal(
        await late(1),
        1,
        'the entry is the later one, and the write was about the earlier',
      );
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL + 1_000] });
    });
  });

  describe('a probe’s protocol version alone begins one window, and no other inside the hour (A-68)', () => {
    const GRACE = LATE_REFUSAL_GRACE_MS;
    const COOL_OFF = LATE_REFUSAL_COOL_OFF_MS;
    /** A sensor a name entry covers: sent, and the core's to decide, whatever the probe speaks. */
    const covered = (sensorId: number): SensorBeingSent => ({
      ...leftToProbe(sensorId),
      restrictions: new Map([['snmp', { targets: ['10.20.0.0/16', '*.dc.test'], hostKeys: null }]]),
    });

    it('is an hour from when a window began: ten minutes of grace and fifty of cool-off', () => {
      assert.equal(COOL_OFF, 3_000_000);
      assert.equal(GRACE + COOL_OFF, 3_600_000);
    });

    it('alternating versions five times gives what one downgrade gives: the one window, where it began', async () => {
      const { clock, written, leave, late } = core();
      const tick = (ms: number): void => {
        clock.ms += ms;
        clock.wall += ms;
      };
      await leave([1, 2, 3]);
      // Down: the probe is left nothing, and the grace begins for all three.
      await leave([1, 2, 3], PINNING - 1);
      assert.equal(await late(), 1);
      const began = written.at(-1);
      assert.deepEqual(began, {
        probeId: 7,
        sensorIds: [1, 2, 3],
        stoppedAtMs: [WALL, WALL, WALL],
      });

      // Up and down again, every two minutes: five changes of version in all.
      const versions = [PINNING, PINNING - 1, PINNING, PINNING - 1];
      for (const version of versions) {
        tick(120_000);
        await leave([1, 2, 3], version);
        assert.deepEqual(written.at(-1), began, 'no time in the table has moved');
        // Under the older version a refusal is late for what is left of the one window; under
        // the newer the sensor is the probe's to refuse, and nothing is late.
        assert.equal(await late(2), version === PINNING ? 0 : 1);
      }
      // Eight minutes in. To the last millisecond of the window that began at the first...
      tick(120_000);
      assert.equal(await late(2), 1);
      // ...and not one after, although the last downgrade was two minutes ago.
      tick(1);
      assert.equal(await late(2), 0, 'the later downgrades began nothing');
      await leave([1, 2, 3], PINNING - 1);
      assert.equal(await late(3), 0);

      // And for the rest of the hour: up and down, and nothing is late.
      for (let minute = 12; minute < 60; minute += 12) {
        tick(360_000);
        await leave([1, 2, 3], PINNING);
        tick(360_000);
        await leave([1, 2, 3], PINNING - 1);
        assert.equal(await late(), 0, `nothing is late ${String(minute)} minutes in`);
        assert.deepEqual(written.at(-1), began);
      }
    });

    it('begins another once the hour is out, and not a millisecond before', async () => {
      const { clock, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([1, 2, 3], PINNING - 1);
      clock.ms += GRACE + 1;
      await leave([1, 2, 3], PINNING);
      clock.ms += COOL_OFF - 1;
      // The last millisecond the window is remembered.
      await leave([1, 2, 3], PINNING - 1);
      assert.equal(await late(), 0);
      await leave([1, 2, 3], PINNING);
      clock.ms += 1;
      await leave([1, 2, 3], PINNING - 1);
      assert.equal(await late(), 1, 'an hour and a millisecond after the first began');
      clock.ms += GRACE;
      assert.equal(await late(), 1);
      clock.ms += 1;
      assert.equal(await late(), 0, 'and it is ten minutes, as the first was');
    });

    it('takes the cool-off it is given, and none below zero', async () => {
      for (const [coolOff, lateAfter] of [
        [5_000, 0],
        [0, 1],
        [-60_000, 1],
      ] as const) {
        const clock = { ms: 0 };
        const credentials = new CredentialVouching({
          db: { query: () => Promise.resolve([]), tx: () => Promise.reject(new Error('none')) },
          logger: silent,
          sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned])),
          rights: () => Promise.resolve(new Map()),
          now: () => clock.ms,
          lateRefusalGraceMs: 2_000,
          lateRefusalCoolOffMs: coolOff,
          // The layer under a flap (`A-72`), which these versions would otherwise be.
          protocolFlapHoldMs: 0,
        });
        const send = (version: number): Promise<unknown> =>
          credentials.withhold(7, [leftToProbe(1)], version);
        await send(PINNING);
        await send(PINNING - 1);
        clock.ms = 2_001;
        await send(PINNING);
        await send(PINNING - 1);
        const late = (await credentials.reported(7, [refused(1, T(0))])).late.length;
        assert.equal(late, lateAfter, `a cool-off of ${String(coolOff)} ms`);
        if (lateAfter === 0) continue;
        // And the window that began is kept through the next configuration, whatever the
        // cool-off: below zero it is none, not a grace that ends at the first build.
        clock.ms += 1_000;
        await send(PINNING - 1);
        assert.equal((await credentials.reported(7, [refused(1, T(1))])).late.length, 1);
      }
    });

    it('an operator’s change after a downgrade still gets its grace, inside the hour', async () => {
      const { credentials, clock, written, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([1, 2, 3], PINNING - 1);
      clock.ms += GRACE + 60_000;
      clock.wall += GRACE + 60_000;
      await leave([1, 2, 3], PINNING);
      assert.equal(await late(), 0, 'left again: the probe’s to refuse');

      // A name entry now covers sensor 1's device: the core decides it, at the same version.
      // That is a change somebody made, and a refusal in flight for it is late for ten minutes.
      await credentials.withhold(7, [covered(1), leftToProbe(2), leftToProbe(3)], PINNING);
      assert.equal(await late(1), 1);
      assert.deepEqual(written.at(-1)?.stoppedAtMs, [WALL + GRACE + 60_000, WALL, WALL]);
      clock.ms += GRACE;
      assert.equal(await late(1), 1);
      clock.ms += 1;
      assert.equal(await late(1), 0);
    });

    it('tells a change made beside a downgrade from the downgrade: one sensor gets its grace, the others what is left of theirs', async () => {
      const { credentials, clock, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([1, 2, 3], PINNING - 1);
      clock.ms += GRACE + 60_000;
      await leave([1, 2, 3], PINNING);
      // The probe reconnects under the older version, and in the same configuration sensor 1 is
      // covered by a name entry and sensor 3 is no longer sent at all. Neither would be left to
      // it had the version stayed, so those two were stopped by a change, and sensor 2 by the
      // version alone.
      await credentials.withhold(7, [covered(1), leftToProbe(2)], PINNING - 1);
      assert.equal(await late(1), 1, 'configured: a grace of its own');
      assert.equal(await late(3), 1, 'no longer sent: a grace of its own');
      assert.equal(await late(2), 0, 'the version alone: its window ran out a minute ago');
    });

    it('asks what the version before would have left only when a remembered window could begin again', async () => {
      const { credentials, clock, leave } = core();
      const checked = (): number => credentials.stats().checked;
      await leave([1, 2, 3]);
      assert.equal(checked(), 3);
      // The first downgrade: nothing is remembered, so there is nothing to ask.
      await leave([1, 2, 3], PINNING - 1);
      assert.equal(checked(), 6);
      await leave([1, 2, 3], PINNING);
      assert.equal(checked(), 9);
      // The second is asked about, and what was asked is not counted as sent.
      clock.ms += 1_000;
      await leave([1, 2, 3], PINNING - 1);
      assert.equal(checked(), 12, 'three sensors a configuration, however often it asked');
    });

    it('when it cannot tell the two apart, time alone decides: no window, and the log says so', async () => {
      const { credentials, clock, control, logged, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([1, 2, 3], PINNING - 1);
      clock.ms += GRACE + 1;
      await leave([1, 2, 3], PINNING);
      // The check that decides the configuration answers; the one asked a second time, for
      // what the version before would have left, does not.
      control.failVouchersAt = 2;
      await credentials.withhold(7, [covered(1), leftToProbe(2)], PINNING - 1);
      assert.deepEqual(
        logged.map((line) => [line.level, line.probeId]),
        [[WARN, 7]],
      );
      assert.match(logged[0]?.msg ?? '', /protocol version\s+alone/);
      assert.equal(await late(1), 0, 'a remembered window is not begun again on a guess');
      assert.equal(await late(2), 0);
      assert.equal(credentials.stats().checked, 3 * 3 + 2, 'and the failed one is not counted');
    });

    it('a restart in the middle keeps the bound', async () => {
      const first = core();
      const tick = (clock: { ms: number; wall: number }, ms: number): void => {
        clock.ms += ms;
        clock.wall += ms;
      };
      await first.leave([1, 2, 3]);
      await first.leave([1, 2, 3], PINNING - 1);
      tick(first.clock, 120_000);
      await first.leave([1, 2, 3], PINNING);

      // The core stops here, two minutes into the window, with the probe at the newer version,
      // and starts again three minutes later on what the table holds.
      const second = core(first.table());
      second.clock.wall = first.clock.wall + 180_000;
      assert.deepEqual(await second.credentials.restore(), {
        restored: 3,
        ahead: 0,
        remembered: 0,
        spent: 0,
        left: 3,
        flapping: 0,
      });
      // The probe's first hello to it is the older version: stopped by the version alone,
      // which this core knows because the rows say which version left it the sensors.
      await second.leave([1, 2, 3], PINNING - 1);
      assert.deepEqual(second.written.at(-1)?.stoppedAtMs, [WALL, WALL, WALL], 'not begun again');
      assert.equal(await second.late(), 1, 'five minutes in: what is left of the one window');
      tick(second.clock, 300_000);
      assert.equal(await second.late(), 1, 'to its last millisecond, counted across the restart');
      tick(second.clock, 1);
      assert.equal(await second.late(), 0);

      // And a core started when the grace is over and the hour is not still refuses a window.
      const third = core(second.table());
      third.clock.wall = second.clock.wall + 600_000;
      assert.deepEqual(await third.credentials.restore(), {
        restored: 0,
        ahead: 0,
        remembered: 3,
        spent: 0,
        left: 0,
        flapping: 0,
      });
      await third.leave([1, 2, 3], PINNING);
      await third.leave([1, 2, 3], PINNING - 1);
      assert.equal(await third.late(), 0, 'twenty minutes after the window began');
      // While an operator's change, on that same core, gets its grace.
      await third.leave([1, 2, 3], PINNING);
      await third.leave([2, 3], PINNING);
      assert.equal(await third.late(1), 1);
    });
  });

  describe('what each probe was last left is stored, and a restarted core compares with it (A-68)', () => {
    it('writes what a probe is left with the version it was left it under, and again when either moves', async () => {
      const { written, lefts, leave } = core();
      await leave([1, 2, 3]);
      assert.deepEqual(lefts, [{ left: [1, 2, 3], version: PINNING }]);
      // A newer version that leaves it the same sensors: the rows say so, since the next stop
      // is told apart by it.
      await leave([1, 2, 3], PINNING + 1);
      assert.deepEqual(lefts.at(-1), { left: [1, 2, 3], version: PINNING + 1 });
      await leave([1, 2, 3], PINNING + 1);
      assert.equal(written.length, 2);
    });

    it('writes nothing for a version change that leaves the probe nothing before or after', async () => {
      const { written, leave } = core();
      await leave([], PINNING);
      await leave([], PINNING - 1);
      await leave([1, 2], PINNING - 1);
      await leave([1, 2], PINNING - 2);
      assert.deepEqual(written, [], 'no row to carry a version, and no window to remember');
    });

    it('a change committed before the core stopped, and not yet built for the probe, still begins its grace', async () => {
      const first = core();
      await first.leave([1, 2, 3]);
      // An operator's change takes sensor 1 from the probe. It is committed, and the core stops
      // before the notifier's quarter of a second is up, or with the probe away: no
      // configuration is built, and there is no row saying sensor 1 stopped being left.
      const stored = first.table();
      assert.deepEqual(
        stored.map((row) => [row.sensor_id, row.stopped_ms, row.left_version]),
        [
          ['1', null, PINNING],
          ['2', null, PINNING],
          ['3', null, PINNING],
        ],
      );

      const second = core(stored);
      assert.deepEqual(await second.credentials.restore(), {
        restored: 0,
        ahead: 0,
        remembered: 0,
        spent: 0,
        left: 3,
        flapping: 0,
      });
      assert.deepEqual(second.written, [], 'reading what a probe is left writes nothing');
      // The probe redials. The configuration built for it is compared with the last one the
      // core before it built, and finds the stop: the grace begins now, and is stored.
      await second.leave([2, 3]);
      assert.deepEqual(second.written, [{ probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] }]);
      assert.equal(await second.late(1), 1, 'late, where it was a failed scan');
      assert.equal(await second.late(2), 0, 'still the probe’s to refuse');
      second.clock.ms += LATE_REFUSAL_GRACE_MS + 1;
      assert.equal(await second.late(1), 0, 'and for ten minutes from that configuration');
    });

    it('honours a refusal for what the probe was last left, before the restarted core has built anything', async () => {
      const first = core();
      await first.leave([1, 2, 3]);
      const second = core(first.table());
      await second.credentials.restore();
      const reported = await second.credentials.reported(7, [refused(1, T(0)), refused(9, T(0))]);
      assert.equal(reported.unearned.length, 1, 'sensor 9 was never left to it');
      assert.deepEqual(
        reported.results.map((one) => one.sensorId),
        [9],
      );
      assert.equal(second.credentials.stats().withheld, 1, 'sensor 1 is held, as before the stop');
    });

    it('keeps what this core has built itself over what the table says', async () => {
      const first = core();
      await first.leave([1, 2, 3]);
      const second = core(first.table());
      await second.leave([2]);
      const restored = await second.credentials.restore();
      assert.equal(restored.left, 0, 'the probe has a configuration from this core already');
      await second.leave([2]);
      assert.equal(await second.late(1), 0, 'nothing was stopped by reading the table late');
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
      // And Core Health reads how many writes of it were given up (`A-68`).
      assert.match(
        main,
        /lateRefusalWritesGivenUp: \(\) => credentialVouching\.stats\(\)\.recordWritesGivenUp,/,
      );
      // A flap that is over has the configurations built again, and Probe Health reads the flap
      // and the results dropped for withheld sensors (`A-72`). The class's own hold is the one
      // that ships: `main.ts` does not set it.
      assert.match(main, /onProtocolFlapOver: \(\) => \{\n\s+configNotifier\.flush\(\);\n\s+\},/);
      assert.match(
        main,
        /protocolFlap: \(probeObjectId\) => credentialVouching\.protocolFlap\(probeObjectId\),/,
      );
      assert.match(
        main,
        /withheldResults: \(probeObjectId\) => refusals\.withheldFor\(probeObjectId\),/,
      );
      assert.doesNotMatch(main, /protocolFlapHoldMs/);
    });
  });

  describe('pruned past the grace, without waiting for a configuration', () => {
    it('drops an entry one millisecond past its cool-off, here and in the table, and not before (A-68)', async () => {
      const { credentials, clock, written, lefts, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      await credentials.prune();
      clock.ms += LATE_REFUSAL_GRACE_MS;
      await credentials.prune();
      assert.equal(written.length, 2, 'inside the grace there is nothing to prune or to write');
      assert.equal(await late(), 1);

      // Past the grace nothing is late by it, and it is still remembered: nothing to write.
      clock.ms += 1;
      await credentials.prune();
      assert.equal(await late(), 0);
      clock.ms += LATE_REFUSAL_COOL_OFF_MS - 1;
      await credentials.prune();
      assert.equal(written.length, 2, 'to the last millisecond of the cool-off');

      clock.ms += 1;
      await credentials.prune();
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [], stoppedAtMs: [] });
      assert.deepEqual(lefts.at(-1), { left: [2, 3], version: PINNING }, 'what it is left stays');
      assert.equal(written.length, 3);
      // Gone, not merely out of date: a clock set back does not bring it back.
      clock.ms -= LATE_REFUSAL_GRACE_MS + LATE_REFUSAL_COOL_OFF_MS;
      assert.equal(await late(), 0);
      await credentials.prune();
      assert.equal(written.length, 3, 'and nothing more to write');
    });

    it('keeps what is still remembered when it drops what is not', async () => {
      const { credentials, clock, written, leave, late } = core();
      await leave([1, 2, 3]);
      await leave([2, 3]);
      clock.ms += 300_000;
      clock.wall += 300_000;
      await leave([3]);
      clock.ms += 300_001;
      clock.wall += 300_001;
      await credentials.prune();
      assert.equal(written.length, 3, 'one past its grace, both remembered: nothing to write');
      assert.equal(await late(1), 0);
      assert.equal(await late(2), 1);
      clock.ms += LATE_REFUSAL_COOL_OFF_MS;
      clock.wall += LATE_REFUSAL_COOL_OFF_MS;
      await credentials.prune();
      assert.deepEqual(written.at(-1), {
        probeId: 7,
        sensorIds: [2],
        stoppedAtMs: [WALL + 300_000],
      });
    });

    it('prunes what a start took up, for a probe that never redials', async () => {
      const { credentials, clock, written } = core([storedAt(-120_000)]);
      await credentials.restore();
      clock.ms += 480_001;
      await credentials.prune();
      assert.deepEqual(written, [], 'past its grace, and remembered');
      clock.ms += LATE_REFUSAL_COOL_OFF_MS;
      await credentials.prune();
      assert.deepEqual(written, [{ probeId: 7, sensorIds: [], stoppedAtMs: [] }]);
    });

    it('writes again what an earlier write could not', async () => {
      const { credentials, control, written, leave } = core();
      await leave([1, 2, 3]);
      control.failWrite = true;
      await leave([2, 3]);
      await credentials.prune();
      assert.equal(written.length, 1);
      control.failWrite = false;
      await credentials.prune();
      assert.deepEqual(written.at(-1), { probeId: 7, sensorIds: [1], stoppedAtMs: [WALL] });
      await credentials.prune();
      assert.equal(written.length, 2);
    });
  });

  // ---- `A-72`: a probe whose protocol version flaps holds what its version decides ----

  describe('a probe whose protocol version changes twice inside the hold is a flap, and holds what its version decides (A-72)', () => {
    const HOLD = PROTOCOL_FLAP_HOLD_MS;
    const quiet = (version: number): VersionRecord => ({
      version,
      changedAt: null,
      since: null,
      changes: 0,
      floor: null,
    });
    const run = (
      version: number,
      changedAt: number,
      since: number,
      changes: number,
      floor: number | null = null,
    ): VersionRecord => ({ version, changedAt, since, changes, floor });

    it('is an hour', () => {
      assert.equal(HOLD, 3_600_000);
    });

    describe('the record, a configuration at a time', () => {
      const T0 = 1_000_000;
      const cases: {
        name: string;
        before: VersionRecord | undefined;
        version: number;
        at: number;
        after: VersionRecord;
        flapping: boolean;
        hold?: number;
      }[] = [
        {
          name: 'the first configuration starts it, with no change',
          before: undefined,
          version: 24,
          at: T0,
          after: quiet(24),
          flapping: false,
        },
        {
          name: 'the same version changes nothing',
          before: quiet(24),
          version: 24,
          at: T0,
          after: quiet(24),
          flapping: false,
        },
        {
          name: 'another version with none before it is a first change, and holds nothing',
          before: quiet(24),
          version: 23,
          at: T0,
          after: run(23, T0, T0, 1),
          flapping: false,
        },
        {
          name: 'a second inside the hold is a flap, judged at the lower of the two',
          before: run(23, T0, T0, 1),
          version: 24,
          at: T0 + HOLD - 1,
          after: run(24, T0 + HOLD - 1, T0, 2, 23),
          flapping: true,
        },
        {
          name: 'a second a whole hold after the first is a first change again',
          before: run(23, T0, T0, 1),
          version: 24,
          at: T0 + HOLD,
          after: run(24, T0 + HOLD, T0 + HOLD, 1),
          flapping: false,
        },
        {
          name: 'a flap that goes on keeps its floor and counts the change',
          before: run(24, T0, T0 - 60_000, 2, 23),
          version: 23,
          at: T0 + 120_000,
          after: run(23, T0 + 120_000, T0 - 60_000, 3, 23),
          flapping: true,
        },
        {
          name: 'a lower version spoken in a flap lowers its floor: nothing more than it may have',
          before: run(23, T0, T0 - 60_000, 2, 23),
          version: 22,
          at: T0 + 120_000,
          after: run(22, T0 + 120_000, T0 - 60_000, 3, 22),
          flapping: true,
        },
        {
          name: 'two changes up are a flap at the first of them, not at the version before',
          before: run(24, T0, T0, 1),
          version: 25,
          at: T0 + 60_000,
          after: run(25, T0 + 60_000, T0, 2, 24),
          flapping: true,
        },
        {
          name: 'the same version inside the hold keeps the flap as it is',
          before: run(24, T0, T0 - 60_000, 2, 23),
          version: 24,
          at: T0 + HOLD - 1,
          after: run(24, T0, T0 - 60_000, 2, 23),
          flapping: true,
        },
        {
          name: 'the same version a whole hold after the last change: over, and forgotten',
          before: run(24, T0, T0 - 60_000, 2, 23),
          version: 24,
          at: T0 + HOLD,
          after: quiet(24),
          flapping: false,
        },
        {
          name: 'a change after a flap is over begins a run of its own',
          before: run(24, T0, T0 - 60_000, 5, 22),
          version: 23,
          at: T0 + HOLD,
          after: run(23, T0 + HOLD, T0 + HOLD, 1),
          flapping: false,
        },
        {
          name: 'a hold of nothing holds nothing',
          before: run(23, T0, T0, 1),
          version: 24,
          at: T0,
          after: run(24, T0, T0, 1),
          flapping: false,
          hold: 0,
        },
      ];
      for (const one of cases) {
        it(one.name, () => {
          const hold = one.hold ?? HOLD;
          const after = nextVersionRecord(one.before, one.version, one.at, hold);
          assert.deepEqual(after, one.after);
          assert.equal(isFlapping(after, one.at, hold), one.flapping);
        });
      }

      it('is a flap to the last millisecond of the hold, and not one after', () => {
        const flap = run(24, T0, T0 - 60_000, 2, 23);
        assert.equal(isFlapping(flap, T0 + HOLD - 1, HOLD), true);
        assert.equal(isFlapping(flap, T0 + HOLD, HOLD), false);
        assert.equal(isFlapping(run(23, T0, T0, 1), T0, HOLD), false, 'one change is no flap');
        assert.equal(isFlapping(undefined, T0, HOLD), false);
      });
    });

    describe('how a stored record is taken up at a start', () => {
      const WALL_NOW = WALL + 10 * 60_000;
      const NOW = 7_000_000;
      const row = (
        changedOffsetMs: number | null,
        changes: number,
        floor: number | null,
        sinceOffsetMs: number | null = changedOffsetMs,
      ): Parameters<typeof restoredVersion>[0] => ({
        version: 24,
        changed_ms: changedOffsetMs === null ? null : String(WALL_NOW + changedOffsetMs),
        since_ms: sinceOffsetMs === null ? null : String(WALL_NOW + sinceOffsetMs),
        run_changes: changes,
        flap_floor: floor,
      });
      const cases: {
        name: string;
        row: Parameters<typeof restoredVersion>[0];
        record: VersionRecord;
        ahead: boolean;
      }[] = [
        {
          name: 'a version with no change is the version',
          row: row(null, 0, null),
          record: quiet(24),
          ahead: false,
        },
        {
          name: 'a flap ten minutes old is a flap, as far along as it was',
          row: row(-600_000, 3, 23, -900_000),
          record: run(24, NOW - 600_000, NOW - 900_000, 3, 23),
          ahead: false,
        },
        {
          name: 'a first change ten minutes old is still one, so the next change is a flap',
          row: row(-600_000, 1, null),
          record: run(24, NOW - 600_000, NOW - 600_000, 1),
          ahead: false,
        },
        {
          name: 'a last change a whole hold ago is none: the flap is over',
          row: row(-HOLD, 4, 23, -HOLD - 60_000),
          record: quiet(24),
          ahead: false,
        },
        {
          name: 'a clock set forward across the restart ends it early, the side that sends less',
          row: row(-HOLD - 86_400_000, 2, 23),
          record: quiet(24),
          ahead: false,
        },
        {
          name: 'a clock set back gives the hold from this start and no more, and is written again',
          row: row(3_600_000, 2, 23, 3_000_000),
          record: run(24, NOW, NOW, 2, 23),
          ahead: true,
        },
        {
          name: 'a time that cannot be read is no change',
          row: { ...row(0, 2, 23), changed_ms: 'NaN' },
          record: quiet(24),
          ahead: false,
        },
        {
          name: 'a floor above the version is never taken: never more than the version spoken',
          row: row(-60_000, 2, 26),
          record: run(24, NOW - 60_000, NOW - 60_000, 2, 24),
          ahead: false,
        },
        {
          name: 'a run that never began is never later than its last change',
          row: row(-60_000, 2, 23, null),
          record: run(24, NOW - 60_000, NOW - 60_000, 2, 23),
          ahead: false,
        },
      ];
      for (const one of cases) {
        it(one.name, () => {
          assert.deepEqual(restoredVersion(one.row, WALL_NOW, NOW, HOLD), {
            record: one.record,
            ahead: one.ahead,
          });
        });
      }
    });

    /** A core with the hold as it ships, and what Probe Health reads of probe 7 from it. */
    function flapping(
      stored: readonly StoredRow[] = [],
      flap: Parameters<typeof core>[2] = {},
    ): ReturnType<typeof core> & {
      tick: (ms: number) => void;
      /** Which of sensors 1 to 3 probe 7 is sent at this version, and which are withheld. */
      speak: (version: number, sensorIds?: readonly number[]) => Promise<Map<number, string>>;
    } {
      const made = core(stored, undefined, { holdMs: HOLD, ...flap });
      return {
        ...made,
        tick: (ms) => {
          made.clock.ms += ms;
          made.clock.wall += ms;
        },
        speak: (version, sensorIds = [1, 2, 3]) =>
          made.credentials.withhold(7, sensorIds.map(leftToProbe), version),
      };
    }
    const CANNOT = WITHHELD_CREDENTIALS.probeCannotPin;
    const all = (sentence: string): Map<number, string> =>
      new Map([1, 2, 3].map((sensorId) => [sensorId, sentence]));

    it('five alternations: the first downgrade withholds, and nothing after it moves inside the hold', async () => {
      const { credentials, written, flaps, speak, tick } = flapping();
      assert.deepEqual(await speak(PINNING), new Map());
      // The first change, a downgrade: as it always was.
      assert.deepEqual(await speak(PINNING - 1), all(CANNOT));
      assert.equal(credentials.protocolFlap(7), null, 'one change is no flap');
      const graceWrites = written.length;

      // Up, down, up, down, every three minutes: each is held where the first left them.
      const versions = [PINNING, PINNING - 1, PINNING, PINNING - 1];
      for (const [index, version] of versions.entries()) {
        tick(180_000);
        assert.deepEqual(await speak(version), all(CANNOT), `change ${String(index + 2)}`);
        assert.equal(credentials.stats().withheld, 3);
        assert.deepEqual(credentials.protocolFlap(7), {
          version,
          floor: PINNING - 1,
          changes: index + 2,
          sinceMs: (index + 1) * 180_000,
          remainingMs: HOLD,
        });
      }
      // Nothing the probe is left moved, so nothing of the late-refusal record is written.
      assert.equal(written.length, graceWrites, 'no window begun, none moved');
      // One row of its own a change, of the probe's own record, and one at its first build.
      assert.deepEqual(
        flaps.map((row) => [row.version, row.run_changes, row.flap_floor]),
        [
          [PINNING, 0, null],
          [PINNING - 1, 1, null],
          [PINNING, 2, PINNING - 1],
          [PINNING - 1, 3, PINNING - 1],
          [PINNING, 4, PINNING - 1],
          [PINNING - 1, 5, PINNING - 1],
        ],
      );
      // A steady build at the version it ended on writes nothing.
      await speak(PINNING - 1);
      assert.equal(flaps.length, 6);
    });

    it('a flap between two versions that both leave the name to the probe moves the late-refusal record no further than the change that began it', async () => {
      const { credentials, written, speak, tick } = flapping();
      assert.deepEqual(await speak(PINNING), new Map());
      tick(180_000);
      assert.deepEqual(await speak(PINNING + 1), new Map());
      tick(180_000);
      assert.deepEqual(await speak(PINNING), new Map());
      assert.equal(credentials.protocolFlap(7)?.floor, PINNING);
      const writes = written.length;
      // Each is sent, as at either version, and recorded as left under the floor: the version
      // the probe is left its sensors under has not moved, so there is nothing to store.
      for (const version of [PINNING + 1, PINNING, PINNING + 1]) {
        tick(180_000);
        assert.deepEqual(await speak(version), new Map());
      }
      assert.equal(written.length, writes);
    });

    it('is over when the version has held an hour, and not a millisecond before', async () => {
      const { credentials, flaps, speak, tick } = flapping();
      await speak(PINNING);
      await speak(PINNING - 1);
      tick(120_000);
      await speak(PINNING);
      tick(HOLD - 1);
      assert.deepEqual(await speak(PINNING), all(CANNOT), 'the last millisecond of the hold');
      assert.equal(credentials.protocolFlap(7)?.remainingMs, 1);
      tick(1);
      assert.equal(credentials.protocolFlap(7), null);
      assert.deepEqual(await speak(PINNING), new Map(), 'let go at the version it speaks');
      assert.equal(credentials.stats().withheld, 0);
      // The run's end is written, settled, so that no start can find it still going.
      assert.equal(flaps.length, 4);
      assert.deepEqual(flaps.at(-1), {
        probe_id: '7',
        version: PINNING,
        changed_ms: null,
        since_ms: null,
        run_changes: 0,
        flap_floor: null,
      });
      // And a change after it is a first change again: as it always was.
      tick(60_000);
      assert.deepEqual(await speak(PINNING - 1), all(CANNOT));
      assert.equal(credentials.protocolFlap(7), null);
    });

    it('a flap that begins with an upgrade withholds at the downgrade after it, as the version requires', async () => {
      const { credentials, speak, tick } = flapping();
      assert.deepEqual(await speak(PINNING - 1), all(CANNOT));
      tick(60_000);
      assert.deepEqual(await speak(PINNING), new Map(), 'the first change: let go');
      tick(60_000);
      // The second is a flap. Held where it stood would be sent; a probe that cannot pin is
      // never sent a set it would connect by name with.
      assert.deepEqual(await speak(PINNING - 1), all(CANNOT));
      tick(60_000);
      assert.deepEqual(await speak(PINNING), all(CANNOT), 'and from there it holds');
      assert.equal(credentials.protocolFlap(7)?.floor, PINNING - 1);
    });

    it('a flap upwards holds at the first version of it, and never sends less than that', async () => {
      const { credentials, speak, tick } = flapping();
      await speak(PINNING - 1);
      tick(60_000);
      assert.deepEqual(await speak(PINNING), new Map());
      tick(60_000);
      assert.deepEqual(await speak(PINNING + 1), new Map(), 'held at 24, which pins');
      assert.equal(credentials.protocolFlap(7)?.floor, PINNING);
      assert.equal(credentials.judgedVersion(7, PINNING + 1), PINNING);
    });

    it('holds only what a version decides: a change somebody makes in a flap is made at once', async () => {
      const { credentials, speak, tick } = flapping();
      await speak(PINNING);
      await speak(PINNING - 1);
      tick(60_000);
      assert.deepEqual(await speak(PINNING), all(CANNOT));
      // A name entry now covers sensor 1's device, and sensor 3 is no longer sent at all.
      const covered: SensorBeingSent = {
        ...leftToProbe(1),
        restrictions: new Map([
          ['snmp', { targets: ['10.20.0.0/16', '*.dc.test'], hostKeys: null }],
        ]),
      };
      const refused = await credentials.withhold(7, [covered, leftToProbe(2)], PINNING);
      assert.deepEqual(refused, new Map([[2, CANNOT]]), 'sensor 1 is sent; 2 is still held');
      assert.equal(credentials.stats().withheld, 1);
    });

    it('is what "check now" is judged at, and asks without moving anything', async () => {
      const { credentials, flaps, speak, tick } = flapping();
      assert.equal(credentials.judgedVersion(7, PINNING), PINNING, 'nothing known: as spoken');
      await speak(PINNING);
      await speak(PINNING - 1);
      tick(60_000);
      await speak(PINNING);
      const writes = flaps.length;
      assert.equal(credentials.judgedVersion(7, PINNING), PINNING - 1);
      assert.equal(credentials.judgedVersion(7, PINNING - 2), PINNING - 2, 'never above spoken');
      assert.equal(credentials.judgedVersion(8, PINNING), PINNING, 'another probe: as spoken');
      assert.equal(flaps.length, writes);
      tick(HOLD);
      assert.equal(credentials.judgedVersion(7, PINNING), PINNING);
    });

    it('records no version that is not one, and judges it as given', async () => {
      const { credentials, flaps } = flapping();
      for (const version of [0, -1, 1.5, Number.NaN]) {
        await credentials.withhold(7, [leftToProbe(1)], version);
      }
      assert.deepEqual(flaps, []);
      assert.equal(credentials.protocolFlap(7), null);
    });

    describe('counted in what the probe advertises, and never in the core’s own version', () => {
      /** Who a build is for: what the probe advertised, on a session that is live. */
      const advertising = (version: number): BuildingFor => ({
        advertisedVersion: version,
        live: () => true,
      });
      const sensors = [1, 2, 3].map(leftToProbe);

      it('a core rolled back and upgraded again, its probe unchanged, is no flap: each build is judged as its core requires, and nothing more is held', async () => {
        const { credentials, flaps, tick } = flapping();
        // The probe advertises one version newer than pinning needs, throughout. The cores it
        // meets negotiate the lower of that and their own: 24, then 23, then 24 again.
        const meet = (negotiated: number): Promise<Map<number, string>> =>
          credentials.withhold(7, sensors, negotiated, advertising(PINNING + 1));
        assert.deepEqual(await meet(PINNING), new Map());
        tick(180_000);
        assert.deepEqual(await meet(PINNING - 1), all(CANNOT), 'as the older core requires');
        tick(180_000);
        assert.deepEqual(await meet(PINNING), new Map(), 'let go at once: nothing held');
        assert.equal(credentials.protocolFlap(7), null);
        assert.equal(credentials.judgedVersion(7, PINNING), PINNING);
        assert.deepEqual(
          flaps.map((row) => [row.version, row.run_changes]),
          [[PINNING + 1, 0]],
          'one row, at the first build, and the probe’s version has not moved since',
        );
      });

      it('a probe that flaps above the core’s version is counted, and judged at no more than the core speaks', async () => {
        const { credentials, tick } = flapping();
        const as = (advertised: number, negotiated: number): Promise<Map<number, string>> =>
          credentials.withhold(7, sensors, negotiated, advertising(advertised));
        await as(PINNING + 2, PINNING);
        tick(60_000);
        await as(PINNING + 1, PINNING);
        tick(60_000);
        assert.deepEqual(await as(PINNING + 2, PINNING), new Map());
        assert.deepEqual(credentials.protocolFlap(7), {
          version: PINNING + 2,
          floor: PINNING + 1,
          changes: 2,
          sinceMs: 60_000,
          remainingMs: HOLD,
        });
        // A floor above what the pair negotiates never lifts a build above it.
        assert.equal(credentials.judgedVersion(7, PINNING - 1), PINNING - 1);
        assert.deepEqual(await as(PINNING + 2, PINNING - 1), all(CANNOT));
      });
    });

    describe('recorded only for the probe’s live session', () => {
      const sensors = [1, 2, 3].map(leftToProbe);
      /** Sessions of probe 7, of which `current` is the live one. */
      function sessions(): {
        current: { name: string };
        as: (name: string, advertised: number) => BuildingFor;
      } {
        const current = { name: 'S0' };
        return {
          current,
          as: (name, advertised) => ({
            advertisedVersion: advertised,
            live: () => current.name === name,
          }),
        };
      }

      it('a build for a superseded session that ends after its successor’s records nothing: no change, no hold, no result dropped', async () => {
        const { credentials, flaps } = flapping();
        const { current, as } = sessions();
        assert.deepEqual(
          await credentials.withhold(7, sensors, PINNING, as('S0', PINNING)),
          new Map(),
        );
        const writes = flaps.length;
        // S1 connects at 23 and its build begins. Before it ends, S2 connects at 24 and
        // supersedes it, and S2's build runs to the end first.
        current.name = 'S1';
        const stale = credentials.withhold(7, sensors, PINNING - 1, as('S1', PINNING - 1));
        current.name = 'S2';
        assert.deepEqual(
          await credentials.withhold(7, sensors, PINNING, as('S2', PINNING)),
          new Map(),
          'S2 is judged at what it speaks',
        );
        // S1's ends: its answer goes back to a caller with nobody to send it to.
        assert.deepEqual(await stale, all(CANNOT));
        // And a build of S1's that begins only now is the same.
        await credentials.withhold(7, sensors, PINNING - 1, as('S1', PINNING - 1));

        assert.equal(credentials.protocolFlap(7), null, 'no change was invented');
        assert.equal(credentials.judgedVersion(7, PINNING), PINNING);
        assert.equal(flaps.length, writes, 'nothing stored');
        assert.equal(credentials.stats().withheld, 0, 'nothing held');
        // What S2's probe reports of the sensors it was sent is taken.
        const batch = await credentials.reported(7, [measured(1, T(0))]);
        assert.equal(batch.withheldDropped.length, 0);
        assert.equal(batch.results.length, 1);
        // S2 at 24 a second time is the version it already is: still nothing.
        assert.deepEqual(
          await credentials.withhold(7, sensors, PINNING, as('S2', PINNING)),
          new Map(),
        );
        assert.equal(credentials.protocolFlap(7), null);
      });

      it('a session that closes while its record is being stored holds nothing', async () => {
        const { credentials, control } = flapping();
        const { current, as } = sessions();
        await credentials.withhold(7, sensors, PINNING, as('S0', PINNING));
        // S1 at 23 stops leaving the sensors to the probe, which is a write; it is held up.
        current.name = 'S1';
        control.stalled = 7;
        const building = credentials.withhold(7, sensors, PINNING - 1, as('S1', PINNING - 1));
        await new Promise((done) => setImmediate(done));
        current.name = 'S2';
        control.release();
        assert.deepEqual(await building, all(CANNOT));
        assert.equal(credentials.stats().withheld, 0, 'its answer is held by nobody');
        const batch = await credentials.reported(7, [measured(1, T(0))]);
        assert.equal(batch.withheldDropped.length, 0);
      });
    });

    describe('a sensor with two kinds, one of them decided by the version', () => {
      const BY_ADDRESS = { targets: ['10.20.0.0/16'], hostKeys: null };
      const BY_NAME = { targets: ['10.20.0.0/16', '*.dc.test'], hostKeys: null };
      const ELSEWHERE = { targets: ['*.other.test'], hostKeys: null };
      const both = (
        snmp: CredentialRestriction | null,
        ssh: CredentialRestriction | null,
      ): SensorBeingSent => {
        const restrictions = new Map<string, CredentialRestriction>();
        if (snmp !== null) restrictions.set('snmp', snmp);
        if (ssh !== null) restrictions.set('ssh', ssh);
        return {
          sensorId: 5,
          sensorType: 'test.snmp.ssh',
          params: { port: 161 },
          host: 'sw.dc.test',
          ipVersion: 'auto',
          owners: new Map([
            ['snmp', 900],
            ['ssh', 901],
          ]),
          restrictions,
        };
      };
      const rows: {
        name: string;
        sensor: SensorBeingSent;
        /** What it is withheld with at 24, at 23, and at 24 inside a flap that began at 24. */
        at24: string | null;
        at23: string | null;
        heldAt24: string | null;
        /** Whether the probe is left the name to check, at 24 out of any flap. */
        left: boolean;
      }[] = [
        {
          name: 'the version-dependent kind and one the core decides: the version decides',
          sensor: both(BY_ADDRESS, BY_NAME),
          at24: null,
          at23: CANNOT,
          heldAt24: CANNOT,
          left: true,
        },
        {
          name: 'the other kind outside: withheld whatever the version, in its words',
          sensor: both(BY_ADDRESS, ELSEWHERE),
          at24: WITHHELD_CREDENTIALS.outside,
          at23: WITHHELD_CREDENTIALS.outside,
          heldAt24: WITHHELD_CREDENTIALS.outside,
          left: false,
        },
        {
          name: 'the other kind nobody vouched for: withheld whatever the version',
          sensor: both(BY_ADDRESS, null),
          at24: WITHHELD_CREDENTIALS.unvouched,
          at23: WITHHELD_CREDENTIALS.unvouched,
          heldAt24: WITHHELD_CREDENTIALS.unvouched,
          left: false,
        },
        {
          name: 'both the core’s to decide: sent at any version, flap or none',
          sensor: both(BY_NAME, BY_NAME),
          at24: null,
          at23: null,
          heldAt24: null,
          left: false,
        },
      ];
      for (const row of rows) {
        it(row.name, async () => {
          const { credentials, tick, late } = flapping();
          const send = (version: number): Promise<Map<number, string>> =>
            credentials.withhold(7, [row.sensor], version);
          assert.equal((await send(PINNING)).get(5) ?? null, row.at24);
          // Left to the probe to check is what makes its refusal one it may make.
          const first = await credentials.reported(7, [refused(5, T(0))]);
          assert.equal(first.results.length === 0 && first.withheldDropped.length === 0, row.left);
          assert.equal((await send(PINNING - 1)).get(5) ?? null, row.at23);
          tick(60_000);
          assert.equal((await send(PINNING)).get(5) ?? null, row.heldAt24);
          assert.equal(credentials.protocolFlap(7)?.changes, 2);
          // And whatever it was withheld for, a result from the probe for it now is dropped.
          if (row.heldAt24 !== null) {
            tick(LATE_REFUSAL_GRACE_MS);
            const batch = await credentials.reported(7, [refused(5, T(1)), measured(5, T(2))]);
            assert.deepEqual(
              [
                batch.results.length,
                batch.withheldDropped.length,
                batch.unearned.length,
                await late(5),
              ],
              [0, 2, 0, 0],
            );
          }
        });
      }
    });

    describe('a result for a sensor the core withholds is dropped and counted, never a failed scan', () => {
      it('drops a marked one past the grace, and a reading, and keeps what is not withheld', async () => {
        const { credentials, speak, tick } = flapping();
        await speak(PINNING);
        await speak(PINNING - 1, [1, 2]);
        // Sensor 3 is no longer sent at all; 1 and 2 are withheld for the probe's version.
        tick(LATE_REFUSAL_GRACE_MS + 1);
        const batch = await credentials.reported(7, [
          refused(1, T(0)),
          { ...measured(2, T(1)), channels: [{ key: 'uptime', value: 9 }] },
          measured(3, T(2), 'error'),
          refused(3, T(3)),
        ]);
        assert.equal(batch.withheldDropped.length, 2, 'both of the sensors the core withholds');
        assert.deepEqual(
          batch.results.map((one) => [one.sensorId, one.withheld === true]),
          [
            [3, false],
            [3, false],
          ],
          'the sensor no longer sent is not withheld: its results are what they were',
        );
        assert.equal(batch.unearned.length, 1);
        assert.equal(batch.late.length, 0);
      });

      it('takes a refusal inside the grace as late, before it is a withheld sensor’s', async () => {
        const { credentials, speak } = flapping();
        await speak(PINNING);
        await speak(PINNING - 1);
        const batch = await credentials.reported(7, [refused(1, T(0)), measured(1, T(1))]);
        assert.deepEqual(
          [batch.late.length, batch.withheldDropped.length, batch.results.length],
          [1, 1, 0],
        );
      });

      it('drops for the probe that withholds it only, and holds and lets go nothing by it', async () => {
        const { credentials, speak } = flapping();
        await speak(PINNING - 1);
        await credentials.withhold(8, [1, 2, 3].map(leftToProbe), PINNING);
        const fromOther = await credentials.reported(8, [measured(1, T(0)), refused(2, T(0))]);
        assert.deepEqual([fromOther.withheldDropped.length, fromOther.results.length], [0, 1]);
        assert.equal(credentials.stats().withheld, 4, 'three withheld from 7, one 8 refused');
        const fromSeven = await credentials.reported(7, [measured(2, T(1))]);
        assert.equal(fromSeven.withheldDropped.length, 1);
        assert.equal(credentials.stats().withheld, 4, 'the probe 8 refusal is not let go by it');
      });

      it('stops dropping once the sensor is sent again', async () => {
        const { credentials, speak } = flapping();
        await speak(PINNING - 1);
        assert.equal(
          (await credentials.reported(7, [measured(1, T(0))])).withheldDropped.length,
          1,
        );
        await speak(PINNING);
        const batch = await credentials.reported(7, [measured(1, T(1))]);
        assert.deepEqual([batch.withheldDropped.length, batch.results.length], [0, 1]);
      });
    });

    describe('stored, and read back at start', () => {
      it('a core restarted in the middle of a flap still holds it, as far along as it was', async () => {
        const first = flapping();
        await first.speak(PINNING);
        await first.speak(PINNING - 1);
        first.tick(120_000);
        await first.speak(PINNING);
        assert.equal(first.credentials.protocolFlap(7)?.changes, 2);

        const second = flapping(first.table(), { stored: first.flapTable() });
        second.clock.wall = first.clock.wall + 300_000;
        const restored = await second.credentials.restore();
        assert.equal(restored.flapping, 1);
        assert.deepEqual(second.credentials.protocolFlap(7), {
          version: PINNING,
          floor: PINNING - 1,
          changes: 2,
          sinceMs: 420_000,
          remainingMs: HOLD - 300_000,
        });
        // The probe redials at the newer version, the one it spoke when the core stopped: held.
        assert.deepEqual(await second.speak(PINNING), all(CANNOT));
        assert.deepEqual(second.flaps, [], 'and the same version again writes nothing');
        // And at the older: a third change, counted on.
        second.tick(60_000);
        await second.speak(PINNING - 1);
        assert.equal(second.credentials.protocolFlap(7)?.changes, 3);
        assert.equal(second.flaps.length, 1);
      });

      it('a probe that changed its version while the core was stopped has changed', async () => {
        const first = flapping();
        await first.speak(PINNING);
        await first.speak(PINNING - 1);
        const second = flapping(first.table(), { stored: first.flapTable() });
        second.clock.wall = first.clock.wall + 60_000;
        await second.credentials.restore();
        // It comes back at the newer version: the second change, inside the hold.
        assert.deepEqual(await second.speak(PINNING), all(CANNOT));
        assert.equal(second.credentials.protocolFlap(7)?.changes, 2);
      });

      it('a flap an hour quiet is over at the start, and lets go what it held', async () => {
        const first = flapping();
        await first.speak(PINNING);
        await first.speak(PINNING - 1);
        await first.speak(PINNING);
        const second = flapping([], { stored: first.flapTable() });
        second.clock.wall = first.clock.wall + HOLD;
        assert.equal((await second.credentials.restore()).flapping, 0);
        assert.deepEqual(await second.speak(PINNING), new Map());
      });

      it('a flap the prune ended is stored ended, so a clock set back across the restart does not bring it back', async () => {
        const first = flapping();
        await first.speak(PINNING);
        await first.speak(PINNING - 1);
        first.tick(60_000);
        await first.speak(PINNING);
        first.tick(HOLD);
        await first.credentials.prune();
        assert.equal(first.credentials.protocolFlap(7), null);
        assert.deepEqual(first.flapTable(), [
          {
            probe_id: '7',
            version: PINNING,
            changed_ms: null,
            since_ms: null,
            run_changes: 0,
            flap_floor: null,
          },
        ]);

        // Restarted with the wall clock two hours behind: back before the flap began.
        for (const setBack of [HOLD / 2, 2 * HOLD]) {
          const second = flapping([], { stored: first.flapTable() });
          second.clock.wall = first.clock.wall - setBack;
          assert.equal((await second.credentials.restore()).flapping, 0);
          assert.deepEqual(await second.speak(PINNING), new Map(), 'nothing held again');
          assert.equal(second.credentials.protocolFlap(7), null);
          // And the probe's next change is a first one, as it always was.
          second.tick(60_000);
          assert.deepEqual(await second.speak(PINNING - 1), all(CANNOT));
          assert.equal(second.credentials.protocolFlap(7), null);
        }
      });

      it('a single change the prune found a hold old is stored ended too, and the next is a first change', async () => {
        const first = flapping();
        await first.speak(PINNING);
        await first.speak(PINNING - 1);
        first.tick(HOLD);
        await first.credentials.prune();
        assert.equal(first.flapTable()[0]?.run_changes, 0);
        const second = flapping([], { stored: first.flapTable() });
        second.clock.wall = first.clock.wall - HOLD;
        await second.credentials.restore();
        assert.deepEqual(await second.speak(PINNING), new Map(), 'a first change: let go');
        assert.equal(second.credentials.protocolFlap(7), null);
      });

      it('writes again a record stored ahead of the clock, and only that', async () => {
        const first = flapping();
        await first.speak(PINNING);
        await first.speak(PINNING - 1);
        await first.speak(PINNING);
        const second = flapping([], { stored: first.flapTable() });
        second.clock.wall = first.clock.wall - 600_000;
        await second.credentials.restore();
        assert.equal(second.flaps.length, 1);
        assert.equal(second.flaps[0]?.changed_ms, String(second.clock.wall));
        assert.deepEqual(second.written, [], 'nothing of the late-refusal record');
        assert.equal(second.credentials.protocolFlap(7)?.remainingMs, HOLD);
      });

      it('does not start a core that cannot read it', async () => {
        const { credentials, control } = flapping();
        control.failFlapRead = true;
        await assert.rejects(credentials.restore(), /probe_protocol_flap/);
      });

      it('writes again what a write could not, at the next configuration or within the minute', async () => {
        const { credentials, control, flaps, speak } = flapping();
        await speak(PINNING);
        control.failWrite = true;
        await speak(PINNING - 1);
        assert.equal(flaps.length, 1);
        assert.equal(credentials.stats().recordWritesGivenUp, 1);
        control.failWrite = false;
        await credentials.prune();
        assert.deepEqual(
          flaps.map((row) => row.version),
          [PINNING, PINNING - 1],
        );
        await credentials.prune();
        assert.equal(flaps.length, 2, 'and once it has landed, not again');
      });

      it('drops the record of a probe that is gone, and does not write it again', async () => {
        const { credentials, control, flaps, speak } = flapping();
        control.gone.add(7);
        await speak(PINNING);
        assert.equal(flaps.length, 1);
        await credentials.prune();
        await speak(PINNING);
        assert.equal(flaps.length, 2, 'the next build begins it again, once');
      });
    });

    describe('when it is over, whoever builds configurations is told, once', () => {
      it('at the first prune after the version has held an hour, and not before', async () => {
        const told: number[][] = [];
        const { credentials, speak, tick } = flapping([], {
          onOver: (probeIds) => told.push([...probeIds]),
        });
        await speak(PINNING);
        await speak(PINNING - 1);
        tick(60_000);
        await speak(PINNING);
        await credentials.prune();
        tick(HOLD - 1);
        await credentials.prune();
        assert.deepEqual(told, []);
        tick(1);
        await credentials.prune();
        assert.deepEqual(told, [[7]]);
        await credentials.prune();
        assert.deepEqual(told, [[7]], 'once');
        assert.deepEqual(await speak(PINNING), new Map());
      });

      it('says nothing for a flap a configuration already found over', async () => {
        const told: number[][] = [];
        const { credentials, speak, tick } = flapping([], {
          onOver: (probeIds) => told.push([...probeIds]),
        });
        await speak(PINNING);
        await speak(PINNING - 1);
        await speak(PINNING);
        tick(HOLD);
        await speak(PINNING);
        await credentials.prune();
        assert.deepEqual(told, []);
      });

      it('keeps pruning when whoever is told throws', async () => {
        const { credentials, control, flaps, speak, tick, logged } = flapping([], {
          onOver: () => {
            throw new Error('no endpoint');
          },
        });
        await speak(PINNING);
        await speak(PINNING - 1);
        control.failWrite = true;
        await speak(PINNING);
        control.failWrite = false;
        tick(HOLD);
        await credentials.prune();
        assert.equal(flaps.at(-1)?.version, PINNING, 'the write it owed is made');
        assert.ok(logged.some((line) => line.level === ERROR && /flap is over/.test(line.msg)));
      });
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

    const gate = catalogueSensorTypeGate(testCatalogue([snmpPinned, dbQuery, dbPinned, sshLoad]));
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
        types: [snmpPinned, dbQuery, dbPinned, sshLoad],
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
        // The cases here ask as whichever probe version they need of one probe, one after another,
        // which is not a probe reconnecting: no flap is held (`A-72`). The scenarios of `A-72`
        // build cores of their own with the hold as it ships.
        protocolFlapHoldMs: 0,
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

    it('a database set reaches a named device through a probe at 27, and no older one (A-62)', async () => {
      const DATABASE = versionFor('databaseAddressPinning');
      const group = await create({ kind: 'group', parentId: site, name: 'databases' });
      const device = await create({
        kind: 'device',
        parentId: group,
        name: 'named database',
        host: 'db.gate.test',
      });
      const query = await create({
        kind: 'sensor',
        parentId: device,
        name: 'pinned query',
        sensorType: 'test.db.pinned',
        params: { port: 5432 },
      });
      // The write counts nothing: whether the name resolves inside is the probe's to find out.
      const written = await h.service.setCredential(testActor, group, 'database', {
        username: 'monitor',
        password: 'pinned-password',
        allowedTargets: ['10.20.0.0/16'],
      });
      assert.equal(written.withholds, 0);
      assert.equal(written.byReason.unpinnable.withholds, 0);

      // A probe at 27 is sent it, with the targets it has to check the name against.
      const sent = (await config.assignmentsFor(site, DATABASE)).sensors.find(
        (one) => one.sensorId === query,
      );
      assert.ok(sent !== undefined, 'the database sensor is sent to a probe at 27');
      assert.deepEqual(sent.target, { host: 'db.gate.test', ipVersion: 'auto' });
      assert.deepEqual(sent.credentials?.['database']?.['allowedTargets'], ['10.20.0.0/16']);
      assert.equal(sent.credentials['database']['password'], 'pinned-password');
      assert.equal(vouching.withheld().has(query), false);

      // A probe that pins the other kinds, and whose database drivers still resolve the name
      // themselves, is not: it would connect by name.
      for (const older of [DATABASE - 1, PINNING, PINNING - 1, 3]) {
        assert.equal(await sentTo(older, query), false, `protocol ${String(older)}`);
        assert.deepEqual(await stateOf(query), {
          state: 'unknown',
          message: WITHHELD_CREDENTIALS.probeCannotPinDatabase,
        });
      }
      assert.equal(await sentTo(DATABASE, query), true);
      assert.equal(vouching.withheld().has(query), false);

      // "Check now" is held to the same rule, against the probe on the line.
      await assert.rejects(
        config.assignmentFor(query, () => DATABASE - 1),
        (error: unknown) =>
          error instanceof ObjectError &&
          error.message === WITHHELD_CREDENTIALS.probeCannotPinDatabase,
      );
      assert.deepEqual(await config.assignmentFor(query), {
        probeObjectId: site,
        peerVersion: 0,
        assignment: null,
      });
      const found = await config.assignmentFor(query, () => DATABASE);
      assert.equal(found?.peerVersion, DATABASE);
      assert.equal(found.assignment?.credentials?.['database']?.['password'], 'pinned-password');

      // A refusal the probe then makes is believed, as for the kinds it pinned before: the
      // sensor is one the last configuration left to it.
      await config.assignmentsFor(site, DATABASE);
      const sentence =
        'Not scanned: db.gate.test resolves to 192.0.2.7, which is outside the allowed targets ' +
        'of the database credentials it would use, so they are not sent.';
      await fromProbe([refused(query, new Date().toISOString(), sentence)]);
      assert.deepEqual(await stateOf(query), { state: 'unknown', message: sentence });
      assert.equal(await downs([query]), 0, 'a refused check is not a failed scan');
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

    describe('a SQL Server redirect outside a bounded set, on a device the core decided itself (A-70)', () => {
      const DATABASE = versionFor('databaseAddressPinning');
      /** A database sensor on a device given as an address inside its set's targets, and Up. */
      async function addressed(name: string, host: string): Promise<number> {
        const group = await create({ kind: 'group', parentId: site, name: `${name} group` });
        await h.service.setCredential(testActor, group, 'database', {
          username: 'monitor',
          password: `${name}-password`,
          allowedTargets: ['10.20.0.0/16'],
        });
        const device = await create({ kind: 'device', parentId: group, name, host });
        const sensor = await create({
          kind: 'sensor',
          parentId: device,
          name: `${name} query`,
          sensorType: 'test.db.pinned',
          params: { port: 1433 },
        });
        // Sent to its probe with the set, and the core decided that itself: the address is
        // inside the targets, so there was no name to leave for the probe to check.
        assert.equal(await sentTo(DATABASE, sensor), true);
        await fromProbe([{ ...measured(sensor, at(-60)), message: '1 row in 3 ms' }]);
        assert.deepEqual(await stateOf(sensor), { state: 'up', message: '1 row in 3 ms' });
        return sensor;
      }

      it('marked as withheld it is a failed scan the core counts against the probe: what a probe did before', async () => {
        // The probe refused to follow the redirect and sent the routed server nothing, which
        // is right. It then marked the result `withheld`, as it does a pinned set's refusal.
        // The core believes that mark only for a sensor its configuration left to the probe,
        // and this one it did not: the mark is unearned, the result is the failed scan it is
        // without it, and Probe Health's refused results count an honest probe as one that
        // hides failures.
        const sensor = await addressed('routed-before', '10.20.0.41');
        const marked =
          'Not scanned: 10.20.0.41 handed the connection on to replica.elsewhere.test, which ' +
          'the allowed targets of the database credentials it would use do not cover, so they ' +
          'are not sent there.';
        const refusals = new ProbeRefusals();
        await fromProbe(
          [refused(sensor, at(-4), marked), refused(sensor, at(-3), marked)],
          site,
          refusals,
        );
        assert.deepEqual(await stateOf(sensor), { state: 'down', message: marked });
        assert.equal(vouching.withheld().has(sensor), false, 'not held Unknown: not believed');
        assert.equal(refusals.countsFor(site).refused, 2, 'and counted as unearned, each scan');
      });

      // `P-295`: a batch whose acknowledgement was lost is sent again, and its unearned marks
      // were counted again with it. One ingestion service, as the running core has: what it
      // remembers is what counts a result once.
      it('counts an unearned mark once when the acknowledgement was lost and the batch comes again', async () => {
        const sensor = await addressed('routed-again', '10.20.0.43');
        const marked = 'Not scanned: 10.20.0.43 handed the connection on to elsewhere.test.';
        const refusals = new ProbeRefusals();
        const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms: engine });
        try {
          const ingestion = new IngestionService({
            db,
            logger: silent,
            ingestor,
            credentialRefusals: credentials,
            refusals,
            ...(h.states === undefined ? {} : { states: h.states }),
          });
          const origin = { gid: `gid-${String(site)}`, probeObjectId: site };
          const spooled = [refused(sensor, at(-4), marked)];
          const first = await ingestion.acceptProbeResults(origin, {
            type: 'results',
            batchId: 'unearned-1',
            results: spooled,
          });
          assert.equal(first.type, 'results-ack');
          assert.equal(refusals.countsFor(site).refused, 1);
          // The acknowledgement was lost: the same result again, under a new send's id, with
          // one more queued since.
          const again = await ingestion.acceptProbeResults(origin, {
            type: 'results',
            batchId: 'unearned-2',
            results: [...spooled, refused(sensor, at(-3), marked)],
          });
          assert.equal(again.type, 'results-ack');
          assert.equal(refusals.countsFor(site).refused, 2, 'the one sent again counted once');
        } finally {
          await ingestor.stop();
        }
      });

      it('said as the failed check it is: one Down, one page, the sentence, and nothing counted against the probe', async () => {
        const sensor = await addressed('routed', '10.20.0.42');
        // What the probe says now: an ordinary error, unmarked, in the redirect's own words.
        const sentence = REDIRECT_OUTSIDE_TARGETS('10.20.0.42', 'replica.elsewhere.test');
        assert.match(
          sentence,
          /^10\.20\.0\.42 routed the login to replica\.elsewhere\.test, which is outside the allowed targets of the database credentials this sensor uses, so nothing was sent there\./,
        );
        const failed = (seconds: number): CheckResult => ({
          ...measured(sensor, at(seconds), 'error'),
          message: sentence,
        });
        // The pages this sensor is owed, and the messages that name it: the triggers are at
        // the root, and the tests before this one left sensors of their own to page about.
        const owed = (): Promise<{ reason: string; kind: string }[]> =>
          db.query<{ reason: string; kind: string }>(
            `SELECT reason, trigger_kind AS kind FROM notification_request
             WHERE sensor_id = $1 ORDER BY id`,
            [sensor],
          );
        const naming = (): number =>
          seen.filter((message) => message.about.includes(sensor)).length;
        await scheduler.sweep(later(3_600));
        assert.deepEqual(await owed(), [], 'nothing owed for a sensor that is Up');
        const held = credentials.stats().withheld;
        seen.length = 0;
        const refusals = new ProbeRefusals();

        // Two scans, as the state machine asks before it calls a sensor Down.
        const reply = await fromProbe([failed(-4), failed(-3)], site, refusals);
        assert.equal((reply as { type: string }).type, 'results-ack');
        assert.deepEqual(await stateOf(sensor), { state: 'down', message: sentence });
        assert.equal(await downs([sensor]), 1, 'Down once');
        assert.equal(vouching.withheld().has(sensor), false);
        assert.equal(credentials.stats().withheld, held, 'nothing is held for it');
        assert.equal(refusals.countsFor(site).refused, 0, 'an honest probe is counted nothing');
        assert.equal(refusals.lateFor(site), 0);

        // One page, from the Down trigger, and none from the Unknown one.
        await scheduler.sweep(later(4_000));
        assert.deepEqual(await owed(), [{ reason: 'initial', kind: 'state' }]);
        // The digest's window opens at the first dispatch and is sent at one after it closes.
        await drain(later(4_001));
        await drain(later(4_300));
        assert.equal(naming(), 1, 'one message names it');

        // The server goes on routing the login there: every scan after is the same Down.
        await fromProbe([failed(-2), failed(-1)], site, refusals);
        assert.deepEqual(await stateOf(sensor), { state: 'down', message: sentence });
        assert.equal(await downs([sensor]), 1, 'still the one Down');
        await scheduler.sweep(later(4_600));
        assert.equal((await owed()).length, 1, 'and nothing more to page about');
        await drain(later(4_601));
        await drain(later(4_900));
        assert.equal(naming(), 1);
        assert.equal(refusals.countsFor(site).refused, 0);

        // The targets are widened to cover the routed server, the login goes through, and the
        // sensor is Up at the scan that found out.
        await fromProbe([{ ...measured(sensor, at(0)), message: '1 row in 4 ms' }], site, refusals);
        assert.deepEqual(await stateOf(sensor), { state: 'up', message: '1 row in 4 ms' });
      });
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

    it('gives way to a transaction that holds a row it needs: the configuration goes out, the other commits, and the record is stored after (A-61)', async () => {
      const doomed = await named(site, 'doomed');
      assert.equal(await sentTo(PINNING, doomed.sensor), true);
      // New, and in no configuration yet: its row is still to be written (`A-68`), which is the
      // write that needs a lock on the sensor's own row.
      const kept = await named(site, 'contended');
      const rows = (sensorId: number): Promise<number> =>
        count('SELECT count(*)::text AS n FROM late_refusal_grace WHERE sensor_id = $1', [
          sensorId,
        ]);
      const point = (device: number, host: string): Promise<unknown> =>
        h.service.update(testActor, device, { kind: 'device', host }, { kind: 'none' });
      /** How long a configuration for the probe took to come back. */
      const build = async (sensorId: number): Promise<number> => {
        const started = performance.now();
        assert.equal(await sentTo(PINNING, sensorId), true, 'the configuration is still returned');
        return performance.now() - started;
      };
      const givenUp = credentials.stats().recordWritesGivenUp;
      // The pool counts neither give-way: this write counts its own, and the pool's counts warn
      // on Core Health, where a delete of a group would raise a warning for nothing (`P-229`).
      const pool = db.timeouts();

      // Another connection holds the sensor's row, as an update of it would. The write needs a
      // key-share lock on that row, waits its 300 ms for it, and gives up.
      await db.tx(async (other) => {
        await other.query('SELECT 1 FROM object WHERE id = $1 FOR UPDATE', [kept.sensor]);
        const waited = await build(kept.sensor);
        assert.ok(waited >= LATE_REFUSAL_SAVE_LOCK_MS - 50, `it waited ${String(waited)} ms`);
        assert.ok(waited < 1_500, `inside its bound, and it took ${String(waited)} ms`);
        assert.equal(await rows(kept.sensor), 0, 'not stored while the row is held');
      });
      // Counted, where Core Health reads it (`A-68`).
      assert.equal(credentials.stats().recordWritesGivenUp, givenUp + 1);
      // The next build stores it.
      await build(kept.sensor);
      assert.equal(await rows(kept.sensor), 1);
      assert.equal(credentials.stats().recordWritesGivenUp, givenUp + 1, 'made again, and landed');

      // The same against a delete, which is the one that could deadlock: it takes the sensor's
      // row first and cascades into the table. The write gives up, and the delete commits.
      await point(doomed.device, '10.20.0.62');
      await db.tx(async (other) => {
        await other.query('DELETE FROM object WHERE id = $1', [doomed.sensor]);
        const waited = await build(kept.sensor);
        assert.ok(waited >= LATE_REFUSAL_SAVE_LOCK_MS - 50, `it waited ${String(waited)} ms`);
        assert.ok(waited < 1_500, `inside its bound, and it took ${String(waited)} ms`);
      });
      assert.equal(
        await count('SELECT count(*)::text AS n FROM object WHERE id = $1', [doomed.sensor]),
        0,
        'the delete was not the one aborted',
      );
      assert.equal(credentials.stats().recordWritesGivenUp, givenUp + 2);
      assert.deepEqual(db.timeouts(), pool, 'the write’s give-ways are not the pool’s count');
      // And the write is made again, for what is left: no row for a sensor that is gone.
      await credentials.prune();
      assert.equal(await rows(doomed.sensor), 0);
      assert.equal(await rows(kept.sensor), 1);
      const quick = await build(kept.sensor);
      assert.ok(quick < LATE_REFUSAL_SAVE_LOCK_MS, `nothing left to wait for: ${String(quick)} ms`);
    });

    it('stores which sensors a configuration stopped leaving to the probe, and reads them back by the clock it is started at (A-61)', async () => {
      const { device, sensor } = await named(site, 'stored');
      /** The sensor's window, where it has one: a row with a time. */
      const row = async (): Promise<{ probe: number; ageMs: number; left: number | null }[]> =>
        (
          await db.query<{ probe_id: string; stopped_ms: string; left_version: number | null }>(
            `SELECT probe_id::text AS probe_id,
                    (extract(epoch FROM stopped_at) * 1000)::float8::text AS stopped_ms,
                    left_version
             FROM late_refusal_grace WHERE sensor_id = $1 AND stopped_at IS NOT NULL`,
            [sensor],
          )
        ).map((one) => ({
          probe: Number(one.probe_id),
          ageMs: Date.now() - Number(one.stopped_ms),
          left: one.left_version,
        }));
      /** What the table says the probe's last configuration left it this sensor under. */
      const leftUnder = async (): Promise<(number | null)[]> =>
        (
          await db.query<{ left_version: number | null }>(
            'SELECT left_version FROM late_refusal_grace WHERE sensor_id = $1',
            [sensor],
          )
        ).map((one) => one.left_version);
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

      // Left to the probe: no window is recorded, and that it is left is, with the version.
      assert.deepEqual(await leftUnder(), []);
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.deepEqual(await row(), []);
      assert.deepEqual(await leftUnder(), [PINNING]);

      // Given an address inside the targets, the core decides it: no longer the probe's.
      await point('10.20.0.60');
      assert.equal(await sentTo(PINNING, sensor), true);
      const [first] = await row();
      assert.equal(first?.probe, site);
      assert.equal(first.left, null, 'no longer left');
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

      // Named again, it is the probe's to check. The row says so, and keeps its time: the
      // window is remembered for the hour (`A-68`).
      await point('stored.dc.test');
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.deepEqual(await leftUnder(), [PINNING]);
      // The same moment, written again from the clock that counts it: to the millisecond.
      const moved = Date.parse(String(await stamp())) - Date.parse(String(written));
      assert.ok(Math.abs(moved) <= 5, `it moved ${String(moved)} ms`);

      await point('10.20.0.60');
      assert.equal(await sentTo(PINNING, sensor), true);
      assert.equal((await row()).length, 1);
      assert.deepEqual(await leftUnder(), [null]);

      // A core started with its clock two hours behind the one that wrote the row: the time is
      // ahead of it. It is given the grace from that start, and the row is written down again
      // as that clock's now, so the next start counts from there.
      const behind = await restarted(() => Date.now() - 7_200_000).restore();
      assert.ok(behind.ahead >= 1 && behind.spent === 0, JSON.stringify(behind));
      const [setBack] = await row();
      assert.ok(
        setBack !== undefined && near(setBack.ageMs, 7_200_000),
        `rewritten as two hours ago by this clock, and it reads ${String(setBack?.ageMs)} ms old`,
      );

      // And a core started by the right clock finds a time two hours old: past its grace and
      // its cool-off, spent, and removed.
      const later = await restarted().restore();
      assert.ok(later.spent >= 1 && later.ahead === 0, JSON.stringify(later));
      assert.deepEqual(await row(), []);
    });

    // `P-299`: a late refusal (`A-53`) and a result for a withheld sensor (`A-72`) were counted
    // on every arrival, so a batch sent again after a lost acknowledgement counted them twice.
    // One ingestion service, as the running core has: what it remembers counts a result once.
    it('counts a late refusal and a result for a withheld sensor once when the acknowledgement was lost and the batch comes again (P-299)', async () => {
      const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'resends' });
      const late = await named(probe, 'resent-late');
      const dropped = await named(probe, 'resent-withheld');
      assert.equal(await sentTo(PINNING, late.sensor, probe), true);
      assert.equal(await sentTo(PINNING, dropped.sensor, probe), true);
      // The probe comes back too old to pin: both are withheld from it now, and what the
      // configuration before left it is inside its grace.
      assert.equal(await sentTo(PINNING - 1, late.sensor, probe), false);
      const refusals = new ProbeRefusals();
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms: engine });
      try {
        const ingestion = new IngestionService({
          db,
          logger: silent,
          ingestor,
          credentialRefusals: credentials,
          refusals,
          ...(h.states === undefined ? {} : { states: h.states }),
        });
        const origin = { gid: `gid-${String(probe)}`, probeObjectId: probe };
        const reading = (seconds: number): CheckResult => ({
          ...measured(dropped.sensor, at(seconds)),
          message: 'up 1 d',
        });
        const spooled = [refused(late.sensor, at(-30)), reading(-30)];
        const first = await ingestion.acceptProbeResults(origin, {
          type: 'results',
          batchId: 'resent-1',
          results: [...spooled],
        });
        assert.equal(first.type, 'results-ack');
        assert.equal(refusals.lateFor(probe), 1);
        assert.equal(refusals.withheldFor(probe), 1);

        // The acknowledgement was lost: the same results again, under a new send's id, with one
        // more of each queued since.
        const again = await ingestion.acceptProbeResults(origin, {
          type: 'results',
          batchId: 'resent-2',
          results: [...spooled, refused(late.sensor, at(-20)), reading(-20)],
        });
        assert.equal(again.type, 'results-ack');
        assert.equal(refusals.lateFor(probe), 2, 'the one sent again counted once');
        assert.equal(refusals.withheldFor(probe), 2, 'and the one queued since counted');
        assert.equal(refusals.countsFor(probe).refused, 0, 'nothing refused from the probe');
        const stats = ingestion.stats();
        assert.equal(stats.resultsReceived, 6, 'received is every arrival');
        assert.equal(stats.resultsRemembered, 4);
      } finally {
        await ingestor.stop();
      }
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
        count(
          `SELECT count(*)::text AS n FROM late_refusal_grace
           WHERE sensor_id = $1 AND stopped_at IS NOT NULL`,
          [sensor],
        );
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
        protocolFlapHoldMs: 0,
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

        // And the time does not outlive its grace and the cool-off after it (`A-68`), with no
        // configuration to take it away.
        assert.equal(await stored(), 1);
        await credentials.prune();
        assert.equal(await stored(), 1, 'remembered, for the rest of the hour');
        ahead.ms += LATE_REFUSAL_COOL_OFF_MS;
        await credentials.prune();
        assert.equal(await stored(), 0);
      } finally {
        ({ credentials, config } = running);
      }
    });

    // ---- `A-68`: what a probe can do by the version it announces, and what a restart loses ----

    /** The notifications asked for about one sensor, by what each is for. */
    const paged = async (sensorId: number): Promise<string[]> =>
      (
        await db.query<{ what: string }>(
          `SELECT r.reason::text || ':' || coalesce(t.settings->>'state', '?') AS what
           FROM notification_request r
           LEFT JOIN notification_trigger t ON t.id = r.trigger_id
           WHERE r.sensor_id = $1 ORDER BY r.id`,
          [sensorId],
        )
      ).map((row) => row.what);

    /** A core started on the same database, with nothing of what the one before held in memory. */
    function restartedCore(
      wallNow?: () => number,
      /** The flap hold (`A-72`): as it ships unless a case says otherwise. */
      protocolFlapHoldMs = PROTOCOL_FLAP_HOLD_MS,
    ): {
      credentials: CredentialVouching;
      config: ProbeConfigService;
    } {
      const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      const fresh = new CredentialVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        rights: (principal, objectIds, q) => access.resolveManyFor(principal, objectIds, q),
        vouching,
        now: () => performance.now() + ahead.ms,
        ...(wallNow === undefined ? {} : { wallNow }),
        protocolFlapHoldMs,
      });
      return {
        credentials: fresh,
        config: new ProbeConfigService({
          db,
          resolver: new InheritanceResolver({ db, logger: silent }),
          vault: h.vault,
          credentialKindsFor: (sensorType) => gate.credentialKinds(sensorType),
          credentialCheck: fresh,
        }),
      };
    }

    /** A link that is up and speaks `version`, for a Probe Health read of it. */
    const linkAt = (version: number): ProbeLink => {
      const now = new Date();
      return {
        connected: true,
        gid: 'flapping',
        clockOffsetMs: null,
        protocolVersion: version,
        connectedAt: now,
        lastHeartbeatAt: now,
        approved: true,
        agentVersion: '1.0.0',
        assignedSensors: 1,
        cadenceSeconds: 60,
        connectedForMs: 60_000,
        sinceResultsMs: 0,
        sinceConfigMs: 0,
        configured: true,
        configurable: true,
        lastResultsAt: now,
        configSentAt: now,
      };
    };

    it('a probe that alternates its protocol version five times pages once for each named sensor, recovers once an hour after it holds, and its results for a withheld sensor raise nothing (A-72)', async () => {
      // `A-68`'s scenario, under the flap hold as it ships. Three probes, each with one named
      // sensor. `steady` is downgraded once, and upgraded thirteen minutes later. The other two
      // go down, up, down, up, down: five changes in twelve minutes, and up at thirteen.
      // `flapping` sends marked refusals whenever it is at the older version, as `steady` does;
      // `quiet` sends none. `unheld` alternates as `quiet` does on a core with no hold: what
      // `A-68` measured, three Unknown pages and two recoveries, kept beside it to compare.
      const running = { credentials, config };
      ({ credentials, config } = restartedCore());
      const unheld = restartedCore(undefined, 0);
      try {
        type One = { probe: number; sensor: number };
        const probes: Record<'steady' | 'flapping' | 'quiet' | 'unheld', One> = {
          steady: { probe: 0, sensor: 0 },
          flapping: { probe: 0, sensor: 0 },
          quiet: { probe: 0, sensor: 0 },
          unheld: { probe: 0, sensor: 0 },
        };
        const configOf = (one: One): ProbeConfigService =>
          one === probes.unheld ? unheld.config : config;
        const sentAt = async (version: number, one: One): Promise<boolean> =>
          (await configOf(one).assignmentsFor(one.probe, version)).sensors.some(
            (sent) => sent.sensorId === one.sensor,
          );
        for (const name of ['steady', 'flapping', 'quiet', 'unheld'] as const) {
          const probe = await create({ kind: 'probe', parentId: h.rootId, name: `${name} a72` });
          const { sensor } = await named(probe, `${name}-a72`);
          probes[name] = { probe, sensor };
          assert.equal(await sentAt(PINNING, probes[name]), true);
          await fromProbe([{ ...measured(sensor, at(-90)), message: 'up 1 d' }], probe);
          assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });
        }
        const { steady, flapping, quiet } = probes;
        const four = Object.values(probes);
        const refusals = new ProbeRefusals();
        await scheduler.sweep(later(3_600));
        for (const one of four) assert.deepEqual(await paged(one.sensor), []);

        /** Each probe reconnects under `version`: whether its sensor is sent, as expected. */
        const speak = async (version: number, sent: boolean, ...which: One[]): Promise<void> => {
          for (const one of which) {
            const expected = one === probes.unheld ? version >= PINNING : sent;
            assert.equal(
              await sentAt(version, one),
              expected,
              `${String(one.probe)} at ${String(version)}`,
            );
          }
          await scheduler.sweep(later(3_600));
        };
        /** Two marked refusals from a probe, which are what two failed scans would be. */
        const mark = (one: One, seconds: number): Promise<unknown> =>
          fromProbe(
            [refused(one.sensor, at(seconds)), refused(one.sensor, at(seconds + 1))],
            one.probe,
            refusals,
          );
        const withheld = { state: 'unknown', message: WITHHELD_CREDENTIALS.probeCannotPin };
        const health = (
          one: One,
          version: number,
        ): { reading: Record<string, number | null>; message: string } => {
          const service = new ProbeHealthService({
            db,
            logger: silent,
            vouching: everyVoucherHolds,
            sources: {
              link: () => linkAt(version),
              protocolFlap: (probeId) => credentials.protocolFlap(probeId),
              withheldResults: (probeId) => refusals.withheldFor(probeId),
            },
            ingest: () => Promise.resolve(),
          });
          return service.read(one.probe);
        };

        // Minute 0: all four reconnect under the older version. As it always was: withheld.
        await speak(PINNING - 1, false, ...four);
        await mark(steady, -80);
        await mark(flapping, -80);
        for (const one of four) assert.deepEqual(await stateOf(one.sensor), withheld);
        assert.equal(health(flapping, PINNING - 1).reading['protocolFlap'], 0, 'one change');
        // Minute 3: up, which is the second change inside the hour: held where it stood.
        ahead.ms += 180_000;
        await speak(PINNING, false, flapping, quiet, probes.unheld);
        const flap = health(flapping, PINNING);
        assert.equal(flap.reading['protocolFlap'], 2);
        // Three minutes and the test's own time, rounded up to whole minutes.
        assert.match(
          flap.message,
          /its protocol version changed 2 times in [34] minutes and is 24 now, so the sensors its version decides hold where they stood, as at protocol 23, until it has held one version for an hour \(60 minutes from now if it holds\)/,
        );
        // Minute 6: down again, inside the window the first downgrade began.
        ahead.ms += 180_000;
        await speak(PINNING - 1, false, flapping, quiet, probes.unheld);
        await mark(steady, -70);
        await mark(flapping, -70);
        assert.equal(refusals.lateFor(flapping.probe), 4, 'late for what is left of the window');
        assert.equal(refusals.lateFor(steady.probe), 4);
        // Minute 9: up. Minute 12: down a third time, two minutes after the window ran out.
        ahead.ms += 180_000;
        await speak(PINNING, false, flapping, quiet, probes.unheld);
        ahead.ms += 180_000;
        await speak(PINNING - 1, false, flapping, quiet, probes.unheld);
        await mark(steady, -60);
        await mark(flapping, -60);

        // Past the window, and for a sensor the core is withholding: dropped and counted on
        // Probe Health, where `A-68` took them as failed scans, for the probe downgraded once as
        // for the one that alternates.
        for (const one of [steady, flapping]) {
          assert.equal(refusals.lateFor(one.probe), 4);
          assert.equal(refusals.withheldFor(one.probe), 2);
          assert.equal(refusals.countsFor(one.probe).refused, 0);
        }
        assert.equal(health(flapping, PINNING - 1).reading['resultsWithheld'], 2);
        assert.equal(health(flapping, PINNING - 1).reading['protocolFlap'], 5);
        assert.equal(health(steady, PINNING - 1).reading['protocolFlap'], 0);
        assert.equal(await downs(four.map((one) => one.sensor)), 0);
        for (const one of four) assert.deepEqual(await stateOf(one.sensor), withheld);

        // One Unknown page for each held sensor, whatever the probe did after its first
        // downgrade, and the three and two the core with no hold raised.
        for (const one of [steady, flapping, quiet]) {
          assert.deepEqual(await paged(one.sensor), ['initial:unknown']);
        }
        const flapped = [
          'initial:unknown',
          'recovery:unknown',
          'initial:unknown',
          'recovery:unknown',
          'initial:unknown',
        ];
        assert.deepEqual(await paged(probes.unheld.sensor), flapped);

        // Minute 13: all four come back at the newer version. For `steady` that is its second
        // change inside the hour too: a flap, held. Nothing moves, nothing is paged.
        ahead.ms += 60_000;
        await speak(PINNING, false, ...four);
        assert.equal(health(steady, PINNING).reading['protocolFlap'], 2);
        for (const one of [steady, flapping, quiet]) {
          assert.deepEqual(await stateOf(one.sensor), withheld);
          assert.deepEqual(await paged(one.sensor), ['initial:unknown']);
        }
        assert.deepEqual(await paged(probes.unheld.sensor), [...flapped, 'recovery:unknown']);

        // An hour on, the version has held. The flap is over: the sensors are let go, each from
        // the state it stood in before it was held, which is Up, and each with the one recovery.
        // No Down for any: what was dropped while they were held is not a failed scan. (A sensor
        // the core lets go is re-decided in no words until its next scan, as every release of
        // `A-29`'s set is: what `A-68` saw as a Down with no message is that, over two failed
        // scans that are now dropped.)
        ahead.ms += PROTOCOL_FLAP_HOLD_MS;
        for (const one of [steady, flapping, quiet]) {
          assert.equal(credentials.protocolFlap(one.probe), null);
        }
        await speak(PINNING, true, steady, flapping, quiet);
        for (const one of [steady, flapping, quiet]) {
          assert.deepEqual(await stateOf(one.sensor), { state: 'up', message: '' });
          assert.deepEqual(await paged(one.sensor), ['initial:unknown', 'recovery:unknown']);
        }
        // And its next scan says what it is, in its own words.
        await fromProbe([{ ...measured(steady.sensor, at(0)), message: 'up 2 d' }], steady.probe);
        assert.deepEqual(await stateOf(steady.sensor), { state: 'up', message: 'up 2 d' });
        assert.equal(await downs(four.map((one) => one.sensor)), 0);
        assert.equal(health(flapping, PINNING).reading['protocolFlap'], 0);
      } finally {
        ({ credentials, config } = running);
      }
    });

    it('a probe whose version flaps between the core’s and the one before raises one Probe Health warning, cleared once it has held an hour (A-72)', async () => {
      // The newer of the two is the core's own, so that a probe speaking it has no skew and the
      // warning there is the flap's; the older is below the one a database set needs, so that
      // the query is withheld there. Two versions apart since 28 (`A-64`) added one above 27.
      const DATABASE = versionFor('databaseAddressPinning');
      const CORE = PROTOCOL_VERSION;
      assert.ok(DATABASE <= CORE, 'the core’s own version pins a database set');
      const running = { credentials, config };
      ({ credentials, config } = restartedCore());
      const lookups = await loadLookups({ logger: silent });
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG, alarms: engine });
      try {
        const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'flaps a database' });
        const group = await create({ kind: 'group', parentId: probe, name: 'flapping databases' });
        await h.service.setCredential(testActor, group, 'database', {
          username: 'monitor',
          password: 'flap-password',
          allowedTargets: ['10.20.0.0/16'],
        });
        const device = await create({
          kind: 'device',
          parentId: group,
          name: 'flapping database',
          host: 'db.flap.test',
        });
        const query = await create({
          kind: 'sensor',
          parentId: device,
          name: 'flapping query',
          sensorType: 'test.db.pinned',
          params: { port: 5432 },
        });
        const watch = await create({
          kind: 'sensor',
          parentId: device,
          name: 'flapping probe health',
          sensorType: 'ms.probe.health',
          params: {},
        });
        const states = h.states ?? assert.fail('no state service');
        const refusals = new ProbeRefusals();
        const ingestion = new IngestionService({
          db,
          logger: silent,
          ingestor,
          states,
          resolver: new ChannelResolver({ logger: silent, lookups }),
          refusals,
        });
        let speaking = CORE;
        let sweeps = 0;
        // Stamped a second apart, behind the core's clock, so each is newer than the last.
        const base = Date.now() - 600_000;
        const service = new ProbeHealthService({
          db,
          logger: silent,
          vouching: everyVoucherHolds,
          sources: {
            link: () => linkAt(speaking),
            protocolFlap: (probeId) => credentials.protocolFlap(probeId),
            withheldResults: (probeId) => refusals.withheldFor(probeId),
          },
          ingest: async (results) => {
            await ingestion.acceptResults(IN_PROCESS_SOURCE.probeHealth, {
              type: 'results',
              batchId: `a72-health-${String(sweeps)}`,
              results: [...results],
            });
          },
          now: () => new Date(base + sweeps * 1_000),
        });
        /** The probe reconnects under `version`, and Probe Health is swept. */
        const speak = async (version: number): Promise<boolean> => {
          speaking = version;
          const sent = await sentTo(version, query, probe);
          sweeps += 1;
          await service.sweep();
          await scheduler.sweep(later(3_600));
          return sent;
        };
        const warnings = (): Promise<number> =>
          count(
            `SELECT count(*)::text AS n FROM sensor_state
             WHERE sensor_id = $1 AND state::text = 'warning'
               AND (previous_state IS NULL OR previous_state::text <> 'warning')`,
            [watch],
          );
        const healthState = async (): Promise<string> => (await stateOf(watch)).state;

        assert.equal(await speak(CORE), true);
        await fromProbe([{ ...measured(query, at(-90)), message: '1 row in 3 ms' }], probe);
        assert.equal(await healthState(), 'up');

        // The first downgrade: the query is withheld, and Probe Health warns that the probe is
        // older than the core, as it always did.
        assert.equal(await speak(DATABASE - 1), false);
        assert.equal(await healthState(), 'warning');
        assert.equal(await warnings(), 1);
        // Four more changes, three minutes apart: the query stays held, and Probe Health stays
        // in the one warning, now naming the flap, at the core's version as at the older.
        for (const version of [CORE, DATABASE - 1, CORE, DATABASE - 1, CORE]) {
          ahead.ms += 180_000;
          assert.equal(await speak(version), false, `held at ${String(version)}`);
          assert.equal(await healthState(), 'warning');
          // At the core's own version the skew is gone, and the warning is the flap's.
          if (version === CORE) {
            assert.match(
              (await stateOf(watch)).message,
              /^Protocol version changes in a flap is \d changes, above the warning limit of 1\.5 changes — this probe's protocol version changed more than once in an hour/,
            );
          }
        }
        assert.equal(await warnings(), 1, 'one warning for the whole flap');
        assert.deepEqual(await paged(query), ['initial:unknown']);

        // Held for an hour at the core's version: over. The query is sent and let go, and
        // Probe Health is Up again.
        ahead.ms += PROTOCOL_FLAP_HOLD_MS;
        await credentials.prune();
        assert.equal(await speak(CORE), true);
        assert.equal(await healthState(), 'up');
        assert.equal(await warnings(), 1);
        assert.equal((await stateOf(query)).state, 'up');
        assert.deepEqual(await paged(query), ['initial:unknown', 'recovery:unknown']);
        assert.equal(await downs([query, watch]), 0);
      } finally {
        await ingestor.stop();
        ({ credentials, config } = running);
      }
    });

    it('a change an operator makes inside a flap is made at once: a name entry sends the held sensor, and it is Up at its next scan (A-72)', async () => {
      const running = { credentials, config };
      ({ credentials, config } = restartedCore());
      try {
        const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'rolled back' });
        const { group, sensor } = await named(probe, 'rolled');
        assert.equal(await sentTo(PINNING, sensor, probe), true);
        await fromProbe([{ ...measured(sensor, at(-90)), message: 'up 1 d' }], probe);
        await scheduler.sweep(later(3_600));

        // Rolled back, and forward again eleven minutes later: a flap, held.
        assert.equal(await sentTo(PINNING - 1, sensor, probe), false);
        ahead.ms += LATE_REFUSAL_GRACE_MS + 60_000;
        assert.equal(await sentTo(PINNING, sensor, probe), false);
        await scheduler.sweep(later(3_600));
        assert.deepEqual(await paged(sensor), ['initial:unknown']);
        // "Check now" is judged as a configuration is: at the flap's floor, so the probe on the
        // line at the core's version is not asked, as the configuration did not send it.
        await assert.rejects(
          config.assignmentFor(sensor, () => PINNING),
          (error: unknown) =>
            error instanceof ObjectError && error.message === WITHHELD_CREDENTIALS.probeCannotPin,
        );

        // Somebody adds a name entry: the core decides the device now, whatever the probe
        // speaks, so the flap has nothing to hold. Sent at once, and Up at its next scan.
        await h.service.setCredential(testActor, group, 'snmp', {
          version: 'v2c',
          community: 'rolled-secret',
          allowedTargets: ['10.20.0.0/16', '*.dc.test'],
        });
        assert.equal(await sentTo(PINNING, sensor, probe), true);
        assert.notEqual(credentials.protocolFlap(probe), null, 'the flap goes on');
        await fromProbe([{ ...measured(sensor, at(-30)), message: 'up 2 d' }], probe);
        assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 2 d' });
        await scheduler.sweep(later(3_600));
        assert.equal(await downs([sensor]), 0);
        assert.deepEqual(await paged(sensor), ['initial:unknown', 'recovery:unknown']);
      } finally {
        ({ credentials, config } = running);
      }
    });

    it('a core restarted in the middle keeps the flap and the window: the probe’s next upgrade is held, and its refusals after the window are dropped (A-68, A-72)', async () => {
      const running = { credentials, config };
      ({ credentials, config } = restartedCore());
      const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'flaps a restart' });
      const { sensor } = await named(probe, 'across');
      assert.equal(await sentTo(PINNING, sensor, probe), true);
      await fromProbe([{ ...measured(sensor, at(-90)), message: 'up 1 d' }], probe);
      const refusals = new ProbeRefusals();
      /** How far both of the restarted core's clocks are ahead of when the window began. */
      const since = { ms: 0 };
      const tick = (ms: number): void => {
        ahead.ms += ms;
        since.ms += ms;
      };

      try {
        // Down, and the core stops two minutes into the window.
        assert.equal(await sentTo(PINNING - 1, sensor, probe), false);
        tick(120_000);
        ({ credentials, config } = restartedCore(() => Date.now() + since.ms));
        const restored = await credentials.restore();
        assert.ok(restored.restored >= 1, JSON.stringify(restored));
        // The probe comes back at the newer version: its second change inside the hour, which
        // the restarted core knows of from the row the one before wrote. Held.
        assert.equal(await sentTo(PINNING, sensor, probe), false);
        assert.equal(credentials.protocolFlap(probe)?.changes, 2);
        tick(120_000);
        assert.equal(await sentTo(PINNING - 1, sensor, probe), false);
        await fromProbe([refused(sensor, at(-80)), refused(sensor, at(-79))], probe, refusals);
        assert.equal(refusals.lateFor(probe), 2, 'four minutes in: what is left of the window');

        // Ten minutes after the first downgrade: not late, and for a sensor the core withholds.
        tick(LATE_REFUSAL_GRACE_MS - 240_000 + 1);
        await fromProbe([refused(sensor, at(-70)), refused(sensor, at(-69))], probe, refusals);
        assert.equal(refusals.lateFor(probe), 2, 'the second downgrade began nothing');
        assert.equal(refusals.withheldFor(probe), 2);
        assert.equal(refusals.countsFor(probe).refused, 0);
        assert.equal(await downs([sensor]), 0);
        assert.deepEqual(await stateOf(sensor), {
          state: 'unknown',
          message: WITHHELD_CREDENTIALS.probeCannotPin,
        });
      } finally {
        ({ credentials, config } = running);
      }
    });

    it('a core rolled back and upgraded again inside the hour, its probe unchanged, is no flap: no warning, and nothing held past what each core requires (A-72)', async () => {
      // The probe advertises the core's own version; the build it is rolled back to is below the
      // one a database set needs (two versions back since `A-64` added 28 above 27).
      const DATABASE = versionFor('databaseAddressPinning');
      const CORE = PROTOCOL_VERSION;
      assert.ok(DATABASE <= CORE);
      const running = { credentials, config };
      ({ credentials, config } = restartedCore());
      try {
        const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'core rolled back' });
        const group = await create({ kind: 'group', parentId: probe, name: 'rolled databases' });
        await h.service.setCredential(testActor, group, 'database', {
          username: 'monitor',
          password: 'rolled-password',
          allowedTargets: ['10.20.0.0/16'],
        });
        const device = await create({
          kind: 'device',
          parentId: group,
          name: 'rolled database',
          host: 'db.rolled.test',
        });
        const query = await create({
          kind: 'sensor',
          parentId: device,
          name: 'rolled query',
          sensorType: 'test.db.pinned',
          params: { port: 5432 },
        });
        /**
         * The probe, which advertises the core's version throughout, meets a core whose own
         * version is `coreVersion`, as the endpoint builds for it: negotiated at the lower.
         */
        const meet = async (coreVersion: number): Promise<boolean> => {
          const sent = (
            await config.assignmentsFor(probe, Math.min(coreVersion, CORE), {
              advertisedVersion: CORE,
              live: () => true,
            })
          ).sensors.some((one) => one.sensorId === query);
          await scheduler.sweep(later(3_600));
          return sent;
        };
        /** The core is restarted, as a build whose own version is the one it is next met at. */
        const restart = async (): Promise<void> => {
          ({ credentials, config } = restartedCore());
          await credentials.restore();
        };
        const flapReading = (negotiated: number): number | null | undefined =>
          new ProbeHealthService({
            db,
            logger: silent,
            vouching: everyVoucherHolds,
            sources: {
              link: () => linkAt(negotiated),
              protocolFlap: (probeId) => credentials.protocolFlap(probeId),
            },
            ingest: () => Promise.resolve(),
          }).read(probe).reading['protocolFlap'];

        assert.equal(await meet(CORE), true);
        await fromProbe([{ ...measured(query, at(-90)), message: '1 row in 3 ms' }], probe);
        assert.deepEqual(await paged(query), []);

        // Rolled back five minutes on, to a build one version older: the query needs the newer,
        // and is withheld, as that build requires, with its one page.
        ahead.ms += 300_000;
        await restart();
        assert.equal(await meet(DATABASE - 1), false);
        assert.deepEqual(await paged(query), ['initial:unknown']);
        assert.equal(flapReading(DATABASE - 1), 0);

        // Upgraded again five minutes later: the query is let go at once, with its one recovery.
        // The probe changed nothing, so there is no flap, no warning and no hour held.
        ahead.ms += 300_000;
        await restart();
        assert.equal(await meet(CORE), true);
        assert.equal(credentials.protocolFlap(probe), null);
        assert.equal(flapReading(CORE), 0);
        assert.deepEqual(await paged(query), ['initial:unknown', 'recovery:unknown']);
        assert.equal(await downs([query]), 0);
        // Its row is what it advertised, written once, and never moved.
        assert.deepEqual(
          await db.query(
            'SELECT version, run_changes, changed_at FROM probe_protocol_flap WHERE probe_id = $1',
            [probe],
          ),
          [{ version: CORE, run_changes: 0, changed_at: null }],
        );
      } finally {
        ({ credentials, config } = running);
      }
    });

    it('a core that stops between a change and the next configuration still takes the late refusals as late: no Down, no page (A-68)', async () => {
      const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'stopped between' });
      const { group, sensor } = await named(probe, 'between');
      assert.equal(await sentTo(PINNING, sensor, probe), true);
      await fromProbe([{ ...measured(sensor, at(-90)), message: 'up 1 d' }], probe);
      assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });
      const windows = (): Promise<number> =>
        count(
          `SELECT count(*)::text AS n FROM late_refusal_grace
           WHERE sensor_id = $1 AND stopped_at IS NOT NULL`,
          [sensor],
        );

      // The change is committed, and the core stops before it builds the probe's next
      // configuration: inside the notifier's quarter of a second, or with the probe away. No
      // configuration says the sensor stopped being left, and nothing is stored that does.
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: 'between-secret',
        allowedTargets: ['10.20.0.0/16', '*.dc.test'],
      });
      assert.equal(await windows(), 0);

      const running = { credentials, config };
      ({ credentials, config } = restartedCore());
      try {
        const restored = await credentials.restore();
        assert.ok(restored.left >= 1, JSON.stringify(restored));
        // The probe redials. Its configuration is compared with the last one the core before
        // built, which the table kept, and the stop is found and stored.
        assert.equal(await sentTo(PINNING, sensor, probe), true);
        assert.equal(await windows(), 1);
        await scheduler.sweep(later(3_600));
        const asked = await requests();
        const before = await history(sensor);
        const refusals = new ProbeRefusals();

        // The refusals its spool held, which were two failed scans, one Down and one page.
        await fromProbe([refused(sensor, at(-80))], probe, refusals);
        await fromProbe([refused(sensor, at(-79))], probe, refusals);
        assert.deepEqual(await stateOf(sensor), { state: 'up', message: 'up 1 d' });
        assert.deepEqual(await history(sensor), before, 'no transition: not Warning, not Down');
        assert.equal(await downs([sensor]), 0);
        assert.equal(vouching.withheld().has(sensor), false);
        assert.equal(await scheduler.sweep(later(3_600)), 0, 'nothing to page about');
        assert.equal(await requests(), asked);
        assert.equal(refusals.lateFor(probe), 2);
        assert.equal(refusals.countsFor(probe).refused, 0);
      } finally {
        ({ credentials, config } = running);
      }
    });
  },
);

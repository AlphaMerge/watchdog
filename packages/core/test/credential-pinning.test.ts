import { strict as assert } from 'node:assert';
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
  WITHHELD_CREDENTIALS,
  boundRefusal,
} from '../src/objects/credential-vouching.js';
import { ObjectError } from '../src/objects/errors.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import { SensorVouching } from '../src/objects/vouching.js';
import { ProbeConfigService } from '../src/probes/config.js';
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

describe('what a probe refuses to scan is held, not counted as a failed scan (A-41c)', () => {
  /** A `CredentialVouching` with nothing behind it but a record of what it settled. */
  function holder(): {
    credentials: CredentialVouching;
    settled: { owner: string; refused: Map<number, string> }[];
  } {
    const settled: { owner: string; refused: Map<number, string> }[] = [];
    const none = (): Promise<never> => Promise.reject(new Error('no database in this test'));
    const credentials = new CredentialVouching({
      db: { query: none, tx: none },
      logger: silent,
      sensorTypes: catalogueSensorTypeGate(testCatalogue([snmpPinned])),
      rights: () => Promise.resolve(new Map()),
      vouching: {
        settle: (owner, refusedNow) => {
          settled.push({ owner, refused: new Map(refusedNow) });
          return Promise.resolve(0);
        },
      },
    });
    return { credentials, settled };
  }

  const T = (seconds: number): string => new Date(1_790_000_000_000 + seconds * 1000).toISOString();

  it('passes a batch with no refusal straight through, and settles nothing', async () => {
    const { credentials, settled } = holder();
    const batch = [measured(1, T(0)), measured(2, T(0), 'error')];
    assert.equal(await credentials.reported(7, batch), batch);
    assert.equal(settled.length, 0);
    assert.equal(credentials.stats().withheld, 0);
  });

  it('takes a refused check out of the batch and holds its sensor, under the probe’s own name', async () => {
    const { credentials, settled } = holder();
    const kept = await credentials.reported(7, [refused(1, T(0)), measured(2, T(0))]);
    assert.deepEqual(
      kept.map((result) => result.sensorId),
      [2],
    );
    assert.deepEqual(settled, [{ owner: 'credentials-probe:7', refused: new Map([[1, REFUSED]]) }]);
    assert.equal(credentials.stats().withheld, 1);
  });

  it('does not settle again for the same words at the next scan, and still takes the result', async () => {
    const { credentials, settled } = holder();
    await credentials.reported(7, [refused(1, T(0))]);
    assert.deepEqual(await credentials.reported(7, [refused(1, T(60))]), []);
    assert.equal(settled.length, 1);
    // Other words are news: the name resolves somewhere else now.
    await credentials.reported(7, [refused(1, T(120), 'Not scanned: somewhere else.')]);
    assert.equal(settled.length, 2);
    assert.equal(settled[1]?.refused.get(1), 'Not scanned: somewhere else.');
  });

  it('lets a sensor go at its next result that is not a refusal, and passes that result on', async () => {
    const { credentials, settled } = holder();
    await credentials.reported(7, [refused(1, T(0))]);
    const kept = await credentials.reported(7, [measured(1, T(60))]);
    assert.equal(kept.length, 1);
    assert.deepEqual(settled[1], { owner: 'credentials-probe:7', refused: new Map() });
    assert.equal(credentials.stats().withheld, 0);
    // A failed scan lets it go too: the probe did ask the device this time.
    await credentials.reported(7, [refused(1, T(120))]);
    await credentials.reported(7, [measured(1, T(180), 'error')]);
    assert.equal(credentials.stats().withheld, 0);
  });

  it('is not let go by a reading older than the refusal: a spool replays', async () => {
    const { credentials, settled } = holder();
    await credentials.reported(7, [refused(1, T(60))]);
    const kept = await credentials.reported(7, [measured(1, T(30))]);
    assert.equal(kept.length, 1, 'the old reading is still the machine’s to judge');
    assert.equal(settled.length, 1);
    assert.equal(credentials.stats().withheld, 1);
  });

  it('holds nothing for a refusal older than the last result the machine took', async () => {
    const { credentials, settled } = holder();
    const last = (): Date => new Date(T(100));
    assert.deepEqual(await credentials.reported(7, [refused(1, T(60))], last), []);
    assert.deepEqual(await credentials.reported(7, [refused(1, T(100))], last), []);
    assert.equal(settled.length, 0);
    await credentials.reported(7, [refused(1, T(101))], last);
    assert.equal(settled.length, 1);
  });

  it('reads one batch in the order it happened, whatever order it arrived in', async () => {
    const first = holder();
    await first.credentials.reported(7, [measured(1, T(60)), refused(1, T(0))]);
    assert.equal(first.credentials.stats().withheld, 0, 'refused, then measured: let go');

    const second = holder();
    const kept = await second.credentials.reported(7, [refused(1, T(60)), measured(1, T(0))]);
    assert.equal(second.credentials.stats().withheld, 1, 'measured, then refused: held');
    assert.equal(kept.length, 1);
  });

  it('leaves a refusal whose time cannot be read to the machine’s own gate', async () => {
    const { credentials, settled } = holder();
    const kept = await credentials.reported(7, [refused(1, 'not a time')]);
    assert.equal(kept.length, 1);
    assert.equal(settled.length, 0);
  });

  it('keeps each probe’s refusals apart', async () => {
    const { credentials, settled } = holder();
    await credentials.reported(7, [refused(1, T(0))]);
    await credentials.reported(8, [refused(2, T(0))]);
    assert.deepEqual(
      settled.map((one) => one.owner),
      ['credentials-probe:7', 'credentials-probe:8'],
    );
    await credentials.reported(8, [measured(1, T(60))]);
    assert.equal(credentials.stats().withheld, 2, 'probe 8 cannot let go what probe 7 refused');
  });

  it('drops what a probe refused once the sensor is no longer sent to it', async () => {
    const { credentials, settled } = holder();
    await credentials.reported(7, [refused(1, T(0))]);
    // A configuration with no credentialed sensor in it: paused, moved away or deleted.
    await credentials.withhold(7, []);
    assert.equal(credentials.stats().withheld, 0);
    assert.deepEqual(settled.at(-1), { owner: 'credentials-probe:7', refused: new Map() });
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

    const gate = catalogueSensorTypeGate(testCatalogue([snmpPinned, dbQuery]));
    let site = 0;
    let batch = 0;

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
    async function fromProbe(results: readonly CheckResult[]): Promise<unknown> {
      const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const ingestion = new IngestionService({
        db,
        logger: silent,
        ingestor,
        credentialRefusals: credentials,
        ...(h.states === undefined ? {} : { states: h.states }),
      });
      batch += 1;
      const reply = await ingestion.acceptProbeResults(
        { gid: 'gid-site', probeObjectId: site },
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

    const sentTo = async (version: number, sensorId: number): Promise<boolean> =>
      (await config.assignmentsFor(site, version)).sensors.some((one) => one.sensorId === sensorId);

    before(async () => {
      scratch = await createScratchDatabase('credential_pinning');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        withheldSensors: () => vouching.withheld(),
        types: [snmpPinned, dbQuery],
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
      const database = await h.service.setCredential(testActor, group, 'database', {
        username: 'monitor',
        password: 'gate-password',
        allowedTargets: ['10.20.0.0/16'],
      });
      assert.equal(database.withholds, 1);

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

      // "Check now" asks as the probe last registered: never, here, so as the oldest.
      await assert.rejects(
        config.assignmentFor(pinned),
        (error: unknown) =>
          error instanceof ObjectError && error.message === WITHHELD_CREDENTIALS.probeCannotPin,
      );
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
  },
);

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { SensorType } from '@ms/sensors';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService } from '../src/auth/access.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import { CredentialVouching, WITHHELD_CREDENTIALS } from '../src/objects/credential-vouching.js';
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
 * Narrowing a credential set's targets is one change, and it pages like one (`A-41b`).
 *
 * A set with `allowedTargets` is not sent to a device outside them, and the sensor is held
 * Unknown with the reason. So narrowing the targets on a group — restricting a set to CIDR ranges
 * when the devices beneath are named, say — can take a group's worth of sensors to Unknown in one
 * write. CLAUDE.md's rule is one outage, one alarm: this counts what that write raises, through
 * the triggers an installation that wants to hear about trouble has. It should be what Unknown
 * already raises, once per sensor and collected into one digest, with nothing for a sensor a
 * dependency already holds, and no more.
 */

const available = await databaseAvailable();

/**
 * An SSH type as the core sees one: the kind it uses and where it sends it, and nothing that
 * runs. The real ones carry schema defaults these assertions have no use for.
 */
const sshLoad: SensorType = {
  id: 'test.ssh.load',
  category: 'SSH',
  costHint: 'light',
  credentialKinds: ['ssh'],
  secretDestinations: { 'kind:ssh': ['port'] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { port: { type: 'integer', minimum: 1, maximum: 65_535 } },
  },
  channels: () => [{ key: 'load', name: 'Load', unit: '', isPrimary: true }],
  execute: () => Promise.resolve({ channels: [] }),
};

/** The devices behind each set, each with one credentialed sensor and one that is not. */
const DEVICES = 6;
/**
 * An hour ago, for what was measured; a withheld sensor is decided at the wall clock, so what
 * follows it is timed from now.
 */
const T0 = new Date(Date.now() - 3_600_000);
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const later = (seconds: number): Date => new Date(Date.now() + seconds * 1000);

describe(
  'narrowing a credential set’s targets (A-41b)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let dispatcher: NotificationDispatcher;
    let vouching: SensorVouching;
    let config: ProbeConfigService;
    const seen: OutgoingMessage[] = [];

    const gate = catalogueSensorTypeGate(testCatalogue([sshLoad]));
    let site = 0;

    async function count(sql: string): Promise<number> {
      const [row] = await db.query<{ n: string }>(sql);
      return Number(row?.n);
    }

    const requests = (): Promise<number> =>
      count('SELECT count(*)::text AS n FROM notification_request');

    async function ingest(results: readonly SensorResult[]): Promise<void> {
      const service = h.states ?? assert.fail('no state service');
      const decisions = await service.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await h.dependencies?.react(q, decisions.transitions, results[0]?.at ?? T0);
        await engine.react(
          q,
          results.map((result) => result.sensorId),
          results[0]?.at ?? T0,
        );
      });
    }

    async function stateOf(sensorId: number): Promise<{ state: string; message: string }> {
      const [row] = await db.query<{ state: string; message: string }>(
        'SELECT state::text AS state, message FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      return row ?? assert.fail(`sensor ${String(sensorId)} has no runtime`);
    }

    /** Dispatches until nothing moves, as `DeliveryLoop` does. */
    async function drain(now: Date): Promise<void> {
      for (let round = 0; round < 40; round += 1) {
        if ((await dispatcher.dispatch(now)) === 0) return;
      }
      assert.fail('the queue never drained');
    }

    const create = async (input: Record<string, unknown>): Promise<number> =>
      (await h.service.create(testActor, input as never)).id;

    /**
     * A group with its own SNMP set, a switch whose ping every device behind it depends on, and
     * `DEVICES` devices, each with a traffic sensor on the set and a ping that uses none.
     */
    async function rack(name: string, octet: number) {
      const group = await create({ kind: 'group', parentId: site, name });
      await h.service.setCredential(testActor, group, 'snmp', {
        version: 'v2c',
        community: `${name}-secret`,
      });
      const switchDevice = await create({
        kind: 'device',
        parentId: group,
        name: `${name}-switch`,
        host: `192.0.${String(octet)}.1`,
      });
      const switchPing = await create({
        kind: 'sensor',
        parentId: switchDevice,
        name: `${name} switch ping`,
        sensorType: 'icmp.ping',
      });
      const traffic: number[] = [];
      const pings: number[] = [];
      for (let index = 0; index < DEVICES; index += 1) {
        const device = await create({
          kind: 'device',
          parentId: group,
          name: `${name}-${String(index)}`,
          host: `192.0.${String(octet)}.${String(10 + index)}`,
        });
        await h.service.setDependency(testActor, device, 'object', switchPing, undefined);
        traffic.push(
          await create({
            kind: 'sensor',
            parentId: device,
            name: `${name}-${String(index)} traffic`,
            sensorType: 'snmp.traffic',
            params: { port: 161 },
          }),
        );
        pings.push(
          await create({
            kind: 'sensor',
            parentId: device,
            name: `${name}-${String(index)} ping`,
            sensorType: 'icmp.ping',
          }),
        );
      }
      const all = [switchPing, ...traffic, ...pings];
      await ingest(all.map((sensorId) => ({ sensorId, at: T0, outcome: 'ok', message: 'fine' })));
      return { group, switchDevice, switchPing, traffic, pings, octet };
    }

    before(async () => {
      scratch = await createScratchDatabase('credential_targets');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        withheldSensors: () => vouching.withheld(),
        types: [sshLoad],
      });
      assert.ok(h.dependencies !== undefined, 'dependencies apply here');
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
        siteName: 'Targets',
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
      const credentials = new CredentialVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        rights: (principal, objectIds, q) => access.resolveManyFor(principal, objectIds, q),
        vouching,
        // A case here asks as a probe at 22 and then at 21 of one probe, which is not a probe
        // reconnecting: no flap is held (`A-72`, whose scenarios are in credential-pinning).
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
          name: `Targets ${state}`,
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

    it('pages once per sensor it withholds, as Unknown does, and delivers one digest', async () => {
      const racks = await rack('racks', 2);
      const sensorsBefore = (await config.assignmentsFor(site)).sensors;
      for (const id of racks.traffic) {
        assert.ok(
          sensorsBefore.some(
            (one) => one.sensorId === id && one.credentials?.['snmp'] !== undefined,
          ),
        );
      }
      const asked = await requests();
      seen.length = 0;

      // Narrowed to the switch alone: every device behind it is outside, and the write says so.
      const view = await h.service.setCredential(testActor, racks.group, 'snmp', {
        version: 'v2c',
        allowedTargets: [`192.0.${String(racks.octet)}.1`],
      });
      assert.equal(view.withholds, DEVICES);
      assert.deepEqual(view.secretsCleared, [], 'narrowing keeps the community');

      const sensorsAfter = (await config.assignmentsFor(site)).sensors;
      for (const id of racks.traffic) {
        assert.equal(
          sensorsAfter.some((one) => one.sensorId === id),
          false,
        );
        assert.deepEqual(await stateOf(id), {
          state: 'unknown',
          message: WITHHELD_CREDENTIALS.outside,
        });
      }
      for (const id of [racks.switchPing, ...racks.pings]) {
        assert.equal((await stateOf(id)).state, 'up', 'nothing that uses no credential moved');
      }

      // One page per withheld sensor from the Unknown trigger, none from the Down trigger:
      // exactly what `A-41`'s withholding and a lost probe already raise.
      assert.equal(await scheduler.sweep(later(120)), DEVICES);
      assert.equal(await requests(), asked + DEVICES);

      // Collected: Unknown is never a "first Down", so the whole outage is held for the window
      // and goes out as one digest when it closes.
      await drain(later(121));
      assert.equal(seen.length, 0, 'nothing sent before the window closes');
      await drain(later(300));
      assert.equal(seen.length, 1, `${String(DEVICES)} withheld sensors, one message`);
      assert.deepEqual(
        [...(seen[0]?.about ?? [])].sort((a, b) => a - b),
        [...racks.traffic].sort((a, b) => a - b),
      );
    });

    it('adds nothing for sensors a Down master already holds: one outage, one alarm', async () => {
      const behind = await rack('behind', 3);
      const asked = await requests();
      seen.length = 0;

      // The switch goes Down — twice, because the two-step rule goes through Warning — and
      // everything behind it is paused by the dependency.
      for (const seconds of [400, 460]) {
        await ingest([
          { sensorId: behind.switchPing, at: at(seconds), outcome: 'error', message: 'no reply' },
        ]);
      }
      assert.equal((await stateOf(behind.switchPing)).state, 'down');
      for (const id of behind.traffic) assert.equal((await stateOf(id)).state, 'paused');

      // Narrowed during the outage: the count is still honest about the set...
      const view = await h.service.setCredential(testActor, behind.group, 'snmp', {
        version: 'v2c',
        allowedTargets: [`192.0.${String(behind.octet)}.1`],
      });
      assert.equal(view.withholds, DEVICES);
      // ...but a paused sensor is not configured, so nothing is withheld and nothing goes Unknown.
      await config.assignmentsFor(site);
      for (const id of behind.traffic) {
        assert.equal(vouching.withheld().has(id), false);
        assert.equal((await stateOf(id)).state, 'paused');
      }

      // The switch's Down, and nothing else.
      assert.equal(await scheduler.sweep(later(600)), 1);
      assert.equal(await requests(), asked + 1);
      await drain(later(601));
      await drain(later(800));
      assert.equal(seen.length, 1, 'the one alarm for the one outage');
      assert.deepEqual(seen[0]?.about, [behind.switchPing]);
    });

    it('leaves an SSH set with only its one fingerprint under the voucher rule, as it was before', async () => {
      // What an installation upgrading into `A-41b` has: a strict SSH set with the one key.
      // Counting that key as a bound would send the set to whoever writes a device beneath it
      // from the day of the upgrade, with nobody having chosen that.
      const group = await create({ kind: 'group', parentId: site, name: 'keys' });
      await h.service.setCredential(testActor, group, 'ssh', {
        username: 'monitor',
        password: 'monitor-password',
        hostKeyPolicy: 'strict',
        hostKeyFingerprint: 'SHA256:only',
      });
      const device = await create({
        kind: 'device',
        parentId: group,
        name: 'keyed',
        host: '192.0.4.10',
      });
      const load = await create({
        kind: 'sensor',
        parentId: device,
        name: 'load',
        sensorType: 'test.ssh.load',
      });
      const vouched = async (): Promise<boolean> =>
        (await count(
          `SELECT count(*)::text AS n FROM sensor_credential_voucher
           WHERE kind = 'ssh' AND sensor_id = ${String(load)}`,
        )) === 1;
      const sent = async (version?: number): Promise<boolean> =>
        (await config.assignmentsFor(site, version)).sensors.some(
          (one) => one.sensorId === load && one.credentials?.['ssh'] !== undefined,
        );

      assert.equal(await vouched(), true, 'vouched for, as every set was');
      assert.equal(await sent(), true);
      await db.query('DELETE FROM sensor_credential_voucher WHERE sensor_id = $1', [load]);
      assert.equal(await sent(), false, 'and without its voucher the fingerprint sends nothing');
      assert.equal(vouching.withheld().get(load), WITHHELD_CREDENTIALS.unvouched);

      // Listing the key is the choice that bounds it: sent with nobody vouching, and the password
      // kept, because a list where there was none narrows the set.
      const view = await h.service.setCredential(testActor, group, 'ssh', {
        username: 'monitor',
        hostKeyPolicy: 'strict',
        hostKeyFingerprint: 'SHA256:only',
        hostKeys: ['SHA256:only'],
      });
      assert.deepEqual(view.secretsCleared, []);
      assert.equal(await vouched(), false, 'nobody vouches for a bounded set');
      assert.equal(await sent(22), true);
      // ...to a probe that checks the list, and not to one that would read only the fingerprint.
      assert.equal(await sent(21), false);
      assert.equal(vouching.withheld().get(load), WITHHELD_CREDENTIALS.probeTooOld);
      assert.equal(await sent(22), true);
      assert.equal(vouching.withheld().has(load), false);
    });
  },
);

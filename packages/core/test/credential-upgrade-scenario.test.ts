import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService } from '../src/auth/access.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
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
 * The upgrade that brings `A-41` in changes nothing an installation can see.
 *
 * `A-41` withholds a sensor's inherited credentials unless somebody with `write` on where they
 * are stored vouched for sending them where it sends them. An installation upgrading into it has
 * no record of anybody vouching for anything, so read naively every credentialed sensor it has
 * would go Unknown at once, and a trigger on Unknown would page for each. Migration 060 marks the
 * installation instead, and the core's boot step records the installation as voucher for what is
 * in use — in one transaction with clearing the mark, so a boot that dies halfway leaves the
 * mark for the next. This walks it: an installation with Up sensors and triggers on Down and
 * Unknown, migrated, booted once into a failure and once for real, then asked for a probe's
 * configuration.
 */

const available = await databaseAvailable();

describe(
  'the upgrade to credential vouchers (A-41)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let vouching: SensorVouching;
    let credentials: CredentialVouching;
    let config: ProbeConfigService;

    const gate = catalogueSensorTypeGate(testCatalogue());
    let site = 0;
    let credentialed: number[] = [];
    let ping = 0;

    async function count(sql: string): Promise<number> {
      const [row] = await db.query<{ n: string }>(sql);
      return Number(row?.n);
    }

    /** Every sensor's state, cause and words, which is what an operator sees. */
    async function states(): Promise<string[]> {
      const rows = await db.query<{ id: string; state: string; cause: string; message: string }>(
        `SELECT object_id::text AS id, state::text AS state, cause::text AS cause, message
         FROM sensor_runtime ORDER BY object_id`,
      );
      return rows.map((row) => `${row.id} ${row.state} ${row.cause} ${row.message}`);
    }

    async function ingest(results: readonly SensorResult[]): Promise<void> {
      const service = h.states ?? assert.fail('no state service');
      const decisions = await service.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(
          q,
          results.map((result) => result.sensorId),
          results[0]?.at ?? new Date(),
        );
      });
    }

    /** What migration 060 leaves on an installation that already had all of this. */
    async function migrated(): Promise<void> {
      await db.query('DELETE FROM sensor_credential_voucher');
      await db.query(`UPDATE credential_voucher_adoption SET pending = true, recipe = ''`);
    }

    before(async () => {
      scratch = await createScratchDatabase('credential_upgrade');
      db = scratch.db;
      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        withheldSensors: () => vouching.withheld(),
      });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      const triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      const templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts: new MessageContextLoader({
          settings: h.resolver,
          publicUrl: 'https://monitoring.example.test',
          siteName: 'Upgrade',
        }),
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
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

      // The installation as it was before the upgrade: an SNMP set on a group, sensors that use
      // it, one that does not, all of them Up.
      const create = async (input: Record<string, unknown>): Promise<number> =>
        (await h.service.create(testActor, input as never)).id;
      site = await create({ kind: 'probe', parentId: h.rootId, name: 'site' });
      const datacentre = await create({ kind: 'group', parentId: site, name: 'datacentre' });
      await h.service.setCredential(testActor, datacentre, 'snmp', {
        version: 'v2c',
        community: 'dc-secret',
      });
      credentialed = [];
      for (const [name, host] of [
        ['core-1', '192.0.2.1'],
        ['core-2', '192.0.2.2'],
        ['edge-1', '192.0.2.3'],
      ] as const) {
        const device = await create({ kind: 'device', parentId: datacentre, name, host });
        credentialed.push(
          await create({
            kind: 'sensor',
            parentId: device,
            name: `${name} traffic`,
            sensorType: 'snmp.traffic',
            params: { port: 161 },
          }),
        );
        if (name === 'core-1') {
          ping = await create({
            kind: 'sensor',
            parentId: device,
            name: 'ping',
            sensorType: 'icmp.ping',
          });
        }
      }
      await ingest(
        [...credentialed, ping].map((sensorId) => ({
          sensorId,
          at: new Date(Date.now() - 60_000),
          outcome: 'ok',
          message: 'fine',
        })),
      );

      // What an installation that wants to hear about trouble has.
      for (const state of ['down', 'unknown'] as const) {
        const template = await templates.create(testActor, {
          name: `Upgrade ${state}`,
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

    it('changes no state and queues no notification, even after a boot that died halfway', async () => {
      const upNow = await states();
      for (const id of [...credentialed, ping]) {
        assert.ok(
          upNow.some((line) => line.startsWith(`${String(id)} up `)),
          `sensor ${String(id)} is Up`,
        );
      }
      await migrated();
      const before = await states();
      const history = await count('SELECT count(*)::text AS n FROM sensor_state');
      const requests = await count('SELECT count(*)::text AS n FROM notification_request');

      // The first boot dies after writing its rows and before clearing the mark.
      await db.query(
        `ALTER TABLE credential_voucher_adoption ADD CONSTRAINT boot_dies CHECK (pending)`,
      );
      try {
        await assert.rejects(credentials.adopt(), /boot_dies/);
      } finally {
        await db.query('ALTER TABLE credential_voucher_adoption DROP CONSTRAINT boot_dies');
      }
      assert.equal(await count('SELECT count(*)::text AS n FROM sensor_credential_voucher'), 0);

      // The next one completes it, and then the endpoint builds the probe's configuration.
      const adopted = await credentials.adopt();
      assert.equal(adopted.adopted, credentialed.length);
      const assignments = await config.assignmentsFor(site);
      for (const id of credentialed) {
        const sent = assignments.sensors.find((one) => one.sensorId === id);
        assert.ok(sent?.credentials?.['snmp'] !== undefined, `${String(id)} is sent its set`);
      }
      assert.equal(vouching.withheld().size, 0);

      assert.equal(await scheduler.sweep(new Date(Date.now() + 3_600_000)), 0);
      assert.deepEqual(await states(), before, 'not one state moved');
      assert.equal(await count('SELECT count(*)::text AS n FROM sensor_state'), history);
      assert.equal(
        await count('SELECT count(*)::text AS n FROM notification_request'),
        requests,
        'and nobody was told anything',
      );
    });

    it('would have noticed: without the boot step every credentialed sensor goes Unknown and pages', async () => {
      // The same configuration, asked before anybody vouched. This is what the boot step is for,
      // and it is what proves the assertions above can fail.
      await migrated();
      const requests = await count('SELECT count(*)::text AS n FROM notification_request');
      const assignments = await config.assignmentsFor(site);
      for (const id of credentialed) {
        assert.equal(
          assignments.sensors.some((one) => one.sensorId === id),
          false,
          `sensor ${String(id)} is withheld`,
        );
        assert.equal(vouching.withheld().get(id), WITHHELD_CREDENTIALS.unvouched);
      }
      assert.ok(
        assignments.sensors.some((one) => one.sensorId === ping),
        'the ping is not',
      );
      assert.equal(
        await scheduler.sweep(new Date(Date.now() + 3_600_000)),
        credentialed.length,
        'one Unknown page each',
      );
      assert.equal(
        await count('SELECT count(*)::text AS n FROM notification_request'),
        requests + credentialed.length,
      );
      await credentials.adopt();
    });
  },
);

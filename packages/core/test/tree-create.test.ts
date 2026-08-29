import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { HistoryService } from '../src/timeseries/history.js';
import type { TreeNodeInput } from '../src/objects/tree-plan.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Creating a subtree in one request (`P-19`).
 *
 * **The claim under test is that it is the same tree**, not a faster different one: the same
 * validation, the same hierarchy rules, the same channels, the same audit entries and the same
 * redaction as five thousand `POST /objects` calls would have produced. A bulk path that quietly
 * skipped one of those would be a second, laxer way in — and the strict path is then the one
 * nobody uses.
 */
describe(
  'creating a subtree in one request',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let probeId: number;

    before(async () => {
      scratch = await createScratchDatabase('treecreate');
      db = scratch.db;
      harness = await buildHarness(db);

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', harness.service);
      app = server.app;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(async () => {
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
    });

    const post = (nodes: TreeNodeInput[], parentId?: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/objects/tree',
        payload: { parentId: parentId ?? probeId, nodes },
      });

    interface Result {
      count: number;
      objects: { ref?: string; id: number; kind: string }[];
    }

    it('creates the whole subtree and answers in the order it was sent', async () => {
      const response = await post([
        // Leaf-first, because a caller building from a template has no reason to sort.
        { kind: 'sensor', name: 'Ping', sensorType: 'icmp.ping', ref: 's', parentRef: 'd' },
        { kind: 'device', name: 'Router', host: '192.0.2.5', ref: 'd', parentRef: 'g' },
        { kind: 'group', name: 'London', ref: 'g' },
      ]);

      assert.equal(response.statusCode, 201, response.body);
      const body = response.json<Result>();
      assert.equal(body.count, 3);
      assert.deepEqual(
        body.objects.map((object) => object.ref),
        ['s', 'd', 'g'],
        'answered in the order the nodes were sent, not the order they were written',
      );
      assert.deepEqual(
        body.objects.map((object) => object.kind),
        ['sensor', 'device', 'group'],
      );

      const [sensorId, deviceId, groupId] = body.objects.map((object) => object.id);
      assert.ok(sensorId !== undefined && deviceId !== undefined && groupId !== undefined);

      const sensor = await harness.service.get(sensorId);
      assert.equal(sensor.parentId, deviceId, 'the sensor hangs off the device from this request');
      const device = await harness.service.get(deviceId);
      assert.equal(device.parentId, groupId);
      const group = await harness.service.get(groupId);
      assert.equal(group.parentId, probeId, 'and the group off the request’s own parent');
    });

    it('declares each sensor’s channels, exactly as a single create would', async () => {
      // The defect this catches is a bulk path that writes the rows and forgets what makes a
      // sensor useful: a sensor with no channels records nothing, for ever, silently.
      const body = (
        await post([
          { kind: 'device', name: 'Box', host: '192.0.2.6', ref: 'd' },
          { kind: 'sensor', name: 'Ping', sensorType: 'icmp.ping', ref: 's', parentRef: 'd' },
        ])
      ).json<Result>();
      const sensorId = body.objects.find((object) => object.ref === 's')?.id;
      assert.ok(sensorId !== undefined);

      const channels = await db.query<{ key: string; is_primary: boolean }>(
        'SELECT key, is_primary FROM channel WHERE sensor_id = $1 ORDER BY key',
        [sensorId],
      );
      assert.deepEqual(
        channels.map((channel) => channel.key),
        ['loss', 'rtt'],
      );
      assert.equal(channels.filter((channel) => channel.is_primary).length, 1);
    });

    it('stores a sensor exactly as a single create would', async () => {
      // **Compared against the serial path rather than against a value typed here**, because the
      // claim is not "these params look right" — it is that the two ways in produce the same
      // row. A hard-coded expectation would go on passing if normalisation moved and only one
      // path followed it.
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'Serial',
        host: '192.0.2.7',
      });
      const serial = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Traffic',
        sensorType: 'snmp.traffic',
        params: { port: 1161 },
      });

      const body = (
        await post([
          { kind: 'device', name: 'Bulk', host: '192.0.2.7', ref: 'd' },
          {
            kind: 'sensor',
            name: 'Traffic',
            sensorType: 'snmp.traffic',
            params: { port: 1161 },
            ref: 's',
            parentRef: 'd',
          },
        ])
      ).json<Result>();
      const bulkId = body.objects.find((object) => object.ref === 's')?.id;
      assert.ok(bulkId !== undefined);

      const rows = await db.query<{ object_id: string; type: string; params: unknown }>(
        'SELECT object_id::text AS object_id, type, params FROM sensor_config WHERE object_id = ANY($1)',
        [[serial.id, bulkId]],
      );
      assert.equal(rows.length, 2);
      const [a, b] = rows;
      assert.ok(a !== undefined && b !== undefined);
      assert.equal(a.type, b.type);
      assert.deepEqual(a.params, b.params, 'the two ways in stored different parameters');

      // And the channels, for the same reason.
      const channels = await db.query<{ sensor_id: string; key: string }>(
        'SELECT sensor_id::text AS sensor_id, key FROM channel WHERE sensor_id = ANY($1) ORDER BY sensor_id, key',
        [[serial.id, bulkId]],
      );
      const keysFor = (id: number): string[] =>
        channels.filter((c) => c.sensor_id === String(id)).map((c) => c.key);
      assert.deepEqual(keysFor(bulkId), keysFor(serial.id));
      assert.ok(keysFor(bulkId).length > 0);
    });

    it('records every creation in the audit log, with what was stored', async () => {
      // An entry saying "5,000 objects were created" answers no question anybody has. What is
      // logged is read back from the database rather than assembled from the request, so it
      // carries the defaults, the version and the redaction a read goes through.
      const body = (
        await post([
          { kind: 'device', name: 'Audited', host: '192.0.2.8', ref: 'd' },
          { kind: 'sensor', name: 'Ping', sensorType: 'icmp.ping', ref: 's', parentRef: 'd' },
        ])
      ).json<Result>();

      const ids = new Set(body.objects.map((object) => object.id));
      // The harness captures what the service hands its sink, which is what a real installation's
      // `DatabaseAuditSink` writes — one entry per object, each carrying the stored object rather
      // than the request. `A-05`'s redaction has already run on it, which the next test checks.
      const entries = harness.audit.recorded.filter(
        (mutation) => mutation.action === 'object.created' && ids.has(mutation.objectId),
      );
      assert.equal(entries.length, 2, 'one entry per object, not one for the request');
      for (const entry of entries) {
        assert.ok(entry.action === 'object.created');
        assert.equal(entry.after.id, entry.objectId);
        assert.ok(entry.after.version >= 1, 'the version the triggers landed on, not a guess');
      }
    });

    it('never writes a secret into the audit log, however it was created', async () => {
      // `A-05`'s rule, and the reason redaction is at one boundary: a new path cannot forget it.
      const body = (
        await post([
          { kind: 'device', name: 'Secret holder', host: '192.0.2.11', ref: 'd' },
          {
            kind: 'sensor',
            name: 'Traffic',
            sensorType: 'snmp.traffic',
            params: { community: 'a-canary-value' },
            ref: 's',
            parentRef: 'd',
          },
        ])
      ).json<Result>();
      assert.equal(body.count, 2);

      assert.equal(
        JSON.stringify(harness.audit.recorded).includes('a-canary-value'),
        false,
        'a write-only parameter reached the audit sink',
      );
    });

    it('writes nothing at all when one node is wrong', async () => {
      // One transaction is the point: a half-provisioned device is worse than a failed one,
      // because nothing says which half.
      const before = await count();
      const response = await post([
        { kind: 'group', name: 'Fine', ref: 'g' },
        { kind: 'device', name: 'Also fine', host: '192.0.2.12', ref: 'd', parentRef: 'g' },
        { kind: 'sensor', name: 'Wrong', sensorType: 'icmp.ping', parentRef: 'g' },
      ]);

      assert.equal(response.statusCode, 400);
      assert.match(
        response.json<{ error: { message: string } }>().error.message,
        /node 2.*sensor, which cannot go under a group/,
      );
      assert.equal(await count(), before, 'the two valid nodes were written anyway');
    });

    it('pauses a subtree created under a paused parent, as a single create does', async () => {
      // `M-08`. Without it a whole provisioned branch would scan, alarm and record readings
      // inside a maintenance window nobody reopened — and the operator who paused the parent did
      // so before any of it existed. The serial path guards this with an `anyActive` probe per
      // object; here it is one recompute over the subtree that was just written.
      await harness.service.pause(testActor, probeId, { kind: 'indefinite' }, 'maintenance');

      const body = (
        await post([
          { kind: 'device', name: 'Late arrival', host: '192.0.2.30', ref: 'd' },
          { kind: 'sensor', name: 'Ping', sensorType: 'icmp.ping', ref: 's', parentRef: 'd' },
        ])
      ).json<Result>();
      const sensorId = body.objects.find((object) => object.ref === 's')?.id;
      assert.ok(sensorId !== undefined);

      const [row] = await db.query<{ paused_by_parent: boolean }>(
        'SELECT paused_by_parent FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      assert.equal(row?.paused_by_parent, true, 'a sensor created under a paused probe scanned');
    });

    it('refuses a parent that does not exist, rather than writing an orphan', async () => {
      const response = await post([{ kind: 'group', name: 'Nowhere' }], 999_999);
      assert.equal(response.statusCode, 404);
    });

    it('refuses a body the schema will not have', async () => {
      for (const payload of [
        { parentId: probeId, nodes: [] },
        { parentId: probeId, nodes: [{ kind: 'device', name: 'no host' }] },
        { parentId: probeId, nodes: [{ kind: 'sensor', name: 'no type' }] },
        { parentId: probeId, nodes: [{ kind: 'group', name: 'g', host: '192.0.2.1' }] },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/objects/tree',
          payload,
        });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
    });

    it('builds a wide subtree with the ids matched to the right parents', async () => {
      // The failure this exists for is silent: ids returned in the order the *levels* produced
      // them rather than the order the nodes were sent would attach every child to the wrong
      // parent, and the tree would look plausible.
      const nodes: TreeNodeInput[] = [];
      for (let g = 0; g < 5; g += 1) {
        nodes.push({ kind: 'group', name: `g${String(g)}`, ref: `g${String(g)}` });
        for (let d = 0; d < 4; d += 1) {
          const ref = `d${String(g)}-${String(d)}`;
          nodes.push({
            kind: 'device',
            name: ref,
            host: `192.0.2.${String(20 + g * 4 + d)}`,
            ref,
            parentRef: `g${String(g)}`,
          });
          nodes.push({
            kind: 'sensor',
            name: `s${ref}`,
            sensorType: 'icmp.ping',
            parentRef: ref,
          });
        }
      }

      const body = (await post(nodes)).json<Result>();
      assert.equal(body.count, nodes.length);

      const byRef = new Map(
        body.objects.map((object, index) => [nodes[index]?.ref ?? `#${String(index)}`, object.id]),
      );
      // Every device is under the group its own ref names, checked against the database rather
      // than against the answer.
      for (let g = 0; g < 5; g += 1) {
        for (let d = 0; d < 4; d += 1) {
          const deviceId = byRef.get(`d${String(g)}-${String(d)}`);
          assert.ok(deviceId !== undefined);
          const device = await harness.service.get(deviceId);
          assert.equal(device.parentId, byRef.get(`g${String(g)}`), `d${String(g)}-${String(d)}`);
        }
      }
    });

    async function count(): Promise<number> {
      const [row] = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM object');
      return Number(row?.n ?? 0);
    }
  },
);

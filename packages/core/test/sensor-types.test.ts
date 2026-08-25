import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ObjectError } from '../src/objects/errors.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** The community string the whole file is about. */
const SECRET = 'community-nobody-should-ever-read-back';

async function rejects(fn: () => Promise<unknown>): Promise<ObjectError> {
  try {
    await fn();
  } catch (error: unknown) {
    assert.ok(error instanceof ObjectError, `expected an ObjectError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a rejection');
}

describe(
  'sensor types',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('sensortypes');
      db = scratch.db;
      h = await buildHarness(db);

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'device',
        host: '192.0.2.80',
      });
      deviceId = device.id;
      h.audit.recorded.length = 0;
    });

    const createSensor = (params: Record<string, unknown>, type = 'snmp.traffic') =>
      h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'sensor',
        sensorType: type,
        params,
      });

    // ── validation ──────────────────────────────────────────────────────────────────────────

    it('refuses a type nothing has registered, and says what is registered', async () => {
      const error = await rejects(() => createSensor({}, 'nope.missing'));
      assert.equal(error.code, 'OBJECT_INVALID');
      assert.deepEqual(error.details['registered'], ['icmp.ping', 'snmp.traffic']);
    });

    it('refuses params the type’s schema rejects, listing every problem', async () => {
      const error = await rejects(() => createSensor({ community: '', port: 70_000 }));
      const problems = error.details['problems'] as { path: string }[];
      assert.equal(problems.length, 2, 'one submission should surface both mistakes');
      assert.deepEqual(problems.map((problem) => problem.path).sort(), ['/community', '/port']);
    });

    it('refuses a parameter the type never declared', async () => {
      const error = await rejects(() => createSensor({ community: 'public', nonsense: 1 }));
      assert.equal(error.code, 'OBJECT_INVALID');
    });

    // ── channels ────────────────────────────────────────────────────────────────────────────

    it('creates the channels the type declares, with its primary', async () => {
      const sensor = await createSensor({ community: 'public' });
      const channels = await h.service.channels(sensor.id);

      assert.deepEqual(
        channels.map((channel) => ({ key: channel.key, primary: channel.isPrimary })),
        [
          { key: 'in', primary: true },
          { key: 'out', primary: false },
        ],
        'S-07 could not set this: nothing had said which channel a sensor is judged by',
      );
    });

    it('returns a version that already accounts for the channels it created', async () => {
      // Writing `channel` fires the trigger that invalidates the sensor's ETag, so a create that
      // reported the version from before would hand back a tag that 412s on its first write.
      const sensor = await createSensor({ community: 'public' });
      assert.equal((await h.service.get(sensor.id)).version, sensor.version);
    });

    // ── the credential surface S-03 could not close ─────────────────────────────────────────

    it('never returns a writeOnly parameter, and says it is set', async () => {
      const sensor = await createSensor({ community: SECRET, port: 161 });
      assert.ok(sensor.kind === 'sensor');

      assert.deepEqual(sensor.params, { port: 161 }, 'the create’s own response');
      assert.deepEqual(sensor.redactedParams, ['community']);

      const read = await h.service.get(sensor.id);
      assert.ok(read.kind === 'sensor');
      assert.deepEqual(read.params, { port: 161 });
      assert.deepEqual(read.redactedParams, ['community']);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(sensor.id)}`,
      });
      assert.equal(response.statusCode, 200);
      assert.ok(!response.body.includes(SECRET), 'the secret reached an HTTP response');
      assert.deepEqual(response.json<{ redactedParams: string[] }>().redactedParams, ['community']);
    });

    it('still has the value where the probe will need it', async () => {
      // Redaction is a property of the boundary, not of storage: a check cannot authenticate
      // with a parameter the core threw away.
      const sensor = await createSensor({ community: SECRET });
      const [row] = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [sensor.id],
      );
      assert.equal(row?.params['community'], SECRET);
    });

    it('reports nothing redacted when no secret is set', async () => {
      const sensor = await createSensor({ count: 4 }, 'icmp.ping');
      assert.ok(sensor.kind === 'sensor');
      assert.deepEqual(sensor.redactedParams, []);
    });

    // ── the audit half (S-10) ───────────────────────────────────────────────────────────────

    it('records that a secret was set, never what it was', async () => {
      await createSensor({ community: SECRET, port: 161 });

      const [entry] = h.audit.recorded;
      assert.equal(entry?.action, 'object.created');
      assert.ok(
        !JSON.stringify(entry).includes(SECRET),
        'a parameter value reached the audit sink',
      );
    });

    it('records a rotated secret as a change, which redaction alone would hide', async () => {
      const sensor = await createSensor({ community: SECRET, port: 161 });
      h.audit.recorded.length = 0;

      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { community: `${SECRET}-rotated`, port: 161 } },
        { kind: 'none' },
      );

      const [entry] = h.audit.recorded;
      assert.ok(entry?.action === 'object.updated');
      // Both sides redact to the same absence, so a diff of what the sink can see reports
      // nothing. The key list is computed before redaction precisely so this is not invisible.
      assert.deepEqual(entry.changedParams, ['community']);
      assert.ok(!JSON.stringify(entry).includes(SECRET));
    });

    it('records ordinary parameter values, now that secrets cannot be among them', async () => {
      const sensor = await createSensor({ community: SECRET, port: 161 });
      h.audit.recorded.length = 0;

      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { community: SECRET, port: 162 } },
        { kind: 'none' },
      );

      const entry = h.audit.recorded[0];
      assert.ok(entry?.action === 'object.updated');
      assert.deepEqual(entry.changedParams, ['port']);
      assert.ok(entry.after.kind === 'sensor');
      assert.deepEqual(entry.after.params, { port: 162 }, 'the value, because it is not a secret');
    });

    // ── the registry over HTTP ──────────────────────────────────────────────────────────────

    it('publishes the catalogue the add-sensor form is generated from', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/sensor-types' });
      assert.equal(response.statusCode, 200);

      const items = response.json<{
        items: { id: string; paramsSchema: Record<string, unknown> }[];
      }>().items;
      assert.deepEqual(
        items.map((item) => item.id),
        ['icmp.ping', 'snmp.traffic'],
      );

      // The annotation stays: it is how a form knows to render a password field. It describes
      // the shape, and never carries a stored value.
      const snmp = items.find((item) => item.id === 'snmp.traffic');
      const properties = snmp?.paramsSchema['properties'] as Record<
        string,
        { writeOnly?: boolean }
      >;
      assert.equal(properties['community']?.writeOnly, true);
    });
  },
);

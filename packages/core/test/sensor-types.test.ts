import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
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
import { BUILT_IN_SENSOR_TYPES, type SensorCatalogue } from '@ms/sensors';
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
    let mapping: FastifyInstance;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('sensortypes');
      db = scratch.db;
      h = await buildHarness(db);

      const build = async (catalogue: SensorCatalogue): Promise<FastifyInstance> => {
        const server = new ApiServer({
          config: {
            host: '127.0.0.1',
            port: 0,
            webRoot: '',
            allowedOrigins: [],
            requireAuthentication: true,
          },
          logger: silent,
          version: '9.9.9',
          service: h.service,
          history: new HistoryService({ db, logger: silent }),
          db,
          audit: new AuditRepository(),
          catalogue,
        });
        await server.build('9.9.9', h.service);
        return server.app;
      };

      app = await build(testCatalogue());
      // The shipped `rest.custom`, not a stand-in: what the preview route is for is running the
      // type's own code, and a fake with a fake preview would prove the plumbing while leaving
      // the only interesting question — does a path proved here work against the device —
      // untested at this level.
      const restCustom = BUILT_IN_SENSOR_TYPES.find((type) => type.id === 'rest.custom');
      assert.ok(restCustom !== undefined, 'rest.custom is not a built-in type any more');
      mapping = await build(testCatalogue([restCustom]));
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
      assert.deepEqual(error.details['registered'], [
        'core.factory',
        'icmp.ping',
        'ms.core.health',
        'ms.probe.health',
        'snmp.traffic',
      ]);
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
          { key: 'status', primary: false },
        ],
        'S-07 could not set this: nothing had said which channel a sensor is judged by',
      );
    });

    it('carries the lookup a type declares onto the channel it declared it for', async () => {
      // M-06. A type knows that its status channel is an enumeration and its counters are not,
      // and saying so once at registration beats an operator configuring it per sensor.
      const sensor = await createSensor({ community: 'public' });
      const channels = await h.service.channels(sensor.id);

      assert.deepEqual(
        channels.map((channel) => [channel.key, channel.lookupId]),
        [
          ['in', null],
          ['out', null],
          ['status', 'ms.snmp.if-oper-status'],
        ],
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

    // ── the mirror of redaction (U-08) ──────────────────────────────────────────────────────

    it('keeps a secret the patch does not mention, instead of deleting it', async () => {
      // The trap a generated form walks straight into: a read never returns the credential, and
      // `params` is replaced wholesale on update. Round-tripping what was read would wipe every
      // secret on the first save, silently, and the sensor would keep scanning until the next
      // authentication failure.
      const sensor = await createSensor({ community: SECRET, port: 161 });
      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { port: 1161 } },
        { kind: 'none' },
      );

      const [row] = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [sensor.id],
      );
      assert.equal(row?.params['community'], SECRET, 'the secret survived a patch that omitted it');
      assert.equal(row.params['port'], 1161, 'and the patch still applied');
    });

    it('replaces a secret the patch does mention, which is how one is rotated', async () => {
      const sensor = await createSensor({ community: SECRET, port: 161 });
      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { community: 'rotated', port: 161 } },
        { kind: 'none' },
      );
      const [row] = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [sensor.id],
      );
      assert.equal(row?.params['community'], 'rotated');
    });

    it('unsets a secret sent as null, so clearing one is expressible at all', async () => {
      const sensor = await createSensor({ community: SECRET, port: 161 });
      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { community: null, port: 161 } },
        { kind: 'none' },
      );
      const [row] = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [sensor.id],
      );
      assert.ok(!Object.hasOwn(row?.params ?? {}, 'community'), 'the key is gone, not blanked');

      const read = await h.service.get(sensor.id);
      assert.ok(read.kind === 'sensor');
      assert.deepEqual(read.redactedParams, [], 'and nothing claims it is still set');
    });

    it('carries the secret over an update that touches no params at all', async () => {
      const sensor = await createSensor({ community: SECRET, port: 161 });
      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', name: 'renamed' },
        { kind: 'none' },
      );
      const [row] = await db.query<{ params: Record<string, unknown> }>(
        'SELECT params FROM sensor_config WHERE object_id = $1',
        [sensor.id],
      );
      assert.equal(row?.params['community'], SECRET);
    });

    it('clears a script’s secret an edit points somewhere else, and says so (A-40)', async () => {
      // The real type, for its declaration: which parameters choose where its secret goes is the
      // type's to say, and a stand-in would be testing a declaration nobody ships.
      const exeScript = BUILT_IN_SENSOR_TYPES.find((type) => type.id === 'exe.script');
      assert.ok(exeScript !== undefined, 'exe.script is not a built-in type any more');
      const scripts = await buildHarness(db, { types: [exeScript] });
      const sensor = await scripts.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'script',
        sensorType: 'exe.script',
        params: { program: 'check.sh', args: ['https://api.example.invalid'], secret: SECRET },
      });
      const stored = async (): Promise<Record<string, unknown>> => {
        const [row] = await db.query<{ params: Record<string, unknown> }>(
          'SELECT params FROM sensor_config WHERE object_id = $1',
          [sensor.id],
        );
        return row?.params ?? {};
      };

      // Where it goes left alone: carried, and nothing to say.
      await scripts.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { program: 'check.sh', args: ['https://api.example.invalid'] } },
        { kind: 'none' },
      );
      assert.equal((await stored())['secret'], SECRET);

      scripts.audit.recorded.length = 0;
      await scripts.service.update(
        testActor,
        sensor.id,
        {
          kind: 'sensor',
          params: { program: 'check.sh', args: ['https://listener.example.invalid'] },
        },
        { kind: 'none' },
      );
      assert.equal(Object.hasOwn(await stored(), 'secret'), false, 'the secret stayed behind');
      const read = await scripts.service.get(sensor.id);
      assert.ok(read.kind === 'sensor');
      assert.deepEqual(read.redactedParams, [], 'and nothing claims it is still set');

      const entry = scripts.audit.recorded.find((one) => one.action === 'object.updated');
      assert.ok(entry?.action === 'object.updated');
      assert.deepEqual(entry.secretsCleared, ['secret'], 'the history says what went');
      assert.ok(entry.changedParams.includes('secret'));
      assert.ok(!JSON.stringify(scripts.audit.recorded).includes(SECRET));
    });

    it('does not put the secret into the audit entry for the patch that kept it', async () => {
      // The value now passes through `update` even when the caller never sent it, so the audit
      // path has one more way to be handed a credential than it had before.
      const sensor = await createSensor({ community: SECRET, port: 161 });
      h.audit.recorded.length = 0;
      await h.service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { port: 1161 } },
        { kind: 'none' },
      );
      assert.ok(
        !JSON.stringify(h.audit.recorded).includes(SECRET),
        'a carried-forward secret reached the audit sink',
      );
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

    // ── a parameter the schema has since narrowed (`S-19`) ─────────────────────────────────

    it('reads a sensor stored before its schema narrowed, and refuses it only on a write', async () => {
      // `S-19` narrowed a script sensor's variables to `MS_VAR_*`. A sensor saved before that
      // is not rewritten — renaming a variable changes what its script sees — so it has to stay
      // readable, and renamable, until somebody writes its parameters. The probe refuses to run
      // it meanwhile, naming the variable; `exe-script.test.ts` has that half.
      const exeScript = BUILT_IN_SENSOR_TYPES.find((type) => type.id === 'exe.script');
      assert.ok(exeScript !== undefined);
      const scripted = await buildHarness(db, { types: [exeScript] });
      const made = await scripted.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'licence count',
        sensorType: 'exe.script',
        params: { program: 'licences.sh', env: [{ name: 'MS_VAR_POOL', value: 'main' }] },
      });
      const stored = [{ name: 'API_URL', value: 'https://licences.example.invalid' }];
      await db.query(
        `UPDATE sensor_config SET params = jsonb_set(params, '{env}', $2::jsonb)
         WHERE object_id = $1`,
        [made.id, JSON.stringify(stored)],
      );

      const read = await scripted.service.get(made.id);
      assert.deepEqual((read as { params?: Record<string, unknown> }).params?.['env'], stored);

      const renamed = await scripted.service.update(
        testActor,
        made.id,
        { kind: 'sensor', name: 'licences in use' },
        { kind: 'none' },
      );
      assert.equal(renamed.name, 'licences in use');

      const error = await rejects(() =>
        scripted.service.update(
          testActor,
          made.id,
          { kind: 'sensor', params: { program: 'licences.sh', env: stored } },
          { kind: 'none' },
        ),
      );
      assert.equal(error.code, 'OBJECT_INVALID');
      const problems = error.details['problems'] as { path: string }[];
      assert.ok(problems.some((problem) => problem.path === '/env/0/name'));

      // And the fix goes through.
      await scripted.service.update(
        testActor,
        made.id,
        {
          kind: 'sensor',
          params: { program: 'licences.sh', env: [{ name: 'MS_VAR_API_URL', value: 'x' }] },
        },
        { kind: 'none' },
      );
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
        ['core.factory', 'icmp.ping', 'ms.core.health', 'ms.probe.health', 'snmp.traffic'],
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

    it('says which types have a mapping language to preview', async () => {
      // The form reads this instead of asking `if (type === 'rest.custom')`, which is the same
      // rule `listener` and `evaluatedBy` follow: adding a type stays a one-file job.
      const items = (await mapping.inject({ method: 'GET', url: '/api/v1/sensor-types' })).json<{
        items: { id: string; hasPreview: boolean }[];
      }>().items;
      assert.equal(items.find((item) => item.id === 'rest.custom')?.hasPreview, true);
      assert.equal(items.find((item) => item.id === 'icmp.ping')?.hasPreview, false);
    });

    // ── the mapping preview (`U-13`) ────────────────────────────────────────────────────────

    describe('previewing a mapping over HTTP', () => {
      const preview = (
        body: Record<string, unknown>,
        typeId = 'rest.custom',
      ): Promise<LightMyRequestResponse> =>
        mapping.inject({
          method: 'POST',
          url: `/api/v1/sensor-types/${typeId}/preview`,
          payload: body,
        });

      const CLUSTER = JSON.stringify({
        status: 'healthy',
        queue: { depth: 12 },
        nodes: [{ load: 0.4 }, { load: 0.95 }],
      });

      it('runs the type’s own paths over the document in the request', async () => {
        const response = await preview({
          document: CLUSTER,
          contentType: 'application/json',
          params: {
            extract: [
              { key: 'depth', path: '$.queue.depth' },
              { key: 'worst', path: '$.nodes[*].load', aggregate: 'max' },
            ],
          },
        });
        assert.equal(response.statusCode, 200);

        const result = response.json<{
          format: string;
          rows: { key: string; value: number | null; selectedCount: number }[];
          problems: string[];
        }>();
        assert.equal(result.format, 'json');
        assert.deepEqual(
          result.rows.map((row) => [row.key, row.value]),
          [
            ['depth', 12],
            ['worst', 0.95],
          ],
        );
        assert.deepEqual(result.problems, []);
      });

      it('keeps every field of a row, since the response schema strips what it does not name', async () => {
        // `additionalProperties: false` on a Fastify response schema silently removes a field
        // the schema forgot, and a preview missing `selected` or `numeric` would look like a
        // path that found nothing.
        const response = await preview({
          document: CLUSTER,
          params: { extract: [{ key: 'loads', path: '$.nodes[*].load' }] },
        });
        const row = response.json<{
          rows: { selected: { text: string; numeric: boolean }[]; selectedCount: number }[];
        }>().rows[0];
        assert.ok(row !== undefined, 'no row came back at all');
        assert.deepEqual(row.selected, [
          { text: '0.4', numeric: true },
          { text: '0.95', numeric: true },
        ]);
        assert.equal(row.selectedCount, 2);
      });

      it('passes the pasted Content-Type through, since it decides how the document is read', async () => {
        // A fragment starting with `<` looks like XML to the format guess; `text/html` is what
        // says it is an error page rather than data. A route that dropped the header would
        // read one as the other, and nothing about the rows would say so.
        const fragment = '<div>hello</div>';
        const guessed = (await preview({ document: fragment, params: {} })).json<{
          format: string;
        }>();
        assert.equal(guessed.format, 'xml');

        const told = (
          await preview({ document: fragment, contentType: 'text/html', params: {} })
        ).json<{ format: string }>();
        assert.equal(told.format, 'json');
      });

      it('answers a half-typed path with a row that says so, not with a 400', async () => {
        const response = await preview({
          document: CLUSTER,
          params: { extract: [{ key: 'broken', path: '$.nodes[?(@.load' }] },
        });
        assert.equal(response.statusCode, 200, 'this is the normal state of the form');
        const result = response.json<{ rows: { error?: string }[]; problems: string[] }>();
        assert.ok(result.rows[0]?.error !== undefined);
        assert.ok(result.problems.length > 0);
      });

      it('reports a document that did not parse as the document’s problem', async () => {
        const result = (
          await preview({ document: '<html>nope</html>', params: { extract: [] } })
        ).json<{ error?: string; rows: unknown[] }>();
        assert.match(result.error ?? '', /not JSON/);
        assert.deepEqual(result.rows, []);
      });

      it('refuses a type with no mapping language, and says which', async () => {
        // 400 rather than 404: the type exists and the thing being asked of it does not, so a
        // 404 would send a client looking for a typo in an id it spelled right.
        const response = await preview({ document: '{}', params: {} }, 'icmp.ping');
        assert.equal(response.statusCode, 400);
        assert.match(response.json<{ error: { message: string } }>().error.message, /icmp\.ping/);
      });

      it('404s a type nobody registered', async () => {
        const response = await preview({ document: '{}', params: {} }, 'not.a.type');
        assert.equal(response.statusCode, 404);
      });

      it('refuses a document larger than a preview reads', async () => {
        // Bounded well below what the sensor itself will read: this one is walked once per path
        // while somebody types.
        const response = await preview({ document: 'x'.repeat(300_000), params: {} });
        assert.equal(response.statusCode, 400);
      });

      it('stores nothing and fetches nothing', async () => {
        // The property that makes this safe to expose: it is a pure function of the request.
        const before = await db.query<{ n: string }>('SELECT count(*) AS n FROM object');
        await preview({
          document: CLUSTER,
          params: { extract: [{ key: 'depth', path: '$.queue.depth' }] },
        });
        const after = await db.query<{ n: string }>('SELECT count(*) AS n FROM object');
        assert.equal(after[0]?.n, before[0]?.n);
        assert.deepEqual(h.audit.recorded, [], 'and nothing to audit, because nothing changed');
      });
    });
  },
);

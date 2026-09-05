import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { render } from '../src/notifications/placeholders.js';
import { TemplateService } from '../src/notifications/templates.js';
import { OBJECT_LOCATION } from '../src/settings/registry.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * `N-06`: where the facts in a message come from.
 *
 * `placeholders.test.ts` proves the substitution rules against a context handed to it. This
 * proves the context is real — that `%device` is the *nearest* device however deep the sensor
 * sits, that `%location` comes from the one inheritance resolver rather than a second
 * parent-walk, and that `%lastvalue` is a reading somebody actually took.
 */
describe(
  'the facts a message is built from',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let loader: MessageContextLoader;
    let templates: TemplateService;
    let probeId: number;
    let outerId: number;
    let innerId: number;
    let deviceId: number;
    let sensorId: number;
    let rttChannel: number;

    before(async () => {
      scratch = await createScratchDatabase('msgcontext');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      loader = new MessageContextLoader({
        settings: h.resolver,
        publicUrl: 'https://monitoring.example.test/',
        siteName: 'Acme production',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts: loader,
      });

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
        catalogue: testCatalogue(),
        templates,
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_template');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      // Deliberately deep: probe → group → group → device → sensor. "The group" means the
      // nearest one, and a fixed-depth join would report the wrong one — or none.
      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Local probe',
        })
      ).id;
      outerId = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'Europe' })
      ).id;
      innerId = (
        await h.service.create(testActor, { kind: 'group', parentId: outerId, name: 'Frankfurt' })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: innerId,
          name: 'edge-router',
          host: '192.0.2.7',
          tags: ['core', 'wan'],
          priority: 2,
          comments: 'replaced the SFP in March',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Ping',
          sensorType: 'icmp.ping',
          tags: ['latency'],
          priority: 1,
          comments: 'watched by the NOC',
        })
      ).id;

      const channels = await db.query<{ id: string; key: string }>(
        'SELECT id::text AS id, key FROM channel WHERE sensor_id = $1',
        [sensorId],
      );
      rttChannel = Number(channels.find((row) => row.key === 'rtt')?.id ?? 0);
    });

    /**
     * A starting instant far enough in the past that a sequence of scans stays behind the clock.
     *
     * `%lastvalue` reads the newest sample *up to now*, bounded on both sides — a probe whose
     * clock runs fast must not be able to make a message quote a value nothing has measured yet.
     * A test writing samples a minute into the future would fail that bound, and be right to.
     */
    const startAt = (): Date => new Date(Date.now() - 600_000);

    /** One scan, written the way ingestion writes it. */
    async function scan(ok: boolean, when: Date, value?: number): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = [
        {
          sensorId,
          at: when,
          outcome: ok ? 'ok' : 'error',
          message: ok ? 'reachable' : 'no ICMP reply from 192.0.2.7',
        },
      ];
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        if (value !== undefined) {
          await q.query('INSERT INTO sample (time, channel_id, value) VALUES ($1, $2, $3)', [
            when,
            rttChannel,
            value,
          ]);
        }
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    async function contextFor(
      observed: number | null = null,
    ): Promise<
      ReturnType<MessageContextLoader['loadFor']> extends Promise<Map<number, infer T>> ? T : never
    > {
      const now = new Date();
      const runtime = await db.query<{ state: string; message: string }>(
        'SELECT state, message FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      const contexts = await loader.loadFor(
        db,
        [
          {
            id: 1,
            sensorId,
            at: now,
            state: (runtime[0]?.state ?? 'unknown') as 'down',
            message: runtime[0]?.message ?? '',
            observed,
          },
        ],
        now,
      );
      const context = contexts.get(1);
      assert.ok(context !== undefined);
      return context;
    }

    // -------------------------------------------------------------------------------------
    // Ancestry.
    // -------------------------------------------------------------------------------------

    it('names the nearest object of each kind, however deep the sensor sits', async () => {
      await scan(true, new Date(), 12);
      const context = await contextFor();
      assert.equal(context.sensorName, 'Ping');
      assert.equal(context.deviceName, 'edge-router');
      assert.equal(context.groupName, 'Frankfurt', 'the nearest group, not the outermost');
      assert.equal(context.probeName, 'Local probe');
      assert.equal(context.host, '192.0.2.7', 'from the device, which is where a host lives');
    });

    it('reads the sensor’s own comments and priority, not the device’s', async () => {
      // Both exist on both objects, and a join that grabbed the wrong row would look right in a
      // test where they matched.
      await scan(true, new Date(), 12);
      const context = await contextFor();
      assert.equal(context.comments, 'watched by the NOC');
      assert.equal(context.priority, 1);
    });

    it('renders inherited tags as well as the sensor’s own', async () => {
      // CAPABILITIES.MD §1 makes "tags + inherited parent tags" a v1 capability, and the object
      // filter already resolves them that way — a message showing only the sensor's own would
      // disagree with the search that found it. Sorted, so the list is the same every time.
      await scan(true, new Date(), 12);
      assert.deepEqual((await contextFor()).tags, ['core', 'latency', 'wan']);
    });

    it('resolves %location through the inheritance resolver', async () => {
      // Set on a group, read by a sensor four levels down. `CLAUDE.md`: inheritance is resolved
      // in one place, and this is that place rather than a second parent-walk.
      await scan(true, new Date(), 12);
      assert.equal((await contextFor()).location, '', 'nothing set');

      await h.resolver.set(innerId, OBJECT_LOCATION.key, 'DC1, rack 14');
      assert.equal((await contextFor()).location, 'DC1, rack 14');

      // And an override nearer the sensor wins, like any other setting.
      await h.resolver.set(deviceId, OBJECT_LOCATION.key, 'DC1, rack 15');
      assert.equal((await contextFor()).location, 'DC1, rack 15');
    });

    // -------------------------------------------------------------------------------------
    // State and readings.
    // -------------------------------------------------------------------------------------

    it('reads the state it changed from', async () => {
      const base = startAt();
      await scan(true, base, 12);
      await scan(false, new Date(base.getTime() + 60_000));
      await scan(false, new Date(base.getTime() + 120_000));

      const context = await contextFor();
      assert.equal(context.state, 'down');
      assert.equal(context.previousState, 'warning', 'the two-step rule went through Warning');
      assert.equal(context.since.getTime(), base.getTime() + 120_000);
    });

    it('has no previous state for a sensor that has only ever had one', async () => {
      const context = await contextFor();
      assert.equal(context.previousState, null, 'not "unknown", which is a state it could be in');
    });

    it('reads the primary channel’s latest value', async () => {
      const base = startAt();
      await scan(true, base, 10);
      await scan(true, new Date(base.getTime() + 60_000), 42);
      assert.equal((await contextFor()).lastValue, 42);
    });

    it('prefers the value the notification is about', async () => {
      // A threshold notification (N-03) carries the number that breached, frozen when the
      // obligation fell due. The channel has moved on since, and a message quoting where it is
      // now would describe a different breach.
      const base = startAt();
      await scan(true, base, 10);
      assert.equal((await contextFor(812)).lastValue, 812);
    });

    it('reports no reading rather than zero', async () => {
      // No-data is not zero (CLAUDE.md).
      await scan(false, new Date());
      assert.equal((await contextFor()).lastValue, null);
    });

    it('carries the installation’s own facts', async () => {
      const context = await contextFor();
      assert.equal(context.publicUrl, 'https://monitoring.example.test/');
      assert.equal(context.siteName, 'Acme production');
    });

    it('builds a message for a sensor that has been deleted', async () => {
      // The notification is still owed — somebody was told an outage started — so it is built
      // from what the request carries rather than dropped.
      const now = new Date();
      const contexts = await loader.loadFor(
        db,
        [
          {
            id: 7,
            sensorId: 999_999,
            at: now,
            state: 'down',
            message: 'gone',
            observed: null,
          },
        ],
        now,
      );
      const context = contexts.get(7);
      assert.ok(context !== undefined);
      assert.equal(context.sensorName, 'sensor 999999');
      assert.equal(context.message, 'gone');
    });

    it('loads a batch in one pass', async () => {
      // What N-11 asks for when it assembles a digest. A loader that queried per notification
      // would be slowest exactly when the system is busiest.
      await scan(true, new Date(), 12);
      const now = new Date();
      const pending = Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        sensorId,
        at: now,
        state: 'down' as const,
        message: `message ${String(index)}`,
        observed: null,
      }));
      const contexts = await loader.loadFor(db, pending, now);
      assert.equal(contexts.size, 25);
      assert.equal(contexts.get(1)?.sensorName, 'Ping');
      assert.equal(contexts.get(25)?.message, 'message 24');
    });

    // -------------------------------------------------------------------------------------
    // End to end, through a template.
    // -------------------------------------------------------------------------------------

    it('renders a real template against a real sensor', async () => {
      const base = startAt();
      await scan(true, base, 10);
      await scan(false, new Date(base.getTime() + 60_000));
      await scan(false, new Date(base.getTime() + 120_000));
      await h.resolver.set(innerId, OBJECT_LOCATION.key, 'DC1, rack 14');

      const rendered = render(
        {
          subject: '%sitename: %sensor on %device is %status',
          body: '%group / %location (%host) — %lastmessage. Was %laststatus. %linksensor',
        },
        await contextFor(),
      );
      assert.equal(rendered.subject, 'Acme production: Ping on edge-router is down');
      assert.equal(
        rendered.body,
        'Frankfurt / DC1, rack 14 (192.0.2.7) — no ICMP reply from 192.0.2.7. Was warning. ' +
          `https://monitoring.example.test/objects/${String(sensorId)}`,
      );
      assert.deepEqual(rendered.unknown, []);
    });

    it('refuses a template that names a placeholder this build does not know', async () => {
      // N-06's second rule, enforced at the only moment anybody can act on it.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/templates',
        payload: {
          name: 'Typo',
          method: 'email',
          settings: {},
          subject: '%sensor is %stauts',
        },
      });
      assert.equal(response.statusCode, 400);
      const body = response.json<{ error: { code: string; details: { problems: string[] } } }>();
      assert.equal(body.error.code, 'TEMPLATE_INVALID');
      assert.ok(body.error.details.problems.some((problem) => problem.includes('%stauts')));
      // And it says what the valid names are, which is the difference between a refusal and a
      // dead end.
      assert.ok(body.error.details.problems.some((problem) => problem.includes('%lastmessage')));
    });

    it('previews a template over HTTP', async () => {
      const base = startAt();
      await scan(false, base);
      await scan(false, new Date(base.getTime() + 60_000));

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/templates',
        payload: {
          name: 'On-call',
          method: 'email',
          settings: {},
          subject: '%sensor on %device is %status',
          body: '%lastmessage',
          recipients: [{ kind: 'address', value: 'ops@example.test' }],
        },
      });
      assert.equal(created.statusCode, 201);
      const id = created.json<{ id: number }>().id;

      const preview = await app.inject({
        method: 'GET',
        url: `/api/v1/templates/${String(id)}/preview?sensorId=${String(sensorId)}`,
      });
      assert.equal(preview.statusCode, 200);
      const body = preview.json<{ subject: string; body: string; unknown: string[] }>();
      assert.equal(body.subject, 'Ping on edge-router is down');
      assert.equal(body.body, 'no ICMP reply from 192.0.2.7');
      assert.deepEqual(body.unknown, []);
    });

    it('404s a preview against a sensor that is not there', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/templates',
        payload: { name: 'On-call', method: 'email', settings: {}, subject: '%sensor' },
      });
      const id = created.json<{ id: number }>().id;
      const preview = await app.inject({
        method: 'GET',
        url: `/api/v1/templates/${String(id)}/preview?sensorId=999999`,
      });
      assert.equal(preview.statusCode, 404);
    });

    it('serves the placeholder list a form helps somebody write with', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notification-placeholders',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ items: { name: string; description: string }[] }>();
      assert.ok(body.items.length >= 17);
      assert.ok(body.items.every((item) => item.description.length > 0));
    });
  },
);

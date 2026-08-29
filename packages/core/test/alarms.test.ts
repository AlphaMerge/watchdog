import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { AlarmService, type AlarmPage } from '../src/state/alarms.js';
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
const NOW = new Date('2026-08-25T12:00:00.000Z');

describe(
  'the alarms list',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let alarms: AlarmService;

    let probeId: number;
    let berlin: number;
    let london: number;
    /** Two sensors under Berlin, one under London. */
    let ping: number;
    let http: number;
    let remote: number;

    before(async () => {
      scratch = await createScratchDatabase('alarms');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      alarms = new AlarmService({ db, logger: silent });

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
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
      await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');

      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: `probe-${String(process.hrtime.bigint())}`,
        })
      ).id;
      berlin = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'Berlin' })
      ).id;
      london = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'London' })
      ).id;

      const device = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: berlin,
          name: 'db-01',
          host: '192.0.2.10',
        })
      ).id;
      const far = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: london,
          name: 'web-01',
          host: '192.0.2.20',
        })
      ).id;

      ping = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device,
          name: 'Ping',
          sensorType: 'icmp.ping',
          priority: 5,
        })
      ).id;
      http = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device,
          name: 'HTTP',
          sensorType: 'icmp.ping',
          priority: 2,
        })
      ).id;
      remote = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: far,
          name: 'Remote ping',
          sensorType: 'icmp.ping',
          priority: 3,
        })
      ).id;
    });

    /** Drives the state machine, so every state under test is one the machine can produce. */
    async function report(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    /** Two failures, because one is a Warning under the default policy (`M-03`). */
    async function knockDown(sensorId: number, at: Date, message = 'ETIMEDOUT'): Promise<void> {
      await report([{ sensorId, at, outcome: 'error', message, channels: null }]);
      await report([
        {
          sensorId,
          at: new Date(at.getTime() + 60_000),
          outcome: 'error',
          message,
          channels: null,
        },
      ]);
    }

    async function list(query: Parameters<AlarmService['list']>[0]): Promise<AlarmPage> {
      return alarms.list(query);
    }

    // -----------------------------------------------------------------------------------------
    // What counts as an alarm.
    // -----------------------------------------------------------------------------------------

    it('is empty on a healthy installation, and says nothing rather than everything', async () => {
      await report([{ sensorId: ping, at: NOW, outcome: 'ok', message: 'ok', channels: null }]);
      const page = await list({ limit: 100 });
      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
      assert.deepEqual(page.counts, {});
    });

    it('leaves out a sensor nothing has scanned yet', async () => {
      // Unknown is a gap in coverage, not a fault. Every sensor in a fresh installation is
      // Unknown, and a list that opened with all of them would be one nobody reads.
      const page = await list({ limit: 100 });
      assert.deepEqual(page.items, []);
    });

    it('leaves out a sensor somebody paused, however Down it was first', async () => {
      // Deliberate silence is not a problem. A list that reports it is the list an operator
      // learns to scroll past, which is how the real alarm underneath gets missed.
      await knockDown(ping, NOW);
      assert.equal((await list({ limit: 100 })).items.length, 1);

      await h.service.pause(testActor, ping, { kind: 'indefinite' }, 'maintenance');
      assert.deepEqual((await list({ limit: 100 })).items, []);
    });

    it('includes a warning, which is one failure and not yet two', async () => {
      await report([
        { sensorId: ping, at: NOW, outcome: 'error', message: 'ETIMEDOUT', channels: null },
      ]);
      const page = await list({ limit: 100 });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.state, 'warning');
    });

    it('keeps an acknowledged alarm, because acknowledging is not fixing', async () => {
      await knockDown(ping, NOW);
      await h.service.acknowledge(testActor, ping, { kind: 'indefinite' }, 'engineer on site');

      const page = await list({ limit: 100 });
      assert.equal(page.items.length, 1);
      const alarm = page.items[0];
      assert.ok(alarm);
      assert.equal(alarm.state, 'down_acknowledged');
      assert.equal(alarm.acknowledged, true);
      assert.equal(alarm.message, 'engineer on site');
    });

    it('can hide the acknowledged ones, for the reader who wants what is unhandled', async () => {
      await knockDown(ping, NOW);
      await knockDown(http, NOW);
      await h.service.acknowledge(testActor, ping, { kind: 'indefinite' }, 'engineer on site');

      const page = await list({ limit: 100, includeAcknowledged: false });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [http],
      );
      // The counts still report it: a chip that hides its own subject is a chip that lies.
      assert.equal(page.counts['down_acknowledged'], 1);
    });

    // -----------------------------------------------------------------------------------------
    // Where each alarm is.
    // -----------------------------------------------------------------------------------------

    it('names the whole path, in ids and in names, root first', async () => {
      // "Ping is down" names nothing on an installation with forty devices.
      await knockDown(ping, NOW);
      const alarm = (await list({ limit: 100 })).items[0];
      assert.ok(alarm);
      assert.deepEqual(alarm.pathNames.slice(-3), ['Berlin', 'db-01', 'Ping']);
      assert.equal(alarm.path.length, alarm.pathNames.length);
      assert.equal(alarm.path[0], h.rootId, 'root first');
      assert.equal(alarm.path[alarm.path.length - 1], ping, 'sensor last');
    });

    it('scopes to a branch, and a branch means everything beneath it', async () => {
      await knockDown(ping, NOW);
      await knockDown(remote, NOW);

      const all = await list({ limit: 100 });
      assert.equal(all.items.length, 2);

      const inBerlin = await list({ limit: 100, objectId: berlin });
      assert.deepEqual(
        inBerlin.items.map((alarm) => alarm.sensorId),
        [ping],
      );

      const inLondon = await list({ limit: 100, objectId: london });
      assert.deepEqual(
        inLondon.items.map((alarm) => alarm.sensorId),
        [remote],
      );
    });

    it('scopes to a sensor itself, which is the degenerate branch', async () => {
      await knockDown(ping, NOW);
      await knockDown(http, NOW);
      const page = await list({ limit: 100, objectId: ping });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [ping],
      );
    });

    // -----------------------------------------------------------------------------------------
    // Order and filters.
    // -----------------------------------------------------------------------------------------

    it('sorts by priority then duration, which is what WORKFLOW.MD §7 asks for', async () => {
      // http (priority 2) breaks first, ping (5) second, remote (3) last. Priority wins, and
      // within a priority the one that has been wrong longest comes first.
      await knockDown(http, NOW);
      await knockDown(remote, new Date(NOW.getTime() + 600_000));
      await knockDown(ping, new Date(NOW.getTime() + 1_200_000));

      const page = await list({ limit: 100 });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [ping, remote, http],
      );
    });

    it('sorts by duration alone when asked what has been broken longest', async () => {
      await knockDown(http, NOW);
      await knockDown(ping, new Date(NOW.getTime() + 1_200_000));

      const page = await list({ limit: 100, sort: 'duration' });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [http, ping],
      );
    });

    it('filters by state without changing what the chips report', async () => {
      await knockDown(ping, NOW);
      await report([
        { sensorId: http, at: NOW, outcome: 'error', message: 'ETIMEDOUT', channels: null },
      ]);

      const page = await list({ limit: 100, states: ['down'] });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [ping],
      );
      assert.equal(page.total, 1);
      // The warning is filtered out of the list and still counted, so its chip can say "1".
      assert.equal(page.counts['warning'], 1);
      assert.equal(page.counts['down'], 1);
    });

    it('filters by priority', async () => {
      await knockDown(ping, NOW);
      await knockDown(http, NOW);
      const page = await list({ limit: 100, priorityMin: 4 });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [ping],
      );
      assert.equal(page.total, 1);
    });

    it('reports how many matched, so a truncated list can say what it is hiding', async () => {
      await knockDown(ping, NOW);
      await knockDown(http, NOW);
      await knockDown(remote, NOW);

      const page = await list({ limit: 1 });
      assert.equal(page.items.length, 1);
      assert.equal(page.total, 3, 'the count is of everything that matched, not of the page');
    });

    it('returns nothing at all when every state is filtered out', async () => {
      await knockDown(ping, NOW);
      const page = await list({ limit: 100, states: [] });
      assert.deepEqual(page.items, []);
    });

    it('still reports the chips when the filter emptied the list', async () => {
      // The empty-list path reads the counts separately; without it a reader filtering to
      // "errors only" on a warning-only installation would be told there is nothing at all.
      await report([
        { sensorId: http, at: NOW, outcome: 'error', message: 'ETIMEDOUT', channels: null },
      ]);
      const page = await list({ limit: 100, states: ['down'] });
      assert.deepEqual(page.items, []);
      assert.equal(page.counts['warning'], 1);
    });

    // -----------------------------------------------------------------------------------------
    // Over HTTP.
    // -----------------------------------------------------------------------------------------

    it('serves the list, and refuses to be cached', async () => {
      await knockDown(ping, NOW);
      const response = await app.inject({ method: 'GET', url: '/api/v1/alarms' });
      assert.equal(response.statusCode, 200);
      // The one view whose whole purpose is to be current.
      assert.equal(response.headers['cache-control'], 'no-store');

      const body = response.json<AlarmPage>();
      assert.equal(body.items.length, 1);
      const served = body.items[0];
      assert.ok(served);
      assert.equal(served.sensorName, 'Ping');
      assert.deepEqual(served.pathNames.slice(-1), ['Ping']);
    });

    it('takes its filters from the query string, one state or several', async () => {
      await knockDown(ping, NOW);
      await report([
        { sensorId: http, at: NOW, outcome: 'error', message: 'ETIMEDOUT', channels: null },
      ]);

      const one = await app.inject({
        method: 'GET',
        url: '/api/v1/alarms',
        query: { state: 'down' },
      });
      assert.equal(one.json<AlarmPage>().items.length, 1);

      const both = await app.inject({
        method: 'GET',
        url: '/api/v1/alarms?state=down&state=warning',
      });
      assert.equal(both.json<AlarmPage>().items.length, 2);
    });

    it('refuses a state that is not an alarm state', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/alarms',
        query: { state: 'paused' },
      });
      assert.equal(response.statusCode, 400);
    });
  },
);

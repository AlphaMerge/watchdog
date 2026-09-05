import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { SENSOR_STATES } from '../src/state/tables.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();
const NOW = new Date('2026-09-03T09:00:00.000Z');

interface CountsBody {
  objects: { probe: number; group: number; device: number; sensor: number; total: number };
  sensorStates: Record<string, number>;
}

/**
 * `GET /objects/{id}/counts` (`U-14`).
 *
 * The endpoint exists because the overview used to answer "how many sensors" by reading a page
 * of the tree and counting the rows. That is exact until an installation outgrows the page, and
 * then it is a lower bound presented as a total — which is the worst way for a number on a
 * status page to be wrong, because nothing about a number says it is partial. Two of the tests
 * below are the same subtree read both ways, so the difference cannot quietly come back.
 */
describe(
  'subtree counts',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let server: ApiServer;
    let app: FastifyInstance;

    let probeId: number;
    let berlin: number;
    let london: number;
    /** Four sensors under Berlin, two under London. */
    let sensors: number[];

    before(async () => {
      scratch = await createScratchDatabase('counts');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      server = new ApiServer({
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
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await server.stop();
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');

      const create = async (input: Parameters<Harness['service']['create']>[1]): Promise<number> =>
        (await h.service.create(testActor, input)).id;

      probeId = await create({
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      berlin = await create({ kind: 'group', parentId: probeId, name: 'Berlin' });
      london = await create({ kind: 'group', parentId: probeId, name: 'London' });
      const db01 = await create({
        kind: 'device',
        parentId: berlin,
        name: 'db-01',
        host: '192.0.2.10',
      });
      const web01 = await create({
        kind: 'device',
        parentId: london,
        name: 'web-01',
        host: '192.0.2.20',
      });

      sensors = [];
      for (const [parentId, name] of [
        [db01, 'Ping'],
        [db01, 'HTTP'],
        [db01, 'Disk'],
        [db01, 'Memory'],
        [web01, 'Ping'],
        [web01, 'HTTP'],
      ] as const) {
        sensors.push(await create({ kind: 'sensor', parentId, name, sensorType: 'icmp.ping' }));
      }
    });

    const counts = async (id: number): Promise<CountsBody> => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/objects/${String(id)}/counts` });
      assert.equal(res.statusCode, 200, res.body);
      return res.json<CountsBody>();
    };

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
    async function knockDown(sensorId: number): Promise<void> {
      for (const minute of [0, 1]) {
        await report([
          {
            sensorId,
            at: new Date(NOW.getTime() + minute * 60_000),
            outcome: 'error',
            message: 'ETIMEDOUT',
            channels: null,
          },
        ]);
      }
    }

    it('counts every object under the root, at any depth', async () => {
      const body = await counts(h.rootId);

      // The root itself is in `total` and in none of the four kinds, which is why the two do
      // not agree: 1 + 1 + 2 + 2 + 6.
      assert.deepEqual(body.objects, { probe: 1, group: 2, device: 2, sensor: 6, total: 12 });
    });

    it('is exact where counting a page of the tree is a lower bound', async () => {
      // What the overview did before `U-14`: read the tree and count what came back. Ask for
      // fewer rows than the subtree has and the answer is wrong with nothing saying so — the
      // `truncated` flag lives on the response, not on any of the numbers taken from it.
      const page = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(h.rootId)}/tree?maxDepth=12&limit=5`,
      });
      const tree = page.json<{ items: { kind: string }[]; truncated: boolean }>();
      assert.equal(tree.truncated, true);
      const countedFromTheTree = tree.items.filter((item) => item.kind === 'sensor').length;
      assert.ok(countedFromTheTree < 6, 'the page has to be short, or this proves nothing');

      const body = await counts(h.rootId);
      assert.equal(body.objects.sensor, 6, 'the aggregate has no page to be cut off by');
    });

    it('scopes to the branch asked about, itself included', async () => {
      const body = await counts(berlin);

      assert.deepEqual(body.objects, { probe: 0, group: 1, device: 1, sensor: 4, total: 6 });
      assert.deepEqual(
        (await counts(london)).objects,
        { probe: 0, group: 1, device: 1, sensor: 2, total: 4 },
        'and nothing from the other branch comes with it',
      );
    });

    it('reports the state of every sensor, including the ones nothing has scanned', async () => {
      const [ping, http] = sensors;
      assert.ok(ping !== undefined && http !== undefined);
      await knockDown(ping);
      await report([{ sensorId: http, at: NOW, outcome: 'ok', message: 'ok', channels: null }]);

      const body = await counts(h.rootId);

      assert.equal(body.sensorStates['down'], 1);
      assert.equal(body.sensorStates['up'], 1);
      // Unknown is a state, not a missing sensor: four have never reported (`M-02`).
      assert.equal(body.sensorStates['unknown'], 4);
    });

    it('carries a zero for every state, so a caller never has to guess at an absent key', async () => {
      const body = await counts(h.rootId);

      assert.deepEqual(Object.keys(body.sensorStates).sort(), [...SENSOR_STATES].sort());
      const summed = Object.values(body.sensorStates).reduce((a, b) => a + b, 0);
      assert.equal(summed, body.objects.sensor, 'the histogram accounts for every sensor');
    });

    it('is a 404 for an object that does not exist, not an empty tally', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/objects/999999/counts' });
      assert.equal(res.statusCode, 404);
    });
  },
);

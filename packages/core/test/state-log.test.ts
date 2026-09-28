import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { StateLogService, type StateLogEntry } from '../src/timeseries/state-log.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { Reach, Visibility } from '../src/auth/access.js';

const available = await databaseAvailable();
const T0 = new Date('2026-08-25T12:00:00.000Z');

/** Minutes after T0, so the fixtures read as a timeline rather than as ISO strings. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

describe(
  'the state-change log',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let log: StateLogService;
    let probeId: number;
    let groupId: number;
    let deviceId: number;
    let sensorId: number;
    let siblingId: number;
    let otherGroupSensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('statelog');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      log = new StateLogService({ db, logger: silent });

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
      probeId = probe.id;
      groupId = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'watched' })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'app-server',
          host: '192.0.2.40',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      siblingId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'HTTP',
          sensorType: 'icmp.ping',
        })
      ).id;

      const elsewhere = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'elsewhere',
      });
      const otherDevice = await h.service.create(testActor, {
        kind: 'device',
        parentId: elsewhere.id,
        name: 'other',
        host: '192.0.2.41',
      });
      otherGroupSensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: otherDevice.id,
          name: 'Other ping',
          sensorType: 'icmp.ping',
        })
      ).id;

      // Every test reads a whole-installation log unless it scopes; leftovers from an earlier
      // one would be counted alongside.
      await db.query('DELETE FROM sensor_state');
      h.audit.recorded.length = 0;
    });

    async function report(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    /** Up at 0, Down at 1 and 2 (the two-step), Up again at 30. */
    async function outage(id: number): Promise<void> {
      await report([{ sensorId: id, at: at(0), outcome: 'ok', message: 'reachable' }]);
      await report([{ sensorId: id, at: at(1), outcome: 'error', message: 'no reply' }]);
      await report([{ sensorId: id, at: at(2), outcome: 'error', message: 'no reply' }]);
      await report([{ sensorId: id, at: at(30), outcome: 'ok', message: 'reachable' }]);
    }

    // -------------------------------------------------------------------------------------
    // What it records.
    // -------------------------------------------------------------------------------------

    it('has every transition, with what it changed from, why, and what the check said', async () => {
      await outage(sensorId);
      const { items } = await log.list({ visibility: Visibility.EVERYTHING, limit: 100 });

      assert.deepEqual(
        items.map((entry) => `${entry.previousState ?? '-'}->${entry.state}:${entry.cause}`),
        ['down->up:scan', 'warning->down:scan', 'up->warning:scan', 'unknown->up:scan'],
        'newest first',
      );
      assert.equal(items[1]?.message, 'no reply', "the check's own words, not a summary");
      assert.equal(items[0]?.sensorName, 'Ping');
    });

    it('measures how long each state lasted, and leaves the current one open', async () => {
      await outage(sensorId);
      const { items } = await log.list({ visibility: Visibility.EVERYTHING, limit: 100 });

      // Newest first: Up (still running), Down (28 min), Warning (1 min), Up (1 min).
      assert.equal(items[0]?.durationMs, null, 'the state it is still in');
      assert.equal(items[1]?.durationMs, 28 * 60_000);
      assert.equal(items[2]?.durationMs, 1 * 60_000);
      assert.equal(items[3]?.durationMs, 1 * 60_000);
    });

    it('records a cause change even when the state does not move (§5 invariant 10)', async () => {
      // Uptime is computed from these rows, so a Warning that became a *different* Warning has
      // to be here — the operator's question is "why", and the answer changed.
      await report([{ sensorId, at: at(0), outcome: 'error', message: 'no reply' }]);
      await h.service.simulateError(
        testActor,
        sensorId,
        true,
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'chain test',
      );
      await h.service.simulateError(
        testActor,
        sensorId,
        false,
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
      );

      const { items } = await log.list({
        visibility: Visibility.EVERYTHING,
        objectId: sensorId,
        limit: 100,
      });
      const causes = items.map((entry) => `${entry.state}:${entry.cause}`);
      assert.ok(causes.includes('down:simulated'), causes.join(', '));
    });

    // -------------------------------------------------------------------------------------
    // Scoping and filtering.
    // -------------------------------------------------------------------------------------

    it('scopes to a branch, which is the question the Logs view asks', async () => {
      await outage(sensorId);
      await outage(otherGroupSensorId);

      const scoped = await log.list({
        visibility: Visibility.EVERYTHING,
        objectId: groupId,
        limit: 100,
      });
      assert.ok(scoped.items.every((entry) => entry.sensorId === sensorId));

      const everything = await log.list({ visibility: Visibility.EVERYTHING, limit: 100 });
      assert.ok(everything.items.some((entry) => entry.sensorId === otherGroupSensorId));
    });

    it('scopes to one sensor, which is the detail page-s log tab', async () => {
      await outage(sensorId);
      await outage(siblingId);
      const { items } = await log.list({
        visibility: Visibility.EVERYTHING,
        objectId: sensorId,
        limit: 100,
      });
      assert.ok(items.length > 0);
      assert.ok(items.every((entry) => entry.sensorId === sensorId));
    });

    it('filters by state and by cause', async () => {
      await outage(sensorId);
      const down = await log.list({
        visibility: Visibility.EVERYTHING,
        states: ['down'],
        limit: 100,
      });
      assert.ok(down.items.every((entry) => entry.state === 'down'));
      assert.equal(down.items.length, 1);

      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      const paused = await log.list({
        visibility: Visibility.EVERYTHING,
        causes: ['user'],
        limit: 100,
      });
      assert.equal(paused.items.length, 1);
      const entry = paused.items[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.state, 'paused');
      assert.equal(entry.message, 'maintenance');
    });

    it('filters by time, both ends', async () => {
      await outage(sensorId);
      const { items } = await log.list({
        visibility: Visibility.EVERYTHING,
        from: at(1),
        to: at(2),
        limit: 100,
      });
      assert.deepEqual(
        items.map((entry) => entry.state),
        ['down', 'warning'],
      );
    });

    // -------------------------------------------------------------------------------------
    // Paging.
    // -------------------------------------------------------------------------------------

    it('pages newest-first without repeating or skipping a row', async () => {
      await outage(sensorId);
      await outage(siblingId);

      const seen: StateLogEntry[] = [];
      let before: string | null | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await log.list({
          visibility: Visibility.EVERYTHING,
          limit: 3,
          ...(before == null ? {} : { before }),
        });
        seen.push(...result.items);
        before = result.nextBefore;
        if (before === null) break;
      }

      assert.equal(seen.length, 8, 'four transitions each, no more and no fewer');
      const keys = seen.map((entry) => `${entry.at}:${String(entry.sensorId)}`);
      assert.equal(new Set(keys).size, keys.length, 'nothing was served twice');
      const times = seen.map((entry) => Date.parse(entry.at));
      assert.deepEqual(
        [...times].sort((a, b) => b - a),
        times,
        'still newest first across pages',
      );
    });

    it('measures a duration against the real next transition, not the next one on the page', async () => {
      // The reason it is a lateral join and not a window function: otherwise the same transition
      // reads "28 minutes" or "still running" according to where the page boundary fell.
      await outage(sensorId);
      const whole = await log.list({
        visibility: Visibility.EVERYTHING,
        objectId: sensorId,
        limit: 100,
      });
      const paged = await log.list({
        visibility: Visibility.EVERYTHING,
        objectId: sensorId,
        limit: 1,
      });
      assert.equal(paged.items[0]?.durationMs, whole.items[0]?.durationMs);

      const second = await log.list({
        visibility: Visibility.EVERYTHING,
        objectId: sensorId,
        limit: 1,
        before: paged.nextBefore ?? '',
      });
      assert.equal(second.items[0]?.durationMs, whole.items[1]?.durationMs);
      assert.equal(second.items[0]?.durationMs, 28 * 60_000);
    });

    it('refuses a cursor it did not issue, rather than serving page one again', async () => {
      await assert.rejects(
        () => log.list({ visibility: Visibility.EVERYTHING, limit: 10, before: 'not-a-cursor' }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'CURSOR_INVALID');
          return true;
        },
      );
    });

    // -------------------------------------------------------------------------------------
    // History outlives its sensor.
    // -------------------------------------------------------------------------------------

    it('keeps a deleted sensor-s transitions, with an empty name rather than nothing', async () => {
      await outage(sensorId);
      await h.service.delete(testActor, sensorId, { kind: 'leafOnly' }, { kind: 'none' });

      const { items } = await log.list({ visibility: Visibility.EVERYTHING, limit: 100 });
      const orphaned = items.filter((entry) => entry.sensorId === sensorId);
      assert.equal(orphaned.length, 4, 'the outage is still answerable');
      assert.equal(orphaned[0]?.sensorName, '');
    });

    // -------------------------------------------------------------------------------------
    // Over HTTP.
    // -------------------------------------------------------------------------------------

    it('serves the log, scoped and filtered, and never lets a client cache it', async () => {
      await outage(sensorId);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/state-log?objectId=${String(groupId)}&state=down&limit=10`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');

      const body = response.json<{ items: StateLogEntry[]; nextBefore: string | null }>();
      assert.equal(body.items.length, 1);
      const only = body.items[0];
      assert.ok(only !== undefined);
      assert.equal(only.state, 'down');
      assert.equal(only.sensorName, 'Ping');
      assert.equal(body.nextBefore, null, 'a short page is the last page');
    });

    it('takes repeated filters, so a UI can ask for Down or Warning in one request', async () => {
      await outage(sensorId);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/state-log?state=down&state=warning&limit=10',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ items: StateLogEntry[] }>();
      assert.deepEqual(
        body.items.map((entry) => entry.state),
        ['down', 'warning'],
      );
    });

    it('rejects a state nobody has, and a date that is not one', async () => {
      const badState = await app.inject({ method: 'GET', url: '/api/v1/state-log?state=green' });
      assert.equal(badState.statusCode, 400);
      const badDate = await app.inject({ method: 'GET', url: '/api/v1/state-log?from=yesterday' });
      assert.equal(badDate.statusCode, 400);
    });

    it('says how far back it goes, so a UI can distinguish empty from pruned', async () => {
      await outage(sensorId);
      assert.equal(await log.horizon(), at(0).toISOString());
    });
  },
);

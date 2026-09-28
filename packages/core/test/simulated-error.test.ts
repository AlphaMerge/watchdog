import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { Visibility } from '../src/auth/access.js';

const available = await databaseAvailable();
const NOW = new Date('2026-08-25T12:00:00.000Z');

describe(
  'simulated error',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let probeId: number;
    let groupId: number;
    let deviceId: number;
    let sensorId: number;
    let siblingId: number;

    before(async () => {
      scratch = await createScratchDatabase('simulated');
      db = scratch.db;
      h = await buildHarness(db, { states: true });

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
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'group' })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'device',
          host: '192.0.2.30',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Subject',
          sensorType: 'icmp.ping',
        })
      ).id;
      siblingId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Sibling',
          sensorType: 'icmp.ping',
        })
      ).id;
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

    async function runtimeOf(id: number): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      simulated: boolean;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        message: string;
        simulated_error: boolean;
      }>('SELECT state, cause, message, simulated_error FROM sensor_runtime WHERE object_id = $1', [
        id,
      ]);
      const row = rows[0];
      assert.ok(row !== undefined, `no runtime row for ${String(id)}`);
      return {
        state: row.state,
        cause: row.cause,
        message: row.message,
        simulated: row.simulated_error,
      };
    }

    // -------------------------------------------------------------------------------------
    // Forcing.
    // -------------------------------------------------------------------------------------

    it('forces a healthy sensor Down, with a cause nobody can confuse for a real one', async () => {
      await report([{ sensorId, at: NOW, outcome: 'ok', message: 'reachable' }]);
      assert.equal((await runtimeOf(sensorId)).state, 'up');

      const view = await h.service.simulateError(
        testActor,
        sensorId,
        true,
        Visibility.EVERYTHING,
        'testing the pager',
      );
      assert.deepEqual(view.sensors, [sensorId]);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'down');
      // `simulated`, never `scan`: a forced outage must not be mistakable for a real one, in
      // the UI or in the log.
      assert.equal(current.cause, 'simulated');
      assert.equal(current.message, 'testing the pager');
    });

    it('records the transition, so a notification chain has something to fire on', async () => {
      await report([{ sensorId, at: NOW, outcome: 'ok', message: 'reachable' }]);
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'chain test');

      const rows = await db.query<{ previous_state: string; state: string; cause: string }>(
        `SELECT previous_state, state, cause FROM sensor_state
         WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1`,
        [sensorId],
      );
      const transition = rows[0];
      assert.ok(transition !== undefined);
      assert.equal(transition.previous_state, 'up');
      assert.equal(transition.state, 'down');
      assert.equal(transition.cause, 'simulated');
    });

    it('keeps scanning it, so lifting the force needs no round trip to find out the truth', async () => {
      const config = new ProbeConfigService({ db, resolver: h.resolver });
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, '');
      const scheduled = (await config.assignmentsFor(probeId)).sensors.map((s) => s.sensorId);
      assert.ok(scheduled.includes(sensorId), 'the force changes what readings mean, not whether');
    });

    it('forces every sensor beneath a container, whatever state each was in', async () => {
      await report([
        { sensorId, at: NOW, outcome: 'ok', message: 'reachable' },
        { sensorId: siblingId, at: NOW, outcome: 'error', message: 'nope' },
      ]);

      const view = await h.service.simulateError(
        testActor,
        deviceId,
        true,
        Visibility.EVERYTHING,
        'storm test',
      );
      assert.deepEqual(
        [...view.sensors].sort((a, b) => a - b),
        [sensorId, siblingId].sort((a, b) => a - b),
      );
      assert.equal((await runtimeOf(sensorId)).cause, 'simulated');
      assert.equal((await runtimeOf(siblingId)).cause, 'simulated');
    });

    it('refuses on an object with no sensors under it, rather than doing nothing quietly', async () => {
      const empty = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'empty',
      });
      await assert.rejects(
        () => h.service.simulateError(testActor, empty.id, true, Visibility.EVERYTHING, ''),
        (error: unknown) => {
          assert.ok((error as Error).message.includes('no sensors here'));
          return true;
        },
      );
    });

    // -------------------------------------------------------------------------------------
    // Lifting it.
    // -------------------------------------------------------------------------------------

    it('returns the sensor to what it actually measures, with no scan in between', async () => {
      await report([{ sensorId, at: NOW, outcome: 'ok', message: 'reachable' }]);
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'testing');
      assert.equal((await runtimeOf(sensorId)).state, 'down');

      await h.service.simulateError(testActor, sensorId, false, Visibility.EVERYTHING);
      const current = await runtimeOf(sensorId);
      // Unlike a resume, which yields Unknown: a forced sensor never stopped being scanned, so
      // its last reading is current and there is nothing to wait for.
      assert.equal(current.state, 'up');
      assert.equal(current.cause, 'scan');
      assert.equal(current.simulated, false);
    });

    it('does nothing, and records nothing, when the force is already what was asked for', async () => {
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'once');
      h.audit.recorded.length = 0;
      const view = await h.service.simulateError(
        testActor,
        sensorId,
        true,
        Visibility.EVERYTHING,
        'again',
      );
      assert.deepEqual(view.sensors, []);
      assert.equal(
        h.audit.recorded.filter((m) => m.action === 'sensor.simulatedError').length,
        0,
        'a second force is not an event',
      );
    });

    // -------------------------------------------------------------------------------------
    // Where it sits in §2.
    // -------------------------------------------------------------------------------------

    it('loses to a pause, so a sensor somebody switched off does not start paging people', async () => {
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'testing');
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'maintenance');

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'paused');
      assert.equal(current.cause, 'parent');
      assert.equal(current.simulated, true, 'still set, simply outranked');
    });

    it('comes back when the pause lifts, because the force was never withdrawn', async () => {
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'testing');
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      await h.service.resume(testActor, sensorId);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'down');
      assert.equal(current.cause, 'simulated');
    });

    it('beats a real reading: that is the whole point of forcing one', async () => {
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'testing');
      await report([
        { sensorId, at: new Date(NOW.getTime() + 60_000), outcome: 'ok', message: 'reachable' },
      ]);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'down');
      assert.equal(current.cause, 'simulated');
    });

    it('still triggers a dependency, because §3 asks whether the master is Down', async () => {
      await h.service.setDependency(testActor, siblingId, 'object', sensorId, undefined);
      await h.service.simulateError(testActor, sensorId, true, Visibility.EVERYTHING, 'chain test');
      await db.tx(async (q) => {
        await h.dependencies?.recompute(q, new Date());
      });

      // Which is right: the point of a simulated error is that everything downstream behaves as
      // it would in a real outage, and dependency pausing is part of what a chain test exercises.
      assert.equal((await runtimeOf(siblingId)).state, 'paused');
      assert.equal((await runtimeOf(siblingId)).cause, 'dependency');
    });

    // -------------------------------------------------------------------------------------
    // Over HTTP.
    // -------------------------------------------------------------------------------------

    it('forces and lifts over HTTP, and says so in the state read', async () => {
      const forced = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(sensorId)}/simulate-error`,
        payload: { message: 'testing the on-call rotation' },
      });
      assert.equal(forced.statusCode, 200);
      assert.deepEqual(forced.json<{ sensors: number[] }>().sensors, [sensorId]);

      const state = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/state`,
      });
      const view = state.json<{ state: string; cause: string; simulatedError: boolean }>();
      assert.equal(view.state, 'down');
      assert.equal(view.cause, 'simulated');
      assert.equal(view.simulatedError, true);

      const lifted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(sensorId)}/simulate-error`,
      });
      assert.equal(lifted.statusCode, 200);
      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/state`,
      });
      assert.equal(after.json<{ simulatedError: boolean }>().simulatedError, false);
    });

    it('audits who forced it, how many, and what they said they were testing', async () => {
      await h.service.simulateError(
        testActor,
        deviceId,
        true,
        Visibility.EVERYTHING,
        'quarterly chain test',
      );
      const recorded = h.audit.recorded.filter((m) => m.action === 'sensor.simulatedError');
      assert.equal(recorded.length, 1);
      const entry = recorded[0];
      assert.ok(entry?.action === 'sensor.simulatedError');
      assert.equal(entry.simulated, true);
      assert.equal(entry.message, 'quarterly chain test');
      assert.equal(entry.sensorsAffected, 2);
    });

    it('keeps the operator words when the next scan comes back healthy', async () => {
      // A forced sensor is still scanned — the force changes what its readings *mean*, not
      // whether it takes any. Letting that scan's message through left the sensor reading
      // "Down — 2/2 replies, min 0.072 ms", which is a row nobody can make sense of and which
      // U-06 puts on the operator's home screen.
      await h.service.simulateError(
        testActor,
        sensorId,
        true,
        Visibility.EVERYTHING,
        'testing the chain',
      );
      assert.equal((await runtimeOf(sensorId)).message, 'testing the chain');

      await report([
        {
          sensorId,
          at: new Date(NOW.getTime() + 60_000),
          outcome: 'ok',
          message: '2/2 replies, min 0.072 ms',
          channels: null,
        },
      ]);

      const after = await runtimeOf(sensorId);
      assert.equal(after.state, 'down');
      assert.equal(after.cause, 'simulated');
      assert.equal(after.message, 'testing the chain', 'the operator still owns the explanation');
    });

    it('hands the message back to the probe as soon as the force is lifted', async () => {
      await h.service.simulateError(
        testActor,
        sensorId,
        true,
        Visibility.EVERYTHING,
        'testing the chain',
      );
      await h.service.simulateError(testActor, sensorId, false, Visibility.EVERYTHING);
      await report([
        {
          sensorId,
          at: new Date(NOW.getTime() + 120_000),
          outcome: 'ok',
          message: '2/2 replies, min 0.072 ms',
          channels: null,
        },
      ]);

      const after = await runtimeOf(sensorId);
      assert.equal(after.state, 'up');
      assert.equal(after.message, '2/2 replies, min 0.072 ms');
    });
  },
);

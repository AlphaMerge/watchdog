import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeConfigService } from '../src/probes/config.js';
import {
  canAcknowledge,
  resolveAcknowledgement,
  ACK_PRESET_MINUTES,
  MAX_ACK_MINUTES,
} from '../src/state/acknowledgement.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import type { SensorResult } from '../src/state/service.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
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

// -------------------------------------------------------------------------------------------
// The rules, without a sensor.
// -------------------------------------------------------------------------------------------

describe('resolving an acknowledgement', () => {
  it('acknowledges indefinitely when no deadline is given', () => {
    const resolved = resolveAcknowledgement({ kind: 'indefinite' }, 'ticket 4471', NOW);
    assert.ok('acknowledgement' in resolved);
    assert.equal(resolved.acknowledgement.acknowledgedUntil, null);
    assert.equal(resolved.acknowledgement.message, 'ticket 4471');
  });

  it('turns a duration into a deadline', () => {
    const resolved = resolveAcknowledgement({ kind: 'duration', minutes: 180 }, '', NOW);
    assert.ok('acknowledgement' in resolved);
    assert.equal(
      resolved.acknowledgement.acknowledgedUntil?.toISOString(),
      '2026-08-25T15:00:00.000Z',
    );
  });

  it('accepts every preset CAPABILITIES names, and durations that are not presets', () => {
    for (const minutes of ACK_PRESET_MINUTES) {
      assert.ok(
        'acknowledgement' in resolveAcknowledgement({ kind: 'duration', minutes }, '', NOW),
        String(minutes),
      );
    }
    assert.ok(
      'acknowledgement' in resolveAcknowledgement({ kind: 'duration', minutes: 45 }, '', NOW),
    );
  });

  it('refuses a deadline in the past, and names what to do instead', () => {
    // It would lapse before the next scan noticed it, so the operator would click acknowledge
    // and watch nothing happen.
    const past = resolveAcknowledgement(
      { kind: 'until', until: new Date(NOW.getTime() - 1) },
      '',
      NOW,
    );
    assert.ok('problems' in past);
    assert.ok(past.problems[0]?.includes('clear it instead'));
  });

  it('refuses one longer than a year, and says to be explicit instead', () => {
    const long = resolveAcknowledgement(
      { kind: 'duration', minutes: MAX_ACK_MINUTES + 1 },
      '',
      NOW,
    );
    assert.ok('problems' in long);
    assert.ok(long.problems[0]?.includes('indefinitely'));
  });

  it('applies only to a Down sensor, in either of its two forms', () => {
    assert.equal(canAcknowledge('down'), true);
    // So that extending or re-wording an existing acknowledgement is the same call.
    assert.equal(canAcknowledge('down_acknowledged'), true);
    for (const state of ['up', 'warning', 'unknown', 'paused']) {
      assert.equal(canAcknowledge(state), false, state);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Against a real tree.
// -------------------------------------------------------------------------------------------

describe(
  'acknowledgement',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let probeId: number;
    let deviceId: number;
    let sensorId: number;
    let siblingId: number;
    let healthyId: number;

    before(async () => {
      scratch = await createScratchDatabase('acknowledgement');
      db = scratch.db;
      h = await buildHarness(db, { states: true });

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
      probeId = probe.id;
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'group',
      });
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: group.id,
          name: 'device',
          host: '192.0.2.20',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Failing',
          sensorType: 'icmp.ping',
        })
      ).id;
      siblingId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Also failing',
          sensorType: 'icmp.ping',
        })
      ).id;
      healthyId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Healthy',
          sensorType: 'icmp.ping',
        })
      ).id;
      h.audit.recorded.length = 0;
    });

    // -------------------------------------------------------------------------------------
    // Harness. States arrive the way they really do: through results.
    // -------------------------------------------------------------------------------------

    /** One batch of results, written the way ingestion writes them. */
    async function report(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    /** Drives a sensor Down through the state machine, not by writing the column. */
    async function makeDown(id: number, at = NOW): Promise<void> {
      // The default policy warns for one interval before Down, so two failures.
      for (const [index, when] of [at, new Date(at.getTime() + 60_000)].entries()) {
        await report([
          { sensorId: id, at: when, outcome: 'error', message: `failure ${String(index + 1)}` },
        ]);
      }
    }

    async function makeUp(id: number, at = new Date(NOW.getTime() + 120_000)): Promise<void> {
      await report([{ sensorId: id, at, outcome: 'ok', message: 'reachable' }]);
    }

    async function runtimeOf(id: number): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      acknowledgedAt: Date | null;
      acknowledgedUntil: Date | null;
      by: string | null;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        message: string;
        acknowledged_at: Date | null;
        acknowledged_until: Date | null;
        acknowledged_by_kind: string | null;
      }>(
        `SELECT state, cause, message, acknowledged_at, acknowledged_until, acknowledged_by_kind
         FROM sensor_runtime WHERE object_id = $1`,
        [id],
      );
      const row = rows[0];
      assert.ok(row !== undefined, `no runtime row for ${String(id)}`);
      return {
        state: row.state,
        cause: row.cause,
        message: row.message,
        acknowledgedAt: row.acknowledged_at,
        acknowledgedUntil: row.acknowledged_until,
        by: row.acknowledged_by_kind,
      };
    }

    // -------------------------------------------------------------------------------------
    // Acknowledging.
    // -------------------------------------------------------------------------------------

    it('turns a Down sensor into Down (Acknowledged), keeping the operator-s words', async () => {
      await makeDown(sensorId);
      assert.equal((await runtimeOf(sensorId)).state, 'down');

      const view = await h.service.acknowledge(
        testActor,
        sensorId,
        { kind: 'indefinite' },
        'ticket 4471, engineer on site',
      );
      assert.deepEqual(view.acknowledged, [sensorId]);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'down_acknowledged');
      assert.equal(current.cause, 'user');
      // CAPABILITIES.MD §5.3: the acknowledgement message becomes the sensor's last message.
      assert.equal(current.message, 'ticket 4471, engineer on site');
      assert.equal(current.by, 'system');
    });

    it('suppresses notifications, not monitoring: the probe still scans it', async () => {
      const config = new ProbeConfigService({ db, resolver: h.resolver });
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, '');

      const scheduled = (await config.assignmentsFor(probeId)).sensors.map((s) => s.sensorId);
      assert.ok(scheduled.includes(sensorId), 'WORKFLOW.MD §4 rule 4: it keeps scanning');
    });

    it('records the transition, so uptime and the log both see it', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'duration', minutes: 60 }, 'later');

      const rows = await db.query<{ previous_state: string; state: string; cause: string }>(
        `SELECT previous_state, state, cause FROM sensor_state
         WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1`,
        [sensorId],
      );
      const transition = rows[0];
      assert.ok(transition !== undefined);
      assert.equal(transition.previous_state, 'down');
      assert.equal(transition.state, 'down_acknowledged');
      assert.equal(transition.cause, 'user');
    });

    it('refuses to acknowledge a sensor that is not Down', async () => {
      await makeUp(sensorId, NOW);
      await assert.rejects(
        () => h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, ''),
        (error: unknown) => {
          const err = error as { code?: string; message?: string };
          assert.equal(err.code, 'OBJECT_NOT_PAUSED');
          assert.ok(err.message?.includes('only a Down sensor'));
          return true;
        },
      );
      assert.equal((await runtimeOf(sensorId)).acknowledgedAt, null, 'and stores nothing');
    });

    it('acknowledges a whole device-s outage in one call, and only what is Down', async () => {
      await makeDown(sensorId);
      await makeDown(siblingId);
      await makeUp(healthyId, NOW);

      const view = await h.service.acknowledge(testActor, deviceId, { kind: 'indefinite' }, 'one');
      assert.deepEqual(
        [...view.acknowledged].sort((a, b) => a - b),
        [sensorId, siblingId].sort((a, b) => a - b),
      );
      assert.equal((await runtimeOf(healthyId)).acknowledgedAt, null, 'the healthy one is left');
      assert.equal((await runtimeOf(siblingId)).state, 'down_acknowledged');
    });

    it('is a snapshot, not a rule: a sensor that fails afterwards is a new alarm', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, deviceId, { kind: 'indefinite' }, 'known');

      await makeDown(siblingId, new Date(NOW.getTime() + 300_000));
      const later = await runtimeOf(siblingId);
      assert.equal(later.state, 'down', 'nobody has looked at this one');
      assert.equal(later.acknowledgedAt, null);
    });

    it('refuses when nothing beneath the object is Down', async () => {
      await makeUp(sensorId, NOW);
      await assert.rejects(
        () => h.service.acknowledge(testActor, deviceId, { kind: 'indefinite' }, ''),
        (error: unknown) => {
          assert.ok((error as Error).message.includes('nothing here is Down'));
          return true;
        },
      );
    });

    // -------------------------------------------------------------------------------------
    // Clearing it, the four ways.
    // -------------------------------------------------------------------------------------

    it('clears on a recovery a reading decided', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'known');
      await makeUp(sensorId);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'up');
      assert.equal(current.acknowledgedAt, null, 'the acknowledgement went with the outage');
    });

    it('expires back to plain Down, against the result clock', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'duration', minutes: 5 }, 'briefly');
      assert.equal((await runtimeOf(sensorId)).state, 'down_acknowledged');

      // §2.4: expiry is evaluated against the *result's* clock, so a replayed spool writes the
      // history it would have written live. A result an hour later is what notices it.
      await report([
        {
          sensorId,
          at: new Date(Date.now() + 3_600_000),
          outcome: 'error',
          message: 'still failing',
        },
      ]);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'down');
      // The change an operator needs to see is that the acknowledgement lapsed, not that the
      // target is still down.
      assert.equal(current.cause, 'user');
      assert.equal(current.acknowledgedAt, null);
    });

    it('clears on pause then resume, which is WORKFLOW.MD §4 rule 5', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'known');

      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'maintenance');
      assert.equal((await runtimeOf(sensorId)).state, 'paused');
      await h.service.resume(testActor, sensorId);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'unknown', 'resumed sensors await their next scan');
      assert.equal(current.acknowledgedAt, null, 'and the acknowledgement went with the pause');
    });

    it('is withdrawn by clearing it, for the case none of the other three covers', async () => {
      // "I acknowledged the wrong sensor" is not recovery, expiry or a pause — and pause-then-
      // resume as the only undo would cost the sensor its failure count.
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'wrong one');

      const view = await h.service.clearAcknowledgement(testActor, sensorId);
      assert.deepEqual(view.acknowledged, [sensorId]);
      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'down', 'back to alarming');
      assert.equal(current.acknowledgedAt, null);
      assert.equal(current.by, null);
    });

    // -------------------------------------------------------------------------------------
    // Interactions with the rest of Phase 3.
    // -------------------------------------------------------------------------------------

    it('loses to a pause, because §2 puts pause first', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'known');
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'planned');

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'paused');
      assert.equal(current.cause, 'parent');
    });

    it('still triggers a dependency, because the target is still down', async () => {
      // §3: an acknowledgement is a statement about notifications, not about the outage, so a
      // master that is Down (Acknowledged) still holds what depends on it.
      await h.service.setDependency(testActor, siblingId, 'object', sensorId, undefined);
      await makeDown(sensorId);
      await h.service.acknowledge(testActor, sensorId, { kind: 'indefinite' }, 'known');
      await db.tx(async (q) => {
        await h.dependencies?.recompute(q, new Date());
      });

      assert.equal((await runtimeOf(siblingId)).state, 'paused');
      assert.equal((await runtimeOf(siblingId)).cause, 'dependency');
    });

    // -------------------------------------------------------------------------------------
    // Over HTTP.
    // -------------------------------------------------------------------------------------

    it('acknowledges and withdraws over HTTP', async () => {
      await makeDown(sensorId);
      const acknowledged = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(sensorId)}/acknowledge`,
        payload: { minutes: 180, message: 'ticket 4471' },
      });
      assert.equal(acknowledged.statusCode, 200);
      const body = acknowledged.json<{ acknowledged: number[]; acknowledgedUntil: string }>();
      assert.deepEqual(body.acknowledged, [sensorId]);
      assert.ok(body.acknowledgedUntil);

      const state = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/state`,
      });
      const view = state.json<{
        state: string;
        message: string;
        acknowledged: boolean;
        acknowledgedBy: { kind: string } | null;
      }>();
      assert.equal(view.state, 'down_acknowledged');
      assert.equal(view.acknowledged, true);
      assert.equal(view.message, 'ticket 4471');
      assert.equal(view.acknowledgedBy?.kind, 'anonymous');

      const cleared = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(sensorId)}/acknowledge`,
      });
      assert.equal(cleared.statusCode, 200);
      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/sensors/${String(sensorId)}/state`,
      });
      assert.equal(after.json<{ state: string }>().state, 'down');
    });

    it('refuses both a duration and a deadline in one request', async () => {
      await makeDown(sensorId);
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/objects/${String(sensorId)}/acknowledge`,
        payload: { minutes: 60, until: new Date(Date.now() + 3_600_000).toISOString() },
      });
      assert.equal(response.statusCode, 400);
    });

    it('audits who silenced the alarm, for how long, and what they said', async () => {
      await makeDown(sensorId);
      await h.service.acknowledge(
        testActor,
        sensorId,
        { kind: 'duration', minutes: 60 },
        'ticket 1',
      );

      const recorded = h.audit.recorded.filter((m) => m.action === 'sensor.acknowledged');
      assert.equal(recorded.length, 1);
      const entry = recorded[0];
      assert.ok(entry?.action === 'sensor.acknowledged');
      assert.equal(entry.message, 'ticket 1');
      assert.equal(entry.sensorsAffected, 1);
      assert.ok(entry.until !== null);
    });
  },
);

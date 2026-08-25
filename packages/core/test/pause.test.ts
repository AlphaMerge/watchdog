import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { PauseSweep } from '../src/objects/pause-sweep.js';
import {
  pauseIsActive,
  pauseIsPending,
  refuseResume,
  resolvePause,
  MAX_PAUSE_MINUTES,
  MAX_WINDOW_LEAD_MINUTES,
  PAUSE_PRESET_MINUTES,
} from '../src/state/pause.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { testCatalogue } from './support/sensor-types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();
const NOW = new Date('2026-08-25T12:00:00.000Z');

// -------------------------------------------------------------------------------------------
// The rules, without a tree in the way.
// -------------------------------------------------------------------------------------------

describe('resolving a pause request', () => {
  it('pauses indefinitely when no deadline is given', () => {
    const resolved = resolvePause({ kind: 'indefinite' }, 'maintenance', NOW);
    assert.ok('pause' in resolved);
    assert.equal(resolved.pause.pausedUntil, null, 'until a person says otherwise');
    assert.equal(resolved.pause.message, 'maintenance');
  });

  it('turns a duration into a deadline', () => {
    const resolved = resolvePause({ kind: 'duration', minutes: 15 }, '', NOW);
    assert.ok('pause' in resolved);
    assert.equal(resolved.pause.pausedUntil?.toISOString(), '2026-08-25T12:15:00.000Z');
  });

  it('accepts every preset a UI offers, and durations that are not presets', () => {
    for (const minutes of PAUSE_PRESET_MINUTES) {
      assert.ok('pause' in resolvePause({ kind: 'duration', minutes }, '', NOW), String(minutes));
    }
    assert.ok('pause' in resolvePause({ kind: 'duration', minutes: 45 }, '', NOW));
  });

  it('refuses a deadline that has already passed', () => {
    // Accepting it would create a pause that expires before anything can act on it — a sensor
    // that flickers Paused and back for no reason anybody could explain.
    const past = resolvePause({ kind: 'until', until: new Date(NOW.getTime() - 1) }, '', NOW);
    assert.ok('problems' in past);
    assert.ok(past.problems[0]?.includes('already in the past'));
  });

  it('refuses a timed pause longer than a year, and says to be explicit instead', () => {
    const long = resolvePause({ kind: 'duration', minutes: MAX_PAUSE_MINUTES + 1 }, '', NOW);
    assert.ok('problems' in long);
    assert.ok(long.problems[0]?.includes('indefinitely'));
  });

  it('refuses a duration that is not a duration', () => {
    assert.ok('problems' in resolvePause({ kind: 'duration', minutes: 0 }, '', NOW));
    assert.ok('problems' in resolvePause({ kind: 'duration', minutes: -5 }, '', NOW));
  });

  it('turns a window into a pause that has not started', () => {
    const from = new Date(NOW.getTime() + 60 * 60_000);
    const until = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const resolved = resolvePause({ kind: 'window', from, until }, 'quarterly patching', NOW);
    assert.ok('pause' in resolved);
    assert.equal(resolved.pause.startsAt.toISOString(), from.toISOString());
    assert.equal(resolved.pause.pausedUntil?.toISOString(), until.toISOString());
    // When it was written, not when it takes effect. The two are the same for every other kind
    // of pause, which is exactly why the distinction is easy to lose.
    assert.equal(resolved.pause.pausedAt.toISOString(), NOW.toISOString());
  });

  it('refuses a window that is over, backwards, or a mistyped year', () => {
    const hour = 60 * 60_000;
    const over = resolvePause(
      {
        kind: 'window',
        from: new Date(NOW.getTime() - 2 * hour),
        until: new Date(NOW.getTime() - hour),
      },
      '',
      NOW,
    );
    assert.ok('problems' in over);
    assert.ok(over.problems[0]?.includes('already over'));

    const backwards = resolvePause(
      {
        kind: 'window',
        from: new Date(NOW.getTime() + 2 * hour),
        until: new Date(NOW.getTime() + hour),
      },
      '',
      NOW,
    );
    assert.ok('problems' in backwards);
    assert.ok(backwards.problems[0]?.includes('end after it starts'));

    const distant = resolvePause(
      {
        kind: 'window',
        from: new Date(NOW.getTime() + (MAX_WINDOW_LEAD_MINUTES + 1) * 60_000),
        until: new Date(NOW.getTime() + (MAX_WINDOW_LEAD_MINUTES + 60) * 60_000),
      },
      '',
      NOW,
    );
    assert.ok('problems' in distant);
  });

  it('accepts a window whose start is already past, which is a pause that is late', () => {
    const resolved = resolvePause(
      {
        kind: 'window',
        from: new Date(NOW.getTime() - 60_000),
        until: new Date(NOW.getTime() + 60_000),
      },
      '',
      NOW,
    );
    assert.ok('pause' in resolved);
  });

  it('is not in force before it starts, however far off its deadline is', () => {
    const later = new Date(NOW.getTime() + 60_000);
    assert.equal(pauseIsActive({ startsAt: later, pausedUntil: null }, NOW), false);
    assert.equal(pauseIsPending({ startsAt: later }, NOW), true);
    assert.equal(pauseIsPending({ startsAt: NOW }, NOW), false);
  });

  it('is active until its deadline, and not after', () => {
    assert.equal(pauseIsActive({ startsAt: NOW, pausedUntil: null }, NOW), true);
    assert.equal(
      pauseIsActive({ startsAt: NOW, pausedUntil: new Date(NOW.getTime() + 1) }, NOW),
      true,
    );
    assert.equal(pauseIsActive({ startsAt: NOW, pausedUntil: NOW }, NOW), false);
  });
});

describe('refusing a resume', () => {
  it('allows resuming what was directly paused', () => {
    assert.equal(refuseResume(true, null), null);
    assert.equal(refuseResume(true, { objectId: 7, name: 'Device' }), null, 'own pause wins');
  });

  it('refuses a cascade, and names what to resume instead', () => {
    // "You cannot do that" without "here is what you can do" is the least useful error a UI can
    // render, and silently doing nothing would leave an operator believing monitoring is back.
    const refusal = refuseResume(false, { objectId: 7, name: 'London switch' });
    assert.ok(refusal);
    assert.ok(refusal.reason.includes('#7'));
    assert.ok(refusal.reason.includes('London switch'));
    assert.equal(refusal.details['pausedBy'], 7);
  });

  it('refuses a resume of something that is not paused at all', () => {
    assert.equal(refuseResume(false, null)?.reason, 'this object is not paused');
  });
});

// -------------------------------------------------------------------------------------------
// Against a real tree.
// -------------------------------------------------------------------------------------------

describe(
  'manual pause',
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
      scratch = await createScratchDatabase('pause');
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
      groupId = group.id;
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'device',
        host: '192.0.2.80',
      });
      deviceId = device.id;
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'sensor',
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;
      const sibling = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'sibling',
        sensorType: 'icmp.ping',
      });
      siblingId = sibling.id;
      h.audit.recorded.length = 0;
    });

    // -------------------------------------------------------------------------------------
    // Harness.
    // -------------------------------------------------------------------------------------

    async function runtimeOf(id: number): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      flags: string[];
      last_result_at: Date | null;
      consecutive_failures: number;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        paused_by_parent: boolean;
        paused_manually: boolean;
        last_result_at: Date | null;
        consecutive_failures: number;
      }>(
        `SELECT state, cause, paused_by_parent, paused_manually, last_result_at,
                consecutive_failures
         FROM sensor_runtime WHERE object_id = $1`,
        [id],
      );
      const row = rows[0];
      assert.ok(row, `no runtime for ${String(id)}`);
      return {
        state: row.state,
        cause: row.cause,
        flags: [
          ...(row.paused_by_parent ? ['parent'] : []),
          ...(row.paused_manually ? ['manual'] : []),
        ],
        last_result_at: row.last_result_at,
        consecutive_failures: row.consecutive_failures,
      };
    }

    async function history(id: number): Promise<string[]> {
      const rows = await db.query<{
        state: SensorState;
        previous_state: SensorState | null;
        cause: SensorStateCause;
      }>(
        'SELECT state, previous_state, cause FROM sensor_state WHERE sensor_id = $1 ORDER BY time',
        [id],
      );
      return rows.map((row) => `${row.previous_state ?? '-'}->${row.state}:${row.cause}`);
    }

    /** A successful scan, so the sensor has something to be paused *from*. */
    async function makeUp(id: number, minutes = 0): Promise<void> {
      await db.query(
        `UPDATE sensor_runtime
         SET state = 'up', cause = 'scan', last_result_at = now() - ($2 || ' minutes')::interval,
             since = now() - ($2 || ' minutes')::interval, consecutive_failures = 0
         WHERE object_id = $1`,
        [id, String(minutes)],
      );
    }

    // -------------------------------------------------------------------------------------
    // Pausing.
    // -------------------------------------------------------------------------------------

    it('pauses a sensor immediately, without waiting for a scan', async () => {
      // The reason M-03 could defer a policy change and M-08 cannot: a policy is a rule about
      // results, so the next result applies it. An operator pausing for maintenance means now,
      // and a sensor that alarmed thirty seconds into a planned outage is the exact failure
      // pausing exists to prevent.
      await makeUp(sensorId);
      const view = await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'patching');

      assert.equal(view.paused, true);
      assert.equal(view.resumable, true);
      assert.equal(view.source, 'manual');
      assert.equal(view.pausedUntil, null);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'paused');
      assert.equal(current.cause, 'user');
      assert.deepEqual(current.flags, ['manual']);
      assert.deepEqual(await history(sensorId), ['up->paused:user']);
    });

    it('cascades to every sensor under a paused device', async () => {
      await makeUp(sensorId);
      await makeUp(siblingId);
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'rack move');

      for (const id of [sensorId, siblingId]) {
        const current = await runtimeOf(id);
        assert.equal(current.state, 'paused', String(id));
        assert.equal(current.cause, 'parent', 'the cascade, not the sensor’s own pause');
        assert.deepEqual(current.flags, ['parent']);
      }
    });

    it('cascades from a group two levels up', async () => {
      await makeUp(sensorId);
      await h.service.pause(testActor, groupId, { kind: 'indefinite' });
      assert.equal((await runtimeOf(sensorId)).cause, 'parent');
    });

    it('counts what it stopped monitoring, which is what makes the log answerable', async () => {
      // "Somebody paused the London group" and "somebody paused the London group and four
      // thousand sensors stopped being monitored" are different events.
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' });
      const entry = h.audit.recorded.find((each) => each.action === 'object.paused');
      assert.ok(entry, 'the pause was recorded');
      assert.equal(entry.sensorsAffected, 2);
    });

    it('records the cause changing on a sensor that was already paused', async () => {
      await makeUp(sensorId);
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' });
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' });

      // Still Paused, but held by something else now — and §5 invariant 10 requires that: the
      // reported cause is what tells an operator which resume would actually free it, and
      // resuming the sensor would no longer work.
      assert.deepEqual(await history(sensorId), ['up->paused:user', 'paused->paused:parent']);
      assert.deepEqual((await runtimeOf(sensorId)).flags, ['parent', 'manual']);
    });

    it('records nothing at all when no flag moved', async () => {
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'first');
      const before = (await history(sensorId)).length;
      await h.service.pause(testActor, deviceId, { kind: 'duration', minutes: 60 }, 'extended');

      // The deadline moved; nothing about any sensor did. Extending a maintenance window should
      // not write a transition per sensor.
      assert.equal((await history(sensorId)).length, before);
    });

    it('replaces the deadline rather than stacking, which is extending a window', async () => {
      await h.service.pause(testActor, deviceId, { kind: 'duration', minutes: 15 }, 'first');
      const extended = await h.service.pause(
        testActor,
        deviceId,
        { kind: 'duration', minutes: 60 },
        'actually an hour',
      );
      assert.equal(extended.message, 'actually an hour');
      const rows = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM object_pause WHERE object_id = $1',
        [deviceId],
      );
      assert.equal(Number(rows[0]?.count), 1, 'one pause per object, and one resume undoes it');
    });

    it('refuses to pause the root, which is pausing the installation', async () => {
      await assert.rejects(
        () => h.service.pause(testActor, h.rootId, { kind: 'indefinite' }),
        /root cannot be paused/,
      );
    });

    // -------------------------------------------------------------------------------------
    // Resuming.
    // -------------------------------------------------------------------------------------

    it('resumes to Unknown, never to the state it had before the pause', async () => {
      // §3: the sensor awaits its next scan. Reporting a state measured before the pause would
      // be reporting something the system has not checked since.
      await makeUp(sensorId);
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' });
      await h.service.resume(testActor, sensorId);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'unknown');
      assert.equal(current.cause, 'scan');
      assert.equal(current.last_result_at, null, 'it awaits its next scan');
      assert.deepEqual(await history(sensorId), ['up->paused:user', 'paused->unknown:scan']);
    });

    it('refuses to resume a sensor its device is holding, and names the device', async () => {
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' });
      await assert.rejects(
        () => h.service.resume(testActor, sensorId),
        (error: Error & { details?: Record<string, unknown> }) => {
          assert.ok(error.message.includes(`#${String(deviceId)}`));
          assert.equal(error.details?.['pausedBy'], deviceId);
          return true;
        },
      );
      assert.equal((await runtimeOf(sensorId)).state, 'paused', 'and it stays paused');
    });

    it('stays paused when one source clears and another still holds it', async () => {
      // The set-not-chain rule of §3, with real rows behind it rather than a table.
      await makeUp(sensorId);
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'device');
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'sensor');
      assert.deepEqual((await runtimeOf(sensorId)).flags, ['parent', 'manual']);

      await h.service.resume(testActor, deviceId);
      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'paused', 'its own pause still holds it');
      assert.equal(current.cause, 'user', 'and the reported cause moves to the one that does');
      assert.deepEqual(current.flags, ['manual']);

      await h.service.resume(testActor, sensorId);
      assert.equal((await runtimeOf(sensorId)).state, 'unknown', 'now the last source cleared');
    });

    it('leaves a sibling alone when one sensor is resumed', async () => {
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' });
      await h.service.pause(testActor, sensorId, { kind: 'indefinite' });
      await h.service.resume(testActor, sensorId);
      assert.equal((await runtimeOf(siblingId)).state, 'paused', 'the device still holds it');
      assert.equal((await runtimeOf(sensorId)).state, 'paused', 'and so does it, still');
    });

    // -------------------------------------------------------------------------------------
    // The tree moving underneath a pause.
    // -------------------------------------------------------------------------------------

    it('pauses a sensor created under something already paused', async () => {
      // The operator paused the device before this sensor existed. Without this it would scan,
      // alarm and record readings inside a maintenance window nobody reopened.
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'rack move');
      const late = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `late-${String(process.hrtime.bigint())}`,
        sensorType: 'icmp.ping',
      });
      const current = await runtimeOf(late.id);
      assert.equal(current.state, 'paused');
      assert.equal(current.cause, 'parent');
    });

    it('re-derives the cascade when a subtree moves', async () => {
      // The branch a "toggle the flag" implementation would miss entirely: nothing about the
      // sensor or its pauses changed, only which ancestors it has.
      const quiet = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: `quiet-${String(process.hrtime.bigint())}`,
      });
      await h.service.pause(testActor, quiet.id, { kind: 'indefinite' }, 'whole site down');
      assert.equal((await runtimeOf(sensorId)).state, 'unknown', 'not under it yet');

      await h.service.move(testActor, deviceId, quiet.id, { kind: 'none' });
      assert.equal((await runtimeOf(sensorId)).state, 'paused');
      assert.equal((await runtimeOf(sensorId)).cause, 'parent');

      await h.service.move(testActor, deviceId, groupId, { kind: 'none' });
      assert.equal((await runtimeOf(sensorId)).state, 'unknown', 'moved back out and resumed');
    });

    it('creates a clone paused, saying what it was cloned from', async () => {
      // S-03. A clone carries its source's configuration and none of its credentials, so
      // scanning immediately would be a burst of authentication failures on a device an
      // operator has not finished setting up.
      const clone = await h.service.clone(testActor, deviceId, {
        name: `clone-${String(process.hrtime.bigint())}`,
      });
      const view = await h.service.pauseState(clone.object.id);
      assert.equal(view.paused, true);
      assert.equal(view.resumable, true);
      assert.equal(view.message, `cloned from #${String(deviceId)}`);

      const rows = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM object WHERE parent_id = $1 AND kind = 'sensor'`,
        [clone.object.id],
      );
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal((await runtimeOf(Number(row.id))).state, 'paused', `sensor ${row.id}`);
      }
    });

    // -------------------------------------------------------------------------------------
    // The probe.
    // -------------------------------------------------------------------------------------

    it('stops telling the probe to scan a paused sensor', async () => {
      // WORKFLOW.MD §3 skips a paused sensor before the check is enqueued. The cheapest way to
      // skip a check is never to schedule it.
      const config = new ProbeConfigService({ db, resolver: h.resolver });
      const before = await config.assignmentsFor(probeId);
      assert.equal(before.sensors.length, 2);

      await h.service.pause(testActor, sensorId, { kind: 'indefinite' });
      const during = await config.assignmentsFor(probeId);
      assert.deepEqual(
        during.sensors.map((each) => each.sensorId),
        [siblingId],
      );
      assert.notEqual(during.version, before.version, 'so the probe is actually pushed the change');

      await h.service.resume(testActor, sensorId);
      const afterwards = await config.assignmentsFor(probeId);
      assert.equal(afterwards.sensors.length, 2);
      assert.equal(afterwards.version, before.version, 'and back to exactly what it was');
    });

    // -------------------------------------------------------------------------------------
    // Time passing.
    // -------------------------------------------------------------------------------------

    it('expires a timed pause and resumes what it was holding', async () => {
      await makeUp(sensorId);
      await h.service.pause(testActor, deviceId, { kind: 'duration', minutes: 15 }, 'quick fix');
      assert.equal((await runtimeOf(sensorId)).state, 'paused');

      // Reach into the row rather than wait fifteen minutes. The deadline is the input; how it
      // got there is not what this is about.
      await db.query(
        `UPDATE object_pause SET paused_at = now() - interval '20 minutes',
                                 starts_at = now() - interval '20 minutes',
                                 paused_until = now() - interval '5 minutes'
         WHERE object_id = $1`,
        [deviceId],
      );

      const expiry = new PauseSweep({ service: h.service, logger: silent });
      assert.equal(await expiry.sweep(), 1);

      const current = await runtimeOf(sensorId);
      assert.equal(current.state, 'unknown', 'resumed, and awaiting its next scan');
      assert.equal(current.cause, 'scan');
      assert.equal(current.last_result_at, null);
      assert.equal((await h.service.pauseState(deviceId)).paused, false);
    });

    it('reads an expired pause as not paused even before the sweep runs', async () => {
      // Every read accounts for the clock, so nothing is wrong between the deadline and the
      // sweep. What the sweep is for is the writes: the transition, the log, the config push.
      await h.service.pause(testActor, deviceId, { kind: 'duration', minutes: 15 });
      await db.query(
        `UPDATE object_pause SET paused_at = now() - interval '20 minutes',
                                 starts_at = now() - interval '20 minutes',
                                 paused_until = now() - interval '5 minutes'
         WHERE object_id = $1`,
        [deviceId],
      );
      assert.equal((await h.service.pauseState(deviceId)).paused, false);
      assert.equal((await h.service.pauseState(sensorId)).paused, false);
    });

    it('leaves a pause that is still in force alone', async () => {
      await h.service.pause(testActor, deviceId, { kind: 'duration', minutes: 60 });
      const expiry = new PauseSweep({ service: h.service, logger: silent });
      await expiry.sweep();
      assert.equal((await runtimeOf(sensorId)).state, 'paused');
      assert.equal((await h.service.pauseState(deviceId)).paused, true);
    });

    it('survives a core restart, because the deadline is in the database', async () => {
      await h.service.pause(testActor, deviceId, { kind: 'duration', minutes: 60 }, 'overnight');
      // A new process: nothing in memory, no timer, everything in the table.
      const restarted = await buildHarness(db, { states: true });
      const view = await restarted.service.pauseState(deviceId);
      assert.equal(view.paused, true);
      assert.equal(view.message, 'overnight');
      assert.equal((await runtimeOf(sensorId)).state, 'paused');
    });

    // -------------------------------------------------------------------------------------
    // Maintenance windows (M-10).
    // -------------------------------------------------------------------------------------

    describe('maintenance windows', () => {
      /** Reach into the row rather than wait for Saturday. The times are the input. */
      async function moveWindow(id: number, startsIn: string, endsIn: string): Promise<void> {
        await db.query(
          `UPDATE object_pause
           SET starts_at = now() + $2::interval, paused_until = now() + $3::interval
           WHERE object_id = $1`,
          [id, startsIn, endsIn],
        );
      }

      function nextWeek(): { from: string; until: string } {
        const from = new Date(Date.now() + 24 * 60 * 60_000);
        return {
          from: from.toISOString(),
          until: new Date(from.getTime() + 2 * 60 * 60_000).toISOString(),
        };
      }

      it('pauses nothing until it starts', async () => {
        await makeUp(sensorId);
        const { from, until } = nextWeek();
        const view = await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          'quarterly patching',
        );

        assert.equal(view.paused, false, 'nothing is paused yet');
        assert.equal(view.pending, true);
        assert.equal(view.startsAt, from);
        assert.equal(view.resumable, true, 'and it can be called off');
        assert.equal((await runtimeOf(sensorId)).state, 'up', 'the sensor is still watched');
      });

      it('opens on time, cascading exactly as a manual pause does', async () => {
        await makeUp(sensorId);
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          'quarterly patching',
        );
        await moveWindow(deviceId, '-1 minute', '1 hour');

        const sweep = new PauseSweep({ service: h.service, logger: silent });
        assert.equal(await sweep.sweep(), 1);

        const current = await runtimeOf(sensorId);
        assert.equal(current.state, 'paused');
        assert.deepEqual(current.flags, ['parent'], 'the cascade, not a fifth source');
        assert.equal((await runtimeOf(siblingId)).state, 'paused', 'every sensor beneath it');
      });

      it('records the window-s own message in the state history', async () => {
        await makeUp(sensorId);
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          'quarterly patching',
        );
        await moveWindow(deviceId, '-1 minute', '1 hour');
        await new PauseSweep({ service: h.service, logger: silent }).sweep();

        const rows = await db.query<{ message: string }>(
          'SELECT message FROM sensor_state WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1',
          [sensorId],
        );
        assert.equal(rows[0]?.message, 'quarterly patching');
      });

      it('closes on its own, like any timed pause', async () => {
        await makeUp(sensorId);
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          '',
        );
        const sweep = new PauseSweep({ service: h.service, logger: silent });

        await moveWindow(deviceId, '-1 minute', '1 hour');
        assert.equal(await sweep.sweep(), 1);
        assert.equal((await runtimeOf(sensorId)).state, 'paused');

        await moveWindow(deviceId, '-2 hours', '-1 minute');
        assert.equal(await sweep.sweep(), 1);
        const current = await runtimeOf(sensorId);
        // §3 again: a resumed sensor awaits its next scan rather than returning to the state
        // nothing has checked since — the window is over, not the outage.
        assert.equal(current.state, 'unknown');
        assert.equal(current.last_result_at, null);
        assert.equal((await h.service.pauseState(deviceId)).paused, false);
      });

      it('sweeps once, not on every pass', async () => {
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          '',
        );
        await moveWindow(deviceId, '-1 minute', '1 hour');

        const sweep = new PauseSweep({ service: h.service, logger: silent });
        assert.equal(await sweep.sweep(), 1, 'it opened');
        assert.equal(await sweep.sweep(), 0, 'and stays open without being reopened');
      });

      it('reconciles a window that opened while the core was down', async () => {
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          'overnight',
        );
        await moveWindow(deviceId, '-3 hours', '3 hours');
        // Nothing applied it: no sweep has run since it was written, which is what a restart
        // during the window looks like from the database's side.
        assert.equal((await runtimeOf(sensorId)).state, 'unknown');

        // A new process. Its first sweep looks back to the epoch, on purpose.
        const restarted = new PauseSweep({ service: h.service, logger: silent });
        assert.equal(await restarted.sweep(), 1);
        assert.equal((await runtimeOf(sensorId)).state, 'paused');
      });

      it('is cancelled by resuming it, before it has started', async () => {
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          '',
        );
        // A resume on an object that is not paused *yet* would be refused if `own` meant "in
        // force"; an operator who booked the wrong weekend should not have to wait for it.
        const view = await h.service.resume(testActor, deviceId);
        assert.equal(view.pending, false);
        assert.equal(view.startsAt, null);

        await moveWindow(deviceId, '-1 minute', '1 hour');
        const sweep = new PauseSweep({ service: h.service, logger: silent });
        assert.equal(await sweep.sweep(), 0, 'and it never opens');
      });

      it('is extended by replacing it, not by stacking a second one', async () => {
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          'first',
        );
        const longer = new Date(new Date(until).getTime() + 60 * 60_000).toISOString();
        const view = await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(longer) },
          'extended',
        );
        assert.equal(view.pausedUntil, longer);
        assert.equal(view.message, 'extended');

        const rows = await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM object_pause WHERE object_id = $1',
          [deviceId],
        );
        assert.equal(rows[0]?.n, '1', 'one row, replaced');
      });

      it('records who scheduled it, separately from it happening', async () => {
        const { from, until } = nextWeek();
        await h.service.pause(
          testActor,
          deviceId,
          { kind: 'window', from: new Date(from), until: new Date(until) },
          'quarterly patching',
        );
        const scheduled = h.audit.recorded.filter((m) => m.action === 'object.paused');
        assert.equal(scheduled.length, 1);
        assert.equal(
          scheduled[0]?.action === 'object.paused' ? scheduled[0].from.toISOString() : '',
          from,
        );

        h.audit.recorded.length = 0;
        await moveWindow(deviceId, '-1 minute', '1 hour');
        await new PauseSweep({ service: h.service, logger: silent }).sweep();
        const opened = h.audit.recorded.filter((m) => m.action === 'object.paused');
        assert.equal(opened.length, 1, 'and a second entry when it actually happened');
      });
    });

    // -------------------------------------------------------------------------------------
    // The API.
    // -------------------------------------------------------------------------------------

    describe('the pause endpoint', () => {
      it('schedules a maintenance window, and refuses one with no end', async () => {
        const from = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
        const until = new Date(Date.now() + 26 * 60 * 60_000).toISOString();
        const created = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: { from, until, message: 'quarterly patching' },
        });
        assert.equal(created.statusCode, 200);
        const body = created.json<{ paused: boolean; pending: boolean; startsAt: string }>();
        assert.equal(body.paused, false);
        assert.equal(body.pending, true);
        assert.equal(body.startsAt, from);

        const endless = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: { from },
        });
        assert.equal(endless.statusCode, 400, 'an outage with no end is not a window');
      });

      it('pauses, reads back and resumes', async () => {
        const paused = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: { minutes: 15, message: 'swapping a PSU' },
        });
        assert.equal(paused.statusCode, 200);
        const body = paused.json<{ paused: boolean; pausedUntil: string; message: string }>();
        assert.equal(body.paused, true);
        assert.ok(body.pausedUntil);
        assert.equal(body.message, 'swapping a PSU');

        const read = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
        });
        assert.equal(read.headers['cache-control'], 'no-store', 'a deadline expires with no write');
        assert.equal(read.json<{ resumable: boolean }>().resumable, true);

        const resumed = await app.inject({
          method: 'DELETE',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
        });
        assert.equal(resumed.statusCode, 200);
        assert.equal(resumed.json<{ paused: boolean }>().paused, false);
      });

      it('says a cascaded child is paused and not resumable, and points at the parent', async () => {
        await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: {},
        });
        const read = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(sensorId)}/pause`,
        });
        const body = read.json<{
          paused: boolean;
          resumable: boolean;
          source: string;
          inheritedFrom: { objectId: number };
        }>();
        assert.equal(body.paused, true);
        assert.equal(body.resumable, false, 'a resume button here would not work');
        assert.equal(body.source, 'parent');
        assert.equal(body.inheritedFrom.objectId, deviceId);
      });

      it('409s a resume of a cascade-paused child', async () => {
        await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: {},
        });
        const response = await app.inject({
          method: 'DELETE',
          url: `/api/v1/objects/${String(sensorId)}/pause`,
        });
        assert.equal(response.statusCode, 409);
        assert.equal(response.json<{ error: { code: string } }>().error.code, 'OBJECT_NOT_PAUSED');
      });

      it('refuses both a duration and a deadline in one request', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: { minutes: 15, until: '2026-09-01T00:00:00Z' },
        });
        assert.equal(response.statusCode, 400);
      });

      it('refuses a deadline in the past, with the reason', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: { until: '2020-01-01T00:00:00Z' },
        });
        assert.equal(response.statusCode, 400);
        const error = response.json<{ error: { details: { problems: string[] } } }>().error;
        assert.ok(error.details.problems[0]?.includes('already in the past'));
      });

      it('shows a paused object in a listing, so a tree can grey the branch', async () => {
        await app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(deviceId)}/pause`,
          payload: {},
        });
        const listing = await app.inject({
          method: 'GET',
          url: '/api/v1/objects',
          query: { parentId: String(groupId), limit: '10' },
        });
        const items = listing.json<{ items: { id: number; paused?: boolean }[] }>().items;
        assert.equal(items.find((item) => item.id === deviceId)?.paused, true);
      });
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import type { DependencyPauses } from '../src/dependencies/pauses.js';
import { DependencySync } from '../src/dependencies/sync.js';
import { resolveDependencyMode } from '../src/dependencies/mode.js';
import { PauseSweep } from '../src/objects/pause-sweep.js';
import { ScheduleSweep } from '../src/schedules/sweep.js';
import { SchedulePauses } from '../src/schedules/pauses.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { DEPENDENCY_DELAY_SECONDS, DEPENDENCY_MASTER_ID } from '../src/settings/registry.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
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

// -------------------------------------------------------------------------------------------
// The three modes, without a tree.
// -------------------------------------------------------------------------------------------

describe('resolving a dependency mode', () => {
  const sensor = { id: 10, kind: 'sensor', parentId: 5, parentKind: 'device' };

  it('inherits by clearing the local value, because that is what inheriting is', () => {
    const resolved = resolveDependencyMode('parent', sensor, undefined);
    assert.ok('write' in resolved);
    assert.equal(resolved.write.targetId, 10);
    assert.equal(resolved.write.masterId, undefined);
  });

  it('depends on nothing by writing an explicit null, which an ancestor cannot override', () => {
    const resolved = resolveDependencyMode('none', sensor, undefined);
    assert.ok('write' in resolved);
    assert.equal(resolved.write.masterId, null);
  });

  it('points at a chosen master', () => {
    const resolved = resolveDependencyMode('object', sensor, 42);
    assert.ok('write' in resolved);
    assert.deepEqual(resolved.write, { targetId: 10, masterId: 42 });
  });

  it('writes "master for parent device" onto the device, not onto the sensor', () => {
    // The whole trick: the setting lands on the device, so every *other* sensor under it
    // inherits this one as their master — and this one keeps scanning, because a master never
    // depends on itself.
    const resolved = resolveDependencyMode('device', sensor, undefined);
    assert.ok('write' in resolved);
    assert.deepEqual(resolved.write, { targetId: 5, masterId: 10 });
  });

  it('refuses the awkward ones rather than writing something that does nothing', () => {
    assert.ok('problems' in resolveDependencyMode('object', sensor, undefined));
    assert.ok('problems' in resolveDependencyMode('object', sensor, 10));
    assert.ok(
      'problems' in
        resolveDependencyMode(
          'device',
          { id: 5, kind: 'device', parentId: 4, parentKind: 'group' },
          undefined,
        ),
    );
    assert.ok(
      'problems' in
        resolveDependencyMode(
          'device',
          { id: 10, kind: 'sensor', parentId: 4, parentKind: 'group' },
          undefined,
        ),
    );
  });
});

// -------------------------------------------------------------------------------------------
// Against a real tree.
// -------------------------------------------------------------------------------------------

describe(
  'dependencies',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let pauses: DependencyPauses;
    let probeId: number;
    let groupId: number;
    let deviceId: number;
    let pingId: number;
    let httpId: number;
    let snmpId: number;

    const NOW = new Date('2026-08-25T12:00:00.000Z');

    before(async () => {
      scratch = await createScratchDatabase('dependencies');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      assert.ok(h.states !== undefined);

      // The one the service was built with, so the pause sweep and these tests are looking at
      // the same reactor rather than two that happen to agree.
      assert.ok(h.dependencies !== undefined);
      pauses = h.dependencies;
      h.audit.also = new DependencySync({ pauses, logger: silent });

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
          name: 'core-switch',
          host: '192.0.2.10',
        })
      ).id;
      pingId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      httpId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'HTTP',
          sensorType: 'icmp.ping',
        })
      ).id;
      snmpId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'SNMP',
          sensorType: 'icmp.ping',
        })
      ).id;

      // Every test starts from "nothing depends on anything": a leftover assignment would be
      // recomputed alongside this test's, and the counts are about these sensors.
      await db.query('DELETE FROM object_setting WHERE key = ANY($1::text[])', [
        [DEPENDENCY_MASTER_ID.key, DEPENDENCY_DELAY_SECONDS.key],
      ]);
      await db.query(
        'UPDATE sensor_runtime SET paused_by_dependency = false, dependency_clear_at = NULL',
      );
      h.audit.recorded.length = 0;
    });

    // -------------------------------------------------------------------------------------
    // Harness.
    // -------------------------------------------------------------------------------------

    /** Puts a sensor into a state directly. The state machine has its own tests. */
    async function setState(id: number, state: SensorState, cause: SensorStateCause = 'scan') {
      await db.query(
        'UPDATE sensor_runtime SET state = $2, cause = $3, last_result_at = $4 WHERE object_id = $1',
        [id, state, cause, NOW],
      );
      // The cache is now behind the database, exactly as it would be after a write it did not
      // make. `forget` takes what a decision produced, so the shape is a runtime write.
      h.states?.forget({
        transitions: [],
        runtimes: [
          {
            sensorId: id,
            at: NOW,
            state,
            cause,
            message: '',
            failure: null,
            since: NOW,
            consecutiveFailures: 0,
            channel: null,
            acknowledged: false,
          },
        ],
      });
    }

    async function runtimeOf(id: number): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      dependency: boolean;
      clearAt: Date | null;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        paused_by_dependency: boolean;
        dependency_clear_at: Date | null;
      }>(
        `SELECT state, cause, paused_by_dependency, dependency_clear_at
         FROM sensor_runtime WHERE object_id = $1`,
        [id],
      );
      const row = rows[0];
      assert.ok(row !== undefined, `no runtime row for ${String(id)}`);
      return {
        state: row.state,
        cause: row.cause,
        dependency: row.paused_by_dependency,
        clearAt: row.dependency_clear_at,
      };
    }

    /** What the ingestor does: hand the reactor the transitions a batch produced. */
    async function react(
      changes: readonly { sensorId: number; state: string; previousState: string | null }[],
      now = NOW,
    ): Promise<number> {
      return db.tx(async (q) => (await pauses.react(q, changes, now)).moved);
    }

    async function masterForDevice(): Promise<void> {
      await h.service.setDependency(testActor, pingId, 'device', undefined, undefined);
    }

    // -------------------------------------------------------------------------------------
    // The cascade.
    // -------------------------------------------------------------------------------------

    it('pauses a device-s other sensors when its master goes Down, and only them', async () => {
      await masterForDevice();
      await setState(pingId, 'down');

      assert.equal(await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]), 2);
      assert.equal((await runtimeOf(httpId)).state, 'paused');
      assert.equal((await runtimeOf(httpId)).cause, 'dependency');
      assert.equal((await runtimeOf(snmpId)).state, 'paused');
      // The whole point of the exclusion: the master itself keeps running, because nothing else
      // can detect that it has recovered. PRTG carried this bug through v19.1.
      assert.equal((await runtimeOf(pingId)).dependency, false);
      assert.equal((await runtimeOf(pingId)).state, 'down');
    });

    it('pauses the dependents when an operator forces the master Down', async () => {
      // **`P-132`.** `M-14`'s simulated error puts sensors into the state the whole dependency
      // mechanism exists to react to — it fires the real notification chain at real people, which
      // is what it is for — and `invalidates` matched none of its mutations. So a master forced
      // Down never paused its dependents, and the storm the dependency was configured to prevent
      // arrived in full, from the button whose purpose is to rehearse exactly that.
      await masterForDevice();
      await h.service.simulateError(
        testActor,
        pingId,
        true,
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'rehearsing the failover',
      );

      assert.equal((await runtimeOf(httpId)).cause, 'dependency');
      assert.equal((await runtimeOf(snmpId)).cause, 'dependency');

      // And lifting it releases them, which is the same defect in the other direction.
      await h.service.simulateError(
        testActor,
        pingId,
        false,
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
      );
      assert.equal((await runtimeOf(httpId)).dependency, false);
    });

    it('does not let two sensors that point at each other hold one another for ever', async () => {
      // **The cascade used to read its own output** (`P-134`). `holding` selected masters that
      // were `paused_by_dependency` — the column the same statement then wrote — which is the
      // recursion the cascade needs and is also a fixpoint that can sustain itself. Two sensors
      // pointing at each other, which a move can arrange and only the assignment path refuses,
      // ended up holding one another: both flags true, each true because the other was, no
      // outage anywhere, permanently unmonitored and permanently unresumable — and nothing
      // logged, because from the row's point of view nothing had changed.
      // Written straight into the settings, because the assignment path refuses the second one —
      // and that is the point: only the assignment path refuses it. A move can arrange the same
      // pair, and the move checks the *tree* for cycles, not the master chain.
      await db.query(
        `INSERT INTO object_setting (object_id, key, value)
         VALUES ($1, $3, to_jsonb($2::bigint)), ($2, $3, to_jsonb($1::bigint))`,
        [httpId, snmpId, DEPENDENCY_MASTER_ID.key],
      );

      // Both flags set, the way a real outage would leave them before the loop closed.
      await db.query(
        `UPDATE sensor_runtime SET paused_by_dependency = true WHERE object_id = ANY($1::bigint[])`,
        [[httpId, snmpId]],
      );
      // Every sensor Up: there is no outage anywhere in the installation.
      await db.query(`UPDATE sensor_runtime SET state = 'up', cause = 'scan'`);

      await db.tx((q) => pauses.recompute(q, NOW));

      assert.equal((await runtimeOf(httpId)).dependency, false, 'nothing is holding it');
      assert.equal((await runtimeOf(snmpId)).dependency, false, 'nor it');
    });

    it('still alarms on a sensor inside a cycle that is genuinely down', async () => {
      // **`R15` — "a cycle contributes nothing and holds nobody" holds only while nothing in the
      // cycle is down.** The test above sets every sensor Up first, so it exercises the
      // ungrounded loop and cannot see this. With A and B as each other's masters and A
      // genuinely failing, the seed was {A}, the recursion added B through A and then A again
      // through B — so A was paused by a hold whose only justification was A itself. Inside one
      // transaction A went down → paused → unknown, the outage was erased, no alarm was armed,
      // and the next scan did it again: a real outage suppressed for as long as the cycle
      // exists, with `sensor_state` churning every interval.
      await db.query(
        `INSERT INTO object_setting (object_id, key, value)
         VALUES ($1, $3, to_jsonb($2::bigint)), ($2, $3, to_jsonb($1::bigint))`,
        [httpId, snmpId, DEPENDENCY_MASTER_ID.key],
      );
      await db.query(`UPDATE sensor_runtime SET state = 'up', cause = 'scan'`);
      await setState(httpId, 'down');

      await db.tx((q) => pauses.recompute(q, NOW));

      assert.equal(
        (await runtimeOf(httpId)).dependency,
        false,
        'the sensor that is down is not held by a hold it is itself the reason for',
      );
      assert.equal(
        (await runtimeOf(httpId)).state,
        'down',
        'and its outage survives, so an alarm can still be armed for it',
      );
      assert.equal(
        (await runtimeOf(snmpId)).dependency,
        false,
        'and neither is the other member of the cycle, which is the trade (`P-171`)',
      );
    });

    it('keeps both outages when both members of a cycle fail together', async () => {
      // **`P-171`, and `P-162` did not cover it.** Carrying the ground refuses a hold a sensor is
      // its *own* reason for, which fixes a cycle with one member down. With both down, each is
      // held by a ground that is the *other*, the guard never fires, and the pair went
      // down → paused → unknown inside one transaction: two real outages erased, no alarm armed
      // for either, and `sensor_state` churning every scan.
      //
      // That is not an exotic state. Two devices at either end of a WAN link, each watching the
      // other, both fail in the same scan interval the moment the link dies — so one ingest
      // batch carries both Down transitions and the settle sees them together.
      await db.query(
        `INSERT INTO object_setting (object_id, key, value)
         VALUES ($1, $3, to_jsonb($2::bigint)), ($2, $3, to_jsonb($1::bigint))`,
        [httpId, snmpId, DEPENDENCY_MASTER_ID.key],
      );
      await db.query(`UPDATE sensor_runtime SET state = 'up', cause = 'scan'`);
      await setState(httpId, 'down');
      await setState(snmpId, 'down');

      await db.tx((q) => pauses.recompute(q, NOW));

      assert.equal((await runtimeOf(httpId)).state, 'down', 'both outages are real');
      assert.equal((await runtimeOf(snmpId)).state, 'down', 'and both survive the settle');
      assert.equal((await runtimeOf(httpId)).dependency, false);
      assert.equal((await runtimeOf(snmpId)).dependency, false);
    });

    it('still holds a dependent that is downstream of a cycle rather than in it', async () => {
      // **The half the exemption must not cost** (`P-171`). A sensor on a master cycle is never
      // *held* — otherwise two members failing together erase both outages — but it still
      // *holds* whatever hangs off it, because a cycle member being Down is a real outage for
      // everything downstream. Suppressing those is the feature working.
      //
      // The trade is deliberate and worth naming: an ill-formed cycle can now produce two alarms
      // for what may be one outage, where before it produced none at all. A duplicate page is
      // recoverable; an erased outage is not.
      await db.query(
        `INSERT INTO object_setting (object_id, key, value)
         VALUES ($1, $3, to_jsonb($2::bigint)), ($2, $3, to_jsonb($1::bigint))`,
        [httpId, snmpId, DEPENDENCY_MASTER_ID.key],
      );
      // A third sensor outside the cycle, pointed at one of its members.
      await db.query(
        `INSERT INTO object_setting (object_id, key, value) VALUES ($1, $3, to_jsonb($2::bigint))`,
        [pingId, httpId, DEPENDENCY_MASTER_ID.key],
      );
      await db.query(`UPDATE sensor_runtime SET state = 'up', cause = 'scan'`);
      await setState(httpId, 'down');

      await db.tx((q) => pauses.recompute(q, NOW));

      assert.equal((await runtimeOf(httpId)).state, 'down', 'the cycle member alarms');
      assert.equal(
        (await runtimeOf(pingId)).dependency,
        true,
        'and the sensor downstream of it is still suppressed',
      );
    });

    it('keeps the master in the probe-s configuration while its dependents leave it', async () => {
      const config = new ProbeConfigService({ db, resolver: h.resolver });
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      const assignments = await config.assignmentsFor(probeId);
      const ids = assignments.sensors.map((sensor) => sensor.sensorId);
      assert.ok(ids.includes(pingId), 'the master is still scanned');
      assert.ok(!ids.includes(httpId));
      assert.ok(!ids.includes(snmpId));
    });

    it('names the master in the state history by id, so the outage is findable', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      const rows = await db.query<{ message: string }>(
        'SELECT message FROM sensor_state WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1',
        [httpId],
      );
      // The sensor, not the device: an operator reading this needs the object that is down, and
      // "core-switch is Down" would name something that has no state of its own.
      //
      // **By id, and not by name** (`A-12`). This row is the dependent's history, read by
      // everybody who can read the dependent, and the master can be in a branch they were never
      // granted. The pause view names it to whoever may see it.
      assert.equal(rows[0]?.message, `master #${String(pingId)} is Down`);
    });

    it('holds a sensor created while the master is already Down', async () => {
      // **`P-93`.** `object.created` was skipped on the grounds that such a sensor "is picked up
      // by the next state change of that master or by the next sweep". `ScheduleSweep` settles
      // dependencies on the minute now (`P-136`), which is a repair and not a schedule to wait
      // for — the new sensor would scan unheld until the next tick — and `sweepPauses` still
      // calls only `releaseElapsed`, which does nothing unless a `dependency_clear_at` is due.
      // The master emits no further transitions while it
      // stays Down, because `react` runs on what a *result batch* produced and a master sitting
      // at Down produces none.
      //
      // So the new sensor scanned right through the outage, failed, went Down and armed its own
      // alarm: one outage, two alarms, out of the exact topology the dependency exists to
      // collapse. A template application, a clone or a rediscovery reaches this the same way an
      // operator does.
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      const late = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'Late arrival',
        sensorType: 'icmp.ping',
      });

      const runtime = await runtimeOf(late.id);
      assert.equal(runtime.dependency, true, 'held, like every other sensor under this master');
      assert.equal(runtime.state, 'paused');
    });

    it('releases them when the master is deleted, rather than holding them for ever', async () => {
      // **`P-88`.** `DependencySync` reacts to `object.deleted` for exactly this reason — a
      // stale flag "would pause them for ever with no object left to point at" — but the audit
      // entry was recorded *before* the rows were deleted, and `CompositeAuditSink.record` fans
      // out synchronously inside that same transaction. So the reactor ran while the master was
      // still present and still Down: `holding` still named it, nothing moved, and the sink
      // that exists to prevent this was the one thing guaranteed not to see it.
      //
      // The dependents are then invisible rather than merely stuck: `assignmentsFor` excludes
      // them so the probe never scans them again, and `pauseState` computes the holder from a
      // master that no longer exists and answers `paused: false` — so `resume` refuses them too.
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(httpId)).dependency, true, 'held while the master is Down');

      await h.service.delete(testActor, pingId, { kind: 'leafOnly' }, { kind: 'none' });

      const after = await runtimeOf(httpId);
      assert.equal(after.dependency, false, 'nothing left to hold it');
      assert.notEqual(after.state, 'paused', 'and it is scannable again');
    });

    it('releases them when the master recovers, with no delay configured', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      await setState(pingId, 'up');
      assert.equal(await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]), 2);
      const http = await runtimeOf(httpId);
      assert.equal(http.dependency, false);
      // §3: a resumed sensor awaits its next scan rather than returning to a state nothing has
      // checked since.
      assert.equal(http.state, 'unknown');
    });

    it('treats Down (Acknowledged) as still Down, because the target still is', async () => {
      await masterForDevice();
      await setState(pingId, 'down_acknowledged', 'user');
      assert.equal(
        await react([{ sensorId: pingId, state: 'down_acknowledged', previousState: 'down' }]),
        2,
      );
      assert.equal((await runtimeOf(httpId)).state, 'paused');
    });

    it('does not cascade when the master is merely paused', async () => {
      // WORKFLOW.MD §5: only a genuine Down triggers dependency pausing. Pausing a master by
      // hand is a statement about the master, not about the thing it stands for.
      await masterForDevice();
      await h.service.pause(testActor, pingId, { kind: 'indefinite' }, 'maintenance');
      assert.equal((await runtimeOf(pingId)).state, 'paused');
      assert.equal((await runtimeOf(httpId)).dependency, false);
      assert.equal((await runtimeOf(httpId)).state, 'unknown');
    });

    it('cascades recursively: dependents of a paused dependent also pause', async () => {
      // A second device whose sensors depend on the first device's HTTP sensor, which itself
      // depends on Ping. One outage at the top pauses both levels.
      const second = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'app-server',
          host: '192.0.2.11',
        })
      ).id;
      const appSensor = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: second,
          name: 'App',
          sensorType: 'icmp.ping',
        })
      ).id;
      await masterForDevice();
      await h.service.setDependency(testActor, second, 'object', httpId, undefined);

      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      assert.equal((await runtimeOf(httpId)).state, 'paused', 'first level');
      assert.equal((await runtimeOf(appSensor)).state, 'paused', 'second level');
      assert.equal((await runtimeOf(appSensor)).cause, 'dependency');
    });

    it('lets one sensor opt out of the dependency its device carries', async () => {
      await masterForDevice();
      await h.service.setDependency(testActor, snmpId, 'none', undefined, undefined);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      assert.equal((await runtimeOf(httpId)).state, 'paused');
      assert.equal((await runtimeOf(snmpId)).dependency, false, 'exempted by an explicit none');
    });

    it('agrees with the resolver, which walks the tree the other way', async () => {
      await masterForDevice();
      await h.service.setDependency(testActor, snmpId, 'none', undefined, undefined);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      const resolved = await h.resolver.resolveForObjects<number | null>(
        [pingId, httpId, snmpId],
        DEPENDENCY_MASTER_ID.key,
      );
      for (const id of [pingId, httpId, snmpId]) {
        const master = resolved.get(id)?.value ?? null;
        const expected = master === pingId && id !== pingId;
        assert.equal((await runtimeOf(id)).dependency, expected, `sensor ${String(id)}`);
      }
    });

    // -------------------------------------------------------------------------------------
    // The delay after recovery.
    // -------------------------------------------------------------------------------------

    it('keeps dependents paused through the configured delay, then releases them', async () => {
      await h.service.setDependency(testActor, pingId, 'device', undefined, 300);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(httpId)).state, 'paused');

      await setState(pingId, 'up');
      assert.equal(
        await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]),
        0,
        'the recovery alone releases nothing',
      );
      assert.equal((await runtimeOf(httpId)).state, 'paused', 'still held by the delay');
      assert.ok((await runtimeOf(pingId)).clearAt !== null, 'and the deadline is on the master');

      // The sweep is what notices the deadline, exactly as it notices a pause expiring.
      await db.query(
        `UPDATE sensor_runtime SET dependency_clear_at = now() - interval '1 second'
         WHERE object_id = $1`,
        [pingId],
      );
      const released = await db.tx(async (q) => (await pauses.releaseElapsed(q, new Date())).moved);
      assert.equal(released, 2);
      assert.equal((await runtimeOf(httpId)).state, 'unknown');
      assert.equal((await runtimeOf(pingId)).clearAt, null, 'and the deadline is spent');
    });

    it('applies the delay a dependent in another subtree configured', async () => {
      // **`P-89`.** The existing case above uses `device` mode, where the master sensor sits
      // inside the device the setting lands on — so resolving the delay on the *master* happens
      // to find it. WORKFLOW.MD §5's other mode is "every branch-office device depends on the
      // WAN link sensor", where the master is somewhere else entirely: the value is not on its
      // chain, and every recovery fell back to the registry default of 0 while `GET` and the
      // resolver went on reporting the configured 300.
      //
      // The visible cost is a flap storm. Released immediately, the dependents are pushed back
      // into the probe configuration, re-scanned and re-paused on the next bounce — two rows
      // each per bounce in `sensor_state`, which uptime and SLA are computed from.
      const branch = await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'branch-office',
        host: '192.0.2.20',
      });
      const branchSensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: branch.id,
        name: 'Branch ping',
        sensorType: 'icmp.ping',
      });
      await h.service.setDependency(testActor, branch.id, 'object', pingId, 300);
      assert.equal(
        (await h.resolver.resolve<number>(branchSensor.id, DEPENDENCY_DELAY_SECONDS.key)).value,
        300,
        'the delay is configured, and the resolver says so',
      );

      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(branchSensor.id)).state, 'paused');

      await setState(pingId, 'up');
      await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]);
      assert.ok(
        (await runtimeOf(pingId)).clearAt !== null,
        'the master holds for the delay its dependent configured, not for the default of 0',
      );
      assert.equal((await runtimeOf(branchSensor.id)).state, 'paused', 'still held');
    });

    it('restarts the delay when the master flaps, rather than accumulating one', async () => {
      // docs/state-machine.md §6 asked M-11 what happens if the master flaps during the delay.
      // A fresh failure discards the deadline; a fresh recovery writes a new one.
      await h.service.setDependency(testActor, pingId, 'device', undefined, 300);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await setState(pingId, 'up');
      await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]);
      const first = (await runtimeOf(pingId)).clearAt;
      assert.ok(first !== null);

      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(pingId)).clearAt, null, 'the deadline is discarded');

      await setState(pingId, 'up');
      await react(
        [{ sensorId: pingId, state: 'up', previousState: 'down' }],
        new Date(NOW.getTime() + 60_000),
      );
      const second = (await runtimeOf(pingId)).clearAt;
      assert.ok(second !== null);
      assert.ok(second.getTime() > first.getTime(), 'a new deadline, not the old one extended');
    });

    it('tells the probes, on the one write path the audit sink does not cover', async () => {
      // A check result is not a configuration change, so nothing rides the audit sink here.
      // Without the poke the probes would keep scanning sensors the core has already paused —
      // harmless to the states, and wasted work during exactly the outage that caused it.
      let pushes = 0;
      const sweep = new PauseSweep({
        service: h.service,
        logger: silent,
        onChanged: () => {
          pushes += 1;
        },
      });
      await h.service.setDependency(testActor, pingId, 'device', undefined, 300);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await setState(pingId, 'up');
      await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]);
      await db.query(
        `UPDATE sensor_runtime SET dependency_clear_at = now() - interval '1 second'
         WHERE object_id = $1`,
        [pingId],
      );

      assert.equal(await sweep.sweep(), 2);
      assert.equal(pushes, 1, 'once, after the release');
      assert.equal(await sweep.sweep(), 0);
      assert.equal(pushes, 1, 'and not for a sweep that changed nothing');
    });

    it('is pushed by whichever sweep gets there first, not only by the pause sweep', async () => {
      // **`R14`, `G09` — `P-136` added a settle to the schedule sweep and discarded its
      // result.** `applyPauses` computes `holding` from `dependency_clear_at > now`, so the
      // minute a master's recovery delay elapses it is *this* sweep that releases its
      // dependents' flags — and the push decision read only the schedule half, which moved
      // nothing. The `PauseSweep` that was meant to handle the event then found `releaseElapsed`
      // settling nothing, so it did not push either. Forty sensors unpaused in the database,
      // absent from the probe's assignment list, and unscanned until an unrelated configuration
      // change happened to poke the fingerprint.
      let pushes = 0;
      const sweep = new ScheduleSweep({
        db,
        pauses: new SchedulePauses({
          logger: silent,
          ...(h.states === undefined ? {} : { states: h.states }),
        }),
        dependencies: pauses,
        logger: silent,
        onChanged: () => {
          pushes += 1;
        },
      });

      await h.service.setDependency(testActor, pingId, 'device', undefined, 300);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await setState(pingId, 'up');
      await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]);
      assert.equal((await runtimeOf(httpId)).dependency, true, 'held through the delay');
      await db.query(
        `UPDATE sensor_runtime SET dependency_clear_at = now() - interval '1 second'
         WHERE object_id = $1`,
        [pingId],
      );

      // No schedule anywhere in this installation, so the schedule half moves nothing: this is
      // the sweep whose only work is the dependency settle.
      await sweep.sweep();
      assert.equal(
        (await runtimeOf(httpId)).dependency,
        false,
        'the delay elapsed, so this sweep is what released them',
      );
      assert.equal(pushes, 1, 'and the probes have to be told, because it moved a flag they read');
    });

    it('is released by the pause sweep, alongside every other deadline', async () => {
      await h.service.setDependency(testActor, pingId, 'device', undefined, 300);
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await setState(pingId, 'up');
      await react([{ sensorId: pingId, state: 'up', previousState: 'down' }]);
      await db.query(
        `UPDATE sensor_runtime SET dependency_clear_at = now() - interval '1 second'
         WHERE object_id = $1`,
        [pingId],
      );

      const sweep = new PauseSweep({ service: h.service, logger: silent });
      assert.equal(await sweep.sweep(), 2, 'the sweep released both dependents');
      assert.equal((await runtimeOf(httpId)).state, 'unknown');
    });

    // -------------------------------------------------------------------------------------
    // Refusals.
    // -------------------------------------------------------------------------------------

    it('refuses a loop, because a loop of masters can never recover', async () => {
      // A depends on B and B depends on A: whichever goes Down first pauses the other, the
      // paused one stops scanning, and neither can ever recover. Refused where it is made.
      const second = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'second',
          host: '192.0.2.12',
        })
      ).id;
      const other = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: second,
          name: 'Other ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      await h.service.setDependency(testActor, deviceId, 'object', other, undefined);

      await assert.rejects(
        () => h.service.setDependency(testActor, second, 'object', pingId, undefined),
        (error: unknown) => {
          const err = error as { code?: string; details?: { path?: number[] } };
          assert.equal(err.code, 'OBJECT_CYCLE');
          assert.ok((err.details?.path ?? []).includes(pingId));
          return true;
        },
      );
    });

    it('refuses a master that is not a sensor, and one that does not exist', async () => {
      await assert.rejects(
        () => h.service.setDependency(testActor, httpId, 'object', deviceId, undefined),
        (error: unknown) => {
          assert.ok((error as Error).message.includes('must be a sensor'));
          return true;
        },
      );
      await assert.rejects(() =>
        h.service.setDependency(testActor, httpId, 'object', 9_999_999, undefined),
      );
    });

    it('refuses an object that depends on itself', async () => {
      await assert.rejects(() =>
        h.service.setDependency(testActor, httpId, 'object', httpId, undefined),
      );
    });

    // -------------------------------------------------------------------------------------
    // What the rest of the system sees.
    // -------------------------------------------------------------------------------------

    it('says on the pause view which master is holding an object', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);

      const view = await h.service.pauseState(httpId);
      assert.equal(view.paused, true);
      assert.equal(view.source, 'dependency');
      assert.ok(view.dependency !== null);
      assert.equal(view.dependency.masterId, pingId);
      assert.equal(view.dependency.masterName, 'Ping');
      assert.equal(view.dependency.holding, true);
      assert.equal(view.dependency.definedOn, deviceId, 'and where the assignment lives');

      // The master's own view names the same dependency and says it is not held by it.
      const master = await h.service.pauseState(pingId);
      assert.equal(master.dependency?.holding, false, 'a master never holds itself');
      assert.equal(master.paused, false);
    });

    it('reports the parent cascade ahead of a dependency, in the order §5 evaluates them', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await h.service.pause(testActor, groupId, { kind: 'indefinite' }, 'planned');

      const view = await h.service.pauseState(httpId);
      assert.equal(view.source, 'parent');
      assert.equal((await runtimeOf(httpId)).cause, 'parent', 'and the state agrees');
    });

    it('undoes "master for parent device" when the sensor leaves that mode', async () => {
      // The setting lives on the device, so clearing only the sensor's own value would leave it
      // master of a device it no longer claims to be — a dropdown that cannot be changed back.
      await masterForDevice();
      const before = await h.resolver.own(deviceId);
      assert.equal(before[DEPENDENCY_MASTER_ID.key], pingId);

      await h.service.setDependency(testActor, pingId, 'parent', undefined, undefined);
      const after = await h.resolver.own(deviceId);
      assert.equal(after[DEPENDENCY_MASTER_ID.key], undefined, 'the device no longer names it');
      assert.equal((await h.service.pauseState(httpId)).dependency, null);
    });

    it('lifts the flag when the assignment is cleared, in the same transaction', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(httpId)).state, 'paused');

      await h.service.setDependency(testActor, deviceId, 'parent', undefined, undefined);
      assert.equal((await runtimeOf(httpId)).dependency, false, 'lifted by the audit sink');
    });

    // -------------------------------------------------------------------------------------
    // A withheld master (`M-23`).
    // -------------------------------------------------------------------------------------

    /** What the voucher check does to a master it withholds: mark, then re-decide, then settle. */
    async function withhold(id: number): Promise<void> {
      await db.tx((q) => pauses.holdWithheld(q, [id]));
      await setState(id, 'unknown', 'access');
      await db.tx((q) => pauses.recompute(q, NOW));
    }

    /** And to one it vouches for again, which re-decides it as `state`. */
    async function vouchAgain(id: number, state: SensorState, cause: SensorStateCause = 'scan') {
      await setState(id, state, cause);
      await db.tx(async (q) => {
        await pauses.returnWithheld(q, [id], NOW);
        await pauses.recompute(q, NOW);
      });
    }

    it('keeps a master withheld while Down holding, with no release time, until it is evaluated again', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(httpId)).dependency, true, 'held by the outage');

      await withhold(pingId);
      assert.equal((await runtimeOf(httpId)).dependency, true, 'still held, withheld');
      assert.equal((await runtimeOf(snmpId)).dependency, true);

      // Held, and no date to release it: the view says so, and so does the API.
      const view = await h.service.pauseState(httpId);
      assert.equal(view.source, 'dependency');
      assert.deepEqual(
        [view.dependency?.holding, view.dependency?.releasesAt, view.dependency?.masterState],
        [true, null, 'unknown'],
      );
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(httpId)}/pause`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ dependency: { holding: boolean; releasesAt: unknown } }>();
      assert.deepEqual([body.dependency.holding, body.dependency.releasesAt], [true, null]);
    });

    it('lets a withheld master go while it is paused, and holds again if it comes back withheld', async () => {
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await withhold(pingId);

      await setState(pingId, 'paused', 'user');
      await db.tx((q) => pauses.recompute(q, NOW));
      assert.equal((await runtimeOf(httpId)).dependency, false, 'a paused master holds nothing');
      assert.equal((await h.service.pauseState(httpId)).dependency?.holding, false);

      await setState(pingId, 'unknown', 'access');
      await db.tx((q) => pauses.recompute(q, NOW));
      assert.equal((await runtimeOf(httpId)).dependency, true, 'withheld again, held again');
    });

    it('holds only for a master that was Down when it was withheld', async () => {
      await masterForDevice();
      // Up: nothing to hold, and nothing is marked.
      await setState(pingId, 'up');
      await withhold(pingId);
      assert.equal((await runtimeOf(pingId)).clearAt, null);
      assert.equal((await runtimeOf(httpId)).dependency, false);
      // Down, but a master of nothing: not marked either.
      await setState(snmpId, 'down');
      await db.tx((q) => pauses.holdWithheld(q, [snmpId]));
      assert.equal((await runtimeOf(snmpId)).clearAt, null);
    });

    it('settles a master vouched for again as any master returning from Down does', async () => {
      await h.service.setDependency(testActor, pingId, 'device', undefined, 300);
      const cases: [SensorState, SensorStateCause, boolean, string][] = [
        ['down', 'scan', true, 'Down again: held by being Down'],
        ['paused', 'user', false, 'paused: let go, as a paused master always is'],
        ['up', 'scan', true, 'recovered: held for the configured delay'],
      ];
      for (const [state, cause, held, why] of cases) {
        await setState(pingId, 'down');
        await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
        await withhold(pingId);
        await vouchAgain(pingId, state, cause);
        assert.equal((await runtimeOf(httpId)).dependency, held, why);
        const clearAt = (await runtimeOf(pingId)).clearAt;
        assert.equal(
          clearAt?.getTime() ?? null,
          state === 'up' ? NOW.getTime() + 300_000 : null,
          `${why}: the deadline`,
        );
      }
      // And the delay runs out as any recovery's does.
      await db.tx((q) => pauses.releaseElapsed(q, new Date(NOW.getTime() + 301_000)));
      assert.equal((await runtimeOf(httpId)).dependency, false);
    });

    it('keeps a Sensor Factory held Down for its inputs’ probe holding, as a withheld master (`M-26`)', async () => {
      // Its dependents may be anywhere, scanned as before, and would each page on the outage it
      // can no longer speak for: `M-23`'s reason, reached through a lost probe.
      const factory = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Total',
          sensorType: 'core.factory',
          params: { channels: [{ key: 'v', formula: `channel(${String(snmpId)}, 'x')` }] },
        } as never)
      ).id;
      await h.service.setDependency(testActor, factory, 'device', undefined, undefined);
      await setState(factory, 'down');
      await react([{ sensorId: factory, state: 'down', previousState: 'up' }]);
      assert.equal((await runtimeOf(httpId)).dependency, true, 'held by the outage');

      // What `FactoryReach` does: mark, re-decide, settle.
      await db.tx((q) => pauses.holdWithheld(q, [factory]));
      await setState(factory, 'unknown', 'probe');
      await db.tx((q) => pauses.recompute(q, NOW));
      assert.equal((await runtimeOf(httpId)).dependency, true, 'still held');
      const view = await h.service.pauseState(httpId);
      assert.deepEqual(
        [view.dependency?.holding, view.dependency?.releasesAt, view.dependency?.masterState],
        [true, null, 'unknown'],
      );
    });

    it('lets a master marked while withheld go when its own probe is lost, as `P-135` has it (`M-26`)', async () => {
      // Its dependents are Unknown with it. The mark is still there, and only a factory reading
      // Unknown for its probe is held by one.
      await masterForDevice();
      await setState(pingId, 'down');
      await react([{ sensorId: pingId, state: 'down', previousState: 'up' }]);
      await withhold(pingId);
      assert.equal((await runtimeOf(httpId)).dependency, true, 'withheld: held');

      await setState(pingId, 'unknown', 'probe');
      await db.tx((q) => pauses.recompute(q, NOW));
      assert.equal((await runtimeOf(httpId)).dependency, false, 'its probe lost: let go');
      assert.equal((await h.service.pauseState(httpId)).dependency?.holding, false);
    });

    // -------------------------------------------------------------------------------------
    // Over HTTP.
    // -------------------------------------------------------------------------------------

    it('sets a master object for the parent device over HTTP', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(pingId)}/dependency`,
        payload: { mode: 'device', delaySeconds: 120 },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<{ dependency: { masterId: number; definedOn: number } | null }>();
      assert.ok(body.dependency !== null);
      assert.equal(body.dependency.masterId, pingId);
      assert.equal(body.dependency.definedOn, deviceId);

      const delay = await h.resolver.resolve<number>(httpId, DEPENDENCY_DELAY_SECONDS.key);
      assert.equal(delay.value, 120, 'and the delay is inherited from the device');
    });

    it('refuses a loop over HTTP with a 409, not a 500', async () => {
      const second = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'loop-b',
          host: '192.0.2.13',
        })
      ).id;
      const other = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: second,
          name: 'Loop ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      await h.service.setDependency(testActor, deviceId, 'object', other, undefined);

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(second)}/dependency`,
        payload: { mode: 'object', masterId: pingId },
      });
      assert.equal(response.statusCode, 409);
      assert.ok(JSON.stringify(response.json()).includes('loop'));
    });

    it('refuses "master for parent device" on something that is not a sensor', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/objects/${String(deviceId)}/dependency`,
        payload: { mode: 'device' },
      });
      assert.equal(response.statusCode, 400);
    });
  },
);

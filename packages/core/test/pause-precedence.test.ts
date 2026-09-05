import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { DependencySync } from '../src/dependencies/sync.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { ScheduleService } from '../src/schedules/service.js';
import { SchedulePauses } from '../src/schedules/pauses.js';
import { ScheduleSync } from '../src/schedules/sync.js';
import { SCHEDULE_ID } from '../src/settings/registry.js';
import { PAUSE_PRECEDENCE, PAUSE_SOURCES, type PauseSource } from '../src/state/tables.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
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
 * `M-12`: the four sources, together, against a real tree.
 *
 * `state-machine.test.ts` already drives all sixteen combinations through the pure evaluator, and
 * `state-tables.test.ts` checks the table against its own rule. Neither of them can catch the
 * thing `PLAN.md` calls Phase 3's principal risk, because both are one derivation checked against
 * itself: what is untested until here is whether the four *mechanisms* — a row in `object_pause`,
 * a master going Down, a window closing, an operator clicking pause — actually produce the flags
 * the table says they do, when they are all in play at once and each has its own recompute.
 *
 * So this arranges each combination through the real path, with no flag ever written by hand.
 */
describe(
  'pause precedence, end to end',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let schedules: ScheduleService;
    let schedulePauses: SchedulePauses;
    let probeId: number;
    let watchedGroupId: number;
    let deviceId: number;
    let sensorId: number;
    let siblingId: number;
    let masterId: number;
    let masterDeviceId: number;
    let closedScheduleId: number;

    /** Monday 03:00 UTC — outside the office-hours window used below. */
    const OUTSIDE = new Date('2026-08-24T03:00:00.000Z');

    before(async () => {
      scratch = await createScratchDatabase('precedence');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      assert.ok(h.states !== undefined);
      assert.ok(h.dependencies !== undefined);

      schedulePauses = new SchedulePauses({ logger: silent, states: h.states });
      // Both sinks where they sit in production: inside every mutation's own transaction.
      h.audit.also = new CompositeAuditSink([
        new ScheduleSync({ pauses: schedulePauses, logger: silent }),
        new DependencySync({ pauses: h.dependencies, logger: silent }),
      ]);
      schedules = new ScheduleService({
        db,
        audit: new CompositeAuditSink([
          new DatabaseAuditSink(),
          new ScheduleSync({ pauses: schedulePauses, logger: silent }),
        ]),
        logger: silent,
      });

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        schedules,
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

      // The master lives in its own branch, deliberately. Putting it under the group that the
      // `parent` case pauses would make two of the sources exclusive: a paused master is not a
      // Down master, so the dependency would release exactly when the cascade arrived — which is
      // correct behaviour and would have made half this table unreachable.
      const masterGroup = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'masters' })
      ).id;
      masterDeviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: masterGroup,
          name: 'core-switch',
          host: '192.0.2.1',
        })
      ).id;
      masterId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: masterDeviceId,
          name: 'Master ping',
          sensorType: 'icmp.ping',
        })
      ).id;

      watchedGroupId = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'watched' })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: watchedGroupId,
          name: 'app-server',
          host: '192.0.2.2',
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

      closedScheduleId = (
        await schedules.create(testActor, {
          name: `office-${String(process.hrtime.bigint())}`,
          periods: 'mo:08:00-mo:18:00',
        })
      ).id;

      h.audit.recorded.length = 0;
    });

    // -------------------------------------------------------------------------------------
    // Arranging each source through the mechanism that really sets it.
    // -------------------------------------------------------------------------------------

    async function setMasterState(state: SensorState): Promise<void> {
      await db.query(
        `UPDATE sensor_runtime SET state = $2, cause = 'scan', last_result_at = $3
         WHERE object_id = $1`,
        [masterId, state, OUTSIDE],
      );
      h.states?.forget({
        transitions: [],
        runtimes: [
          {
            sensorId: masterId,
            at: OUTSIDE,
            state,
            cause: 'scan',
            message: '',
            since: OUTSIDE,
            consecutiveFailures: 0,
            channel: null,
            acknowledged: false,
          },
        ],
      });
      await db.tx(async (q) => {
        await h.dependencies?.react(
          q,
          [{ sensorId: masterId, state, previousState: state === 'down' ? 'up' : 'down' }],
          OUTSIDE,
        );
      });
    }

    /** Turns exactly one source on, using the path an operator or the system really uses. */
    async function turnOn(source: PauseSource): Promise<void> {
      switch (source) {
        case 'parent':
          await h.service.pause(testActor, watchedGroupId, { kind: 'indefinite' }, 'group work');
          return;
        case 'dependency':
          await h.service.setDependency(testActor, sensorId, 'object', masterId, undefined);
          await setMasterState('down');
          return;
        case 'schedule':
          await h.service.setSetting(testActor, sensorId, SCHEDULE_ID.key, closedScheduleId);
          await db.tx(async (q) => {
            await schedulePauses.recompute(q, OUTSIDE);
          });
          return;
        case 'manual':
          await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'by hand');
          return;
      }
    }

    async function turnOff(source: PauseSource): Promise<void> {
      switch (source) {
        case 'parent':
          await h.service.resume(testActor, watchedGroupId);
          return;
        case 'dependency':
          await setMasterState('up');
          return;
        case 'schedule':
          await h.service.clearSetting(testActor, sensorId, SCHEDULE_ID.key);
          await db.tx(async (q) => {
            await schedulePauses.recompute(q, OUTSIDE);
          });
          return;
        case 'manual':
          await h.service.resume(testActor, sensorId);
          return;
      }
    }

    async function flagsOf(id: number): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      active: PauseSource[];
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        paused_by_parent: boolean;
        paused_by_dependency: boolean;
        paused_by_schedule: boolean;
        paused_manually: boolean;
      }>(
        `SELECT state, cause, paused_by_parent, paused_by_dependency, paused_by_schedule,
                paused_manually
         FROM sensor_runtime WHERE object_id = $1`,
        [id],
      );
      const row = rows[0];
      assert.ok(row !== undefined, `no runtime row for ${String(id)}`);
      return {
        state: row.state,
        cause: row.cause,
        active: [
          ...(row.paused_by_parent ? (['parent'] as const) : []),
          ...(row.paused_by_dependency ? (['dependency'] as const) : []),
          ...(row.paused_by_schedule ? (['schedule'] as const) : []),
          ...(row.paused_manually ? (['manual'] as const) : []),
        ],
      };
    }

    // -------------------------------------------------------------------------------------
    // The table, against the real thing.
    // -------------------------------------------------------------------------------------

    for (const expected of PAUSE_PRECEDENCE) {
      const label = expected.active.length === 0 ? 'nothing' : expected.active.join(' + ');
      it(`holds a sensor by ${label}, reporting ${expected.cause ?? 'no pause'}`, async () => {
        for (const source of expected.active) await turnOn(source);

        const flags = await flagsOf(sensorId);
        assert.deepEqual(flags.active, [...expected.active], 'the flags the mechanisms set');
        if (expected.paused) {
          assert.equal(flags.state, 'paused');
          assert.equal(flags.cause, expected.cause);
        } else {
          assert.notEqual(flags.state, 'paused');
        }

        // The view an operator reads has to agree with the row a probe is filtered by, or one of
        // them is lying about the same sensor.
        const view = await h.service.pauseState(sensorId);
        assert.equal(view.paused, expected.paused);
        assert.equal(
          view.source,
          expected.cause === null ? null : expected.cause === 'user' ? 'manual' : expected.cause,
        );

        const config = new ProbeConfigService({ db, resolver: h.resolver });
        const scheduled = (await config.assignmentsFor(probeId)).sensors.map((s) => s.sensorId);
        assert.equal(
          scheduled.includes(sensorId),
          !expected.paused,
          'a paused sensor is not in its probe configuration at all',
        );
      });
    }

    // -------------------------------------------------------------------------------------
    // The property the table exists to protect.
    // -------------------------------------------------------------------------------------

    it('stays paused as each source clears, reporting the next one down the order', async () => {
      // The whole risk `PLAN.md` names: if precedence were a priority *chain*, lifting the
      // highest source would resume the sensor. Because the four are an independent set, it does
      // not — the reported cause simply moves down.
      for (const source of PAUSE_SOURCES) await turnOn(source);
      assert.deepEqual((await flagsOf(sensorId)).active, [...PAUSE_SOURCES]);

      const reported: (SensorStateCause | null)[] = [];
      for (const source of PAUSE_SOURCES) {
        const before = await flagsOf(sensorId);
        assert.equal(before.state, 'paused', `still paused before clearing ${source}`);
        reported.push(before.cause);
        await turnOff(source);
      }

      assert.deepEqual(
        reported,
        ['parent', 'dependency', 'schedule', 'user'],
        'each source reported in turn as the one above it cleared',
      );
      const finally_ = await flagsOf(sensorId);
      assert.deepEqual(finally_.active, []);
      // §3: a resumed sensor awaits its next scan rather than returning to a state nothing has
      // checked since.
      assert.equal(finally_.state, 'unknown');
    });

    it('leaves a sibling alone: the flags are per sensor, not per subtree', async () => {
      await turnOn('manual');
      await turnOn('schedule');
      assert.deepEqual((await flagsOf(sensorId)).active, ['schedule', 'manual']);
      assert.deepEqual((await flagsOf(siblingId)).active, []);
    });

    // -------------------------------------------------------------------------------------
    // Resuming, and what the API says when it will not.
    // -------------------------------------------------------------------------------------

    it('refuses to resume a sensor its group is holding, and names the group', async () => {
      await turnOn('parent');
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(sensorId)}/pause`,
      });
      assert.equal(response.statusCode, 409);
      const body = response.json<{
        error: { message: string; details: { source: string; pausedBy: number } };
      }>();
      assert.equal(body.error.details.source, 'parent');
      assert.equal(body.error.details.pausedBy, watchedGroupId);
      assert.ok(body.error.message.includes('resume that instead'), body.error.message);
    });

    it('refuses to resume one a master is holding, and says what would release it', async () => {
      await turnOn('dependency');
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(sensorId)}/pause`,
      });
      assert.equal(response.statusCode, 409);
      const body = response.json<{
        error: { message: string; details: { source: string; masterId: number } };
      }>();
      assert.equal(body.error.details.source, 'dependency');
      assert.equal(body.error.details.masterId, masterId);
      assert.ok(body.error.message.includes('when the master recovers'), body.error.message);
    });

    it('refuses to resume one a schedule is holding, and says when the window opens', async () => {
      await turnOn('schedule');
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(sensorId)}/pause`,
      });
      assert.equal(response.statusCode, 409);
      const body = response.json<{
        error: { message: string; details: { source: string; nextChangeAt: string | null } };
      }>();
      assert.equal(body.error.details.source, 'schedule');
      assert.ok(body.error.details.nextChangeAt !== null, 'and when it lifts');
      assert.ok(body.error.message.includes('resumes when the window opens'), body.error.message);
    });

    it('resuming the object that was paused does not resume one another source still holds', async () => {
      await turnOn('parent');
      await turnOn('manual');
      // The sensor owns a pause of its own, so this one is allowed — and it must not be enough.
      await h.service.resume(testActor, sensorId);

      const flags = await flagsOf(sensorId);
      assert.deepEqual(flags.active, ['parent']);
      assert.equal(flags.state, 'paused');
      assert.equal(flags.cause, 'parent', 'the reported cause moved, the pause did not lift');
    });

    it('says "not paused" only when nothing at all is holding it', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/objects/${String(sensorId)}/pause`,
      });
      assert.equal(response.statusCode, 409);
      const body = response.json<{ error: { message: string; details: { source: null } } }>();
      assert.equal(body.error.details.source, null);
      assert.ok(body.error.message.includes('not paused'));
    });

    it('releases a dependency when the master itself is paused, not when it is Down', async () => {
      // The interaction the sixteen rows above cannot express, because they keep the master out
      // of the paused subtree on purpose. `WORKFLOW.MD §5`: only a genuine Down triggers
      // dependency pausing — so pausing a group that *contains* the master stops it being Down
      // and releases its dependents, which is the opposite of what "pause the group" sounds
      // like it should do to things depending on something inside it.
      await turnOn('dependency');
      assert.deepEqual((await flagsOf(sensorId)).active, ['dependency']);

      // Pausing the master's device makes the master Paused rather than Down.
      await h.service.pause(
        testActor,
        masterDeviceId,
        { kind: 'indefinite' },
        'master maintenance',
      );

      assert.equal((await flagsOf(masterId)).state, 'paused');
      assert.deepEqual(
        (await flagsOf(sensorId)).active,
        [],
        'the dependent is released: a paused master is not a Down master',
      );

      // **And the release is what production does, not what this test does** (`P-87`). This
      // case passed for two weeks while calling `dependencies.recompute` by hand on the line
      // above — supplying the exact trigger whose absence was the defect. `DependencySync` saw
      // `object.paused` fall through to `default: return false`, so nothing recomputed and the
      // dependent stayed held for ever. A test that provides the missing step tests the step
      // after it.
      const pauseState = await h.service.pauseState(sensorId);
      assert.equal(pauseState.paused, false, 'and the API agrees with the row');
    });

    it('reports every holder at once, so a UI can show all four', async () => {
      for (const source of PAUSE_SOURCES) await turnOn(source);
      const view = await h.service.pauseState(sensorId);

      assert.equal(view.paused, true);
      assert.equal(view.source, 'parent', 'the one §5 reports');
      assert.equal(view.inheritedFrom?.objectId, watchedGroupId);
      assert.equal(view.schedule?.active, false);
      assert.equal(view.dependency?.holding, true);
      assert.equal(view.pausedAt !== null, true, 'and its own manual pause is still there');
    });
  },
);

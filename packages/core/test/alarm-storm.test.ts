import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { PauseSweep } from '../src/objects/pause-sweep.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { straddleAPowerOfTen } from './support/ids.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();
const T0 = new Date('2026-08-25T12:00:00.000Z');

/** Eight devices behind one switch, five sensors each. `PLAN.md` says "not forty". */
const DEVICES = 8;
const SENSORS_PER_DEVICE = 5;
const DOWNSTREAM = DEVICES * SENSORS_PER_DEVICE;

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/**
 * `M-17`: the alarm storm, or the absence of one.
 *
 * `CLAUDE.md`'s first rule about alarm volume is *one outage, one alarm*, and `PLAN.md` states
 * the scenario exactly: unplugging a switch in front of forty sensors must produce one alarm,
 * not forty. This builds that topology, unplugs the switch, and counts.
 *
 * What is asserted here is what **dependencies** deliver — the states and the probe's
 * assignments. `N-15` is where the notification count is asserted, because notifications do not
 * exist yet; the measurement below is what tells that task what it is starting from.
 */
describe(
  'an alarm storm, and what suppresses it',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let probeId: number;
    let switchPingId: number;
    let downstreamIds: number[];

    before(async () => {
      scratch = await createScratchDatabase('alarmstorm');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      assert.ok(h.states !== undefined);
      assert.ok(h.dependencies !== undefined);
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
      const site = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'London',
      });

      // The switch, and the Ping sensor auto-discovery would make its master (D-04).
      const core = await h.service.create(testActor, {
        kind: 'device',
        parentId: site.id,
        name: 'core-switch',
        host: '192.0.2.1',
      });
      switchPingId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: core.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      await h.service.setDependency(testActor, switchPingId, 'device', undefined, undefined);

      // Everything behind it. The dependency goes on each *device*, so its sensors inherit —
      // one assignment per device rather than one per sensor is what an operator would do.
      downstreamIds = [];
      for (let device = 0; device < DEVICES; device += 1) {
        const host = await h.service.create(testActor, {
          kind: 'device',
          parentId: site.id,
          name: `app-${String(device).padStart(2, '0')}`,
          host: `192.0.2.${String(10 + device)}`,
        });
        await h.service.setDependency(testActor, host.id, 'object', switchPingId, undefined);
        for (let sensor = 0; sensor < SENSORS_PER_DEVICE; sensor += 1) {
          const created = await h.service.create(testActor, {
            kind: 'sensor',
            parentId: host.id,
            name: `check-${String(sensor)}`,
            sensorType: 'icmp.ping',
          });
          downstreamIds.push(created.id);
        }
      }
      assert.equal(downstreamIds.length, DOWNSTREAM);
      h.audit.recorded.length = 0;
      await db.query('DELETE FROM sensor_state');
    });

    /**
     * One scan of everything, written the way ingestion writes it.
     *
     * The order matters and is production's: decide the batch, write the history and the
     * runtimes, then react to the state changes — all inside one transaction (`M-11`).
     */
    async function scan(
      minute: number,
      ok: boolean,
      ids: readonly number[] = [switchPingId, ...downstreamIds],
    ): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = ids.map((sensorId) => ({
        sensorId,
        at: at(minute),
        outcome: ok ? 'ok' : 'error',
        message: ok ? 'reachable' : 'no ICMP reply from 192.0.2.1',
      }));

      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        // At the results' own instant, deliberately. Production passes the wall clock, which is
        // normally a little past the result and hides the hazard; driving them together is the
        // case where the pause would collide with the Down that caused it and be dropped by
        // `sensor_state`'s unique key. `reactionTime` is what keeps them apart.
        await h.dependencies?.react(q, decisions.transitions, at(minute));
      });
    }

    async function statesNow(
      ids: readonly number[] = [switchPingId, ...downstreamIds],
    ): Promise<Map<number, { state: SensorState; cause: SensorStateCause }>> {
      const rows = await db.query<{
        object_id: string;
        state: SensorState;
        cause: SensorStateCause;
      }>(
        `SELECT object_id::text AS object_id, state, cause FROM sensor_runtime
         WHERE object_id = ANY($1::bigint[])`,
        [ids],
      );
      return new Map(
        rows.map((row) => [Number(row.object_id), { state: row.state, cause: row.cause }]),
      );
    }

    // -------------------------------------------------------------------------------------
    // The scenario.
    // -------------------------------------------------------------------------------------

    it('leaves one sensor Down and forty Paused when the switch is unplugged', async () => {
      await scan(0, true);
      // Unplugged. Everything behind it stops answering, including the switch's own Ping —
      // which is what a probe on the far side actually observes.
      await scan(1, false);
      await scan(2, false);

      const current = await statesNow();
      const master = current.get(switchPingId);
      assert.ok(master !== undefined);
      assert.equal(master.state, 'down', 'the outage is attributed to the thing that failed');
      assert.equal(master.cause, 'scan');

      const downstream = downstreamIds.map((id) => current.get(id));
      assert.equal(
        downstream.filter((entry) => entry?.state === 'paused' && entry.cause === 'dependency')
          .length,
        DOWNSTREAM,
        'every sensor behind the switch is suppressed, and says why',
      );
      assert.equal(
        downstream.filter((entry) => entry?.state === 'down').length,
        0,
        'and none of them is left alarming',
      );
    });

    it('stops the probe scanning what it cannot reach, and keeps scanning the master', async () => {
      await scan(0, true);
      await scan(1, false);
      await scan(2, false);

      const config = new ProbeConfigService({ db, resolver: h.resolver });
      const scheduled = (await config.assignmentsFor(probeId)).sensors.map((s) => s.sensorId);
      assert.deepEqual(scheduled, [switchPingId], 'one check, on the only thing worth checking');
    });

    it('leaves exactly one alarm standing, and supersedes the rest within the transaction', async () => {
      await scan(0, true);
      await scan(1, false);
      await scan(2, false);

      // Every Down in the history, and how long it stood before something replaced it. A null
      // duration is a Down that is *still* the sensor's state — which is what an alarm is.
      const rows = await db.query<{ sensor_id: string; ms: string | null }>(
        `SELECT s.sensor_id::text AS sensor_id,
                (EXTRACT(EPOCH FROM (next.time - s.time)) * 1000)::bigint::text AS ms
         FROM sensor_state s
         LEFT JOIN LATERAL (
           SELECT n.time FROM sensor_state n
           WHERE n.sensor_id = s.sensor_id AND n.time > s.time
           ORDER BY n.time LIMIT 1
         ) next ON true
         WHERE s.state = 'down'
         ORDER BY s.sensor_id`,
      );

      const standing = rows.filter((row) => row.ms === null).map((row) => Number(row.sensor_id));
      assert.deepEqual(standing, [switchPingId], 'one outage, one alarm');

      // The dependents' own checks failed in the same batch that took the master Down, so each
      // recorded a Down before the dependency — decided from the same batch, later in the same
      // transaction — superseded it. That is truthful: the check did fail, and the system then
      // attributed the failure to the master. What matters is that none of them stands, and
      // that the window is far too short for `N-15`'s notification latency to fire in.
      const superseded = rows.filter((row) => row.ms !== null);
      assert.equal(superseded.length, DOWNSTREAM, 'forty transient Downs, forty supersessions');
      const longest = Math.max(...superseded.map((row) => Number(row.ms)));
      // One millisecond: `reactionTime` puts the pause immediately after the Down that caused
      // it, in the same transaction, so nothing outside the transaction ever saw the Down. The
      // number is here because `N-15` needs it — a notification latency of any usable length is
      // four orders of magnitude longer, which is why no message results.
      assert.ok(longest <= 1_000, `a superseded Down stood for ${String(longest)} ms`);
    });

    it('recovers to one story: the master comes back and the rest await their next scan', async () => {
      await scan(0, true);
      await scan(1, false);
      await scan(2, false);
      // Plugged back in. The master is the only thing still being scanned, so it is the only
      // thing that can report — which is exactly why a master must keep scanning.
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide([
        { sensorId: switchPingId, at: at(3), outcome: 'ok', message: 'reachable' },
      ]);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await h.dependencies?.react(q, decisions.transitions, at(3));
      });

      const current = await statesNow();
      assert.equal(current.get(switchPingId)?.state, 'up');
      const downstream = downstreamIds.map((id) => current.get(id));
      assert.equal(
        downstream.filter((entry) => entry?.state === 'unknown').length,
        DOWNSTREAM,
        '§3: a released sensor awaits its next scan rather than claiming a state nobody checked',
      );
    });

    it('raises no alarm from a maintenance window across a power of ten, swept a page at a time', async () => {
      // **The `P-385` review's case.** A bulk maintenance window writes one `starts_at` for
      // every object it covers, and the sweep that opens it pages by `(starts_at, object_id)`.
      // `startedIn` ordered its page by its `object_id::text` output column while the keyset
      // compared the bigint, so with ids either side of a power of ten the page ended at
      // `'1002'`, the next started past 1002, and 995..999 were never paused: they went on being
      // scanned through the window, and each one alarmed. Twelve sensors, five a page.
      const box = await h.service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'patched-box',
        host: '192.0.2.200',
      });
      const expected = await straddleAPowerOfTen(db, 'object', 12);
      const patched: number[] = [];
      for (const id of expected) {
        const created = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box.id,
          name: `service-${String(id)}`,
          sensorType: 'icmp.ping',
        });
        patched.push(created.id);
      }
      assert.deepEqual(patched, expected);
      await scan(0, true, patched);

      const from = new Date(Date.now() + 24 * 60 * 60_000);
      for (const id of patched) {
        await h.service.pause(
          testActor,
          id,
          { kind: 'window', from, until: new Date(from.getTime() + 2 * 60 * 60_000) },
          'quarterly patching',
        );
      }
      // Opened while the core was down, at one instant, as one bulk request writes it.
      await db.query(
        `UPDATE object_pause SET starts_at = date_trunc('second', now()) - interval '1 minute',
                                 paused_until = now() + interval '1 hour'
         WHERE object_id = ANY($1::bigint[])`,
        [patched],
      );
      const sweep = new PauseSweep({ service: h.service, logger: silent, batchSize: 5 });
      for (let pass = 0; pass < 10; pass += 1) await sweep.sweep();

      // The patching: every one of them stops answering. After the sweep, which paused them at
      // the wall clock, so these results are newer than that.
      const later = Math.ceil((Date.now() - T0.getTime()) / 60_000) + 1;
      await scan(later, false, patched);
      await scan(later + 1, false, patched);

      const current = await statesNow(patched);
      assert.deepEqual(
        patched.filter((id) => current.get(id)?.state !== 'paused'),
        [],
        'every sensor in the window is paused',
      );
      const downs = await db.query<{ sensor_id: string }>(
        `SELECT DISTINCT sensor_state.sensor_id::text AS sensor_id FROM sensor_state
         WHERE sensor_state.sensor_id = ANY($1::bigint[]) AND state = 'down'`,
        [patched],
      );
      assert.deepEqual(
        downs.map((row) => Number(row.sensor_id)),
        [],
        'and not one of them alarmed, even for a moment',
      );
    });

    it('suppresses nothing when the switch is fine and one server fails', async () => {
      // The other half of "one outage, one alarm": a dependency must not swallow an alarm that
      // is genuinely its own. Only the master going Down suppresses anything.
      await scan(0, true);
      const states = h.states;
      assert.ok(states !== undefined);
      const victim = downstreamIds[0];
      assert.ok(victim !== undefined);

      for (const minute of [1, 2]) {
        const decisions = await states.decide([
          { sensorId: victim, at: at(minute), outcome: 'error', message: 'connection refused' },
        ]);
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
          await h.dependencies?.react(q, decisions.transitions, at(minute));
        });
      }

      const current = await statesNow();
      assert.equal(current.get(victim)?.state, 'down', 'its own outage is its own alarm');
      assert.equal(current.get(switchPingId)?.state, 'up');
      assert.equal(
        downstreamIds.slice(1).filter((id) => current.get(id)?.state !== 'up').length,
        0,
        'and nothing else moved',
      );
    });
  },
);

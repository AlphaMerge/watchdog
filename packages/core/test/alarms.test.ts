import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { AlarmEngine, holdsFrom } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { AlarmService, type AlarmPage } from '../src/state/alarms.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { Reach, Visibility } from '../src/auth/access.js';

const available = await databaseAvailable();
const NOW = new Date('2026-08-25T12:00:00.000Z');
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

describe(
  'the alarms list',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let alarms: AlarmService;
    /**
     * The engine a held return needs (`M-18`), with the holds `main.ts` gives it. Nothing is
     * configured to notify anybody outside the tests that add a trigger, so everywhere else it
     * costs its one guard query.
     */
    let engine: AlarmEngine;
    let triggers: TriggerService;

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
      engine = new AlarmEngine({ logger: silent, recoveryHolds: holdsFrom(testCatalogue()) });
      h = await buildHarness(db, { states: true, alarms: engine });
      alarms = new AlarmService({ db, logger: silent });
      triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });

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
        // Where the state service reacts, in the same transaction (`M-18` needs it).
        await engine.react(
          q,
          results.map((result) => result.sensorId),
          results[0]?.at ?? NOW,
        );
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

    // The whole tree, spelled out: these are about what an alarm is, and `object-visibility`
    // is where what a reader may see of them is tested (`A-12`).
    async function list(
      query: Omit<Parameters<AlarmService['list']>[0], 'visibility'>,
    ): Promise<AlarmPage> {
      return alarms.list({ visibility: Visibility.EVERYTHING, ...query });
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
      await h.service.acknowledge(
        testActor,
        ping,
        { kind: 'indefinite' },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'engineer on site',
      );

      const page = await list({ limit: 100 });
      assert.equal(page.items.length, 1);
      const alarm = page.items[0];
      assert.ok(alarm);
      assert.equal(alarm.state, 'down_acknowledged');
      assert.equal(alarm.acknowledged, true);
      assert.equal(alarm.message, 'engineer on site');
    });

    it('keeps saying how long it has been wrong when somebody acknowledges it', async () => {
      // **`P-142`.** The duration column and the "what has been broken longest" sort read
      // `sensor_runtime.since` — when the sensor entered its *current state*. Acknowledging a
      // Down is a state change, so the moment an operator said "I am on it" the duration reset to
      // zero and the sensor dropped to the bottom of that sort; the acknowledgement lapsing reset
      // it again. `CLAUDE.md` already says where durations come from: uptime is computed from
      // state history, not from the runtime row.
      await knockDown(ping, NOW);
      const before = (await list({ limit: 100 })).items[0]?.since;
      assert.ok(before !== undefined);

      await h.service.acknowledge(
        testActor,
        ping,
        { kind: 'indefinite' },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'engineer on site',
      );

      const after = (await list({ limit: 100 })).items[0];
      assert.ok(after);
      assert.equal(after.state, 'down_acknowledged');
      assert.equal(
        after.since,
        before,
        'the outage started when it started, not when somebody noticed it',
      );
    });

    it('can hide the acknowledged ones, for the reader who wants what is unhandled', async () => {
      await knockDown(ping, NOW);
      await knockDown(http, NOW);
      await h.service.acknowledge(
        testActor,
        ping,
        { kind: 'indefinite' },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        'engineer on site',
      );

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
    // A return held before its alarm is over (`M-18`).
    // -----------------------------------------------------------------------------------------

    /** A Probe Health under the probe, outside both groups: the type that holds a return. */
    async function probeHealth(): Promise<number> {
      const box = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'probe-box',
          host: '192.0.2.30',
        })
      ).id;
      return (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          priority: 5,
        })
      ).id;
    }

    async function downTrigger(on: number, settings: Record<string, unknown> = {}): Promise<void> {
      // A template id nothing reads: a held alarm that is still pending is cancelled, not sent.
      await triggers.create(testActor, on, {
        kind: 'state',
        settings: { state: 'down', initialTemplateId: 101, ...settings },
      });
    }

    async function back(sensorId: number, when: Date): Promise<void> {
      await report([{ sensorId, at: when, outcome: 'ok', message: 'ok', channels: null }]);
    }

    it('lists a sensor that is back while its alarm waits out the hold, and when it is over (`M-18`)', async () => {
      const health = await probeHealth();
      await downTrigger(probeId);
      await knockDown(health, NOW);
      await back(health, at(120));

      const page = await list({ limit: 100 });
      assert.deepEqual(
        page.items.map((alarm) => alarm.sensorId),
        [health],
      );
      const row = page.items[0];
      assert.ok(row);
      assert.equal(row.state, 'up', 'the sensor is back, and says so');
      assert.equal(row.since, at(120).toISOString(), 'back since');
      assert.deepEqual(row.recovering, {
        since: at(120).toISOString(),
        // Probe Health's own five minutes: the trigger sets none.
        confirmsAt: at(420).toISOString(),
      });
      assert.deepEqual(page.counts, { recovering: 1 });

      // Once the hold has ended the alarm is over, and so is the row.
      await new AlarmScheduler({ db, engine, logger: silent }).sweep(at(421));
      const after = await list({ limit: 100 });
      assert.deepEqual(after.items, []);
      assert.deepEqual(after.counts, {});
    });

    it('lists a sensor back only as far as Warning as Warning, with the hold beside it, and a relapse as Down and not held (`M-18`)', async () => {
      const health = await probeHealth();
      await downTrigger(probeId);
      await knockDown(health, NOW);
      await back(health, at(120));
      await report([
        { sensorId: health, at: at(180), outcome: 'error', message: 'lost', channels: null },
      ]);

      const warned = await list({ limit: 100 });
      assert.equal(warned.items[0]?.state, 'warning');
      assert.deepEqual(warned.items[0].recovering, {
        since: at(120).toISOString(),
        confirmsAt: at(420).toISOString(),
      });
      assert.deepEqual(warned.counts, { warning: 1 }, 'counted once, by its state');

      // Down again inside the hold: the same alarm resumes, and nothing is held any more.
      await report([
        { sensorId: health, at: at(240), outcome: 'error', message: 'lost', channels: null },
      ]);
      const relapsed = await list({ limit: 100 });
      assert.equal(relapsed.items[0]?.state, 'down');
      assert.equal(relapsed.items[0].recovering, null);
      assert.deepEqual(relapsed.counts, { down: 1 });
    });

    it('puts a held return after every alarm still happening, whatever its priority (`M-18`)', async () => {
      // Probe Health is priority 5 and came back first; HTTP is priority 2 and broke later. By
      // priority, and by duration, the held return would lead; it follows instead.
      const health = await probeHealth();
      await downTrigger(probeId);
      await knockDown(health, NOW);
      await back(health, at(120));
      await knockDown(http, at(600));

      for (const sort of ['priority', 'duration'] as const) {
        const page = await list({ limit: 100, sort });
        assert.deepEqual(
          page.items.map((alarm) => alarm.sensorId),
          [http, health],
          sort,
        );
      }
    });

    it('filters to held returns, and counts them while they are filtered out (`M-18`)', async () => {
      const health = await probeHealth();
      await downTrigger(probeId);
      await knockDown(health, NOW);
      await back(health, at(120));
      await knockDown(http, at(600));

      const held = await list({ limit: 100, states: ['recovering'] });
      assert.deepEqual(
        held.items.map((alarm) => alarm.sensorId),
        [health],
      );
      assert.equal(held.total, 1);

      const down = await list({ limit: 100, states: ['down'] });
      assert.deepEqual(
        down.items.map((alarm) => alarm.sensorId),
        [http],
      );
      assert.deepEqual(down.counts, { down: 1, recovering: 1 });

      // And on the path that reads the chips on their own, when the filter empties the list.
      const none = await list({ limit: 100, states: ['warning'] });
      assert.deepEqual(none.items, []);
      assert.deepEqual(none.counts, { down: 1, recovering: 1 });
    });

    it('lists and counts a held return only for a reader who can see it (`A-12`, `M-18`)', async () => {
      // Probe Health sits under the probe, outside the branch this reader is granted. The
      // provider's own probe recovering is not a customer's alarm, and a chip saying so would
      // announce it.
      const health = await probeHealth();
      await downTrigger(probeId);
      await downTrigger(berlin, { recoveryHoldSeconds: 300 });
      await knockDown(health, NOW);
      await back(health, at(120));
      await knockDown(ping, NOW);
      await back(ping, at(120));

      const everything = await list({ limit: 100 });
      assert.deepEqual(everything.counts, { recovering: 2 }, 'both are held');

      const berliner = Visibility.of(new Map([[berlin, true]]), false, null);
      const seen = await alarms.list({ visibility: berliner, limit: 100 });
      assert.deepEqual(
        seen.items.map((alarm) => alarm.sensorId),
        [ping],
        'the visible held return is listed, so the other is absent for being hidden',
      );
      assert.equal(seen.total, 1);
      assert.deepEqual(seen.counts, { recovering: 1 });

      const emptied = await alarms.list({ visibility: berliner, limit: 100, states: ['down'] });
      assert.deepEqual(emptied.counts, { recovering: 1 });
    });

    it('says a sensor held by two triggers is over when the later of their holds ends (`M-18`)', async () => {
      // Each trigger holds its own alarm, and a trigger may set its own hold. The row goes when
      // the last of them is over, so that is the time it gives.
      await downTrigger(berlin, { recoveryHoldSeconds: 300 });
      await downTrigger(berlin, { recoveryHoldSeconds: 600 });
      await knockDown(ping, NOW);
      await back(ping, at(120));

      const page = await list({ limit: 100 });
      assert.deepEqual(page.items[0]?.recovering, {
        since: at(120).toISOString(),
        confirmsAt: at(720).toISOString(),
      });

      // The shorter hold ends, and the row stays until the longer one does.
      const sweep = new AlarmScheduler({ db, engine, logger: silent });
      await sweep.sweep(at(421));
      assert.equal(
        (await list({ limit: 100 })).items[0]?.recovering?.confirmsAt,
        at(720).toISOString(),
      );
      await sweep.sweep(at(721));
      assert.deepEqual((await list({ limit: 100 })).items, []);
    });

    it('stamps the page with the core’s clock, for a reader timing the end of a hold (`M-18`)', async () => {
      const before = Date.now();
      const page = await list({ limit: 100 });
      const stamped = Date.parse(page.now);
      assert.ok(stamped >= before && stamped <= Date.now(), page.now);
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

    it('serves a held return, filters to one, and says what time the core makes it (`M-18`)', async () => {
      const health = await probeHealth();
      await downTrigger(probeId);
      await knockDown(health, NOW);
      await back(health, at(120));

      const asked = Date.now();
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/alarms',
        query: { state: 'recovering' },
      });
      const answered = Date.now();
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<AlarmPage>();
      assert.deepEqual(body.items[0]?.recovering, {
        since: at(120).toISOString(),
        confirmsAt: at(420).toISOString(),
      });
      assert.deepEqual(body.counts, { recovering: 1 });
      const now = Date.parse(body.now);
      assert.ok(now >= asked && now <= answered, body.now);
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

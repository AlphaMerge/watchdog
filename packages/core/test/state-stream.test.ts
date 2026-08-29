import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { StateBroadcaster, type StateEvent } from '../src/state/stream.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** Collects what a subscriber was sent, and can be told to stop draining. */
function recorder() {
  const events: StateEvent[] = [];
  let overflowed = false;
  return {
    events,
    get overflowed() {
      return overflowed;
    },
    subscriber: {
      send: (event: StateEvent) => {
        events.push(event);
      },
      overflow: () => {
        overflowed = true;
      },
    },
  };
}

describe(
  'the live state stream',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let stream: StateBroadcaster;
    let probeId: number;
    let deviceId: number;
    let otherDeviceId: number;
    let sensorId: number;
    let otherSensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('statestream');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);
      stream = new StateBroadcaster({ logger: silent });

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'edge-router',
          host: '192.0.2.7',
        })
      ).id;
      otherDeviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'other',
          host: '192.0.2.8',
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
      otherSensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: otherDeviceId,
          name: 'HTTP',
          sensorType: 'icmp.ping',
        })
      ).id;
    });

    /**
     * The after-commit publish, made awaitable.
     *
     * Publishing is asynchronous relative to the commit — it reads the ancestry — so a test that
     * asserted straight after `tx` returned would be racing it. Production does not care: a
     * frame a few milliseconds behind the commit is still a frame nobody saw early.
     */
    const publishing: Promise<unknown>[] = [];
    function publishTo(broadcaster: StateBroadcaster) {
      return (committed: Parameters<Parameters<typeof writeStateHistory>[2] & object>[0]) => {
        publishing.push(broadcaster.publish(db, committed));
      };
    }
    async function settled(): Promise<void> {
      await Promise.all(publishing.splice(0));
    }

    /** One scan, written the way ingestion writes it, with the stream hooked to the commit. */
    async function scan(sensors: readonly number[], ok: boolean, when: Date): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = sensors.map((id) => ({
        sensorId: id,
        at: when,
        outcome: ok ? 'ok' : 'error',
        message: ok ? 'reachable' : 'no ICMP reply',
      }));
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions, publishTo(stream));
        await writeRuntimes(q, decisions.runtimes);
      });
      await settled();
    }

    // ---------------------------------------------------------------------------------------
    // After the commit, never inside it.
    // ---------------------------------------------------------------------------------------

    it('runs an after-commit hook after the transaction, not inside it', async () => {
      // The seam the whole stream rests on. A frame announcing a state change, sent from inside
      // the transaction that decided it, is an outage on an operator's screen that may never
      // have happened.
      const order: string[] = [];
      await db.tx(async (q) => {
        q.afterCommit?.(() => {
          order.push('after');
        });
        await q.query('SELECT 1');
        order.push('inside');
      });
      assert.deepEqual(order, ['inside', 'after']);
    });

    it('runs no after-commit hook when the transaction rolls back', async () => {
      const order: string[] = [];
      await assert.rejects(
        db.tx(async (q) => {
          q.afterCommit?.(() => {
            order.push('after');
          });
          await q.query('SELECT 1');
          throw new Error('rolled back');
        }),
      );
      assert.deepEqual(order, []);
    });

    it('says nothing at all when a transaction rolls back', async () => {
      const seen = recorder();
      stream.subscribe(seen.subscriber, null);

      await assert.rejects(
        db.tx(async (q) => {
          const states = h.states;
          assert.ok(states !== undefined);
          const decisions = await states.decide([
            { sensorId, at: new Date(), outcome: 'error', message: 'no ICMP reply' },
          ]);
          await writeStateHistory(q, decisions.transitions, publishTo(stream));
          throw new Error('rolled back');
        }),
      );
      await settled();
      assert.deepEqual(seen.events, [], 'nothing that was undone was announced');
    });

    it('announces only the rows that actually landed', async () => {
      // `ON CONFLICT (sensor_id, time) DO NOTHING` drops a repeat, and announcing the drop would
      // describe a history the table does not have.
      const seen = recorder();
      stream.subscribe(seen.subscriber, null);
      const at = new Date();
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide([
        { sensorId, at, outcome: 'error', message: 'no ICMP reply' },
      ]);

      for (let pass = 0; pass < 2; pass += 1) {
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions, publishTo(stream));
        });
        await settled();
      }
      assert.equal(seen.events.length, 1, 'the second write landed nothing, so it said nothing');
    });

    // ---------------------------------------------------------------------------------------
    // Scoping and the snapshot.
    // ---------------------------------------------------------------------------------------

    it('sends a subtree subscriber only what is beneath it', async () => {
      const branch = recorder();
      const everything = recorder();
      stream.subscribe(branch.subscriber, deviceId);
      stream.subscribe(everything.subscriber, null);

      await scan([sensorId, otherSensorId], false, new Date());

      assert.deepEqual(
        branch.events.map((event) => event.sensorId),
        [sensorId],
        'the other device is somebody else’s problem',
      );
      assert.equal(everything.events.length, 2);
    });

    it('carries the path, which is what a tree rolls a colour up', async () => {
      const seen = recorder();
      stream.subscribe(seen.subscriber, null);
      await scan([sensorId], false, new Date());
      const [event] = seen.events;
      assert.ok(event !== undefined);
      assert.deepEqual(event.path, [h.rootId, probeId, deviceId, sensorId]);
      assert.equal(event.sensorName, 'Ping');
    });

    it('numbers its events, so a gap is visible', async () => {
      const seen = recorder();
      stream.subscribe(seen.subscriber, null);
      await scan([sensorId, otherSensorId], false, new Date());
      assert.deepEqual(
        seen.events.map((event) => event.seq),
        [1, 2],
      );
    });

    it('hands a subscriber the state of its subtree, and says where it starts', async () => {
      await scan([sensorId, otherSensorId], false, new Date(Date.now() - 60_000));
      await scan([sensorId, otherSensorId], false, new Date());

      const snapshot = await stream.snapshot(db, deviceId);
      assert.equal(snapshot.objectId, deviceId);
      assert.equal(snapshot.truncated, false);
      assert.deepEqual(
        snapshot.entries.map((entry) => entry.sensorId),
        [sensorId],
      );
      const [entry] = snapshot.entries;
      assert.ok(entry !== undefined);
      assert.equal(entry.state, 'down');
      assert.deepEqual(entry.path, [h.rootId, probeId, deviceId, sensorId]);
    });

    it('loses nothing between attaching and taking the snapshot', async () => {
      // The ordering that makes resync work: attached first, so a change that lands while the
      // snapshot is being read is queued rather than falling into the gap. Applying it a second
      // time sets the state it already has.
      const seen = recorder();
      stream.subscribe(seen.subscriber, null);
      await scan([sensorId], false, new Date());

      const snapshot = await stream.snapshot(db, null);
      const [event] = seen.events;
      assert.ok(event !== undefined, 'the change arrived on the stream');
      assert.equal(seen.events.length, 1);
      assert.ok(snapshot.seq >= event.seq, 'and the snapshot already includes it');
    });

    it('says a subtree is bigger than one snapshot rather than truncating quietly', async () => {
      const small = new StateBroadcaster({ logger: silent, snapshotLimit: 1 });
      await scan([sensorId, otherSensorId], false, new Date());
      const snapshot = await small.snapshot(db, null);
      assert.equal(snapshot.entries.length, 1);
      assert.equal(snapshot.truncated, true);
    });

    // ---------------------------------------------------------------------------------------
    // Nobody listening, and somebody who cannot keep up.
    // ---------------------------------------------------------------------------------------

    it('costs nothing when nobody is watching', async () => {
      // The guard every sweep in this system has: an installation with no browser open must not
      // pay for the ancestry read that scopes an event to a subtree.
      await scan([sensorId, otherSensorId], false, new Date());
      assert.equal(stream.stats.published, 0);
      assert.equal(stream.stats.unwatched, 2, 'and it is counted rather than invisible');
    });

    it('cuts off a subscriber that cannot keep up, and counts it', async () => {
      // Never a silent trim: a client missing a change from the middle of the stream shows a
      // state the system has moved on from and has no way to tell.
      const stuck = new StateBroadcaster({ logger: silent, queueLimit: 0 });
      const seen = recorder();
      stuck.subscribe(seen.subscriber, null);

      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide([
        { sensorId, at: new Date(), outcome: 'error', message: 'no ICMP reply' },
      ]);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions, publishTo(stuck));
      });
      await settled();

      assert.equal(seen.overflowed, true, 'it was told to resubscribe');
      assert.deepEqual(seen.events, [], 'rather than being handed half a stream');
      assert.equal(stuck.stats.overflowed, 1);
      assert.equal(stuck.stats.subscribers, 0, 'and detached');
    });

    it('stops sending to a subscriber that has gone', async () => {
      const seen = recorder();
      const detach = stream.subscribe(seen.subscriber, null);
      detach();
      await scan([sensorId], false, new Date());
      assert.deepEqual(seen.events, []);
    });

    // ---------------------------------------------------------------------------------------
    // Over a real socket.
    // ---------------------------------------------------------------------------------------

    it('streams to a browser over a real WebSocket', async () => {
      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        stream,
      });
      await server.build('9.9.9', h.service);
      const address = await server.start();

      const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api/v1/stream`);
      const frames: Record<string, unknown>[] = [];
      const arrived = (
        type: string,
        matches: (frame: Record<string, unknown>) => boolean = () => true,
      ): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`no ${type} frame`));
          }, 10_000);
          const check = (): void => {
            const found = frames.find((frame) => frame['type'] === type && matches(frame));
            if (found === undefined) return;
            clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            resolve(found);
          };
          const onMessage = (): void => {
            check();
          };
          socket.addEventListener('message', onMessage);
          check();
        });

      socket.addEventListener('message', (message: Event) => {
        const data = (message as { data?: unknown }).data;
        frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      });

      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => {
            resolve();
          });
          socket.addEventListener('error', () => {
            reject(new Error('the socket would not open'));
          });
        });
        await arrived('hello');

        socket.send(JSON.stringify({ subscribe: { objectId: deviceId } }));
        const snapshot = await arrived('snapshot');
        assert.equal(snapshot['objectId'], deviceId);

        // Twice, because the two-step rule takes a sensor through Warning before it is Down —
        // so both frames go out, which is itself the thing a tree needs.
        await scan([sensorId], false, new Date(Date.now() - 60_000));
        const warning = await arrived('state');
        assert.equal(warning['state'], 'warning');

        await scan([sensorId], false, new Date());
        const event = await arrived('state', (frame) => frame['state'] === 'down');
        assert.equal(event['sensorId'], sensorId);
        assert.equal(event['sensorName'], 'Ping');
        assert.equal(event['previousState'], 'warning');
      } finally {
        socket.close();
        await server.stop();
      }
    });
  },
);

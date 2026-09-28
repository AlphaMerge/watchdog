import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ApiServer } from '../src/api/server.js';
import { contained, STREAM_MAX_PAYLOAD_BYTES } from '../src/api/routes/stream.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import {
  StateBroadcaster,
  type StateEvent,
  type StateSubscriber,
  type StreamSight,
} from '../src/state/stream.js';
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

describe('a socket handler that throws (P-217)', () => {
  it('hands the throw to its own handler rather than to the process', () => {
    const faults: unknown[] = [];
    const guarded = contained(
      (size: number) => {
        if (size > 1) throw new Error(`too big: ${String(size)}`);
      },
      (error) => faults.push(error),
    );
    guarded(1);
    guarded(2);
    assert.equal(faults.length, 1);
    assert.match(String(faults[0]), /too big: 2/);
  });
});

/** A subscriber that sees the whole tree, said out loud (`A-12`). */
const EVERYONE: StreamSight = {
  visibility: Visibility.EVERYTHING,
  key: 'everyone',
  resolve: () => Promise.resolve(Visibility.EVERYTHING),
};

/**
 * Collects what a subscriber was sent, and can be told how far behind it is.
 *
 * The backlog is a parameter because the broadcaster asks rather than infers (`P-60`): a real
 * subscriber sits on a socket that buffers, and only the socket knows. Left out, this one is a
 * subscriber that consumes as fast as it is given — which every recorder here was, silently, and
 * which is why a guard that could never fire never showed up as a failure.
 */
function recorder(backlog?: () => number) {
  const events: StateEvent[] = [];
  let overflowed = false;
  const subscriber: StateSubscriber = {
    send: (event: StateEvent) => {
      events.push(event);
    },
    overflow: () => {
      overflowed = true;
    },
    ...(backlog === undefined ? {} : { backlog }),
  };
  return {
    events,
    get overflowed() {
      return overflowed;
    },
    subscriber,
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
      stream.subscribe(seen.subscriber, null, EVERYONE);

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
      stream.subscribe(seen.subscriber, null, EVERYONE);
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
      stream.subscribe(branch.subscriber, deviceId, EVERYONE);
      stream.subscribe(everything.subscriber, null, EVERYONE);

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
      stream.subscribe(seen.subscriber, null, EVERYONE);
      await scan([sensorId], false, new Date());
      const [event] = seen.events;
      assert.ok(event !== undefined);
      assert.deepEqual(event.path, [h.rootId, probeId, deviceId, sensorId]);
      assert.equal(event.sensorName, 'Ping');
    });

    it('numbers nothing, because its only number would be the installation’s (A-21)', async () => {
      // A count kept here is one per change anywhere, and a subscriber that sees part of the tree
      // would read the rest in its gaps. The route numbers what each socket is sent.
      const seen = recorder();
      stream.subscribe(seen.subscriber, null, EVERYONE);
      await scan([sensorId, otherSensorId], false, new Date());
      assert.equal(seen.events.length, 2);
      for (const event of seen.events) assert.equal('seq' in event, false);
      const snapshot = await stream.snapshot(db, null, Visibility.EVERYTHING);
      assert.equal('seq' in snapshot, false);
    });

    it('hands a subscriber the state of its subtree, and says where it starts', async () => {
      await scan([sensorId, otherSensorId], false, new Date(Date.now() - 60_000));
      await scan([sensorId, otherSensorId], false, new Date());

      const snapshot = await stream.snapshot(db, deviceId, Visibility.EVERYTHING);
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
      stream.subscribe(seen.subscriber, null, EVERYONE);
      await scan([sensorId], false, new Date());

      const snapshot = await stream.snapshot(db, null, Visibility.EVERYTHING);
      const [event] = seen.events;
      assert.ok(event !== undefined, 'the change arrived on the stream');
      assert.equal(seen.events.length, 1);
      assert.ok(
        snapshot.entries.some(
          (entry) => entry.sensorId === sensorId && entry.state === event.state,
        ),
        'and the snapshot already includes it',
      );
    });

    it('says a subtree is bigger than one snapshot rather than truncating quietly', async () => {
      const small = new StateBroadcaster({ logger: silent, snapshotLimit: 1 });
      await scan([sensorId, otherSensorId], false, new Date());
      const snapshot = await small.snapshot(db, null, Visibility.EVERYTHING);
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
      const stuck = new StateBroadcaster({ logger: silent, backlogLimitBytes: 0 });
      const seen = recorder();
      stuck.subscribe(seen.subscriber, null, EVERYONE);

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

    it('cuts off a subscriber once its own backlog crosses the limit, and not before', async () => {
      // `P-60`. The guard used to read a counter the broadcaster raised and lowered around a
      // `send` that returns immediately — so it was zero at every check and this could never
      // fire, however far behind the client actually was. The number comes from the subscriber
      // now, because the transport that buffers is the only thing that can measure it.
      let backlog = 0;
      const seen = recorder(() => backlog);
      const slow = new StateBroadcaster({ logger: silent, backlogLimitBytes: 4_096 });
      slow.subscribe(seen.subscriber, null, EVERYONE);

      const change = {
        sensorId,
        state: 'down',
        previousState: 'up',
        cause: 'probe',
        message: 'no ICMP reply',
        at: new Date(),
      } as const;

      await slow.publish(db, [change]);
      assert.equal(seen.events.length, 1, 'keeping up, so nothing happens to it');
      assert.equal(slow.stats.overflowed, 0);

      backlog = 4_096;
      await slow.publish(db, [change]);
      assert.equal(seen.overflowed, true, 'over the limit, so it is told to resubscribe');
      assert.equal(seen.events.length, 1, 'and is not handed the event it could not take');
      assert.equal(slow.stats.overflowed, 1);
      assert.equal(slow.stats.subscribers, 0, 'and is detached');
    });

    it('never rejects, because a rejection here shuts the core down', async () => {
      // **`P-91`.** This runs as an `afterCommit` hook, and `Database.tx`'s hook loop
      // try/catches only the *synchronous* call — so a rejection from the ancestry query, which
      // runs on the pool outside any transaction, escaped to `unhandledRejection`, whose
      // lifecycle handler logs fatal and shuts ms-core down. A pool timeout under ingestion
      // load, or a Postgres failover, therefore stopped the monitoring at the moment the
      // database was unhealthy and monitoring mattered most — over a broadcast whose
      // transaction had already committed and whose failure costs a repaint, not a fact.
      const seen = recorder();
      const broken = new StateBroadcaster({ logger: silent });
      broken.subscribe(seen.subscriber, null, EVERYONE);

      const failing = {
        query: () => Promise.reject(new Error('connection terminated unexpectedly')),
      } as unknown as typeof db;

      const sent = await broken.publish(failing, [
        {
          sensorId,
          state: 'down',
          previousState: 'up',
          cause: 'probe',
          message: 'no ICMP reply',
          at: new Date(),
        },
      ]);
      assert.equal(sent, 0, 'nothing went out, and it says so rather than throwing');
      assert.equal(seen.events.length, 0);
    });

    it('leaves a subscriber that keeps up alone, whatever the volume', async () => {
      // The other half. A limit expressed as “bytes it has not delivered” must not fire on a
      // client that is delivering — the old shape counted events, and this is the reading of it
      // that would have been wrong.
      const seen = recorder(() => 0);
      const fast = new StateBroadcaster({ logger: silent, backlogLimitBytes: 64 });
      fast.subscribe(seen.subscriber, null, EVERYONE);

      const many = Array.from({ length: 200 }, () => ({
        sensorId,
        state: 'down' as const,
        previousState: 'up' as const,
        cause: 'probe' as const,
        message: 'no ICMP reply',
        at: new Date(),
      }));
      await fast.publish(db, many);

      assert.equal(seen.events.length, 200);
      assert.equal(seen.overflowed, false);
      assert.equal(fast.stats.overflowed, 0);
    });

    it('stops sending to a subscriber that has gone', async () => {
      const seen = recorder();
      const detach = stream.subscribe(seen.subscriber, null, EVERYONE);
      detach();
      await scan([sensorId], false, new Date());
      assert.deepEqual(seen.events, []);
    });

    // ---------------------------------------------------------------------------------------
    // Over a real socket.
    // ---------------------------------------------------------------------------------------

    it('streams to a browser over a real WebSocket', async () => {
      // Every subscriber the route attaches, so the backlog wiring below can be checked on the
      // real one rather than on a stand-in. `stream` is rebuilt per test, so this is local.
      const registered: StateSubscriber[] = [];
      const attach = stream.subscribe.bind(stream);
      stream.subscribe = (subscriber, objectId, sight): (() => void) => {
        registered.push(subscriber);
        return attach(subscriber, objectId, sight);
      };

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

        // **What this pins, and what it does not.** It pins that the route gives its subscriber
        // a `backlog` at all: absent, the call below is `undefined`, the comparison fails, and a
        // route added later without one would be uncuttable and silent about it — which is how
        // the counter it replaced went unnoticed. It does *not* pin that the number comes from
        // the server's socket. `socket` here is the client end, both ends read 0 on an idle
        // connection, and an implementation returning a constant 0 would pass just as well; the
        // first version of this test claimed otherwise and was wrong. What covers the arithmetic
        // is `stream-backlog.test.ts`, against a socket a test can move by hand.
        assert.equal(
          registered[0]?.backlog?.(),
          0,
          'the stream route must report a backlog, or it can never be cut off',
        );

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

    /** A server with the stream on it, and what a socket connects to (`P-217`). */
    async function streaming(): Promise<{ server: ApiServer; url: string }> {
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
        stream,
      });
      await server.build('9.9.9', h.service);
      const address = await server.start();
      return { server, url: `ws://127.0.0.1:${String(address.port)}/api/v1/stream` };
    }

    /** A socket, everything it was sent, how it closed, and a way to wait for enough of it. */
    async function connected(url: string) {
      const socket = new WebSocket(url);
      const frames: Record<string, unknown>[] = [];
      socket.addEventListener('message', (message: Event) => {
        const data = (message as { data?: unknown }).data;
        frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      });
      const code = new Promise<number>((resolve) => {
        socket.addEventListener('close', (event: Event) => {
          resolve((event as unknown as { code: number }).code);
        });
      });
      /** How the server closed it — or a failure, not a hang, when it never does. */
      const closed = async (): Promise<number> => {
        let timer: NodeJS.Timeout | undefined;
        const never = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('the server never closed the socket'));
          }, 10_000);
        });
        try {
          return await Promise.race([code, never]);
        } finally {
          clearTimeout(timer);
        }
      };
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve();
        });
        socket.addEventListener('error', () => {
          reject(new Error('the socket would not open'));
        });
      });
      const count = async (type: string, n: number): Promise<Record<string, unknown>[]> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const found = frames.filter((frame) => frame['type'] === type);
          if (found.length >= n) return found;
          if (Date.now() > deadline) {
            throw new Error(`${String(found.length)} ${type} frames of ${String(n)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      await count('hello', 1);
      return { socket, frames, count, closed };
    }

    /** Whatever reaches the process's last-resort handler while `body` runs. */
    async function uncaughtDuring(body: () => Promise<void>): Promise<unknown[]> {
      const uncaught: unknown[] = [];
      const record = (error: unknown): void => {
        uncaught.push(error);
      };
      process.on('uncaughtException', record);
      try {
        await body();
      } finally {
        process.off('uncaughtException', record);
      }
      return uncaught;
    }

    it(
      'answers any frame a client can send, and the core stays up (P-217)',
      { timeout: 60_000 },
      async () => {
        // `null` and `{"subscribe":null}` are JSON, and the handler read them straight off a cast.
        // `ws` emits `message` synchronously, so each was an `uncaughtException` and the core shut
        // down — one frame, from any account that may read. Every frame below has to come back as a
        // `problem` on a socket that still subscribes afterwards.
        const { server, url } = await streaming();
        const open = () => connected(url);

        const junk: (string | Uint8Array)[] = [
          'null',
          '{"subscribe":null}',
          '[]',
          '[{"subscribe":{}}]',
          '5',
          '"subscribe"',
          'true',
          '{}',
          '{"subscribe":5}',
          '{"subscribe":[]}',
          '{"subscribe":"everything"}',
          '{"subscribe":{"objectId":null}}',
          '{"subscribe":{"objectId":0}}',
          '{"subscribe":{"objectId":-3}}',
          '{"subscribe":{"objectId":1.5}}',
          '{"subscribe":{"objectId":"7"}}',
          '{"subscribe":{"objectId":1e300}}',
          '{"subscribe":{},"also":1}',
          '{"subscribe":{"objectId":1,"depth":2}}',
          // Deeply nested, and still under the size the handler reads.
          `{"subscribe":{"objectId":${'['.repeat(400)}${']'.repeat(400)}}}`,
          `{"subscribe":{"deep":${'{"a":'.repeat(150)}1${'}'.repeat(150)}}}`,
          'not JSON at all',
          new Uint8Array([0xff, 0x00, 0xfe]),
          // Over what the handler reads, under what `ws` will buffer: told, not dropped.
          JSON.stringify({ subscribe: {}, padding: 'x'.repeat(4_000) }),
        ];

        const first = await open();
        const huge = await open();
        const after = await open();
        const uncaught = await uncaughtDuring(async () => {
          for (const frame of junk) first.socket.send(frame);
          const problems = await first.count('problem', junk.length);
          assert.equal(problems.length, junk.length, 'one problem frame per frame of junk');
          assert.equal(
            first.frames.some((frame) => frame['type'] === 'snapshot'),
            false,
            'no junk frame may subscribe',
          );

          // The same socket still subscribes, scoped and unscoped.
          first.socket.send(JSON.stringify({ subscribe: { objectId: deviceId } }));
          const [scoped] = await first.count('snapshot', 1);
          assert.equal(scoped?.['objectId'], deviceId);
          first.socket.send(JSON.stringify({ subscribe: {} }));
          await first.count('snapshot', 2);

          // Past what `ws` will buffer at all: the library closes that socket with 1009 before the
          // handler sees a byte, and nothing else notices.
          huge.socket.send('['.repeat(STREAM_MAX_PAYLOAD_BYTES + 1));
          assert.equal(await huge.closed(), 1009);

          after.socket.send(JSON.stringify({ subscribe: {} }));
          await after.count('snapshot', 1);
        }).finally(async () => {
          first.socket.close();
          after.socket.close();
          await server.stop();
        });
        assert.deepEqual(uncaught, [], 'a frame reached the process');
      },
    );

    it('closes only the socket whose handler threw (P-217)', { timeout: 60_000 }, async () => {
      // Validation closes the hole that was found; this is for the next one. A throw inside the
      // route's `message` handler is forced by making the server's own `JSON.stringify` of one
      // particular reply fail — the test and the server share a process, and nothing in the frame
      // the client sends can reach a throw any more. That socket goes, with 1011; the process and
      // every other socket stay.
      const { server, url } = await streaming();
      const faulty = await connected(url);
      const bystander = await connected(url);
      const stringify = JSON.stringify;
      const failing = (value: unknown, ...rest: unknown[]): string => {
        if ((value as { reason?: unknown } | null)?.reason === 'that was not JSON') {
          throw new Error('a defect in the handler');
        }
        return (stringify as (...args: unknown[]) => string)(value, ...rest);
      };

      const uncaught = await uncaughtDuring(async () => {
        JSON.stringify = failing as typeof JSON.stringify;
        try {
          faulty.socket.send('not JSON at all');
          assert.equal(await faulty.closed(), 1011);
        } finally {
          JSON.stringify = stringify;
        }
        bystander.socket.send('{"subscribe":{}}');
        await bystander.count('snapshot', 1);
      }).finally(async () => {
        bystander.socket.close();
        await server.stop();
      });
      assert.deepEqual(uncaught, [], 'the throw reached the process');
    });
  },
);

import { strict as assert } from 'node:assert';
import { connect } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { QueryResultRow } from 'pg';
import { ApiServer } from '../src/api/server.js';
import {
  contained,
  STREAM_LIMITS,
  STREAM_MAX_PAYLOAD_BYTES,
  type StreamLimits,
} from '../src/api/routes/stream.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import {
  StateBroadcaster,
  type ProbeWatcher,
  type StateEvent,
  type StateSubscriber,
  type StreamSight,
  type StreamSocket,
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
import { credentialKey, type CredentialCheck, type Lapse } from '../src/auth/credentials.js';

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
      // The sweep's timer an hour away, so the only sweeps are the ones a test runs by hand.
      stream = new StateBroadcaster({
        logger: silent,
        accessEpoch: epochNow,
        credentialSweepMs: 3_600_000,
      });

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
      const { snapshot } = await stream.snapshot(db, null, Visibility.EVERYTHING);
      assert.equal('seq' in snapshot, false);
    });

    it('hands a subscriber the state of its subtree, and says where it starts', async () => {
      await scan([sensorId, otherSensorId], false, new Date(Date.now() - 60_000));
      await scan([sensorId, otherSensorId], false, new Date());

      const { snapshot } = await stream.snapshot(db, deviceId, Visibility.EVERYTHING);
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

      const { snapshot } = await stream.snapshot(db, null, Visibility.EVERYTHING);
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
      const { snapshot } = await small.snapshot(db, null, Visibility.EVERYTHING);
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
    // Grants that move while it works (`A-30`).
    // ---------------------------------------------------------------------------------------

    async function epochNow(): Promise<number> {
      const rows = await db.query<{ value: string }>(
        'SELECT value::text AS value FROM access_epoch',
      );
      return Number(rows[0]?.value);
    }

    /** What a grant change does to the counter, without a grant to undo afterwards. */
    async function grantsMoved(): Promise<number> {
      await db.query('UPDATE access_epoch SET value = value + 1');
      return epochNow();
    }

    it('says which epoch a snapshot was read at, even an empty one', async () => {
      const epoch = await epochNow();
      assert.equal((await stream.snapshot(db, null, Visibility.EVERYTHING)).epoch, epoch);
      const empty = await stream.snapshot(db, null, Visibility.nothing(epoch));
      assert.deepEqual(empty.snapshot.entries, []);
      assert.equal(empty.epoch, epoch, 'an empty snapshot still says when it was read');
    });

    it('confirms a snapshot only through a view that is still the account’s', async () => {
      const at = 7;
      let asked = 0;
      const sight = (answer: Visibility): StreamSight => ({
        visibility: Visibility.everything(at),
        key: 'confirming',
        resolve: () => {
          asked += 1;
          return Promise.resolve(answer);
        },
      });

      assert.equal(await stream.confirm(sight(Visibility.nothing(at)), at), true);
      assert.equal(asked, 0, 'nothing moved, so nothing is asked');

      const same = sight(Visibility.everything(at + 1));
      assert.equal(await stream.confirm(same, at + 1), true);
      assert.equal(same.visibility.epoch, at + 1, 'and the sight is brought up to date');

      assert.equal(await stream.confirm(sight(Visibility.nothing(at + 1)), at + 1), false);
      assert.equal(stream.stats.resynced, 1, 'a changed view is a resync, and counted');
    });

    it('sends a batch to nobody who attached while it was checking for moved grants', async () => {
      // A view resolved before a grant change, attaching while a batch published after it is still
      // asking the others again. The check has already chosen whom to ask, so without a horizon
      // this one is sent the batch through the view the change took away.
      const stale = await epochNow();
      const moved = await grantsMoved();
      const checked = recorder();
      const late = recorder();
      stream.subscribe(checked.subscriber, null, {
        visibility: Visibility.everything(stale),
        key: 'checked',
        resolve: () => {
          stream.subscribe(late.subscriber, null, {
            visibility: Visibility.everything(stale),
            key: 'late',
            resolve: () => Promise.resolve(Visibility.nothing(moved)),
          });
          return Promise.resolve(Visibility.everything(moved));
        },
      });

      await scan([sensorId], false, new Date());
      assert.equal(checked.events.length, 1, 'the one it checked is sent the change');
      assert.deepEqual(late.events, [], 'the one it never checked was sent it anyway');

      // The next batch checks it, finds its view gone, and sends it back to the start.
      await scan([otherSensorId], false, new Date());
      assert.deepEqual(late.events, []);
      assert.equal(late.overflowed, true);
    });

    it('asks once per account however many batches noticed the same move', async () => {
      const stale = await epochNow();
      const moved = await grantsMoved();
      let asked = 0;
      // Three tabs of one account.
      const tabs = [recorder(), recorder(), recorder()];
      for (const tab of tabs) {
        stream.subscribe(tab.subscriber, null, {
          visibility: Visibility.everything(stale),
          key: 'one-account',
          resolve: () => {
            asked += 1;
            return Promise.resolve(Visibility.everything(moved));
          },
        });
      }

      // Two batches in flight at once, as ingestion commits them: both have read their ancestry
      // before either looks at a subscriber.
      let arrived = 0;
      let bothRead = (): void => undefined;
      const together = new Promise<void>((resolve) => {
        bothRead = resolve;
      });
      const inStep: Queryable = {
        async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
          const rows = await db.query<T>(text, values);
          arrived += 1;
          if (arrived === 2) bothRead();
          await together;
          return rows;
        },
      };
      const change = (id: number) => ({
        sensorId: id,
        state: 'down' as const,
        previousState: 'up' as const,
        cause: 'scan' as const,
        message: 'no ICMP reply',
        at: new Date(),
      });
      await Promise.all([
        stream.publish(inStep, [change(sensorId)]),
        stream.publish(inStep, [change(otherSensorId)]),
      ]);

      assert.equal(asked, 1, 'one account and one move, asked once per batch in flight');
      for (const tab of tabs) assert.equal(tab.events.length, 2);
    });

    // ---------------------------------------------------------------------------------------
    // A probe's own link and report (`U-24`).
    // ---------------------------------------------------------------------------------------

    /** What a watcher of one probe was told, and how often. */
    function probeRecorder() {
      let changes = 0;
      const overflows: (string | undefined)[] = [];
      const watcher: ProbeWatcher = {
        changed: () => {
          changes += 1;
        },
        overflow: (reason) => {
          overflows.push(reason);
        },
      };
      return {
        watcher,
        overflows,
        get changes() {
          return changes;
        },
      };
    }

    /** `db`, counting what is asked of it and holding each answer until `release` is called. */
    function gated(): { q: Queryable; asked: () => number; release: () => void } {
      let asked = 0;
      let release = (): void => undefined;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        asked: () => asked,
        release: () => {
          release();
        },
        q: {
          async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
            asked += 1;
            const rows = await db.query<T>(text, values);
            await open;
            return rows;
          },
        },
      };
    }

    it('tells whoever watches a probe that it changed, and nobody watching another', async () => {
      const other = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'the other probe',
      });
      const mine = probeRecorder();
      const theirs = probeRecorder();
      const tree = recorder();
      stream.watchProbe(mine.watcher, probeId, EVERYONE);
      stream.watchProbe(theirs.watcher, other.id, EVERYONE);
      // A subscription to the whole tree is not a watch: it asked for sensors' states.
      stream.subscribe(tree.subscriber, null, EVERYONE);

      assert.equal(await stream.publishProbe(db, probeId), 1);
      assert.equal(mine.changes, 1);
      assert.equal(theirs.changes, 0);
      assert.deepEqual(tree.events, [], 'a tree was sent a frame it never asked for');
      assert.equal(stream.stats.subscribers, 3);

      // And a watcher is sent no sensor's state, however much changes under its probe.
      await scan([sensorId], false, new Date());
      assert.equal(tree.events.length, 1);
      assert.equal(mine.changes, 1);
    });

    it('stops telling a watcher that has gone', async () => {
      const seen = probeRecorder();
      const detach = stream.watchProbe(seen.watcher, probeId, EVERYONE);
      await stream.publishProbe(db, probeId);
      detach();
      await stream.publishProbe(db, probeId);
      assert.equal(seen.changes, 1);
      assert.equal(stream.stats.subscribers, 0);
    });

    it('reads nothing for a probe nobody watches, and holds no state publish open', async () => {
      const elsewhere = probeRecorder();
      stream.watchProbe(elsewhere.watcher, probeId + 1_000_000, EVERYONE);
      const never = gated();
      assert.equal(await stream.publishProbe(never.q, probeId), 0);
      assert.equal(never.asked(), 0, 'a probe nobody watches cost a query');

      // The guard in front of every ancestry read: a form watching one probe is not a tree.
      assert.equal(stream.watching, false);
      await scan([sensorId], false, new Date());
      assert.equal(stream.stats.unwatched, 1);
    });

    it('sends the frame through the view a sensor’s frame is sent through', async () => {
      const epoch = await epochNow();
      const other = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'beside it',
      });
      const of = (labels: [number, boolean][], rootSees: boolean): Visibility =>
        Visibility.of(new Map(labels), rootSees, epoch);
      const cases: readonly { name: string; visibility: Visibility; told: boolean }[] = [
        { name: 'everything', visibility: Visibility.everything(epoch), told: true },
        { name: 'nothing', visibility: Visibility.nothing(epoch), told: false },
        { name: 'the root', visibility: of([[h.rootId, true]], true), told: true },
        { name: 'the probe alone', visibility: of([[probeId, true]], false), told: true },
        {
          name: 'the root, with the probe carved out',
          visibility: of(
            [
              [h.rootId, true],
              [probeId, false],
            ],
            true,
          ),
          told: false,
        },
        {
          name: 'the root refused and the probe granted',
          visibility: of(
            [
              [h.rootId, false],
              [probeId, true],
            ],
            false,
          ),
          told: true,
        },
        // Exactly the reader `B-08` tells nothing: sensors of its own under a probe it cannot see.
        {
          name: 'a device under the probe',
          visibility: of([[deviceId, true]], false),
          told: false,
        },
        {
          name: 'a sensor under the probe',
          visibility: of([[sensorId, true]], false),
          told: false,
        },
        { name: 'another probe', visibility: of([[other.id, true]], false), told: false },
      ];

      const watchers = cases.map(({ name, visibility }) => {
        const seen = probeRecorder();
        stream.watchProbe(seen.watcher, probeId, {
          visibility,
          key: name,
          resolve: () => Promise.reject(new Error(`${name}: nothing moved, so nothing is asked`)),
        });
        return seen;
      });
      const sent = await stream.publishProbe(db, probeId);

      for (const [index, { name, told }] of cases.entries()) {
        const watcher = watchers[index];
        assert.ok(watcher !== undefined, name);
        assert.equal(watcher.changes, told ? 1 : 0, name);
        assert.deepEqual(watcher.overflows, [], name);
      }
      assert.equal(sent, cases.filter(({ told }) => told).length);
    });

    it('tells a watcher that lost its probe nothing when the probe changes, and sends it back on the sweep', async () => {
      // The finding this replaces a pinned case for: a watcher examined when its probe changed
      // was sent `overflow` at that instant — the time of a link edge on a probe it may no longer
      // see. Nothing but watches here: no tree subscriber, so no state batch examines anybody.
      const stale = await epochNow();
      let now: number = stale;
      let asked = 0;
      const revoked = probeRecorder();
      const allowed = probeRecorder();
      stream.watchProbe(revoked.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'revoked',
        resolve: () => Promise.resolve(Visibility.nothing(now)),
      });
      stream.watchProbe(allowed.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'allowed',
        resolve: () => {
          asked += 1;
          return Promise.resolve(Visibility.everything(now));
        },
      });
      assert.equal(await stream.publishProbe(db, probeId), 2);
      assert.equal(revoked.changes, 1);

      // Access is taken away, and then the probe's link moves three times.
      now = await grantsMoved();
      assert.equal(stream.watching, false);
      for (let edge = 0; edge < 3; edge += 1) await stream.publishProbe(db, probeId);
      assert.equal(allowed.changes, 4, 'the edges happened: a reader of the probe heard each');
      assert.equal(revoked.changes, 1, 'a frame went to a reader whose access was taken away');
      assert.deepEqual(revoked.overflows, [], 'it was told something at the probe’s own edge');
      assert.equal(stream.stats.resynced, 0);

      // The sweep's tick, and only that, sends it back to the start.
      await stream.sweep();
      assert.equal(revoked.overflows.length, 1);
      assert.match(String(revoked.overflows[0]), /may see has changed/);
      assert.equal(stream.stats.resynced, 1);
      assert.equal(stream.stats.subscribers, 1, 'and it is detached');
      await stream.publishProbe(db, probeId);
      await stream.sweep();
      assert.equal(revoked.changes, 1);
      assert.equal(revoked.overflows.length, 1);

      // The reader whose access did not move was asked once, heard every edge, and was never
      // disturbed — by the other account's revocation or by the sweeps.
      assert.equal(allowed.changes, 5);
      assert.deepEqual(allowed.overflows, []);
      assert.equal(asked, 1, 'one grant change, asked about once');
    });

    it('tells a watcher that lost its probe nothing when another probe changes', async () => {
      const other = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'the one that flaps',
      });
      const stale = await epochNow();
      const moved = await grantsMoved();
      const revoked = probeRecorder();
      const elsewhere = probeRecorder();
      stream.watchProbe(revoked.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'revoked',
        resolve: () => Promise.resolve(Visibility.nothing(moved)),
      });
      stream.watchProbe(elsewhere.watcher, other.id, EVERYONE);

      for (let edge = 0; edge < 3; edge += 1) await stream.publishProbe(db, other.id);
      assert.equal(elsewhere.changes, 3);
      assert.equal(revoked.changes, 0);
      assert.deepEqual(revoked.overflows, [], 'told at the instant a probe it cannot see changed');

      await stream.sweep();
      assert.equal(revoked.overflows.length, 1);
      assert.deepEqual(elsewhere.overflows, []);
    });

    it('tells a watcher nothing when a sensor changes state, whatever happened to its grants', async () => {
      const stale = await epochNow();
      const moved = await grantsMoved();
      const seen = probeRecorder();
      const tree = recorder();
      stream.subscribe(tree.subscriber, null, EVERYONE);
      stream.watchProbe(seen.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'revoked',
        resolve: () => Promise.resolve(Visibility.nothing(moved)),
      });
      await scan([sensorId], false, new Date());
      assert.equal(tree.events.length, 1);
      assert.deepEqual(seen.overflows, [], 'a watcher was told at the instant a sensor changed');
      await stream.sweep();
      assert.equal(seen.overflows.length, 1);
    });

    it('sends the frame through the view the account has now, and leaves a changed view to the sweep', async () => {
      // Attached without the probe in view — the route refuses that subscription, and the
      // broadcaster must not depend on it having done so.
      const stale = await epochNow();
      const hidden = probeRecorder();
      let granted: number | null = null;
      stream.watchProbe(hidden.watcher, probeId, {
        visibility: Visibility.nothing(stale),
        key: 'reader',
        resolve: () => Promise.resolve(Visibility.everything(granted)),
      });
      await stream.publishProbe(db, probeId);
      await stream.sweep();
      assert.equal(hidden.changes, 0, 'a reader who cannot see the probe was told it changed');
      assert.deepEqual(hidden.overflows, [], 'nothing moved, so the sweep asks nothing');

      // Access is granted. The next change goes through the view the account has now, and one
      // sweep sends the socket back to take up that view for good.
      granted = await grantsMoved();
      assert.equal(await stream.publishProbe(db, probeId), 1);
      assert.equal(hidden.changes, 1);
      assert.deepEqual(hidden.overflows, []);
      await stream.sweep();
      assert.equal(hidden.overflows.length, 1);
      assert.match(String(hidden.overflows[0]), /may see has changed/);
    });

    it('sends back a watcher whose view could not be asked for, on the sweep and not at the edge', async () => {
      const stale = await epochNow();
      await grantsMoved();
      const seen = probeRecorder();
      stream.watchProbe(seen.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'unanswered',
        resolve: () => Promise.reject(new Error('connection terminated unexpectedly')),
      });
      assert.equal(await stream.publishProbe(db, probeId), 0);
      assert.equal(seen.changes, 0, 'a frame went through a view nobody could confirm');
      assert.deepEqual(seen.overflows, []);
      await stream.sweep();
      assert.equal(seen.overflows.length, 1);
      assert.match(String(seen.overflows[0]), /could not confirm/);
    });

    it('never rejects from a sweep that cannot read the epoch, and tells nobody', async () => {
      const blind = new StateBroadcaster({
        logger: silent,
        credentialSweepMs: 3_600_000,
        accessEpoch: () => Promise.reject(new Error('connection terminated unexpectedly')),
      });
      const seen = probeRecorder();
      const detach = blind.watchProbe(seen.watcher, probeId, {
        visibility: Visibility.everything(1),
        key: 'unread',
        resolve: () => Promise.reject(new Error('never asked')),
      });
      await blind.sweep();
      assert.deepEqual(seen.overflows, []);
      assert.equal(blind.stats.subscribers, 1);
      detach();
    });

    // What this cannot show is that the timer is *gone* once nobody watches: a leaked interval
    // runs a sweep that returns before it reads anything, and `reads` stays where it was. That
    // claim is 'holds one timer while there is a socket or a watcher', which watches the timer.
    it('reviews watchers on the sweep’s own timer, and reads nothing for nobody', async (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const stale = await epochNow();
      let reads = 0;
      const timed = new StateBroadcaster({
        logger: silent,
        credentialSweepMs: 5_000,
        accessEpoch: () => {
          reads += 1;
          return epochNow();
        },
      });
      /** Lets a sweep the mocked timer started run to its end: its awaits are real queries. */
      const swept = async (expected: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (reads < expected) {
          if (Date.now() > deadline) assert.fail('the timer started no sweep');
          await new Promise((resolve) => setImmediate(resolve));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      };

      t.mock.timers.tick(5_000);
      assert.equal(reads, 0, 'a sweep ran with nobody watching');

      const moved = await grantsMoved();
      const seen = probeRecorder();
      const detach = timed.watchProbe(seen.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'revoked',
        resolve: () => Promise.resolve(Visibility.nothing(moved)),
      });
      // Edges, and time short of a tick: nothing.
      await timed.publishProbe(db, probeId);
      t.mock.timers.tick(4_999);
      await timed.publishProbe(db, probeId);
      assert.equal(reads, 0);
      assert.deepEqual(seen.overflows, []);

      // The tick.
      t.mock.timers.tick(1);
      await swept(1);
      assert.equal(seen.overflows.length, 1);
      assert.equal(seen.changes, 0);

      // It was dropped, so nobody watches and the timer is gone: no more reads.
      t.mock.timers.tick(20_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(reads, 1, 'the sweep went on reading the epoch for nobody');

      // And a watcher that detaches by itself stops it too.
      const again = timed.watchProbe(probeRecorder().watcher, probeId, EVERYONE);
      t.mock.timers.tick(5_000);
      await swept(2);
      again();
      t.mock.timers.tick(20_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(reads, 2);
      detach();
    });

    it('tells nobody who started watching while it was asking for the views of those who were', async () => {
      const stale = await epochNow();
      const moved = await grantsMoved();
      const checked = probeRecorder();
      const late = probeRecorder();
      stream.watchProbe(checked.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'checked',
        resolve: () => {
          stream.watchProbe(late.watcher, probeId, {
            visibility: Visibility.everything(stale),
            key: 'late',
            resolve: () => Promise.resolve(Visibility.nothing(moved)),
          });
          return Promise.resolve(Visibility.everything(moved));
        },
      });

      await stream.publishProbe(db, probeId);
      assert.equal(checked.changes, 1);
      assert.equal(late.changes, 0, 'the one it never examined was told anyway');

      // The next change asks for its view, finds the probe gone from it, and sends nothing.
      await stream.publishProbe(db, probeId);
      assert.equal(checked.changes, 2);
      assert.equal(late.changes, 0);
      assert.deepEqual(late.overflows, []);
    });

    it('does not tell a watcher that detached while the views were being asked for', async () => {
      const stale = await epochNow();
      const moved = await grantsMoved();
      const seen = probeRecorder();
      const holder: { detach: () => void } = { detach: () => undefined };
      holder.detach = stream.watchProbe(seen.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'leaving',
        resolve: () => {
          holder.detach();
          return Promise.resolve(Visibility.everything(moved));
        },
      });
      assert.equal(await stream.publishProbe(db, probeId), 0);
      assert.equal(seen.changes, 0);
    });

    it('folds a flapping link into the frame already being read for, and counts it', async () => {
      const seen = probeRecorder();
      stream.watchProbe(seen.watcher, probeId, EVERYONE);
      const held = gated();

      // Six edges before the first one's read comes back.
      const edges = Array.from({ length: 6 }, () => stream.publishProbe(held.q, probeId));
      assert.equal(held.asked(), 1, 'each edge of a flapping link held a query of its own');
      assert.equal(stream.stats.probeCoalesced, 5);
      held.release();
      const sent = await Promise.all(edges);
      assert.deepEqual(sent, [1, 0, 0, 0, 0, 0]);
      assert.equal(seen.changes, 1);

      // Not swallowed for ever: once that frame has gone, the next change is a frame.
      assert.equal(await stream.publishProbe(db, probeId), 1);
      assert.equal(seen.changes, 2);
      assert.equal(stream.stats.probeCoalesced, 5);

      // And one probe flapping holds back nothing about another.
      const other = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'steady',
      });
      const steady = probeRecorder();
      stream.watchProbe(steady.watcher, other.id, EVERYONE);
      const again = gated();
      const flapping = stream.publishProbe(again.q, probeId);
      const calm = stream.publishProbe(again.q, other.id);
      assert.equal(again.asked(), 2);
      again.release();
      assert.deepEqual(await Promise.all([flapping, calm]), [1, 1]);
      assert.equal(steady.changes, 1);
      assert.equal(stream.stats.probeCoalesced, 5);
    });

    it('never rejects when the probe’s place cannot be read, and tells the next change', async () => {
      const seen = probeRecorder();
      stream.watchProbe(seen.watcher, probeId, EVERYONE);
      const failing = {
        query: () => Promise.reject(new Error('connection terminated unexpectedly')),
      } as unknown as typeof db;

      assert.equal(await stream.publishProbe(failing, probeId), 0);
      assert.equal(seen.changes, 0);
      // The failed read is over: a change after it is read for, not folded into nothing.
      assert.equal(await stream.publishProbe(db, probeId), 1);
      assert.equal(seen.changes, 1);
      assert.equal(stream.stats.probeCoalesced, 0);
    });

    it('says nothing about a probe that was deleted before its place was read', async () => {
      const gone = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'short-lived',
      });
      const seen = probeRecorder();
      stream.watchProbe(seen.watcher, gone.id, EVERYONE);
      await db.query('DELETE FROM object WHERE id = $1', [gone.id]);
      assert.equal(await stream.publishProbe(db, gone.id), 0);
      assert.equal(seen.changes, 0);
    });

    it('allows a watch on a probe the view sees, and on nothing else by that route', async () => {
      const epoch = await epochNow();
      const all = Visibility.everything(epoch);
      assert.deepEqual(await stream.canWatchProbe(db, probeId, all), { visible: true, epoch });
      assert.deepEqual(await stream.canWatchProbe(db, probeId, Visibility.EVERYTHING), {
        visible: true,
        epoch,
      });
      // One answer for a probe out of view, an object that is not a probe and an id nobody used.
      const refused = { visible: false, epoch };
      assert.deepEqual(await stream.canWatchProbe(db, probeId, Visibility.nothing(epoch)), refused);
      assert.deepEqual(
        await stream.canWatchProbe(
          db,
          probeId,
          Visibility.of(new Map([[deviceId, true]]), false, epoch),
        ),
        refused,
        'a reader of a device under the probe may not watch the probe',
      );
      assert.deepEqual(await stream.canWatchProbe(db, deviceId, all), refused);
      assert.deepEqual(await stream.canWatchProbe(db, 2_000_000_000, all), refused);
      assert.deepEqual(
        await stream.canWatchProbe(
          db,
          probeId,
          Visibility.of(new Map([[probeId, true]]), false, epoch),
        ),
        { visible: true, epoch },
      );
    });

    // ---------------------------------------------------------------------------------------
    // A socket whose credential lapsed is silenced at an edge and closed by the sweep (`U-25`).
    // ---------------------------------------------------------------------------------------

    /** A credential check that says what it is told to, and records what it was asked. */
    function credentials() {
      const lapses = new Map<string, Lapse>();
      const asked: string[][] = [];
      let failing = false;
      const check: CredentialCheck = {
        lapsed: (about) => {
          const keys = about.map(credentialKey);
          asked.push(keys);
          if (failing) return Promise.reject(new Error('the database went away'));
          const answer = new Map<string, Lapse>();
          for (const key of keys) {
            const lapse = lapses.get(key);
            if (lapse !== undefined) answer.set(key, lapse);
          }
          return Promise.resolve(answer);
        },
      };
      return {
        check,
        asked,
        lapse: (id: string, lapse: Lapse = 'ended'): void => {
          lapses.set(`session:${id}`, lapse);
        },
        restore: (id: string): void => {
          lapses.delete(`session:${id}`);
        },
        fail: (now: boolean): void => {
          failing = now;
        },
      };
    }

    /**
     * An admitted socket with a subscription to everything and a watch on the probe, which does
     * with `silence` what the stream route does: detaches both, at once, and closes nothing.
     */
    function admitted(broadcaster: StateBroadcaster, id: string, check: CredentialCheck) {
      const log: string[] = [];
      const tree = recorder();
      const watch = probeRecorder();
      const detach = [
        broadcaster.subscribe(tree.subscriber, null, EVERYONE),
        broadcaster.watchProbe(watch.watcher, probeId, EVERYONE),
      ];
      const socket: StreamSocket = {
        credential: { kind: 'session', id, userId: 1 },
        silence: (lapse) => {
          log.push(`silence:${lapse}`);
          for (const each of detach) each();
        },
        signOut: (lapse) => {
          log.push(`signOut:${lapse}`);
          for (const each of detach) each();
        },
      };
      const admission = broadcaster.admit(socket, check);
      return { log, tree, watch, admission };
    }

    const stateChange = () => ({
      sensorId,
      state: 'down' as const,
      previousState: 'up' as const,
      cause: 'scan' as const,
      message: 'no ICMP reply',
      at: new Date(),
    });

    it('silences a lapsed socket at the edge that finds it, and closes it only on the sweep', async () => {
      const held = credentials();
      const lapsed = admitted(stream, 'lapsed', held.check);
      const allowed = admitted(stream, 'allowed', held.check);

      // Signed out, and then three state batches and three edges on a probe.
      held.lapse('lapsed');
      for (let batch = 0; batch < 3; batch += 1) await stream.publish(db, [stateChange()]);
      for (let edge = 0; edge < 3; edge += 1) await stream.publishProbe(db, probeId);

      // The edges happened: a socket still signed in was sent every one.
      assert.equal(allowed.tree.events.length, 3);
      assert.equal(allowed.watch.changes, 3);
      assert.deepEqual(allowed.log, []);
      // The lapsed one was sent none of them — not the batch that found it either (`A-34`) — and
      // told nothing else, and is still open: silenced once, signed out not at all.
      assert.equal(lapsed.tree.events.length, 0, 'a change went to a socket after its sign-out');
      assert.equal(lapsed.tree.overflowed, false);
      assert.equal(lapsed.watch.changes, 0);
      assert.deepEqual(lapsed.watch.overflows, []);
      assert.deepEqual(lapsed.log, ['silence:ended'], 'closed at an edge, or silenced twice');
      // Counted where it was found, once.
      assert.equal(stream.stats.signedOut.ended, 1);

      // The sweep's tick, and only that, closes it.
      await stream.sweep();
      assert.deepEqual(lapsed.log, ['silence:ended', 'signOut:ended']);
      assert.deepEqual(allowed.log, []);
      assert.equal(stream.stats.signedOut.ended, 1, 'counted again when it was closed');
      // Once: later sweeps and edges have nothing left to say to it.
      await stream.publish(db, [stateChange()]);
      await stream.sweep();
      assert.deepEqual(lapsed.log, ['silence:ended', 'signOut:ended']);
      assert.equal(allowed.tree.events.length, 4);
    });

    it('silences at a probe’s edge too, with nobody subscribed to the tree', async () => {
      const held = credentials();
      const log: string[] = [];
      const watch = probeRecorder();
      const detach = stream.watchProbe(watch.watcher, probeId, EVERYONE);
      stream.admit(
        {
          credential: { kind: 'session', id: 'form', userId: 1 },
          silence: (lapse) => {
            log.push(`silence:${lapse}`);
            detach();
          },
          signOut: (lapse) => log.push(`signOut:${lapse}`),
        },
        held.check,
      );
      const other = probeRecorder();
      stream.watchProbe(other.watcher, probeId, EVERYONE);
      assert.equal(stream.watching, false);

      held.lapse('form', 'disabled');
      for (let edge = 0; edge < 3; edge += 1) await stream.publishProbe(db, probeId);
      assert.equal(other.changes, 3, 'the edges happened');
      assert.equal(watch.changes, 0);
      assert.deepEqual(watch.overflows, []);
      assert.deepEqual(log, ['silence:disabled']);

      await stream.sweep();
      assert.deepEqual(log, ['silence:disabled', 'signOut:disabled']);
    });

    it('asks once per edge as before, and never again about a socket it has silenced', async () => {
      const held = credentials();
      admitted(stream, 'lapsed', held.check);
      admitted(stream, 'allowed', held.check);
      held.lapse('lapsed');

      await stream.publish(db, [stateChange()]);
      assert.deepEqual(held.asked, [['session:lapsed', 'session:allowed']]);
      await stream.publish(db, [stateChange()]);
      await stream.publishProbe(db, probeId);
      await stream.sweep();
      assert.deepEqual(
        held.asked.slice(1),
        [['session:allowed'], ['session:allowed'], ['session:allowed']],
        'one question per edge and per sweep, and none about a socket already decided',
      );
    });

    it('closes a silenced socket on the sweep even when it would now be answered for', async () => {
      // A session ended and — by a restore, or an administrator who thought better of it — back
      // again. The socket missed what was not sent to it, and only a close tells its client so.
      const held = credentials();
      const lapsed = admitted(stream, 'lapsed', held.check);
      held.lapse('lapsed');
      await stream.publish(db, [stateChange()]);
      held.restore('lapsed');
      await stream.publish(db, [stateChange()]);
      assert.equal(lapsed.tree.events.length, 0);

      await stream.sweep();
      assert.deepEqual(lapsed.log, ['silence:ended', 'signOut:ended']);
    });

    it('closes what an edge decided on a sweep whose own check fails, and nothing else', async () => {
      const held = credentials();
      const silenced = admitted(stream, 'silenced', held.check);
      held.lapse('silenced');
      await stream.publish(db, [stateChange()]);
      // Lapsed since, and found by nothing yet.
      const unfound = admitted(stream, 'unfound', held.check);
      held.lapse('unfound');
      held.fail(true);
      const failures = stream.stats.credentialCheckFailures;

      await stream.sweep();
      assert.deepEqual(silenced.log, ['silence:ended', 'signOut:ended']);
      assert.deepEqual(unfound.log, [], 'a check that could not answer closed a socket');
      assert.equal(stream.stats.credentialCheckFailures, failures + 1);

      held.fail(false);
      await stream.sweep();
      assert.deepEqual(unfound.log, ['signOut:ended']);
    });

    it('closes a silenced socket at once when its own frame asks, having asked the check all the same', async () => {
      const held = credentials();
      const lapsed = admitted(stream, 'lapsed', held.check);
      const allowed = admitted(stream, 'allowed', held.check);
      held.lapse('lapsed');
      await stream.publish(db, [stateChange()]);
      assert.deepEqual(lapsed.log, ['silence:ended']);
      const before = held.asked.length;

      // What the route does with a frame from the client: asks. No sweep.
      assert.equal(await lapsed.admission.confirm(), false);
      assert.deepEqual(lapsed.log, ['silence:ended', 'signOut:ended']);
      // **Asked, though it was decided**: an unsilenced lapsed socket costs one question before
      // it is closed, and a silenced one that cost none would be closed measurably sooner.
      assert.deepEqual(held.asked.slice(before), [['session:lapsed']]);
      assert.equal(stream.stats.signedOut.ended, 1, 'counted where it was found, and not again');
      // Gone from the sweep: nothing more is said to it, and a second ask is answered no.
      assert.equal(await lapsed.admission.confirm(), false);
      await stream.sweep();
      assert.deepEqual(lapsed.log, ['silence:ended', 'signOut:ended']);

      // One still signed in is confirmed and left alone.
      assert.equal(await allowed.admission.confirm(), true);
      assert.deepEqual(allowed.log, []);

      // And a silenced socket is closed by its own frame even when the check cannot answer —
      // while one not yet decided is "cannot tell", which closes nothing.
      const second = admitted(stream, 'second', held.check);
      held.lapse('second');
      await stream.publish(db, [stateChange()]);
      const third = admitted(stream, 'third', held.check);
      held.lapse('third');
      held.fail(true);
      assert.equal(await second.admission.confirm(), false);
      assert.deepEqual(second.log, ['silence:ended', 'signOut:ended']);
      await assert.rejects(third.admission.confirm(), /the database went away/);
      assert.deepEqual(third.log, []);
    });

    it('says nothing to a silenced socket that closed by itself before the sweep', async () => {
      const held = credentials();
      const lapsed = admitted(stream, 'lapsed', held.check);
      held.lapse('lapsed');
      await stream.publish(db, [stateChange()]);
      lapsed.admission.release();
      await stream.sweep();
      assert.deepEqual(lapsed.log, ['silence:ended']);
      assert.deepEqual(held.asked.length, 1, 'a released socket was asked about');
    });

    it('closes a lapsed socket on the sweep’s tick, wherever in the interval the edges fell', async (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const timed = new StateBroadcaster({ logger: silent, credentialSweepMs: 5_000 });
      const held = credentials();
      // Admitted at 0: the timer's phase is set here, and by nothing after.
      const first = admitted(timed, 'first', held.check);
      const second = admitted(timed, 'second', held.check);
      const third = admitted(timed, 'third', held.check);
      /** Lets whatever a tick started run: a sweep's awaits are promises, not timers. */
      const idle = async (): Promise<void> => {
        for (let turn = 0; turn < 20; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      };

      // Signed out at 1.0 s; a state batch at 1.2 s, a probe's edge at 3.2 s.
      t.mock.timers.tick(1_000);
      held.lapse('first');
      t.mock.timers.tick(200);
      await timed.publish(db, [stateChange()]);
      assert.deepEqual(first.log, ['silence:ended']);
      t.mock.timers.tick(2_000);
      await timed.publishProbe(db, probeId);
      t.mock.timers.tick(1_799);
      await idle();
      assert.deepEqual(first.log, ['silence:ended'], 'closed before the sweep’s tick');
      assert.equal(third.tree.events.length, 1);
      assert.equal(third.watch.changes, 1);

      // 5.0 s: the tick.
      t.mock.timers.tick(1);
      await idle();
      assert.deepEqual(first.log, ['silence:ended', 'signOut:ended']);

      // **The edges moved nothing.** The next tick is at 10.0 s, five seconds after the last
      // and not five seconds after anything that was published: a socket that lapses at 6 s,
      // with an edge at 9 s, is silent from 9 s and closed at 10 s.
      t.mock.timers.tick(1_000);
      held.lapse('second');
      t.mock.timers.tick(3_000);
      await timed.publish(db, [stateChange()]);
      assert.deepEqual(second.log, ['silence:ended']);
      t.mock.timers.tick(999);
      await idle();
      assert.deepEqual(second.log, ['silence:ended']);
      t.mock.timers.tick(1);
      await idle();
      assert.deepEqual(second.log, ['silence:ended', 'signOut:ended']);
      assert.deepEqual(third.log, []);
      third.admission.release();
    });

    it('holds one timer while there is a socket or a watcher, and lets it go with the last', async (t) => {
      // **The timer itself is what is watched** (`U-25`). The test this joins asserted that a
      // sweep read nothing once the last watcher had gone — which a leaked interval also
      // satisfies, since a sweep with nobody to review returns before it reads anything.
      const EVERY = 3_599_989;
      const set = t.mock.method(globalThis, 'setInterval');
      const cleared = t.mock.method(globalThis, 'clearInterval');
      /** Intervals of this broadcaster's period that were set and have not been cleared. */
      const live = (): number => {
        const gone = new Set<unknown>(cleared.mock.calls.map((call) => call.arguments[0]));
        return set.mock.calls.filter(
          (call) => call.arguments[1] === EVERY && !gone.has(call.result),
        ).length;
      };
      const timed = new StateBroadcaster({
        logger: silent,
        accessEpoch: epochNow,
        credentialSweepMs: EVERY,
      });
      const held = credentials();
      assert.equal(live(), 0, 'a timer with nobody to sweep');

      // Watchers alone: armed by the first, one timer for two, gone with the last.
      const one = timed.watchProbe(probeRecorder().watcher, probeId, EVERYONE);
      assert.equal(live(), 1);
      const two = timed.watchProbe(probeRecorder().watcher, probeId, EVERYONE);
      assert.equal(live(), 1);
      one();
      assert.equal(live(), 1);
      two();
      assert.equal(live(), 0, 'the timer outlived the last watcher');

      // A watcher the review itself drops.
      const stale = await epochNow();
      const moved = await grantsMoved();
      const dropped = probeRecorder();
      timed.watchProbe(dropped.watcher, probeId, {
        visibility: Visibility.everything(stale),
        key: 'revoked',
        resolve: () => Promise.resolve(Visibility.nothing(moved)),
      });
      assert.equal(live(), 1);
      await timed.sweep();
      assert.equal(dropped.overflows.length, 1);
      assert.equal(live(), 0, 'the timer outlived a watcher the review sent back');

      // A socket: armed when admitted, gone when released.
      const socket = (id: string, log: string[]): StreamSocket => ({
        credential: { kind: 'session', id, userId: 1 },
        silence: (lapse) => log.push(`silence:${lapse}`),
        signOut: (lapse) => log.push(`signOut:${lapse}`),
      });
      const released = timed.admit(socket('released', []), held.check);
      assert.equal(live(), 1);
      released.release();
      assert.equal(live(), 0, 'the timer outlived the last socket');

      // A socket the sweep closes, which nothing releases.
      const swept: string[] = [];
      timed.admit(socket('swept', swept), held.check);
      held.lapse('swept');
      assert.equal(live(), 1);
      await timed.sweep();
      assert.deepEqual(swept, ['signOut:ended']);
      assert.equal(live(), 0, 'the timer outlived a socket the sweep closed');

      // **A silenced socket holds the timer**: the tick is what closes it.
      const silenced: string[] = [];
      const detach = timed.subscribe(recorder().subscriber, null, EVERYONE);
      timed.admit(socket('silenced', silenced), held.check);
      held.lapse('silenced');
      await timed.publish(db, [stateChange()]);
      assert.deepEqual(silenced, ['silence:ended']);
      assert.equal(live(), 1, 'a silenced socket was left with no timer to close it');
      await timed.sweep();
      assert.deepEqual(silenced, ['silence:ended', 'signOut:ended']);
      assert.equal(live(), 0);
      detach();
      // One timer at a time, throughout.
      assert.equal(set.mock.calls.filter((call) => call.arguments[1] === EVERY).length, 5);
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
        await within(
          10_000,
          'the socket to open',
          new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => {
              resolve();
            });
            socket.addEventListener('error', () => {
              reject(new Error('the socket would not open'));
            });
          }),
        );
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
    async function streaming(
      limits: Partial<StreamLimits> = {},
    ): Promise<{ server: ApiServer; url: string }> {
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
        streamLimits: limits,
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
      await within(
        10_000,
        'the socket to open',
        new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => {
            resolve();
          });
          socket.addEventListener('error', () => {
            reject(new Error('the socket would not open'));
          });
        }),
      );
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
        // `problem` on a socket that still subscribes afterwards. More of them than a socket is
        // answered by default (`A-30`), which has its own case below: this one is about every shape.
        const { server, url } = await streaming({ problems: 1_000 });
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

    it(
      'stops answering a socket that keeps sending what it cannot use (A-30)',
      { timeout: 30_000 },
      async () => {
        // Each refusal was answered, on a socket that stayed open: a seven-byte frame bought a reply
        // twenty times its size, as often as a client cared to send one.
        const { server, url } = await streaming();
        const client = await connected(url);
        try {
          for (let n = 0; n <= STREAM_LIMITS.problems; n += 1) client.socket.send('5');
          assert.equal(await client.closed(), 1008);
          assert.equal(
            client.frames.filter((frame) => frame['type'] === 'problem').length,
            STREAM_LIMITS.problems,
          );
          assert.equal(stream.stats.severed, 1, 'and it is counted on Core Health');
        } finally {
          await server.stop();
        }
      },
    );

    it(
      'closes a socket that subscribes faster than any client needs to (A-30)',
      { timeout: 30_000 },
      async () => {
        const { server, url } = await streaming({ subscribesPerMinute: 3 });
        const client = await connected(url);
        try {
          for (let n = 0; n < 3; n += 1) {
            client.socket.send(JSON.stringify({ subscribe: {} }));
            await client.count('snapshot', n + 1);
          }
          client.socket.send(JSON.stringify({ subscribe: {} }));
          assert.equal(await client.closed(), 1008);
          assert.equal(stream.stats.severed, 1);
        } finally {
          await server.stop();
        }
      },
    );

    it(
      'closes a socket that stops reading before it holds more than its bound (A-30)',
      { timeout: 60_000 },
      async () => {
        // A client that stops reading and keeps sending: every reply queued in the core's memory,
        // with nothing to stop it short of `MemoryMax`. A raw TCP client, because a `ws` client
        // resumes its own socket and so cannot be made to stop reading from outside.
        const bound = 32 * 1024;
        const junk = 50_000;
        const { server, url } = await streaming({ socketBytes: bound, problems: junk * 2 });
        const { port } = new URL(url);
        const client = connect({ host: '127.0.0.1', port: Number(port) });
        try {
          await within(
            10_000,
            'the connection',
            new Promise<void>((resolve, reject) => {
              client.once('connect', resolve);
              client.once('error', reject);
            }),
          );
          client.write(
            'GET /api/v1/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n' +
              'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              'Sec-WebSocket-Version: 13\r\n\r\n',
          );
          await within(
            10_000,
            'the upgrade to be answered',
            new Promise<void>((resolve) => {
              client.once('data', () => {
                resolve();
              });
            }),
          );
          // Nothing read from here on.
          client.pause();

          // `5`, masked with a zero key, fifty thousand times: seven bytes each way in, some 150
          // back as a `problem`. Unbounded, that is 7 MiB queued for a client reading none of it.
          const frame = Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0x35]);
          client.write(Buffer.concat(Array.from({ length: junk }, () => frame)));

          const deadline = Date.now() + 30_000;
          while (stream.stats.severed === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(stream.stats.severed, 1, 'the socket was never closed');

          // What it can still read is what the kernel held when the core let go, not the 7 MiB.
          let received = 0;
          client.on('data', (chunk: Buffer) => {
            received += chunk.length;
          });
          const ended = new Promise<void>((resolve) => {
            client.once('close', () => {
              resolve();
            });
          });
          client.resume();
          await within(10_000, 'the core to close the socket it severed', ended);
          assert.ok(
            received < (junk * 150) / 2,
            `${String(received)} bytes reached a client that read none of them`,
          );
        } finally {
          client.destroy();
          await server.stop();
        }
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

/**
 * `promise`, or a failure naming `what` once `ms` have passed.
 *
 * **For every wait on the far end of a socket.** A test's own `timeout` fails the test and does
 * not cancel it, so an `await` that never settles never reaches the `finally` that stops the
 * server — and the server's open handles then keep the whole file's process alive, which is a
 * suite that never finishes rather than a test that fails.
 */
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

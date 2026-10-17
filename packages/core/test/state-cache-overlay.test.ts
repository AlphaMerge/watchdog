import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import type { HeldWords } from '../src/state/runtime.js';
import {
  SensorStateService,
  type PolicySource,
  type SensorResult,
  type SensorStateServiceOptions,
} from '../src/state/service.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

const T0 = new Date(Date.now() - 60 * 60_000);
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const HELD: HeldWords = { message: 'held by the test', failure: null };

/** One kind of hold the state service lays over the facts, and what it decides while it stands. */
interface Hold {
  readonly name: string;
  readonly decided: { state: SensorState; cause: SensorStateCause };
  /** The service's option for this hold, reading `held` live. */
  readonly option: (held: ReadonlySet<number>) => Partial<SensorStateServiceOptions>;
}

const asWords = (held: ReadonlySet<number>): ReadonlyMap<number, HeldWords> =>
  new Map([...held].map((id) => [id, HELD]));

const HOLDS: readonly Hold[] = [
  {
    name: 'a lost probe',
    decided: { state: 'unknown', cause: 'probe' },
    option: (held) => ({ lostSensors: () => asWords(held) }),
  },
  {
    name: 'a silence',
    decided: { state: 'unknown', cause: 'probe' },
    option: (held) => ({ silentSensors: () => asWords(held) }),
  },
  {
    name: 'a frozen clock',
    decided: { state: 'unknown', cause: 'probe' },
    option: (held) => ({ clockFrozenSensors: () => asWords(held) }),
  },
  {
    name: 'a check its probe could not start',
    decided: { state: 'unknown', cause: 'probe' },
    option: (held) => ({ notStartedSensors: () => asWords(held) }),
  },
  {
    name: 'a factory’s unreached inputs',
    decided: { state: 'unknown', cause: 'probe' },
    option: (held) => ({ unreachedFactories: () => asWords(held) }),
  },
  {
    name: 'a withholding',
    decided: { state: 'unknown', cause: 'access' },
    option: (held) => ({ withheldSensors: () => asWords(held) }),
  },
];

/**
 * What the state service caches is what the row says, and the live facts are laid over it as a
 * batch is decided (`P-412`). A load that straddled a release cached the hold of its moment after
 * the release had dropped the entry, and the sensor's new probe never sends a release to drop it
 * again: every result it sent was decided Unknown from that.
 */
describe(
  'the live facts are read as each batch is decided, and never cached (P-412)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('state_cache_overlay');
      db = scratch.db;
      h = await buildHarness(db);
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
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'app-server',
        host: '192.0.2.41',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;
    });

    const replied = (minutes: number): SensorResult => ({
      sensorId,
      at: at(minutes),
      outcome: 'ok',
      message: '4/4 replies',
    });

    const decided = async (
      states: SensorStateService,
      minutes: number,
    ): Promise<{ state: SensorState; cause: SensorStateCause } | undefined> => {
      const runtime = (await states.decide([replied(minutes)])).runtimes[0];
      return runtime === undefined ? undefined : { state: runtime.state, cause: runtime.cause };
    };

    for (const hold of HOLDS) {
      it(`does not cache ${hold.name} that a release let go while the load was open`, async () => {
        const held = new Set([sensorId]);
        let loaded = (): void => undefined;
        const wasLoaded = new Promise<void>((resolve) => {
          loaded = resolve;
        });
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        // The row is read on one connection and the policy on another, and the batch waits for
        // both: the policy read is held open once the row has been read under the hold.
        const settings: PolicySource = {
          resolveForObjects: async (ids, key) => {
            const answer = await h.resolver.resolveForObjects(ids, key);
            await gate;
            return answer;
          },
        };
        const signalling = new Proxy(db, {
          get(target, property) {
            if (property === 'tx') {
              return (fn: (q: Queryable) => Promise<unknown>): Promise<unknown> =>
                target.tx(fn).finally(loaded);
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function'
              ? (value as (this: Database, ...args: unknown[]) => unknown).bind(target)
              : value;
          },
        });
        const states = new SensorStateService({
          db: signalling,
          logger: silent,
          settings,
          pauses: new PauseRepository(),
          ...hold.option(held),
        });

        const deciding = decided(states, 1);
        await within(5_000, 'the runtime load under the hold', wasLoaded);
        // A turn of the event loop, so whatever is chained on the load has run under the hold: the
        // signal comes one step before it, and a release taken there overtook what it tests.
        await new Promise<void>((resolve) => setImmediate(resolve));
        // What a release does: the hold goes, and so does what was cached of the sensor.
        held.delete(sensorId);
        states.forgetSensors([sensorId]);
        open();

        assert.deepEqual(
          await within(5_000, 'the batch the release overtook', deciding),
          { state: 'up', cause: 'scan' },
          'decided under the facts as they were when it was decided',
        );
        assert.equal(states.peek(sensorId)?.facts.probeReachable, true);
        assert.equal(states.peek(sensorId)?.facts.vouchedFor, true);
        assert.deepEqual(await decided(states, 2), { state: 'up', cause: 'scan' });
      });

      it(`caches a result decided while ${hold.name} stood as its row has it, and reads the hold live`, async () => {
        const held = new Set([sensorId]);
        const states = new SensorStateService({
          db,
          logger: silent,
          pauses: new PauseRepository(),
          ...hold.option(held),
        });
        assert.deepEqual(await decided(states, 1), hold.decided);
        const cached = states.peek(sensorId);
        assert.ok(cached);
        assert.equal(cached.state, hold.decided.state, 'what the row will say');
        assert.equal(
          cached.cause,
          hold.decided.cause,
          'the decision, not the row it was read from',
        );
        assert.equal(cached.facts.lastResultAt?.getTime(), at(1).getTime());
        assert.equal(cached.facts.probeReachable, true, 'with no hold in it');
        assert.equal(cached.facts.vouchedFor, true);

        // Let go with nothing dropped from the cache: the next result reads that it has gone.
        held.delete(sensorId);
        assert.deepEqual(await decided(states, 2), { state: 'up', cause: 'scan' });
        // And held again over a warm cache: the next result reads that too.
        held.add(sensorId);
        assert.deepEqual(await decided(states, 3), hold.decided);
      });
    }
  },
);

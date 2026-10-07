import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import { SensorOwnership } from '../src/ingestion/ownership.js';
import { IngestionService } from '../src/ingestion/service.js';
import { ProbeRefusals } from '../src/probes/refusals.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

const coreEvaluated = (sensorType: string): boolean => sensorType === 'ms.probe.health';

function result(sensorId: number, outcome: 'ok' | 'error' = 'ok'): CheckResult {
  return {
    sensorId,
    at: new Date().toISOString(),
    outcome,
    message: outcome === 'ok' ? '4/4 replies' : 'no replies',
    durationMs: 12,
    channels: outcome === 'ok' ? [{ key: 'rtt', value: 1.5 }] : [],
  };
}

/** Counts the statements something issues, to tell a cache hit from a database round trip. */
function counting(q: Queryable): { q: Queryable; count: () => number } {
  let statements = 0;
  return {
    q: {
      query: async (text, values) => {
        statements += 1;
        return q.query(text, values);
      },
    },
    count: () => statements,
  };
}

describe(
  'which probe may report a sensor (`P-228`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let ownership: SensorOwnership;
    let invalidator: ResultCacheInvalidator;
    let serial = 0;

    before(async () => {
      scratch = await createScratchDatabase('p228ownership');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      ownership = new SensorOwnership({ coreEvaluated });
      // Where the two sit in production: the audit log written in the mover's transaction, and
      // the invalidator told in the same call. A test that cleared the cache by hand would prove
      // nothing about whether a move clears it.
      invalidator = new ResultCacheInvalidator({
        channels: new ChannelResolver({ logger: silent }),
        owners: ownership,
        logger: silent,
        settleMs: 5,
      });
      h.audit.also = new CompositeAuditSink([new DatabaseAuditSink(), invalidator]);
    });

    after(async () => {
      invalidator.stop();
      await scratch.drop();
    });

    /** Two probes. A: a group holding a device, and a device of its own. B: a device and a group. */
    async function tree(): Promise<{
      a: number;
      b: number;
      groupA: number;
      deviceA: number;
      sensorA: number;
      directA: number;
      healthA: number;
      deviceB: number;
      groupB: number;
      sensorB: number;
    }> {
      serial += 1;
      const named = (name: string): string => `${name}-${String(serial)}`;
      const probe = async (name: string): Promise<number> =>
        (
          await h.service.create(testActor, {
            kind: 'probe',
            parentId: h.rootId,
            name: named(name),
          })
        ).id;
      const group = async (parentId: number, name: string): Promise<number> =>
        (await h.service.create(testActor, { kind: 'group', parentId, name: named(name) })).id;
      const device = async (parentId: number, name: string): Promise<number> =>
        (
          await h.service.create(testActor, {
            kind: 'device',
            parentId,
            name: named(name),
            host: '192.0.2.10',
          })
        ).id;
      const sensor = async (parentId: number, name: string, sensorType = 'icmp.ping') =>
        (
          await h.service.create(testActor, {
            kind: 'sensor',
            parentId,
            name: named(name),
            sensorType,
            params: {},
          })
        ).id;

      const a = await probe('A');
      const b = await probe('B');
      const groupA = await group(a, 'GA');
      const deviceA = await device(groupA, 'DA');
      const sensorA = await sensor(deviceA, 'Ping A');
      const directDevice = await device(a, 'DA2');
      const directA = await sensor(directDevice, 'Ping A2');
      const healthA = await sensor(deviceA, 'Probe Health', 'ms.probe.health');
      const deviceB = await device(b, 'DB');
      const groupB = await group(b, 'GB');
      const sensorB = await sensor(deviceB, 'Ping B');
      return { a, b, groupA, deviceA, sensorA, directA, healthA, deviceB, groupB, sensorB };
    }

    const move = async (id: number, to: number): Promise<void> => {
      await h.service.move(testActor, id, to, { kind: 'none' });
    };

    const ids = (list: readonly CheckResult[]): number[] => list.map((one) => one.sensorId);

    it('admits a probe’s own sensors and refuses another probe’s as foreign', async () => {
      const t = await tree();
      const admitted = await ownership.admit(db, t.a, [
        result(t.sensorA),
        result(t.sensorB),
        result(t.directA),
      ]);
      assert.deepEqual(ids(admitted.results), [t.sensorA, t.directA]);
      assert.deepEqual(ids(admitted.refused.foreign), [t.sensorB]);
      assert.deepEqual(ids(admitted.refused.moved), []);
    });

    it('refuses a sensor that does not exist as unknown, which is ordinary, not foreign', async () => {
      const t = await tree();
      const admitted = await ownership.admit(db, t.a, [result(2_000_000_000)]);
      assert.deepEqual(ids(admitted.refused.unknown), [2_000_000_000]);
      assert.deepEqual(ids(admitted.refused.foreign), []);
    });

    it('refuses a type the core evaluates, even from the probe it sits under', async () => {
      // A probe reporting its own health as fine is the reading Probe Health exists to take out
      // of the probe's hands.
      const t = await tree();
      const admitted = await ownership.admit(db, t.a, [result(t.healthA)]);
      assert.deepEqual(ids(admitted.refused.foreign), [t.healthA]);
    });

    it('refuses everything real from a GID no probe object has claimed', async () => {
      const t = await tree();
      const admitted = await ownership.admit(db, null, [result(t.sensorA)]);
      assert.deepEqual(ids(admitted.refused.foreign), [t.sensorA]);
    });

    it('reads a sensor moved away as moved on the probe it left, and admits it for the new one', async () => {
      const t = await tree();
      assert.equal((await ownership.admit(db, t.a, [result(t.sensorA)])).results.length, 1);

      await move(t.sensorA, t.deviceB);
      const fromA = await ownership.admit(db, t.a, [result(t.sensorA)]);
      assert.deepEqual(ids(fromA.refused.moved), [t.sensorA], 'the old probe is lagging a move');
      const fromB = await ownership.admit(db, t.b, [result(t.sensorA)]);
      assert.deepEqual(ids(fromB.results), [t.sensorA], 'and the new one owns it at once');
    });

    it('reads a sensor as moved when its device moved', async () => {
      const t = await tree();
      await move(t.deviceA, t.b);
      const fromA = await ownership.admit(db, t.a, [result(t.sensorA)]);
      assert.deepEqual(ids(fromA.refused.moved), [t.sensorA]);
    });

    it('reads a sensor as moved when a group above it moved', async () => {
      const t = await tree();
      await move(t.groupA, t.b);
      const fromA = await ownership.admit(db, t.a, [result(t.sensorA)]);
      assert.deepEqual(ids(fromA.refused.moved), [t.sensorA]);
    });

    it('still reads it as moved after it was moved again, out of the group that carried it', async () => {
      // The case that needs the *historical* walk. The group left A, then the sensor left the
      // group; its current ancestors include neither the group nor A, and A's spool is still
      // draining. The walk goes through the sensor's own move back into the group, and through
      // the group's move back to A.
      const t = await tree();
      await move(t.groupA, t.b);
      await move(t.sensorA, t.deviceB);
      const fromA = await ownership.admit(db, t.a, [result(t.sensorA)]);
      assert.deepEqual(ids(fromA.refused.moved), [t.sensorA]);
    });

    it('keeps a sensor that was never under the probe foreign, whatever moved around it', async () => {
      const t = await tree();
      await move(t.deviceB, t.groupB);
      await move(t.groupA, t.b);
      const fromA = await ownership.admit(db, t.a, [result(t.sensorB)]);
      assert.deepEqual(ids(fromA.refused.foreign), [t.sensorB]);
    });

    it('keeps a sensor created after its group left the probe foreign to it (`P-241`)', async () => {
      // The group left A for B, and only then was the sensor created in it, so it was never
      // under A. The walk used to follow the group's move back to A whenever that move
      // happened, and read A's results as `moved`, which warns nobody.
      const t = await tree();
      await move(t.groupA, t.b);
      const born = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: t.deviceA,
          name: `Ping late-${String(serial)}`,
          sensorType: 'icmp.ping',
          params: {},
        })
      ).id;
      const fromA = await ownership.admit(db, t.a, [result(born)]);
      assert.deepEqual(ids(fromA.refused.foreign), [born], 'read as moved, from before it existed');
      const fromB = await ownership.admit(db, t.b, [result(born)]);
      assert.deepEqual(ids(fromB.results), [born]);
      // And a sensor that was in the group when it moved still reads as moved: the bound is
      // the sensor's own creation, not the time of asking.
      const lagging = await ownership.admit(db, t.a, [result(t.sensorA)]);
      assert.deepEqual(ids(lagging.refused.moved), [t.sensorA]);
    });

    it('reads a deleted sensor as unknown rather than as the probe it was under', async () => {
      const t = await tree();
      assert.equal((await ownership.admit(db, t.a, [result(t.directA)])).results.length, 1);

      await h.service.delete(testActor, t.directA, { kind: 'leafOnly' }, { kind: 'none' });
      const after = await ownership.admit(db, t.a, [result(t.directA)]);
      assert.deepEqual(ids(after.refused.unknown), [t.directA]);
    });

    it('answers from its cache until a move says otherwise', async () => {
      const t = await tree();
      await ownership.admit(db, t.a, [result(t.sensorA), result(t.sensorB)]);

      const warm = counting(db);
      await ownership.admit(warm.q, t.a, [result(t.sensorA), result(t.sensorB)]);
      assert.equal(warm.count(), 0, 'owners and the foreign verdict both came from the cache');

      await move(t.sensorA, t.deviceB);
      const cold = counting(db);
      const fromA = await ownership.admit(cold.q, t.a, [result(t.sensorA)]);
      assert.ok(cold.count() > 0, 'the move cleared it');
      assert.deepEqual(ids(fromA.refused.moved), [t.sensorA]);
    });

    describe('in the ingestion service', () => {
      function service(refusals: ProbeRefusals): {
        ingestion: IngestionService;
        ingestor: Ingestor;
      } {
        const ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
        const ingestion = new IngestionService({
          db,
          logger: silent,
          ingestor,
          ownership,
          refusals,
          ...(h.states === undefined ? {} : { states: h.states }),
        });
        return { ingestion, ingestor };
      }

      async function stateOf(sensorId: number): Promise<{ state: string | null; history: number }> {
        const runtime = await db.query<{ state: string }>(
          'SELECT state FROM sensor_runtime WHERE object_id = $1',
          [sensorId],
        );
        const history = await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1',
          [sensorId],
        );
        return { state: runtime[0]?.state ?? null, history: Number(history[0]?.n ?? 0) };
      }

      async function channelsOf(sensorId: number): Promise<string[]> {
        const rows = await db.query<{ key: string }>(
          'SELECT key FROM channel WHERE sensor_id = $1 ORDER BY key',
          [sensorId],
        );
        return rows.map((row) => row.key);
      }

      it('stores what a probe may report, and moves nothing for what it may not', async () => {
        const t = await tree();
        const refusals = new ProbeRefusals();
        const { ingestion, ingestor } = service(refusals);
        const before = { state: await stateOf(t.sensorB), channels: await channelsOf(t.sensorB) };

        const reply = await ingestion.acceptProbeResults(
          { gid: 'gid-a', probeObjectId: t.a },
          {
            type: 'results',
            batchId: 'mixed',
            results: [
              result(t.sensorA),
              // The worst of the three paths: no readings at all, so a gate in the channel
              // resolver would never have seen it, and it is what turns a sensor Down.
              result(t.sensorB, 'error'),
              // A second later: the same sensor at the same time is one result, to the store
              // and, since `P-295`, to the count of what was refused.
              {
                ...result(t.sensorB),
                at: new Date(Date.now() + 1_000).toISOString(),
                channels: [{ key: 'injected', value: 999 }],
              },
            ],
          },
        );
        await ingestor.stop();

        assert.ok(reply.type === 'results-ack');
        assert.equal(reply.storedSamples, 1, 'A’s own reading');
        assert.deepEqual(await stateOf(t.sensorB), before.state, 'B’s sensor did not move');
        assert.deepEqual(await channelsOf(t.sensorB), before.channels, 'and gained no channel');
        assert.equal((await stateOf(t.sensorA)).state, 'up');
        assert.deepEqual(refusals.countsFor(t.a), { refused: 2, foreignRecently: 2 });
        assert.equal(ingestion.stats().refusedForeign, 2);
      });

      it('acknowledges a batch it refused entirely, so the probe does not send it for ever', async () => {
        const t = await tree();
        const { ingestion, ingestor } = service(new ProbeRefusals());
        const reply = await ingestion.acceptProbeResults(
          { gid: 'gid-a', probeObjectId: t.a },
          { type: 'results', batchId: 'all-foreign', results: [result(t.sensorB, 'error')] },
        );
        await ingestor.stop();
        assert.deepEqual(reply, {
          type: 'results-ack',
          batchId: 'all-foreign',
          storedSamples: 0,
          retryAfterMs: 0,
        });
      });

      it('counts a moved sensor’s late results as refused and never as foreign', async () => {
        const t = await tree();
        const refusals = new ProbeRefusals();
        const { ingestion, ingestor } = service(refusals);
        await move(t.deviceA, t.b);

        await ingestion.acceptProbeResults(
          { gid: 'gid-a', probeObjectId: t.a },
          { type: 'results', batchId: 'late', results: [result(t.sensorA, 'error')] },
        );
        await ingestor.stop();

        assert.deepEqual(refusals.countsFor(t.a), { refused: 1, foreignRecently: 0 });
        assert.equal(ingestion.stats().refusedMoved, 1);
      });

      it('counts a deleted sensor’s readings as dropped, as it did before the gate', async () => {
        const t = await tree();
        const { ingestion, ingestor } = service(new ProbeRefusals());
        const dropped = ingestion.stats().discardedUnknownSensor;
        await ingestion.acceptProbeResults(
          { gid: 'gid-a', probeObjectId: t.a },
          { type: 'results', batchId: 'gone', results: [result(2_000_000_001)] },
        );
        await ingestor.stop();
        assert.equal(ingestion.stats().discardedUnknownSensor, dropped + 1);
        assert.equal(ingestion.stats().refusedUnknown, 1);
      });

      // `P-295`: a batch whose acknowledgement was lost is sent again, and its refusals were
      // counted again with it. Not under the same batch id: the probe numbers every send, and
      // its spool may put the results with others queued since (`P-288`).
      it('counts each refusal once when the acknowledgement was lost and the batch comes again', async () => {
        const t = await tree();
        const refusals = new ProbeRefusals();
        const { ingestion, ingestor } = service(refusals);
        try {
          await move(t.deviceA, t.b);
          const stamp = new Date().toISOString();
          // As the spool holds them: sent again, each is the same result.
          const spooled = [
            { ...result(t.directA), at: stamp },
            { ...result(t.sensorA, 'error'), at: stamp },
            { ...result(t.sensorB, 'error'), at: stamp },
            { ...result(2_000_000_002), at: stamp },
          ];
          const origin = { gid: 'gid-a', probeObjectId: t.a };

          const first = await ingestion.acceptProbeResults(origin, {
            type: 'results',
            batchId: 'gid-a-1',
            results: spooled,
          });
          assert.equal(first.type, 'results-ack');
          assert.deepEqual(refusals.countsFor(t.a), { refused: 3, foreignRecently: 1 });

          // The acknowledgement was lost. The same results again, under a new send's id, with
          // one more foreign result queued since.
          const queuedSince = {
            ...result(t.sensorB, 'error'),
            at: new Date(Date.parse(stamp) + 1_000).toISOString(),
          };
          const again = await ingestion.acceptProbeResults(origin, {
            type: 'results',
            batchId: 'gid-a-2',
            results: [...spooled, queuedSince],
          });
          assert.equal(again.type, 'results-ack');

          // Each refused result once: only the one queued since is new. The foreign window is
          // told every arrival, so the warning lasts five minutes after the last of them.
          assert.deepEqual(refusals.countsFor(t.a), { refused: 4, foreignRecently: 3 });
          assert.deepEqual(refusals.stats(), { refused: 4, foreign: 2 });
          const stats = ingestion.stats();
          assert.deepEqual(
            [stats.refusedUnknown, stats.refusedMoved, stats.refusedForeign],
            [1, 1, 2],
          );
          assert.equal(stats.discardedUnknownSensor, 1, 'the unknown sensor’s reading once');
          // And what arrived is still what arrived: two sends of four, and the one since.
          assert.equal(stats.resultsReceived, 9);
          assert.equal(stats.resultsRemembered, 4, 'the refusals, and not the stored result');
        } finally {
          await ingestor.stop();
        }
      });
    });
  },
);

describe('every re-parenting records the probe it left (`P-228`)', () => {
  // The classification above reads the audit log, so a path that moved a sensor between probes
  // without writing `object.moved` would turn an ordinary move into a foreign warning. Today
  // there is one statement that changes `parent_id` and one caller of it; this fails the day a
  // second appears, which is the day somebody has to decide what it records.
  const src = join(import.meta.dirname, '..', '..', 'src');
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8') }));

  it('has one statement that changes a parent', () => {
    const writers = files.filter(({ text }) => /SET\s+parent_id\s*=/iu.test(text));
    assert.deepEqual(
      writers.map(({ file }) => file),
      [join('objects', 'repository.ts')],
    );
  });

  it('reaches it from one place, which records where the object came from', () => {
    const callers = files.filter(({ text }) => text.includes('.reparent('));
    assert.deepEqual(
      callers.map(({ file }) => file),
      [join('objects', 'service.ts')],
    );
    const service = callers[0]?.text ?? '';
    const moved = service.indexOf("action: 'object.moved'");
    assert.ok(moved > 0, 'the move is audited');
    assert.ok(service.slice(moved, moved + 400).includes('fromProbeId:'), 'with the probe it left');
  });
});

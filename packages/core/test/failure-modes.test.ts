import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { IngestionConfig } from '@ms/shared';
import type { Database, Queryable } from '../src/db/pool.js';
import { Ingestor, type IngestTarget, type SampleRow } from '../src/ingestion/ingestor.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * `WORKFLOW.MD §13`, for the two rows nothing proved end to end (`H-02`).
 *
 * The other six rows are proved where they live, and the audit in
 * `docs/findings/2026-08-29-failure-modes.md` says which test proves which claim. What was
 * missing is not a mechanism — every part of these two rows has a unit test — but the *sentence*:
 * a core that restarts loses nothing, and a database that goes away and comes back loses nothing.
 * Both are claims about two components agreeing across an interruption, and neither component's
 * own tests can make them.
 *
 * **Nothing is mocked that matters.** The database is a real scratch database, the ingestor is
 * the real one, and the failure is injected where a real one occurs — at the write. A test that
 * stubbed the ingestor would be asserting that a stub returns what it was told to.
 */

const AT = new Date('2026-08-20T10:00:00.000Z');

function ingestion(overrides: Partial<IngestionConfig> = {}): IngestionConfig {
  return {
    queueMaxRows: 200_000,
    batchMaxRows: 5_000,
    batchMaxDelayMs: 20,
    slowDownAtPercent: 50,
    retryAfterMs: 1_000,
    replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
    ...overrides,
  };
}

function samples(channelId: number, count: number, from = AT): SampleRow[] {
  return Array.from({ length: count }, (_, index) => ({
    channelId,
    at: new Date(from.getTime() + index * 60_000),
    value: index + 1,
  }));
}

/**
 * A database that can be taken away and given back.
 *
 * Throwing from `query` is what a lost connection looks like from above — `pg` rejects the
 * query, it does not return an empty result — so this is the failure the ingestor's own error
 * path was written for rather than a synthetic one.
 */
function breakable(db: Database): { target: IngestTarget; fail: (on: boolean) => void } {
  let failing = false;
  return {
    fail: (on: boolean) => {
      failing = on;
    },
    target: {
      tx: async <T>(run: (q: Queryable) => Promise<T>): Promise<T> => {
        if (failing) throw new Error('connection terminated unexpectedly');
        return db.tx(run);
      },
    },
  };
}

describe(
  'failure modes',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('failuremodes');
      db = scratch.db;
      h = await buildHarness(db);
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Failure probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Failure device',
        host: '192.0.2.30',
      });
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Failure sensor',
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query(
        `SELECT drop_chunks('sample'::regclass, older_than => 'infinity'::timestamptz)`,
      );
    });

    const stored = async (channelId: number): Promise<number> => {
      const rows = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM sample WHERE channel_id = $1',
        [channelId],
      );
      return Number(rows[0]?.count ?? 0);
    };

    // ── §13: "Core server restarts" ─────────────────────────────────────────────────────────

    describe('when the core restarts', () => {
      it('stores a replayed batch once, however many times the probe offers it', async () => {
        // What a restart *is*, from the probe's side: the acknowledgement for a batch it sent
        // never arrived, so it keeps the batch and offers it again to whatever comes back. If
        // the write were not idempotent the graph would carry a doubled point at every restart —
        // and it would look like data rather than like a fault.
        const first = new Ingestor({ db, logger: silent, config: ingestion() });
        const outcome = await first.submit({ source: 'probe-1', samples: samples(901, 5) });
        assert.equal(outcome.accepted, true);
        await first.stop();

        const second = new Ingestor({ db, logger: silent, config: ingestion() });
        const replays = [
          await second.submit({ source: 'probe-1', samples: samples(901, 5) }),
          await second.submit({ source: 'probe-1', samples: samples(901, 5) }),
        ];
        await second.stop();

        assert.equal(await stored(901), 5, 'three offers of the same five readings');
        // Both halves, and the second is the one a row count alone would miss: a replay that
        // *errored* on the unique index would leave the count right and the probe unable to
        // clear its spool, replaying the same batch until somebody looked at a log.
        assert.ok(
          replays.every((one) => one.accepted),
          'and the probe is told it may forget them',
        );
      });

      it('takes what was never acknowledged, on top of what was', async () => {
        // The realistic shape: some of the spool got through before the core went, the rest did
        // not, and the probe replays from its own last acknowledgement — which overlaps.
        const first = new Ingestor({ db, logger: silent, config: ingestion() });
        await first.submit({ source: 'probe-1', samples: samples(902, 3) });
        await first.stop();

        const second = new Ingestor({ db, logger: silent, config: ingestion() });
        // Six readings starting where the first three did: three are already stored.
        await second.submit({ source: 'probe-1', samples: samples(902, 6) });
        await second.stop();

        assert.equal(await stored(902), 6, 'the overlap is absorbed, the new half lands');
      });

      it('refuses after it has begun stopping, so nothing is promised and dropped', async () => {
        // A restart is a *stop* first, and the window between "shutting down" and "gone" is
        // where a promise nobody keeps would be made. The probe is told to retry instead, and
        // retrying is what the previous two tests then make safe.
        const it0 = new Ingestor({ db, logger: silent, config: ingestion() });
        await it0.stop();

        const outcome = await it0.submit({ source: 'probe-1', samples: samples(903, 2) });
        assert.equal(outcome.accepted, false);
        assert.equal(outcome.reason, 'shutting-down');
        assert.ok(outcome.retryAfterMs > 0, 'and says when to come back');
        assert.equal(await stored(903), 0);
      });

      it('leaves a pause where a new process finds it', async () => {
        // §13's first clause. `pause.test.ts` proves the deadline survives; what is asserted
        // here is the whole path a restart takes — a second service, built from nothing, against
        // the same database — because a pause held anywhere in memory would pass that test and
        // fail this one.
        await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'before the restart');

        const rebuilt = await buildHarness(db);
        const after = await rebuilt.service.pauseState(sensorId);
        assert.equal(after.paused, true);
        assert.equal(after.source, 'manual');
        assert.equal(after.message, 'before the restart');

        await h.service.resume(testActor, sensorId);
      });
    });

    // ── §13: "Database unavailable" ─────────────────────────────────────────────────────────

    describe('when the database goes away', () => {
      it('nacks with a retry rather than throwing, so the probe keeps the batch', async () => {
        // The whole row hangs on this. A rejection here would leave the probe waiting for an
        // acknowledgement that never comes; an *acceptance* would be worse — the probe would
        // drop from its spool a batch that was never written.
        const { target, fail } = breakable(db);
        const it0 = new Ingestor({ db: target, logger: silent, config: ingestion() });

        fail(true);
        const outcome = await it0.submit({ source: 'probe-1', samples: samples(910, 4) });
        assert.equal(outcome.accepted, false);
        assert.ok(outcome.retryAfterMs > 0);
        assert.equal(await stored(910), 0);
        await it0.stop();
      });

      it('counts the failure rather than losing it in a log line', async () => {
        // CLAUDE.md: backpressure is visible, never silent. An outage nobody counted is an
        // outage Core Health cannot report.
        const { target, fail } = breakable(db);
        const it0 = new Ingestor({ db: target, logger: silent, config: ingestion() });

        fail(true);
        await it0.submit({ source: 'probe-1', samples: samples(911, 4) });
        const stats = it0.stats();
        assert.ok(stats.failedBatches > 0, 'the write failure is on the record');
        await it0.stop();
      });

      it('resumes on recovery, with nothing lost and nothing doubled', async () => {
        // The sentence §13 actually makes. Two batches are refused while the database is away
        // and replayed when it returns, along with one that had already been stored — which is
        // exactly what a probe replaying its spool sends, because its own last acknowledgement
        // is older than what the core has.
        const { target, fail } = breakable(db);
        const it0 = new Ingestor({ db: target, logger: silent, config: ingestion() });

        const before = await it0.submit({ source: 'probe-1', samples: samples(912, 2) });
        assert.equal(before.accepted, true);

        fail(true);
        const refused = await Promise.all([
          it0.submit({ source: 'probe-1', samples: samples(912, 4) }),
          it0.submit({ source: 'probe-1', samples: samples(912, 6) }),
        ]);
        assert.ok(
          refused.every((one) => !one.accepted),
          'nothing is acknowledged while the database is away',
        );
        assert.equal(await stored(912), 2, 'and nothing is written');

        fail(false);
        // The probe replays from its own watermark, so it offers everything it holds — including
        // the two the core already has.
        const recovered = await it0.submit({ source: 'probe-1', samples: samples(912, 6) });
        assert.equal(recovered.accepted, true);
        assert.equal(await stored(912), 6, 'the six distinct readings, once each');

        await it0.stop();
      });

      it('does not acknowledge a batch it only queued, if the write then fails', async () => {
        // The subtle one, and the reason `submit` resolves at the *commit* rather than at the
        // enqueue: a batch that was accepted into the queue and then failed to write must still
        // come back as a nack, or the probe drops it from its spool on the strength of a promise
        // the core did not keep.
        const { target, fail } = breakable(db);
        const it0 = new Ingestor({
          db: target,
          logger: silent,
          // Long enough that the batch is certainly still queued when the database goes.
          config: ingestion({ batchMaxDelayMs: 300 }),
        });

        const pending = it0.submit({ source: 'probe-1', samples: samples(913, 3) });
        fail(true);
        const outcome = await pending;

        assert.equal(outcome.accepted, false, 'queued is not stored');
        assert.equal(await stored(913), 0);
        await it0.stop();
      });
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckResult, IngestionConfig } from '@ms/shared';
import type { Database, Queryable } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor, type IngestTarget, type SampleRow } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { ReplayPacer } from '../src/ingestion/replay-pacer.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

function ingestion(overrides: Partial<IngestionConfig> = {}): IngestionConfig {
  return {
    queueMaxRows: 200_000,
    batchMaxRows: 5_000,
    // Short by default: most tests want the write to happen. The few that need to hold a batch
    // in the queue set a long delay explicitly, so no test pays for another test's timer.
    batchMaxDelayMs: 20,
    slowDownAtPercent: 50,
    retryAfterMs: 1_000,
    replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
    ...overrides,
  };
}

const AT = new Date('2026-08-20T10:00:00.000Z');

/** Waits for a condition, or fails rather than leaving the runner to sit on it. */
async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function samples(channelId: number, count: number, from = AT): SampleRow[] {
  return Array.from({ length: count }, (_, index) => ({
    channelId,
    at: new Date(from.getTime() + index * 60_000),
    value: index + 1,
  }));
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
  'ingestion',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('ingestion');
      db = scratch.db;
      const harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Ingest probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Ingest device',
        host: '192.0.2.20',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Ingest sensor',
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
      await db.query('DELETE FROM rollup_watermark');
      await db.query('DELETE FROM rollup_backfill');
      await db.query('DELETE FROM channel');
    });

    function ingestor(config = ingestion(), q: IngestTarget = db): Ingestor {
      return new Ingestor({ db: q, logger: silent, config });
    }

    async function storedFor(channelId: number): Promise<number> {
      const rows = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM sample WHERE channel_id = $1',
        [channelId],
      );
      return Number(rows[0]?.count ?? 0);
    }

    // ---------------------------------------------------------------------------------------
    // Writing.
    // ---------------------------------------------------------------------------------------

    it('stores readings and reports what it stored', async () => {
      const it0 = ingestor();
      const outcome = await it0.submit({ source: 'probe-1', samples: samples(101, 3) });

      assert.equal(outcome.accepted, true);
      assert.equal(outcome.storedSamples, 3);
      assert.equal(await storedFor(101), 3);
      assert.equal(it0.stats().storedSamples, 3);
      await it0.stop();
    });

    it('coalesces several offered batches into one write', async () => {
      const it0 = ingestor();
      // Not awaited individually: three probes reporting at the same moment is the ordinary
      // case, and each paying its own round trip is what batching exists to avoid.
      const outcomes = await Promise.all([
        it0.submit({ source: 'a', samples: samples(201, 2) }),
        it0.submit({ source: 'b', samples: samples(202, 2) }),
        it0.submit({ source: 'c', samples: samples(203, 2) }),
      ]);

      assert.ok(outcomes.every((outcome) => outcome.accepted));
      assert.equal(it0.stats().writes, 1, 'three batches, one statement');
      assert.equal(it0.stats().storedSamples, 6);
      await it0.stop();
    });

    it('writes as soon as it has a full batch, without waiting out the delay', async () => {
      // batchMaxDelayMs is five seconds; if the size trigger did not work this would sit there.
      const it0 = ingestor(ingestion({ batchMaxRows: 3, batchMaxDelayMs: 60_000 }));
      const raced = await Promise.race([
        it0.submit({ source: 'a', samples: samples(301, 4) }).then(() => 'written' as const),
        new Promise<'waited'>((resolve) => {
          setTimeout(() => {
            resolve('waited');
          }, 2_000);
        }),
      ]);
      assert.equal(raced, 'written');
      await it0.stop();
    });

    it('accepts an empty batch, because a probe whose checks all failed still needs an answer', async () => {
      const it0 = ingestor();
      const outcome = await it0.submit({ source: 'a', samples: [] });
      assert.equal(outcome.accepted, true);
      assert.equal(outcome.storedSamples, 0);
      await it0.stop();
    });

    // ---------------------------------------------------------------------------------------
    // Bounds and backpressure.
    // ---------------------------------------------------------------------------------------

    it('refuses a batch that would overflow the queue, and counts it', async () => {
      const it0 = ingestor(
        ingestion({ queueMaxRows: 10, batchMaxRows: 1_000, batchMaxDelayMs: 60_000 }),
      );
      const queued = it0.submit({ source: 'a', samples: samples(401, 8) });

      const refused = await it0.submit({ source: 'b', samples: samples(402, 5) });
      assert.equal(refused.accepted, false);
      assert.equal(refused.reason, 'queue-full');
      assert.ok(refused.retryAfterMs > 0, 'and says how long to wait');

      const stats = it0.stats();
      assert.equal(stats.refusedBatches, 1);
      assert.equal(stats.refusedRows, 5, 'never dropped without counting');

      await it0.stop();
      await queued;
      assert.equal(await storedFor(401), 8, 'what was accepted is still written');
      assert.equal(await storedFor(402), 0, 'what was refused is not');
    });

    it('asks probes to slow down before it has to refuse them', async () => {
      // A hundred rows of room, ten to a write, and a hint above half full. Ten batches arrive
      // at once, so the first acknowledgements go out with ninety rows still queued behind them
      // and the last with none — which is the whole point of a gradual signal.
      const it0 = ingestor(
        ingestion({ queueMaxRows: 100, batchMaxRows: 10, slowDownAtPercent: 50 }),
      );

      const offered = Array.from({ length: 10 }, (_, index) =>
        it0.submit({ source: `probe-${String(index)}`, samples: samples(500 + index, 10) }),
      );
      assert.ok(it0.stats().slowingDown, 'visible in the metrics, not only on the wire');

      const outcomes = await Promise.all(offered);
      assert.ok(
        outcomes.every((outcome) => outcome.accepted),
        'a slow-down is advice, not a refusal',
      );

      const first = outcomes[0];
      const last = outcomes[9];
      assert.ok(first?.accepted === true && first.retryAfterMs > 0, 'told to ease off while deep');
      assert.equal(last?.accepted === true && last.retryAfterMs, 0, 'and let alone once drained');
      assert.equal(it0.stats().refusedBatches, 0);
      await it0.stop();
    });

    it('reports a write failure without throwing, and counts it', async () => {
      const broken: IngestTarget = {
        tx: () => Promise.reject(new Error('the database went away')),
      };
      const it0 = ingestor(ingestion(), broken);

      const outcome = await it0.submit({ source: 'a', samples: samples(601, 2) });
      assert.equal(outcome.accepted, false);
      assert.equal(outcome.reason, 'storage-error');
      assert.equal(it0.stats().failedBatches, 1);
      assert.equal(it0.stats().queuedRows, 0, 'and the queue does not leak the rows it lost');
      await it0.stop();
    });

    it('drains what it has promised before it stops, then refuses everything after', async () => {
      const it0 = ingestor(ingestion({ batchMaxDelayMs: 60_000 }));
      const pending = it0.submit({ source: 'a', samples: samples(701, 4) });

      await it0.stop();
      const outcome = await pending;
      assert.equal(outcome.accepted, true);
      assert.equal(await storedFor(701), 4, 'the drain wrote it rather than waiting out the timer');

      const late = await it0.submit({ source: 'a', samples: samples(702, 1) });
      assert.equal(late.accepted, false);
      assert.equal(late.reason, 'shutting-down');
    });

    // ---------------------------------------------------------------------------------------
    // Replay.
    // ---------------------------------------------------------------------------------------

    it('stores a replayed batch once and says how much of it was already there', async () => {
      const it0 = ingestor();
      const first = await it0.submit({ source: 'a', samples: samples(801, 3) });
      assert.equal(first.accepted, true);
      assert.equal(first.storedSamples, 3);

      // A probe that never saw the acknowledgement offers the batch again.
      const again = await it0.submit({ source: 'a', samples: samples(801, 3) });
      assert.equal(again.accepted, true);
      assert.equal(again.storedSamples, 0, 'all of it was already stored');
      assert.equal(await storedFor(801), 3);
      assert.equal(it0.stats().duplicateSamples, 3);
      await it0.stop();
    });

    it('tells each merged batch the truth about its own readings', async () => {
      const it0 = ingestor();
      await it0.submit({ source: 'a', samples: samples(901, 2) });

      // One batch is entirely new, the other entirely a duplicate, and they are written by the
      // same statement. Splitting the write's total between them would tell both a lie.
      const [fresh, replayed] = await Promise.all([
        it0.submit({ source: 'a', samples: samples(902, 2) }),
        it0.submit({ source: 'b', samples: samples(901, 2) }),
      ]);

      assert.equal(it0.stats().writes, 2, 'the two ran in one write after the first');
      assert.equal(fresh.accepted, true);
      assert.equal(replayed.accepted, true);
      assert.equal(fresh.storedSamples, 2);
      assert.equal(replayed.storedSamples, 0);
      await it0.stop();
    });

    // ---------------------------------------------------------------------------------------
    // Late data — the seam S-06 asked for.
    // ---------------------------------------------------------------------------------------

    it('queues a rollup backfill when readings land behind the watermark', async () => {
      const housekeeper = new Housekeeper({
        db,
        logger: silent,
        config: {
          enabled: false,
          intervalSeconds: 300,
          rollupLagSeconds: 0,
          retention: {
            rawDays: 40,
            fiveMinuteDays: 365,
            hourlyDays: 730,
            dailyDays: 3_650,
            auditDays: 730,
            stateDays: 3_650,
            reportDays: 90,
            reportRunDays: 730,
          },
          compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
          disk: {
            path: '',
            evictBelowPercent: 10,
            recoverAbovePercent: 15,
            minimumRetainedHours: 48,
          },
        },
      });
      await db.query(
        "INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', now() - interval '1 hour')",
      );

      const it0 = new Ingestor({ db, logger: silent, config: ingestion(), lateData: housekeeper });

      // Two hours old: the five-minute tier has already summarised that bucket.
      const late = new Date(Date.now() - 2 * 3_600_000);
      await it0.submit({ source: 'a', samples: [{ channelId: 1001, at: late, value: 1 }] });

      const queued = await db.query<{ from_time: Date; reason: string }>(
        'SELECT from_time, reason FROM rollup_backfill',
      );
      assert.equal(queued.length, 1);
      assert.equal(queued[0]?.from_time.getTime(), late.getTime());
      assert.equal(it0.stats().backfillsQueued, 1);

      // Current readings are ahead of the watermark and need no correction — this must not
      // enqueue a window for every write the system ever does.
      await it0.submit({ source: 'a', samples: [{ channelId: 1001, at: new Date(), value: 2 }] });
      const still = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM rollup_backfill',
      );
      assert.equal(still[0]?.count, '1');

      // **Only the channels that were late, and only readings that were written** (`P-226`). A
      // backfill re-rolls exactly the channels an entry names, so one that named a channel whose
      // readings were current, or a duplicate that changed nothing, would re-roll for nothing.
      await db.query('DELETE FROM rollup_backfill');
      const twoHours = new Date(Date.now() - 2 * 3_600_000);
      const threeHours = new Date(Date.now() - 3 * 3_600_000);
      await it0.submit({
        source: 'a',
        samples: [
          { channelId: 2001, at: twoHours, value: 1 },
          { channelId: 2002, at: new Date(), value: 1 },
          { channelId: 2003, at: threeHours, value: 1 },
          { channelId: 2003, at: twoHours, value: 1 },
        ],
      });
      const named = await db.query<{ from_time: Date; to_time: Date; channel_ids: number[] }>(
        'SELECT from_time, to_time, channel_ids FROM rollup_backfill',
      );
      assert.equal(named.length, 1);
      assert.deepEqual(named[0]?.channel_ids, [2001, 2003]);
      assert.equal(named[0].from_time.getTime(), threeHours.getTime());
      assert.equal(
        named[0].to_time.getTime(),
        twoHours.getTime() + 1,
        'the newest late one, inclusive',
      );

      await db.query('DELETE FROM rollup_backfill');
      await it0.submit({ source: 'a', samples: [{ channelId: 2001, at: twoHours, value: 1 }] });
      const duplicate = await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM rollup_backfill',
      );
      assert.equal(
        duplicate[0]?.count,
        '0',
        'a duplicate wrote nothing, so there is nothing to re-roll',
      );

      // A write that mixes a new late reading with a duplicate one names only the new one's
      // channel: the duplicate's buckets already count it.
      await it0.submit({
        source: 'a',
        samples: [
          { channelId: 2001, at: twoHours, value: 1 },
          { channelId: 2004, at: twoHours, value: 1 },
        ],
      });
      const mixed = await db.query<{ channel_ids: number[] }>(
        'SELECT channel_ids FROM rollup_backfill',
      );
      assert.deepEqual(
        mixed.map((row) => row.channel_ids),
        [[2004]],
      );
      await it0.stop();
    });

    // ---------------------------------------------------------------------------------------
    // Channel resolution.
    // ---------------------------------------------------------------------------------------

    it('creates a channel the first time a sensor reports it, then serves it from memory', async () => {
      const resolver = new ChannelResolver({ logger: silent });
      const results: CheckResult[] = [
        {
          sensorId,
          at: AT.toISOString(),
          outcome: 'ok',
          message: '',
          durationMs: 5,
          channels: [
            { key: 'rtt', value: 12.5, name: 'Round trip', unit: 'ms' },
            { key: 'loss', value: 0, name: 'Packet loss', unit: '%' },
          ],
        },
      ];

      const first = await db.tx((q) => resolver.resolve(q, results));
      assert.equal(first.created, 2);
      assert.equal(first.ids.size, 2);

      const stored = await db.query<{ key: string; name: string; unit: string }>(
        'SELECT key, name, unit FROM channel WHERE sensor_id = $1 ORDER BY key',
        [sensorId],
      );
      assert.deepEqual(
        stored.map((row) => [row.key, row.name, row.unit]),
        [
          ['loss', 'Packet loss', '%'],
          ['rtt', 'Round trip', 'ms'],
        ],
      );

      // The second result for the same channels must not go near the database: at the v1 target
      // that would be 15,000 lookups a minute for information that never changes.
      const spy = counting(db);
      const second = await resolver.resolve(spy.q, results);
      assert.equal(spy.count(), 0, 'resolved entirely from cache');
      assert.equal(second.created, 0);
      assert.deepEqual([...second.ids.values()].sort(), [...first.ids.values()].sort());
    });

    it('drops readings for a sensor that no longer exists, and counts them', async () => {
      const resolver = new ChannelResolver({ logger: silent });
      const resolved = await db.tx((q) =>
        resolver.resolve(q, [
          {
            sensorId: 999_999,
            at: AT.toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [{ key: 'rtt', value: 1 }],
          },
        ]),
      );

      // A spool replayed after the sensor was deleted. Letting the foreign key raise would fail
      // the whole batch, taking every other sensor's readings with it.
      assert.equal(resolved.ids.size, 0);
      assert.equal(resolved.droppedReadings, 1);
      assert.equal(resolved.droppedSensors, 1);
    });

    it('names a channel after its key when the probe sent no display name', async () => {
      const resolver = new ChannelResolver({ logger: silent });
      await db.tx((q) =>
        resolver.resolve(q, [
          {
            sensorId,
            at: AT.toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [{ key: 'bare', value: 1 }],
          },
        ]),
      );
      const [row] = await db.query<{ name: string; unit: string }>(
        "SELECT name, unit FROM channel WHERE sensor_id = $1 AND key = 'bare'",
        [sensorId],
      );
      assert.ok(row);
      assert.equal(row.name, 'bare');
      assert.equal(row.unit, '');
    });

    // ---------------------------------------------------------------------------------------
    // The service the probe endpoint talks to.
    // ---------------------------------------------------------------------------------------

    function service(
      config = ingestion(),
      pacer?: ReplayPacer,
    ): { service: IngestionService; ingestor: Ingestor } {
      const created = new Ingestor({ db, logger: silent, config });
      return {
        service: new IngestionService({
          db,
          logger: silent,
          ingestor: created,
          ...(pacer === undefined ? {} : { pacer }),
        }),
        ingestor: created,
      };
    }

    const batch = (backlog?: number) => ({
      type: 'results' as const,
      batchId: `batch-${String(process.hrtime.bigint())}`,
      ...(backlog === undefined ? {} : { backlog }),
      results: [
        {
          sensorId,
          at: new Date(AT.getTime() + Number(process.hrtime.bigint() % 100_000n)).toISOString(),
          outcome: 'ok' as const,
          message: '',
          durationMs: 1,
          channels: [{ key: 'rtt', value: 1 }],
        },
      ],
    });

    // ---------------------------------------------------------------------------------------
    // Pacing catch-up so it cannot stall live ingestion (R-03).
    // ---------------------------------------------------------------------------------------

    it('does not slow a probe that has nothing behind it', async () => {
      const pacer = new ReplayPacer({
        config: { maxConcurrentProbes: 1, stepMs: 500, maxDelayMs: 5_000, idleAfterMs: 30_000 },
        logger: silent,
      });
      const { service: svc } = service(ingestion(), pacer);

      // Three probes deep in a replay, and the queue itself is nowhere near full.
      for (const source of ['a', 'b', 'c']) await svc.acceptResults(source, batch(10_000));

      const live = await svc.acceptResults('live-probe', batch(0));
      assert.equal(live.type, 'results-ack');
      assert.equal(
        live.retryAfterMs,
        0,
        'a probe reporting a check that just ran must not be queued behind a replaying fleet',
      );
    });

    it('slows a probe that is catching up behind others', async () => {
      const pacer = new ReplayPacer({
        config: { maxConcurrentProbes: 1, stepMs: 500, maxDelayMs: 5_000, idleAfterMs: 30_000 },
        logger: silent,
      });
      const { service: svc } = service(ingestion(), pacer);

      const first = await svc.acceptResults('a', batch(10_000));
      assert.equal(first.type, 'results-ack');
      assert.equal(first.retryAfterMs, 0, 'the first one through is not slowed');

      const second = await svc.acceptResults('b', batch(10_000));
      assert.equal(second.type, 'results-ack');
      assert.equal(second.retryAfterMs, 500, 'one over the limit');
    });

    it('leaves the acknowledgement alone when no pacer is wired', async () => {
      // The behaviour before R-03, and what a build without one still does.
      const { service: svc } = service();
      const reply = await svc.acceptResults('a', batch(10_000));
      assert.equal(reply.type, 'results-ack');
      assert.equal(reply.retryAfterMs, 0);
    });

    it('acknowledges a results batch with the readings it stored', async () => {
      const { service: svc, ingestor: created } = service();
      const reply = await svc.acceptResults('probe-1', {
        type: 'results',
        batchId: 'batch-1',
        results: [
          {
            sensorId,
            at: AT.toISOString(),
            outcome: 'ok',
            message: 'ok',
            durationMs: 4,
            channels: [
              { key: 'rtt', value: 11, name: 'Round trip', unit: 'ms' },
              { key: 'loss', value: 0, name: 'Packet loss', unit: '%' },
            ],
          },
        ],
      });

      assert.equal(reply.type, 'results-ack');
      assert.equal(reply.batchId, 'batch-1');
      assert.equal(reply.storedSamples, 2);
      assert.equal(svc.stats().channelsCreated, 2);
      await created.stop();
    });

    it('refuses to store channel values from a failed check', async () => {
      const { service: svc, ingestor: created } = service();
      const reply = await svc.acceptResults('probe-1', {
        type: 'results',
        batchId: 'batch-2',
        results: [
          {
            sensorId,
            at: AT.toISOString(),
            outcome: 'error',
            message: 'timeout',
            durationMs: 3_000,
            // A misbehaving sensor type sends values anyway. A Down sensor records none: the
            // gap has to stay a gap (CLAUDE.md), and a zero here would draw a line to the floor.
            channels: [{ key: 'rtt', value: 0 }],
          },
        ],
      });

      assert.equal(reply.type, 'results-ack');
      assert.equal(reply.storedSamples, 0);
      assert.equal(svc.stats().discardedOnError, 1);
      const rows = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      assert.equal(rows[0]?.count, '0');
      await created.stop();
    });

    it('discards a result whose timestamp is not a date', async () => {
      const { service: svc, ingestor: created } = service();
      const reply = await svc.acceptResults('probe-1', {
        type: 'results',
        batchId: 'batch-3',
        results: [
          {
            sensorId,
            at: 'the day before yesterday',
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [{ key: 'rtt', value: 5 }],
          },
        ],
      });

      assert.equal(reply.type, 'results-ack');
      assert.equal(svc.stats().discardedInvalidTime, 1);
      await created.stop();
    });

    it('passes a refusal back to the probe as a nack it can retry', async () => {
      const { service: svc, ingestor: created } = service(
        ingestion({ queueMaxRows: 2, batchMaxRows: 1_000, batchMaxDelayMs: 60_000 }),
      );
      const result = (key: string): CheckResult => ({
        sensorId,
        at: AT.toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [{ key, value: 1 }],
      });

      const held = svc.acceptResults('probe-1', {
        type: 'results',
        batchId: 'held',
        results: [result('a'), result('b')],
      });
      // **Waited for rather than assumed, which is what `P-23` was filed for.** Both calls
      // resolve channels against the database before they reach the queue, and nothing makes
      // the first of them win that race. When the second got the slot instead, the assertion
      // below read `results-ack` — and the test took *sixty seconds* getting there, because an
      // accepted batch of one row waits out `batchMaxDelayMs` before it is written. A test
      // whose failure mode is a minute of silence is one people stop waiting for.
      await until(() => created.stats().queuedRows === 2, 'the first batch to fill the queue');

      const refused = await svc.acceptResults('probe-1', {
        type: 'results',
        batchId: 'refused',
        results: [result('c')],
      });

      assert.equal(refused.type, 'results-nack');
      assert.equal(refused.reason, 'queue-full');
      assert.ok(refused.retryAfterMs > 0);
      await created.stop();
      await held;
    });
  },
);

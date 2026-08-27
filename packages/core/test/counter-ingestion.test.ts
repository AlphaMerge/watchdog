import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckResult } from '@ms/shared';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

const T0 = new Date('2026-08-27T10:00:00.000Z');
const at = (secondsLater: number): string =>
  new Date(T0.getTime() + secondsLater * 1_000).toISOString();

describe(
  'counter channels through ingestion (`T-02`)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let sensorId: number;
    let service: IngestionService;

    before(async () => {
      scratch = await createScratchDatabase('counters');
      db = scratch.db;
      const harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Counter probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'router',
        host: '192.0.2.30',
      });
      // The test catalogue's SNMP type, whose `in` channel is declared a 64-bit counter.
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'eth0',
        sensorType: 'snmp.traffic',
        params: {},
      });
      sensorId = sensor.id;

      service = new IngestionService({
        db,
        logger: silent,
        ingestor: new Ingestor({
          db,
          logger: silent,
          config: {
            queueMaxRows: 200_000,
            batchMaxRows: 5_000,
            // Short, because every test here wants the write to have happened by the time it
            // looks for it.
            batchMaxDelayMs: 5,
            slowDownAtPercent: 50,
            retryAfterMs: 1_000,
            replay: {
              maxConcurrentProbes: 4,
              stepMs: 250,
              maxDelayMs: 30_000,
              idleAfterMs: 30_000,
            },
          },
        }),
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query(
        `SELECT drop_chunks('sample'::regclass, older_than => 'infinity'::timestamptz)`,
      );
      await db.query('DELETE FROM channel_counter');
    });

    /** One scan reporting a raw counter, the way `snmp.traffic` does. */
    function scan(counter: bigint, secondsLater: number, bits?: 32 | 64): CheckResult {
      return {
        sensorId,
        at: at(secondsLater),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [
          {
            key: 'in',
            value: Number(counter),
            counter: counter.toString(),
            ...(bits === undefined ? {} : { counterBits: bits }),
          },
        ],
      };
    }

    async function submit(...results: CheckResult[]): Promise<void> {
      await service.acceptResults('probe-1', {
        type: 'results',
        batchId: `b-${String(process.hrtime.bigint())}`,
        results,
      });
      // The ingestor batches on a timer; every assertion here is about what reached the table.
      await settle();
    }

    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

    async function storedRates(): Promise<number[]> {
      const rows = await db.query<{ value: number }>(
        `SELECT s.value FROM sample s
         JOIN channel c ON c.id = s.channel_id
         WHERE c.sensor_id = $1 AND c.key = 'in'
         ORDER BY s.time`,
        [sensorId],
      );
      return rows.map((row: { value: number }) => row.value);
    }

    async function baseline(): Promise<{ value: string; at: Date } | null> {
      const rows = await db.query<{ last_value: string; last_at: Date }>(
        `SELECT cc.last_value::text AS last_value, cc.last_at
         FROM channel_counter cc
         JOIN channel c ON c.id = cc.channel_id
         WHERE c.sensor_id = $1 AND c.key = 'in'`,
        [sensorId],
      );
      const row = rows[0];
      return row === undefined ? null : { value: row.last_value, at: row.last_at };
    }

    it('stores a rate, not the counter', async () => {
      // 6,000 octets over 60 seconds is 100 a second. Storing the counter instead would draw a
      // line that only ever goes up and a limit nobody can set.
      await submit(scan(1_000n, 0));
      await submit(scan(7_000n, 60));
      assert.deepEqual(await storedRates(), [100]);
    });

    it('stores nothing for the first reading', async () => {
      // A gap, deliberately: there is nothing to subtract, and the counter itself would be one
      // enormous point at the start of every new sensor.
      await submit(scan(1_000n, 0));
      assert.deepEqual(await storedRates(), []);
    });

    it('keeps the baseline even when it stored nothing', async () => {
      // The failure this prevents: if a first reading did not move the baseline, the second
      // would also be a "first", and the sensor would never produce a sample at all.
      await submit(scan(1_000n, 0));
      assert.equal((await baseline())?.value, '1000');
    });

    it('is exact past 2^53, where a double would have rounded the delta away', async () => {
      // The transported value is text for exactly this. `ifHCInOctets` reaches here in about
      // nine days on a 100 Gbit/s link.
      const base = 1n << 54n;
      await submit(scan(base, 0));
      await submit(scan(base + 1_000n, 10));
      assert.deepEqual(await storedRates(), [100]);
    });

    it('records a gap rather than a spike when a 64-bit counter goes backwards', async () => {
      // A device that rebooted. "Correcting for the wrap" would store roughly 1.8e19 and dwarf
      // the axis for the whole retention window.
      await submit(scan(5_000_000n, 0));
      await submit(scan(1_000n, 60));
      assert.deepEqual(await storedRates(), []);
      assert.equal((await baseline())?.value, '1000', 'and re-baselines, so the next scan works');
    });

    it('recovers on the scan after a reset', async () => {
      await submit(scan(5_000_000n, 0));
      await submit(scan(1_000n, 60));
      await submit(scan(7_000n, 120));
      assert.deepEqual(await storedRates(), [100]);
    });

    it('treats a 32-bit counter going backwards as a wrap, when the reading says it is 32-bit', async () => {
      // The channel was declared 64-bit by the type; the *reading* says the device only offered
      // 32-bit counters. Reading it as 64-bit would make every wrap a gap — on a gigabit link,
      // every thirty-four seconds.
      const nearTop = (1n << 32n) - 1_000n;
      await submit(scan(nearTop, 0, 32));
      await submit(scan(2_000n, 30, 32));
      assert.deepEqual(await storedRates(), [100]);
    });

    it('would have called that same wrap a reset without the width on the reading', async () => {
      // The control for the test above: identical counters, no `counterBits`, so the channel's
      // declared 64 is used and the wrap reads as a device reboot.
      const nearTop = (1n << 32n) - 1_000n;
      await submit(scan(nearTop, 0));
      await submit(scan(2_000n, 30));
      assert.deepEqual(await storedRates(), []);
    });

    it('does not move the baseline backwards when a spooled batch arrives late', async () => {
      // Real: a probe drains its spool after an outage, so a batch can carry a reading older
      // than one already stored. Taking it would make the next delta enormous.
      await submit(scan(1_000n, 0));
      await submit(scan(7_000n, 60));
      await submit(scan(4_000n, 30));
      assert.equal((await baseline())?.value, '7000');
      assert.equal((await baseline())?.at.toISOString(), at(60));
    });

    it('reports a zero rate for an idle interface, which is a measurement', async () => {
      // The one case where zero is the truth rather than an absence: the link really is
      // carrying nothing.
      await submit(scan(5_000n, 0));
      await submit(scan(5_000n, 60));
      assert.deepEqual(await storedRates(), [0]);
    });

    it('counts why a counter produced no sample', async () => {
      // "The graph has holes in it" has three very different causes, and only these numbers
      // separate a new sensor from a rebooting device from a monitoring outage.
      const before = service.stats();
      await submit(scan(1_000n, 0));
      await submit(scan(500n, 60));
      const after = service.stats();
      assert.equal(after.counterFirst - before.counterFirst, 1);
      assert.equal(after.counterReset - before.counterReset, 1);
    });

    it('leaves a non-counter channel alone', async () => {
      // `status` is declared without `counter`, so its value is stored as it arrived.
      await service.acceptResults('probe-1', {
        type: 'results',
        batchId: `b-${String(process.hrtime.bigint())}`,
        results: [
          {
            sensorId,
            at: at(0),
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [{ key: 'status', value: 1 }],
          },
        ],
      });
      await settle();
      const rows = await db.query<{ value: number }>(
        `SELECT s.value FROM sample s JOIN channel c ON c.id = s.channel_id
         WHERE c.sensor_id = $1 AND c.key = 'status'`,
        [sensorId],
      );
      assert.deepEqual(
        rows.map((row: { value: number }) => row.value),
        [1],
      );
    });
  },
);

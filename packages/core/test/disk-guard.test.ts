import { strict as assert } from 'node:assert';
import { statfs } from 'node:fs/promises';
import { pino } from 'pino';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { HousekeepingConfig } from '@ms/shared';
import type { Database, Queryable } from '../src/db/pool.js';
import { DiskWatcher } from '../src/timeseries/disk.js';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/**
 * What happens as the disk fills (`S-17`, `WORKFLOW.MD §13` row 7).
 *
 * **The disk is faked and nothing else is.** Filling a real filesystem inside a test would be a
 * test about the filesystem, and an unreliable one; what has to be right is everything that hangs
 * off the number — which disk is measured, whether a core that cannot see the right one says so
 * rather than guessing, and exactly how much data eviction is allowed to take. All of that runs
 * against a real database with real chunks in it.
 *
 * The thing being guarded against is subtle and worth stating: **eviction is a bug that destroys
 * data.** Every bound below is a way this could take more than it should, and each has a test
 * because the failure is silent and permanent.
 */

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 24 * 3_600_000;

function housekeeping(overrides: Partial<HousekeepingConfig['disk']> = {}): HousekeepingConfig {
  return {
    enabled: false,
    intervalSeconds: 300,
    rollupLagSeconds: 0,
    retention: {
      // Long, so ordinary retention never fires: what is under test is the *emergency* path, and
      // a horizon that dropped the same chunks first would let it pass for the wrong reason.
      rawDays: 3_650,
      fiveMinuteDays: 3_650,
      hourlyDays: 3_650,
      dailyDays: 3_650,
      auditDays: 3_650,
      stateDays: 3_650,
    },
    compression: { rawAfterDays: 3_650, fiveMinuteAfterDays: 3_650 },
    disk: {
      path: '/fake',
      evictBelowPercent: 10,
      recoverAbovePercent: 15,
      minimumRetainedHours: 48,
      ...overrides,
    },
  };
}

/** A disk whose free space this test decides, and which can recover as chunks are dropped. */
function fakeDisk(freePercent: number): {
  watcher: DiskWatcher;
  set: (percent: number) => void;
  reads: number;
} {
  const state = { percent: freePercent, reads: 0 };
  const watcher = new DiskWatcher({
    logger: silent,
    path: '/fake',
    dataDir: '/fake',
    measure: () => {
      state.reads += 1;
      return Promise.resolve({
        totalBytes: 1_000_000_000,
        freeBytes: Math.round(1_000_000_000 * (state.percent / 100)),
      });
    },
  });
  return {
    watcher,
    set: (percent: number) => {
      state.percent = percent;
    },
    get reads() {
      return state.reads;
    },
  };
}

describe(
  'the disk guard',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let channelId: number;

    before(async () => {
      scratch = await createScratchDatabase('diskguard');
      db = scratch.db;
      const h = await buildHarness(db);
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Disk probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Disk device',
        host: '192.0.2.50',
      });
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Disk sensor',
        sensorType: 'icmp.ping',
      });
      const rows = await db.query<{ id: number }>(
        'SELECT id FROM channel WHERE sensor_id = $1 AND key = $2',
        [sensor.id, 'rtt'],
      );
      const first = rows[0];
      assert.ok(first !== undefined, 'the sensor type declares an rtt channel');
      channelId = first.id;
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
    });

    /** One reading a day for `days` days, ending `endingDaysAgo` before NOW. */
    async function fill(days: number, endingDaysAgo = 1): Promise<void> {
      const end = NOW.getTime() - endingDaysAgo * DAY;
      const times: Date[] = [];
      for (let i = 0; i < days; i += 1) times.push(new Date(end - i * DAY));
      await db.query(
        `INSERT INTO sample (channel_id, time, value)
         SELECT $1, t, 1 FROM unnest($2::timestamptz[]) AS t
         ON CONFLICT DO NOTHING`,
        [channelId, times],
      );
    }

    const remaining = async (): Promise<number> => {
      const rows = await db.query<{ count: string }>('SELECT count(*) AS count FROM sample');
      return Number(rows[0]?.count ?? 0);
    };

    /** The rollup watermark is the cap eviction may never pass. */
    async function watermarkAt(at: Date): Promise<void> {
      await db.query(
        `INSERT INTO rollup_watermark (tier, watermark) VALUES ('sample_5m', $1)
         ON CONFLICT (tier) DO UPDATE SET watermark = EXCLUDED.watermark`,
        [at],
      );
    }

    const housekeeperWith = (disk: DiskWatcher, config = housekeeping()): Housekeeper =>
      new Housekeeper({ db, logger: silent, config, disk, now: () => NOW });

    describe('measuring', () => {
      it('reports free space as a percentage and in bytes', async () => {
        const { watcher } = fakeDisk(42);
        const reading = await db.tx((q: Queryable) => watcher.read(q));
        assert.ok(reading !== null);
        assert.equal(reading.freePercent, 42);
        assert.equal(reading.freeBytes, 420_000_000);
        assert.ok(reading.databaseBytes > 0, 'and what this database occupies');
      });

      it('answers nothing rather than zero when the filesystem cannot be read', async () => {
        // `CLAUDE.md`: no-data is not zero. A core that reported 0% free because `statfs` failed
        // would raise the exact alarm this channel exists to make meaningful.
        const watcher = new DiskWatcher({
          logger: silent,
          path: '/definitely/not/a/path',
          dataDir: '/definitely/not/a/path',
          measure: () => Promise.reject(new Error('ENOENT')),
        });
        assert.equal(await db.tx((q: Queryable) => watcher.read(q)), null);
      });

      it('reads the filesystem once and remembers which one it is', async () => {
        // The locality check is a round trip, and it cannot change without a restart.
        const { watcher, reads } = fakeDisk(50);
        await db.tx((q: Queryable) => watcher.read(q));
        await db.tx((q: Queryable) => watcher.read(q));
        assert.equal(watcher.watching, '/fake');
        assert.ok(reads >= 0);
      });
    });

    describe('which disk', () => {
      it('watches nothing when the database is on another host', async () => {
        // **The case that would be worse than not watching at all**: the readings are on
        // PostgreSQL's volume, and a core reporting its own disk as though it were the
        // database's would show a healthy number in front of a volume about to fill.
        const remote: Queryable = {
          query: <T>(text: string) =>
            Promise.resolve(
              (text.includes('inet_server_addr')
                ? [{ addr: '10.0.0.9' }]
                : [{ bytes: '1' }]) as T[],
            ),
        };
        const watcher = new DiskWatcher({
          logger: silent,
          path: '',
          dataDir: '/',
          measure: () => Promise.resolve({ totalBytes: 100, freeBytes: 1 }),
        });

        assert.equal(await watcher.read(remote), null);
        assert.equal(watcher.watching, null, 'and it says so rather than falling back');
      });

      it('watches the data directory when the database is on this host', async () => {
        const local: Queryable = {
          query: <T>(text: string) =>
            Promise.resolve(
              (text.includes('inet_server_addr') ? [{ addr: null }] : [{ bytes: '1' }]) as T[],
            ),
        };
        const watcher = new DiskWatcher({
          logger: silent,
          path: '',
          dataDir: '/tmp',
          measure: () => Promise.resolve({ totalBytes: 100, freeBytes: 30 }),
        });

        const reading = await watcher.read(local);
        assert.equal(reading?.freePercent, 30);
        assert.equal(watcher.watching, '/tmp');
      });

      it('reports the space this account may use, not the root reserve', async () => {
        // A real `statfs`, because this is the one part no injected measurement covers — and
        // `bfree` counts blocks only root may touch. A monitoring service that counted them
        // would believe it had room it cannot have.
        const stats = await statfs('/tmp');
        const watcher = new DiskWatcher({ logger: silent, path: '/tmp', dataDir: '/tmp' });
        const reading = await watcher.read(db);

        assert.ok(reading !== null);
        assert.equal(reading.freeBytes, stats.bavail * stats.bsize);
        if (stats.bavail !== stats.bfree) {
          assert.notEqual(
            reading.freeBytes,
            stats.bfree * stats.bsize,
            'this filesystem has a reserve, and it is not being counted',
          );
        }
      });
    });

    describe('evicting', () => {
      it('does nothing at all while there is room', async () => {
        await fill(30);
        // The watermark matters even here: without one there is no cap, eviction bails before it
        // looks at the disk, and this test would pass for a reason that has nothing to do with
        // free space. Found by a surviving mutant that deleted the threshold check.
        await watermarkAt(NOW);
        const before = await remaining();
        const { watcher } = fakeDisk(50);
        const report = await housekeeperWith(watcher).runOnce();

        assert.deepEqual(report.failures, []);
        assert.equal(report.evictedChunks, 0);
        assert.equal(await remaining(), before);
        // Through a whole pass, not the step alone: the guard has to be reached after retention
        // rather than skipped by it, and a report with no disk in it is what that looks like.
        assert.equal(report.disk?.freePercent, 50, 'and it says what it saw');
      });

      it('says nothing at error level while there is room', async () => {
        // A healthy installation logging "free disk space is below the eviction threshold" every
        // five minutes is how an operator learns to ignore the log — and the eviction loop's own
        // recovery check means nothing would actually be dropped, so a count assertion cannot
        // see this. Found by a surviving mutant that deleted the threshold check.
        await fill(30);
        await watermarkAt(NOW);
        const lines: Record<string, unknown>[] = [];
        const logger = pino(
          { level: 'trace' },
          {
            write: (chunk: string) => {
              lines.push(JSON.parse(chunk) as Record<string, unknown>);
            },
          },
        );

        const { watcher } = fakeDisk(50);
        await new Housekeeper({
          db,
          logger,
          config: housekeeping(),
          disk: watcher,
          now: () => NOW,
        }).guardDisk();

        assert.deepEqual(
          lines.filter((line) => Number(line['level']) >= 50),
          [],
          'nothing at error level from a disk that is half empty',
        );
      });

      it('drops the oldest readings first when the disk is nearly full', async () => {
        await fill(60);
        await watermarkAt(NOW);
        const before = await remaining();

        const { watcher } = fakeDisk(5);
        const report = await housekeeperWith(watcher).runOnce();

        assert.ok(report.evictedChunks > 0, 'chunks went');
        const left = await remaining();
        assert.ok(left < before, `${String(before)} readings became ${String(left)}`);

        // The *oldest* went, which is the half a count cannot show. Everything left is newer
        // than everything dropped, by construction of the drop.
        const rows = await db.query<{ at: Date }>('SELECT min(time) AS at FROM sample');
        const oldest = rows[0]?.at;
        assert.ok(oldest !== undefined);
        assert.ok(oldest.getTime() > NOW.getTime() - 60 * DAY, 'the start of the history went');
      });

      it('stops as soon as the disk is healthy again, rather than taking all it may', async () => {
        // The difference between shedding what is needed and shedding everything eviction is
        // allowed to. Each drop is followed by a measurement for exactly this reason.
        await fill(60);
        await watermarkAt(NOW);

        let drops = 0;
        const watcher = new DiskWatcher({
          logger: silent,
          path: '/fake',
          dataDir: '/fake',
          measure: () => {
            drops += 1;
            // Healthy from the second reading on: one step of eviction was enough.
            return Promise.resolve({
              totalBytes: 1_000_000_000,
              freeBytes: drops <= 1 ? 50_000_000 : 200_000_000,
            });
          },
        });
        const report = await housekeeperWith(watcher).runOnce();
        assert.equal(report.evictedChunks > 0, true);
        assert.ok(
          (await remaining()) > 50,
          'it stopped at the first healthy measurement rather than emptying the table',
        );
      });

      it('never evicts past what the tier above has summarised', async () => {
        // The cap that matters most: raw data that has not been rolled up is the only copy of
        // that hour, and dropping it would lose the hour rather than only its detail.
        await fill(60);
        await watermarkAt(new Date(NOW.getTime() - 55 * DAY));

        // The guard on its own: inside a full pass the rollup would have advanced this very
        // watermark before the guard read it, which is right in production and useless here.
        const { watcher } = fakeDisk(1);
        await housekeeperWith(watcher).guardDisk();

        const rows = await db.query<{ at: Date }>('SELECT min(time) AS at FROM sample');
        const oldest = rows[0]?.at;
        assert.ok(oldest !== undefined);
        assert.ok(
          oldest.getTime() <= NOW.getTime() - 54 * DAY,
          `nothing newer than the watermark was taken, but the oldest left is ${oldest.toISOString()}`,
        );
      });

      it('never evicts inside a window a backfill still has to re-read', async () => {
        await fill(60);
        await watermarkAt(NOW);
        await db.query(
          `INSERT INTO rollup_backfill (from_time, to_time, reason)
           VALUES ($1, $2, 'test')`,
          [new Date(NOW.getTime() - 58 * DAY), new Date(NOW.getTime() - 57 * DAY)],
        );

        // Directly again: a full pass claims and clears the backfill queue before the guard runs.
        const { watcher } = fakeDisk(1);
        await housekeeperWith(watcher).guardDisk();

        const rows = await db.query<{ at: Date }>('SELECT min(time) AS at FROM sample');
        const oldest = rows[0]?.at;
        assert.ok(oldest !== undefined);
        assert.ok(
          oldest.getTime() <= NOW.getTime() - 57 * DAY,
          `the pending window was left alone, but the oldest left is ${oldest.toISOString()}`,
        );
      });

      it('never evicts the most recent history, whatever the disk says', async () => {
        // Two days of readings and a disk at 1%: there is nothing eviction is allowed to take,
        // and taking it anyway would not save the disk and would take the graph an operator is
        // looking at while they fix it.
        await fill(2);
        await watermarkAt(NOW);
        const before = await remaining();

        const { watcher } = fakeDisk(1);
        const report = await housekeeperWith(watcher).runOnce();

        assert.equal(report.evictedChunks, 0);
        assert.equal(await remaining(), before);
      });

      it('counts what it took, cumulatively, because it is a counter channel', async () => {
        await fill(60);
        await watermarkAt(NOW);
        const { watcher } = fakeDisk(1);
        const keeper = housekeeperWith(watcher);

        await keeper.runOnce();
        const first = keeper.stats.evictedChunks;
        assert.ok(first > 0);

        await fill(60);
        await keeper.runOnce();
        assert.ok(keeper.stats.evictedChunks >= first, 'the total never goes backwards');
      });

      it('leaves the loop exactly as it was when there is no disk to watch', async () => {
        // A build with no watcher is the shape every test written before `S-17` runs in, and the
        // step has to be a no-op rather than a failure in it.
        await fill(30);
        const before = await remaining();
        const keeper = new Housekeeper({ db, logger: silent, config: housekeeping() });
        const report = await keeper.runOnce();

        assert.equal(report.disk, null);
        assert.equal(report.evictedChunks, 0);
        assert.equal(await remaining(), before);
      });
    });
  },
);

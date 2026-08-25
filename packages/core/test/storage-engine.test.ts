import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import {
  TimescaleEngine,
  type EngineCapabilities,
  type StorageEngine,
} from '../src/timeseries/engine.js';
import { alignDown } from '../src/timeseries/housekeeper.js';
import { SqlTimeSeriesStore } from '../src/timeseries/store.js';
import { ROLLUP_TIERS, tierById } from '../src/timeseries/tiers.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { silent } from './support/tree.js';

const available = await databaseAvailable();

/**
 * A second engine, built only to prove the seam is real (S-12).
 *
 * `date_bin` has been in core PostgreSQL since 14 and takes an explicit origin, so anchoring it
 * at the Unix epoch should reproduce `time_bucket` exactly for the widths we use. "Should" is
 * why this exists: an interface with one implementation is an assertion, and `ADR-001` Decision
 * 4 promised a contained fallback rather than a hopeful one.
 *
 * The chunk-lifecycle methods throw. That is honest — they need declarative partitioning, which
 * is `S-11`'s decision to make — and it keeps this from looking like a shippable engine.
 */
class DateBinEngine implements StorageEngine {
  readonly name = 'postgres';

  bucket(intervalParam: string, at: string): string {
    return `date_bin(${intervalParam}::interval, ${at}, TIMESTAMPTZ 'epoch')`;
  }

  check(): Promise<EngineCapabilities> {
    return Promise.resolve({ engine: this.name, version: null, compaction: false });
  }

  compactableChunks(): Promise<string[]> {
    throw new Error('not implemented: needs declarative partitioning (S-11)');
  }

  compact(): Promise<void> {
    throw new Error('not implemented: plain PostgreSQL has no columnar storage');
  }

  dropOlderThan(): Promise<string[]> {
    throw new Error('not implemented: needs declarative partitioning (S-11)');
  }
}

/**
 * No file outside these may name an engine-specific function.
 *
 * The migrations are the documented exception, and the reason is worth remembering: they are
 * checksummed to detect drift, so parameterising their SQL by engine would make the checksum
 * depend on the engine. A fallback needs its own migration list, selected at start-up.
 */
const ENGINE_SPECIFIC_FILES = [
  'timeseries/engine.ts',
  'db/migrations/003-timeseries.ts',
  'db/migrations/004-rollups.ts',
];

const ENGINE_TOKENS = [
  'time_bucket',
  'create_hypertable',
  'drop_chunks',
  'show_chunks',
  'compress_chunk',
  'decompress_chunk',
  'hypertable_size',
  'timescaledb',
];

describe('storage engine boundary', () => {
  it('names an engine-specific function in no file but the engine and its migrations', async () => {
    // At runtime this file is <package>/dist/test/storage-engine.test.js.
    const root = join(import.meta.dirname, '..', '..', 'src');
    const offenders: string[] = [];

    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), relative);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (ENGINE_SPECIFIC_FILES.includes(relative)) continue;

        const text = await readFile(join(directory, entry.name), 'utf8');
        for (const token of ENGINE_TOKENS) {
          if (text.includes(token)) offenders.push(`${relative}: ${token}`);
        }
      }
    };
    await walk(root, '');

    assert.deepEqual(
      offenders,
      [],
      'time-series access must go through the store, and engine-specific SQL through ' +
        `StorageEngine (CLAUDE.md, S-12):\n  ${offenders.join('\n  ')}`,
    );
  });
});

describe(
  'storage engine',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('engine');
      db = scratch.db;
      await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      for (const table of ['sample', 'sample_5m', 'sample_1h', 'sample_1d']) {
        await db.query(`SELECT drop_chunks($1::regclass, older_than => 'infinity'::timestamptz)`, [
          table,
        ]);
      }
      await db.query('DELETE FROM rollup_watermark');
    });

    it('reports what the engine is and whether it can compact', async () => {
      const capabilities = await new SqlTimeSeriesStore().capabilities(db);
      assert.equal(capabilities.engine, 'timescaledb');
      assert.ok(capabilities.version);
      assert.equal(
        capabilities.compaction,
        true,
        'the dev database runs the Community licence, so compression is available',
      );
    });

    it('buckets identically to the in-core substitute', async () => {
      // The crux of whether a fallback is possible at all. If these two disagreed by so much as
      // a second, every rollup written by one engine would be unreadable by the other.
      const probes = [
        '2026-08-25T13:47:29.512Z',
        '1970-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-03-29T02:30:00.000Z', // a European DST transition
        '2026-12-31T23:59:59.999Z',
      ];
      const timescale = new TimescaleEngine();
      const plain = new DateBinEngine();

      for (const tier of ROLLUP_TIERS) {
        for (const probe of probes) {
          const rows = await db.query<{ a: Date; b: Date }>(
            `SELECT ${timescale.bucket('$1', '$2::timestamptz')} AS a,
                    ${plain.bucket('$1', '$2::timestamptz')} AS b`,
            [tier.bucket, probe],
          );
          const a = rows[0]?.a;
          const b = rows[0]?.b;
          assert.ok(a && b);
          assert.equal(a.toISOString(), b.toISOString(), `${tier.id} disagreed at ${probe}`);
          // And both agree with the arithmetic the housekeeper slices time with.
          assert.equal(
            alignDown(new Date(probe), tier.bucketSeconds).toISOString(),
            a.toISOString(),
          );
        }
      }
    });

    it('rolls up and reads back the same numbers whichever engine buckets them', async () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      const readings = [
        [base, 10],
        [new Date(base.getTime() + 60_000), 20],
        [new Date(base.getTime() + 120_000), 30],
        [new Date(base.getTime() + 600_000), 100],
      ] as const;
      await db.query(
        `INSERT INTO sample (time, channel_id, value)
         SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::float8[])`,
        [readings.map((r) => r[0]), readings.map(() => 4_242), readings.map((r) => r[1])],
      );

      const to = new Date(base.getTime() + 3_600_000);
      const read = async (engine: StorageEngine) => {
        const store = new SqlTimeSeriesStore(engine);
        await db.query('DELETE FROM sample_5m');
        await db.tx((q: Queryable) => store.rollUp(q, tierById('sample_5m'), base, to));
        return db.tx((q: Queryable) =>
          store.readSeries(q, {
            channelIds: [4_242],
            segments: [{ table: 'sample_5m', from: base, to }],
            bucketSeconds: 300,
          }),
        );
      };

      const viaTimescale = await read(new TimescaleEngine());
      const viaPlain = await read(new DateBinEngine());

      assert.ok(viaTimescale.length > 0);
      assert.deepEqual(
        viaPlain.map((row) => [row.bucket.toISOString(), row.count, row.sum, row.min, row.max]),
        viaTimescale.map((row) => [row.bucket.toISOString(), row.count, row.sum, row.min, row.max]),
        'the same store, a different engine, the same answer',
      );
      // And the answer is the hand-computed one, not merely self-consistent.
      assert.deepEqual(
        viaPlain.map((row) => [row.count, row.sum]),
        [
          [3, 60],
          [1, 100],
        ],
      );
    });
  },
);

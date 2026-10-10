import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Logger } from '@ms/shared';
import { logIfUnexpected, toHttpError } from '../src/api/errors.js';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { DatabaseError, uniqueViolation, type Database } from '../src/db/pool.js';
import {
  refusingTaken,
  UNIQUE_CONSTRAINTS,
  type UniqueRule,
} from '../src/db/unique-constraints.js';
import { ObjectError } from '../src/objects/errors.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';

/**
 * Every unique rule in the schema says what a caller who breaks it hears (`P-391`).
 *
 * `P-386` found `probe_config_gid_unique` answering a route with PostgreSQL's sentence, which names
 * an index and not the object in the way, and the sweep after it found four more doing the same.
 * `db/unique-constraints.ts` now lists each rule as refused by its service, or unreachable and why.
 * This holds the list to the schema: a migration that adds a unique constraint or index fails here
 * until it is listed, so whoever adds one decides what a caller who breaks it is told.
 */

const available = await databaseAvailable();

/** A 23505 as the pool hands it on: PostgreSQL's error inside a `DatabaseError`. */
function duplicate(constraint?: string): DatabaseError {
  return new DatabaseError('query failed', {
    context: { phase: 'test' },
    cause: Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraint ?? '?'}"`),
      { code: '23505', ...(constraint === undefined ? {} : { constraint }) },
    ),
  });
}

describe(
  'unique constraints, against the schema',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('uniques');
      db = scratch.db;
      await new Migrator({ db, logger: silentLogger, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    it('lists every unique constraint and index the schema has, and none it does not', async () => {
      // Unique indexes, which every unique and primary-key constraint is backed by, in the schema
      // the core writes: TimescaleDB's own catalogue and its chunks are not ours to answer for.
      const rows = await db.query<{ name: string; tbl: string }>(
        `SELECT i.relname AS name, c.relname AS tbl
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE x.indisunique AND n.nspname = 'public'
       ORDER BY i.relname`,
      );
      const inSchema = new Set(rows.map((row) => row.name));
      const listed = new Set(Object.keys(UNIQUE_CONSTRAINTS));

      const unlisted = rows
        .filter((row) => !listed.has(row.name))
        .map((row) => `${row.name} (${row.tbl})`);
      assert.deepEqual(
        unlisted,
        [],
        'a unique rule nobody has said a caller can or cannot break: add each to ' +
          'UNIQUE_CONSTRAINTS in src/db/unique-constraints.ts, refused with a sentence naming what ' +
          'is in the way, or unreachable with the reason',
      );
      const stale = [...listed].filter((name) => !inSchema.has(name));
      assert.deepEqual(stale, [], 'listed in UNIQUE_CONSTRAINTS but no longer in the schema');
    });

    describe('refusingTaken', () => {
      before(async () => {
        // Its own schema, so the catalogue above never reads it, whichever runs first.
        await db.query('CREATE SCHEMA p391');
        await db.query('CREATE TABLE p391.refused_here (name text UNIQUE)');
      });

      const taken = new Error('taken');

      it('refuses before the write when something is in the way, and writes nothing', async () => {
        await db.query('DELETE FROM p391.refused_here');
        await db.query("INSERT INTO p391.refused_here VALUES ('a')");
        let wrote = false;
        await assert.rejects(
          () =>
            db.tx((q) =>
              refusingTaken(
                q,
                'notification_template_name_key',
                () => Promise.resolve(taken),
                () => {
                  wrote = true;
                  return Promise.resolve();
                },
              ),
            ),
          (error: unknown) => error === taken,
        );
        assert.equal(wrote, false);
      });

      it('asks again when the constraint refuses, and the transaction is still readable', async () => {
        await db.query('DELETE FROM p391.refused_here');
        await db.query("INSERT INTO p391.refused_here VALUES ('a')");
        // Nothing in the way the first time, as when the other row is committed after the look.
        let asked = 0;
        const answer = await db
          .tx(async (q) => {
            await refusingTaken(
              q,
              // Any listed name: the write below breaks it, as its own constraint would.
              'refused_here_name_key' as 'notification_template_name_key',
              async (inner) => {
                asked += 1;
                const rows = await inner.query('SELECT 1 FROM p391.refused_here');
                return asked === 1 || rows.length === 0 ? null : taken;
              },
              (inner) => inner.query("INSERT INTO p391.refused_here VALUES ('a')"),
            );
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        assert.equal(answer, taken);
        assert.equal(asked, 2);
      });

      it('lets any other failure, and that one with nothing in the way, go out as it came', async () => {
        await db.query('DELETE FROM p391.refused_here');
        await db.query("INSERT INTO p391.refused_here VALUES ('a')");
        const other = await db
          .tx((q) =>
            refusingTaken(
              q,
              'schedule_name_key',
              () => Promise.resolve(null),
              (inner) => inner.query("INSERT INTO p391.refused_here VALUES ('a')"),
            ),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        assert.equal(uniqueViolation(other), 'refused_here_name_key', String(other));

        const nobody = await db
          .tx((q) =>
            refusingTaken(
              q,
              'refused_here_name_key' as 'schedule_name_key',
              () => Promise.resolve(null),
              (inner) => inner.query("INSERT INTO p391.refused_here VALUES ('a')"),
            ),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        assert.equal(uniqueViolation(nobody), 'refused_here_name_key', String(nobody));
      });
    });
  },
);

describe('the rules a route can break', () => {
  it('each name a refusal the source throws', async () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const texts: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts') && entry.name !== 'unique-constraints.ts') {
          texts.push(await readFile(path, 'utf8'));
        }
      }
    };
    await walk(root);
    const source = texts.join('\n');

    const missing: string[] = [];
    for (const [name, rule] of Object.entries(UNIQUE_CONSTRAINTS) as [string, UniqueRule][]) {
      if (!('refused' in rule)) continue;
      for (const code of rule.refused.split(',').map((one) => one.trim())) {
        if (!source.includes(`'${code}'`)) missing.push(`${name}: ${code}`);
      }
    }
    assert.deepEqual(missing, [], 'a refusal UNIQUE_CONSTRAINTS names that nothing throws');
  });
});

describe('a unique violation nothing answered (P-391)', () => {
  it('is a 409 that does not hand PostgreSQL’s sentence on', () => {
    const answer = toHttpError(duplicate('notification_template_name_key'));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error.code, 'OBJECT_INVALID');
    assert.equal(
      answer.body.error.message,
      'this change would duplicate something that must be unique; if somebody else was ' +
        'changing the same thing at the same moment, read it again and retry',
    );
    assert.ok(!JSON.stringify(answer.body).includes('duplicate key'), JSON.stringify(answer.body));
  });

  it('is logged as the bug it is, and a service’s own refusal is not', () => {
    const lines: { level: string; fields: unknown; message: string }[] = [];
    const logger = {
      error: (fields: unknown, message: string) => lines.push({ level: 'error', fields, message }),
      warn: (fields: unknown, message: string) => lines.push({ level: 'warn', fields, message }),
    } as unknown as Logger;

    logIfUnexpected(logger, duplicate('schedule_name_key'), 409);
    assert.equal(lines.length, 1);
    const line = lines.at(0);
    assert.ok(line !== undefined);
    assert.equal(line.level, 'error');
    assert.equal((line.fields as { constraint?: string }).constraint, 'schedule_name_key');

    logIfUnexpected(
      logger,
      new ObjectError('SCHEDULE_NAME_TAKEN', 'schedule 1 is already called A', { context: {} }),
      409,
    );
    assert.equal(lines.length, 1);
  });
});

describe('uniqueViolation', () => {
  it('reads the constraint through the pool’s wrapper, and nothing from anything else', () => {
    assert.equal(uniqueViolation(duplicate('api_token_name_idx')), 'api_token_name_idx');
    assert.equal(uniqueViolation(duplicate()), '');
    assert.equal(
      uniqueViolation(
        new DatabaseError('query failed', {
          cause: Object.assign(new Error('fk'), { code: '23503', constraint: 'x_fkey' }),
        }),
      ),
      null,
    );
    assert.equal(uniqueViolation(new Error('no')), null);
    assert.equal(uniqueViolation(undefined), null);
  });
});

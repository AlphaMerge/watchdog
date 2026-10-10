import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { ObjectError } from '../src/objects/errors.js';
import { builtInSchedules } from '../src/schedules/built-in.js';
import { ScheduleRepository, type ScheduleWrite } from '../src/schedules/repository.js';
import { ScheduleService, seedNames } from '../src/schedules/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { CapturingAuditSink } from './support/tree.js';

/**
 * A new built-in schedule whose name an operator's schedule already has (`P-393`).
 *
 * The seed inserted each built-in `ON CONFLICT (built_in_id) DO NOTHING`, which does not cover
 * `schedule_name_key`: a build that shipped a built-in called something an operator had already
 * called one of theirs raised 23505 at start-up, and the core did not start. The built-in is now
 * added under the next free name, and the operator's schedule is left as it was.
 */

const available = await databaseAvailable();

describe(
  'a built-in schedule whose name an operator has given one of theirs (P-393)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    const lines: string[] = [];
    let schedules: ScheduleService;

    // The one the tests stand in for: a built-in this build adds that the database has not seen.
    const builtIn = builtInSchedules().find((one) => one.id === 'weekends');
    assert.ok(builtIn !== undefined, 'the weekends built-in is the one these tests remove');
    const name = builtIn.name;

    /** An operator's schedule called `called`, with a definition copied from a built-in. */
    const operators = async (called: string): Promise<number> => {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO schedule (name, description, periods, polarity, authored_as, timezone)
         SELECT $1, 'an operator''s', periods, polarity, authored_as, timezone
         FROM schedule WHERE built_in_id = 'weekdays'
         RETURNING id::text AS id`,
        [called],
      );
      return Number(rows[0]?.id);
    };

    const scheduleRows = (): Promise<{ name: string; builtIn: string | null }[]> =>
      db.query<{ name: string; builtIn: string | null }>(
        `SELECT schedule.name, schedule.built_in_id AS "builtIn" FROM schedule
         WHERE schedule.name LIKE $1 ORDER BY schedule.name`,
        [`${name}%`],
      );

    before(async () => {
      scratch = await createScratchDatabase('schedule_seed');
      db = scratch.db;
      await new Migrator({ db, logger: silentLogger, migrations: MIGRATIONS }).up();
      schedules = new ScheduleService({
        db,
        audit: new CapturingAuditSink(),
        logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
      });
      await schedules.seedBuiltIns();
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      // As if this build were the first to ship it.
      await db.query('DELETE FROM schedule WHERE name LIKE $1', [`${name}%`]);
      lines.length = 0;
    });

    it('adds the built-in as "(built-in)", leaves the operator’s, and says so once', async () => {
      const theirs = await operators(name);

      assert.equal(await schedules.seedBuiltIns(), 1, 'the core starts, and adds the built-in');
      assert.deepEqual(await scheduleRows(), [
        { name, builtIn: null },
        { name: `${name} (built-in)`, builtIn: 'weekends' },
      ]);
      const kept = await db.query<{ description: string }>(
        'SELECT description FROM schedule WHERE id = $1',
        [theirs],
      );
      assert.equal(kept[0]?.description, "an operator's", 'the operator’s is as it was');

      const warned = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const said = warned.filter((line) => line['builtIn'] === 'weekends');
      assert.equal(said.length, 1, lines.join('\n'));
      const warning = said.at(0);
      assert.ok(warning !== undefined);
      assert.equal(warning['level'], 40);
      assert.equal(warning['heldBy'], theirs);
      assert.equal(warning['name'], `${name} (built-in)`);
      assert.match(String(warning['msg']), /either can be renamed/);

      assert.equal(await schedules.seedBuiltIns(), 0, 'and never adds it again');
      assert.equal((await scheduleRows()).length, 2);
    });

    it('takes the first free name when "(built-in)" is taken as well', async () => {
      await operators(name);
      await operators(`${name} (built-in)`);
      await operators(`${name} (built-in 2)`);

      assert.equal(await schedules.seedBuiltIns(), 1);
      const added = (await scheduleRows()).filter((row) => row.builtIn === 'weekends');
      assert.deepEqual(added, [{ name: `${name} (built-in 3)`, builtIn: 'weekends' }]);
    });

    it('takes the next name when the operator’s is committed after the look', async () => {
      // Committed from another connection between the seed's look and its insert, as a schedule
      // created through the API in that moment would be.
      let raced = false;
      class Racing extends ScheduleRepository {
        override async seed(
          q: Queryable,
          write: ScheduleWrite,
          builtInId: string,
        ): Promise<boolean> {
          if (!raced && builtInId === 'weekends') {
            raced = true;
            await operators(write.name);
          }
          return super.seed(q, write, builtInId);
        }
      }
      const racing = new ScheduleService({
        db,
        audit: new CapturingAuditSink(),
        logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
        repository: new Racing(),
      });

      assert.equal(await racing.seedBuiltIns(), 1);
      assert.ok(raced);
      assert.deepEqual(await scheduleRows(), [
        { name, builtIn: null },
        { name: `${name} (built-in)`, builtIn: 'weekends' },
      ]);
    });

    it('a built-in renamed by an operator is not added again under its name', async () => {
      await schedules.seedBuiltIns();
      await db.query("UPDATE schedule SET name = 'Our weekends' WHERE built_in_id = 'weekends'");
      try {
        assert.equal(await schedules.seedBuiltIns(), 0);
        assert.deepEqual(await scheduleRows(), []);
        assert.equal(lines.filter((line) => line.includes('"builtIn"')).length, 0);
      } finally {
        await db.query("DELETE FROM schedule WHERE built_in_id = 'weekends'");
      }
    });

    it('a built-in already there is not refused for the names it would have taken', async () => {
      await schedules.seedBuiltIns();
      for (const one of seedNames(name).slice(1)) await operators(one);

      assert.equal(await schedules.seedBuiltIns(), 0);
      const seeded = (await scheduleRows()).filter((row) => row.builtIn === 'weekends');
      assert.deepEqual(seeded, [{ name, builtIn: 'weekends' }]);
    });

    it('refuses with a sentence naming the schedule to rename when every name is taken', async () => {
      const ids: number[] = [];
      for (const one of seedNames(name)) ids.push(await operators(one));
      const before = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM schedule');

      await assert.rejects(
        () => schedules.seedBuiltIns(),
        (error: unknown) => {
          assert.ok(error instanceof ObjectError, String(error));
          assert.equal(error.code, 'SCHEDULE_NAME_TAKEN');
          assert.match(
            error.message,
            new RegExp(`Rename schedule ${String(ids[0])} and start the core again`),
          );
          assert.ok(!error.message.includes('duplicate key'), error.message);
          return true;
        },
      );
      const afterwards = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM schedule');
      assert.deepEqual(afterwards, before, 'nothing else the seed would add was added');
    });
  },
);

describe('the names a built-in is added under (P-393)', () => {
  it('are its own, then "(built-in)", then numbered from 2, ten in all', () => {
    const names = seedNames('Weekends');
    assert.equal(names.length, 10);
    assert.deepEqual(names.slice(0, 3), [
      'Weekends',
      'Weekends (built-in)',
      'Weekends (built-in 2)',
    ]);
    assert.equal(names.at(-1), 'Weekends (built-in 9)');
    assert.equal(new Set(names).size, names.length);
  });
});

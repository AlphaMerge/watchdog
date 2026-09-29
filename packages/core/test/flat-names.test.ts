import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Actor, AuditSink, Mutation } from '../src/objects/audit.js';
import type { FlatViewer } from '../src/auth/flat-access.js';
import { MapRepository } from '../src/maps/repository.js';
import { MapService } from '../src/maps/service.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService } from '../src/reports/service.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService } from '../src/libraries/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';

const available = await databaseAvailable();

/**
 * A map's, a report's and a library's name is unique among what the caller can read (`L-06`).
 *
 * **Unique everywhere was an existence oracle**: `*_NAME_TAKEN` told a writer on one branch what
 * another branch's were called, one guess at a time. So a name another group's entity holds is
 * free to take, and one the caller can read — through any group, or as an administrator — is not.
 *
 * **And nothing but the advisory lock stops two creates racing** now that migration 064 dropped
 * the unique indexes. The race is made to happen rather than hoped for: the first create is held
 * inside its transaction, after its row is written, until the second is seen waiting on the lock.
 */

/** Records, and holds the change it rides with once, at the action it is told. */
class HoldsAfterRecording implements AuditSink {
  readonly #inner = new DatabaseAuditSink();
  holdOn: string | null = null;
  hold: (q: Queryable) => Promise<void> = () => Promise.resolve();

  async record(q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date) {
    await this.#inner.record(q, actor, mutations, at);
    if (mutations.some((mutation) => mutation.action === this.holdOn)) {
      this.holdOn = null;
      await this.hold(q);
    }
  }
}

interface Person {
  viewer: FlatViewer;
  actor: Actor;
}

interface Entity {
  kind: 'map' | 'report' | 'library';
  taken: string;
  create(who: Person, name: string): Promise<{ id: number; version: number }>;
  rename(who: Person, id: number, version: number, name: string): Promise<unknown>;
}

describe(
  'names among what the caller can read',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    const sink = new HoldsAfterRecording();
    /** `author` and `teammate` share a group; `outsider` shares nothing; `admin` sees all. */
    const people = new Map<string, Person>();
    const who = (login: 'author' | 'teammate' | 'outsider' | 'admin'): Person => {
      const person = people.get(login);
      assert.ok(person, login);
      return person;
    };
    let entities: Entity[] = [];
    let seq = 0;
    const fresh = (prefix: string): string => {
      seq += 1;
      return `${prefix} ${String(seq)}`;
    };

    before(async () => {
      scratch = await createScratchDatabase('flatnames');
      db = scratch.db;
      await buildHarness(db);

      const group = async (name: string, isAdmin = false): Promise<number> =>
        Number(
          (
            await db.query<{ id: string }>(
              `INSERT INTO user_group (name, is_admin) VALUES ($1, $2) RETURNING id`,
              [name, isAdmin],
            )
          )[0]?.id,
        );
      const branch = await group('branch');
      const elsewhere = await group('elsewhere');
      const admins = await group('names-admins', true);
      for (const [login, groupId] of [
        ['author', branch],
        ['teammate', branch],
        ['outsider', elsewhere],
        ['admin', admins],
      ] as const) {
        const rows = await db.query<{ id: string }>(
          `INSERT INTO user_account (login, display_name, password_hash, role)
           VALUES ($1, $1, 'x', 'readwrite') RETURNING id`,
          [login],
        );
        const userId = Number(rows[0]?.id);
        await db.query(
          `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
          [groupId, userId],
        );
        people.set(login, {
          viewer: { userId, role: 'readwrite' },
          actor: { kind: 'user', userId, login },
        });
      }

      const maps = new MapService({
        db,
        repository: new MapRepository(),
        audit: sink,
        logger: silent,
      });
      const reports = new ReportService({
        db,
        repository: new ReportRepository(),
        audit: sink,
        logger: silent,
      });
      const libraries = new LibraryService({
        db,
        repository: new LibraryRepository(),
        audit: sink,
        logger: silent,
      });
      entities = [
        {
          kind: 'map',
          taken: 'MAP_NAME_TAKEN',
          create: (who, name) => maps.create(who.viewer, { name }, who.actor),
          rename: (who, id, version, name) =>
            maps.update(who.viewer, id, version, { name }, who.actor),
        },
        {
          kind: 'report',
          taken: 'REPORT_NAME_TAKEN',
          create: (who, name) =>
            reports.create(who.viewer, { name, kind: 'table_only' }, who.actor),
          rename: (who, id, version, name) =>
            reports.update(who.viewer, id, version, { name }, who.actor),
        },
        {
          kind: 'library',
          taken: 'LIBRARY_NAME_TAKEN',
          create: (who, name) => libraries.create(who.viewer, who.actor, { name }),
          rename: (who, id, version, name) =>
            libraries.update(who.viewer, who.actor, id, version, { name }),
        },
      ];
    });

    after(async () => {
      await scratch.drop();
    });

    const refusedAs = (code: string) => (error: unknown) => {
      assert.equal((error as { code: string }).code, code);
      return true;
    };

    const named = async (entity: Entity, name: string): Promise<number> =>
      (await db.query(`SELECT 1 FROM ${entity.kind} WHERE lower(name) = lower($1)`, [name])).length;

    for (const kind of ['map', 'report', 'library'] as const) {
      const entity = (): Entity => {
        const found = entities.find((one) => one.kind === kind);
        assert.ok(found);
        return found;
      };

      describe(`a ${kind}`, () => {
        it('may take a name only another group’s holds, on create and on rename', async () => {
          const name = fresh('Core Network');
          const renamed = fresh('Core Network');
          await entity().create(who('outsider'), name);
          await entity().create(who('outsider'), renamed);

          await entity().create(who('author'), name.toLowerCase());
          const other = await entity().create(who('author'), fresh('Edge'));
          await entity().rename(who('author'), other.id, other.version, renamed.toUpperCase());
          assert.equal(await named(entity(), name), 2);
          assert.equal(await named(entity(), renamed), 2);
        });

        it('may not take one the caller can read, through its group or as an administrator', async () => {
          const name = fresh('Backbone');
          await entity().create(who('author'), name);

          await assert.rejects(
            () => entity().create(who('teammate'), name.toUpperCase()),
            refusedAs(entity().taken),
          );
          const other = await entity().create(who('teammate'), fresh('Spare'));
          await assert.rejects(
            () => entity().rename(who('teammate'), other.id, other.version, name),
            refusedAs(entity().taken),
          );
          // An administrator reads every one, so every name is one it can read.
          await assert.rejects(
            () => entity().create(who('admin'), name),
            refusedAs(entity().taken),
          );
          assert.equal(await named(entity(), name), 1);
        });

        it('lets only one of two concurrent creates of a name land', async () => {
          const name = fresh('Race');
          const race: { second?: Promise<unknown>; settled: boolean } = { settled: false };
          sink.holdOn = `${kind}.created`;
          sink.hold = async (q) => {
            // The first create has written its row and not committed. Start the second, and
            // hold the first until the second is seen waiting on it — or has finished without
            // waiting, which is the race the lock is there to close.
            const pid = (await q.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`))[0]?.pid;
            const second = entity().create(who('teammate'), name);
            race.second = second;
            second.then(
              () => {
                race.settled = true;
              },
              () => {
                race.settled = true;
              },
            );
            const deadline = Date.now() + 5_000;
            for (;;) {
              const waiting = await db.query(
                `SELECT 1 FROM pg_locks
                 WHERE locktype = 'advisory' AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))`,
                [pid],
              );
              if (waiting.length > 0 || race.settled) return;
              if (Date.now() > deadline) {
                throw new Error('the second create neither waited on the first nor finished');
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          };
          try {
            await entity().create(who('author'), name);
          } finally {
            sink.holdOn = null;
            sink.hold = () => Promise.resolve();
          }

          assert.ok(race.second, 'the second create never started');
          await assert.rejects(race.second, refusedAs(entity().taken));
          assert.equal(await named(entity(), name), 1);
        });
      });
    }
  },
);

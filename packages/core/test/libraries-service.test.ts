import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Actor, AuditSink, Mutation } from '../src/objects/audit.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService, type LibraryViewer } from '../src/libraries/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Records, then fails when told to: `flat-audit.test.ts`'s sink. The one refusal that can tell an
 * entry written in the change's transaction from one written beside it (`L-06`).
 */
class FailsAfterRecording implements AuditSink {
  readonly #inner = new DatabaseAuditSink();
  failOn: string | null = null;

  async record(q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date) {
    await this.#inner.record(q, actor, mutations, at);
    if (mutations.some((mutation) => mutation.action === this.failOn)) {
      throw new Error(`failing after recording ${String(this.failOn)}`);
    }
  }
}

/**
 * Who may do what with a library, and what the audit log says they did (`L-01`).
 *
 * **The access half is the map service's suite, asked of a third entity**, because `FlatAccess`
 * is shared now and a rule that holds for maps and not for libraries would be a rule held by
 * whichever caller happened to be tested. **The audit half is new**: maps and reports record
 * nothing, and the cases here are what keep a library from quietly joining them.
 */
describe(
  'the library service',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let libraries: LibraryService;
    const sink = new FailsAfterRecording();

    before(async () => {
      scratch = await createScratchDatabase('libsvc');
      db = scratch.db;
      await buildHarness(db);
      libraries = new LibraryService({
        db,
        repository: new LibraryRepository(),
        audit: sink,
        logger: silent,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    let seq = 0;

    const makeGroup = async (name: string, isAdmin = false): Promise<number> => {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO user_group (name, is_admin) VALUES ($1, $2) RETURNING id`,
        [name, isAdmin],
      );
      return Number(rows[0]?.id);
    };

    /** An account in the given groups, the first of them primary. */
    const makeUser = async (groups: number[]): Promise<number> => {
      seq += 1;
      const rows = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ($1, $1, 'x', 'readwrite') RETURNING id`,
        [`lib-user-${String(seq)}`],
      );
      const id = Number(rows[0]?.id);
      for (const [index, group] of groups.entries()) {
        await db.query(
          `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, $3)`,
          [group, id, index === 0],
        );
      }
      return id;
    };

    const viewer = (userId: number, role: LibraryViewer['role'] = 'readwrite'): LibraryViewer => ({
      userId,
      role,
    });
    const actor = (userId: number): Actor => ({ kind: 'user', userId, login: 'librarian' });

    /** An account with its own group, which is therefore granted `full` on what it creates. */
    const owner = async (): Promise<number> =>
      makeUser([await makeGroup(`lib-owner-${String(seq)}`)]);

    const codeOf = (code: string) => (error: unknown) => {
      assert.equal((error as { code: string }).code, code);
      return true;
    };

    const auditFor = async (libraryId: number) =>
      db.query<{
        action: string;
        object_id: string | null;
        actor_kind: string;
        summary: Record<string, unknown>;
        diff: { field: string; before: unknown; after: unknown }[];
      }>(
        `SELECT action, object_id, actor_kind, summary, diff FROM audit_log
         WHERE summary->>'libraryId' = $1 ORDER BY id`,
        [String(libraryId)],
      );

    beforeEach(() => {
      seq += 1;
    });

    describe('access, which is FlatAccess’s and the same as a map’s', () => {
      it('gives a creator’s primary group full access, so they keep what they made', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `mine-${String(seq)}`,
        });
        assert.equal(await libraries.rightFor(viewer(user), made.id), 'full');
        assert.equal((await libraries.get(viewer(user), made.id)).id, made.id);
      });

      it('lets nobody create one who could not change one, before reading the input', async () => {
        // `A-14`: a new library has no grant to cap, so the role's and the token's ceilings are
        // the whole check. The name is invalid on purpose: a refusal that came from validation
        // would be a different code, and would tell a caller who may not create what a library
        // must look like.
        const user = await owner();
        for (const who of [
          { userId: user, role: 'readonly' as const },
          { userId: user, role: 'readwrite' as const, scope: 'read' as const },
        ]) {
          await assert.rejects(
            () => libraries.create(who, actor(user), { name: '' }),
            codeOf('LIBRARY_FORBIDDEN'),
          );
        }
        await libraries.create({ userId: user, role: 'readwrite', scope: 'write' }, actor(user), {
          name: `token-made-${String(seq)}`,
        });
      });

      it('hides a library from an account with no grant, as absent rather than forbidden', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `secret-${String(seq)}`,
        });
        const stranger = await makeUser([await makeGroup(`lib-stranger-${String(seq)}`)]);
        await assert.rejects(
          () => libraries.get(viewer(stranger), made.id),
          codeOf('LIBRARY_NOT_FOUND'),
        );
        // And for a write, which must not be the way to learn it exists.
        await assert.rejects(
          () => libraries.update(viewer(stranger), actor(stranger), made.id, made.version, {}),
          codeOf('LIBRARY_NOT_FOUND'),
        );
      });

      it('tells a reader they may not change it, now that they can see it', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `ro-${String(seq)}`,
        });
        const group = await makeGroup(`lib-readers-${String(seq)}`);
        const reader = await makeUser([group]);
        await libraries.grant(viewer(user), actor(user), made.id, group, 'read');

        await assert.rejects(
          () =>
            libraries.update(viewer(reader), actor(reader), made.id, made.version, { priority: 5 }),
          codeOf('LIBRARY_FORBIDDEN'),
        );
      });

      it('lets an administrator group in without a grant, and lists everything for it', async () => {
        const name = `admin-sees-${String(seq)}`;
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), { name });
        const admin = await makeUser([await makeGroup(`lib-admins-${String(seq)}`, true)]);
        assert.equal(await libraries.rightFor(viewer(admin), made.id), 'full');
        assert.ok((await libraries.list(viewer(admin))).some((one) => one.name === name));
      });

      it('lists only what a group of the viewer’s was granted', async () => {
        const name = `listed-${String(seq)}`;
        const user = await owner();
        await libraries.create(viewer(user), actor(user), { name });
        const stranger = await makeUser([await makeGroup(`lib-other-${String(seq)}`)]);

        assert.ok((await libraries.list(viewer(user))).some((one) => one.name === name));
        assert.ok(!(await libraries.list(viewer(stranger))).some((one) => one.name === name));
      });

      it('caps a group’s grant by the role and by a token’s scope', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `cap-${String(seq)}`,
        });
        assert.equal(await libraries.rightFor(viewer(user, 'readonly'), made.id), 'read');
        assert.equal(
          await libraries.rightFor({ userId: user, role: 'readwrite', scope: 'write' }, made.id),
          'write',
        );
      });

      it('needs full to delete, and to say who else may see it', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `full-${String(seq)}`,
        });
        const group = await makeGroup(`lib-editors-${String(seq)}`);
        const editor = await makeUser([group]);
        await libraries.grant(viewer(user), actor(user), made.id, group, 'write');

        await assert.rejects(
          () => libraries.remove(viewer(editor), actor(editor), made.id),
          codeOf('LIBRARY_FORBIDDEN'),
        );
        await assert.rejects(
          () => libraries.grants(viewer(editor), made.id),
          codeOf('LIBRARY_FORBIDDEN'),
        );
        await assert.rejects(
          () => libraries.grant(viewer(editor), actor(editor), made.id, group, 'full'),
          codeOf('LIBRARY_FORBIDDEN'),
        );
        // A write holder may still arrange it.
        await libraries.update(viewer(editor), actor(editor), made.id, made.version, {
          priority: 1,
        });
      });

      it('replaces a grant rather than failing, and refuses a group that does not exist', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `regrant-${String(seq)}`,
        });
        const group = await makeGroup(`lib-regrant-${String(seq)}`);
        await libraries.grant(viewer(user), actor(user), made.id, group, 'read');
        await libraries.grant(viewer(user), actor(user), made.id, group, 'write');
        const grants = await libraries.grants(viewer(user), made.id);
        assert.deepEqual(
          grants.filter((one) => one.groupId === group).map((one) => one.right),
          ['write'],
        );

        await assert.rejects(
          () => libraries.grant(viewer(user), actor(user), made.id, 999_999, 'read'),
          codeOf('LIBRARY_GROUP_NOT_FOUND'),
        );

        const member = await makeUser([group]);
        await libraries.revoke(viewer(user), actor(user), made.id, group);
        assert.equal(await libraries.rightFor(viewer(member), made.id), 'none');
      });
    });

    describe('the document', () => {
      it('stores the nodes it was given, checked, and returns them in the same shape', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `doc-${String(seq)}`,
          nodes: [
            {
              id: 'a',
              name: 'Customer A',
              children: [{ id: 'r', name: 'Routers', rule: { types: ['snmp.traffic'] } }],
            },
          ],
        });
        const read = await libraries.get(viewer(user), made.id);
        assert.deepEqual(read.nodes, [
          {
            id: 'a',
            name: 'Customer A',
            rule: null,
            children: [
              {
                id: 'r',
                name: 'Routers',
                rule: { roots: [], types: ['snmp.traffic'], tags: [], states: [] },
                children: [],
              },
            ],
          },
        ]);
      });

      it('refuses a document that does not fit whole, and writes nothing', async () => {
        const user = await owner();
        const name = `refused-doc-${String(seq)}`;
        await assert.rejects(
          () =>
            libraries.create(viewer(user), actor(user), {
              name,
              nodes: [{ id: 'a', name: 'A', rule: { states: 'down' } }],
            }),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'LIBRARY_INVALID');
            assert.equal(
              (error as { details: { path: string } }).details.path,
              'nodes[0].rule.states',
            );
            return true;
          },
        );
        assert.equal((await db.query(`SELECT 1 FROM library WHERE name = $1`, [name])).length, 0);
      });

      it('refuses a duplicate name whatever its case, on create and on rename', async () => {
        const user = await owner();
        await libraries.create(viewer(user), actor(user), { name: `Dup-${String(seq)}` });
        await assert.rejects(
          () => libraries.create(viewer(user), actor(user), { name: `dup-${String(seq)}` }),
          codeOf('LIBRARY_NAME_TAKEN'),
        );
        const other = await libraries.create(viewer(user), actor(user), {
          name: `Other-${String(seq)}`,
        });
        await assert.rejects(
          () =>
            libraries.update(viewer(user), actor(user), other.id, other.version, {
              name: `DUP-${String(seq)}`,
            }),
          codeOf('LIBRARY_NAME_TAKEN'),
        );
        // Its own name in another case is a rename, not a clash.
        const renamed = await libraries.update(viewer(user), actor(user), other.id, other.version, {
          name: `OTHER-${String(seq)}`,
        });
        assert.equal(renamed.name, `OTHER-${String(seq)}`);
      });

      it('refuses a write against a version that has moved on', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `conc-${String(seq)}`,
        });
        const first = await libraries.update(viewer(user), actor(user), made.id, made.version, {
          priority: 4,
        });
        assert.equal(first.version, made.version + 1);

        await assert.rejects(
          () => libraries.update(viewer(user), actor(user), made.id, made.version, { priority: 2 }),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'LIBRARY_CHANGED');
            assert.deepEqual((error as { details: unknown }).details, {
              expectedVersion: made.version,
              actualVersion: first.version,
            });
            return true;
          },
        );
      });

      it('refuses a blank name, a long description and a priority outside 1..5', async () => {
        const user = await owner();
        for (const input of [
          { name: '   ' },
          { name: 'x'.repeat(101) },
          { name: `d-${String(seq)}`, description: 'x'.repeat(1001) },
          { name: `p-${String(seq)}`, priority: 9 },
        ]) {
          await assert.rejects(
            () => libraries.create(viewer(user), actor(user), input),
            codeOf('LIBRARY_INVALID'),
          );
        }
      });
    });

    describe('the audit log, which maps and reports do not write', () => {
      it('records a create, an edit and a delete, each with what moved', async () => {
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `audited-${String(seq)}`,
          nodes: [{ id: 'r', name: 'Routers', rule: { states: ['down'] } }],
        });
        const edited = await libraries.update(viewer(user), actor(user), made.id, made.version, {
          nodes: [{ id: 'r', name: 'Routers', rule: { states: ['down', 'warning'] } }],
        });
        await libraries.remove(viewer(user), actor(user), edited.id);

        const rows = await auditFor(made.id);
        assert.deepEqual(
          rows.map((row) => row.action),
          ['library.created', 'library.updated', 'library.deleted'],
        );
        // Not a tree object, so no object id — the library's own id is in the summary.
        assert.ok(rows.every((row) => row.object_id === null && row.actor_kind === 'user'));
        assert.equal(rows[0]?.summary['name'], `audited-${String(seq)}`);

        // **Only what moved**: the nodes changed and the name did not, so the diff says so.
        assert.deepEqual(rows[1]?.diff, [
          {
            field: 'library.nodes',
            before: 'Routers: states down',
            after: 'Routers: states down, warning',
          },
        ]);
        // The delete keeps what was lost — there is no recycle bin.
        assert.ok(
          rows[2]?.diff.some(
            (entry) =>
              entry.field === 'library.nodes' && entry.before === 'Routers: states down, warning',
          ),
        );
      });

      it('records a change the one-line text cannot show, with the documents (`L-06`)', async () => {
        // Two tags and one tag with a comma in it read alike, and so do two ids behind one name.
        // Compared as text, each of these edits was recorded as `diff: []`.
        const user = await owner();
        const node = (id: string, tags: string[]) => ({ id, name: 'Sites', rule: { tags } });
        const stored = (id: string, tags: string[]) => ({
          id,
          name: 'Sites',
          rule: { roots: [], types: [], tags, states: [] },
          children: [],
        });
        const made = await libraries.create(viewer(user), actor(user), {
          name: `lossy-${String(seq)}`,
          nodes: [node('a', ['core', 'berlin'])],
        });
        const retagged = await libraries.update(viewer(user), actor(user), made.id, made.version, {
          nodes: [node('a', ['core, berlin'])],
        });
        await libraries.update(viewer(user), actor(user), made.id, retagged.version, {
          nodes: [node('b', ['core, berlin'])],
        });
        // What did not move is still not recorded: the same document again is no change.
        const unchanged = await libraries.get(viewer(user), made.id);
        await libraries.update(viewer(user), actor(user), made.id, unchanged.version, {
          nodes: [node('b', ['core, berlin'])],
          priority: 5,
        });

        const rows = await auditFor(made.id);
        assert.deepEqual(rows[1]?.diff, [
          {
            field: 'library.nodes',
            before: [stored('a', ['core', 'berlin'])],
            after: [stored('a', ['core, berlin'])],
          },
        ]);
        assert.deepEqual(rows[2]?.diff, [
          {
            field: 'library.nodes',
            before: [stored('a', ['core, berlin'])],
            after: [stored('b', ['core, berlin'])],
          },
        ]);
        assert.deepEqual(
          rows[3]?.diff.map((entry) => entry.field),
          ['library.priority'],
        );
      });

      it('records nothing for a change that was refused', async () => {
        // **In the transaction, so the two cannot disagree.** A row for a write that rolled back
        // is a false record. A stale version is refused before anything is recorded, so it
        // cannot show where the entry is written; a failure *after* the entry is written can
        // (`L-06`), and only an entry inside the transaction goes when the change does.
        const user = await owner();
        const made = await libraries.create(viewer(user), actor(user), {
          name: `stale-${String(seq)}`,
        });
        const edited = await libraries.update(viewer(user), actor(user), made.id, made.version, {
          priority: 5,
        });
        await assert.rejects(
          () => libraries.update(viewer(user), actor(user), made.id, made.version, { priority: 1 }),
          codeOf('LIBRARY_CHANGED'),
        );

        sink.failOn = 'library.updated';
        try {
          await assert.rejects(
            () =>
              libraries.update(viewer(user), actor(user), made.id, edited.version, {
                priority: 1,
              }),
            /failing after recording library.updated/,
          );
        } finally {
          sink.failOn = null;
        }

        assert.deepEqual(
          (await auditFor(made.id)).map((row) => row.action),
          ['library.created', 'library.updated'],
        );
        // And the change went with its entry.
        assert.equal((await libraries.get(viewer(user), made.id)).priority, 5);
      });
    });
  },
);

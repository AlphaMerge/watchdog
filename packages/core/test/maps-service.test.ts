import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { MapRepository } from '../src/maps/repository.js';
import { MapService, type MapViewer } from '../src/maps/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, actorNamed } from './support/tree.js';
import { DatabaseAuditSink } from '../src/audit/store.js';

const available = await databaseAvailable();

/**
 * Who may do what with a map (`G-01`).
 *
 * **Access is the substance of this ticket**, and every case here is a rule that would otherwise
 * be a comment: a map you cannot read reads as absent, an administrator needs no grant, a role is
 * a ceiling, and a creator does not lose what they just made.
 */
describe(
  'the map service',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let maps: MapService;

    before(async () => {
      scratch = await createScratchDatabase('mapsvc');
      db = scratch.db;
      await buildHarness(db);
      maps = new MapService({
        db,
        repository: new MapRepository(),
        audit: new DatabaseAuditSink(),
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

    /** An account in the given groups. Login is unique per call so cases cannot collide. */
    const makeUser = async (groups: number[]): Promise<number> => {
      seq += 1;
      const rows = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ($1, $1, 'x', 'readwrite') RETURNING id`,
        [`user-${String(seq)}`],
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

    const viewer = (userId: number, role: MapViewer['role'] = 'readwrite'): MapViewer => ({
      userId,
      role,
    });

    beforeEach(() => {
      seq += 1;
    });

    it('gives a creator’s primary group full access, so they keep what they made', async () => {
      // **Without this a non-administrator creates a map and immediately loses it**: access is
      // per group and a new map has no grants, which is the sort of thing a user finds rather
      // than a test.
      const group = await makeGroup(`creators-${String(seq)}`);
      const user = await makeUser([group]);
      const map = await maps.create(
        viewer(user),
        { name: `mine-${String(seq)}` },
        actorNamed('tester'),
      );

      assert.equal(await maps.rightFor(viewer(user), map.id), 'full');
      assert.equal((await maps.get(viewer(user), map.id)).id, map.id);
    });

    it('lets nobody create a map who could not change one', async () => {
      // **`A-14`, at the service as well as at the route.** Creating has no map to hold a right
      // on, so the role and the token's scope are the only ceilings there are — and they were not
      // consulted, so a read-only account or a read-scoped token made maps and got `full` on
      // them. The route refuses first over HTTP; this is the half that holds for any caller.
      const group = await makeGroup(`not-creators-${String(seq)}`);
      const user = await makeUser([group]);
      for (const who of [
        { userId: user, role: 'readonly' as const },
        { userId: user, role: 'readwrite' as const, scope: 'read' as const },
      ]) {
        const name = `refused-${who.role}-${String(seq)}`;
        await assert.rejects(
          () => maps.create(who, { name }, actorNamed('tester')),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'MAP_FORBIDDEN');
            return true;
          },
        );
        assert.equal((await db.query(`SELECT 1 FROM map WHERE name = $1`, [name])).length, 0);
      }
      // A `write` token is enough, because creating is a write.
      await maps.create(
        { userId: user, role: 'readwrite', scope: 'write' },
        { name: `allowed-${String(seq)}` },
        actorNamed('tester'),
      );
    });

    it('hides a map from an account with no grant, as absent rather than forbidden', async () => {
      // Answering 403 for a map that exists and 404 for one that does not is an oracle: anybody
      // could enumerate ids and learn how many maps an installation has.
      const owner = await makeUser([await makeGroup(`owner-${String(seq)}`)]);
      const map = await maps.create(
        viewer(owner),
        { name: `secret-${String(seq)}` },
        actorNamed('tester'),
      );
      const stranger = await makeUser([await makeGroup(`stranger-${String(seq)}`)]);

      await assert.rejects(
        () => maps.get(viewer(stranger), map.id),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'MAP_NOT_FOUND');
          return true;
        },
      );
    });

    it('lets an administrator group in without a grant', async () => {
      // "May do anything, including to things that do not exist yet" is not a grant, and must not
      // depend on a row that somebody can delete.
      const owner = await makeUser([await makeGroup(`owner2-${String(seq)}`)]);
      const map = await maps.create(
        viewer(owner),
        { name: `admin-sees-${String(seq)}` },
        actorNamed('tester'),
      );
      const admin = await makeUser([await makeGroup(`admins-${String(seq)}`, true)]);

      assert.equal(await maps.rightFor(viewer(admin), map.id), 'full');
    });

    it('caps what a group granted by the account’s role', async () => {
      // A-04: a role is a ceiling, not a starting point. A read-only account in a group holding
      // full on a map still holds read.
      const group = await makeGroup(`capped-${String(seq)}`);
      const user = await makeUser([group]);
      const map = await maps.create(
        viewer(user),
        { name: `capped-map-${String(seq)}` },
        actorNamed('tester'),
      );

      assert.equal(await maps.rightFor(viewer(user, 'readonly'), map.id), 'read');
      await assert.rejects(
        () =>
          maps.update(
            viewer(user, 'readonly'),
            map.id,
            map.version,
            { priority: 5 },
            actorNamed('x'),
          ),
        /may not write/,
      );
    });

    it('caps an account’s right by a token’s scope as well', async () => {
      const group = await makeGroup(`scoped-${String(seq)}`);
      const user = await makeUser([group]);
      const map = await maps.create(
        viewer(user),
        { name: `scoped-map-${String(seq)}` },
        actorNamed('tester'),
      );
      assert.equal(
        await maps.rightFor({ userId: user, role: 'readwrite', scope: 'read' }, map.id),
        'read',
      );
    });

    it('lists only what the viewer may see, and everything for an administrator', async () => {
      // **The name is captured, not recomputed.** `makeUser` advances `seq`, so re-deriving it
      // at the assertion asks for a map created under a different name — which reads as "the
      // list is wrong" and is the test being wrong.
      const name = `listed-${String(seq)}`;
      const mine = await makeGroup(`list-mine-${String(seq)}`);
      const user = await makeUser([mine]);
      await maps.create(viewer(user), { name }, actorNamed('tester'));

      const stranger = await makeUser([await makeGroup(`list-other-${String(seq)}`)]);
      const admin = await makeUser([await makeGroup(`list-admin-${String(seq)}`, true)]);

      const theirs = await maps.list(viewer(user));
      assert.ok(theirs.some((one) => one.name === name));
      assert.equal((await maps.list(viewer(stranger))).length, 0);
      assert.ok((await maps.list(viewer(admin))).length >= theirs.length);
    });

    describe('concurrent editing, which a designer makes ordinary', () => {
      it('refuses a write against a version that has moved on', async () => {
        const user = await makeUser([await makeGroup(`conc-${String(seq)}`)]);
        const map = await maps.create(
          viewer(user),
          { name: `conc-${String(seq)}` },
          actorNamed('tester'),
        );

        const first = await maps.update(
          viewer(user),
          map.id,
          map.version,
          { priority: 4 },
          actorNamed('a'),
        );
        assert.equal(first.version, map.version + 1);

        // The second designer still holds the version they opened.
        await assert.rejects(
          () => maps.update(viewer(user), map.id, map.version, { priority: 2 }, actorNamed('b')),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'MAP_CHANGED');
            assert.deepEqual((error as { details: unknown }).details, {
              expectedVersion: map.version,
              actualVersion: first.version,
            });
            return true;
          },
        );
      });
    });

    describe('granting', () => {
      it('needs full, so a write holder cannot decide who else sees the map', async () => {
        const owner = await makeUser([await makeGroup(`g-owner-${String(seq)}`)]);
        const map = await maps.create(
          viewer(owner),
          { name: `granting-${String(seq)}` },
          actorNamed('tester'),
        );

        const editorGroup = await makeGroup(`g-editor-${String(seq)}`);
        const editor = await makeUser([editorGroup]);
        await maps.grant(viewer(owner), map.id, editorGroup, 'write', actorNamed('tester'));

        assert.equal(await maps.rightFor(viewer(editor), map.id), 'write');
        await assert.rejects(
          () => maps.grant(viewer(editor), map.id, editorGroup, 'full', actorNamed('editor')),
          /may not full/,
        );
      });

      it('replaces a grant rather than failing, because granting twice is a correction', async () => {
        const owner = await makeUser([await makeGroup(`g2-owner-${String(seq)}`)]);
        const map = await maps.create(
          viewer(owner),
          { name: `regrant-${String(seq)}` },
          actorNamed('tester'),
        );
        const other = await makeGroup(`g2-other-${String(seq)}`);

        await maps.grant(viewer(owner), map.id, other, 'read', actorNamed('tester'));
        await maps.grant(viewer(owner), map.id, other, 'write', actorNamed('tester'));

        const grants = await maps.grants(viewer(owner), map.id);
        assert.equal(grants.filter((one) => one.groupId === other).length, 1);
        assert.equal(grants.find((one) => one.groupId === other)?.right, 'write');
      });

      it('refuses a grant to a group that does not exist', async () => {
        const owner = await makeUser([await makeGroup(`g3-owner-${String(seq)}`)]);
        const map = await maps.create(
          viewer(owner),
          { name: `nogroup-${String(seq)}` },
          actorNamed('tester'),
        );
        await assert.rejects(
          () => maps.grant(viewer(owner), map.id, 999_999, 'read', actorNamed('tester')),
          /does not exist/,
        );
      });

      it('takes access away again on revoke', async () => {
        const owner = await makeUser([await makeGroup(`g4-owner-${String(seq)}`)]);
        const map = await maps.create(
          viewer(owner),
          { name: `revoked-${String(seq)}` },
          actorNamed('tester'),
        );
        const group = await makeGroup(`g4-other-${String(seq)}`);
        const user = await makeUser([group]);

        await maps.grant(viewer(owner), map.id, group, 'read', actorNamed('tester'));
        assert.equal(await maps.rightFor(viewer(user), map.id), 'read');
        await maps.revoke(viewer(owner), map.id, group, actorNamed('tester'));
        assert.equal(await maps.rightFor(viewer(user), map.id), 'none');
      });
    });

    describe('validation', () => {
      it('refuses a blank name and one that is too long', async () => {
        const user = await makeUser([await makeGroup(`v-${String(seq)}`)]);
        await assert.rejects(
          () => maps.create(viewer(user), { name: '   ' }, actorNamed('x')),
          /1 to 100/,
        );
        await assert.rejects(
          () => maps.create(viewer(user), { name: 'x'.repeat(101) }, actorNamed('x')),
          /1 to 100/,
        );
      });

      it('refuses a duplicate name whatever its case', async () => {
        const user = await makeUser([await makeGroup(`v2-${String(seq)}`)]);
        await maps.create(viewer(user), { name: `Dup-${String(seq)}` }, actorNamed('x'));
        await assert.rejects(
          () => maps.create(viewer(user), { name: `dup-${String(seq)}` }, actorNamed('x')),
          /already exists/,
        );
      });

      it('refuses a priority outside 1..5', async () => {
        const user = await makeUser([await makeGroup(`v3-${String(seq)}`)]);
        await assert.rejects(
          () =>
            maps.create(viewer(user), { name: `p-${String(seq)}`, priority: 9 }, actorNamed('x')),
          /1 to 5/,
        );
      });

      it('trims the name, so two maps cannot differ by a space', async () => {
        const user = await makeUser([await makeGroup(`v4-${String(seq)}`)]);
        const map = await maps.create(
          viewer(user),
          { name: `  Trimmed-${String(seq)}  ` },
          actorNamed('x'),
        );
        assert.equal(map.name, `Trimmed-${String(seq)}`);
      });
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * The map schema (`G-01`).
 *
 * **Every case here is a decision the migration's comments claim, asserted rather than described.**
 * A comment saying a deleted group takes its grants with it is a comment; the test is what stops
 * the next migration quietly changing it.
 */
describe(
  'the map schema',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let rootId: number;

    before(async () => {
      scratch = await createScratchDatabase('maps');
      db = scratch.db;
      // The harness runs the migrations and gives a root — a probe must have a parent, which is
      // the tree's own constraint and not something this schema gets to sidestep.
      rootId = (await buildHarness(db)).rootId;
    });

    after(async () => {
      await scratch.drop();
    });

    const makeMap = async (name: string, priority = 3): Promise<number> => {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO map (name, priority) VALUES ($1, $2) RETURNING id`,
        [name, priority],
      );
      return Number(rows[0]?.id);
    };

    const makeGroup = async (name: string): Promise<number> => {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO user_group (name) VALUES ($1) RETURNING id`,
        [name],
      );
      return Number(rows[0]?.id);
    };

    it('starts a map with an empty canvas rather than a null one', async () => {
      // `G-02` reads this column; a null would make every widget path start with a null check
      // for a state that should not exist.
      const id = await makeMap('empty');
      const rows = await db.query<{ layout: { widgets: unknown[] } }>(
        `SELECT layout FROM map WHERE id = $1`,
        [id],
      );
      assert.deepEqual(rows[0]?.layout, { widgets: [] });
    });

    it('holds two maps of one name, because a name is unique only among what somebody can read', async () => {
      // Migration 064 (`L-06`): a name unique everywhere was an existence oracle, so the rule is
      // `FlatAccess.nameTaken`'s now, asked among the caller's own maps. The table keeps the
      // case-folded index for that question and no longer refuses the row.
      await makeMap('Core Network');
      await makeMap('core network');
      const rows = await db.query(`SELECT 1 FROM map WHERE lower(name) = 'core network'`);
      assert.equal(rows.length, 2);
    });

    it('refuses a priority outside the 1..5 the tree uses', async () => {
      await assert.rejects(() => makeMap('too-keen', 6), /priority/);
      await assert.rejects(() => makeMap('too-meek', 0), /priority/);
    });

    it('moves updated_at on a change, through migration 001’s own trigger', async () => {
      const id = await makeMap('touched');
      const before = await db.query<{ updated_at: Date }>(
        `SELECT updated_at FROM map WHERE id = $1`,
        [id],
      );
      await db.query(`UPDATE map SET description = 'changed' WHERE id = $1`, [id]);
      const after = await db.query<{ updated_at: Date }>(
        `SELECT updated_at FROM map WHERE id = $1`,
        [id],
      );
      assert.ok(
        (after[0]?.updated_at.getTime() ?? 0) > (before[0]?.updated_at.getTime() ?? 0),
        'the trigger fired',
      );
    });

    describe('access, which is flat because maps do not nest', () => {
      it('grants a right to a group', async () => {
        const map = await makeMap('granted');
        const group = await makeGroup('viewers');
        await db.query(
          `INSERT INTO map_access (map_id, group_id, right_) VALUES ($1, $2, 'read')`,
          [map, group],
        );
        const rows = await db.query<{ right_: string }>(
          `SELECT right_ FROM map_access WHERE map_id = $1 AND group_id = $2`,
          [map, group],
        );
        assert.equal(rows[0]?.right_, 'read');
      });

      it('holds one right per group per map, not a list', async () => {
        const map = await makeMap('one-each');
        const group = await makeGroup('one-each-group');
        await db.query(
          `INSERT INTO map_access (map_id, group_id, right_) VALUES ($1, $2, 'read')`,
          [map, group],
        );
        await assert.rejects(
          () =>
            db.query(`INSERT INTO map_access (map_id, group_id, right_) VALUES ($1, $2, 'full')`, [
              map,
              group,
            ]),
          /map_access_pkey/,
        );
      });

      it('takes the grants with the map when the map goes', async () => {
        const map = await makeMap('doomed');
        const group = await makeGroup('doomed-group');
        await db.query(
          `INSERT INTO map_access (map_id, group_id, right_) VALUES ($1, $2, 'full')`,
          [map, group],
        );
        await db.query(`DELETE FROM map WHERE id = $1`, [map]);
        const rows = await db.query(`SELECT 1 FROM map_access WHERE map_id = $1`, [map]);
        assert.equal(rows.length, 0);
      });

      it('takes the grants with the group when the group goes', async () => {
        // A deleted group must not leave rows pointing at nothing, which would then be granted
        // to whatever reused the id.
        const map = await makeMap('outliving');
        const group = await makeGroup('short-lived');
        await db.query(
          `INSERT INTO map_access (map_id, group_id, right_) VALUES ($1, $2, 'full')`,
          [map, group],
        );
        await db.query(`DELETE FROM user_group WHERE id = $1`, [group]);
        const rows = await db.query(`SELECT 1 FROM map_access WHERE map_id = $1`, [map]);
        assert.equal(rows.length, 0);
        const survived = await db.query(`SELECT 1 FROM map WHERE id = $1`, [map]);
        assert.equal(survived.length, 1, 'and the map itself survives');
      });

      it('uses migration 033’s access_right, not a second copy of it', async () => {
        const map = await makeMap('typed');
        const group = await makeGroup('typed-group');
        await assert.rejects(
          () =>
            db.query(
              `INSERT INTO map_access (map_id, group_id, right_) VALUES ($1, $2, 'sideways')`,
              [map, group],
            ),
          /access_right/,
        );
      });
    });

    describe('the reference a widget holds', () => {
      it('survives the object it names being deleted', async () => {
        // **The decision this schema exists to make.** A foreign key would have to choose between
        // deleting the widget — so the dashboard quietly stops mentioning what failed — and
        // refusing to delete the sensor because somebody once put it on a map. The document keeps
        // the reference, and `G-02` renders a widget that says the object is gone.
        const rows = await db.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'probe', 'ref-probe')
           RETURNING id`,
          [rootId],
        );
        const objectId = Number(rows[0]?.id);
        const map = await makeMap('holds-a-reference');
        await db.query(`UPDATE map SET layout = $2 WHERE id = $1`, [
          map,
          JSON.stringify({ widgets: [{ kind: 'status', objectId }] }),
        ]);

        await db.query(`DELETE FROM object WHERE id = $1`, [objectId]);

        const after = await db.query<{ layout: { widgets: { objectId: number }[] } }>(
          `SELECT layout FROM map WHERE id = $1`,
          [map],
        );
        const layout = after[0]?.layout;
        assert.ok(layout, 'the map is still there');
        assert.equal(layout.widgets.length, 1, 'the widget is still on the canvas');
        assert.equal(layout.widgets[0]?.objectId, objectId, 'still naming what is gone');
      });
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { ObjectId } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * The audit sink's contract, from `audit.ts`: "Called **inside** the mutation's transaction, so
 * an audit entry can never exist for a change that rolled back, nor a change without its
 * entry."
 *
 * A sink that pushes to an array cannot prove that — an array survives a rollback. These tests
 * make the sink write through the executor it was handed, so the database decides.
 */
describe(
  'audit entries share the mutation transaction',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let probeId: ObjectId;

    before(async () => {
      scratch = await createScratchDatabase('objaudit');
      h = await buildHarness(scratch.db);
      await scratch.db.query(`
        CREATE TABLE audit_probe (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          action text NOT NULL,
          object_id bigint NOT NULL
        )
      `);
      h.audit.persist = true;
      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Local probe',
        })
      ).id;
    });

    after(async () => {
      await scratch.drop();
    });

    const auditRows = async (): Promise<{ action: string; object_id: string }[]> =>
      scratch.db.query<{ action: string; object_id: string }>(
        'SELECT action, object_id FROM audit_probe ORDER BY id',
      );

    it('commits the entry with the change', async () => {
      const before = (await auditRows()).length;

      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'Audited',
      });

      const rows = await auditRows();
      assert.equal(rows.length, before + 1);
      assert.equal(rows.at(-1)?.action, 'object.created');
      assert.equal(Number(rows.at(-1)?.object_id), group.id);
    });

    it('rolls the entry back when the change fails', async () => {
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'Doomed',
      });
      await h.service.create(testActor, {
        kind: 'device',
        parentId: group.id,
        name: 'switch-01',
        host: '10.0.0.1',
      });

      const before = await auditRows();

      // The delete records its entry inside the transaction and *before* the DELETE, then this
      // count mismatch aborts. Nothing must survive.
      await assert.rejects(() =>
        h.service.delete(testActor, group.id, { kind: 'exact', descendants: 99 }, { kind: 'none' }),
      );

      const after = await auditRows();
      assert.equal(
        after.length,
        before.length,
        'no audit entry may outlive the change it describes',
      );
      assert.equal((await h.service.get(group.id)).id, group.id, 'and the object is still there');
    });

    it('rolls back a settings write and its entry together', async () => {
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'Settings',
      });
      const before = await auditRows();

      // A stale precondition aborts the transaction after existence is confirmed.
      await assert.rejects(() =>
        h.service.setSetting(testActor, group.id, 'scan.intervalSeconds', 300, {
          kind: 'version',
          expected: 999,
        }),
      );

      assert.equal((await auditRows()).length, before.length);
      assert.deepEqual(await h.resolver.own(group.id), {}, 'and no setting was written');
    });
  },
);

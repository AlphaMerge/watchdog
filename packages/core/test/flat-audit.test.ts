import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Actor, AuditSink, Mutation } from '../src/objects/audit.js';
import { MapRepository } from '../src/maps/repository.js';
import { MapService } from '../src/maps/service.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService } from '../src/reports/service.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService } from '../src/libraries/service.js';
import type { FlatViewer } from '../src/auth/flat-access.js';
import { AccessService } from '../src/auth/access.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';

const available = await databaseAvailable();

/**
 * What the audit log says about maps, reports and every grant, on the tree or off it (`A-17`).
 *
 * `audit-sweep.test.ts` proves each route writes *an* entry. This says what the entries hold,
 * because an entry that exists and says the wrong thing is worse than none: somebody reads it.
 * And it proves the one property a row count cannot — that the entry is written in the change's
 * own transaction, so a change that fails takes its entry with it.
 */

interface Row {
  action: string;
  object_id: string | null;
  summary: Record<string, unknown>;
  diff: { field: string; before: unknown; after: unknown }[];
}

/** Records, then fails: the change it rides with must roll back, and take the row with it. */
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

describe(
  'flat entities in the audit log',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let sink: FailsAfterRecording;
    let maps: MapService;
    let reports: ReportService;
    let libraries: LibraryService;
    let access: AccessService;
    let rootId = 0;
    let owner: FlatViewer;
    let actor: Actor;
    let groupId = 0;
    let seq = 0;

    const name = (prefix: string): string => {
      seq += 1;
      return `${prefix}-${String(seq)}`;
    };

    const rows = async (where: string, values: unknown[]): Promise<Row[]> =>
      db.query<Row>(
        `SELECT action, object_id, summary, diff FROM audit_log WHERE ${where} ORDER BY id`,
        values,
      );

    before(async () => {
      scratch = await createScratchDatabase('flataudit');
      db = scratch.db;
      rootId = (await buildHarness(db)).rootId;
      sink = new FailsAfterRecording();
      access = new AccessService({ db, audit: sink, logger: silent });
      maps = new MapService({ db, repository: new MapRepository(), audit: sink, logger: silent });
      reports = new ReportService({
        db,
        repository: new ReportRepository(),
        audit: sink,
        logger: silent,
      });
      libraries = new LibraryService({
        db,
        repository: new LibraryRepository(),
        audit: sink,
        logger: silent,
      });

      const group = await db.query<{ id: string }>(
        `INSERT INTO user_group (name) VALUES ('auditors') RETURNING id`,
      );
      const other = await db.query<{ id: string }>(
        `INSERT INTO user_group (name) VALUES ('Readers') RETURNING id`,
      );
      groupId = Number(other[0]?.id);
      const user = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ('auditor', 'auditor', 'x', 'readwrite') RETURNING id`,
      );
      const userId = Number(user[0]?.id);
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
        [Number(group[0]?.id), userId],
      );
      owner = { userId, role: 'readwrite' };
      actor = { kind: 'user', userId, login: 'auditor' };
    });

    after(async () => {
      await scratch.drop();
    });

    describe('grants, one action for all of them', () => {
      it('records a new grant, a change of one and a revoke, before and after', async () => {
        const library = await libraries.create(owner, actor, { name: name('granted') });
        await libraries.grant(owner, actor, library.id, groupId, 'read');
        await libraries.grant(owner, actor, library.id, groupId, 'write');
        await libraries.revoke(owner, actor, library.id, groupId);

        const entries = await rows(
          `action LIKE 'grant.%' AND summary->>'subject' = 'library'
           AND (summary->>'subjectId')::bigint = $1 AND (summary->>'groupId')::bigint = $2`,
          [library.id, groupId],
        );
        assert.deepEqual(
          entries.map((row) => [row.action, row.diff[0]?.before, row.diff[0]?.after]),
          [
            // Null, not `none`: the group held nothing here, which is not the same as being
            // refused — `none` overrides an inherited right and absence does not.
            ['grant.set', null, 'read'],
            ['grant.set', 'read', 'write'],
            ['grant.revoked', 'write', null],
          ],
        );
        assert.equal(entries[0]?.summary['group'], 'Readers');
        assert.ok(entries.every((row) => row.object_id === null));
      });

      it('records the grant a creator is given, which decides who can see a new thing', async () => {
        const map = await maps.create(owner, { name: name('created') }, actor);
        const entries = await rows(
          `action = 'grant.set' AND summary->>'subject' = 'map' AND (summary->>'subjectId')::bigint = $1`,
          [map.id],
        );
        assert.deepEqual(
          entries.map((row) => [row.summary['group'], row.diff[0]?.before, row.diff[0]?.after]),
          [['auditors', null, 'full']],
        );
      });

      it('records an object grant against the object, so it is in the history of that object', async () => {
        await access.grant(rootId, groupId, 'read', actor);
        assert.equal((await access.grantsOn(rootId))[0]?.grantedBy, 'auditor');
        await access.grant(rootId, groupId, 'none', actor);
        await access.revoke(rootId, groupId, actor);
        assert.equal(await access.revoke(rootId, groupId, actor), false);

        const entries = await rows(
          `action LIKE 'grant.%' AND summary->>'subject' = 'object'
           AND object_id = $1 AND (summary->>'groupId')::bigint = $2`,
          [rootId, groupId],
        );
        assert.deepEqual(
          entries.map((row) => [row.action, row.diff[0]?.before, row.diff[0]?.after]),
          [
            ['grant.set', null, 'read'],
            // `none` is a grant and not a revoke: it overrides what the group inherits, where a
            // revoke hands the object back to it. And the revoke that found nothing wrote nothing.
            ['grant.set', 'read', 'none'],
            ['grant.revoked', 'none', null],
          ],
        );
        assert.ok(entries.every((row) => row.summary['subjectId'] === rootId));
      });

      it('records nothing for a revoke that found nothing to take', async () => {
        const report = await reports.create(
          owner,
          { name: name('bare'), kind: 'table_only' },
          actor,
        );
        await reports.revoke(owner, report.id, groupId, actor);
        const entries = await rows(
          `action = 'grant.revoked' AND summary->>'subject' = 'report'
           AND (summary->>'subjectId')::bigint = $1`,
          [report.id],
        );
        assert.deepEqual(entries, []);
      });
    });

    describe('maps', () => {
      it('records what moved on an edit, and the layout one item to a line', async () => {
        // A tile on an object the editor may read, since a save may not add one it cannot
        // (`A-22`). Granted in SQL so that the grant is not itself one of the rows read below.
        const objectId = rootId;
        await db.query(
          `INSERT INTO object_access (object_id, group_id, right_)
           SELECT $1, id, 'read' FROM user_group WHERE name = 'auditors'
           ON CONFLICT DO NOTHING`,
          [objectId],
        );
        const map = await maps.create(owner, { name: name('edited') }, actor);
        await maps.update(
          owner,
          map.id,
          map.version,
          { layout: { widgets: [{ id: 'w1', kind: 'status', objectId }] } },
          actor,
        );
        const [entry] = await rows(`action = 'map.updated' AND (summary->>'mapId')::bigint = $1`, [
          map.id,
        ]);
        assert.deepEqual(entry?.diff, [
          {
            field: 'map.layout',
            before: 'widgets: []',
            after: `widgets: {"id":"w1","kind":"status","objectId":${String(objectId)}}`,
          },
        ]);
      });

      it('survives a layout with no widgets at all, which nothing forbids', async () => {
        // The column is only held to being an object, and the route accepts any. An audit that
        // assumed `widgets` would turn a strange save into a failed one.
        const map = await maps.create(owner, { name: name('odd'), layout: {} as never }, actor);
        await maps.update(owner, map.id, map.version, { priority: 1 }, actor);
      });

      it('records a share link by its label and prefix, never its token', async () => {
        const map = await maps.create(owner, { name: name('shared') }, actor);
        const expiresAt = new Date(Date.now() + 86_400_000);
        const { share, token } = await maps.createShare(
          owner,
          map.id,
          { label: 'lobby', expiresAt },
          actor,
        );
        const [entry] = await rows(
          `action = 'map.share.created' AND (summary->>'mapId')::bigint = $1`,
          [map.id],
        );
        assert.ok(entry !== undefined);
        assert.equal(entry.summary['label'], 'lobby');
        assert.equal(entry.summary['prefix'], share.prefix);
        // The token is a grant to everybody; a row that held it would be one in every backup.
        const leaked = await rows(
          `summary::text LIKE '%' || $1 || '%' OR diff::text LIKE '%' || $1 || '%'`,
          [token],
        );
        assert.deepEqual(leaked, []);
      });
    });

    describe('reports', () => {
      it('records who a report renders as, since changing it decides what it contains', async () => {
        const report = await reports.create(owner, { name: name('as'), kind: 'table_only' }, actor);
        const [created] = await rows(
          `action = 'report.created' AND (summary->>'reportId')::bigint = $1`,
          [report.id],
        );
        assert.ok(
          created?.diff.some(
            (change) => change.field === 'report.runAs' && change.after === 'auditor',
          ),
        );
        await reports.remove(owner, report.id, actor);
        const [deleted] = await rows(
          `action = 'report.deleted' AND (summary->>'reportId')::bigint = $1`,
          [report.id],
        );
        assert.equal(deleted?.summary['name'], report.name);
      });
    });

    describe('in the transaction, so a change that fails takes its entry with it', () => {
      // **The property a row count cannot see.** Each case records and then fails, inside the
      // service's transaction; a sink that wrote outside it would leave a row describing a change
      // that never happened.
      const all = (action: string) => async (): Promise<number> =>
        (await rows(`action = $1`, [action])).length;
      // The grant's library has its own creator grant, a `grant.set` meant to stay; this case
      // counts only the grant that fails.
      const toReaders = async (): Promise<number> =>
        (await rows(`action = 'grant.set' AND (summary->>'groupId')::bigint = $1`, [groupId]))
          .length;
      /**
       * The object grant's entries *and the grant* (`A-26`). Its entries alone could not tell a
       * grant that rolled back from one written outside the transaction: the audit row went
       * either way, and the next case's own grant then overwrote the row that should not exist.
       */
      const toReadersAndTheGrant = async (): Promise<{
        entries: number;
        right: string | null;
      }> => ({
        entries: await toReaders(),
        right:
          (
            await db.query<{ right_: string }>(
              `SELECT right_::text AS right_ FROM object_access
               WHERE object_id = $1 AND group_id = $2`,
              [rootId, groupId],
            )
          )[0]?.right_ ?? null,
      });

      const cases: [string, string, () => Promise<unknown>, () => Promise<unknown>][] = [
        [
          'a map',
          'map.created',
          all('map.created'),
          () => maps.create(owner, { name: 'rolled-back-map' }, actor),
        ],
        [
          'a report',
          'report.created',
          all('report.created'),
          () => reports.create(owner, { name: 'rolled-back-report', kind: 'table_only' }, actor),
        ],
        [
          'a grant',
          'grant.set',
          toReaders,
          async () => {
            sink.failOn = null;
            const library = await libraries.create(owner, actor, { name: 'rolled-back-grant' });
            sink.failOn = 'grant.set';
            await libraries.grant(owner, actor, library.id, groupId, 'read');
          },
        ],
        [
          'an object grant',
          'grant.set',
          toReadersAndTheGrant,
          () => access.grant(rootId, groupId, 'write', actor),
        ],
        [
          'an object revoke',
          'grant.revoked',
          all('grant.revoked'),
          async () => {
            sink.failOn = null;
            await access.grant(rootId, groupId, 'read', actor);
            sink.failOn = 'grant.revoked';
            await access.revoke(rootId, groupId, actor);
          },
        ],
      ];

      for (const [what, action, count, change] of cases) {
        it(`leaves no ${action} entry, and no ${what}, when the change fails after recording`, async () => {
          const before = await count();
          sink.failOn = action;
          try {
            await assert.rejects(change, /failing after recording/);
          } finally {
            sink.failOn = null;
          }
          assert.deepEqual(await count(), before);
        });
      }

      it('and really undid the change, not only the entry', async () => {
        assert.equal(
          (await db.query(`SELECT 1 FROM map WHERE name = 'rolled-back-map'`)).length,
          0,
        );
        assert.equal(
          (await db.query(`SELECT 1 FROM report WHERE name = 'rolled-back-report'`)).length,
          0,
        );
        assert.equal(
          (
            await db.query(
              `SELECT 1 FROM library_access a JOIN library l ON l.id = a.library_id
               WHERE l.name = 'rolled-back-grant' AND a.group_id = $1`,
              [groupId],
            )
          ).length,
          0,
        );
        // The revoke that failed left the grant before it. The grant that failed is asserted by its
        // own case, before the revoke's setup could overwrite it.
        assert.deepEqual(
          await db.query(
            `SELECT right_ FROM object_access WHERE object_id = $1 AND group_id = $2`,
            [rootId, groupId],
          ),
          [{ right_: 'read' }],
        );
      });
    });
  },
);

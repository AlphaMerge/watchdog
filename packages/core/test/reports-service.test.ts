import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService, type ReportViewer } from '../src/reports/service.js';
import { contextLost } from '../src/reports/errors.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, actorNamed } from './support/tree.js';
import { DatabaseAuditSink } from '../src/audit/store.js';

const available = await databaseAvailable();

/**
 * Who may do what with a report, and whose eyes it renders through (`E-01`).
 *
 * The access half deliberately asserts the same rules `maps-service.test.ts` does, because they
 * are the same rules and the point of a second grantable thing is that it does not invent a second
 * answer. The half that is this ticket's own is the security context: `§6` lets a report run under
 * a named account's visibility, which is an "act as" path, and the failure to design against is a
 * report that quietly widens its own scope when that account goes away.
 */
describe(
  'the report service',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let reports: ReportService;
    let harness: Awaited<ReturnType<typeof buildHarness>>;
    /** The only kind of caller who may point a report at somebody else (`A-13`). */
    let administrator: { id: number; login: string };

    before(async () => {
      scratch = await createScratchDatabase('reportsvc');
      db = scratch.db;
      harness = await buildHarness(db);
      reports = new ReportService({
        db,
        repository: new ReportRepository(),
        audit: new DatabaseAuditSink(),
        logger: silent,
      });
      administrator = await makeUser([await makeGroup('r-administrators', true)], 'admin');
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

    /**
     * An account in the given groups, and **its login comes back with it.**
     *
     * Unlike the map cases, the actor here cannot be an invented string: a report's default
     * security context is the account that created it, and the service refuses a context naming
     * nobody. A test passing `'tester'` would fail for a reason that has nothing to do with what
     * it is asserting.
     */
    const makeUser = async (
      groups: number[],
      role = 'readwrite',
    ): Promise<{ id: number; login: string }> => {
      seq += 1;
      const login = `user-${String(seq)}`;
      const rows = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ($1, $1, 'x', $2) RETURNING id`,
        [login, role],
      );
      const id = Number(rows[0]?.id);
      for (const [index, group] of groups.entries()) {
        await db.query(
          `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, $3)`,
          [group, id, index === 0],
        );
      }
      return { id, login };
    };

    const viewer = (userId: number, role: ReportViewer['role'] = 'readwrite'): ReportViewer => ({
      userId,
      role,
    });

    beforeEach(() => {
      seq += 1;
    });

    /** Points a report at another account, as an administrator — nobody else may (`A-13`). */
    const repoint = (report: { id: number; version: number }, login: string) =>
      reports.update(
        viewer(administrator.id, 'admin'),
        report.id,
        report.version,
        { runAs: login },
        actorNamed(administrator.login),
      );

    describe('access, answered the same way a map answers it', () => {
      it('gives a creator’s primary group full access, so they keep what they made', async () => {
        const group = await makeGroup(`r-creators-${String(seq)}`);
        const user = await makeUser([group]);
        const report = await reports.create(
          viewer(user.id),
          { name: `mine-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );

        assert.equal(await reports.rightFor(viewer(user.id), report.id), 'full');
        assert.equal((await reports.get(viewer(user.id), report.id)).id, report.id);
      });

      it('lets nobody create a report who could not change one', async () => {
        // **`A-14`, at the service as well as at the route**, for the reason `maps-service`
        // gives: a new report has no right to cap, so the role and the token are the only
        // ceilings — and they were not consulted.
        const user = await makeUser([await makeGroup(`r-not-creators-${String(seq)}`)]);
        for (const who of [
          { userId: user.id, role: 'readonly' as const },
          { userId: user.id, role: 'readwrite' as const, scope: 'read' as const },
        ]) {
          const name = `refused-${who.role}-${String(seq)}`;
          await assert.rejects(
            () => reports.create(who, { name, kind: 'table_only' }, actorNamed(user.login)),
            (error: unknown) => {
              assert.equal((error as { code: string }).code, 'REPORT_FORBIDDEN');
              return true;
            },
          );
          assert.equal((await db.query(`SELECT 1 FROM report WHERE name = $1`, [name])).length, 0);
        }
        await reports.create(
          { userId: user.id, role: 'readwrite', scope: 'write' },
          { name: `allowed-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );
      });

      it('hides a report from an account with no grant, as absent rather than forbidden', async () => {
        const owner = await makeUser([await makeGroup(`r-owner-${String(seq)}`)]);
        const report = await reports.create(
          viewer(owner.id),
          { name: `secret-${String(seq)}`, kind: 'graph_only' },
          actorNamed(owner.login),
        );
        const stranger = await makeUser([await makeGroup(`r-stranger-${String(seq)}`)]);

        await assert.rejects(
          () => reports.get(viewer(stranger.id), report.id),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'REPORT_NOT_FOUND');
            return true;
          },
        );
      });

      it('lets an administrator group in without a grant', async () => {
        const owner = await makeUser([await makeGroup(`r-owner2-${String(seq)}`)]);
        const report = await reports.create(
          viewer(owner.id),
          { name: `admin-sees-${String(seq)}`, kind: 'sensor_list' },
          actorNamed(owner.login),
        );
        const admin = await makeUser([await makeGroup(`r-admins-${String(seq)}`, true)]);

        assert.equal(await reports.rightFor(viewer(admin.id), report.id), 'full');
      });

      it('caps what a group granted by the account’s role, and by a token’s scope', async () => {
        const user = await makeUser([await makeGroup(`r-capped-${String(seq)}`)]);
        const report = await reports.create(
          viewer(user.id),
          { name: `capped-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );

        assert.equal(await reports.rightFor(viewer(user.id, 'readonly'), report.id), 'read');
        assert.equal(
          await reports.rightFor({ userId: user.id, role: 'readwrite', scope: 'read' }, report.id),
          'read',
        );
        await assert.rejects(
          () =>
            reports.update(
              viewer(user.id, 'readonly'),
              report.id,
              report.version,
              { description: 'no' },
              actorNamed(user.login),
            ),
          /may not write/,
        );
      });

      it('lists only what the viewer may see, and everything for an administrator', async () => {
        const name = `listed-${String(seq)}`;
        const user = await makeUser([await makeGroup(`r-list-mine-${String(seq)}`)]);
        await reports.create(viewer(user.id), { name, kind: 'top_uptime' }, actorNamed(user.login));

        const stranger = await makeUser([await makeGroup(`r-list-other-${String(seq)}`)]);
        const admin = await makeUser([await makeGroup(`r-list-admin-${String(seq)}`, true)]);

        const theirs = await reports.list(viewer(user.id));
        assert.ok(theirs.some((one) => one.name === name));
        assert.equal((await reports.list(viewer(stranger.id))).length, 0);
        assert.ok((await reports.list(viewer(admin.id))).length >= theirs.length);
      });

      it('refuses a write against a version that has moved on', async () => {
        const user = await makeUser([await makeGroup(`r-conc-${String(seq)}`)]);
        const report = await reports.create(
          viewer(user.id),
          { name: `conc-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );

        const first = await reports.update(
          viewer(user.id),
          report.id,
          report.version,
          { description: 'first' },
          actorNamed(user.login),
        );
        assert.equal(first.version, report.version + 1);

        await assert.rejects(
          () =>
            reports.update(
              viewer(user.id),
              report.id,
              report.version,
              { description: 'second' },
              actorNamed(user.login),
            ),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'REPORT_CHANGED');
            assert.deepEqual((error as { details: unknown }).details, {
              expectedVersion: report.version,
              actualVersion: first.version,
            });
            return true;
          },
        );
      });

      it('needs full to grant, replaces a repeat grant, and gives access back on revoke', async () => {
        const owner = await makeUser([await makeGroup(`r-g-owner-${String(seq)}`)]);
        const report = await reports.create(
          viewer(owner.id),
          { name: `granting-${String(seq)}`, kind: 'table_only' },
          actorNamed(owner.login),
        );

        const editorGroup = await makeGroup(`r-g-editor-${String(seq)}`);
        const editor = await makeUser([editorGroup]);
        await reports.grant(
          viewer(owner.id),
          report.id,
          editorGroup,
          'write',
          actorNamed(owner.login),
        );
        assert.equal(await reports.rightFor(viewer(editor.id), report.id), 'write');

        await assert.rejects(
          () =>
            reports.grant(
              viewer(editor.id),
              report.id,
              editorGroup,
              'full',
              actorNamed(editor.login),
            ),
          /may not full/,
        );

        // Granting twice is a correction, not a collision.
        await reports.grant(
          viewer(owner.id),
          report.id,
          editorGroup,
          'read',
          actorNamed(owner.login),
        );
        const grants = await reports.grants(viewer(owner.id), report.id);
        assert.equal(grants.filter((one) => one.groupId === editorGroup).length, 1);
        assert.equal(grants.find((one) => one.groupId === editorGroup)?.right, 'read');

        await reports.revoke(viewer(owner.id), report.id, editorGroup, actorNamed(owner.login));
        assert.equal(await reports.rightFor(viewer(editor.id), report.id), 'none');
      });

      it('refuses a grant to a group that does not exist', async () => {
        const owner = await makeUser([await makeGroup(`r-g3-${String(seq)}`)]);
        const report = await reports.create(
          viewer(owner.id),
          { name: `nogroup-${String(seq)}`, kind: 'table_only' },
          actorNamed(owner.login),
        );
        await assert.rejects(
          () =>
            reports.grant(viewer(owner.id), report.id, 999_999, 'read', actorNamed(owner.login)),
          /there is no group/,
        );
      });

      it('needs full to delete, because deleting takes the grants with it', async () => {
        const owner = await makeUser([await makeGroup(`r-del-owner-${String(seq)}`)]);
        const report = await reports.create(
          viewer(owner.id),
          { name: `deleted-${String(seq)}`, kind: 'table_only' },
          actorNamed(owner.login),
        );
        const writerGroup = await makeGroup(`r-del-writer-${String(seq)}`);
        const writer = await makeUser([writerGroup]);
        await reports.grant(
          viewer(owner.id),
          report.id,
          writerGroup,
          'write',
          actorNamed(owner.login),
        );

        await assert.rejects(
          () => reports.remove(viewer(writer.id), report.id, actorNamed(writer.login)),
          /may not full/,
        );
        await reports.remove(viewer(owner.id), report.id, actorNamed(owner.login));

        const rows = await db.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM report_access WHERE report_id = $1`,
          [report.id],
        );
        assert.equal(rows[0]?.total, '0', 'the grants went with the report');
      });
    });

    describe('the security context, which is what §6 adds over a map', () => {
      it('defaults to the account that created it, and stores the account’s own spelling', async () => {
        const user = await makeUser([await makeGroup(`r-ctx-${String(seq)}`)]);
        const report = await reports.create(
          viewer(user.id),
          { name: `ctx-${String(seq)}`, kind: 'table_only' },
          // Typed in a different case than the account is stored as. Both halves of the context
          // have to agree, or the refusal message names something nobody can look up.
          actorNamed(user.login.toUpperCase()),
        );

        assert.equal(report.runAsUserId, user.id);
        assert.equal(report.runAsLogin, user.login);
      });

      it('refuses a context naming nobody, at the write rather than at 3am on a schedule', async () => {
        // An administrator, because only an administrator may name anybody but themselves
        // (`A-13`) — and so only an administrator is told that the name they typed is nobody.
        const user = administrator;
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id, 'admin'),
              { name: `ghost-${String(seq)}`, kind: 'table_only', runAs: 'nobody-at-all' },
              actorNamed(user.login),
            ),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, 'REPORT_USER_NOT_FOUND');
            assert.equal((error as { status: number }).status, 404);
            return true;
          },
        );
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id, 'admin'),
              { name: `blank-${String(seq)}`, kind: 'table_only', runAs: '   ' },
              actorNamed(user.login),
            ),
          /needs an account to render through/,
        );
      });

      it('lets nobody but an administrator name an account other than their own', async () => {
        // **`A-13`, at the one place it is decided.** A report renders through its `runAs`
        // account, so naming somebody else is reading as them — and the creator holds `full` on a
        // new report a moment later, which is how `update`'s `full` rule was walked round on the
        // way in. Refused on create and on update alike, and before the account is looked up, so
        // the refusal cannot be used to ask which logins exist.
        const team = await makeGroup(`r-ctx6-team-${String(seq)}`);
        const owner = await makeUser([team]);
        const target = await makeUser([team]);

        const refused = (error: unknown): boolean => {
          assert.equal((error as { code: string }).code, 'REPORT_FORBIDDEN');
          assert.equal((error as { status: number }).status, 403);
          return true;
        };
        for (const runAs of [target.login, 'nobody-at-all']) {
          await assert.rejects(
            () =>
              reports.create(
                viewer(owner.id),
                { name: `borrowed-${runAs}-${String(seq)}`, kind: 'table_only', runAs },
                actorNamed(owner.login),
              ),
            refused,
          );
        }
        // An administrator acting through a token below `full` is not acting as one.
        await assert.rejects(
          () =>
            reports.create(
              { userId: administrator.id, role: 'admin', scope: 'write' },
              { name: `borrowed-token-${String(seq)}`, kind: 'table_only', runAs: target.login },
              actorNamed(administrator.login),
            ),
          refused,
        );

        const report = await reports.create(
          viewer(owner.id),
          { name: `own-eyes-${String(seq)}`, kind: 'table_only', runAs: owner.login.toUpperCase() },
          actorNamed(owner.login),
        );
        assert.equal(report.runAsUserId, owner.id, 'naming yourself is not borrowing anything');
        await assert.rejects(
          () =>
            reports.update(
              viewer(owner.id),
              report.id,
              report.version,
              { runAs: target.login },
              actorNamed(owner.login),
            ),
          refused,
        );

        const moved = await repoint(report, target.login);
        assert.equal(moved.runAsUserId, target.id, 'and an administrator may');
      });

      it('needs full to change it — a write holder may change what, not as whom', async () => {
        // **The rule this ticket is most likely to get wrong.** Everything else in `update` edits
        // a document; this field decides whose data the output contains, which is the same class
        // of act as granting access. A `write` holder who could set it could read, through a
        // report, everything an administrator can see.
        const owner = await makeUser([await makeGroup(`r-ctx3-owner-${String(seq)}`)]);
        const report = await reports.create(
          viewer(owner.id),
          { name: `whose-${String(seq)}`, kind: 'table_only' },
          actorNamed(owner.login),
        );
        const writerGroup = await makeGroup(`r-ctx3-writer-${String(seq)}`);
        const writer = await makeUser([writerGroup]);
        await reports.grant(
          viewer(owner.id),
          report.id,
          writerGroup,
          'write',
          actorNamed(owner.login),
        );

        // The same holder, editing anything else, is fine.
        const edited = await reports.update(
          viewer(writer.id),
          report.id,
          report.version,
          { description: 'a writer may do this' },
          actorNamed(writer.login),
        );
        assert.equal(edited.description, 'a writer may do this');

        await assert.rejects(
          () =>
            reports.update(
              viewer(writer.id),
              report.id,
              edited.version,
              { runAs: writer.login },
              actorNamed(writer.login),
            ),
          /may not full/,
        );
        // And it did not change underneath the refusal.
        assert.equal((await reports.get(viewer(owner.id), report.id)).runAsLogin, owner.login);

        // `full` is necessary and, for anybody but the holder's own account, not sufficient
        // (`A-13`): the owner may not point it at the writer either. An administrator may.
        await assert.rejects(
          () =>
            reports.update(
              viewer(owner.id),
              report.id,
              edited.version,
              { runAs: writer.login },
              actorNamed(owner.login),
            ),
          /only an administrator/,
        );
        const moved = await repoint(edited, writer.login);
        assert.equal(moved.runAsUserId, writer.id);
      });

      it('leaves a readable broken state when the account goes, never an unscoped report', async () => {
        // Migration 047's whole claim, asserted against the database rather than trusted: the id
        // is nulled and **the login survives**, so `E-03` can refuse and name whose scope was
        // lost. The failure this guards against is a report that silently starts rendering with
        // no scope at all — which, for a scheduler with no session, is one careless join away
        // from every object in the installation.
        const owner = await makeUser([await makeGroup(`r-ctx4-owner-${String(seq)}`)]);
        const doomed = await makeUser([await makeGroup(`r-ctx4-doomed-${String(seq)}`)]);
        const report = await repoint(
          await reports.create(
            viewer(owner.id),
            { name: `orphaned-${String(seq)}`, kind: 'table_only' },
            actorNamed(owner.login),
          ),
          doomed.login,
        );
        assert.equal(report.runAsUserId, doomed.id);

        await db.query(`DELETE FROM user_account WHERE id = $1`, [doomed.id]);

        const after_ = await reports.get(viewer(owner.id), report.id);
        assert.equal(after_.runAsUserId, null, 'the id went with the account');
        assert.equal(after_.runAsLogin, doomed.login, 'and the name it was set to did not');

        // The refusal that state is for. `E-03` is the caller; this is the shape it will use,
        // and 422 rather than 403 because no right the caller could hold would fix it.
        const refusal = contextLost(after_.id, after_.runAsLogin);
        assert.equal(refusal.status, 422);
        assert.match(refusal.message, new RegExp(doomed.login));
      });

      it('can be repointed at a live account once it is lost', async () => {
        const owner = await makeUser([await makeGroup(`r-ctx5-owner-${String(seq)}`)]);
        const doomed = await makeUser([await makeGroup(`r-ctx5-doomed-${String(seq)}`)]);
        const report = await repoint(
          await reports.create(
            viewer(owner.id),
            { name: `repointed-${String(seq)}`, kind: 'table_only' },
            actorNamed(owner.login),
          ),
          doomed.login,
        );
        await db.query(`DELETE FROM user_account WHERE id = $1`, [doomed.id]);

        const broken = await reports.get(viewer(owner.id), report.id);
        const fixed = await reports.update(
          viewer(owner.id),
          report.id,
          broken.version,
          { runAs: owner.login },
          actorNamed(owner.login),
        );
        assert.equal(fixed.runAsUserId, owner.id);
        assert.equal(fixed.runAsLogin, owner.login);
      });
    });

    describe('the span, which the service validates on the write (E-02)', () => {
      it('defaults to last month, so a scheduled report is never about two hours', async () => {
        const user = await makeUser([await makeGroup(`r-span-${String(seq)}`)]);
        const report = await reports.create(
          viewer(user.id),
          { name: `span-default-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );
        assert.deepEqual(report.span, { kind: 'month', offset: 1 });
      });

      it('stores what it accepted, through a round trip to jsonb and back', async () => {
        const user = await makeUser([await makeGroup(`r-span2-${String(seq)}`)]);
        const span = { kind: 'quarter', offset: 2, timezone: 'Pacific/Chatham' };
        const report = await reports.create(
          viewer(user.id),
          { name: `span-kept-${String(seq)}`, kind: 'graph_only', span },
          actorNamed(user.login),
        );
        assert.deepEqual((await reports.get(viewer(user.id), report.id)).span, span);
      });

      it('refuses a span at the write rather than letting it fail on a schedule', async () => {
        // The same argument as the security context: the person who typed it is at a keyboard
        // now, and asleep when the schedule fires.
        const user = await makeUser([await makeGroup(`r-span3-${String(seq)}`)]);
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              { name: `span-bad-${String(seq)}`, kind: 'table_only', span: { kind: 'fortnight' } },
              actorNamed(user.login),
            ),
          /no report span called/,
        );

        const report = await reports.create(
          viewer(user.id),
          { name: `span-edit-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );
        await assert.rejects(
          () =>
            reports.update(
              viewer(user.id),
              report.id,
              report.version,
              { span: { kind: 'month', timezone: 'Mars/Olympus_Mons' } },
              actorNamed(user.login),
            ),
          /not a time zone this system knows/,
        );
        // And the refusal left the stored span alone.
        assert.deepEqual((await reports.get(viewer(user.id), report.id)).span, {
          kind: 'month',
          offset: 1,
        });
      });
    });

    describe('validation', () => {
      it('refuses a blank name, an over-long one, and a duplicate whatever its case', async () => {
        const user = await makeUser([await makeGroup(`r-v-${String(seq)}`)]);
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              { name: '  ', kind: 'table_only' },
              actorNamed(user.login),
            ),
          /1 to 100/,
        );
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              { name: 'x'.repeat(101), kind: 'table_only' },
              actorNamed(user.login),
            ),
          /1 to 100/,
        );
        await reports.create(
          viewer(user.id),
          { name: `Dup-${String(seq)}`, kind: 'table_only' },
          actorNamed(user.login),
        );
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              { name: `dup-${String(seq)}`, kind: 'table_only' },
              actorNamed(user.login),
            ),
          /already exists/,
        );
      });

      it('refuses a template that is not one of the seven', async () => {
        const user = await makeUser([await makeGroup(`r-v2-${String(seq)}`)]);
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              { name: `kind-${String(seq)}`, kind: 'graph_and_tabel' },
              actorNamed(user.login),
            ),
          /no report template called/,
        );
      });

      it('deduplicates subjects and bounds how many a report may cover', async () => {
        const user = await makeUser([await makeGroup(`r-v3-${String(seq)}`)]);
        const report = await reports.create(
          viewer(user.id),
          {
            name: `subjects-${String(seq)}`,
            kind: 'sensor_list',
            subjects: { objectIds: [7, 7, 9] },
          },
          actorNamed(user.login),
        );
        assert.deepEqual(report.subjects.objectIds, [7, 9]);

        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              {
                name: `toomany-${String(seq)}`,
                kind: 'sensor_list',
                subjects: { objectIds: Array.from({ length: 501 }, (_, i) => i + 1) },
              },
              actorNamed(user.login),
            ),
          /at most 500 objects/,
        );
        await assert.rejects(
          () =>
            reports.create(
              viewer(user.id),
              { name: `bad-${String(seq)}`, kind: 'sensor_list', subjects: { objectIds: [0] } },
              actorNamed(user.login),
            ),
          /is not an object id/,
        );
      });

      it('keeps a subject whose object has been deleted, rather than dropping it', async () => {
        // **The reason `subjects` is a document and not child rows.** A report is read later, by
        // somebody who was not there; a sensor that leaves the installation must leave a row in
        // the output that says so rather than silently vanishing from a monthly summary.
        const user = await makeUser([await makeGroup(`r-v4-${String(seq)}`)]);
        const doomed = await harness.service.create(testActor, {
          kind: 'probe',
          name: `doomed-probe-${String(seq)}`,
          parentId: harness.rootId,
        });
        const objectId = doomed.id;
        const report = await reports.create(
          viewer(user.id),
          {
            name: `survives-${String(seq)}`,
            kind: 'sensor_list',
            subjects: { objectIds: [objectId] },
          },
          actorNamed(user.login),
        );

        await db.query(`DELETE FROM object WHERE id = $1`, [objectId]);

        const reread = await reports.get(viewer(user.id), report.id);
        assert.deepEqual(reread.subjects.objectIds, [objectId]);
      });
    });
  },
);

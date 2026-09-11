import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { AccessService } from '../src/auth/access.js';
import { ReportContext } from '../src/reports/context.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService, type ReportViewer } from '../src/reports/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Whose eyes a report renders through (`E-03`, `CAPABILITIES.MD §6`).
 *
 * **Scenario tests, because the thing to prove is a negative.** Every case below builds a real
 * tree, real accounts, real grants, and asks what a report would contain — the question the
 * renderer will ask. A unit test of "does it call `AccessService`" would pass while the answer was
 * wrong; these fail if a report ever contains an object the account it names could not open.
 *
 * The scenario is the same throughout, and it is the one an installation actually has: a probe
 * with two devices, one team granted each, and an account in one of those teams.
 */
describe('a report’s security context', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let reports: ReportService;
  let context: ReportContext;

  let rootId: number;
  let salesDeviceId: number;
  let opsDeviceId: number;
  let salesSensorId: number;
  let opsSensorId: number;
  let credentialSensorId: number;
  let deletedSensorId: number;

  let salesGroup: number;
  let opsGroup: number;
  let adminGroup: number;

  before(async () => {
    scratch = await createScratchDatabase('reportctx');
    db = scratch.db;
    const harness = await buildHarness(db);
    rootId = harness.rootId;
    const repository = new ReportRepository();
    reports = new ReportService({ db, repository, logger: silent });
    context = new ReportContext({
      db,
      repository,
      access: new AccessService({ db, logger: silent }),
      logger: silent,
    });

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      name: 'ctx-probe',
      parentId: rootId,
    });
    const sales = await harness.service.create(testActor, {
      kind: 'device',
      name: 'sales-db',
      parentId: probe.id,
      host: '10.0.0.10',
    });
    const ops = await harness.service.create(testActor, {
      kind: 'device',
      name: 'ops-router',
      parentId: probe.id,
      host: '10.0.0.20',
    });
    salesDeviceId = sales.id;
    opsDeviceId = ops.id;

    salesSensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'sales-ping',
        parentId: sales.id,
        sensorType: 'icmp.ping',
      })
    ).id;
    opsSensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'ops-ping',
        parentId: ops.id,
        sensorType: 'icmp.ping',
      })
    ).id;
    // A sensor carrying a `writeOnly` parameter, on the side the report *can* see — so a
    // projection that leaked one would leak it here rather than being saved by access control.
    credentialSensorId = (
      await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'sales-snmp',
        parentId: sales.id,
        sensorType: 'snmp.traffic',
        params: { community: 'super-secret-community', port: 161 },
      })
    ).id;

    const doomed = await harness.service.create(testActor, {
      kind: 'sensor',
      name: 'was-a-sensor',
      parentId: sales.id,
      sensorType: 'icmp.ping',
    });
    deletedSensorId = doomed.id;
    await db.query('DELETE FROM object WHERE id = $1', [deletedSensorId]);

    salesGroup = await makeGroup('sales');
    opsGroup = await makeGroup('ops');
    adminGroup = await makeGroup('admins', true);
    await db.query(
      `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'read'), ($3, $4, 'read')`,
      [salesDeviceId, salesGroup, opsDeviceId, opsGroup],
    );
  });

  after(async () => {
    await scratch.drop();
  });

  const makeGroup = async (name: string, isAdmin = false): Promise<number> => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO user_group (name, is_admin) VALUES ($1, $2) RETURNING id`,
      [name, isAdmin],
    );
    return Number(rows[0]?.id);
  };

  let seq = 0;

  const makeUser = async (
    groups: number[],
    role = 'readwrite',
  ): Promise<{ id: number; login: string }> => {
    seq += 1;
    const login = `ctx-user-${String(seq)}`;
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

  const viewer = (userId: number): ReportViewer => ({ userId, role: 'readwrite' });

  /** A report over every subject in the fixture, rendered as somebody. */
  const reportAs = async (
    owner: { id: number; login: string },
    runAs: string,
    subjects: number[] = [salesSensorId, opsSensorId, credentialSensorId, deletedSensorId],
  ) => {
    seq += 1;
    return reports.create(
      viewer(owner.id),
      {
        name: `scenario-${String(seq)}`,
        kind: 'sensor_list',
        subjects: { objectIds: subjects },
        runAs,
      },
      owner.login,
    );
  };

  describe('decides what a report contains, and it is not what the scheduler could see', () => {
    it('renders what the named account can read, and nothing from the branch it cannot', async () => {
      // **The whole ticket in one case.** An account in `sales` builds a report naming sensors on
      // both devices. The ops sensor is real, is named in the document, and must not appear.
      const author = await makeUser([salesGroup]);
      const report = await reportAs(author, author.login);

      const resolved = await context.subjectsFor(report);
      const names = resolved.visible.map((one) => one.name).sort();
      assert.deepEqual(names, ['sales-ping', 'sales-snmp']);
      assert.ok(!resolved.visible.some((one) => one.id === opsSensorId));
      assert.deepEqual(
        [...resolved.unavailable].sort((a, b) => a - b),
        [opsSensorId, deletedSensorId].sort((a, b) => a - b),
      );
    });

    it('follows the account named, not the account that asked', async () => {
      // The failure this exists to catch: a renderer that used the caller's rights. An `ops`
      // account reading a report that runs as a `sales` account gets sales' data — and an
      // `ops`-scoped report stays ops-scoped no matter who reads it.
      const salesUser = await makeUser([salesGroup]);
      const opsUser = await makeUser([opsGroup]);

      const asSales = await reportAs(salesUser, salesUser.login);
      const asOps = await reportAs(salesUser, opsUser.login);

      assert.deepEqual((await context.subjectsFor(asSales)).visible.map((one) => one.name).sort(), [
        'sales-ping',
        'sales-snmp',
      ]);
      assert.deepEqual(
        (await context.subjectsFor(asOps)).visible.map((one) => one.name),
        ['ops-ping'],
      );
    });

    it('is not widened by the report’s own grants', async () => {
      // **The asymmetry, stated as a test.** Being able to read a report gives you everything its
      // `runAs` account can see — that is the act-as grant. It does not work the other way: the
      // report's ACL never adds to what the context may read.
      const salesUser = await makeUser([salesGroup]);
      const report = await reportAs(salesUser, salesUser.login);
      // Grant the ops team full access to the *report*. It still contains only sales data.
      await reports.grant(viewer(salesUser.id), report.id, opsGroup, 'full', salesUser.login);

      const resolved = await context.subjectsFor(
        await reports.get(viewer(salesUser.id), report.id),
      );
      assert.deepEqual(
        resolved.visible.map((one) => one.name).sort(),
        ['sales-ping', 'sales-snmp'],
        'a grant on the report did not grant its context anything',
      );
    });

    it('applies the role ceiling, so a read-only account is still a read-only context', async () => {
      // `A-04`: a role is a ceiling, not a starting point. The context resolves at `read`, which
      // is all a report needs — the test is that the ceiling reaches here at all.
      const readOnly = await makeUser([salesGroup], 'readonly');
      const report = await reportAs(readOnly, readOnly.login, [salesSensorId]);

      const resolved = await context.subjectsFor(report);
      assert.equal(resolved.principal.role, 'readonly');
      assert.equal(await context.rightOn(resolved.principal, salesSensorId), 'read');
      assert.deepEqual(
        resolved.visible.map((one) => one.name),
        ['sales-ping'],
      );
    });

    it('lets an administrator context see the whole tree, with no grant anywhere', async () => {
      const admin = await makeUser([adminGroup]);
      const author = await makeUser([salesGroup]);
      const report = await reportAs(author, admin.login);

      const resolved = await context.subjectsFor(report);
      assert.deepEqual(resolved.visible.map((one) => one.name).sort(), [
        'ops-ping',
        'sales-ping',
        'sales-snmp',
      ]);
      assert.deepEqual(
        resolved.unavailable,
        [deletedSensorId],
        'and still cannot see a deleted one',
      );
    });

    it('counts what it will not render rather than dropping it', async () => {
      // `CLAUDE.md`'s "no-data is not zero", applied to subjects. A report that silently covers
      // two of the four sensors it names is the most durable way this system can lie.
      const author = await makeUser([salesGroup]);
      const report = await reportAs(author, author.login);
      const resolved = await context.subjectsFor(report);
      assert.equal(
        resolved.visible.length + resolved.unavailable.length,
        report.subjects.objectIds.length,
        'every subject is accounted for, in one list or the other',
      );
    });

    it('will not say whether an unavailable subject is deleted or merely out of scope', async () => {
      // **An existence oracle, closed.** A `write` holder on a report needs no access to the tree,
      // so telling "forbidden" from "gone" would let anybody who can edit a report enumerate every
      // object id in the installation: add ids, resolve, read which ones came back as forbidden.
      const author = await makeUser([salesGroup]);
      const report = await reportAs(author, author.login, [opsSensorId, deletedSensorId]);
      const resolved = await context.subjectsFor(report);

      assert.equal(resolved.unavailable.length, 2);
      assert.ok(
        resolved.unavailable.includes(opsSensorId) &&
          resolved.unavailable.includes(deletedSensorId),
        'both are unavailable',
      );
      // A bare list of numbers: there is nowhere to put the distinction even by accident.
      for (const entry of resolved.unavailable) assert.equal(typeof entry, 'number');
    });
  });

  describe('never carries a credential out with it', () => {
    it('projects identity only, so there is nowhere to put a writeOnly parameter', async () => {
      // `CLAUDE.md`: credentials are never returned by any route, to anyone. The strongest form
      // of that is a shape with no field for one — this asserts the shape, so widening it later
      // fails here rather than in a rendered PDF.
      const author = await makeUser([salesGroup]);
      const report = await reportAs(author, author.login, [credentialSensorId]);
      const resolved = await context.subjectsFor(report);

      const subject = resolved.visible[0];
      assert.ok(subject);
      assert.deepEqual(Object.keys(subject).sort(), ['id', 'kind', 'name']);
      assert.equal(
        JSON.stringify(resolved).includes('super-secret-community'),
        false,
        'the community string is nowhere in what a renderer is handed',
      );
    });
  });

  describe('refuses to run rather than running unscoped', () => {
    it('stops when the account has been deleted, and names it', async () => {
      const author = await makeUser([salesGroup]);
      const doomed = await makeUser([salesGroup]);
      const report = await reportAs(author, doomed.login, [salesSensorId]);
      await db.query(`DELETE FROM user_account WHERE id = $1`, [doomed.id]);

      const reread = await reports.get(viewer(author.id), report.id);
      await assert.rejects(
        () => context.subjectsFor(reread),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_NO_CONTEXT');
          assert.equal((error as { status: number }).status, 422);
          assert.match((error as { message: string }).message, new RegExp(doomed.login));
          return true;
        },
      );
    });

    it('stops when the account has been disabled, which E-01 could not see', async () => {
      // **The hole this ticket found.** A deleted account nulls the reference; a *disabled* one
      // keeps its row, so nothing in `E-01` would have noticed and the report would go on
      // rendering through a departed colleague's scope indefinitely. Disabling is how `031` says
      // this system revokes an account, so ignoring it makes revocation not work for the one path
      // that runs unattended.
      const author = await makeUser([salesGroup]);
      const departing = await makeUser([adminGroup]);
      const report = await reportAs(author, departing.login, [salesSensorId, opsSensorId]);

      // While enabled, that context sees everything — which is what makes the refusal matter.
      assert.equal((await context.subjectsFor(report)).visible.length, 2);

      await db.query(`UPDATE user_account SET disabled = true WHERE id = $1`, [departing.id]);

      const reread = await reports.get(viewer(author.id), report.id);
      await assert.rejects(
        () => context.subjectsFor(reread),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'REPORT_NO_CONTEXT');
          assert.equal((error as { status: number }).status, 422);
          assert.match((error as { message: string }).message, /disabled/);
          assert.equal(
            (error as { details: { reason: string } }).details.reason,
            'disabled',
            'and says which of the two ways the context was lost',
          );
          return true;
        },
      );
      // And the read API says so without being asked twice.
      assert.equal(reread.runAsDisabled, true);
    });

    it('keeps running for an account that is merely locked out', async () => {
      // Lockout is `A-08`'s brute-force defence and is transient: it says somebody is guessing
      // that account's password, not that the account should stop existing. Stopping a monthly
      // report for it would be a denial of service anybody could trigger from the login form.
      const author = await makeUser([salesGroup]);
      const report = await reportAs(author, author.login, [salesSensorId]);
      await db.query(
        `UPDATE user_account SET locked_until = now() + interval '1 hour' WHERE id = $1`,
        [author.id],
      );

      const resolved = await context.subjectsFor(await reports.get(viewer(author.id), report.id));
      assert.deepEqual(
        resolved.visible.map((one) => one.name),
        ['sales-ping'],
      );
    });

    it('refuses before it reads anything, so a broken context cannot leak a name', async () => {
      const author = await makeUser([salesGroup]);
      const admin = await makeUser([adminGroup]);
      const report = await reportAs(author, admin.login, [opsSensorId]);
      await db.query(`UPDATE user_account SET disabled = true WHERE id = $1`, [admin.id]);

      const reread = await reports.get(viewer(author.id), report.id);
      await assert.rejects(
        () => context.subjectsFor(reread),
        (error: unknown) => {
          assert.equal(
            JSON.stringify(error).includes('ops-ping'),
            false,
            'the refusal carries no object it was about to render',
          );
          return true;
        },
      );
    });
  });
});

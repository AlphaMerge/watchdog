import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService, Visibility } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import type { Database, Queryable } from '../src/db/pool.js';
import {
  INSTALLATION_VOUCHES,
  refusal,
  type Found,
  type Voucher,
  type WrittenReads,
  type Writer,
} from '../src/objects/sensor-reads.js';
import type { ObjectKind } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { actorNamed, buildHarness, testActor, type Harness } from './support/tree.js';

/**
 * `A-29`: a sensor's parameters may name only what its writer can read.
 *
 * A Sensor Factory republishes the readings its formula names, and a Probe Health sensor the
 * health of the probe it names, to everybody who can read the sensor. So every write that leaves
 * one behind — create, edit, a created tree, a move, a clone — is checked through the eyes of
 * the account that wrote it, and the rules are a table: the pure half first, then each type
 * through each write path against a real tree and a real account's grants.
 */

// ── the rules, without a database ────────────────────────────────────────────────────────────

const ACCOUNT: Voucher = { kind: 'account', userId: 7, sees: Visibility.EVERYTHING };

const naming = (objectId: number, expects: 'sensor' | 'probe' = 'sensor'): WrittenReads => ({
  named: [{ sensorName: 'Sum', param: 'channels[0].formula', objectId, expects }],
  bars: [],
  sayWhich: false,
});

const found = (
  kinds: readonly [number, ObjectKind][],
  readable: readonly number[],
  rootReadable = true,
): Found => ({ kinds: new Map(kinds), readable: new Set(readable), rootReadable });

/** What a caller can observe of a refusal: everything but the stack. */
function observed(error: Error | null): Record<string, unknown> | null {
  if (error === null) return null;
  const app = error as Error & { code?: string; status?: number; context?: unknown };
  return {
    name: app.name,
    code: app.code,
    status: app.status,
    message: app.message,
    context: app.context,
  };
}

describe('what a written sensor may name, as rules', () => {
  it('refuses a hidden object and a missing one in the same words', () => {
    // The whole point of the shared wording: a formula must not be a way to learn which ids
    // exist. Only the id differs, and the caller supplied that.
    const hidden = observed(refusal(ACCOUNT, naming(42), found([[42, 'sensor']], [])));
    const missing = observed(refusal(ACCOUNT, naming(42), found([], [])));
    assert.ok(hidden !== null);
    assert.deepEqual(hidden, missing);
    assert.equal(hidden['status'], 403);
    assert.equal(hidden['code'], 'AUTH_FORBIDDEN');
    assert.equal(
      hidden['message'],
      'channels[0].formula names object 42, which does not exist or which you cannot read',
    );
  });

  it('says what kind an object is only when the writer can read it', () => {
    const cases: {
      name: string;
      voucher: Voucher;
      written: WrittenReads;
      found: Found;
      status: number | null;
      message?: RegExp;
    }[] = [
      {
        name: 'a readable sensor, named as a sensor',
        voucher: ACCOUNT,
        written: naming(42),
        found: found([[42, 'sensor']], [42]),
        status: null,
      },
      {
        name: 'a readable device, named as a sensor',
        voucher: ACCOUNT,
        written: naming(42),
        found: found([[42, 'device']], [42]),
        status: 400,
        message: /names object 42, which is a device, not a sensor$/,
      },
      {
        // Saying "that is a device" of something hidden would be the leak by another route.
        name: 'a hidden device, named as a sensor',
        voucher: ACCOUNT,
        written: naming(42),
        found: found([[42, 'device']], []),
        status: 403,
        message: /which does not exist or which you cannot read$/,
      },
      {
        name: 'a readable probe, named as a probe',
        voucher: ACCOUNT,
        written: naming(3, 'probe'),
        found: found([[3, 'probe']], [3]),
        status: null,
      },
      {
        name: 'a readable group, named as a probe',
        voucher: ACCOUNT,
        written: naming(3, 'probe'),
        found: found([[3, 'group']], [3]),
        status: 400,
        message: /which is a group, not a probe$/,
      },
      {
        // The installation hides nothing from itself, so "missing" can say so plainly.
        name: 'the installation, naming something missing',
        voucher: INSTALLATION_VOUCHES,
        written: naming(42),
        found: found([], []),
        status: 400,
        message: /names object 42, which does not exist$/,
      },
      {
        name: 'the installation, naming something no account could read',
        voucher: INSTALLATION_VOUCHES,
        written: naming(42),
        found: found([[42, 'sensor']], [], false),
        status: null,
      },
      {
        name: 'the installation, naming the wrong kind',
        voucher: INSTALLATION_VOUCHES,
        written: naming(42),
        found: found([[42, 'group']], []),
        status: 400,
        message: /which is a group, not a sensor$/,
      },
      {
        name: 'the installation bar, for an account that cannot read the root',
        voucher: ACCOUNT,
        written: {
          named: [],
          bars: [{ sensorName: 'CH', sensorType: 'ms.core.health' }],
          sayWhich: false,
        },
        found: found([], [], false),
        status: 403,
        message: /^a ms\.core\.health sensor reports on the whole installation/,
      },
      {
        name: 'the installation bar, for an account that can',
        voucher: ACCOUNT,
        written: {
          named: [],
          bars: [{ sensorName: 'CH', sensorType: 'ms.core.health' }],
          sayWhich: false,
        },
        found: found([], [], true),
        status: null,
      },
      {
        name: 'the installation bar, for the installation',
        voucher: INSTALLATION_VOUCHES,
        written: {
          named: [],
          bars: [{ sensorName: 'CH', sensorType: 'ms.core.health' }],
          sayWhich: false,
        },
        found: found([], [], false),
        status: null,
      },
      {
        // A move of a group has to say which of its sensors is the problem.
        name: 'a refusal about a sensor inside a subtree',
        voucher: ACCOUNT,
        written: { ...naming(42), sayWhich: true },
        found: found([], []),
        status: 403,
        message: /^sensor "Sum": channels\[0\]\.formula names object 42/,
      },
    ];

    for (const row of cases) {
      const answer = observed(refusal(row.voucher, row.written, row.found));
      if (row.status === null) {
        assert.equal(answer, null, row.name);
        continue;
      }
      assert.ok(answer !== null, row.name);
      assert.equal(answer['status'], row.status, row.name);
      if (row.message !== undefined) assert.match(String(answer['message']), row.message, row.name);
    }
  });
});

// ── each type, through each write path ───────────────────────────────────────────────────────

const available = await databaseAvailable();

describe(
  'what a written sensor may name, as writes',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;

    /** Read on this probe, write on `mine`, nothing on `theirs`. */
    let seenProbe = 0;
    let mine = 0;
    let mineDevice = 0;
    let minePing = 0;
    let theirsDevice = 0;
    let theirsPing = 0;
    /** No right on this probe, and write on a group beneath it. */
    let hiddenProbe = 0;
    let underHidden = 0;

    let branch: Writer;
    /** What the operator can see, for a clone, which copies only that (`A-35`). */
    let operatorSees: Visibility;
    let admin: Writer;
    /** The operator again, with the sight a request hands over: resolved when asked (`P-235`). */
    let deferred: Writer;
    /** The connection each resolution of `deferred`'s sight was asked on. */
    const deferredOn: Queryable[] = [];

    const NEVER_ISSUED = 9_000_000;

    const sum = (...ids: number[]) => ({
      channels: [
        {
          key: 'x',
          formula:
            ids.length === 0 ? '1' : ids.map((id) => `channel(${String(id)}, 'rtt')`).join(' + '),
        },
      ],
    });

    before(async () => {
      scratch = await createScratchDatabase('sensorreads');
      db = scratch.db;
      harness = await buildHarness(db);

      const accounts = new AccountService({
        audit: new DatabaseAuditSink(),
        db,
        logger: silentLogger,
      });
      const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silentLogger });
      const access = new AccessService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
      });

      const create = async (input: Record<string, unknown>): Promise<number> =>
        (await harness.service.create(testActor, input as never)).id;

      seenProbe = await create({ kind: 'probe', parentId: harness.rootId, name: 'seen' });
      mine = await create({ kind: 'group', parentId: seenProbe, name: 'mine' });
      mineDevice = await create({
        kind: 'device',
        parentId: mine,
        name: 'mine-01',
        host: '10.0.0.1',
      });
      minePing = await create({
        kind: 'sensor',
        parentId: mineDevice,
        name: 'mine-ping',
        sensorType: 'icmp.ping',
      });
      const theirs = await create({ kind: 'group', parentId: seenProbe, name: 'theirs' });
      theirsDevice = await create({
        kind: 'device',
        parentId: theirs,
        name: 'theirs-01',
        host: '10.0.0.2',
      });
      theirsPing = await create({
        kind: 'sensor',
        parentId: theirsDevice,
        name: 'theirs-ping',
        sensorType: 'icmp.ping',
      });
      hiddenProbe = await create({ kind: 'probe', parentId: harness.rootId, name: 'hidden' });
      underHidden = await create({ kind: 'group', parentId: hiddenProbe, name: 'under-hidden' });

      const team = (await groups.create({ name: 'Team' }, testActor)).id;
      await access.grant(seenProbe, team, 'read', actorNamed('test'));
      await access.grant(mine, team, 'write', actorNamed('test'));
      await access.grant(theirs, team, 'none', actorNamed('test'));
      await access.grant(underHidden, team, 'write', actorNamed('test'));

      const operator = await accounts.create(
        {
          login: 'operator',
          password: 'correct-horse-battery',
          role: 'readwrite',
        },
        testActor,
      );
      await groups.addMember(team, operator.id, testActor);
      operatorSees = await access.visibilityFor({ userId: operator.id, role: 'readwrite' });
      branch = {
        kind: 'user',
        userId: operator.id,
        login: 'operator',
        voucher: {
          kind: 'account',
          userId: operator.id,
          sees: operatorSees,
        },
      };
      deferred = {
        ...branch,
        voucher: {
          kind: 'account',
          userId: operator.id,
          sees: (q) => {
            deferredOn.push(q);
            return access.visibilityFor({ userId: operator.id, role: 'readwrite' }, q);
          },
        },
      };

      const root = await accounts.create(
        {
          login: 'root',
          password: 'correct-horse-battery',
          role: 'admin',
        },
        testActor,
      );
      const admins = (await groups.list()).find((group) => group.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, root.id, testActor);
      admin = {
        kind: 'user',
        userId: root.id,
        login: 'root',
        voucher: {
          kind: 'account',
          userId: root.id,
          sees: await access.visibilityFor({ userId: root.id, role: 'admin' }),
        },
      };
    });

    after(async () => {
      await scratch.drop();
    });

    const sensor = (
      writer: Writer,
      parentId: number,
      sensorType: string,
      params: Record<string, unknown>,
      name = `${sensorType}-${String(process.hrtime.bigint())}`,
    ) => harness.service.create(writer, { kind: 'sensor', parentId, name, sensorType, params });

    const countNamed = async (name: string): Promise<number> =>
      Number(
        (
          await db.query<{ n: string }>('SELECT count(*) AS n FROM object WHERE name = $1', [name])
        )[0]?.n,
      );

    /** Asserts a refusal, and that it rolled the write back. */
    async function refused(
      write: () => Promise<unknown>,
      status: number,
      message: RegExp,
      leftBehind?: () => Promise<void>,
    ): Promise<void> {
      await assert.rejects(write, (error: unknown) => {
        const app = error as { status?: number; message?: string };
        assert.equal(app.status, status, app.message);
        assert.match(app.message ?? '', message);
        return true;
      });
      await leftBehind?.();
    }

    it('lets a formula name what its writer can read', async () => {
      const made = await sensor(branch, mineDevice, 'core.factory', sum(minePing));
      assert.equal(made.kind, 'sensor');
    });

    it('asks a deferred sight only when something is named, on the write’s connection (P-235)', async () => {
      deferredOn.length = 0;
      await sensor(deferred, mineDevice, 'icmp.ping', {});
      assert.equal(deferredOn.length, 0, 'a ping names nothing, and its create never asked');
      await sensor(deferred, mineDevice, 'core.factory', sum(minePing));
      await refused(
        () => sensor(deferred, mineDevice, 'core.factory', sum(theirsPing)),
        403,
        /which does not exist or which you cannot read$/,
      );
      assert.equal(deferredOn.length, 2, 'the two that named something asked, once each');
      assert.ok(
        deferredOn.every((q) => q !== db),
        'inside the write’s transaction, not on a connection of its own',
      );
    });

    it('refuses a formula naming a hidden sensor, and writes nothing', async () => {
      await refused(
        () => sensor(branch, mineDevice, 'core.factory', sum(minePing, theirsPing), 'leaky-sum'),
        403,
        new RegExp(
          `^channels\\[0\\]\\.formula names object ${String(theirsPing)}, which does not exist or which you cannot read$`,
        ),
        async () => {
          assert.equal(await countNamed('leaky-sum'), 0);
        },
      );
    });

    it('refuses a formula naming an id never issued, in the same words', async () => {
      await refused(
        () => sensor(branch, mineDevice, 'core.factory', sum(NEVER_ISSUED)),
        403,
        new RegExp(
          `names object ${String(NEVER_ISSUED)}, which does not exist or which you cannot read$`,
        ),
      );
    });

    it('refuses a formula naming a device it can read, and says so', async () => {
      await refused(
        () => sensor(branch, mineDevice, 'core.factory', sum(mineDevice)),
        400,
        /which is a device, not a sensor$/,
      );
    });

    it('checks an edit of the parameters, and not a rename', async () => {
      // Written by the installation, naming a sensor the branch account cannot read.
      const shared = await sensor(testActor, mineDevice, 'core.factory', sum(theirsPing));

      // Renaming it vouches for nothing, so it is not checked.
      const renamed = await harness.service.update(
        branch,
        shared.id,
        { kind: 'sensor', name: 'renamed-sum' },
        { kind: 'none' },
      );
      assert.equal(renamed.name, 'renamed-sum');

      // Writing its parameters vouches for all of them — even ones the edit did not touch.
      await refused(
        () =>
          harness.service.update(
            branch,
            shared.id,
            { kind: 'sensor', params: { ...sum(theirsPing), maxAgeSeconds: 600 } },
            { kind: 'none' },
          ),
        403,
        /which does not exist or which you cannot read$/,
      );
      const stored = await harness.service.get(shared.id);
      assert.equal(
        (stored as { params?: Record<string, unknown> }).params?.['maxAgeSeconds'],
        undefined,
        'the refused edit rolled back',
      );

      // And an edit that names only what the account can read goes through, as it.
      const fixed = await harness.service.update(
        branch,
        shared.id,
        { kind: 'sensor', params: sum(minePing) },
        { kind: 'none' },
      );
      assert.equal(fixed.kind, 'sensor');
    });

    it('lets Probe Health name a probe its writer can read', async () => {
      await sensor(branch, mineDevice, 'ms.probe.health', { probeId: seenProbe });
      await sensor(branch, mineDevice, 'ms.probe.health', {});
    });

    it('refuses Probe Health naming a hidden probe, or something that is not a probe', async () => {
      await refused(
        () => sensor(branch, mineDevice, 'ms.probe.health', { probeId: hiddenProbe }),
        403,
        new RegExp(
          `^probeId names object ${String(hiddenProbe)}, which does not exist or which you cannot read$`,
        ),
      );
      await refused(
        () => sensor(branch, mineDevice, 'ms.probe.health', { probeId: mine }),
        400,
        /which is a group, not a probe$/,
      );
    });

    it('refuses Probe Health with no probeId under a probe its writer cannot read', async () => {
      // The account may write this group, and the probe above it is still not its to publish.
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: underHidden,
        name: 'under-hidden-01',
        host: '10.0.1.1',
      });
      await refused(
        () => sensor(branch, device.id, 'ms.probe.health', {}),
        403,
        new RegExp(`^probeId names object ${String(hiddenProbe)}`),
      );
    });

    it('holds Core Health to read on the root', async () => {
      await refused(
        () => sensor(branch, mineDevice, 'ms.core.health', {}),
        403,
        /^a ms\.core\.health sensor reports on the whole installation, so writing one needs read on the root$/,
      );
      await sensor(admin, mineDevice, 'ms.core.health', {});
      await sensor(testActor, mineDevice, 'ms.core.health', {});
    });

    it('re-checks a move, because the probe above can change', async () => {
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: mine,
        name: 'moving-01',
        host: '10.0.2.1',
      });
      await sensor(testActor, device.id, 'ms.probe.health', {}, 'moving-health');

      await refused(
        () => harness.service.move(branch, device.id, underHidden, { kind: 'none' }),
        403,
        new RegExp(`^sensor "moving-health": probeId names object ${String(hiddenProbe)}`),
      );
      const still = await harness.service.get(device.id);
      assert.equal(still.parentId, mine, 'the refused move rolled back');

      // The administrator can read that probe, and moves it.
      const moved = await harness.service.move(admin, device.id, underHidden, { kind: 'none' });
      assert.equal(moved.toParentId, underHidden);
    });

    it('re-checks a move for what the moved sensors name, whoever wrote them', async () => {
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: mine,
        name: 'carrying-01',
        host: '10.0.3.1',
      });
      await sensor(testActor, device.id, 'core.factory', sum(theirsPing), 'carried-sum');
      await refused(
        () => harness.service.move(branch, device.id, underHidden, { kind: 'none' }),
        403,
        new RegExp(
          `^sensor "carried-sum": channels\\[0\\]\\.formula names object ${String(theirsPing)}`,
        ),
      );
    });

    it('re-checks a clone, which copies what its source names', async () => {
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: mine,
        name: 'source-01',
        host: '10.0.4.1',
      });
      await sensor(testActor, device.id, 'core.factory', sum(theirsPing), 'copied-sum');
      const before = await countNamed('copied-sum');

      await refused(
        () => harness.service.clone(branch, device.id, { name: 'refused-copy' }, operatorSees),
        403,
        /^sensor "copied-sum": channels\[0\]\.formula names object/,
        async () => {
          assert.equal(await countNamed('refused-copy'), 0);
          assert.equal(await countNamed('copied-sum'), before);
        },
      );

      const fine = await harness.service.create(testActor, {
        kind: 'device',
        parentId: mine,
        name: 'source-02',
        host: '10.0.4.2',
      });
      await sensor(testActor, fine.id, 'core.factory', sum(minePing));
      const copy = await harness.service.clone(
        branch,
        fine.id,
        { name: 'fine-copy' },
        operatorSees,
      );
      assert.equal(copy.object.name, 'fine-copy');
    });

    it('checks a created tree, naming the node, and creates none of it', async () => {
      await refused(
        () =>
          harness.service.createTree(branch, {
            parentId: mine,
            nodes: [
              { kind: 'device', name: 'tree-01', host: '10.0.5.1', ref: 'd' },
              {
                kind: 'sensor',
                name: 'tree-sum',
                sensorType: 'core.factory',
                params: sum(theirsPing),
                parentRef: 'd',
              },
            ],
          }),
        403,
        /^sensor "tree-sum": channels\[0\]\.formula names object/,
        async () => {
          assert.equal(await countNamed('tree-01'), 0);
        },
      );
    });

    it('lets the installation name anything that exists', async () => {
      await sensor(testActor, mineDevice, 'core.factory', sum(theirsPing));
      await refused(
        () => sensor(testActor, mineDevice, 'core.factory', sum(NEVER_ISSUED)),
        400,
        new RegExp(`names object ${String(NEVER_ISSUED)}, which does not exist$`),
      );
    });

    it('asks the database nothing for a sensor that names nothing', async () => {
      // The provisioning path: five thousand pings must not pay for the check a factory needs.
      const repository = harness.repository;
      const original = repository.sensorsOfTypesAtOrUnder.bind(repository);
      let asked = 0;
      repository.sensorsOfTypesAtOrUnder = (...args) => {
        asked += 1;
        return original(...args);
      };
      try {
        await sensor(branch, mineDevice, 'icmp.ping', {});
        await harness.service.createTree(branch, {
          parentId: mine,
          nodes: [
            { kind: 'device', name: 'quiet-01', host: '10.0.6.1', ref: 'd' },
            { kind: 'sensor', name: 'quiet-ping', sensorType: 'icmp.ping', parentRef: 'd' },
          ],
        });
        assert.equal(asked, 0);
        await sensor(branch, mineDevice, 'core.factory', sum(minePing));
        assert.equal(asked, 1, 'and a factory is asked about');
      } finally {
        repository.sensorsOfTypesAtOrUnder = original;
      }
    });
  },
);

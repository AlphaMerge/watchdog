import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BulkService, MAX_BULK } from '../src/objects/bulk.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';

/**
 * Bulk operations over a selection (`D-09`).
 *
 * **What is worth testing is the batch's behaviour, not the operations'** — each one is the
 * single-object method that already has its own tests, and asserting again that a move moves
 * would only be testing that a loop calls what it says. What is new here is everything about
 * the *selection*: that a repeated id is applied once, that one failure does not stop the rest,
 * that the report names what did not happen and why, and that an object removed by an earlier
 * delete in the same batch is reported as that rather than as a stranger's edit.
 *
 * Against a real database, because "one failure does not stop the rest" is a claim about
 * transactions: a batch that shared one would roll the successes back and every assertion here
 * would pass against a stub.
 */

const available = await databaseAvailable();

describe('bulk operations', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let bulk: BulkService;
  let groupId = 0;
  let probeId = 0;

  before(async () => {
    scratch = await createScratchDatabase('bulk');
    db = scratch.db;
    harness = await buildHarness(db, { states: true });
    bulk = new BulkService({ objects: harness.service, logger: silentLogger });
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
    const group = await harness.service.create(testActor, {
      kind: 'group',
      parentId: probe.id,
      name: 'Datacentre',
    });
    groupId = group.id;
  });

  const device = async (name: string, parentId = groupId) =>
    (await harness.service.create(testActor, { kind: 'device', parentId, name, host: '127.0.0.1' }))
      .id;

  const sensor = async (deviceId: number, name: string) =>
    (
      await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name,
        sensorType: 'icmp.ping',
        params: { count: 3 },
      })
    ).id;

  describe('the selection', () => {
    it('applies an operation once to an id given twice', async () => {
      const one = await device('web01');
      const report = await bulk.apply(testActor, [one, one, one], { kind: 'resume' });
      assert.equal(report.requested, 1, 'the duplicates are collapsed');
      assert.equal(report.duplicates, 2, 'and counted rather than silently dropped');
      assert.equal(report.outcomes.length, 1);
    });

    it('refuses a selection larger than one operator ever made by hand', async () => {
      const ids = Array.from({ length: MAX_BULK + 1 }, (_, at) => at + 1);
      await assert.rejects(
        () => bulk.apply(testActor, ids, { kind: 'resume' }),
        (error: unknown) => error instanceof Error && /at most 500 objects/.test(error.message),
      );
    });

    it('counts the request after duplicates, not before', async () => {
      // Otherwise a UI sending the same id 600 times would be refused for a selection of one.
      const one = await device('web01');
      const report = await bulk.apply(testActor, Array.from({ length: MAX_BULK + 1 }, () => one), {
        kind: 'resume',
      });
      assert.equal(report.requested, 1);
    });
  });

  describe('when one of them fails', () => {
    it('does the rest, and says which one did not', async () => {
      // The whole reason the batch is best-effort. An operator who selected forty and had one
      // deleted underneath them wants thirty-nine done and a line naming the fortieth.
      const first = await device('web01');
      const third = await device('web03');
      const report = await bulk.apply(testActor, [first, 999_999, third], {
        kind: 'setting',
        key: 'scan.intervalSeconds',
        value: 300,
      });

      assert.equal(report.succeeded, 2);
      assert.equal(report.failed, 1);
      assert.deepEqual(
        report.outcomes.map((one) => one.ok),
        [true, false, true],
        'and in the order they were asked for',
      );
      assert.match(report.outcomes[1]?.problem ?? '', /999999 does not exist/);
      assert.equal(report.outcomes[1]?.code, 'OBJECT_NOT_FOUND');

      // The successes are committed, which is the claim a stub could not check.
      const settings = await harness.service.settings(first);
      const interval = settings.find((one) => one.key === 'scan.intervalSeconds');
      assert.deepEqual(interval?.own, { value: 300 });
    });

    it('carries the single-object error’s own sentence', async () => {
      // "It failed" is not a diagnosis. A device may not hold a device, and the message that
      // says so is already written.
      const one = await device('web01');
      const report = await bulk.apply(testActor, [probeId], { kind: 'move', targetParentId: one });
      assert.equal(report.failed, 1);
      assert.match(report.outcomes[0]?.problem ?? '', /probe|not be a child|not movable/i);
    });
  });

  describe('deleting', () => {
    it('refuses an object with children unless told to cascade', async () => {
      const one = await device('web01');
      await sensor(one, 'Ping');

      const refused = await bulk.apply(testActor, [one], { kind: 'delete', cascade: false });
      assert.equal(refused.failed, 1);
      assert.equal(refused.outcomes[0]?.code, 'OBJECT_NOT_EMPTY');
      assert.notEqual(await harness.service.get(one), null, 'and it is still there');

      const done = await bulk.apply(testActor, [one], { kind: 'delete', cascade: true });
      assert.equal(done.succeeded, 1);
      assert.equal(done.outcomes[0]?.deleted, 2, 'the device and its sensor');
    });

    it('says an object went with its parent rather than that it never existed', async () => {
      // The difference matters. "object 812 does not exist" is true and reads as somebody else
      // changing the tree underneath them, which sends an operator looking for a problem that
      // is not there — when in fact their own selection did exactly what they asked.
      const parent = await device('web01');
      const child = await sensor(parent, 'Ping');

      const report = await bulk.apply(testActor, [parent, child], {
        kind: 'delete',
        cascade: true,
      });
      assert.equal(report.succeeded, 1);
      assert.equal(report.failed, 1);
      assert.equal(
        report.outcomes[1]?.problem,
        'it was removed with an object deleted earlier in this batch',
      );
    });

    it('still reports a genuine stranger as not existing', async () => {
      // The other half of the same judgement: an id this batch never touched is a plain
      // absence, and dressing it up as "removed earlier" would hide a real disagreement.
      const parent = await device('web01');
      await sensor(parent, 'Ping');
      const report = await bulk.apply(testActor, [parent, 999_999], {
        kind: 'delete',
        cascade: true,
      });
      assert.match(report.outcomes[1]?.problem ?? '', /does not exist/);
    });
  });

  describe('the operations it wraps', () => {
    it('pauses a selection, and resumes it', async () => {
      const first = await device('web01');
      const second = await device('web02');

      const paused = await bulk.apply(testActor, [first, second], {
        kind: 'pause',
        request: { kind: 'indefinite' },
        message: 'patching',
      });
      assert.equal(paused.succeeded, 2);
      assert.equal((await harness.service.pauseState(first)).paused, true);
      assert.equal((await harness.service.pauseState(second)).paused, true);

      const resumed = await bulk.apply(testActor, [first, second], { kind: 'resume' });
      assert.equal(resumed.succeeded, 2);
      assert.equal((await harness.service.pauseState(first)).paused, false);
    });

    it('moves a selection into one parent', async () => {
      const other = (
        await harness.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: 'Branch',
        })
      ).id;
      const first = await device('web01');
      const second = await device('web02');

      const report = await bulk.apply(testActor, [first, second], {
        kind: 'move',
        targetParentId: other,
      });
      assert.equal(report.succeeded, 2);
      assert.equal((await harness.service.get(first)).parentId, other);
      assert.equal((await harness.service.get(second)).parentId, other);
    });

    it('clones a selection and reports what each one became', async () => {
      const other = (
        await harness.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: 'Branch',
        })
      ).id;
      const first = await device('web01');
      await sensor(first, 'Ping');

      const report = await bulk.apply(testActor, [first], {
        kind: 'clone',
        targetParentId: other,
      });
      assert.equal(report.succeeded, 1);
      const made = report.outcomes[0]?.createdId;
      assert.ok(made !== undefined, 'the new id is in the report, not left to be looked up');
      assert.equal((await harness.service.get(made)).parentId, other);
    });

    it('reverts a setting to what the object inherits', async () => {
      // Its own operation rather than `setting` with a null, which is the split the
      // single-object routes already make between PUT and DELETE. **Found live**: the first
      // version read a null value as "revert", and reverting failed on every object because
      // the null reached the setting's own schema, which wants an integer.
      const first = await device('web01');
      const second = await device('web02');
      await bulk.apply(testActor, [first, second], {
        kind: 'setting',
        key: 'scan.intervalSeconds',
        value: 300,
      });

      const report = await bulk.apply(testActor, [first, second], {
        kind: 'revertSetting',
        key: 'scan.intervalSeconds',
      });
      assert.equal(report.succeeded, 2);
      const settings = await harness.service.settings(first);
      const interval = settings.find((one) => one.key === 'scan.intervalSeconds');
      assert.equal(interval?.own, null, 'nothing of its own left');
      assert.deepEqual(interval.effective.value, 60, 'and the inherited default is back');
    });

    it('refuses a value a setting’s own schema will not take', async () => {
      // The bulk layer does not validate settings and must not: the registry's schema is the
      // one place that knows, and every object reports its own refusal.
      const first = await device('web01');
      const report = await bulk.apply(testActor, [first], {
        kind: 'setting',
        key: 'scan.intervalSeconds',
        value: null,
      });
      assert.equal(report.failed, 1);
    });

    it('audits every object it changed, once each', async () => {
      // A bulk edit is still N edits, and an audit log that recorded one entry for forty
      // changes would make "who changed this sensor" unanswerable for thirty-nine of them.
      const first = await device('web01');
      const second = await device('web02');
      harness.audit.recorded.length = 0;

      await bulk.apply(testActor, [first, second], {
        kind: 'setting',
        key: 'scan.intervalSeconds',
        value: 600,
      });
      const touched = harness.audit.recorded.filter((one) => one.action === 'setting.set');
      assert.deepEqual(
        touched.map((one) => one.objectId).sort((a, b) => a - b),
        [first, second].sort((a, b) => a - b),
      );
    });
  });
});

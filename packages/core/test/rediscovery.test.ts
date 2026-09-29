import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DiscoveryService } from '../src/discovery/service.js';
import { RediscoveryService } from '../src/discovery/rediscovery.js';
import { DiscoveryError } from '../src/discovery/errors.js';
import type { ScheduleDefinition } from '../src/schedules/definition.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';
import { Visibility } from '../src/auth/access.js';

/**
 * Scheduled rediscovery (`D-07`), against a real database.
 *
 * **The claims worth testing are all claims about restraint**: that a schedule arrives off, that
 * auto-provisioning is separately off, that a run somebody started by hand is never provisioned
 * on their behalf, and that a permission window can push a firing later. Every one of those is a
 * statement about a row, so none of them is visible from a unit test — the cadence arithmetic is
 * where the pure tests live (`rediscovery-cadence.test.ts`), and this is the other half.
 *
 * The clock is injected because a test that waits for 03:00 is not a test.
 */

const available = await databaseAvailable();

/** Monday 2026-08-31, midnight UTC. Every cadence below is expressed in UTC to match. */
const MONDAY_MIDNIGHT = new Date('2026-08-31T00:00:00Z');

/** Sunday only, 00:00 to 24:00. Day 0 is Monday, so Sunday starts at minute 8640. */
const SUNDAYS: ScheduleDefinition = {
  periods: [{ start: 6 * 1440, end: 7 * 1440 }],
  polarity: 'active',
  timezone: 'UTC',
};

describe('scheduled rediscovery', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let groupId = 0;
  let probeId = 0;
  let now = MONDAY_MIDNIGHT;
  let window: ScheduleDefinition | null = null;
  let windowsAsked: number[] = [];
  let provisioned: number[] = [];
  let discovery: DiscoveryService;
  let rediscovery: RediscoveryService;

  before(async () => {
    scratch = await createScratchDatabase('rediscovery');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM discovery_schedule');
    await db.query('DELETE FROM discovery_run');
    await db.query('DELETE FROM schedule');
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    now = MONDAY_MIDNIGHT;
    window = null;
    windowsAsked = [];
    provisioned = [];

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

    discovery = new DiscoveryService({
      db,
      audit: new DatabaseAuditSink(),
      logger: silentLogger,
      // Connected, and nothing is asserted about what the probe was sent — `D-01` owns that.
      dispatch: () => ({ kind: 'sent' }),
    });
    rediscovery = new RediscoveryService({
      db,
      audit: new DatabaseAuditSink(),
      logger: silentLogger,
      discovery,
      windowFor: (id) => {
        windowsAsked.push(id);
        return Promise.resolve(window);
      },
      provision: (runId) => {
        provisioned.push(runId);
        return Promise.resolve();
      },
      now: () => now,
    });
  });

  /** A daily rediscovery at 03:00 UTC, which is the shape of every case below. */
  const create = (overrides: Partial<Parameters<RediscoveryService['create']>[0]> = {}) =>
    rediscovery.create(
      {
        groupId,
        probeId,
        name: 'Nightly',
        range: '10.0.0.0/29',
        cadence: 'daily',
        cadenceMinute: 3 * 60,
        timezone: 'UTC',
        ...overrides,
      },
      testActor,
    );

  /** A schedule that must exist, so the assertions read as statements rather than as guards. */
  const mustGet = async (id: number) => {
    const found = await rediscovery.get(id);
    assert.ok(found !== null, `schedule ${String(id)} should exist`);
    return found;
  };

  /** `M-09`'s calendar, stored so the foreign key has something to point at. */
  const storeWindow = async (definition: ScheduleDefinition): Promise<number> => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO schedule (name, description, periods, polarity, authored_as, timezone)
       VALUES ('Sundays', '', $1::jsonb, $2, 'periods', $3)
       RETURNING id::text AS id`,
      [JSON.stringify(definition.periods), definition.polarity, definition.timezone],
    );
    const row = rows[0];
    assert.ok(row !== undefined);
    window = definition;
    return Number(row.id);
  };

  describe('creating', () => {
    it('creates a schedule that is off, and whose auto-provisioning is separately off', async () => {
      const schedule = await create();
      assert.equal(schedule.enabled, false);
      assert.equal(schedule.autoProvision, false);
      // Nothing booked, so the sweep cannot find it even if the enabled check were lost.
      assert.equal(schedule.nextRunAt, null);
      assert.equal(schedule.description, 'every day at 03:00');
    });

    it('books the first run when one is created switched on', async () => {
      const schedule = await create({ enabled: true });
      assert.equal(schedule.nextRunAt, '2026-08-31T03:00:00.000Z');
    });

    it('refuses a cadence that cannot fire, with the sentence that says why', async () => {
      await assert.rejects(
        () => create({ cadence: 'daily', cadenceMinute: 2_000 }),
        (error: unknown) => error instanceof Error && /between 0 and 1439/.test(error.message),
      );
      assert.equal(
        (await rediscovery.list(Visibility.EVERYTHING)).length,
        0,
        'and nothing was recorded',
      );
    });

    it('refuses a range the parser refuses, in the parser’s words, before it is saved', async () => {
      // It used to be saved and fail at its first firing, unattended, the sentence lost to a log.
      await assert.rejects(
        () => create({ range: '10.0.0.0/8' }),
        (error: unknown) =>
          error instanceof DiscoveryError &&
          error.code === 'DISCOVERY_RANGE_INVALID' &&
          /addresses/.test(error.message),
      );
      assert.equal((await rediscovery.list(Visibility.EVERYTHING)).length, 0);
    });

    it('refuses a time zone the system does not know', async () => {
      await assert.rejects(
        () => create({ timezone: 'Mars/Olympus' }),
        (error: unknown) => error instanceof Error && /not a time zone/.test(error.message),
      );
    });
  });

  describe('enabling', () => {
    it('books the next run on, and clears it off', async () => {
      const created = await create();
      const on = await rediscovery.setEnabled(created.id, true, testActor);
      assert.equal(on?.nextRunAt, '2026-08-31T03:00:00.000Z');

      const off = await rediscovery.setEnabled(created.id, false, testActor);
      // `assert.equal` narrows, so the second read needs no `?.` — and eslint says so.
      assert.equal(off?.enabled, false);
      assert.equal(off.nextRunAt, null, 'a schedule that is off is not due');
    });

    it('books the *next* one when enabled at exactly its firing time', async () => {
      // Somebody switching a nightly job on at 03:00 means tonight's 03:00, not this instant.
      const created = await create();
      now = new Date('2026-08-31T03:00:00Z');
      const on = await rediscovery.setEnabled(created.id, true, testActor);
      assert.equal(on?.nextRunAt, '2026-09-01T03:00:00.000Z');
    });

    it('reports nothing for a schedule that is not there', async () => {
      assert.equal(await rediscovery.setEnabled(999_999, true, testActor), null);
    });
  });

  describe('firing', () => {
    it('starts nothing before it is due', async () => {
      await create({ enabled: true });
      now = new Date('2026-08-31T02:59:00Z');
      assert.equal(await rediscovery.tick(), 0);
    });

    it('starts an ordinary run, marks it as this schedule’s, and books tomorrow', async () => {
      const created = await create({ enabled: true });
      now = new Date('2026-08-31T03:00:00Z');
      assert.equal(await rediscovery.tick(), 1);

      const after = await mustGet(created.id);
      assert.ok(after.lastRunId !== null, 'the run it started is recorded');
      assert.equal(after.nextRunAt, '2026-09-01T03:00:00.000Z');

      const run = await discovery.get(after.lastRunId);
      assert.ok(run !== null);
      assert.equal(run.range, '10.0.0.0/29', 'the stencil’s parameters, not defaults');
      assert.equal(run.status, 'running');

      // The link back, which is what lets a summary say where a run nobody started came from.
      const rows = await db.query<{ schedule_id: string | null }>(
        `SELECT schedule_id::text AS schedule_id FROM discovery_run WHERE id = $1`,
        [after.lastRunId],
      );
      assert.equal(Number(rows[0]?.schedule_id), created.id);
    });

    it('books the next run even when the start fails', async () => {
      // The failure that matters: a schedule whose booking did not move would be retried every
      // minute for ever, turning one bad configuration into a sweep that never stops asking.
      const created = await create({ enabled: true });
      // A range the parser refuses. Refused when a rule is written since `D-11`, so it is put
      // there directly — the state of a rule written before, which a firing still has to survive.
      await db.query(`UPDATE discovery_schedule SET range_text = '10.0.0.0/8' WHERE id = $1`, [
        created.id,
      ]);
      now = new Date('2026-08-31T03:00:00Z');
      assert.equal(await rediscovery.tick(), 0, 'nothing started');

      const after = await mustGet(created.id);
      assert.equal(after.lastRunId, null);
      assert.equal(after.nextRunAt, '2026-09-01T03:00:00.000Z', 'but tomorrow is booked');
    });

    it('starts one run per firing, however late the sweep is', async () => {
      const created = await create({ enabled: true });
      // Three days after it was due: the schedule fires once and books the next, rather than
      // catching up on every missed night.
      now = new Date('2026-09-03T09:00:00Z');
      assert.equal(await rediscovery.tick(), 1);
      assert.equal(await rediscovery.tick(), 0, 'and is no longer due');
      assert.equal((await mustGet(created.id)).nextRunAt, '2026-09-04T03:00:00.000Z');
    });

    it('leaves a disabled schedule alone even if a booking survived', async () => {
      const created = await create({ enabled: true });
      await db.query(`UPDATE discovery_schedule SET enabled = false WHERE id = $1`, [created.id]);
      now = new Date('2026-08-31T03:00:00Z');
      assert.equal(await rediscovery.tick(), 0);
    });
  });

  describe('the permission window', () => {
    it('pushes a firing to the next time the window is open', async () => {
      const scheduleId = await storeWindow(SUNDAYS);
      const created = await create({ enabled: true, scheduleId });
      // Daily at 03:00, but only allowed on Sundays: the next one is Sunday, not tonight.
      assert.equal(created.nextRunAt, '2026-09-06T03:00:00.000Z');
      assert.deepEqual(windowsAsked, [scheduleId]);
    });

    it('books without the window when the window has gone', async () => {
      const scheduleId = await storeWindow(SUNDAYS);
      const created = await create({ scheduleId });
      window = null;
      const on = await rediscovery.setEnabled(created.id, true, testActor);
      // A rediscovery that runs when it should not is visible; one that silently never runs
      // again is not, so the missing window is a warning rather than a refusal.
      assert.equal(on?.nextRunAt, '2026-08-31T03:00:00.000Z');
      assert.deepEqual(windowsAsked, [scheduleId]);
    });

    it('books nothing when the window is never open', async () => {
      // The whole week marked inactive, which is how an operator says "not for now".
      const scheduleId = await storeWindow({
        periods: [{ start: 0, end: 7 * 1440 }],
        polarity: 'inactive',
        timezone: 'UTC',
      });
      const created = await create({ enabled: true, scheduleId });
      assert.equal(created.nextRunAt, null, 'which reads as "never" rather than as a crash');
    });
  });

  describe('provisioning what a firing found', () => {
    /** A schedule that has fired, and the run it started. */
    const fire = async (autoProvision: boolean): Promise<number> => {
      const created = await create({ enabled: true, autoProvision });
      now = new Date('2026-08-31T03:00:00Z');
      await rediscovery.tick();
      const after = await mustGet(created.id);
      assert.ok(after.lastRunId !== null);
      return after.lastRunId;
    };

    it('provisions a finished run when the schedule said to', async () => {
      const runId = await fire(true);
      assert.equal(await rediscovery.runFinished(runId), true);
      assert.deepEqual(provisioned, [runId]);
      assert.equal(rediscovery.stats().provisioned, 1);
    });

    it('sweeps and identifies but creates nothing when it did not', async () => {
      const runId = await fire(false);
      assert.equal(await rediscovery.runFinished(runId), false);
      assert.deepEqual(provisioned, [], 'the plan is there for an operator to look at');
      assert.equal(rediscovery.stats().skipped, 1);
    });

    it('never provisions a run somebody started by hand', async () => {
      // Theirs to provision. Creating objects on their behalf is the exact surprise this
      // ticket is careful about, and a hand-started run has no schedule to have asked for it.
      const run = await discovery.start({ groupId, probeId, range: '10.0.0.0/29' }, testActor);
      assert.equal(await rediscovery.runFinished(run.id), false);
      assert.deepEqual(provisioned, []);
      assert.equal(rediscovery.stats().skipped, 0, 'and it is not counted as a skip either');
    });

    it('reports nothing for a run that is not there', async () => {
      assert.equal(await rediscovery.runFinished(999_999), false);
    });
  });

  describe('editing (`D-11`)', () => {
    const entries = async (id: number) =>
      db.query<{ diff: { field: string; before: unknown; after: unknown }[] }>(
        `SELECT diff FROM audit_log
         WHERE action = 'discovery.schedule.updated' AND (summary->>'scheduleId')::bigint = $1
         ORDER BY id`,
        [id],
      );

    const changedTo = (code: string) => (error: unknown) =>
      error instanceof DiscoveryError && error.code === code;

    it('changes what it is given, keeps the rest, and counts a version', async () => {
      const created = await create({ enabled: true, snmpCommunity: 'kept-community' });
      assert.equal(created.version, 1);

      const edited = await rediscovery.update(
        created.id,
        1,
        { name: 'Nightly, later', cadenceMinute: 4 * 60, level: 'detailed' },
        testActor,
      );
      assert.ok(edited !== null);
      assert.equal(edited.version, 2);
      assert.equal(edited.name, 'Nightly, later');
      assert.equal(edited.level, 'detailed');
      assert.equal(edited.range, '10.0.0.0/29', 'untouched');
      assert.equal(edited.snmpCommunity, 'kept-community', 'an absent community is kept');
      assert.equal(edited.enabled, true, 'whether it is on is not the edit’s');
      // Rebooked by the new cadence, because it is on.
      assert.equal(edited.description, 'every day at 04:00');
      assert.equal(edited.nextRunAt, '2026-08-31T04:00:00.000Z');

      const [entry] = await entries(created.id);
      assert.deepEqual(
        entry?.diff.map((change) => change.field),
        ['discovery.schedule.name', 'discovery.schedule.level', 'discovery.schedule.cadence'],
      );
    });

    it('refuses an edit made against a version that is no longer current', async () => {
      const created = await create();
      await rediscovery.update(created.id, 1, { name: 'First' }, testActor);
      await assert.rejects(
        () => rediscovery.update(created.id, 1, { name: 'Second' }, testActor),
        changedTo('DISCOVERY_SCHEDULE_CHANGED'),
      );
      assert.equal((await mustGet(created.id)).name, 'First', 'the first edit stands');
      assert.equal((await entries(created.id)).length, 1);
    });

    it('counts switching it on and off as a change, and a firing as none', async () => {
      const created = await create();
      await rediscovery.setEnabled(created.id, true, testActor);
      assert.equal((await mustGet(created.id)).version, 2);
      await rediscovery.setEnabled(created.id, true, testActor);
      assert.equal((await mustGet(created.id)).version, 2, 'the state it was already in');

      // An editor must not be refused because the rule did what it was told meanwhile.
      now = new Date('2026-08-31T03:00:00Z');
      assert.equal(await rediscovery.tick(), 1);
      assert.equal((await mustGet(created.id)).version, 2);
      assert.ok(await rediscovery.update(created.id, 2, { name: 'After firing' }, testActor));
    });

    it('writes nothing, and keeps its version, for an edit that changes nothing', async () => {
      const created = await create();
      const same = await rediscovery.update(
        created.id,
        1,
        { name: created.name, range: created.range },
        testActor,
      );
      assert.equal(same?.version, 1);
      assert.equal((await entries(created.id)).length, 0);
    });

    it('says a community was replaced or cleared, and never what it was', async () => {
      const created = await create({ snmpCommunity: 'first-community-3b1e' });
      await rediscovery.update(
        created.id,
        1,
        { snmpCommunity: 'second-community-3b1e' },
        testActor,
      );
      await rediscovery.update(created.id, 2, { snmpCommunity: '' }, testActor);
      assert.equal((await mustGet(created.id)).snmpCommunity, '');

      const [replaced, cleared] = await entries(created.id);
      assert.deepEqual(replaced?.diff, [
        { field: 'discovery.schedule.community', before: 'set', after: 'replaced' },
      ]);
      assert.deepEqual(cleared?.diff, [
        { field: 'discovery.schedule.community', before: true, after: false },
      ]);
      const everything = JSON.stringify(
        await db.query(`SELECT summary, diff FROM audit_log WHERE action LIKE 'discovery.%'`),
      );
      assert.ok(!everything.includes('community-3b1e'), 'no community is ever written down');
    });

    it('leaves the community behind when the range or the probe moves without it (A-40)', async () => {
      const logged = async (id: number) =>
        db.query<{ summary: Record<string, unknown>; diff: { field: string }[] }>(
          `SELECT summary, diff FROM audit_log
           WHERE action = 'discovery.schedule.updated' AND (summary->>'scheduleId')::bigint = $1
           ORDER BY id`,
          [id],
        );
      const created = await create({ snmpCommunity: 'moved-community-9c2d' });

      // Sent again with the move: it goes where it was sent.
      const resent = await rediscovery.update(
        created.id,
        1,
        { range: '10.0.1.0/29', snmpCommunity: 'moved-community-9c2d' },
        testActor,
      );
      assert.equal(resent?.snmpCommunity, 'moved-community-9c2d');

      const moved = await rediscovery.update(created.id, 2, { range: '10.0.2.0/29' }, testActor);
      assert.equal(moved?.snmpCommunity, '', 'a new range is not where the community was set for');

      const [kept, left] = await logged(created.id);
      assert.equal(kept?.summary['communityLeftBehind'], undefined);
      assert.equal(left?.summary['communityLeftBehind'], true, 'the history says why it went');
      assert.ok(left.diff.some((change) => change.field === 'discovery.schedule.community'));

      // And the probe: the group moves, and the rule follows it without the community.
      const other = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `other-${String(process.hrtime.bigint())}`,
      });
      const second = await create({ snmpCommunity: 'moved-community-9c2d' });
      await harness.service.move(testActor, groupId, other.id, { kind: 'none' });
      const followed = await rediscovery.update(second.id, 1, { probeId: other.id }, testActor);
      assert.equal(followed?.snmpCommunity, '', 'another probe is not where it was set for');
      const [probeMove] = await logged(second.id);
      assert.equal(probeMove?.summary['communityLeftBehind'], true);
      const everything = JSON.stringify(
        await db.query(`SELECT summary, diff FROM audit_log WHERE action LIKE 'discovery.%'`),
      );
      assert.ok(!everything.includes('community-9c2d'), 'no community is ever written down');
    });

    it('asks what a new rule is asked: the range, the cadence and the probe', async () => {
      const created = await create();
      await assert.rejects(
        () => rediscovery.update(created.id, 1, { range: '10.0.0.0/8' }, testActor),
        changedTo('DISCOVERY_RANGE_INVALID'),
      );
      await assert.rejects(
        () => rediscovery.update(created.id, 1, { cadenceMinute: 2_000 }, testActor),
        changedTo('DISCOVERY_SCHEDULE_INVALID'),
      );
      const elsewhere = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `elsewhere-${String(process.hrtime.bigint())}`,
      });
      await assert.rejects(
        () => rediscovery.update(created.id, 1, { probeId: elsewhere.id }, testActor),
        changedTo('DISCOVERY_PROBE_INVALID'),
      );
      await assert.rejects(
        () => rediscovery.update(created.id, 1, { scheduleId: 999_999 }, testActor),
        changedTo('DISCOVERY_SCHEDULE_INVALID'),
      );
      assert.equal((await mustGet(created.id)).version, 1, 'and nothing was changed');
    });

    it('is how a rule refused on firing is put right, and the refusal goes with the fix', async () => {
      // The group moves under another probe; the rule's firing is refused and says so (`A-28`).
      const created = await create({ enabled: true });
      const other = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `other-${String(process.hrtime.bigint())}`,
      });
      await harness.service.move(testActor, groupId, other.id, { kind: 'none' });
      now = new Date('2026-08-31T03:00:00Z');
      assert.equal(await rediscovery.tick(), 0);
      const refused = await mustGet(created.id);
      assert.notEqual(refused.lastProblem, '');

      const fixed = await rediscovery.update(
        created.id,
        refused.version,
        { probeId: other.id },
        testActor,
      );
      assert.equal(fixed?.probeId, other.id);
      assert.equal(fixed.lastProblem, '');
    });

    it('reports nothing for a rule that is not there', async () => {
      assert.equal(await rediscovery.update(999_999, 1, { name: 'x' }, testActor), null);
    });
  });

  describe('listing and removal', () => {
    it('lists by group, and removes', async () => {
      const first = await create({ name: 'Nightly' });
      const other = await harness.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'Branch',
      });
      await create({ name: 'Weekly', groupId: other.id, cadence: 'weekly', cadenceWeekday: 6 });

      assert.equal((await rediscovery.list(Visibility.EVERYTHING)).length, 2);
      const mine = await rediscovery.list(Visibility.EVERYTHING, groupId);
      assert.deepEqual(
        mine.map((s) => s.name),
        ['Nightly'],
      );

      assert.equal(await rediscovery.remove(first.id, testActor), true);
      assert.equal(await rediscovery.remove(first.id, testActor), false, 'and only once');
      assert.equal(await rediscovery.get(first.id), null);
    });

    it('describes a weekly cadence the way an operator would say it', async () => {
      const schedule = await create({ cadence: 'weekly', cadenceWeekday: 6, cadenceMinute: 210 });
      assert.equal(schedule.description, 'every Sunday at 03:30');
    });
  });
});

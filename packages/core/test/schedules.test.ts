import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { builtInSchedules } from '../src/schedules/built-in.js';
import {
  boundaries,
  formatPeriods,
  gridToIntervals,
  isActiveAt,
  MINUTES_PER_WEEK,
  nextChangeAfter,
  normaliseIntervals,
  parsePeriods,
  toGrid,
  validateDefinition,
  weekMinuteOf,
  type ScheduleDefinition,
  type WeekInterval,
} from '../src/schedules/definition.js';
import { SchedulePauses } from '../src/schedules/pauses.js';
import { ScheduleRepository } from '../src/schedules/repository.js';
import { ScheduleService } from '../src/schedules/service.js';
import { ScheduleSweep } from '../src/schedules/sweep.js';
import type { DependencyPauses } from '../src/dependencies/pauses.js';
import { ScheduleSync } from '../src/schedules/sync.js';
import { SCHEDULE_ID } from '../src/settings/registry.js';
import type { SensorState, SensorStateCause } from '../src/state/tables.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** A definition built the way the service builds one, for the pure tests. */
function define(
  periods: string,
  polarity: 'active' | 'inactive' = 'active',
  timezone: string | null = 'UTC',
): ScheduleDefinition {
  const parsed = parsePeriods(periods);
  assert.ok('periods' in parsed, `"${periods}" should parse: ${JSON.stringify(parsed)}`);
  return { periods: parsed.periods, polarity, timezone };
}

// -------------------------------------------------------------------------------------------
// The period language.
// -------------------------------------------------------------------------------------------

describe('parsing periods', () => {
  it('reads a period inside one day', () => {
    const parsed = parsePeriods('mo:09:00-mo:17:30');
    assert.ok('periods' in parsed);
    assert.deepEqual(parsed.periods, [{ start: 9 * 60, end: 17 * 60 + 30 }]);
  });

  it('splits a period that wraps past Sunday midnight into the two it really is', () => {
    // `WORKFLOW.MD §8`'s own example. Stored as two intervals so nothing downstream needs a
    // wraparound case — the evaluator is a containment test and that is the whole reason.
    const parsed = parsePeriods('fr:19:30-mo:06:05');
    assert.ok('periods' in parsed);
    assert.deepEqual(parsed.periods, [
      { start: 0, end: 6 * 60 + 5 },
      { start: 4 * 1440 + 19 * 60 + 30, end: MINUTES_PER_WEEK },
    ]);
  });

  it('accepts 24:00 as the end of a day, so a whole day need not be written as the next one', () => {
    const parsed = parsePeriods('su:00:00-su:24:00');
    assert.ok('periods' in parsed);
    assert.deepEqual(parsed.periods, [{ start: 6 * 1440, end: MINUTES_PER_WEEK }]);
  });

  it('takes spaces, commas and newlines between periods, because a person types this', () => {
    const spaced = parsePeriods('mo:09:00-mo:17:00 tu:09:00-tu:17:00');
    const commas = parsePeriods('mo:09:00-mo:17:00,tu:09:00-tu:17:00');
    const lines = parsePeriods('mo:09:00-mo:17:00\ntu:09:00-tu:17:00');
    assert.ok('periods' in spaced && 'periods' in commas && 'periods' in lines);
    assert.deepEqual(commas.periods, spaced.periods);
    assert.deepEqual(lines.periods, spaced.periods);
  });

  it('refuses what it cannot read, and says what the form is', () => {
    const nonsense = parsePeriods('monday 9 to 5');
    assert.ok('problems' in nonsense);
    assert.ok(nonsense.problems[0]?.includes('ww:hh:mm-ww:hh:mm'));

    assert.ok('problems' in parsePeriods('xx:09:00-mo:17:00'));
    assert.ok('problems' in parsePeriods('mo:25:00-mo:26:00'));
    assert.ok('problems' in parsePeriods('mo:09:70-mo:17:00'));
    assert.ok('problems' in parsePeriods(''));
  });

  it('round-trips through the text form', () => {
    for (const text of [
      'mo:09:00-mo:17:30',
      'fr:19:30-mo:06:05',
      'su:00:00-su:24:00',
      'mo:00:00-sa:00:00',
      'mo:08:00-mo:18:00 we:08:00-we:18:00',
    ]) {
      const first = define(text);
      const again = parsePeriods(formatPeriods(first.periods));
      assert.ok('periods' in again, text);
      assert.deepEqual(again.periods, first.periods, text);
    }
  });
});

describe('normalising periods', () => {
  it('merges periods that touch or overlap, so one meaning is one row', () => {
    const merged = normaliseIntervals([
      { start: 120, end: 240 },
      { start: 0, end: 120 },
      { start: 200, end: 300 },
    ]);
    assert.deepEqual(merged, [{ start: 0, end: 300 }]);
  });

  it('drops an empty interval rather than storing a period of no length', () => {
    assert.deepEqual(normaliseIntervals([{ start: 60, end: 60 }]), []);
  });

  it('keeps periods that do not touch apart', () => {
    const merged = normaliseIntervals([
      { start: 300, end: 400 },
      { start: 0, end: 100 },
    ]);
    assert.deepEqual(merged, [
      { start: 0, end: 100 },
      { start: 300, end: 400 },
    ]);
  });
});

// -------------------------------------------------------------------------------------------
// The grid.
// -------------------------------------------------------------------------------------------

describe('the weekday x hour grid', () => {
  function emptyGrid(): boolean[][] {
    return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => false));
  }

  it('merges a run of hours into one period', () => {
    const grid = emptyGrid();
    for (let hour = 9; hour < 17; hour += 1) (grid[0] ?? [])[hour] = true;
    assert.deepEqual(gridToIntervals(grid), [{ start: 9 * 60, end: 17 * 60 }]);
  });

  it('joins the last hour of one day to the first of the next', () => {
    const grid = emptyGrid();
    (grid[0] ?? [])[23] = true;
    (grid[1] ?? [])[0] = true;
    assert.deepEqual(gridToIntervals(grid), [{ start: 23 * 60, end: 25 * 60 }]);
  });

  it('renders back to the grid it came from', () => {
    const grid = emptyGrid();
    for (let hour = 8; hour < 18; hour += 1) (grid[2] ?? [])[hour] = true;
    const rendered = toGrid({ periods: gridToIntervals(grid), polarity: 'active', timezone: null });
    assert.deepEqual(rendered.grid, grid);
    assert.equal(rendered.exact, true);
  });

  it('says when the hourly grid cannot draw the schedule exactly', () => {
    // `fr:19:30` is half past the hour, so the 19:00 cell is neither on nor off. A UI that
    // drew it as either would be lying; `exact` is what lets it say so before somebody saves.
    const rendered = toGrid(define('fr:19:30-mo:06:05'));
    assert.equal(rendered.exact, false);
  });

  it('inverts for an inactive-polarity schedule, because the grid shows monitored hours', () => {
    const rendered = toGrid(define('sa:00:00-su:24:00', 'inactive'));
    assert.equal(rendered.grid[0]?.[12], true, 'Monday noon is monitored');
    assert.equal(rendered.grid[5]?.[12], false, 'Saturday noon is the suspended period');
  });
});

// -------------------------------------------------------------------------------------------
// Validation.
// -------------------------------------------------------------------------------------------

describe('a grid read back and submitted again', () => {
  it('means the hours it marks, whatever polarity travels with it', () => {
    // **`P-127`.** `toGrid` applies the polarity on the way out, so a schedule stored as
    // "inactive during Sunday" is served as a grid of the six days it *does* monitor — together
    // with `polarity: 'inactive'`, because that is what is stored. A client that read that view
    // and sent it straight back, which is what a form does, stored the monitored hours as the
    // inactive ones: the maintenance window became the only time anything was watched, silently.
    const maintenance: ScheduleDefinition = {
      // Sunday off.
      periods: [{ start: 6 * 24 * 60, end: 7 * 24 * 60 }],
      polarity: 'inactive',
      timezone: null,
    };
    const { grid } = toGrid(maintenance);

    // Monday 09:00 is monitored; Sunday 09:00 is not.
    assert.equal(isActiveAt(maintenance, new Date('2026-08-24T09:00:00Z')), true);
    assert.equal(isActiveAt(maintenance, new Date('2026-08-30T09:00:00Z')), false);

    // The round trip: the grid's cells become the periods, and the polarity that came with the
    // view must not invert them.
    const roundTripped: ScheduleDefinition = {
      periods: gridToIntervals(grid),
      polarity: 'active',
      timezone: null,
    };
    assert.equal(isActiveAt(roundTripped, new Date('2026-08-24T09:00:00Z')), true);
    assert.equal(isActiveAt(roundTripped, new Date('2026-08-30T09:00:00Z')), false);
  });
});

describe('validating a schedule', () => {
  it('refuses one with no periods', () => {
    const problems = validateDefinition({ periods: [], polarity: 'active', timezone: null });
    assert.ok(problems.some((p) => p.includes('at least one')));
  });

  it('refuses one that would never monitor anything, whichever way it is written', () => {
    // The failure this rule exists for: somebody inverts a polarity, assigns the schedule to a
    // group, and finds out months later that nothing under it was ever watched.
    const wholeWeekOff = validateDefinition(define('mo:00:00-su:24:00', 'inactive'));
    assert.ok(wholeWeekOff.some((p) => p.includes('never monitor')));
  });

  it('refuses a time zone this system does not know', () => {
    const problems = validateDefinition(define('mo:09:00-mo:17:00', 'active', 'Mars/Olympus'));
    assert.ok(problems.some((p) => p.includes('not a time zone')));
  });

  it('accepts a schedule that monitors one hour a week — small is not the same as empty', () => {
    assert.deepEqual(validateDefinition(define('we:03:00-we:04:00')), []);
  });
});

// -------------------------------------------------------------------------------------------
// Evaluation, including the awkward hours.
// -------------------------------------------------------------------------------------------

describe('evaluating a schedule', () => {
  it('counts the week from Monday 00:00 local', () => {
    // Monday 09:00 UTC.
    assert.equal(weekMinuteOf(new Date('2026-08-24T09:00:00Z'), 'UTC'), 9 * 60);
    // Saturday 09:00 UTC is the sixth day.
    assert.equal(weekMinuteOf(new Date('2026-08-22T09:00:00Z'), 'UTC'), 5 * 1440 + 9 * 60);
  });

  it('reads the local clock, not the server-s', () => {
    // 21:00 UTC on a Friday is already Saturday in Tokyo, which is the whole reason the zone
    // is part of the definition rather than of the deployment.
    const at = new Date('2026-08-28T21:00:00Z');
    assert.equal(isActiveAt(define('sa:00:00-su:24:00', 'active', 'UTC'), at), false);
    assert.equal(isActiveAt(define('sa:00:00-su:24:00', 'active', 'Asia/Tokyo'), at), true);
  });

  it('is active inside its periods and not outside them', () => {
    const office = define('mo:09:00-mo:17:00');
    assert.equal(isActiveAt(office, new Date('2026-08-24T08:59:00Z')), false);
    assert.equal(isActiveAt(office, new Date('2026-08-24T09:00:00Z')), true);
    assert.equal(isActiveAt(office, new Date('2026-08-24T16:59:00Z')), true);
    // Half-open: the period ends *at* 17:00, so 17:00 is already outside it.
    assert.equal(isActiveAt(office, new Date('2026-08-24T17:00:00Z')), false);
  });

  it('inverts for an inactive-polarity schedule', () => {
    const window = define('fr:19:00-mo:06:00', 'inactive');
    assert.equal(isActiveAt(window, new Date('2026-08-28T18:00:00Z')), true, 'before it starts');
    assert.equal(isActiveAt(window, new Date('2026-08-28T20:00:00Z')), false, 'inside it');
    assert.equal(isActiveAt(window, new Date('2026-08-24T09:00:00Z')), true, 'a Monday morning');
  });

  it('follows the local clock across the spring transition', () => {
    // Europe/London goes forward at 01:00 UTC on 2026-03-29: 00:59 GMT becomes 02:00 BST, and
    // the local hour 01:00-02:00 does not happen at all. A schedule that runs 01:00-03:00 local
    // therefore starts the moment the clock jumps.
    const nightly = define('su:01:00-su:03:00', 'active', 'Europe/London');
    assert.equal(isActiveAt(nightly, new Date('2026-03-29T00:30:00Z')), false);
    assert.equal(isActiveAt(nightly, new Date('2026-03-29T01:30:00Z')), true);
    assert.equal(isActiveAt(nightly, new Date('2026-03-29T02:30:00Z')), false);
  });

  it('follows the local clock across the autumn transition, where an hour happens twice', () => {
    const nightly = define('su:01:00-su:03:00', 'active', 'Europe/London');
    assert.equal(isActiveAt(nightly, new Date('2026-10-25T00:30:00Z')), true, '01:30 BST');
    assert.equal(isActiveAt(nightly, new Date('2026-10-25T01:30:00Z')), true, '01:30 GMT, again');
    assert.equal(isActiveAt(nightly, new Date('2026-10-25T02:30:00Z')), true, '02:30 GMT');
    assert.equal(isActiveAt(nightly, new Date('2026-10-25T03:30:00Z')), false);
  });
});

describe('when a schedule next changes', () => {
  it('finds the next edge', () => {
    const office = define('mo:09:00-mo:17:00');
    assert.equal(
      nextChangeAfter(office, new Date('2026-08-24T08:00:00Z'))?.toISOString(),
      '2026-08-24T09:00:00.000Z',
    );
    assert.equal(
      nextChangeAfter(office, new Date('2026-08-24T09:00:00Z'))?.toISOString(),
      '2026-08-24T17:00:00.000Z',
    );
  });

  it('wraps into next week when nothing is left in this one', () => {
    const office = define('mo:09:00-mo:17:00');
    const next = nextChangeAfter(office, new Date('2026-08-28T12:00:00Z'));
    assert.equal(next?.toISOString(), '2026-08-31T09:00:00.000Z', 'the following Monday');
  });

  it('is null for a schedule whose answer never changes', () => {
    assert.equal(nextChangeAfter(define('mo:00:00-su:24:00'), new Date('2026-08-24T09:00Z')), null);
  });

  it('corrects itself across a daylight-saving transition rather than being an hour out', () => {
    const nightly = define('su:01:00-su:03:00', 'active', 'Europe/London');
    // Spring: local 01:00 never happens, so the window opens the instant the clock jumps.
    assert.equal(
      nextChangeAfter(nightly, new Date('2026-03-29T00:30:00Z'))?.toISOString(),
      '2026-03-29T01:00:00.000Z',
    );
    // Autumn: the local hour repeats, so the window closes an hour later in real time than the
    // naive arithmetic predicts. This is the case the refinement pass exists for.
    assert.equal(
      nextChangeAfter(nightly, new Date('2026-10-25T00:30:00Z'))?.toISOString(),
      '2026-10-25T03:00:00.000Z',
    );
  });

  it('lists every edge once', () => {
    assert.deepEqual(boundaries(define('mo:09:00-mo:17:00 tu:09:00-tu:17:00')), [
      9 * 60,
      17 * 60,
      1440 + 9 * 60,
      1440 + 17 * 60,
    ]);
  });
});

describe('when a schedule next changes, across a clock change', () => {
  it('is not an hour late on the Sunday the clocks go forward', () => {
    // **`P-128`.** Week-minutes are local time and the delta is elapsed time, so a spring-forward
    // between now and the next edge means the edge arrives an hour *sooner* than the arithmetic
    // predicts — Europe/London skips 01:00 to 02:00, so thirteen local hours are twelve real
    // ones. The candidate therefore already read as changed, the verification was satisfied by
    // that, and the answer was an hour late. Every year, in every zone that does it.
    const office = define('su:09:00-su:17:00', 'active', 'Europe/London');
    // Saturday 20:00 UTC, before the transition at 01:00 UTC on the Sunday.
    const asked = new Date('2026-03-28T20:00:00Z');
    const change = nextChangeAfter(office, asked);
    assert.ok(change !== null);
    // 09:00 BST on the Sunday is 08:00 UTC.
    assert.equal(change.toISOString(), '2026-03-29T08:00:00.000Z');
  });

  it('is still right on the Sunday the clocks go back', () => {
    // The other direction, where the prediction is early rather than late and the forward scan
    // was already correct. Asserted so the fix for one cannot break the other.
    const office = define('su:09:00-su:17:00', 'active', 'Europe/London');
    const asked = new Date('2026-10-24T20:00:00Z');
    const change = nextChangeAfter(office, asked);
    assert.ok(change !== null);
    // 09:00 GMT on the Sunday is 09:00 UTC.
    assert.equal(change.toISOString(), '2026-10-25T09:00:00.000Z');
  });
});

describe('the built-in schedules', () => {
  it('all parse, all validate, and none of them monitors nothing', () => {
    for (const schedule of builtInSchedules()) {
      const definition: ScheduleDefinition = {
        periods: schedule.periods,
        polarity: schedule.polarity,
        timezone: null,
      };
      assert.deepEqual(validateDefinition(definition), [], schedule.id);
    }
  });

  it('means what its name says', () => {
    const byId = new Map(builtInSchedules().map((schedule) => [schedule.id, schedule]));
    const office = byId.get('office-hours');
    assert.ok(office !== undefined);
    const definition: ScheduleDefinition = {
      periods: office.periods,
      polarity: office.polarity,
      timezone: 'UTC',
    };
    assert.equal(isActiveAt(definition, new Date('2026-08-24T10:00:00Z')), true, 'Monday 10:00');
    assert.equal(isActiveAt(definition, new Date('2026-08-24T03:00:00Z')), false, 'Monday 03:00');
    assert.equal(isActiveAt(definition, new Date('2026-08-22T10:00:00Z')), false, 'Saturday');
  });
});

// -------------------------------------------------------------------------------------------
// Against a real tree.
// -------------------------------------------------------------------------------------------

describe(
  'schedules against a tree',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let schedules: ScheduleService;
    let pauses: SchedulePauses;
    let settler: DependencyPauses;
    let repo: ScheduleRepository;
    let probeId: number;
    let groupId: number;
    let deviceId: number;
    let sensorId: number;
    let otherDeviceId: number;
    let otherSensorId: number;

    /** Monday 10:00 UTC — inside office hours. */
    const INSIDE = new Date('2026-08-24T10:00:00Z');
    /** Monday 03:00 UTC — outside them. */
    const OUTSIDE = new Date('2026-08-24T03:00:00Z');

    before(async () => {
      scratch = await createScratchDatabase('schedules');
      db = scratch.db;
      h = await buildHarness(db, { states: true });

      repo = new ScheduleRepository();
      assert.ok(h.states !== undefined);
      pauses = new SchedulePauses({ logger: silent, states: h.states, repository: repo });
      // The one the harness built, so the sweep settles the same flags these tests read
      // (`P-136`). A stub here would make the sweep's own settle unobservable.
      const built = h.dependencies;
      assert.ok(built !== undefined);
      settler = built;
      const sync = new ScheduleSync({ pauses, logger: silent });
      // Where it sits in production: inside the mutation's own transaction, behind the audit
      // sink every write already goes through.
      h.audit.also = sync;

      // The production composite: the table the history tab reads, and the sync that re-derives
      // the flags — both inside the schedule mutation's own transaction.
      const scheduleAudit = new CompositeAuditSink([new DatabaseAuditSink(), sync]);
      schedules = new ScheduleService({
        db,
        audit: scheduleAudit,
        logger: silent,
        repository: repo,
      });
      await schedules.seedBuiltIns();

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        schedules,
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      groupId = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'group' })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'device',
          host: '192.0.2.90',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'sensor',
          sensorType: 'icmp.ping',
        })
      ).id;
      otherDeviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'other',
          host: '192.0.2.91',
        })
      ).id;
      otherSensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: otherDeviceId,
          name: 'other sensor',
          sensorType: 'icmp.ping',
        })
      ).id;
      // Every test starts from "nothing is scheduled". The counts below are about this test's
      // sensors, and a leftover assignment from an earlier one would be counted too.
      await db.query(`DELETE FROM object_setting WHERE key = $1`, [SCHEDULE_ID.key]);
      await db.query('UPDATE sensor_runtime SET paused_by_schedule = false');
      h.audit.recorded.length = 0;
    });

    async function officeHours(): Promise<number> {
      const list = await schedules.list(INSIDE);
      const office = list.find((schedule) => schedule.name.startsWith('Office hours'));
      assert.ok(office !== undefined, 'the built-in office-hours schedule should be seeded');
      return office.id;
    }

    async function flagsOf(id: number): Promise<{
      state: SensorState;
      cause: SensorStateCause;
      schedule: boolean;
    }> {
      const rows = await db.query<{
        state: SensorState;
        cause: SensorStateCause;
        paused_by_schedule: boolean;
      }>('SELECT state, cause, paused_by_schedule FROM sensor_runtime WHERE object_id = $1', [id]);
      const row = rows[0];
      assert.ok(row !== undefined, `no runtime row for ${String(id)}`);
      return { state: row.state, cause: row.cause, schedule: row.paused_by_schedule };
    }

    async function recompute(now: Date): Promise<number> {
      return db.tx(async (q) => (await pauses.recompute(q, now)).moved);
    }

    /** A period covering this moment, so a test can assert against the wall clock. */
    function aroundNow(): string {
      const minute = weekMinuteOf(new Date(), 'UTC');
      const interval: WeekInterval = {
        start: Math.max(0, minute - 60),
        end: Math.min(MINUTES_PER_WEEK, minute + 60),
      };
      return formatPeriods([interval]);
    }

    // -------------------------------------------------------------------------------------
    // Seeding.
    // -------------------------------------------------------------------------------------

    it('seeds the built-ins once, and never overwrites an edit to one', async () => {
      const id = await officeHours();
      await schedules.update(testActor, id, {
        name: 'Office hours (Mon–Fri 08:00–18:00)',
        periods: 'mo:09:00-mo:17:00',
      });

      assert.equal(await schedules.seedBuiltIns(), 0, 'a second seed inserts nothing');
      const again = await schedules.get(id);
      assert.equal(again.periods, 'mo:09:00-mo:17:00', 'the edit survived');
      assert.equal(again.builtIn, true);

      // Put it back for the tests below.
      await schedules.update(testActor, id, {
        name: 'Office hours (Mon–Fri 08:00–18:00)',
        periods:
          'mo:08:00-mo:18:00 tu:08:00-tu:18:00 we:08:00-we:18:00 th:08:00-th:18:00 ' +
          'fr:08:00-fr:18:00',
      });
    });

    // -------------------------------------------------------------------------------------
    // The derivation.
    // -------------------------------------------------------------------------------------

    it('pauses every sensor under an assignment while the window is closed', async () => {
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());

      await recompute(OUTSIDE);
      const paused = await flagsOf(sensorId);
      assert.equal(paused.schedule, true);
      assert.equal(paused.state, 'paused');
      assert.equal(paused.cause, 'schedule');
      assert.equal((await flagsOf(otherSensorId)).schedule, true, 'the whole subtree, not one');

      await recompute(INSIDE);
      const resumed = await flagsOf(sensorId);
      assert.equal(resumed.schedule, false);
      // §3: when the last source clears the sensor awaits its next scan rather than returning to
      // a state nothing has checked since.
      assert.equal(resumed.state, 'unknown');
    });

    it('does not write the schedule’s name over an operator’s own pause message', async () => {
      // **`P-94`.** `recompute` passes the schedule's text to `reevaluate` in *both* directions,
      // on the reasoning that the message is blanked for a sensor that is resuming. That holds
      // only when the sensor fully resumes — which is the case where the message does not
      // matter. A sensor also paused by hand stays paused; `PAUSE_SOURCES` puts `schedule` above
      // `manual`, so the cause moves from `schedule` to `user`, which is a real change and
      // writes a transition. The message written was the schedule's, at the exact instant that
      // schedule stopped being the reason for anything.
      //
      // `pause-precedence.test.ts` walks this same transition and asserts only `state` and
      // `cause`, never `message`, which is why it stayed green.
      //
      // The clock here is the wall clock, not this block's fixed `INSIDE`/`OUTSIDE`: a manual
      // pause is stamped `new Date()` by `ObjectService.pause`, and a schedule re-evaluated at a
      // date before that pause exists is not the situation being tested.
      const now = new Date();
      const closed = (
        await schedules.create(testActor, {
          name: 'Patching window',
          periods: aroundNow(),
          polarity: 'inactive',
        })
      ).id;
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, closed);
      await recompute(now);
      assert.equal((await flagsOf(sensorId)).cause, 'schedule', 'held by the closed window');

      await h.service.pause(testActor, sensorId, { kind: 'indefinite' }, 'replacing the PSU');

      // The window opens — the schedule stops applying, the operator's pause does not.
      await schedules.update(testActor, closed, {
        name: 'Patching window',
        periods: aroundNow(),
        polarity: 'active',
      });
      await recompute(new Date());

      const held = await flagsOf(sensorId);
      assert.equal(held.state, 'paused');
      assert.equal(held.cause, 'user', 'the manual pause is what holds it now');

      const runtime = await db.query<{ message: string }>(
        'SELECT message FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      assert.equal(
        runtime[0]?.message,
        'replacing the PSU',
        'the words belong to the source that is reported',
      );

      const newest = await db.query<{ message: string }>(
        `SELECT message FROM sensor_state
         WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1`,
        [sensorId],
      );
      assert.equal(newest[0]?.message, 'replacing the PSU');
    });

    it('stores a grid as the hours it marks, even when an inactive polarity comes with it', async () => {
      // **The round trip a form makes** (`P-127`). `GET /schedules/:id` serves an inactive
      // schedule as `polarity: 'inactive'` *and* a grid of the hours it does monitor, because
      // `toGrid` resolves the polarity on the way out. Sending both back unchanged stored the
      // monitored hours as the inactive ones: a Sunday maintenance window became the only time
      // anything was watched, and nothing said so.
      const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => false));
      for (let day = 0; day < 6; day += 1) {
        for (let hour = 0; hour < 24; hour += 1) (grid[day] ?? [])[hour] = true;
      }

      const created = await schedules.create(testActor, {
        name: 'Six days on',
        grid,
        polarity: 'inactive',
      });
      const view = await schedules.get(created.id);
      assert.equal(view.polarity, 'active', 'the grid is what it says it is');
      // Monday is marked and Sunday is not, so Monday is monitored.
      assert.equal((view.grid[0] ?? [])[9], true);
      assert.equal((view.grid[6] ?? [])[9], false);
    });

    it('names the schedule in the state history, not just "a schedule"', async () => {
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      await recompute(OUTSIDE);

      const rows = await db.query<{ message: string }>(
        `SELECT message FROM sensor_state
         WHERE sensor_id = $1 ORDER BY time DESC LIMIT 1`,
        [sensorId],
      );
      assert.ok(rows[0]?.message.includes('Office hours'), rows[0]?.message);
    });

    it('leaves sensors alone when nothing assigns a schedule', async () => {
      assert.equal(await recompute(OUTSIDE), 0);
      assert.equal((await flagsOf(sensorId)).schedule, false);
    });

    it('lets a nearer assignment win, exactly as the resolver does', async () => {
      const office = await officeHours();
      const alwaysOn = (
        await schedules.create(testActor, { name: 'Always', periods: 'mo:00:00-su:24:00' })
      ).id;
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, office);
      await h.service.setSetting(testActor, deviceId, SCHEDULE_ID.key, alwaysOn);

      await recompute(OUTSIDE);
      assert.equal((await flagsOf(sensorId)).schedule, false, 'the device overrides the group');
      assert.equal((await flagsOf(otherSensorId)).schedule, true, 'its sibling still inherits');
    });

    it('treats an explicit null as "monitor me always", which is what an override means', async () => {
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      await h.service.setSetting(testActor, deviceId, SCHEDULE_ID.key, null);

      await recompute(OUTSIDE);
      assert.equal((await flagsOf(sensorId)).schedule, false);
      assert.equal((await flagsOf(otherSensorId)).schedule, true);
    });

    it('agrees with the resolver, which walks the tree the other way', async () => {
      // Two independent derivations of one rule. `applyPauses` descends from each assignment;
      // `resolveForObjects` climbs from each sensor. A test that only exercised one of them
      // would prove the SQL runs, not that it means what inheritance means.
      const office = await officeHours();
      const alwaysOn = (
        await schedules.create(testActor, { name: 'Always on', periods: 'mo:00:00-su:24:00' })
      ).id;
      await h.service.setSetting(testActor, probeId, SCHEDULE_ID.key, office);
      await h.service.setSetting(testActor, deviceId, SCHEDULE_ID.key, alwaysOn);
      await h.service.setSetting(testActor, otherDeviceId, SCHEDULE_ID.key, null);

      const resolved = await h.resolver.resolveForObjects<number | null>(
        [sensorId, otherSensorId],
        SCHEDULE_ID.key,
      );
      await recompute(OUTSIDE);

      for (const id of [sensorId, otherSensorId]) {
        const viaResolver = resolved.get(id)?.value ?? null;
        const expected = viaResolver === office;
        assert.equal(
          (await flagsOf(id)).schedule,
          expected,
          `sensor ${String(id)} resolves to ${String(viaResolver)}`,
        );
      }
    });

    // -------------------------------------------------------------------------------------
    // Taking effect.
    // -------------------------------------------------------------------------------------

    it('takes effect when the assignment is made, without waiting for a sweep', async () => {
      // Against the wall clock, on purpose: the point of this test is that the sink runs inside
      // `setSetting`'s own transaction, so a maintenance schedule assigned at 03:00 means 03:00
      // and not "some time in the next minute". The schedule is authored around whatever the
      // clock says when the suite runs, which is the only way to assert that without one.
      const closed = (
        await schedules.create(testActor, {
          name: 'Suspended right now',
          periods: aroundNow(),
          polarity: 'inactive',
          timezone: 'UTC',
        })
      ).id;

      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, closed);
      assert.equal((await flagsOf(sensorId)).schedule, true, 'paused before the call returned');

      await h.service.clearSetting(testActor, groupId, SCHEDULE_ID.key);
      assert.equal((await flagsOf(sensorId)).schedule, false, 'reverting lifts it immediately');
    });

    it('takes effect when the schedule itself is edited', async () => {
      const id = (
        await schedules.create(testActor, { name: 'Editable', periods: 'mo:00:00-su:24:00' })
      ).id;
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, id);
      await recompute(OUTSIDE);
      assert.equal((await flagsOf(sensorId)).schedule, false, 'always on to begin with');

      await schedules.update(
        testActor,
        id,
        { name: 'Editable', periods: 'mo:09:00-mo:17:00' },
        OUTSIDE,
      );
      assert.equal((await flagsOf(sensorId)).schedule, true, 'the edit paused it in its own tx');
    });

    it('pauses a sensor created inside a closed window, before it can scan', async () => {
      // **`P-109`.** `invalidates` skipped `object.created`, justified by "a sensor created
      // inside a closed window starts unpaused and is paused by the next sweep, within a minute
      // and before its first scan interval has usually elapsed". The cost half of that was
      // right; the timing half was not. `TimingWheel.add` implements the opposite — "the first
      // firing is the next tick that lands on the sensor's own phase — not a whole interval
      // away" — so the first scan lands uniformly in (0, intervalSeconds] while the sweep is
      // armed at the next wall-clock minute. At the default 60 s that is a coin flip; below it
      // the scan always wins.
      //
      // A sensor created at 02:00 on a weekend-maintenance window therefore scanned the target
      // being patched, wrote a transition timestamped *inside* the window, and armed a chain: a
      // page at 02:00 out of the exact window that exists to prevent one. §3 says a paused
      // sensor has "no scans, no notifications, no uptime accrual".
      const closed = (
        await schedules.create(testActor, {
          name: 'Weekend patching',
          periods: aroundNow(),
          polarity: 'inactive',
        })
      ).id;
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, closed);
      await recompute(new Date());

      const late = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'Created inside the window',
        sensorType: 'icmp.ping',
      });

      // No sweep in between: the flag has to be right the moment the sensor exists.
      const flags = await flagsOf(late.id);
      assert.equal(flags.schedule, true, 'held by the window it was created inside');
      assert.equal(flags.state, 'paused');

      // And the probe is never told to scan it, which is the consequence that matters.
      const assignments = await new ProbeConfigService({
        db,
        resolver: h.resolver,
      }).assignmentsFor(probeId);
      assert.ok(
        !assignments.sensors.some((sensor) => sensor.sensorId === late.id),
        'a paused sensor is not in its probe’s configuration at all',
      );
    });

    it('takes effect when a device is moved into a scheduled group', async () => {
      const other = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'unscheduled' })
      ).id;
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      await recompute(OUTSIDE);
      assert.equal((await flagsOf(sensorId)).schedule, true);

      await h.service.move(testActor, deviceId, other, { kind: 'none' });
      assert.equal((await flagsOf(sensorId)).schedule, false, 'moved out from under it');
    });

    // -------------------------------------------------------------------------------------
    // What the rest of the system sees.
    // -------------------------------------------------------------------------------------

    it('stops the probe being told to scan a schedule-paused sensor', async () => {
      const config = new ProbeConfigService({ db, resolver: h.resolver });
      const before = await config.assignmentsFor(probeId);
      assert.ok(before.sensors.some((sensor) => sensor.sensorId === sensorId));

      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      await recompute(OUTSIDE);

      const during = await config.assignmentsFor(probeId);
      assert.ok(!during.sensors.some((sensor) => sensor.sensorId === sensorId));
      assert.notEqual(during.version, before.version, 'and the probe can tell it changed');
    });

    it('says on the pause view which schedule is holding an object, and when it lifts', async () => {
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      const view = await h.service.pauseState(sensorId);
      assert.ok(view.schedule !== null);
      assert.ok(view.schedule.name.startsWith('Office hours'));
      assert.equal(view.schedule.definedOn, groupId, 'and where to go to change it');
      assert.equal(view.resumable, false, 'a schedule pause is not resumable by hand');
    });

    it('reports the parent cascade ahead of a schedule, in the order §5 evaluates them', async () => {
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      await h.service.pause(testActor, deviceId, { kind: 'indefinite' }, 'maintenance');
      const view = await h.service.pauseState(sensorId);
      assert.equal(view.paused, true);
      assert.equal(view.source, 'parent', 'the source a resume would have to act on first');
    });

    // -------------------------------------------------------------------------------------
    // The sweep.
    // -------------------------------------------------------------------------------------

    it('moves the flags when a window opens or closes, and pokes the config push once', async () => {
      let pushes = 0;
      const sweep = new ScheduleSweep({
        db,
        pauses,
        dependencies: settler,
        logger: silent,
        intervalMs: 60_000,
        onChanged: () => {
          pushes += 1;
        },
      });
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, await officeHours());
      // The assignment took effect against the wall clock, which is whatever it is when the
      // suite runs. Establish the baseline the sweep is measured from.
      await recompute(INSIDE);

      assert.equal(await sweep.sweep(OUTSIDE), 2, 'both sensors closed');
      assert.equal(pushes, 1);
      assert.equal(await sweep.sweep(OUTSIDE), 0, 'idempotent: nothing moved the second time');
      assert.equal(pushes, 1, 'and no push for a sweep that changed nothing');
      assert.equal(await sweep.sweep(INSIDE), 2, 'both sensors opened');
      assert.equal(pushes, 2);
    });

    it('sweeps once when it starts, rather than waiting for the top of the minute', async () => {
      // **`P-131`.** `paused_by_schedule` is a stored flag and the probes' configuration is built
      // from it, so a core that was down when a window closed came back with every flag as it was
      // before the boundary and handed the probes a list that said to keep scanning. Up to sixty
      // seconds of checks inside a window an operator had closed, on every restart — and the
      // whole point of a maintenance window is that nothing scans during it.
      //
      // Driven with a clock the sweep cannot see, so what is asserted is that a sweep happened at
      // all before any timer could have fired: the flags move, and the interval here is an hour.
      // Its own schedule, not the shared one: this test closes the window by writing to the row,
      // and a later test reading a schedule this one had shut would fail for no reason of its own.
      const window = (
        await schedules.create(testActor, { name: 'Restart window', periods: 'mo:00:00-su:24:00' })
      ).id;
      await h.service.setSetting(testActor, groupId, SCHEDULE_ID.key, window);
      await recompute(INSIDE);
      assert.notEqual(
        (await flagsOf(sensorId)).cause,
        'schedule',
        'inside the window to begin with',
      );

      // The window closes while nothing is running — which is what a restart across a boundary
      // looks like from the database's point of view. Closed at every hour rather than at a
      // particular one, so what this asserts is that a sweep ran and not what the wall clock
      // happened to be when the suite did.
      await db.query(`UPDATE schedule SET polarity = 'inactive' WHERE id = $1`, [window]);

      const sweep = new ScheduleSweep({
        db,
        pauses,
        dependencies: settler,
        logger: silent,
        intervalMs: 60 * 60_000,
      });
      await sweep.start();
      sweep.stop();

      assert.equal(
        (await flagsOf(sensorId)).cause,
        'schedule',
        'the flags were brought up to date before anything could be served',
      );
    });

    it('survives a failure rather than taking every future window with it', async () => {
      const broken = new SchedulePauses({
        logger: silent,
        repository: {
          anyWork: () => Promise.reject(new Error('boom')),
        } as unknown as ScheduleRepository,
      });
      const sweep = new ScheduleSweep({
        db,
        pauses: broken,
        dependencies: settler,
        logger: silent,
        intervalMs: 60_000,
      });
      assert.equal(await sweep.sweep(OUTSIDE), 0);
    });

    // -------------------------------------------------------------------------------------
    // The library.
    // -------------------------------------------------------------------------------------

    it('refuses an assignment naming a schedule that does not exist', async () => {
      // jsonb carries no foreign key, so nothing else would catch it. A dangling id looks like
      // a schedule in the UI and never pauses anything, which is the worst of both.
      await assert.rejects(
        () => h.service.setSetting(testActor, deviceId, SCHEDULE_ID.key, 999_999),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'OBJECT_INVALID');
          return true;
        },
      );
    });

    it('refuses to delete a schedule something still points at, and names what', async () => {
      const id = (
        await schedules.create(testActor, { name: 'Doomed', periods: 'mo:09:00-mo:17:00' })
      ).id;
      await h.service.setSetting(testActor, deviceId, SCHEDULE_ID.key, id);

      await assert.rejects(
        () => schedules.delete(testActor, id),
        (error: unknown) => {
          const err = error as { code?: string; details?: { usedBy?: { name: string }[] } };
          assert.equal(err.code, 'OBJECT_NOT_DELETABLE');
          assert.equal(err.details?.usedBy?.[0]?.name, 'device');
          return true;
        },
      );

      await h.service.clearSetting(testActor, deviceId, SCHEDULE_ID.key);
      await schedules.delete(testActor, id);
      await assert.rejects(() => schedules.get(id));
    });

    it('reports how many objects hold it, not how many the page returned', async () => {
      // **`P-129`.** The refusal was built from `usedBy`'s length, and `usedBy` is a page of
      // fifty. A schedule assigned to more than that told the operator fifty; they clear fifty,
      // try again, and are told fifty again. Asserted with a small page rather than 51 objects,
      // because the defect is the two numbers being confused and not the size of either.
      const id = (
        await schedules.create(testActor, { name: 'Popular', periods: 'mo:09:00-mo:17:00' })
      ).id;
      // Past the page, on purpose: at fifty or fewer the two numbers agree and the defect is
      // invisible, which is exactly why it survived. Written straight into `object_setting`
      // rather than through fifty-one object creations — the assignment is what is counted, and
      // building a tree to prove an off-by-a-page would be a slow test of something else.
      const assigned: number[] = [deviceId, sensorId];
      for (let i = 0; i < 50; i += 1) {
        assigned.push(
          (
            await h.service.create(testActor, {
              kind: 'sensor',
              parentId: deviceId,
              name: `filler-${String(i)}`,
              sensorType: 'icmp.ping',
            })
          ).id,
        );
      }
      await db.query(
        `INSERT INTO object_setting (object_id, key, value)
         SELECT unnest($1::bigint[]), $2, to_jsonb($3::bigint)`,
        [assigned, SCHEDULE_ID.key, id],
      );

      assert.equal((await repo.usedBy(db, id)).length, 50, 'the page stops at fifty');
      assert.equal(await repo.usedByCount(db, id), 52, 'and the count is the truth');

      await assert.rejects(
        () => schedules.delete(testActor, id),
        (error: unknown) => {
          const err = error as { message: string; details?: { usedByTotal?: number } };
          assert.equal(err.details?.usedByTotal, 52);
          assert.match(err.message, /assigned to 52 object/);
          return true;
        },
      );
    });

    it('refuses a schedule a rediscovery rule uses, by name rather than by constraint', async () => {
      // **`P-130`.** `discovery_schedule.schedule_id` is a `RESTRICT` foreign key and nothing was
      // checking it, so this delete reached the database and came back as a constraint violation
      // — a 500 with a constraint name in it, for something ordinary and correctable.
      const id = (
        await schedules.create(testActor, {
          name: 'Rediscovery window',
          periods: 'mo:09:00-mo:17:00',
        })
      ).id;
      await db.query(
        `INSERT INTO discovery_schedule
           (name, group_id, probe_id, range_text, cadence, schedule_id)
         VALUES ('nightly', $1, $2, '192.0.2.0/24', 'daily', $3)`,
        [groupId, probeId, id],
      );

      await assert.rejects(
        () => schedules.delete(testActor, id),
        (error: unknown) => {
          const err = error as {
            code?: string;
            details?: { usedByRediscovery?: { name: string }[] };
          };
          assert.equal(err.code, 'OBJECT_NOT_DELETABLE');
          assert.equal(err.details?.usedByRediscovery?.[0]?.name, 'nightly');
          return true;
        },
      );
    });

    it('refuses to delete a built-in, because the manual points at it', async () => {
      const id = await officeHours();
      await assert.rejects(
        () => schedules.delete(testActor, id),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'OBJECT_NOT_DELETABLE');
          return true;
        },
      );
    });

    it('refuses a schedule authored two ways at once', async () => {
      await assert.rejects(
        () =>
          schedules.create(testActor, {
            name: 'Both',
            periods: 'mo:09:00-mo:17:00',
            grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => true)),
          }),
        (error: unknown) => {
          const err = error as { code?: string; details?: { problems?: string[] } };
          assert.equal(err.code, 'OBJECT_INVALID');
          assert.ok(err.details?.problems?.[0]?.includes('not both'));
          return true;
        },
      );
    });

    it('audits a schedule change with the periods a person can read', async () => {
      const id = (
        await schedules.create(testActor, { name: 'Audited', periods: 'mo:09:00-mo:17:00' })
      ).id;
      await schedules.update(testActor, id, { name: 'Audited', periods: 'mo:10:00-mo:16:00' });

      const rows = await db.query<{ action: string; diff: { field: string; after: unknown }[] }>(
        `SELECT action, diff FROM audit_log WHERE action = 'schedule.updated'
         ORDER BY id DESC LIMIT 1`,
      );
      const changed = rows[0]?.diff.find((entry) => entry.field === 'schedule.periods');
      assert.equal(changed?.after, 'mo:10:00-mo:16:00');
    });

    // -------------------------------------------------------------------------------------
    // Over HTTP.
    // -------------------------------------------------------------------------------------

    it('serves both authoring forms of every schedule', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/schedules' });
      assert.equal(response.statusCode, 200);
      const body = response.json<{
        items: { name: string; grid: boolean[][]; periods: string }[];
      }>();
      const office = body.items.find((item) => item.name.startsWith('Office hours'));
      assert.ok(office !== undefined);
      assert.equal(office.grid.length, 7);
      assert.equal(office.grid[0]?.length, 24);
      assert.ok(office.periods.includes('mo:08:00-mo:18:00'));
    });

    it('creates and deletes a schedule over HTTP', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/schedules',
        payload: { name: 'Over HTTP', periods: 'we:03:00-we:04:00' },
      });
      assert.equal(created.statusCode, 201);
      const id = created.json<{ id: number }>().id;

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/schedules/${String(id)}`,
      });
      assert.equal(deleted.statusCode, 200);
      const gone = await app.inject({ method: 'GET', url: `/api/v1/schedules/${String(id)}` });
      assert.equal(gone.statusCode, 404);
    });

    it('rejects a schedule that would never monitor anything', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/schedules',
        payload: { name: 'Never', periods: 'mo:00:00-su:24:00', polarity: 'inactive' },
      });
      assert.equal(response.statusCode, 400);
      assert.ok(
        JSON.stringify(response.json()).includes('never monitor'),
        'and says so in terms an operator can act on',
      );
    });
  },
);

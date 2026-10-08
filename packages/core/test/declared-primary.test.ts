import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { QueryResultRow } from 'pg';
import { pino } from 'pino';
import type { SensorType } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { ChannelResolver, type ResolvedChannels } from '../src/ingestion/channels.js';
import { ResultCacheInvalidator } from '../src/ingestion/invalidation.js';
import type { Actor, AuditSink } from '../src/objects/audit.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { declaredChannelLookup, declaredLimitsLookup } from '../src/state/declared-limits.js';
import {
  repairDeclaredPrimaries,
  type DeclaredPrimaryRepairOptions,
  type DeclaredPrimaryRepairReport,
} from '../src/state/declared-primary.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';
import { somebodyWaits } from './support/waits-for-lock.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** `snmp.table`'s shape without SNMP: one channel per column named, the first primary. */
const columns: SensorType = {
  id: 'test.columns',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      columns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1 } },
        },
      },
    },
  },
  channels: (params) => {
    const named = Array.isArray(params['columns']) ? (params['columns'] as { key: string }[]) : [];
    if (named.length === 0) return [{ key: 'value', name: 'Value', isPrimary: true }];
    return named.map((column, at) => ({
      key: column.key,
      name: column.key,
      ...(at === 0 ? { isPrimary: true } : {}),
    }));
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/** The same type under an id the repair's catalogue does not register: a build that dropped it. */
const dropped: SensorType = { ...columns, id: 'test.dropped' };

/** A type that throws for some stored parameters; its `{}` answer makes `value` primary. */
const brittle: SensorType = {
  id: 'test.brittle',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { mode: { enum: ['fine', 'typeError'] } },
  },
  channels: (params) => {
    if (params['mode'] === 'typeError') throw new TypeError('no such column');
    return [{ key: 'value', name: 'Value', isPrimary: true }];
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/** A type that declares channels and no primary. */
const unranked: SensorType = {
  id: 'test.unranked',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  channels: () => [
    { key: 'a', name: 'A' },
    { key: 'b', name: 'B' },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/** What the repair recorded: who, and which channel's `isPrimary` went which way. */
interface Recorded {
  actor: Actor;
  moves: { sensorId: number | null; key: string; from: boolean; to: boolean }[];
}

const REPAIR: Actor = { kind: 'system', component: 'declared-primary-startup-repair' };

const cols = (...keys: string[]): Record<string, unknown> => ({
  columns: keys.map((key) => ({ key })),
});

/**
 * The start-up repair of a declared primary an earlier build left non-primary (`P-323`).
 *
 * Before `P-314`, the reading that created a declared primary's row created it plain, and nothing
 * but an edit that changed the declaration again would move the primary onto it. The repair runs
 * every sensor's type on its stored parameters and moves `is_primary` where that row exists and is
 * not primary, demoting first, audited by its own system actor.
 */
describe(
  'the declared primary moved at start-up (P-323)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let deviceId: number;
    let probeId: number;

    before(async () => {
      scratch = await createScratchDatabase('declared_primary');
      db = scratch.db;
      harness = await buildHarness(db, { types: [columns, dropped, brittle, unranked] });
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'switch',
        host: '192.0.2.41',
      });
      deviceId = device.id;
      probeId = probe.id;
    });

    after(async () => {
      await scratch.drop();
    });

    /** The catalogue of the build doing the repair: `test.dropped` is no longer in it. */
    const catalogue = testCatalogue([columns, brittle, unranked]);

    /** Records what it is given, and writes it through `also` as `main.ts`'s sinks would. */
    const recording = (recorded: Recorded[], also?: AuditSink): AuditSink => ({
      record: async (q, actor, mutations, at) => {
        recorded.push({
          actor,
          moves: mutations.map((one) =>
            one.action === 'channel.redeclared'
              ? {
                  sensorId: one.objectId,
                  key: one.channelKey,
                  from: one.before.isPrimary,
                  to: one.after.isPrimary,
                }
              : assert.fail(`audited ${one.action}`),
          ),
        });
        await also?.record(q, actor, mutations, at);
      },
    });

    const repair = (
      audit: AuditSink,
      more: Partial<DeclaredPrimaryRepairOptions> = {},
    ): Promise<DeclaredPrimaryRepairReport> =>
      within(
        30_000,
        'the repair',
        repairDeclaredPrimaries({ db, logger: silent, catalogue, audit, ...more }),
      );

    const primaryOf = async (sensorId: number): Promise<string[]> =>
      (
        await db.query<{ key: string }>(
          'SELECT key FROM channel WHERE sensor_id = $1 AND is_primary ORDER BY key',
          [sensorId],
        )
      ).map((one) => one.key);

    const versionOf = async (sensorId: number): Promise<string> =>
      (
        await db.query<{ version: string }>('SELECT version::text FROM object WHERE id = $1', [
          sensorId,
        ])
      )[0]?.version ?? 'gone';

    /**
     * A sensor of `type` whose rows are exactly `rows` (the ones marked `true` primary) and whose
     * stored parameters are `stored`, written behind the type's back as an earlier build left them.
     */
    const sensorWith = async (
      type: string,
      created: Record<string, unknown>,
      stored: Record<string, unknown>,
      rows: readonly (readonly [string, boolean])[],
      parentId: number = deviceId,
    ): Promise<number> => {
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId,
        name: `${type}-${String(process.hrtime.bigint())}`,
        sensorType: type,
        params: created,
      });
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [sensor.id]);
      for (const [key, primary] of rows) {
        await db.query(
          "INSERT INTO channel (sensor_id, key, name, unit, is_primary) VALUES ($1, $2, $2, '', $3)",
          [sensor.id, key, primary],
        );
      }
      await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
        sensor.id,
        JSON.stringify(stored),
      ]);
      return sensor.id;
    };

    const cases: readonly {
      name: string;
      type: string;
      created: Record<string, unknown>;
      stored: Record<string, unknown>;
      rows: readonly (readonly [string, boolean])[];
      primary: readonly string[];
      /** `[key, from, to]` for each channel whose `isPrimary` was audited as moved, in order. */
      moves: readonly (readonly [string, boolean, boolean])[];
    }[] = [
      {
        name: 'moved: the declared primary a reading created before P-314',
        type: 'test.columns',
        created: cols('used', 'free'),
        stored: cols('fresh', 'used', 'free'),
        rows: [
          ['used', true],
          ['free', false],
          ['fresh', false],
        ],
        primary: ['fresh'],
        moves: [
          ['used', true, false],
          ['fresh', false, true],
        ],
      },
      {
        name: 'moved off a column the parameters no longer name',
        type: 'test.columns',
        created: cols('gone', 'kept'),
        stored: cols('kept'),
        rows: [
          ['gone', true],
          ['kept', false],
        ],
        primary: ['kept'],
        moves: [
          ['gone', true, false],
          ['kept', false, true],
        ],
      },
      {
        name: 'already right: left',
        type: 'test.columns',
        created: cols('used', 'free'),
        stored: cols('used', 'free'),
        rows: [
          ['used', true],
          ['free', false],
        ],
        primary: ['used'],
        moves: [],
      },
      {
        name: 'no row for the declared primary: left, for the reading that creates it (P-314)',
        type: 'test.columns',
        created: cols('used'),
        stored: cols('fresh', 'used'),
        rows: [['used', true]],
        primary: ['used'],
        moves: [],
      },
      {
        name: 'the type throws for the stored parameters: left, though `{}`’s primary has a row',
        type: 'test.brittle',
        created: { mode: 'fine' },
        stored: { mode: 'typeError' },
        rows: [
          ['value', false],
          ['kept', true],
        ],
        primary: ['kept'],
        moves: [],
      },
      {
        name: 'the type declares no primary: left',
        type: 'test.unranked',
        created: {},
        stored: {},
        rows: [
          ['a', false],
          ['b', true],
        ],
        primary: ['b'],
        moves: [],
      },
      {
        name: 'the type is not registered in this build: left',
        type: 'test.dropped',
        created: cols('used'),
        stored: cols('fresh', 'used'),
        rows: [
          ['fresh', false],
          ['used', true],
        ],
        primary: ['used'],
        moves: [],
      },
      {
        name: 'a sensor with no primary: given the declared one',
        type: 'test.columns',
        created: cols('used', 'free'),
        stored: cols('used', 'free'),
        rows: [
          ['used', false],
          ['free', false],
        ],
        primary: ['used'],
        moves: [['used', false, true]],
      },
    ];

    it('moves what each case says, in pages, audited by the system, and nothing the second time', async () => {
      const ids = new Map<string, number>();
      for (const one of cases) {
        ids.set(one.name, await sensorWith(one.type, one.created, one.stored, one.rows));
      }

      // Behind the database sink and the real invalidator, as `ingestionAuditSinks` puts them.
      const forgot: number[] = [];
      const invalidator = new ResultCacheInvalidator({
        channels: {
          forget: (sensorId) => {
            forgot.push(sensorId);
            return 0;
          },
          clear: () => undefined,
        },
        logger: silent,
      });
      const recorded: Recorded[] = [];
      let first: DeclaredPrimaryRepairReport;
      try {
        // Pages of two, so the eight sensors (and the probe's own) take several.
        first = await repair(
          recording(recorded, new CompositeAuditSink([new DatabaseAuditSink(), invalidator])),
          { batchSize: 2 },
        );
      } finally {
        invalidator.stop();
      }

      for (const one of cases) {
        const id = ids.get(one.name) ?? assert.fail(one.name);
        assert.deepEqual(await primaryOf(id), one.primary, `${one.name}: its primary`);
        assert.deepEqual(
          recorded.flatMap((entry) =>
            entry.moves
              .filter((move) => move.sensorId === id)
              .map((move) => [move.key, move.from, move.to]),
          ),
          one.moves,
          `${one.name}: audited, demoted first`,
        );
        if (one.moves.length > 0) {
          assert.ok(forgot.includes(id), `${one.name}: ingestion forgot the sensor (M-04)`);
        }
      }
      for (const entry of recorded) assert.deepEqual(entry.actor, REPAIR);
      assert.deepEqual(
        {
          moved: first.moved,
          skipped: first.skipped,
          failedPages: first.failedPages,
          undeclared: first.undeclared,
          types: first.undeclaredTypes,
          complete: first.complete,
        },
        {
          moved: 3,
          skipped: 0,
          failedPages: 0,
          undeclared: 1,
          types: ['test.brittle'],
          complete: true,
        },
        'the report counts what it moved and what it could not judge',
      );
      assert.ok(first.sensors >= cases.length, 'every sensor read');

      // In the audit log as the move ingestion makes, by this pass's own actor.
      const moved = ids.get(cases[0]?.name ?? '') ?? assert.fail('the first case');
      const entries = (
        await new AuditRepository().list(db, {
          objectId: moved,
          categories: ['channel'],
          limit: 50,
        })
      ).filter((entry) => entry.action === 'channel.redeclared');
      assert.deepEqual(
        entries
          .map((entry) => ({
            actor: entry.actor,
            diff: entry.diff.map((change) => ({ ...change })),
          }))
          .sort((a, b) => String(a.diff[0]?.field).localeCompare(String(b.diff[0]?.field))),
        [
          {
            actor: REPAIR,
            diff: [{ field: 'channel.fresh.isPrimary', before: false, after: true }],
          },
          {
            actor: REPAIR,
            diff: [{ field: 'channel.used.isPrimary', before: true, after: false }],
          },
        ],
      );

      // Idempotent: the same pass again writes nothing, so not even a sensor's version moves.
      const versions = await Promise.all([...ids.values()].map(versionOf));
      const again: Recorded[] = [];
      const second = await repair(recording(again), { batchSize: 2 });
      assert.equal(second.moved, 0);
      assert.equal(second.sensors, first.sensors);
      assert.deepEqual(again, [], 'nothing audited the second time');
      assert.deepEqual(await Promise.all([...ids.values()].map(versionOf)), versions);
      for (const one of cases) {
        assert.deepEqual(await primaryOf(ids.get(one.name) ?? 0), one.primary, `${one.name}: kept`);
      }
    });

    it('stops between pages once shutdown has begun, and says it did not finish', async () => {
      const id = await sensorWith('test.columns', cols('used'), cols('fresh', 'used'), [
        ['fresh', false],
        ['used', true],
      ]);
      const stopped = new AbortController();
      stopped.abort();
      const recorded: Recorded[] = [];
      const report = await repair(recording(recorded), { signal: stopped.signal });
      assert.deepEqual(
        { sensors: report.sensors, moved: report.moved, complete: report.complete },
        { sensors: 0, moved: 0, complete: false },
      );
      assert.deepEqual(await primaryOf(id), ['used']);
      // And the next start does it.
      await repair(recording(recorded));
      assert.deepEqual(await primaryOf(id), ['fresh']);
    });

    // ── at the same time as something else ───────────────────────────────────────────────────

    /** A gate: `wait` resolves once `open` is called. */
    const gate = (): { wait: Promise<void>; open: () => void } => {
      let open: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    };

    /**
     * The repair's database, stopping inside its transaction until `release` once it has read the
     * parameters it decides from (after its lock, which is what the waiting proves), and running
     * `beforeLock` between the unlocked read and the transaction.
     */
    const pausing = (hooks: {
      beforeLock?: () => Promise<void>;
      held?: { locked: () => void; released: Promise<void> };
    }): DeclaredPrimaryRepairOptions['db'] => ({
      query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
        db.query<T>(text, values),
      tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
        await hooks.beforeLock?.();
        return db.tx((q) =>
          fn({
            query: async <R extends QueryResultRow>(
              text: string,
              values?: readonly unknown[],
            ): Promise<R[]> => {
              const rows = await q.query<R>(text, values);
              if (hooks.held !== undefined && text.includes('FROM sensor_config')) {
                hooks.held.locked();
                await hooks.held.released;
              }
              return rows;
            },
          }),
        );
      },
    });

    const reading = (sensorId: number, keys: readonly string[]): CheckResult => ({
      sensorId,
      at: new Date('2026-10-08T12:00:00.000Z').toISOString(),
      outcome: 'ok',
      message: '',
      durationMs: 1,
      channels: keys.map((key) => ({ key, value: 1 })),
    });

    /** A resolver as `main.ts` builds it: it holds the sensor to create a channel (`P-314`). */
    const resolver = (recorded: Recorded[]): ChannelResolver =>
      new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue),
        audit: recording(recorded),
      });

    it('skips a sensor another transaction holds, counts it, and moves it on the next run', async () => {
      // A reading holds the sensor while it creates `extra`, which is not the declared primary.
      // The repair, which saw `used` non-primary unlocked, does not wait for it (`P-323` review):
      // it finishes with the sensor skipped and counted, and the next run moves it.
      const id = await sensorWith('test.columns', cols('used'), cols('used', 'extra'), [
        ['other', true],
        ['used', false],
      ]);
      const locked = gate();
      const released = gate();
      const fromReading: Recorded[] = [];
      const creating = db.tx((q) =>
        resolver(fromReading).resolve(
          {
            query: async <R extends QueryResultRow>(
              text: string,
              values?: readonly unknown[],
            ): Promise<R[]> => {
              const rows = await q.query<R>(text, values);
              if (text.includes('FOR NO KEY UPDATE')) {
                locked.open();
                await released.wait;
              }
              return rows;
            },
          },
          [reading(id, ['extra'])],
        ),
      );
      const recorded: Recorded[] = [];
      try {
        await within(10_000, 'the reading holding its sensor', locked.wait);
        // Under the pool's lock_timeout, so a repair that waited would fail here, not pass late.
        const report = await within(
          4_000,
          'the repair, beside a held sensor',
          repair(recording(recorded)),
        );
        assert.deepEqual(
          { moved: report.moved, skipped: report.skipped, failedPages: report.failedPages },
          { moved: 0, skipped: 1, failedPages: 0 },
        );
        assert.equal(recorded.length, 0, 'nothing moved, so nothing audited');
        released.open();
        const created = await within(10_000, 'the reading', creating);
        assert.equal(created.created, 1, 'the reading created its row');
      } finally {
        released.open();
      }
      assert.deepEqual(await primaryOf(id), ['other'], 'left as it was');

      const next = await repair(recording(recorded));
      assert.deepEqual({ moved: next.moved, skipped: next.skipped }, { moved: 1, skipped: 0 });
      assert.deepEqual(await primaryOf(id), ['used']);
      assert.deepEqual(fromReading, [], 'the reading moved nothing: `extra` is not the primary');
      assert.deepEqual(
        recorded.flatMap((entry) => entry.moves.map((move) => [move.sensorId, move.key, move.to])),
        [
          [id, 'other', false],
          [id, 'used', true],
        ],
      );
      const extra = await db.query('SELECT 1 FROM channel WHERE sensor_id = $1 AND key = $2', [
        id,
        'extra',
      ]);
      assert.equal(extra.length, 1);
    });

    it('neither waits for nor deadlocks with a subtree delete holding a sensor of its page', async () => {
      // `deleteIds` locks `object` rows in scan order, not by id. The delete below holds the
      // sensor of the device it is removing, uncommitted, while the repair runs over a page that
      // holds both that sensor and another one: the repair moves the other, skips the held one,
      // and returns while the delete is still open; then the delete commits.
      const doomed = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'doomed',
        host: '192.0.2.42',
      });
      const gone = await sensorWith(
        'test.columns',
        cols('used'),
        cols('used', 'free'),
        [
          ['other', true],
          ['used', false],
        ],
        doomed.id,
      );
      const kept = await sensorWith('test.columns', cols('used'), cols('used', 'free'), [
        ['other', true],
        ['used', false],
      ]);
      const recorded: Recorded[] = [];
      let during: DeclaredPrimaryRepairReport | undefined;
      const was = harness.audit.also;
      harness.audit.also = {
        record: async (_q, _actor, mutations) => {
          if (!mutations.some((one) => one.action === 'object.deleted')) return;
          if (during !== undefined) return;
          during = await within(
            4_000,
            'the repair while the delete holds its rows',
            repair(recording(recorded)),
          );
        },
      };
      try {
        await within(
          20_000,
          'the delete',
          harness.service.delete(
            testActor,
            doomed.id,
            { kind: 'exact', descendants: 1 },
            { kind: 'none' },
          ),
        );
      } finally {
        harness.audit.also = was;
      }
      assert.ok(during !== undefined, 'the delete never reached its audit entry');
      assert.deepEqual(
        { moved: during.moved, skipped: during.skipped, failedPages: during.failedPages },
        { moved: 1, skipped: 1, failedPages: 0 },
      );
      assert.deepEqual(await primaryOf(kept), ['used']);
      assert.deepEqual(await primaryOf(gone), [], 'deleted, with its channels');
      assert.equal(await versionOf(gone), 'gone');
      assert.deepEqual(
        recorded.flatMap((entry) => entry.moves.map((move) => move.sensorId)),
        [kept, kept],
        'only the sensor it held was moved',
      );
    });

    it('goes on past a page whose transaction throws, and says which', async () => {
      // Pages of one, the first failing: the sensor after it is still moved, and the failed one
      // is moved by the next run. The pass resolves; it does not reject.
      const first = await sensorWith('test.columns', cols('used'), cols('used', 'free'), [
        ['other', true],
        ['used', false],
      ]);
      const second = await sensorWith('test.columns', cols('used'), cols('used', 'free'), [
        ['other', true],
        ['used', false],
      ]);
      let failed = 0;
      const failingOnce: DeclaredPrimaryRepairOptions['db'] = {
        query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
          db.query<T>(text, values),
        tx: <T>(fn: (q: Queryable) => Promise<T>): Promise<T> =>
          db.tx(async (q) => {
            if (failed === 0) {
              failed += 1;
              throw new Error('a page that cannot be moved');
            }
            return fn(q);
          }),
      };
      const recorded: Recorded[] = [];
      const lines: string[] = [];
      const logger = pino(
        { level: 'warn' },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      );
      const report = await repair(recording(recorded), {
        db: failingOnce,
        batchSize: 1,
        logger,
      });
      assert.equal(failed, 1);
      const said = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        said.map((one) => [
          one['phase'],
          one['firstSensorId'],
          one['lastSensorId'],
          one['message'],
        ]),
        [['move-page', String(first), String(first), 'a page that cannot be moved']],
        'the failed page, by its range and its error',
      );
      assert.deepEqual(
        {
          moved: report.moved,
          failedPages: report.failedPages,
          skipped: report.skipped,
          complete: report.complete,
        },
        { moved: 1, failedPages: 1, skipped: 0, complete: true },
      );
      assert.deepEqual(await primaryOf(first), ['other'], 'its page failed');
      assert.deepEqual(await primaryOf(second), ['used'], 'the page after it went on');
      await repair(recording(recorded));
      assert.deepEqual(await primaryOf(first), ['used'], 'moved by the next run');
    });

    it('holds the sensor while it moves, and a reading creating a channel waits for it', async () => {
      const id = await sensorWith('test.columns', cols('used'), cols('used', 'extra'), [
        ['other', true],
        ['used', false],
      ]);
      const locked = gate();
      const released = gate();
      const recorded: Recorded[] = [];
      const repairing = repairDeclaredPrimaries({
        db: pausing({ held: { locked: locked.open, released: released.wait } }),
        logger: silent,
        catalogue,
        audit: recording(recorded),
      });
      let creating: Promise<ResolvedChannels> | undefined;
      try {
        await within(10_000, 'the repair holding its sensor', locked.wait);
        // A reading of a channel that exists takes no lock on the sensor: not held up.
        await within(
          5_000,
          'a reading of an existing channel',
          db.tx((q) => resolver([]).resolve(q, [reading(id, ['other'])])),
        );
        creating = db.tx((q) => resolver([]).resolve(q, [reading(id, ['extra'])]));
        await somebodyWaits(db, 'the reading creating a channel waiting for the repair');
        released.open();
        const [report, created] = await within(
          10_000,
          'the repair and the reading',
          Promise.all([repairing, creating]),
        );
        assert.equal(report.moved, 1);
        assert.equal(created.created, 1);
      } finally {
        released.open();
      }
      assert.deepEqual(await primaryOf(id), ['used']);
    });

    it('decides again under the lock: an edit that moved the declaration meanwhile wins', async () => {
      // The unlocked read sees `used` declared primary and not primary. Before the repair locks,
      // an edit puts `other` back first, which is already primary (`P-309` moves nothing). The
      // repair must read the edit's parameters under its lock and leave `other` where it is.
      const id = await sensorWith('test.columns', cols('other', 'used'), cols('used', 'other'), [
        ['other', true],
        ['used', false],
      ]);
      const recorded: Recorded[] = [];
      let edited = false;
      const report = await within(
        30_000,
        'the repair',
        repairDeclaredPrimaries({
          db: pausing({
            beforeLock: async () => {
              if (edited) return;
              edited = true;
              await harness.service.update(
                testActor,
                id,
                { kind: 'sensor', params: cols('other', 'used') },
                { kind: 'none' },
              );
            },
          }),
          logger: silent,
          catalogue,
          audit: recording(recorded),
        }),
      );
      assert.ok(edited, 'the repair never reached its lock');
      assert.equal(report.moved, 0);
      assert.deepEqual(recorded, []);
      assert.deepEqual(await primaryOf(id), ['other']);
    });
  },
);

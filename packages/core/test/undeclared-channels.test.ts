import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { QueryResultRow } from 'pg';
import { pino } from 'pino';
import type { SensorType } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { Visibility } from '../src/auth/access.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import type { Actor, AuditSink } from '../src/objects/audit.js';
import { declaredChannelLookup } from '../src/state/declared-limits.js';
import {
  repairUndeclaredChannels,
  UNDECLARED_CHANNEL_REPAIR,
  type UndeclaredChannelRepairOptions,
} from '../src/state/undeclared-channels.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** The keys every reading of `test.mended` names. */
const KEYS = ['status', 'wide', 'octets', 'level', 'extra', 'turned'] as const;

/** Parameters the later build still cannot answer for: a bug it did not fix. */
const STILL_BROKEN = 99;

/**
 * One type, two builds of it (`P-312`).
 *
 * The later build declares, for any parameters but `STILL_BROKEN`: a status lookup, a 64-bit
 * counter (`wide`), another (`octets`), a gauge (`level`) and a gauge (`turned`), and nothing for
 * `extra`.
 */
const fixed: SensorType = {
  id: 'test.mended',
  category: 'Custom',
  costHint: 'light',
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { gen: { type: 'integer' } },
  },
  channels: (params) => {
    if (params['gen'] === STILL_BROKEN) throw new TypeError('generation still not understood');
    return [
      { key: 'status', name: 'Status', isPrimary: true, lookup: 'ms.snmp.if-oper-status' },
      { key: 'wide', name: 'Wide', counter: { bits: 64 } },
      { key: 'octets', name: 'Octets', counter: { bits: 64 } },
      { key: 'level', name: 'Level' },
      { key: 'turned', name: 'Turned' },
    ];
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/**
 * The earlier build: it throws for any parameters naming a generation, as a type with a bug
 * does, and its answer to `{}` — the fallback — declares a placeholder primary, `wide` and
 * `turned` as 32-bit counters, and `extra` with a lookup the later build does not declare.
 */
const broken: SensorType = {
  ...fixed,
  channels: (params) => {
    if (params['gen'] !== undefined) throw new TypeError('generation not understood');
    return [
      { key: 'value', name: 'Value', isPrimary: true },
      { key: 'wide', name: 'Wide', counter: { bits: 32 } },
      { key: 'turned', name: 'Turned', counter: { bits: 32 } },
      { key: 'extra', name: 'Extra', lookup: 'ms.snmp.if-admin-status' },
    ];
  },
};

interface Row {
  key: string;
  lookup_id: string | null;
  counter_bits: number | null;
  undeclared: boolean;
}

/** What the earlier build's fallback writes for `KEYS`. */
const FROM_FALLBACK: readonly Row[] = [
  { key: 'extra', lookup_id: 'ms.snmp.if-admin-status', counter_bits: null, undeclared: true },
  { key: 'level', lookup_id: null, counter_bits: null, undeclared: true },
  { key: 'octets', lookup_id: null, counter_bits: null, undeclared: true },
  { key: 'status', lookup_id: null, counter_bits: null, undeclared: true },
  { key: 'turned', lookup_id: null, counter_bits: 32, undeclared: true },
  { key: 'wide', lookup_id: null, counter_bits: 32, undeclared: true },
];

describe(
  'a channel created without its declared shape (P-312)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let deviceId: number;
    let made = 0;

    before(async () => {
      scratch = await createScratchDatabase('undeclared_channels');
      db = scratch.db;
      harness = await buildHarness(db, { types: [fixed] });
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'switch',
        host: '192.0.2.40',
      });
      deviceId = device.id;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      // Each test's report is about its own sensors: nothing an earlier one left is marked.
      await db.query('UPDATE channel SET undeclared = false WHERE undeclared');
      harness.audit.recorded.length = 0;
    });

    /**
     * A sensor of `test.mended` whose channels do not exist yet, as before its first reading. A
     * `gen` the later build cannot answer either is stored behind the type's back, as an earlier
     * build could have left it.
     */
    async function sensor(gen: number | null): Promise<number> {
      made += 1;
      const created = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `mended-${String(made)}`,
        sensorType: 'test.mended',
        params: gen === null ? {} : { gen: gen === STILL_BROKEN ? 1 : gen },
      });
      if (gen === STILL_BROKEN) {
        await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
          created.id,
          JSON.stringify({ gen }),
        ]);
      }
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [created.id]);
      // Its `object.created`, which is the harness's and not the repair's.
      harness.audit.recorded.length = 0;
      return created.id;
    }

    /** Its first reading, through a resolver over the given build of the catalogue. */
    async function read(
      sensorIds: readonly number[],
      types: readonly SensorType[],
      keys: readonly string[] = KEYS,
    ): Promise<{ created: number; createdUndeclared: number }> {
      const catalogue = testCatalogue(types);
      const resolver = new ChannelResolver({
        logger: silent,
        declaredShape: declaredChannelLookup(catalogue),
      });
      const results: CheckResult[] = sensorIds.map((sensorId) => ({
        sensorId,
        at: new Date().toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: keys.map((key) => ({ key, value: 1 })),
      }));
      return db.tx((q) => resolver.resolve(q, results));
    }

    async function rows(sensorId: number): Promise<Row[]> {
      return db.query<Row>(
        `SELECT key, lookup_id, counter_bits, undeclared FROM channel
         WHERE sensor_id = $1 ORDER BY key`,
        [sensorId],
      );
    }

    async function versionOf(id: number): Promise<number> {
      const [row] = await db.query<{ version: number }>(
        'SELECT version FROM object WHERE id = $1',
        [id],
      );
      return row?.version ?? assert.fail(`no object ${String(id)}`);
    }

    function repair(
      types: readonly SensorType[],
      options: Partial<UndeclaredChannelRepairOptions> = {},
    ) {
      return repairUndeclaredChannels({
        db,
        logger: silent,
        catalogue: testCatalogue(types),
        audit: harness.audit,
        ...options,
      });
    }

    /** The audit's `channel.redeclared` entries, as `sensor/key: lookup, width`. */
    function redeclared(): string[] {
      return harness.audit.recorded.map((one) =>
        one.action === 'channel.redeclared'
          ? `${String(one.objectId)}/${one.channelKey}: ` +
            `${String(one.before.lookupId)}>${String(one.after.lookupId)}, ` +
            `${String(one.before.counterBits)}>${String(one.after.counterBits)}`
          : one.action,
      );
    }

    it('marks the channels made from a fallback or for an unregistered type, and no others', async () => {
      const fallback = await sensor(2);
      const answered = await sensor(null);
      const unknown = await sensor(2);
      const fromBroken = await read([fallback, answered], [broken]);
      assert.equal(fromBroken.created, 12);
      assert.equal(fromBroken.createdUndeclared, 6, 'the fallback’s six, as P-306 counted');
      assert.deepEqual(await rows(fallback), FROM_FALLBACK);
      assert.ok((await rows(answered)).every((row) => !row.undeclared));

      // A build that does not register the type: counted and marked as a fallback is.
      const unregistered = await read([unknown], []);
      assert.equal(unregistered.created, 6);
      assert.equal(unregistered.createdUndeclared, 6);
      assert.ok(
        (await rows(unknown)).every(
          (row) => row.undeclared && row.lookup_id === null && row.counter_bits === null,
        ),
      );
    });

    it('warns once for each type this build does not register', async () => {
      const first = await sensor(2);
      const second = await sensor(2);
      const lines: string[] = [];
      const lookup = declaredChannelLookup(testCatalogue(), {
        logger: pino({ level: 'info', base: null }, { write: (line: string) => lines.push(line) }),
      });
      for (const id of [first, second, first]) {
        assert.equal(lookup('test.mended', { gen: 2 }, id).undeclared, true);
      }
      assert.equal(lookup('test.other', {}, second).undeclared, true);
      const said = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        said.map((line) => [line['sensorType'], line['sensorId'], line['fallback']]),
        [
          ['test.mended', first, 'nothing'],
          ['test.other', second, 'nothing'],
        ],
      );
    });

    it('writes what the type now declares, keeps what it cannot, and says each once', async () => {
      const id = await sensor(2);
      await read([id], [broken]);
      const before = await versionOf(id);

      const report = await repair([fixed]);
      assert.deepEqual(
        { ...report },
        {
          sensors: 1,
          repaired: 2,
          cleared: 6,
          modeKept: 2,
          stillUndeclared: 0,
          undeclaredTypes: [],
          skipped: 0,
          failedPages: 0,
          complete: true,
        },
      );
      assert.deepEqual(await rows(id), [
        // A key the declaration does not name: nothing to write it from, so the fallback's stays.
        {
          key: 'extra',
          lookup_id: 'ms.snmp.if-admin-status',
          counter_bits: null,
          undeclared: false,
        },
        { key: 'level', lookup_id: null, counter_bits: null, undeclared: false },
        // Declared a counter, created a gauge: its samples are raw values, so it stays one.
        { key: 'octets', lookup_id: null, counter_bits: null, undeclared: false },
        {
          key: 'status',
          lookup_id: 'ms.snmp.if-oper-status',
          counter_bits: null,
          undeclared: false,
        },
        // And the reverse: declared a gauge, created a counter, whose samples are rates.
        { key: 'turned', lookup_id: null, counter_bits: 32, undeclared: false },
        { key: 'wide', lookup_id: null, counter_bits: 64, undeclared: false },
      ]);
      // Each write is a `channel.redeclared` on its own sensor, by the repair's own actor, which
      // is what makes the result path forget the sensor's cached channels; and a change, so the
      // sensor's version moves as it does for an edit's re-declaration.
      assert.deepEqual(redeclared(), [
        `${String(id)}/status: null>ms.snmp.if-oper-status, null>null`,
        `${String(id)}/wide: null>null, 32>64`,
      ]);
      assert.ok((await versionOf(id)) > before, 'a real change moves the version');

      // Once: nothing is marked now, so the next start reads nothing.
      harness.audit.recorded.length = 0;
      const again = await repair([fixed]);
      assert.equal(again.sensors, 0);
      assert.deepEqual(harness.audit.recorded, []);
    });

    it('clears a mark with nothing to write without moving the version or the audit', async () => {
      // `level` and `extra` only: the later build declares what the fallback wrote, or nothing.
      const id = await sensor(2);
      await read([id], [broken], ['level', 'extra']);
      const before = await versionOf(id);
      const report = await repair([fixed]);
      assert.equal(report.cleared, 2);
      assert.equal(report.repaired, 0);
      assert.ok((await rows(id)).every((row) => !row.undeclared));
      assert.equal(await versionOf(id), before, 'an open form is not refused for the mark');
      assert.deepEqual(harness.audit.recorded, []);
    });

    it('records its writes under its own actor', async () => {
      const id = await sensor(3);
      await read([id], [broken]);
      const actors: Actor[] = [];
      const sink: AuditSink = {
        record: (_q, actor) => {
          actors.push(actor);
          return Promise.resolve();
        },
      };
      await repair([fixed], { audit: sink });
      assert.deepEqual(actors, [UNDECLARED_CHANNEL_REPAIR]);
    });

    it('leaves a sensor marked while its type still cannot answer, and repairs an unregistered one once a build registers it', async () => {
      const stuck = await sensor(4);
      const unknown = await sensor(4);
      await read([stuck], [broken]);
      await read([unknown], []);

      const still = await repair([broken]);
      assert.equal(still.sensors, 2);
      assert.equal(still.stillUndeclared, 2);
      assert.deepEqual(still.undeclaredTypes, ['test.mended']);
      assert.equal(still.cleared, 0);
      assert.ok((await rows(stuck)).every((row) => row.undeclared));
      assert.deepEqual(harness.audit.recorded, []);

      // Unregistered by the build that read it; registered by this one.
      const mended = await repair([fixed]);
      assert.equal(mended.stillUndeclared, 0);
      assert.equal(mended.cleared, 12);
      const status = (await rows(unknown)).find((row) => row.key === 'status');
      assert.equal(status?.lookup_id, 'ms.snmp.if-oper-status');
    });

    it('goes on past a page whose types cannot answer', async () => {
      // Created first, so its page comes first, one sensor a page.
      const stuck = await sensor(STILL_BROKEN);
      const mendable = await sensor(7);
      assert.ok(stuck < mendable);
      await read([stuck, mendable], [broken]);
      const report = await repair([fixed], { batchSize: 1 });
      assert.equal(report.sensors, 2);
      assert.equal(report.stillUndeclared, 1);
      assert.equal(report.cleared, 6, 'the second page was read');
      assert.ok((await rows(stuck)).every((row) => row.undeclared));
      assert.ok((await rows(mendable)).every((row) => !row.undeclared));
    });

    it('decides again under the lock, from the parameters committed then', async () => {
      const id = await sensor(8);
      await read([id], [broken]);
      // An edit lands between the unlocked read and the lock: parameters the type cannot answer.
      const racing: UndeclaredChannelRepairOptions['db'] = {
        query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
          db.query<T>(text, values),
        tx: async <T>(fn: (q: Queryable) => Promise<T>) => {
          await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
            id,
            JSON.stringify({ gen: STILL_BROKEN }),
          ]);
          return db.tx(fn);
        },
      };
      const report = await repair([fixed], { db: racing });
      assert.equal(report.cleared, 0);
      assert.deepEqual(await rows(id), FROM_FALLBACK);
    });

    it('counts a page that failed and goes on, and stops at shutdown', async () => {
      const id = await sensor(9);
      await read([id], [broken]);
      const failing: UndeclaredChannelRepairOptions['db'] = {
        query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
          db.query<T>(text, values),
        tx: () => Promise.reject(new Error('the page’s transaction failed')),
      };
      const failed = await repair([fixed], { db: failing });
      assert.equal(failed.failedPages, 1);
      assert.equal(failed.complete, true, 'the pages after it would have gone on');
      assert.deepEqual(await rows(id), FROM_FALLBACK);

      const stopped = await repair([fixed], { signal: AbortSignal.abort() });
      assert.equal(stopped.sensors, 0);
      assert.equal(stopped.complete, false);
      assert.deepEqual(await rows(id), FROM_FALLBACK);
    });

    it('never undoes a lookup an operator chose, even the one the channel already had', async () => {
      const changed = await sensor(5);
      const kept = await sensor(5);
      await read([changed, kept], [broken]);
      await harness.service.patchChannel(testActor, changed, 'status', {
        lookupId: 'ms.snmp.if-admin-status',
      });
      // Its lookup is null, from the fallback, and the operator says null: a decision, which
      // moves nothing a reader sees.
      const before = await versionOf(kept);
      await harness.service.patchChannel(testActor, kept, 'status', { lookupId: null });
      assert.equal(await versionOf(kept), before);
      for (const id of [changed, kept]) {
        const status = (await rows(id)).find((row) => row.key === 'status');
        assert.equal(status?.undeclared, false);
      }

      harness.audit.recorded.length = 0;
      const report = await repair([fixed]);
      assert.equal(report.cleared, 10, 'the other five of each');
      assert.equal(
        (await rows(changed)).find((row) => row.key === 'status')?.lookup_id,
        'ms.snmp.if-admin-status',
      );
      assert.equal((await rows(kept)).find((row) => row.key === 'status')?.lookup_id, null);
      assert.ok(redeclared().every((line) => !line.includes('/status:')));
    });

    it('marks a clone’s copy of a marked channel, and repairs it with its source', async () => {
      const source = await sensor(10);
      await read([source], [broken]);
      const clone = await harness.service.clone(testActor, source, {}, Visibility.EVERYTHING);
      assert.deepEqual(await rows(clone.object.id), FROM_FALLBACK);
      const report = await repair([fixed]);
      assert.equal(report.sensors, 2);
      assert.equal(report.cleared, 12);
      assert.equal(
        (await rows(clone.object.id)).find((row) => row.key === 'status')?.lookup_id,
        'ms.snmp.if-oper-status',
      );
    });

    it('leaves a sensor somebody else holds for the next start', async () => {
      const id = await sensor(6);
      await read([id], [broken]);
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = (): void => undefined;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = db.tx(async (q) => {
        await q.query('SELECT id FROM object WHERE id = $1 FOR UPDATE', [id]);
        held();
        await released;
      });
      try {
        await holding;
        const report = await repair([fixed]);
        assert.equal(report.skipped, 1);
        assert.equal(report.cleared, 0);
        assert.deepEqual(await rows(id), FROM_FALLBACK);
      } finally {
        release();
        await holder;
      }
      const later = await repair([fixed]);
      assert.equal(later.cleared, 6);
    });
  },
);

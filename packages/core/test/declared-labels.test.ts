import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { SensorType } from '@ms/sensors';
import type { ChannelReading, CheckResult } from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import type { Actor, AuditSink } from '../src/objects/audit.js';
import { declaredChannelLookup } from '../src/state/declared-limits.js';
import {
  DECLARED_LABEL_PASS,
  DECLARED_LABEL_REPAIR,
  repairDeclaredLabels,
  type DeclaredLabelRepairOptions,
} from '../src/state/declared-labels.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** Parameters the type cannot answer for: stored behind its back, as an earlier build could. */
const BROKEN = 99;

/**
 * Each thing a declaration can say about a channel's name and unit (`P-402`): a name and a unit
 * of its own (`temp`), a name and no unit (`mode`), a name that is only its key (`bare`), the same
 * with a unit (`rate`), and a primary whose name a parameter chooses and which is otherwise its
 * key, as `exe.script.advanced`'s is — "Empty uses whatever the program calls it" (`value`).
 * `blankMode` and `tempUnit` declare what nothing checks against the column: an empty name, and a
 * unit of any length (`P-405`).
 */
const labelled: SensorType = {
  id: 'test.labelled',
  category: 'Custom',
  costHint: 'light',
  channelsFromWhatItReads: 'a test type, left unflagged so that nothing of it is called retired',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      gen: { type: 'integer' },
      primaryName: { type: 'string' },
      blankMode: { type: 'boolean' },
      tempUnit: { type: 'string' },
    },
  },
  channels: (params) => {
    if (params['gen'] === BROKEN) throw new TypeError('generation not understood');
    const named = typeof params['primaryName'] === 'string' ? params['primaryName'] : '';
    return [
      { key: 'value', name: named === '' ? 'value' : named, isPrimary: true },
      {
        key: 'temp',
        name: 'Temperature',
        unit: typeof params['tempUnit'] === 'string' ? params['tempUnit'] : '°C',
      },
      // Nothing stops a type declaring an empty name: the catalogue does not check names.
      { key: 'mode', name: params['blankMode'] === true ? '' : 'Mode' },
      { key: 'bare', name: 'bare' },
      { key: 'rate', name: 'rate', unit: '/s' },
    ];
  },
  execute: () => Promise.resolve({ channels: [] }),
};

const KEYS = ['bare', 'mode', 'rate', 'temp', 'value'] as const;

interface Params {
  gen?: number;
  primaryName?: string;
  blankMode?: boolean;
  tempUnit?: string;
}

interface Label {
  key: string;
  name: string;
  unit: string;
}

/** What `labelled` declares for `{}`, by key, as a create writes it. */
const DECLARED: readonly Label[] = [
  { key: 'bare', name: 'bare', unit: '' },
  { key: 'mode', name: 'Mode', unit: '' },
  { key: 'rate', name: 'rate', unit: '/s' },
  { key: 'temp', name: 'Temperature', unit: '°C' },
  { key: 'value', name: 'value', unit: '' },
];

/** The same rows as ingestion named them before `P-402`, from readings that sent no words. */
const BY_KEY: readonly Label[] = KEYS.map((key) => ({ key, name: key, unit: '' }));

describe(
  'a channel named as its type declares it (P-402)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let deviceId: number;
    let made = 0;

    before(async () => {
      scratch = await createScratchDatabase('declared_labels');
      db = scratch.db;
      harness = await buildHarness(db, { types: [labelled] });
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
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      // The repair reads every sensor in the installation: each test's are its own.
      await db.query("DELETE FROM object WHERE kind = 'sensor'");
      await db.query('DELETE FROM startup_pass');
      harness.audit.recorded.length = 0;
    });

    /**
     * A sensor of `labelled` with no channels yet, as before its first reading. A `gen` of
     * `BROKEN` is stored behind the type's back, as an earlier build could have left it.
     */
    async function sensor(params: Params = {}): Promise<number> {
      made += 1;
      const created = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `labelled-${String(made)}`,
        sensorType: 'test.labelled',
        params: params.gen === BROKEN ? { gen: 1 } : { ...params },
      });
      if (params.gen === BROKEN) {
        await db.query('UPDATE sensor_config SET params = $2::jsonb WHERE object_id = $1', [
          created.id,
          JSON.stringify({ gen: BROKEN }),
        ]);
      }
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [created.id]);
      harness.audit.recorded.length = 0;
      return created.id;
    }

    /** A sensor whose channels an earlier build's ingestion created and named by their keys. */
    async function namedByKey(params: Params = {}) {
      const id = await sensor(params);
      await db.query(
        `INSERT INTO channel (sensor_id, key, name, unit, is_primary)
         SELECT $1, k, k, '', k = 'value' FROM unnest($2::text[]) AS k`,
        [id, KEYS],
      );
      return id;
    }

    /** One batch of results through a resolver over the given build of the catalogue. */
    async function read(
      sensorId: number,
      batches: readonly (readonly ChannelReading[])[],
      types: readonly SensorType[] = [labelled],
    ): Promise<{ created: number; createdUndeclared: number }> {
      const resolver = new ChannelResolver({
        logger: silent,
        declaredShape: declaredChannelLookup(testCatalogue(types)),
      });
      const results: CheckResult[] = batches.map((channels) => ({
        sensorId,
        at: new Date().toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [...channels],
      }));
      return db.tx((q) => resolver.resolve(q, results));
    }

    async function labels(sensorId: number): Promise<Label[]> {
      return db.query<Label>(
        'SELECT key, name, unit FROM channel WHERE sensor_id = $1 ORDER BY key',
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

    /** Who recorded each batch of entries the repair wrote. */
    const actors: Actor[] = [];
    const audit: AuditSink = {
      record: async (q, actor, mutations, at) => {
        actors.push(actor);
        await harness.audit.record(q, actor, mutations, at);
      },
    };

    function repair(
      options: Partial<DeclaredLabelRepairOptions> = {},
    ): ReturnType<typeof repairDeclaredLabels> {
      return repairDeclaredLabels({
        db,
        logger: silent,
        catalogue: testCatalogue([labelled]),
        audit,
        ...options,
      });
    }

    /** The audit's `channel.redeclared` entries, as `sensor/key: name>name unit>unit`. */
    function redeclared(): string[] {
      return harness.audit.recorded.map((one) =>
        one.action === 'channel.redeclared'
          ? `${String(one.objectId)}/${one.channelKey}: ` +
            `${one.before.name}>${one.after.name} ${one.before.unit}>${one.after.unit}`
          : one.action,
      );
    }

    describe('created by a reading', () => {
      it('takes its declared name and unit when the reading sends none', async () => {
        const id = await sensor();
        const outcome = await read(id, [KEYS.map((key) => ({ key, value: 1 }))]);
        assert.equal(outcome.created, 5);
        assert.equal(outcome.createdUndeclared, 0);
        // What a create writes: the same answer from the same place (`S-18`, `P-80`).
        assert.deepEqual(await labels(id), DECLARED);
      });

      it('keeps what a reading sends where its declaration says nothing of its own, and only there', async () => {
        // The primary's name is only its key, and it declares no unit: the program's words are
        // kept, as `primaryName`'s "Empty uses whatever the program calls it" says. Where the
        // declaration names a channel, or gives it a unit, that is what it is created with.
        const id = await sensor();
        await read(id, [
          [
            { key: 'value', value: 1, name: 'Free Space', unit: '%' },
            { key: 'temp', value: 1, name: 'Celsius', unit: 'K' },
            { key: 'bare', value: 1, name: 'Bare one' },
            { key: 'rate', value: 1, name: 'Rate', unit: '/min' },
            { key: 'mode', value: 1, unit: 'x' },
          ],
        ]);
        assert.deepEqual(await labels(id), [
          { key: 'bare', name: 'Bare one', unit: '' },
          { key: 'mode', name: 'Mode', unit: 'x' },
          { key: 'rate', name: 'Rate', unit: '/s' },
          { key: 'temp', name: 'Temperature', unit: '°C' },
          { key: 'value', name: 'Free Space', unit: '%' },
        ]);

        // An operator's `primaryName` is the declaration's own, and it wins over the program's.
        const chosen = await sensor({ primaryName: 'Disk free' });
        await read(chosen, [[{ key: 'value', value: 1, name: 'Free Space', unit: '%' }]]);
        assert.deepEqual(await labels(chosen), [{ key: 'value', name: 'Disk free', unit: '%' }]);
      });

      it('names a key the type does not declare as the reading does, and by its key without', async () => {
        const id = await sensor();
        await read(id, [
          [
            { key: 'extra', value: 1 },
            { key: 'second', value: 1, name: 'Second', unit: 'ms' },
          ],
        ]);
        assert.deepEqual(await labels(id), [
          { key: 'extra', name: 'extra', unit: '' },
          { key: 'second', name: 'Second', unit: 'ms' },
        ]);
      });

      it('names nothing from a fallback, whose `{}` answer names it otherwise', async () => {
        // The type throws for the stored parameters, so its shape is its answer to `{}`, which
        // calls `temp` "Temperature": a placeholder's word, not the sensor's (`ChannelShape`).
        const broken = await sensor({ gen: BROKEN });
        const fromFallback = await read(broken, [[{ key: 'temp', value: 1 }]]);
        assert.equal(fromFallback.createdUndeclared, 1, 'a fallback, counted as `P-306` counts it');
        assert.deepEqual(await labels(broken), [{ key: 'temp', name: 'temp', unit: '' }]);
        // And a type this build does not register declares nothing at all (`P-312`).
        const unknown = await sensor();
        const unregistered = await read(unknown, [[{ key: 'temp', value: 1 }]], []);
        assert.equal(unregistered.createdUndeclared, 1);
        assert.deepEqual(await labels(unknown), [{ key: 'temp', name: 'temp', unit: '' }]);
      });

      it('fits a declared name to what a channel row holds, as a reading’s is fitted', async () => {
        // Nothing checks a declaration against the column's 1 to 200 characters. Unfitted, a
        // long one broke the INSERT, and the probe offered that batch again every second.
        const long = 'p'.repeat(210);
        const id = await sensor({ primaryName: long, blankMode: true });
        const outcome = await read(id, [
          [
            { key: 'value', value: 1 },
            { key: 'mode', value: 1 },
          ],
        ]);
        assert.equal(outcome.created, 2, 'the batch is taken');
        assert.deepEqual(await labels(id), [
          // An empty declared name says nothing of its own: the key stands in.
          { key: 'mode', name: 'mode', unit: '' },
          { key: 'value', name: `${'p'.repeat(199)}…`, unit: '' },
        ]);

        // And the repair writes the same, so its page does not fail on every start.
        const old = await namedByKey({ primaryName: long, blankMode: true });
        const report = await repair();
        assert.equal(report.failedPages, 0);
        const value = (await labels(old)).find((one) => one.key === 'value');
        assert.equal(value?.name, `${'p'.repeat(199)}…`);
        const mode = (await labels(old)).find((one) => one.key === 'mode');
        assert.deepEqual(mode, { key: 'mode', name: 'mode', unit: '' });
      });

      it('names each channel at a create as ingestion names it from a reading that sent nothing (P-405)', async () => {
        // One rule for both (`declaredLabel`): a long name or unit clipped, an empty name the
        // key. Before, a create wrote the declaration as it was and the column refused it.
        const params = { primaryName: 'p'.repeat(210), blankMode: true, tempUnit: 'u'.repeat(60) };
        const created = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'created',
          sensorType: 'test.labelled',
          params,
        });
        const fromReadings = await sensor(params);
        const outcome = await read(fromReadings, [KEYS.map((key) => ({ key, value: 1 }))]);
        assert.equal(outcome.created, KEYS.length);
        const expected: Label[] = [
          { key: 'bare', name: 'bare', unit: '' },
          { key: 'mode', name: 'mode', unit: '' },
          { key: 'rate', name: 'rate', unit: '/s' },
          { key: 'temp', name: 'Temperature', unit: `${'u'.repeat(49)}…` },
          { key: 'value', name: `${'p'.repeat(199)}…`, unit: '' },
        ];
        assert.deepEqual(await labels(created.id), expected);
        assert.deepEqual(await labels(fromReadings), expected);
      });

      it('keeps the words an earlier reading of the batch sent', async () => {
        // A probe may send them only on a channel's first appearance: a second result of the
        // same batch that sends none does not take them away.
        const id = await sensor();
        await read(id, [
          [{ key: 'value', value: 1, name: 'Free Space', unit: '%' }],
          [{ key: 'value', value: 2 }],
        ]);
        assert.deepEqual(await labels(id), [{ key: 'value', name: 'Free Space', unit: '%' }]);
      });

      it('names a channel a later build added to Core Health as Core Health declares it', async () => {
        // The case `P-402` was found by: a health sensor older than the build that added
        // `probesSilent`, whose readings carry a key and a value and nothing else.
        const [object] = await db.query<{ id: string }>(
          `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'sensor', 'Core Health')
           RETURNING id`,
          [deviceId],
        );
        const id = Number(object?.id);
        await db.query(
          "INSERT INTO sensor_config (object_id, type, params) VALUES ($1, 'ms.core.health', '{}')",
          [id],
        );
        await read(
          id,
          [
            [
              { key: 'probesSilent', value: 0 },
              { key: 'sensorsOwedRedecision', value: 0 },
            ],
          ],
          [],
        );
        assert.deepEqual(await labels(id), [
          { key: 'probesSilent', name: 'Probes not delivering', unit: 'probes' },
          { key: 'sensorsOwedRedecision', name: 'Sensors owed a re-decision', unit: 'sensors' },
        ]);
      });
    });

    describe('named by its key by an earlier build, and repaired at start-up', () => {
      it('writes the declared name and unit, page by page, audited by the system, moving the version', async () => {
        const first = await namedByKey();
        const second = await namedByKey();
        const before = await versionOf(first);
        actors.length = 0;

        const report = await repair({ batchSize: 1 });

        assert.deepEqual(
          {
            ran: report.ran,
            sensors: report.sensors,
            relabelled: report.relabelled,
            skipped: report.skipped,
            failedPages: report.failedPages,
            undeclared: report.undeclared,
            complete: report.complete,
          },
          {
            ran: true,
            sensors: 2,
            relabelled: 6,
            skipped: 0,
            failedPages: 0,
            undeclared: 0,
            complete: true,
          },
        );
        // What a create of the same parameters writes; `bare` and `value` say nothing of their
        // own, and are left.
        assert.deepEqual(await labels(first), DECLARED);
        assert.deepEqual(await labels(second), DECLARED);
        assert.deepEqual(redeclared(), [
          `${String(first)}/mode: mode>Mode >`,
          `${String(first)}/rate: rate>rate >/s`,
          `${String(first)}/temp: temp>Temperature >°C`,
          `${String(second)}/mode: mode>Mode >`,
          `${String(second)}/rate: rate>rate >/s`,
          `${String(second)}/temp: temp>Temperature >°C`,
        ]);
        assert.deepEqual(actors, [DECLARED_LABEL_REPAIR, DECLARED_LABEL_REPAIR]);
        assert.ok((await versionOf(first)) > before, 'a reader sees it, so the version moves');

        // Nothing left: a second run of the same rows writes nothing.
        harness.audit.recorded.length = 0;
        const again = await repair();
        assert.equal(again.relabelled, 0);
        assert.deepEqual(redeclared(), []);
      });

      it('leaves a name a reading sent, and a channel with a unit, beside one it renames', async () => {
        // `rate` puts the sensor in a page; the others are read with it, and only it is renamed.
        const id = await sensor();
        await db.query(
          `INSERT INTO channel (sensor_id, key, name, unit) VALUES
             ($1, 'temp', 'Celsius', ''), ($1, 'mode', 'mode', 'x'),
             ($1, 'value', 'Free Space', ''), ($1, 'rate', 'rate', '')`,
          [id],
        );
        // And a sensor with nothing of the kind is not read at all.
        const unitOnly = await sensor();
        await db.query(
          `INSERT INTO channel (sensor_id, key, name, unit)
           VALUES ($1, 'mode', 'mode', 'x'), ($1, 'temp', 'Celsius', '')`,
          [unitOnly],
        );
        const report = await repair();
        assert.deepEqual(
          { sensors: report.sensors, relabelled: report.relabelled },
          {
            sensors: 1,
            relabelled: 1,
          },
        );
        assert.deepEqual(await labels(id), [
          { key: 'mode', name: 'mode', unit: 'x' },
          { key: 'rate', name: 'rate', unit: '/s' },
          { key: 'temp', name: 'Celsius', unit: '' },
          { key: 'value', name: 'Free Space', unit: '' },
        ]);
        assert.deepEqual(await labels(unitOnly), [
          { key: 'mode', name: 'mode', unit: 'x' },
          { key: 'temp', name: 'Celsius', unit: '' },
        ]);
      });

      it('leaves a key its sensor’s answer does not name', async () => {
        const id = await sensor();
        await db.query(
          "INSERT INTO channel (sensor_id, key, name, unit) VALUES ($1, 'extra', 'extra', '')",
          [id],
        );
        const report = await repair();
        assert.deepEqual(
          { sensors: report.sensors, relabelled: report.relabelled },
          {
            sensors: 1,
            relabelled: 0,
          },
        );
        assert.deepEqual(await labels(id), [{ key: 'extra', name: 'extra', unit: '' }]);
      });

      it('leaves a sensor whose type cannot answer, or is not registered, and names the type', async () => {
        const broken = await namedByKey({ gen: BROKEN });
        const report = await repair();
        assert.deepEqual(
          {
            relabelled: report.relabelled,
            undeclared: report.undeclared,
            types: report.undeclaredTypes,
          },
          { relabelled: 0, undeclared: 1, types: ['test.labelled'] },
        );
        assert.deepEqual(await labels(broken), BY_KEY, 'not from the `{}` answer’s placeholder');

        const answering = await namedByKey();
        const unregistered = await repair({ catalogue: testCatalogue([]) });
        assert.deepEqual(
          { relabelled: unregistered.relabelled, undeclared: unregistered.undeclared },
          { relabelled: 0, undeclared: 2 },
        );
        assert.deepEqual(await labels(answering), BY_KEY);
        // Neither can answer under this build, and neither will: the run is finished.
        assert.equal(unregistered.complete, true);
      });

      it('skips a sensor another transaction holds, records nothing, and names it next time (P-333)', async () => {
        const id = await namedByKey();
        let locked = (): void => undefined;
        let release = (): void => undefined;
        const holding = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holder = db.tx(async (q) => {
          await q.query('SELECT id FROM object WHERE id = $1 FOR NO KEY UPDATE', [id]);
          locked();
          await released;
        });
        try {
          await within(10_000, 'the transaction holding the sensor', holding);
          // Under the pool's lock_timeout, so a repair that waited would fail here, not pass late.
          const report = await within(
            4_000,
            'the repair, beside a held sensor',
            repair({ rules: 'held-build' }),
          );
          assert.deepEqual(
            { relabelled: report.relabelled, skipped: report.skipped },
            { relabelled: 0, skipped: 1 },
          );
        } finally {
          release();
          await holder;
        }
        assert.deepEqual(await labels(id), BY_KEY, 'left as it was');

        const next = await repair({ rules: 'held-build' });
        assert.equal(next.ran, true, 'a run that skipped one recorded nothing');
        assert.equal(next.relabelled, 3);
        assert.deepEqual(await labels(id), DECLARED);
        assert.equal((await repair({ rules: 'held-build' })).ran, false, 'and this one did');
      });

      it('reads the candidates once per exact build, and every time with none (P-333)', async () => {
        const markerOf = async (): Promise<string | undefined> =>
          (
            await db.query<{ rules: string }>('SELECT rules FROM startup_pass WHERE name = $1', [
              DECLARED_LABEL_PASS,
            ])
          )[0]?.rules;

        const stopped = new AbortController();
        stopped.abort();
        const cut = await repair({ rules: 'build-a', signal: stopped.signal });
        assert.deepEqual(
          { complete: cut.complete, relabelled: cut.relabelled },
          {
            complete: false,
            relabelled: 0,
          },
        );
        assert.equal(await markerOf(), undefined, 'a run shutdown stopped records nothing');

        await namedByKey();
        const first = await repair({ rules: 'build-a' });
        assert.equal(first.relabelled, 3);
        assert.equal(await markerOf(), 'build-a');

        const later = await namedByKey();
        const same = await repair({ rules: 'build-a' });
        assert.equal(same.ran, false, 'the same build, already finished: nothing is read');
        assert.deepEqual(await labels(later), BY_KEY);

        const next = await repair({ rules: 'build-b' });
        assert.deepEqual(
          { ran: next.ran, relabelled: next.relabelled },
          { ran: true, relabelled: 3 },
        );
        assert.deepEqual(await labels(later), DECLARED);
        assert.equal(await markerOf(), 'build-b');

        // A build that cannot say what it is runs at every start, and records nothing.
        const anyway = await repair({ rules: null });
        assert.equal(anyway.ran, true);
        assert.equal(await markerOf(), 'build-b');
      });
    });
  },
);

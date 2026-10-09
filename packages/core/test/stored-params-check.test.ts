import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { QueryResultRow } from 'pg';
import { pino, type Logger } from 'pino';
import { BUILT_IN_SENSOR_TYPES, standardCatalogue, type SensorType } from '@ms/sensors';
import { Visibility } from '../src/auth/access.js';
import type { Database, Queryable } from '../src/db/pool.js';
import type { Actor, Mutation } from '../src/objects/audit.js';
import {
  catalogueSensorTypeGate,
  type SensorTypeGate,
  type StoredParamProblem,
} from '../src/objects/sensor-type-gate.js';
import {
  StoredParamsCheck,
  WARNINGS_PER_TYPE,
  type StoredParamsReport,
} from '../src/objects/stored-params-check.js';
import type { ObjectKind } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** A logger whose lines a test can read back, parsed. */
function capturing(): { logger: Logger; lines: string[]; parsed: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return {
    logger,
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** The warning naming one sensor, of which there must be exactly one. */
function warningFor(
  parsed: readonly Record<string, unknown>[],
  sensorId: number,
): Record<string, unknown> {
  const found = parsed.filter((line) => line['sensorId'] === sensorId && line['level'] === 40);
  assert.equal(found.length, 1, `one warning for sensor ${String(sensorId)}`);
  const [line] = found;
  assert.ok(line !== undefined);
  return line;
}

/**
 * The start-up pass naming sensors whose stored parameters their type's current schema refuses
 * (`P-358`): one warning per sensor with its paths and keywords and never a value, the count for
 * Core Health, a type this build does not register skipped, and nothing written.
 */
describe('the stored-parameters check at start-up (P-358)', () => {
  describe('paging, and one sensor’s failure (no database)', () => {
    interface Row {
      id: number;
      type: string;
      params: Record<string, unknown>;
    }

    /**
     * The keyset read over an array, recording the `after` each page asked from. `during` runs
     * while a page is in flight, before it is answered from `rows` — what the pass's snapshot
     * holds, whatever a write committed meanwhile.
     */
    const fakeDb = (
      rows: readonly Row[],
      asked: string[],
      failAfter?: string,
      during?: (from: string) => Promise<void>,
    ): Queryable => ({
      query: async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        assert.match(text, /FROM sensor_config/);
        assert.match(text, /ORDER BY object_id LIMIT/);
        const [from, limit] = values as [string, number];
        asked.push(from);
        await during?.(from);
        if (from === failAfter) throw new Error('connection reset');
        const page = rows
          .filter((row) => row.id > Number(from))
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((row) => ({ id: String(row.id), type: row.type, params: row.params }));
        return page as unknown as T[];
      },
    });

    /** Invalid when `bad`, unregistered for `gone`, throws for `boom`; records each sensor seen. */
    const fakeGate = (seen: string[]): Pick<SensorTypeGate, 'storedParamProblems'> => ({
      storedParamProblems: (type, params): readonly StoredParamProblem[] | null => {
        seen.push(String(params['n']));
        if (type === 'gone') return null;
        if (type === 'boom') throw new TypeError(`cannot read ${String(params['secret'])}`);
        return type.startsWith('bad')
          ? [{ path: '/n', keyword: 'maximum', message: 'must be <= 3' }]
          : [];
      },
    });

    const sensors = (types: readonly string[]): Row[] =>
      types.map((type, at) => ({ id: at + 1, type, params: { n: at + 1, secret: 'S3cr3t-x' } }));

    /** One sensor as a write left it. */
    const written = (id: number, type: string): Row => ({
      id,
      type,
      params: { n: id, secret: 'S3cr3t-x' },
    });

    /**
     * One write's transaction, as the sink is handed it: its reads answered from `rows` (by id,
     * or all of them for a clone's subtree), its `afterCommit` hooks held until `commit`.
     */
    const fakeTx = (
      rows: readonly Row[],
    ): { q: Queryable; reads: string[]; commit: () => void } => {
      const hooks: (() => void)[] = [];
      const reads: string[] = [];
      return {
        q: {
          query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            reads.push(text);
            const [ids] = values as [readonly number[]];
            const wanted = new Set(ids.map(Number));
            const found = text.includes('RECURSIVE')
              ? rows
              : rows.filter((one) => wanted.has(one.id));
            return Promise.resolve(
              found.map((one) => ({
                id: String(one.id),
                type: one.type,
                params: one.params,
              })) as unknown as T[],
            );
          },
          afterCommit: (fn: () => void) => {
            hooks.push(fn);
          },
        },
        reads,
        commit: () => {
          for (const hook of hooks) hook();
        },
      };
    };

    const system: Actor = { kind: 'system', component: 'test' };

    // Only the fields the sink reads: a test of what it does with them, not of the entries.
    const edited = (id: number, changedParams: readonly string[] = ['n']): Mutation =>
      ({
        action: 'object.updated',
        objectId: id,
        kind: 'sensor',
        changedParams,
      }) as unknown as Mutation;
    const deleted = (destroyed: readonly [number, ObjectKind][]): Mutation =>
      ({
        action: 'object.deleted',
        objectId: destroyed[0]?.[0],
        kind: destroyed[0]?.[1],
        destroyed: destroyed.map(([id, kind]) => ({ id, kind, name: `#${String(id)}` })),
      }) as unknown as Mutation;
    const cloned = (rootId: number): Mutation =>
      ({ action: 'object.cloned', objectId: rootId, kind: 'device' }) as unknown as Mutation;

    /** A write recorded through the sink, and committed unless told otherwise. */
    const write = async (
      check: StoredParamsCheck,
      mutation: Mutation,
      rows: readonly Row[],
      commit = true,
    ): Promise<{ reads: string[] }> => {
      const tx = fakeTx(rows);
      await check.record(tx.q, system, [mutation], new Date());
      if (commit) tx.commit();
      return tx;
    };

    it('reads every sensor once, in pages, past the page boundary', async () => {
      for (const [count, pages] of [
        [5, ['0', '2', '4']],
        // An exact multiple: the empty page after the last full one ends it.
        [4, ['0', '2', '4']],
        [1, ['0']],
        [0, ['0']],
      ] as const) {
        const asked: string[] = [];
        const seen: string[] = [];
        const rows = sensors(Array.from({ length: count }, (_, at) => (at === 2 ? 'bad' : 'ok')));
        const check = new StoredParamsCheck({
          db: fakeDb(rows, asked),
          logger: silent,
          sensorTypes: fakeGate(seen),
          batchSize: 2,
        });
        const report = await check.run();
        assert.deepEqual(asked, pages, `${String(count)} sensors: the pages asked for`);
        assert.deepEqual(
          seen,
          rows.map((row) => String(row.params['n'])),
          `${String(count)} sensors: each checked once, in order`,
        );
        assert.equal(report.sensors, count);
        assert.equal(report.invalid, count >= 3 ? 1 : 0);
        assert.equal(report.complete, true);
        assert.equal(check.invalid, report.invalid, 'published for Core Health');
      }
    });

    it('goes on past a sensor whose check throws, saying which and not what it threw', async () => {
      const { logger, lines, parsed } = capturing();
      const seen: string[] = [];
      const check = new StoredParamsCheck({
        db: fakeDb(sensors(['ok', 'boom', 'bad', 'gone', 'bad']), []),
        logger,
        sensorTypes: fakeGate(seen),
        batchSize: 2,
      });
      const report = await check.run();
      assert.deepEqual(seen, ['1', '2', '3', '4', '5'], 'the rest of its page and the next go on');
      assert.equal(report.failedSensors, 1);
      assert.equal(report.invalid, 2);
      assert.deepEqual(report.invalidTypes, ['bad']);
      assert.equal(report.unregistered, 1);
      assert.deepEqual(report.unregisteredTypes, ['gone']);
      assert.equal(check.invalid, 2);
      const failed = warningFor(parsed(), 2);
      assert.equal(failed['sensorType'], 'boom');
      assert.equal(failed['errorKind'], 'TypeError');
      for (const line of lines) assert.equal(line.includes('S3cr3t-x'), false, line);
    });

    it('stops between pages at shutdown, and publishes no count from a pass that did not finish', async () => {
      const controller = new AbortController();
      controller.abort();
      const asked: string[] = [];
      const check = new StoredParamsCheck({
        db: fakeDb(sensors(['bad']), asked),
        logger: silent,
        sensorTypes: fakeGate([]),
        signal: controller.signal,
      });
      const report = await check.run();
      assert.deepEqual(asked, [], 'nothing read');
      assert.equal(report.complete, false);
      assert.equal(check.invalid, null, 'a gap, not a lower bound');
    });

    it('stops at a page it cannot read, says so, and does not reject', async () => {
      const { logger, parsed } = capturing();
      const check = new StoredParamsCheck({
        db: fakeDb(sensors(['bad', 'ok', 'bad']), [], '2'),
        logger,
        sensorTypes: fakeGate([]),
        batchSize: 2,
      });
      const report = await check.run();
      assert.equal(report.complete, false);
      assert.equal(report.sensors, 2);
      assert.equal(check.invalid, null);
      const stopped = parsed().filter((line) => line['phase'] === 'read-page');
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0]?.['afterSensorId'], '2');
    });

    it(`names at most ${String(WARNINGS_PER_TYPE)} sensors of a type and counts the rest by type (P-368)`, async () => {
      const { logger, lines, parsed } = capturing();
      // One past the cap of one type, two of another, and a valid one between.
      const types = [
        ...Array.from({ length: WARNINGS_PER_TYPE + 1 }, () => 'bad'),
        'ok',
        'bad.other',
        'bad.other',
      ];
      const check = new StoredParamsCheck({
        db: fakeDb(sensors(types), []),
        logger,
        sensorTypes: fakeGate([]),
        batchSize: 4,
      });
      const report = await check.run();
      const all = parsed();
      const warned = (type: string): unknown[] =>
        all
          .filter((line) => line['level'] === 40 && line['sensorType'] === type)
          .map((line) => line['sensorId']);
      assert.deepEqual(
        warned('bad'),
        Array.from({ length: WARNINGS_PER_TYPE }, (_, at) => at + 1),
        'the first of the type, in the pass’s order, and no more',
      );
      assert.deepEqual(warned('bad.other'), [WARNINGS_PER_TYPE + 3, WARNINGS_PER_TYPE + 4]);

      assert.equal(report.invalid, WARNINGS_PER_TYPE + 3, 'every one counted, named or not');
      assert.equal(check.invalid, WARNINGS_PER_TYPE + 3, 'and on Core Health');
      assert.deepEqual(report.invalidByType, { bad: WARNINGS_PER_TYPE + 1, 'bad.other': 2 });
      assert.deepEqual(report.notNamedByType, { bad: 1 });
      const summaries = all.filter((line) => line['level'] === 30);
      assert.equal(summaries.length, 1, 'one line for the pass');
      const [summary] = summaries;
      assert.ok(summary !== undefined);
      assert.deepEqual(summary['notNamedByType'], { bad: 1 });
      assert.deepEqual(summary['invalidByType'], {
        bad: WARNINGS_PER_TYPE + 1,
        'bad.other': 2,
      });
      assert.match(String(summary['msg']), /notNamedByType counts the rest/);
      for (const line of lines) assert.equal(line.includes('S3cr3t-x'), false, line);
    });

    it('keeps the count current after the pass: a mend, a delete, a clone; not a rename or a rollback (P-367)', async () => {
      const check = new StoredParamsCheck({
        db: fakeDb(sensors(['bad', 'bad', 'bad', 'ok']), []),
        logger: silent,
        sensorTypes: fakeGate([]),
        batchSize: 2,
      });
      // Before the pass a write moves the set, and the count is still a gap.
      await write(check, edited(4), [written(4, 'ok')]);
      assert.equal(check.invalid, null);
      await check.run();
      assert.equal(check.invalid, 3);

      await write(check, edited(1), [written(1, 'ok')]);
      assert.equal(check.invalid, 2, 'an edit that mends it takes it off');

      await write(check, edited(2), [written(2, 'ok')], false);
      assert.equal(check.invalid, 2, 'a write that did not commit moves nothing');

      const rename = await write(check, edited(2, []), [written(2, 'ok')]);
      assert.deepEqual(rename.reads, [], 'a write that changed no parameter reads nothing');
      assert.equal(check.invalid, 2);

      await write(check, edited(2), [written(2, 'bad')]);
      assert.equal(check.invalid, 2, 'one still failing is counted once');

      await write(check, edited(2), [written(2, 'boom')]);
      assert.equal(check.invalid, 2, 'one whose check throws is left as it was');

      await write(
        check,
        deleted([
          [90, 'device'],
          [2, 'sensor'],
          [3, 'sensor'],
        ]),
        [],
      );
      assert.equal(check.invalid, 0, 'a delete takes its sensors off');

      // A clone copies its source's parameters without the gate.
      const clone = await write(check, cloned(6), [written(7, 'bad'), written(8, 'ok')]);
      assert.match(clone.reads[0] ?? '', /RECURSIVE/, 'the clone’s whole subtree');
      assert.equal(check.invalid, 1, 'a clone of a failing sensor is counted');
    });

    it('lets a write during the pass stand over a page read before it, and counts nothing twice (P-367)', async () => {
      const { logger, parsed } = capturing();
      // The pass's snapshot: five failing sensors. Sensor 5 is a clone made while page one was
      // in flight, so the pass reads it too.
      const rows = sensors(['bad', 'bad', 'bad', 'bad', 'bad']);
      const during = async (from: string): Promise<void> => {
        if (from === '0') {
          // Committed while page one is in flight; the page still holds what they were.
          await write(check, edited(1), [written(1, 'ok')]);
          await write(check, deleted([[2, 'sensor']]), []);
          await write(check, cloned(5), [written(5, 'bad')]);
        }
        // While page two is in flight, sensor 3 is mended: the page holds it failing.
        if (from === '2') await write(check, edited(3), [written(3, 'ok')]);
        // And sensor 4, read failing on page two, is mended after it.
        if (from === '4') await write(check, edited(4), [written(4, 'ok')]);
      };
      const check: StoredParamsCheck = new StoredParamsCheck({
        db: fakeDb(rows, [], undefined, during),
        logger,
        sensorTypes: fakeGate([]),
        batchSize: 2,
      });
      const report = await check.run();
      assert.equal(report.complete, true);
      assert.equal(check.invalid, 1, 'the clone, once; not the mended, not the deleted');
      // The pass names only what no write had judged when it read it.
      assert.equal(report.invalid, 1);
      const named = parsed()
        .filter((line) => line['level'] === 40)
        .map((line) => line['sensorId']);
      assert.deepEqual(named, [4]);

      // After the pass, a write is simply the set's.
      await write(check, edited(5), [written(5, 'ok')]);
      assert.equal(check.invalid, 0);
    });
  });

  describe(
    'against a database',
    { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
    () => {
      /** A secret no log line may carry, in any of the sensors below. */
      const SECRET = 'Tr0ub4dor-and-3-horses';
      const QUOTED_SECRET = 'correct-horse-battery-staple';

      /** The same shape under an id the checking build does not register: a build that dropped it. */
      const dropped: SensorType = {
        id: 'test.dropped',
        category: 'Custom',
        costHint: 'light',
        declaresEveryChannel: true,
        paramsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { n: { type: 'integer', maximum: 3 } },
        },
        channels: () => [{ key: 'value', name: 'Value', isPrimary: true }],
        execute: () => Promise.resolve({ channels: [] }),
      };

      /** A type whose own check quotes the secret it refuses, as a careless one might. */
      const quoting: SensorType = {
        id: 'test.quoting',
        category: 'Custom',
        costHint: 'light',
        declaresEveryChannel: true,
        secretDestinations: { token: [] },
        paramsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            token: { type: 'string', writeOnly: true },
            mode: { enum: ['quiet', 'loud'], default: 'quiet' },
          },
        },
        paramProblems: (params) =>
          params['mode'] === 'loud'
            ? [{ path: '/mode', message: `loud mode cannot send ${String(params['token'])}` }]
            : [],
        channels: () => [{ key: 'value', name: 'Value', isPrimary: true }],
        execute: () => Promise.resolve({ channels: [] }),
      };

      const shipped = (id: string): SensorType => {
        const type = BUILT_IN_SENSOR_TYPES.find((one) => one.id === id);
        assert.ok(type !== undefined, id);
        return type;
      };

      let scratch: ScratchDatabase;
      let db: Database;
      let harness: Harness;
      let deviceId: number;
      const ids: Record<'valid' | 'reserved' | 'secret' | 'dropped' | 'quoting', number> = {
        valid: 0,
        reserved: 0,
        secret: 0,
        dropped: 0,
        quoting: 0,
      };

      before(async () => {
        scratch = await createScratchDatabase('stored_params');
        db = scratch.db;
        harness = await buildHarness(db, {
          catalogue: standardCatalogue([
            shipped('db.postgresql'),
            shipped('exe.script.advanced'),
            dropped,
            quoting,
          ]),
        });
        const probe = await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name: 'Probe',
        });
        const device = await harness.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: 'db-host',
          host: '192.0.2.58',
        });
        deviceId = device.id;

        /**
         * A sensor created as this build allows, then its parameters set behind the API's back to
         * `stored`, as an earlier build with a looser schema left them.
         */
        const sensor = async (
          type: string,
          created: Record<string, unknown>,
          stored?: Record<string, unknown>,
        ): Promise<number> => {
          const made = await harness.service.create(testActor, {
            kind: 'sensor',
            parentId: deviceId,
            name: `${type}-${String(process.hrtime.bigint())}`,
            sensorType: type,
            params: created,
          });
          if (stored !== undefined) {
            await db.query('UPDATE sensor_config SET params = $2 WHERE object_id = $1', [
              made.id,
              JSON.stringify(stored),
            ]);
          }
          return made.id;
        };

        ids.valid = await sensor('db.postgresql', {
          query: 'SELECT 1, 2',
          extract: [{ key: 'free', column: 'n' }],
        });
        // `P-348`: `rows` is the sensor's own channel, refused as an extract key since.
        ids.reserved = await sensor(
          'db.postgresql',
          { query: 'SELECT count(*) FROM t' },
          { query: 'SELECT count(*) FROM t', extract: [{ key: 'rows', column: 'n' }] },
        );
        // `P-349`: `runtime` refused as a script's primary, beside a `writeOnly` secret.
        ids.secret = await sensor(
          'exe.script.advanced',
          { program: 'check.sh' },
          { program: 'check.sh', secret: SECRET, primaryChannel: 'runtime' },
        );
        ids.dropped = await sensor('test.dropped', { n: 1 }, { n: 99 });
        ids.quoting = await sensor(
          'test.quoting',
          { mode: 'quiet' },
          { token: QUOTED_SECRET, mode: 'loud' },
        );
      });

      after(async () => {
        await scratch.drop();
      });

      /** Everything the pass could have written to, with each row's last writer. */
      const snapshot = async (): Promise<unknown> => ({
        sensors: await db.query(
          'SELECT object_id, type, params::text AS params, xmin::text AS xmin FROM sensor_config ORDER BY object_id',
        ),
        objects: await db.query(
          'SELECT id, version::text AS version, xmin::text AS xmin FROM object ORDER BY id',
        ),
        channels: await db.query('SELECT id, xmin::text AS xmin FROM channel ORDER BY id'),
      });

      it('names each failing sensor once with its paths and keywords, counts it, skips an unregistered type, writes nothing', async () => {
        const before = await snapshot();
        const { logger, lines, parsed } = capturing();
        // The checking build's catalogue: the shipped types, without `test.dropped`.
        const sensorTypes = catalogueSensorTypeGate(
          standardCatalogue([shipped('db.postgresql'), shipped('exe.script.advanced'), quoting]),
          { logger: silent },
        );
        const check = new StoredParamsCheck({ db, logger, sensorTypes, batchSize: 2 });
        assert.equal(check.invalid, null, 'a gap before the pass');
        const report: StoredParamsReport = await within(30_000, 'the check', check.run());

        const [{ count } = { count: '0' }] = await db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sensor_config',
        );
        assert.equal(report.sensors, Number(count), 'every sensor read, across pages of two');
        assert.equal(report.sensors >= 5, true);
        assert.equal(report.complete, true);
        assert.equal(report.invalid, 3);
        assert.deepEqual(report.invalidTypes, [
          'db.postgresql',
          'exe.script.advanced',
          'test.quoting',
        ]);
        assert.equal(report.unregistered, 1);
        assert.deepEqual(report.unregisteredTypes, ['test.dropped']);
        assert.equal(report.failedSensors, 0);
        // What `main.ts` hands Core Health as `sensorsWithInvalidParams`.
        assert.equal(check.invalid, 3);

        const all = parsed();
        assert.equal(
          all.filter((line) => line['sensorId'] === ids.valid).length,
          0,
          'a valid sensor is not named',
        );
        assert.equal(
          all.filter((line) => line['sensorId'] === ids.dropped).length,
          0,
          'nor one of a type this build does not have',
        );

        const reserved = warningFor(all, ids.reserved);
        assert.equal(reserved['sensorType'], 'db.postgresql');
        assert.equal(reserved['phase'], 'validate-stored-params');
        assert.deepEqual(
          (reserved['problems'] as { path: string; keyword: string }[]).map(
            ({ path, keyword }) => ({
              path,
              keyword,
            }),
          ),
          [{ path: '/extract/0/key', keyword: 'pattern' }],
        );

        const secret = warningFor(all, ids.secret);
        assert.equal(secret['sensorType'], 'exe.script.advanced');
        assert.deepEqual(
          (secret['problems'] as { path: string; keyword: string }[]).map(({ path, keyword }) => ({
            path,
            keyword,
          })),
          [{ path: '/primaryChannel', keyword: 'pattern' }],
        );

        const quoted = warningFor(all, ids.quoting);
        assert.deepEqual(quoted['problems'], [
          {
            path: '/mode',
            keyword: 'paramProblems',
            // Every value the parameters hold is cut, the mode as well as the token (`P-305`).
            message: '[a parameter] mode cannot send [a parameter]',
          },
        ]);

        // No secret in any line, as spelled or as base64; no parameter as a field of one.
        for (const value of [SECRET, QUOTED_SECRET]) {
          for (const form of [value, Buffer.from(value).toString('base64')]) {
            for (const line of lines) assert.equal(line.includes(form), false, line);
          }
        }
        for (const line of all) assert.equal('params' in line, false);

        const summaries = all.filter((line) => line['level'] === 30);
        assert.equal(summaries.length, 1, 'one line for the pass');
        const [summary] = summaries;
        assert.ok(summary !== undefined);
        assert.equal(summary['invalid'], 3);
        assert.deepEqual(summary['unregisteredTypes'], ['test.dropped']);

        assert.deepEqual(await snapshot(), before, 'nothing written: not a row, not a version');
      });

      it('takes a mended sensor and a deleted one off the count, and counts a clone of a failing one (P-367)', async () => {
        const sensorTypes = catalogueSensorTypeGate(
          standardCatalogue([shipped('db.postgresql'), shipped('exe.script.advanced'), quoting]),
          { logger: silent },
        );
        const check = new StoredParamsCheck({ db, logger: silent, sensorTypes, batchSize: 2 });
        // Where `main.ts` puts it: one of the object service's audit sinks.
        harness.audit.also = check;
        try {
          await within(30_000, 'the check', check.run());
          assert.equal(check.invalid, 3);

          await harness.service.update(
            testActor,
            ids.reserved,
            { kind: 'sensor', name: 'renamed, still failing' },
            { kind: 'none' },
          );
          assert.equal(check.invalid, 3, 'a rename mends nothing');

          await harness.service.update(
            testActor,
            ids.reserved,
            {
              kind: 'sensor',
              params: { query: 'SELECT count(*) FROM t', extract: [{ key: 'total', column: 'n' }] },
            },
            { kind: 'none' },
          );
          assert.equal(check.invalid, 2, 'mended by an edit');

          // A clone copies its source's parameters, past the gate.
          await harness.service.clone(testActor, ids.quoting, {}, Visibility.EVERYTHING);
          assert.equal(check.invalid, 3, 'a clone of a failing sensor counted');

          await harness.service.delete(
            testActor,
            ids.secret,
            { kind: 'exact', descendants: 0 },
            { kind: 'none' },
          );
          assert.equal(check.invalid, 2, 'deleted');
        } finally {
          harness.audit.also = undefined;
        }
      });
    },
  );
});

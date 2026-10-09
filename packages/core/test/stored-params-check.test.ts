import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { QueryResultRow } from 'pg';
import { pino, type Logger } from 'pino';
import { BUILT_IN_SENSOR_TYPES, standardCatalogue, type SensorType } from '@ms/sensors';
import type { Database, Queryable } from '../src/db/pool.js';
import {
  catalogueSensorTypeGate,
  type SensorTypeGate,
  type StoredParamProblem,
} from '../src/objects/sensor-type-gate.js';
import { StoredParamsCheck, type StoredParamsReport } from '../src/objects/stored-params-check.js';
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

    /** The keyset read over an array, recording the `after` each page asked from. */
    const fakeDb = (rows: readonly Row[], asked: string[], failAfter?: string): Queryable => ({
      query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        assert.match(text, /FROM sensor_config/);
        assert.match(text, /ORDER BY object_id LIMIT/);
        const [from, limit] = values as [string, number];
        asked.push(from);
        if (from === failAfter) return Promise.reject(new Error('connection reset'));
        const page = rows
          .filter((row) => row.id > Number(from))
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((row) => ({ id: String(row.id), type: row.type, params: row.params }));
        return Promise.resolve(page as unknown as T[]);
      },
    });

    /** Invalid when `bad`, unregistered for `gone`, throws for `boom`; records each sensor seen. */
    const fakeGate = (seen: string[]): Pick<SensorTypeGate, 'storedParamProblems'> => ({
      storedParamProblems: (type, params): readonly StoredParamProblem[] | null => {
        seen.push(String(params['n']));
        if (type === 'gone') return null;
        if (type === 'boom') throw new TypeError(`cannot read ${String(params['secret'])}`);
        return type === 'bad' ? [{ path: '/n', keyword: 'maximum', message: 'must be <= 3' }] : [];
      },
    });

    const sensors = (types: readonly string[]): Row[] =>
      types.map((type, at) => ({ id: at + 1, type, params: { n: at + 1, secret: 'S3cr3t-x' } }));

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
    },
  );
});

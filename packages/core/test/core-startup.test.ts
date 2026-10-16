import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import {
  generateCoreCerts,
  opensslAvailable,
  startCore,
  type RunningCore,
} from './support/core-process.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { somebodyWaits } from './support/waits-for-lock.js';
import { pollWithin, within } from './support/within.js';
import { coreCatalogue } from '../src/profile.js';
import { applyDeclaredLimits } from '../src/state/declared-limits.js';

const available = await databaseAvailable();

/** A log line, as pino writes it. */
type Line = Record<string, unknown>;

/** The declared-primary repair's own lines (`P-323`): its child logger names it. */
const repairLines = (core: RunningCore): Line[] =>
  core.logs().filter((line) => line['component'] === 'declared-primary-repair');

/** The repair's closing report: the line that carries `complete`. */
/** The stored-parameters pass's lines (`P-358`, `P-369`). */
const storedParamsLines = (core: RunningCore): Line[] =>
  core.logs().filter((line) => line['component'] === 'stored-params-check');

/** That pass's closing report. */
const storedParamsReport = (core: RunningCore): Line | undefined =>
  storedParamsLines(core).find((line) => typeof line['complete'] === 'boolean');

const reportOf = (core: RunningCore): Line | undefined =>
  repairLines(core).find((line) => typeof line['complete'] === 'boolean');

/** What a log line said, for an assertion's message. */
const said = (core: RunningCore): string =>
  core
    .logs()
    .map((line) => JSON.stringify(line))
    .slice(-40)
    .join('\n');

/**
 * The core's start-up wiring of the declared-primary repair, run as a process (`P-331`).
 *
 * `main.ts` starts the pass without awaiting it, registers a shutdown hook that waits for the page
 * in flight, and logs a failure rather than letting it take the core down (`P-323`). The pass
 * itself is tested part by part in `declared-primary.test.ts`; this is the wiring, which only a
 * started core reaches.
 */
describe(
  'the core’s start-up repair, in a started core (P-331)',
  {
    skip: !available
      ? 'no PostgreSQL reachable (start docker-compose.dev.yml)'
      : !opensslAvailable
        ? 'no openssl to make the probe endpoint’s certificates'
        : false,
  },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let dir: string;
    let deviceId: number;

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ms-core-startup-'));
      generateCoreCerts(dir);
      scratch = await createScratchDatabase('core_startup');
      db = scratch.db;
      harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'router',
        host: '192.0.2.70',
      });
      deviceId = device.id;
    });

    after(async () => {
      await scratch.drop();
      await rm(dir, { recursive: true, force: true });
    });

    /**
     * `count` ping sensors whose primary an earlier build left on `loss`, where `icmp.ping`
     * declares `rtt`: what the repair exists to move.
     */
    async function misplaced(count: number): Promise<number[]> {
      const ids: number[] = [];
      for (let index = 0; index < count; index += 1) {
        const sensor = await harness.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: `ping-${String(process.hrtime.bigint())}`,
          sensorType: 'icmp.ping',
        });
        await db.query('DELETE FROM channel WHERE sensor_id = $1', [sensor.id]);
        await db.query(
          "INSERT INTO channel (sensor_id, key, name, unit, is_primary) VALUES ($1, 'rtt', 'Response time', 'ms', false), ($1, 'loss', 'Packet loss', '%', true)",
          [sensor.id],
        );
        ids.push(sensor.id);
      }
      return ids;
    }

    const primaryOf = async (sensorId: number): Promise<string[]> =>
      (
        await db.query<{ key: string }>(
          'SELECT key FROM channel WHERE sensor_id = $1 AND is_primary ORDER BY key',
          [sensorId],
        )
      ).map((one) => one.key);

    /**
     * Settles what start-up's declared-limits pass would write, as a start would have: so that
     * pass, which is awaited and writes channel rows too, has nothing to wait for below.
     */
    const settleLimits = async (): Promise<void> => {
      await applyDeclaredLimits({ db, logger: silent, catalogue: coreCatalogue('full') });
    };

    /**
     * Holds one channel row against writers until `release` is called. Only the repair writes a
     * sensor's channel rows at start-up, once the limits are settled, so this stops it in the
     * middle of a page: after its read, inside the transaction that moves the primary.
     */
    async function holdChannel(
      sensorId: number,
      key: string,
    ): Promise<{ release: () => Promise<void> }> {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const held = db.tx(async (q) => {
        await q.query('SELECT 1 FROM channel WHERE sensor_id = $1 AND key = $2 FOR UPDATE', [
          sensorId,
          key,
        ]);
        locked();
        await released;
      });
      await within(10_000, 'the lock on the channel row', isLocked);
      return {
        release: async () => {
          release();
          await within(10_000, 'the lock to be let go', held);
        },
      };
    }

    const database = () => ({ ...testDatabaseConfig(), database: scratch.name });

    const ready = (core: RunningCore): Promise<void> =>
      pollWithin(
        60_000,
        () => `the core to be ready:\n${said(core)}`,
        () => core.logs().some((line) => line['msg'] === 'ready'),
        20,
      );

    const answers = async (core: RunningCore): Promise<number> =>
      (await fetch(`http://127.0.0.1:${String(core.apiPort)}/api/v1/objects/root`)).status;

    it('moves the declared primaries once the core is up, audited by the repair', async () => {
      const ids = await misplaced(3);
      // And one whose stored parameters this build's schema refuses (`P-369`): a count of pings
      // that is not a number, as an earlier build might have stored it.
      const { id: refused } = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: `refused-${String(process.hrtime.bigint())}`,
        sensorType: 'icmp.ping',
      });
      await db.query(
        `UPDATE sensor_config SET params = '{"count": "lots"}'::jsonb WHERE object_id = $1`,
        [refused],
      );
      const core = await startCore({ dir, database: database() });
      try {
        await ready(core);
        await pollWithin(
          30_000,
          () => `the repair’s report:\n${said(core)}`,
          () => reportOf(core) !== undefined,
          20,
        );
        const report = reportOf(core);
        assert.equal(report?.['moved'], 3, said(core));
        assert.equal(report['complete'], true);
        for (const id of ids) assert.deepEqual(await primaryOf(id), ['rtt']);
        const audited = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_log
           WHERE actor_kind = 'system' AND actor_ref = 'declared-primary-startup-repair'
             AND action = 'channel.redeclared' AND object_id = ANY($1::bigint[])`,
          [ids],
        );
        // Two per sensor: `loss` demoted, `rtt` promoted.
        assert.equal(audited[0]?.n, '6');
        assert.equal(await answers(core), 401, 'and the core is serving');

        // **The stored-parameters pass, wired beside it** (`P-369`): started unawaited, it names
        // the sensor and counts it.
        await pollWithin(
          30_000,
          () => `the stored-parameters report:\n${said(core)}`,
          () => storedParamsReport(core) !== undefined,
          20,
        );
        const named = storedParamsLines(core).find((line) => line['sensorId'] === refused);
        assert.ok(named !== undefined, `the refused sensor is named:\n${said(core)}`);
        assert.equal(named['level'], 'warn');
        assert.equal(named['phase'], 'validate-stored-params');
        const checked = storedParamsReport(core);
        assert.equal(checked?.['invalid'], 1);
        assert.equal(checked['complete'], true);
      } finally {
        assert.equal(await core.stop(), 0, `a clean exit:\n${said(core)}`);
      }
    });

    it('stops between pages at shutdown, and the shutdown waits for the page in flight', async () => {
      const [held] = await misplaced(1);
      assert.ok(held !== undefined);
      await settleLimits();
      const lock = await holdChannel(held, 'loss');
      let released = false;
      // A lock wait long enough to outlast the test, so the page waits rather than fails.
      const core = await startCore({
        dir,
        database: database(),
        // Debug, for the lifecycle's line as each shutdown hook completes.
        logLevel: 'debug',
        env: { MS_DATABASE__LOCK_TIMEOUT_MS: '120000' },
      });
      try {
        await ready(core);
        await somebodyWaits(db, 'the repair to be waiting on the channel row', 30_000);
        assert.equal(reportOf(core), undefined, 'the repair is in the middle of its first page');

        const stopping = core.stop();
        await pollWithin(
          10_000,
          () => `the shutdown to start:\n${said(core)}`,
          () => core.logs().some((line) => line['msg'] === 'shutting down'),
          20,
        );
        // The process is still up: the hook is waiting for the page the repair is in.
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(reportOf(core), undefined, 'the shutdown did not abandon the page in flight');
        await lock.release();
        released = true;
        assert.equal(await stopping, 0, `a clean exit:\n${said(core)}`);

        const report = reportOf(core);
        assert.ok(report !== undefined, `the repair reported before the exit:\n${said(core)}`);
        assert.equal(report['moved'], 1, 'the page in flight finished its move');
        assert.equal(report['complete'], false, 'and the pass stopped there, for the shutdown');
        assert.deepEqual(await primaryOf(held), ['rtt']);

        // **Waited for by its own hook, before the database closed.** Closing the pool waits for
        // a client still checked out, so the page would finish without the hook; what the hook
        // adds is that the shutdown waits for the repair as a step of its own, before anything
        // the repair uses is stopped. So the report comes before that hook completes.
        const lines = core.logs();
        const hookDone = (name: string): number =>
          lines.findIndex(
            (line) => line['msg'] === 'shutdown hook complete' && line['hook'] === name,
          );
        const reported = lines.indexOf(report);
        const repairHook = hookDone('declared-primary-repair');
        const databaseHook = hookDone('database');
        assert.ok(reported >= 0 && repairHook >= 0 && databaseHook >= 0, said(core));
        assert.ok(reported < repairHook, 'the repair’s hook waited for the page in flight');
        assert.ok(repairHook < databaseHook, 'before the database was closed');
        // The stored-parameters pass finished before `ready` here, with nothing to hold it: every
        // reader of its one table before it is awaited by the start, so a lock that held it would
        // hold the start. Its hook still runs, before the database closes (`P-369`).
        const storedHook = hookDone('stored-params-check');
        assert.ok(storedHook >= 0 && storedHook < databaseHook, said(core));
        // And the repair of channels created undeclared (`P-312`), with nothing marked here.
        const undeclaredHook = hookDone('undeclared-channel-repair');
        assert.ok(undeclaredHook >= 0 && undeclaredHook < databaseHook, said(core));
        // And the one after it, naming channels created by their key (`P-402`).
        const labelHook = hookDone('declared-label-repair');
        assert.ok(labelHook >= 0 && labelHook < databaseHook, said(core));
      } finally {
        if (!released) await lock.release();
        await core.stop();
      }
    });

    it('logs a failure and goes on serving', async () => {
      const [held] = await misplaced(1);
      assert.ok(held !== undefined);
      await settleLimits();
      const lock = await holdChannel(held, 'loss');
      // A lock wait of one second: the repair's move gives up while the test holds the row.
      const core = await startCore({
        dir,
        database: database(),
        env: { MS_DATABASE__LOCK_TIMEOUT_MS: '1000' },
      });
      try {
        await pollWithin(
          60_000,
          () => `the repair's report:\n${said(core)}`,
          () => reportOf(core) !== undefined,
          20,
        );
        const failed = repairLines(core).find((line) => line['phase'] === 'move-page');
        assert.ok(failed !== undefined, `a page failed and said so:\n${said(core)}`);
        assert.equal(failed['level'], 'warn', 'as a warning');
        const report = reportOf(core);
        assert.equal(report?.['failedPages'], 1, 'counted');
        assert.equal(report['moved'], 0);
        assert.deepEqual(await primaryOf(held), ['loss'], 'left for the next start');

        await ready(core);
        assert.equal(await answers(core), 401, 'and the core is up and serving');
        assert.equal(
          core.logs().filter((line) => line['level'] === 'fatal').length,
          0,
          'nothing fatal',
        );
      } finally {
        await lock.release();
        assert.equal(await core.stop(), 0, `a clean exit:\n${said(core)}`);
      }
    });
  },
);

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { ReceivedBatch } from '@ms/sensors';
import type { BuildProfile, CheckResult, QueryFailure, SensorAssignment } from '@ms/shared';
import { dispatchTables, missingTypeError, probeCatalogue } from '../src/catalogue.js';
import { dueDispatcher } from '../src/due-dispatch.js';
import { QueryRunner } from '../src/queries/runner.js';
import { CheckPool, type ResultMeta } from '../src/runner/index.js';
import { pollWithin } from './support/within.js';

/**
 * What a probe build carries (`H-12`), asked of the running thing.
 *
 * The pool below loads the real worker registry — the one a probe runs, not a fixture — and the
 * profile reaches it the only way a working tree has one: `MS_BUILD_PROFILE`, read by the worker
 * as it starts. A test of `sensorTypesFor` alone would pass with a registry that ignored it.
 *
 * **Both profiles, so the refusal is the profile's doing.** A v1 probe refuses `flow.netflow` by
 * name; the full one runs it and fails for the reason flow fails today (`B-07`), in the execute
 * phase. If the v1 refusal came from something else, the two would look alike.
 */

const silent = pino({ level: 'silent' });
const pools: CheckPool[] = [];

after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

interface Seen {
  sensorType: string;
  result: CheckResult;
  meta: ResultMeta;
}

/**
 * `run`, in a working tree whose profile is `profile`.
 *
 * The variable is held until `run` settles, because a worker takes its environment when it is
 * created and a pool may create one late.
 */
async function asProfile<T>(profile: BuildProfile, run: () => Promise<T>): Promise<T> {
  const previous = process.env['MS_BUILD_PROFILE'];
  process.env['MS_BUILD_PROFILE'] = profile;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env['MS_BUILD_PROFILE'];
    else process.env['MS_BUILD_PROFILE'] = previous;
  }
}

function until(done: () => boolean, what: string): Promise<void> {
  return pollWithin(15_000, what, done, 10);
}

/**
 * A one-worker pool built as `profile`, `submit` run against it, and the results of the
 * `sensorTypes.length` checks it submits (sensor ids 1, 2, … in that order).
 */
function throughPool(
  profile: BuildProfile,
  sensorTypes: readonly string[],
  submit: (pool: CheckPool) => void,
): Promise<Seen[]> {
  return asProfile(profile, async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      minSize: 1,
      onResult: (result, meta) => {
        seen.push({ sensorType: sensorTypes[result.sensorId - 1] ?? '?', result, meta });
      },
    });
    pools.push(pool);
    await pool.start();
    submit(pool);
    await until(() => seen.length >= sensorTypes.length, `${String(sensorTypes.length)} results`);
    return seen;
  });
}

/** Each type submitted straight to the pool. */
function runAs(profile: BuildProfile, sensorTypes: readonly string[]): Promise<Seen[]> {
  return throughPool(profile, sensorTypes, (pool) => {
    sensorTypes.forEach((sensorType, index) => {
      pool.submit({
        sensorId: index + 1,
        sensorType,
        // Closed on loopback, so a type the build carries fails fast in the execute phase and
        // never touches a network.
        target: { host: '127.0.0.1', ipVersion: 'auto' as const },
        params: { port: 1 },
        timeoutMs: 5_000,
      });
    });
  });
}

/**
 * A `flow.netflow` assignment falling due on a probe built as `profile`, dispatched the way
 * `main.ts` dispatches it: the tables `dispatchTables` builds from that build's catalogue, the
 * real `dueDispatcher`, the real pool.
 *
 * **With a flow listener present whatever the profile**, the way `B-07` will wire one. Nothing
 * but the table then stands between that listener and a flow assignment. A v1 probe must not
 * feed it, and the full one must, or the v1 answer says nothing about the profile.
 */
async function dispatchFlowAs(
  profile: BuildProfile,
): Promise<{ seen: Seen; drained: readonly number[] }> {
  const flow = probeCatalogue('full').declaration('flow.netflow').listener;
  assert.ok(flow !== undefined, 'flow.netflow declares no listener');
  const drained: number[] = [];
  const at = new Date().toISOString();
  const listener = {
    drain(sensorId: number): ReceivedBatch {
      drained.push(sensorId);
      return { listener: flow, items: [], dropped: 0, since: at, until: at };
    },
  };
  const assignment: SensorAssignment = {
    sensorId: 1,
    sensorType: 'flow.netflow',
    target: { host: '127.0.0.1', ipVersion: 'auto' },
    params: {},
    intervalSeconds: 60,
    timeoutMs: 5_000,
  };
  const { listenerFor, isolated } = dispatchTables(probeCatalogue(profile));

  const seen = await throughPool(profile, ['flow.netflow'], (pool) => {
    dueDispatcher({
      assignments: { get: (sensorId) => (sensorId === 1 ? assignment : undefined) },
      listenerFor,
      listeners: new Map([[flow, listener]]),
      isolated,
      pool,
      // Never chosen: flow is not an isolated type in either profile.
      processRunner: {
        accepts: () => false,
        submit: () => assert.fail('flow.netflow went to the process runner'),
      },
      onDispatch: () => undefined,
    })([1]);
  });
  return { seen: of(seen, 'flow.netflow'), drained };
}

function of(seen: readonly Seen[], sensorType: string): Seen {
  const found = seen.find((entry) => entry.sensorType === sensorType);
  assert.ok(found, `no result for ${sensorType}`);
  return found;
}

const WITHHELD = [
  'flow.netflow',
  'windows.cpu',
  'windows.memory',
  'windows.service',
  'windows.volume',
];

describe('a v1 probe', () => {
  it('refuses the types v1 leaves out, by name and with the reason', async () => {
    const seen = await runAs('v1', [...WITHHELD, 'nope.missing', 'port.tcp']);

    for (const id of WITHHELD) {
      const { meta, result } = of(seen, id);
      assert.equal(meta.phase, 'unknown-type', id);
      assert.equal(result.outcome, 'error');
      assert.match(
        result.message,
        new RegExp(`sensor type "${id.replace('.', '\\.')}" is not in this build: the v1 profile`),
      );
    }
    assert.match(of(seen, 'flow.netflow').result.message, /flow monitoring is v2/);
    assert.match(of(seen, 'windows.cpu').result.message, /Windows is release 1\.1/);

    // A type nobody built is unknown, not withheld — and says nothing about profiles.
    assert.equal(of(seen, 'nope.missing').meta.phase, 'unknown-type');
    assert.match(of(seen, 'nope.missing').result.message, /no sensor type "nope\.missing"/);

    // And a v1 type runs: it fails against a closed port, in the execute phase, like any check.
    assert.equal(of(seen, 'port.tcp').meta.phase, 'execute');
  });

  it('refuses a flow.netflow assignment by name, and feeds it from no listener (`H-13`)', async () => {
    // Not "binds no UDP socket": `main` satisfies that today with v2 fully on, because the
    // collector was never wired (`B-07`), and a check the defect passes is catalogue entry 43.
    const { seen, drained } = await dispatchFlowAs('v1');
    assert.equal(seen.meta.phase, 'unknown-type');
    assert.match(
      seen.result.message,
      /sensor type "flow\.netflow" is not in this build: the v1 profile leaves it out/,
    );
    assert.deepEqual(
      drained,
      [],
      'a v1 probe drained a flow listener for a type it does not carry',
    );
  });

  it('maps no listener to a type it does not carry', () => {
    const { listenerFor } = dispatchTables(probeCatalogue('v1'));
    for (const id of WITHHELD) assert.equal(listenerFor.has(id), false, id);
    assert.ok(listenerFor.has('snmp.trap') && listenerFor.has('syslog.receiver'));
  });

  it('answers a check-now of a withheld type with the reason, not a guess (`H-13`)', async () => {
    // The on-demand path has its own pool and its own answer. It used to replace the registry's
    // message with "probably older than the core", which sent an operator to upgrade a probe
    // that was already the newest build there is.
    const answers: { failure?: QueryFailure; message?: string }[] = [];
    await asProfile('v1', async () => {
      const runner = new QueryRunner({
        logger: silent,
        answer: (message) => answers.push(message),
      });
      await runner.start();
      try {
        runner.run(
          'check-now',
          {
            kind: 'check',
            assignment: {
              sensorId: 1,
              sensorType: 'flow.netflow',
              target: { host: '127.0.0.1', ipVersion: 'auto' },
              params: {},
              intervalSeconds: 60,
              timeoutMs: 5_000,
            },
          },
          5_000,
        );
        await until(() => answers.length > 0, 'an answer');
      } finally {
        await runner.stop();
      }
    });
    const [answer] = answers;
    assert.ok(answer, 'no answer');
    assert.equal(answer.failure, 'unsupported');
    assert.match(
      answer.message ?? '',
      /sensor type "flow\.netflow" is not in this build: the v1 profile leaves it out, because flow monitoring is v2/,
    );
  });
});

describe('a full probe', () => {
  it('runs flow.netflow, which is how the v1 refusal is known to be the profile’s', async () => {
    const seen = await runAs('full', ['flow.netflow']);
    const { meta, result } = of(seen, 'flow.netflow');
    assert.equal(meta.phase, 'execute');
    assert.match(result.message, /flow collector is not running/);
  });

  it('feeds a flow.netflow assignment from its listener, through the same dispatch', async () => {
    const { seen, drained } = await dispatchFlowAs('full');
    assert.deepEqual(
      drained,
      [1],
      'the listener the v1 probe left alone is the one this one reads',
    );
    assert.notEqual(seen.meta.phase, 'unknown-type');
    assert.doesNotMatch(seen.result.message, /flow collector is not running/);
  });

  it('names no profile when it refuses a type', () => {
    assert.equal(
      missingTypeError('flow.netflow', 'full').message,
      'no sensor type "flow.netflow" is registered in this probe, which is probably older than ' +
        'the core',
    );
  });
});

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { BuildProfile, CheckResult } from '@ms/shared';
import { missingTypeError, probeCatalogue } from '../src/catalogue.js';
import { CheckPool, type ResultMeta } from '../src/runner/index.js';

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
 * A one-worker pool built as `profile`, the checks run through it, and their results.
 *
 * The variable is held until every result is in, because a worker takes its environment when it
 * is created and a pool may create one late.
 */
async function runAs(profile: BuildProfile, sensorTypes: readonly string[]): Promise<Seen[]> {
  const previous = process.env['MS_BUILD_PROFILE'];
  process.env['MS_BUILD_PROFILE'] = profile;
  try {
    const seen: Seen[] = [];
    const byId = new Map<number, string>();
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      minSize: 1,
      onResult: (result, meta) => {
        seen.push({ sensorType: byId.get(result.sensorId) ?? '?', result, meta });
      },
    });
    pools.push(pool);
    await pool.start();
    sensorTypes.forEach((sensorType, index) => {
      byId.set(index + 1, sensorType);
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
    const deadline = Date.now() + 15_000;
    while (seen.length < sensorTypes.length) {
      if (Date.now() > deadline) throw new Error(`timed out: ${String(seen.length)} results`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return seen;
  } finally {
    if (previous === undefined) delete process.env['MS_BUILD_PROFILE'];
    else process.env['MS_BUILD_PROFILE'] = previous;
  }
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

  it('maps no listener to a type it does not carry', () => {
    const ids = probeCatalogue('v1').ids();
    for (const id of WITHHELD) assert.equal(ids.includes(id), false, id);
    assert.ok(ids.includes('snmp.trap') && ids.includes('syslog.receiver'));
  });
});

describe('a full probe', () => {
  it('runs flow.netflow, which is how the v1 refusal is known to be the profile’s', async () => {
    const seen = await runAs('full', ['flow.netflow']);
    const { meta, result } = of(seen, 'flow.netflow');
    assert.equal(meta.phase, 'execute');
    assert.match(result.message, /flow collector is not running/);
  });

  it('names no profile when it refuses a type', () => {
    assert.equal(
      missingTypeError('flow.netflow', 'full').message,
      'no sensor type "flow.netflow" is registered',
    );
  });
});

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { TARGET_POLICY_ENV } from '@ms/sensors';
import { CheckPool } from '../src/runner/pool.js';
import { ProcessRunner } from '../src/runner/process-runner.js';
import { handTargetPolicy } from '../src/target-policy-env.js';

/**
 * `probe.targetPolicy` reaches a check, in a worker thread and in a check process (`A-65`).
 *
 * `main.ts` calls `handTargetPolicy` and gives what it returns to the process runner; this
 * starts the two runners `main.ts` starts, the same way, and asks a check in each what policy
 * its catalogue handed it. The registry (`support/policy-registry.ts`) is a real catalogue with
 * one type that says so.
 */

const silent = pino({ level: 'silent' });
const REGISTRY = join(import.meta.dirname, 'support', 'policy-registry.js');

const pools: CheckPool[] = [];
const runners: ProcessRunner[] = [];
const held = process.env[TARGET_POLICY_ENV];

const restore = (): void => {
  if (held === undefined) delete process.env['MS_TARGET_POLICY'];
  else process.env[TARGET_POLICY_ENV] = held;
};

afterEach(restore);
after(async () => {
  await Promise.all([...pools.map((pool) => pool.stop()), ...runners.map((one) => one.stop())]);
});

async function until(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const request = (sensorId: number) => ({
  sensorId,
  sensorType: 'test.policy',
  // A check that arrives claiming a policy is told the probe's all the same.
  target: { host: '192.0.2.1', ipVersion: 'auto' as const, policy: 'none' as const },
  params: {},
  timeoutMs: 20_000,
});

/** What a check in a worker thread started now is told. */
async function inWorker(): Promise<string> {
  const seen: CheckResult[] = [];
  const pool = new CheckPool({
    logger: silent,
    size: 1,
    minSize: 1,
    registryModule: REGISTRY,
    onResult: (result) => seen.push(result),
  });
  pools.push(pool);
  await pool.start();
  assert.equal(pool.submit(request(1)), 'accepted');
  await until(() => seen.length === 1, 'the worker’s check');
  assert.equal(seen[0]?.outcome, 'ok', seen[0]?.message);
  return seen[0].message;
}

/** What a check in a process of its own is told, given this in `childEnv`. */
async function inProcess(childEnv: Readonly<Record<string, string>> | undefined): Promise<string> {
  const seen: CheckResult[] = [];
  const runner = new ProcessRunner({
    logger: silent,
    registryModule: REGISTRY,
    ...(childEnv === undefined ? {} : { childEnv }),
    onResult: (result) => seen.push(result),
  });
  runners.push(runner);
  assert.equal(runner.submit(request(2)), 'accepted');
  await until(() => seen.length === 1, 'the check process');
  assert.equal(seen[0]?.outcome, 'ok', seen[0]?.message);
  return seen[0].message;
}

describe('handing probe.targetPolicy to what runs a check', () => {
  for (const policy of ['none', 'private', 'link-local'] as const) {
    it(`a worker thread and a check process both run under ${policy}`, async () => {
      // The other of the two in the environment first, so the answer is this call's doing.
      process.env[TARGET_POLICY_ENV] = policy === 'none' ? 'private' : 'none';
      const childEnv = handTargetPolicy(policy);
      assert.deepEqual(childEnv, { [TARGET_POLICY_ENV]: policy });
      assert.equal(process.env[TARGET_POLICY_ENV], policy);

      assert.equal(await inWorker(), `policy=${policy}`);
      // The parent's environment is not what a check process reads: it is told, or it is not.
      process.env[TARGET_POLICY_ENV] = policy === 'none' ? 'private' : 'none';
      assert.equal(await inProcess(childEnv), `policy=${policy}`);
    });
  }

  for (const value of ['', '  ', 'None', 'NONE', 'off', 'linklocal', 'none,private']) {
    it(`writes link-local, never none, for ${JSON.stringify(value)}`, () => {
      const env: NodeJS.ProcessEnv = { [TARGET_POLICY_ENV]: 'none' };
      assert.deepEqual(handTargetPolicy(value, env), { [TARGET_POLICY_ENV]: 'link-local' });
      assert.equal(env[TARGET_POLICY_ENV], 'link-local');
    });
  }

  it('writes to the environment it is given, and to this process’s when given none', () => {
    process.env[TARGET_POLICY_ENV] = 'none';
    const env: NodeJS.ProcessEnv = {};
    handTargetPolicy('private', env);
    assert.equal(env[TARGET_POLICY_ENV], 'private');
    assert.equal(process.env[TARGET_POLICY_ENV], 'none', 'and to no other');
  });
});

describe('a runner started with a value nobody recognises', () => {
  // Past `handTargetPolicy`, which would not write one: the last line of defence is the
  // catalogue's own reading, in the thread or process the check runs in.
  for (const value of [undefined, '', 'None', 'off']) {
    it(`holds a worker’s checks to link-local for ${JSON.stringify(value)}`, async () => {
      if (value === undefined) delete process.env['MS_TARGET_POLICY'];
      else process.env[TARGET_POLICY_ENV] = value;
      assert.equal(await inWorker(), 'policy=link-local');
    });

    it(`holds a check process to link-local for ${JSON.stringify(value)}`, async () => {
      // `none` in the parent, which a check process must not inherit either.
      process.env[TARGET_POLICY_ENV] = 'none';
      assert.equal(
        await inProcess(value === undefined ? undefined : { [TARGET_POLICY_ENV]: value }),
        'policy=link-local',
      );
    });
  }
});

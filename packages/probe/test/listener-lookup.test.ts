import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CheckResult } from '@ms/shared';
import { NameResolver } from '../src/resolver/name-resolver.js';
import { CheckPool, type ResultMeta } from '../src/runner/index.js';
import { fakeResolve } from './support/fake-names.js';
import { pollWithin } from './support/within.js';

/**
 * A listener sensor's sender, resolved as every other check resolves a name (`P-425`): the three
 * real listener types in real workers (`support/lookup-registry.ts`), each with its device named,
 * "only this device" on, and an empty batch from its listener in hand.
 *
 * They used to call `dns.lookup` with no bound and no signal: a resolver that did not answer held
 * the check to the pool's timeout, the check could not be stopped, and the pool terminated its
 * worker. Here the pool's timeout is 2 s, the lookup's bound half of it, and the grace for an
 * abort a tenth of a second, so a check that waited past its bound would be timed out and its
 * worker recycled well inside the test.
 */

const silent = pino({ level: 'silent' });
const LOOKUPS = join(import.meta.dirname, 'support', 'lookup-registry.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const pools: CheckPool[] = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
});

async function poolOf(resolver?: NameResolver) {
  const seen: Seen[] = [];
  const pool = new CheckPool({
    logger: silent,
    size: 1,
    minSize: 1,
    registryModule: LOOKUPS,
    abortGraceMs: 100,
    sessionReportMs: 20,
    ...(resolver === undefined ? {} : { resolver }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  pools.push(pool);
  await pool.start();
  return { pool, seen };
}

const AT = new Date().toISOString();
/** Each listener type, what it counts, and the listener its batch comes from. */
const LISTENERS = [
  { sensorType: 'snmp.trap', counts: 'notifications', listener: 'snmp-trap' },
  { sensorType: 'syslog.receiver', counts: 'messages', listener: 'syslog' },
  { sensorType: 'flow.netflow', counts: 'flows', listener: 'flow' },
] as const;
type Listener = (typeof LISTENERS)[number];

const scanOf = (sensorId: number, host: string, { sensorType, listener }: Listener) => ({
  sensorId,
  sensorType,
  target: { host, ipVersion: 'auto' as const },
  params: { sourceIsDevice: true, silenceIsIdle: true },
  received: { listener, items: [], dropped: 0, since: AT, until: AT },
  timeoutMs: 2_000,
});
const SYSLOG = LISTENERS[1];

/** A bound on a wait, never a measure: a loaded machine may take seconds to start a worker. */
function until(predicate: () => boolean, what: string, timeoutMs = 10_000) {
  return pollWithin(timeoutMs, what, predicate, 5);
}

describe('a listener sensor’s sender (P-425)', () => {
  for (const type of LISTENERS) {
    it(`${type.sensorType} fails at the lookup’s bound when the resolver does not answer, and keeps its worker`, async () => {
      const { pool, seen } = await poolOf();
      pool.submit(scanOf(1, 'hangs-sender.test', type));
      await until(() => seen.length === 1, 'the check');
      const first = seen[0];
      assert.ok(first !== undefined);
      assert.equal(first.meta.phase, 'execute', 'failed by the check, not timed out by the pool');
      assert.equal(first.result.outcome, 'error');
      assert.equal(
        first.result.message,
        `this sensor counts only ${type.counts} from hangs-sender.test, and that name did not ` +
          'resolve within 1000 ms — the probe’s resolver is not answering — so nothing could be ' +
          'attributed to this device. Give the device a literal address, or turn off “only this ' +
          'device”',
      );
      assert.ok(first.result.durationMs < 2_000, `${String(first.result.durationMs)} ms`);
      await until(() => pool.stats().lookups?.givenUp === 1, 'the lookup to be counted given up');
      assert.equal(pool.stats().lookups?.inFlight, 1, 'and in flight: the resolver never answers');

      // The same worker takes the next check: nothing was terminated.
      pool.submit(scanOf(2, 'answers-sender.test', type));
      await until(() => seen.length === 2, 'the second check');
      assert.equal(seen[1]?.meta.workerId, first.meta.workerId, 'the worker was not recycled');
    });
  }

  it('asks the probe’s resolver, where the pool serves lookups', async () => {
    const asked: string[] = [];
    const resolver = new NameResolver({
      logger: silent,
      watch: { files: [], everyMs: 60_000 },
      lookup: (host, family) => {
        asked.push(host);
        return fakeResolve(host, family);
      },
    });
    const { pool, seen } = await poolOf(resolver);
    pool.submit(scanOf(1, 'answers-kept.test', SYSLOG));
    pool.submit(scanOf(2, 'answers-kept.test', SYSLOG));
    await until(() => seen.length === 2, 'both checks');
    for (const { result } of seen) assert.equal(result.outcome, 'ok', result.message);
    assert.deepEqual(asked, ['answers-kept.test'], 'asked once, and kept');
  });
});

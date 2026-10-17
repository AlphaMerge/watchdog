import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { SensorCatalogue } from '../src/catalogue.js';
import type { SensorType } from '../src/contract.js';
import { nameLookups as exported, LookupCount as ExportedCount } from '../src/index.js';
import { checkedTarget } from '../src/support/checked-target.js';
import { LookupCount, nameLookups } from '../src/support/lookups.js';
import {
  pinTarget,
  resolveWithin,
  type ResolvedAddress,
  type ResolveHost,
} from '../src/support/pinned-target.js';

/**
 * What a thread's name lookups are doing, for Probe Health (`A-66`).
 *
 * **The lookup is counted, not the check.** `getaddrinfo` cannot be cancelled, so one a check
 * stopped waiting for is still on the thread pool: in flight until the resolver answers it, and
 * given up from the moment the check stopped waiting. Each case here drives `resolveWithin` with a
 * resolver the test settles by hand, and reads the count on each side of the settling.
 */

const ANSWER: readonly ResolvedAddress[] = [{ address: '10.20.0.9', family: 4 }];

/** A lookup the test answers, fails or leaves for ever. */
function lookup(): {
  readonly pending: Promise<readonly ResolvedAddress[]>;
  readonly answer: () => void;
  readonly fail: () => void;
} {
  let answer = (): void => undefined;
  let fail = (): void => undefined;
  const pending = new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
    answer = () => {
      resolve(ANSWER);
    };
    fail = () => {
      reject(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }));
    };
  });
  return { pending, answer, fail };
}

const errors = {
  cancelled: () => new Error('cancelled'),
  timedOut: () => new Error('timed out'),
};

/** Every reaction a settled lookup queued has run: `setImmediate` is after all of them. */
const drained = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('a lookup, counted where a check waits for it (A-66)', () => {
  it('is in flight while it is waited for, and neither once it answers in time', async () => {
    const count = new LookupCount();
    const dns = lookup();
    const waited = resolveWithin(dns.pending, undefined, 60_000, errors, count);
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 0 });
    dns.answer();
    assert.deepEqual(await waited, ANSWER);
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 });
  });

  it('is not given up when the resolver says the name does not exist: that is an answer', async () => {
    const count = new LookupCount();
    const dns = lookup();
    const waited = resolveWithin(dns.pending, undefined, 60_000, errors, count);
    dns.fail();
    await assert.rejects(waited, /ENOTFOUND/);
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 });
  });

  it('is given up at its bound, and stays in flight until the resolver answers it', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const count = new LookupCount();
    const dns = lookup();
    const waited = resolveWithin(dns.pending, undefined, 200, errors, count);
    t.mock.timers.tick(199);
    await drained();
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 0 }, 'not before its bound');
    t.mock.timers.tick(1);
    await assert.rejects(waited, /timed out/);
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 1 }, 'the check has gone; it has not');
    dns.answer();
    await drained();
    assert.deepEqual(
      count.stats(),
      { inFlight: 0, givenUp: 1 },
      'answered late, and still given up',
    );
  });

  it('is given up when the check is cancelled while it waits', async () => {
    const count = new LookupCount();
    const dns = lookup();
    const controller = new AbortController();
    const waited = resolveWithin(dns.pending, controller.signal, 60_000, errors, count);
    controller.abort();
    await assert.rejects(waited, /cancelled/);
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 1 });
    dns.fail();
    await drained();
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 1 }, 'a failure late is an answer too');
  });

  it('is given up at once for a check already cancelled, and is still in flight', async () => {
    // The caller asked the resolver before it looked at the signal: the lookup exists.
    const count = new LookupCount();
    const dns = lookup();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      resolveWithin(dns.pending, controller.signal, 60_000, errors, count),
      /cancelled/,
    );
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 1 });
    dns.answer();
    await drained();
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 1 });
  });

  it('counts each of many at once, however each settles', async () => {
    const count = new LookupCount();
    const controller = new AbortController();
    const answered = lookup();
    const cancelled = lookup();
    const abandoned = lookup();
    const one = resolveWithin(answered.pending, undefined, 60_000, errors, count);
    const two = resolveWithin(cancelled.pending, controller.signal, 60_000, errors, count);
    const three = resolveWithin(abandoned.pending, controller.signal, 60_000, errors, count);
    assert.deepEqual(count.stats(), { inFlight: 3, givenUp: 0 });
    answered.answer();
    await one;
    controller.abort();
    await assert.rejects(two);
    await assert.rejects(three);
    assert.deepEqual(count.stats(), { inFlight: 2, givenUp: 2 });
    cancelled.answer();
    await drained();
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 2 }, 'the one never answered is left');
  });

  it('is this thread’s count when nobody names another, which is what the package exports', () => {
    assert.equal(exported, nameLookups);
    assert.equal(ExportedCount, LookupCount);
  });
});

describe('the lookups a check makes through the shipped paths (A-66)', () => {
  const never: ResolveHost = () => new Promise(() => undefined);
  const answers: ResolveHost = () => Promise.resolve(ANSWER);

  /** What `nameLookups` moved by while `run` ran. Its own numbers belong to the whole file. */
  async function moved(
    run: () => Promise<unknown>,
  ): Promise<{ inFlight: number; givenUp: number }> {
    const before = nameLookups.stats();
    await run().catch(() => undefined);
    const after = nameLookups.stats();
    return { inFlight: after.inFlight - before.inFlight, givenUp: after.givenUp - before.givenUp };
  }

  const guard = (resolve: ResolveHost, host: string, timeoutMs = 400) =>
    checkedTarget({
      host,
      resolve,
      family: 4,
      timeoutMs,
      signal: new AbortController().signal,
      verb: 'query',
      doing: `querying ${host}:161 over SNMP`,
    });

  it('the target policy’s guard: a resolver that does not answer is given up at the bound', async () => {
    assert.deepEqual(await moved(() => guard(never, 'switch.example.test')), {
      inFlight: 1,
      givenUp: 1,
    });
  });

  it('the guard: a name that answers is neither, and an address is never asked', async () => {
    assert.deepEqual(await moved(() => guard(answers, 'switch.example.test')), {
      inFlight: 0,
      givenUp: 0,
    });
    let asked = 0;
    const counting: ResolveHost = (host, family) => {
      asked += 1;
      return answers(host, family);
    };
    assert.deepEqual(await moved(() => guard(counting, '10.20.0.9')), {
      inFlight: 0,
      givenUp: 0,
    });
    assert.equal(asked, 0);
  });

  it('the credential pin: a resolver that does not answer is given up at the bound', async () => {
    const pinned = moved(() =>
      pinTarget(
        {
          sensorId: 41,
          target: { host: 'switch.example.test', ipVersion: 'auto' },
          credentials: { snmp: { community: 'public', allowedTargets: ['10.20.0.0/16'] } },
          pinnedKinds: ['snmp'],
          timeoutMs: 400,
        },
        never,
      ),
    );
    assert.deepEqual(await pinned, { inFlight: 1, givenUp: 1 });
  });

  it('a check through the catalogue, which hands every type the resolver it was built with', async () => {
    const type: SensorType = {
      id: 'test.named',
      category: 'SNMP',
      costHint: 'light',
      declaresEveryChannel: true,
      paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
      channels: () => [{ key: 'value', name: 'Value', unit: '', isPrimary: true }],
      execute: async (context) => {
        await checkedTarget({
          host: context.target.host,
          ...(context.target.resolve === undefined ? {} : { resolve: context.target.resolve }),
          ...(context.target.policy === undefined ? {} : { policy: context.target.policy }),
          family: 4,
          timeoutMs: 400,
          signal: context.signal,
          verb: 'query',
          doing: 'querying',
        });
        return { channels: [{ key: 'value', value: 1 }] };
      },
    };
    const catalogue = new SensorCatalogue({ resolve: never, targetPolicy: 'link-local' })
      .register(type)
      .seal();
    const checked = moved(() =>
      catalogue.execute('test.named', {
        sensorId: 41,
        target: { host: 'switch.example.test', ipVersion: 'auto' },
        params: {},
        credentials: {},
        signal: new AbortController().signal,
      }),
    );
    assert.deepEqual(await checked, { inFlight: 1, givenUp: 1 });
  });
});

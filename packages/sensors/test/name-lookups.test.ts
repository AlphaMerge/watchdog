import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { SensorCatalogue } from '../src/catalogue.js';
import type { SensorType } from '../src/contract.js';
import {
  nameLookups as exported,
  LookupCount as ExportedCount,
  standardCatalogue,
} from '../src/index.js';
import { checkedTarget } from '../src/support/checked-target.js';
import {
  countedElsewhere,
  LookupCount,
  nameLookups,
  notAnswered,
  probeFailed,
  RESOLVER_BUSY,
  RESOLVER_FAULT,
  RESOLVER_FULL,
  RESOLVER_HELD,
  RESOLVER_LATE,
  RESOLVER_STUCK,
  RESOLVER_TOO_MANY,
  tooManyAddresses,
} from '../src/support/lookups.js';
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

describe('a lookup the probe’s resolver answers for (P-426)', () => {
  const failing =
    (code: string, message = `the probe’s resolver says ${code}`): ResolveHost =>
    () =>
      Promise.reject(Object.assign(new Error(message), { code }));

  /** What `nameLookups` moved by while `run` ran, and how `run` ended. */
  async function moved(
    run: () => Promise<unknown>,
  ): Promise<{ inFlight: number; givenUp: number; error: unknown }> {
    const before = nameLookups.stats();
    let error: unknown;
    await run().catch((caught: unknown) => {
      error = caught;
    });
    const after = nameLookups.stats();
    return {
      inFlight: after.inFlight - before.inFlight,
      givenUp: after.givenUp - before.givenUp,
      error,
    };
  }

  const guard = (resolve: ResolveHost) =>
    checkedTarget({
      host: 'switch.example.test',
      resolve,
      family: 4,
      timeoutMs: 4_000,
      signal: new AbortController().signal,
      verb: 'query',
      doing: 'querying switch.example.test:161 over SNMP',
    });

  const pin = (resolve: ResolveHost) =>
    pinTarget(
      {
        sensorId: 41,
        target: { host: 'switch.example.test', ipVersion: 'auto' },
        credentials: { snmp: { community: 'public', allowedTargets: ['10.20.0.0/16'] } },
        pinnedKinds: ['snmp'],
        timeoutMs: 4_000,
      },
      resolve,
    );

  it('is not counted where a check waits for it when the resolver counts it itself', async () => {
    const count = new LookupCount();
    const dns = lookup();
    const waited = resolveWithin(countedElsewhere(dns.pending), undefined, 60_000, errors, count);
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 }, 'the resolver’s to count');
    dns.answer();
    assert.deepEqual(await waited, ANSWER);
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 });
  });

  it('says which codes are the resolver not answering, and which the probe being busy', () => {
    for (const code of ['EAI_AGAIN', RESOLVER_HELD, RESOLVER_STUCK, RESOLVER_FULL]) {
      assert.equal(notAnswered(Object.assign(new Error(code), { code })), true, code);
      assert.equal(probeFailed(Object.assign(new Error(code), { code })), false, code);
    }
    for (const code of ['ENOTFOUND', 'ENODATA', RESOLVER_BUSY, RESOLVER_FAULT, RESOLVER_LATE]) {
      assert.equal(notAnswered(Object.assign(new Error(code), { code })), false, code);
    }
    for (const code of [RESOLVER_BUSY, RESOLVER_FAULT, RESOLVER_LATE]) {
      assert.equal(probeFailed(Object.assign(new Error(code), { code })), true, code);
    }
    assert.equal(probeFailed(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), false);
    assert.equal(notAnswered(new Error('no code')), false);
    assert.equal(notAnswered(undefined), false);
  });

  it('is given up, once, when the resolver says it did not answer, before the bound', async () => {
    const count = new LookupCount();
    const held = Object.assign(new Error('held'), { code: RESOLVER_HELD });
    const started = performance.now();
    await assert.rejects(
      resolveWithin(Promise.reject(held), undefined, 60_000, errors, count),
      /held/,
    );
    assert.ok(performance.now() - started < 1_000, 'at once, not at the bound');
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 1 });
  });

  it('the guard: a name the resolver holds fails at once naming the resolver, given up', async () => {
    for (const code of ['EAI_AGAIN', RESOLVER_HELD, RESOLVER_STUCK, RESOLVER_FULL]) {
      const { inFlight, givenUp, error } = await moved(() => guard(failing(code)));
      assert.deepEqual({ inFlight, givenUp }, { inFlight: 0, givenUp: 1 }, code);
      assert.match(
        (error as Error).message,
        /^the device’s host name did not resolve, querying switch\.example\.test:161 over SNMP — the probe’s resolver is not answering \(the probe’s resolver says /u,
        code,
      );
      assert.equal((error as { phase?: unknown }).phase, 'resolve', code);
    }
  });

  it('the guard: a main thread too busy to take the lookup is the probe, not DNS', async () => {
    const said =
      'the probe’s main thread did not take the lookup within 1000 ms (the probe is overloaded)';
    const { inFlight, givenUp, error } = await moved(() => guard(failing(RESOLVER_BUSY, said)));
    assert.deepEqual({ inFlight, givenUp }, { inFlight: 0, givenUp: 0 }, 'not given up');
    assert.equal(
      (error as Error).message,
      `the device’s host name could not be resolved, querying switch.example.test:161 over SNMP — ${said}`,
    );
    assert.doesNotMatch((error as Error).message, /resolver is not answering/u);
  });

  it('the guard: a name that does not exist is still said as one', async () => {
    const { givenUp, error } = await moved(() =>
      guard(failing('ENOTFOUND', 'getaddrinfo ENOTFOUND x')),
    );
    assert.equal(givenUp, 0);
    assert.doesNotMatch((error as Error).message, /resolver is not answering/u);
  });

  it('the credential pin: a held name is refused naming the resolver, not as no address', async () => {
    const { givenUp, error } = await moved(() => pin(failing(RESOLVER_HELD)));
    assert.equal(givenUp, 1);
    assert.match(
      (error as Error).message,
      /did not resolve \(the probe’s resolver says ERESOLVERHELD\)/u,
    );
    assert.match((error as Error).message, /The probe’s resolver is not answering/u);
    assert.doesNotMatch((error as Error).message, /did not resolve to any/u);
  });

  it('the credential pin: a busy main thread is refused as that, not given up', async () => {
    const { givenUp, error } = await moved(() =>
      pin(failing(RESOLVER_BUSY, 'the probe is overloaded')),
    );
    assert.equal(givenUp, 0);
    assert.match((error as Error).message, /could not be resolved \(the probe is overloaded\)/u);
    assert.doesNotMatch((error as Error).message, /resolver is not answering/u);
  });

  it('the guard and the pin: too many addresses is said in the resolver’s words, not as none', async () => {
    // `P-426`'s review: the resolver's message names the count, and every caller kept only the
    // code, saying the name did not resolve when it resolved to 65.
    const said =
      'switch.example.test resolved to 65 addresses, more than the 64 the probe uses for one name';
    const tooMany = failing(RESOLVER_TOO_MANY, said);
    assert.equal(
      tooManyAddresses(Object.assign(new Error(said), { code: RESOLVER_TOO_MANY })),
      true,
    );
    assert.equal(notAnswered(Object.assign(new Error(said), { code: RESOLVER_TOO_MANY })), false);

    const guarded = await moved(() => guard(tooMany));
    assert.equal(guarded.givenUp, 0, 'an answer: not given up');
    assert.equal(
      (guarded.error as Error).message,
      `the device’s host name could not be used, querying switch.example.test:161 over SNMP — ${said}`,
    );
    assert.equal((guarded.error as { phase?: unknown }).phase, 'resolve');
    // Ahead of a transport's own words for a name that did not resolve (port-tcp's, the database
    // redirect's), which would say the opposite.
    const own = await moved(() =>
      checkedTarget({
        host: 'switch.example.test',
        resolve: tooMany,
        timeoutMs: 4_000,
        signal: new AbortController().signal,
        verb: 'connect',
        doing: 'connecting to switch.example.test:22',
        unresolved: () => new Error('the device’s host name did not resolve'),
      }),
    );
    assert.match((own.error as Error).message, /resolved to 65 addresses, more than the 64/u);

    const pinned = await moved(() => pin(tooMany));
    assert.equal(pinned.givenUp, 0);
    assert.equal(
      (pinned.error as Error).message,
      `Not scanned: ${said}, so switch.example.test could not be checked against the allowed ` +
        'targets of the snmp credentials it would use, and they are not sent. Giving the device ' +
        'one of its addresses, or a name with fewer, sends them again.',
    );
    for (const { error } of [guarded, own, pinned]) {
      assert.doesNotMatch((error as Error).message, /did not resolve/u);
    }
  });

  it('asks with the bound the check will wait, so the resolver can forget it after', async () => {
    const asked: (number | undefined)[] = [];
    const answers: ResolveHost = (_host, _family, options) => {
      asked.push(options?.waitMs);
      return Promise.resolve(ANSWER);
    };
    await guard(answers);
    await pin(answers);
    assert.deepEqual(asked, [2_000, 2_000], 'half of four seconds, each');
  });

  it('is the resolver a standard catalogue is built with', async () => {
    let asked = 0;
    const counting: ResolveHost = () => {
      asked += 1;
      return Promise.resolve(ANSWER);
    };
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
          family: 4,
          timeoutMs: 400,
          signal: context.signal,
          verb: 'query',
          doing: 'querying',
        });
        return { channels: [{ key: 'value', value: 1 }] };
      },
    };
    const catalogue = standardCatalogue([type], { resolve: counting });
    await catalogue.execute('test.named', {
      sensorId: 41,
      target: { host: 'switch.example.test', ipVersion: 'auto' },
      params: {},
      credentials: {},
      signal: new AbortController().signal,
    });
    assert.equal(asked, 1);
  });
});

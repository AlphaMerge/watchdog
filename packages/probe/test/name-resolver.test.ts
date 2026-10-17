import { strict as assert } from 'node:assert';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import {
  RESOLVER_FAULT,
  RESOLVER_FULL,
  RESOLVER_HELD,
  RESOLVER_LATE,
  RESOLVER_STUCK,
  type ResolvedAddress,
} from '@ms/sensors';
import {
  ANSWER_MS,
  DENIAL_MS,
  domainOf,
  HOLD_MAX_MS,
  hostsNames,
  lookupLanes,
  MAX_ADDRESSES,
  MAX_ENTRIES,
  NameResolver,
  RESOLVER_LANES,
  resolverLanes,
  STALE_MS,
  STUCK_MS,
  threadpoolSize,
  WATCH_EVERY_MS,
  type Family,
  type NameResolverOptions,
} from '../src/resolver/name-resolver.js';
import { RESOLVE_FAULT, type ResolveAck, type ResolveReply } from '../src/resolver/protocol.js';
import { pollWithin, within } from './support/within.js';

/**
 * The probe's one resolver (`P-426`), with `getaddrinfo` replaced by lookups the test settles by
 * hand and a clock the test moves: what is kept and for how long, the holds, the lanes and their
 * classes, failing fast, "Check now", the hosts file, and a worker's request.
 *
 * The bound for stuck is a real timer, made short (`STUCK`), since it is what fails a waiting
 * check: everything else the resolver decides by the clock it is handed.
 */

const silent = pino({ level: 'silent' });
/** The test's bound for stuck: `STUCK_MS` is a second, and these tests wait for it. */
const STUCK = 40;

/** One `getaddrinfo` the resolver made, settled by the test. */
interface Call {
  readonly host: string;
  readonly family: Family;
  readonly answer: (addresses?: readonly ResolvedAddress[]) => void;
  readonly fail: (code: string) => void;
}

const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];
const B: readonly ResolvedAddress[] = [{ address: '192.0.2.11', family: 4 }];

/** A resolver over hand-settled lookups and a hand-moved clock. */
function make(options: Partial<NameResolverOptions> = {}) {
  const calls: Call[] = [];
  const clock = { now: 0 };
  const resolver = new NameResolver({
    logger: silent,
    lookup: (host, family) =>
      new Promise((resolve, reject) => {
        calls.push({
          host,
          family,
          answer: (addresses = A) => {
            resolve(addresses);
          },
          fail: (code) => {
            reject(Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code }));
          },
        });
      }),
    now: () => clock.now,
    // The middle of the jitter: every hold is exactly its step.
    random: () => 0.5,
    stuckMs: STUCK,
    watch: { files: [], everyMs: 60_000 },
    ...options,
  });
  /** The calls made for a name, oldest first. */
  const callsFor = (host: string): Call[] => calls.filter((call) => call.host === host);
  /** The last call made for a name. */
  const last = (host: string): Call => {
    const call = callsFor(host).at(-1);
    assert.ok(call !== undefined, `a lookup for ${host} was made`);
    return call;
  };
  const ask = (
    host: string,
    family: Family = 4,
    request: { waitMs?: number; fresh?: boolean } = {},
  ) => resolver.resolve(host, family, request);
  return { resolver, calls, callsFor, last, clock, ask };
}

/** Every reaction to a settled lookup has run. */
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Whether a promise has settled yet, without waiting for it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await settled();
  return done;
}

/** Waits past the bound for stuck, so every lookup running since before is stuck. */
const pastStuck = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, STUCK * 3);
  });

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('the probe’s resolver keeps answers (P-426)', () => {
  it('is built to the numbers decided: 30 s, 30 s, 5 min, 1 s, 64, 10,000 and 6 lanes', () => {
    assert.equal(ANSWER_MS, 30_000);
    assert.equal(DENIAL_MS, 30_000);
    assert.equal(STALE_MS, 300_000, 'the user’s decision of 2026-10-17: five minutes past expiry');
    assert.equal(STUCK_MS, 1_000);
    assert.equal(MAX_ADDRESSES, 64);
    assert.equal(MAX_ENTRIES, 10_000);
    assert.equal(RESOLVER_LANES, 6);
    assert.equal(WATCH_EVERY_MS, 5_000, 'a hosts edit is seen within five seconds');
    assert.equal(HOLD_MAX_MS, 60_000);
  });

  it('asks once for a name and keeps the answer 30 s', async () => {
    const { calls, ask, last, clock } = make();
    const first = ask('a.test');
    last('a.test').answer();
    assert.deepEqual(await first, A);
    clock.now = ANSWER_MS - 1;
    assert.deepEqual(await ask('a.test'), A);
    assert.equal(calls.length, 1, 'answered from what was kept');
  });

  it('asks once for many checks at once, and answers them all', async () => {
    const { calls, ask, last } = make();
    const waiting = [ask('a.test'), ask('a.test'), ask('A.Test')];
    assert.equal(calls.length, 1, 'one lookup in flight for the name, whatever its case');
    last('a.test').answer();
    for (const answer of await Promise.all(waiting)) assert.deepEqual(answer, A);
  });

  it('serves an expired answer at once while one refresh runs, then the refreshed one', async () => {
    const { calls, ask, last, clock } = make();
    const first = ask('a.test');
    last('a.test').answer(A);
    await first;
    clock.now = ANSWER_MS;
    assert.deepEqual(await ask('a.test'), A, 'expired, and served without waiting');
    assert.deepEqual(await ask('a.test'), A);
    assert.equal(calls.length, 2, 'and one refresh asked, not one a check');
    last('a.test').answer(B);
    await settled();
    assert.deepEqual(await ask('a.test'), B);
    assert.equal(calls.length, 2);
  });

  it('keeps a denial 30 s, and asks again after it', async () => {
    const { calls, ask, last, clock } = make();
    const first = ask('gone.test');
    last('gone.test').fail('ENOTFOUND');
    await assert.rejects(first, (error) => codeOf(error) === 'ENOTFOUND');
    clock.now = DENIAL_MS - 1;
    await assert.rejects(ask('gone.test'), (error) => codeOf(error) === 'ENOTFOUND');
    assert.equal(calls.length, 1);
    clock.now = DENIAL_MS;
    const again = ask('gone.test');
    assert.equal(calls.length, 2, 'asked again once the denial expired');
    last('gone.test').answer();
    assert.deepEqual(await again, A);
  });

  it('drops a kept answer when the refresh is a denial', async () => {
    const { ask, last, clock } = make();
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = ANSWER_MS;
    assert.deepEqual(await ask('a.test'), A);
    last('a.test').fail('ENOTFOUND');
    await settled();
    await assert.rejects(ask('a.test'), (error) => codeOf(error) === 'ENOTFOUND');
    // And once the denial has expired, the old answer is not served again: the name is asked.
    clock.now = ANSWER_MS + DENIAL_MS;
    const again = ask('a.test');
    assert.equal(await isSettled(again), false, 'waiting for a lookup, not served the old answer');
    last('a.test').answer(B);
    assert.deepEqual(await again, B);
  });

  it('asks getaddrinfo for the family asked, and keeps each apart: family 0 is one lookup', async () => {
    // A hosts-file override of a name DNS also has an AAAA for. getaddrinfo asked for either
    // family stops at the hosts file; asked for IPv6 alone it finds nothing there and asks DNS.
    // Family 0 put together from a lookup for each would carry DNS's AAAA beside the override.
    const override: readonly ResolvedAddress[] = [{ address: '10.0.0.5', family: 4 }];
    const dnsAaaa: readonly ResolvedAddress[] = [{ address: '2001:db8::5', family: 6 }];
    const { calls, ask, clock } = make({
      lookup: (host, family) => {
        calls.push({ host, family, answer: () => undefined, fail: () => undefined });
        return Promise.resolve(family === 6 ? dnsAaaa : override);
      },
    });
    assert.deepEqual(await ask('db.test', 0), override, 'the hosts file’s answer, and only it');
    assert.deepEqual(
      calls.map(({ family }) => family),
      [0],
      'one lookup, for family 0',
    );
    assert.deepEqual(await ask('db.test', 6), dnsAaaa);
    assert.deepEqual(await ask('db.test', 4), override);
    assert.deepEqual(
      calls.map(({ family }) => family),
      [0, 6, 4],
      'each family its own lookup',
    );
    clock.now = 1;
    assert.deepEqual(await ask('db.test', 0), override, 'and its own entry');
    assert.equal(calls.length, 3);
  });

  it('fails an answer of more than 64 addresses, naming the count, and keeps 64', async () => {
    const many = (n: number): ResolvedAddress[] =>
      Array.from({ length: n }, (_, i) => ({
        address: `10.0.${String(Math.floor(i / 250))}.${String((i % 250) + 1)}`,
        family: 4,
      }));
    const { ask, last } = make();
    const big = ask('big.test');
    last('big.test').answer(many(MAX_ADDRESSES + 1));
    await assert.rejects(big, (error: Error) => {
      assert.equal(codeOf(error), 'ETOOMANYADDRESSES');
      assert.match(error.message, /big\.test resolved to 65 addresses, more than the 64/u);
      return true;
    });
    const fits = ask('fits.test');
    last('fits.test').answer(many(MAX_ADDRESSES));
    assert.equal((await fits).length, MAX_ADDRESSES);
  });

  it('answers an address with itself, asking nothing', async () => {
    const { calls, ask } = make();
    assert.deepEqual(await ask('192.0.2.7', 0), [{ address: '192.0.2.7', family: 4 }]);
    assert.deepEqual(await ask('2001:db8::7', 0), [{ address: '2001:db8::7', family: 6 }]);
    assert.equal(calls.length, 0);
  });

  it('keeps the names most recently asked for, and a refresh answering does not make one recent', async () => {
    const { calls, ask, last, clock } = make({ maxEntries: 3 });
    for (const name of ['a.test', 'b.test', 'c.test']) {
      const asked = ask(name);
      last(name).answer();
      await asked;
    }
    clock.now = ANSWER_MS + 1;
    // a's refresh is asked first and answered last: the order the checks asked in is a, b, c.
    assert.deepEqual(await ask('a.test'), A);
    for (const name of ['b.test', 'c.test']) {
      assert.deepEqual(await ask(name), A);
      last(name).answer();
    }
    last('a.test').answer();
    await settled();
    const before = calls.length;
    const d = ask('d.test');
    last('d.test').answer();
    await d;
    // a went, as the least recently asked for: its refresh answering did not make it recent.
    assert.equal(await isSettled(ask('b.test')), true, 'b is kept, and answers at once');
    assert.equal(calls.length, before + 1, 'nothing asked for b');
    const a = ask('a.test');
    assert.equal(await isSettled(a), false, 'a was dropped, and is asked again');
    last('a.test').answer();
    await a;
  });
});

describe('a stale answer (P-426, decided 2026-10-17: at most 5 minutes past expiry)', () => {
  it('is served while the resolver does not answer, for 5 minutes past expiry and no longer', async () => {
    const { ask, last, clock, callsFor } = make();
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = ANSWER_MS;
    assert.deepEqual(await ask('a.test'), A, 'expired: served, and refreshed behind it');
    await pastStuck();
    assert.equal(callsFor('a.test').length, 2, 'one refresh, which does not answer');
    clock.now = ANSWER_MS + STALE_MS - 1;
    assert.deepEqual(await ask('a.test'), A, 'still served, within the grace');
    clock.now = ANSWER_MS + STALE_MS;
    await assert.rejects(ask('a.test'), (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_HELD);
      assert.match(error.message, /a lookup for a\.test has run \d+ s without an answer/u);
      return true;
    });
  });
});

describe('a name the resolver does not answer is held (P-426)', () => {
  it('serves its kept answer while held, and asks again only once the hold is over', async () => {
    const { ask, last, clock, callsFor } = make();
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = ANSWER_MS;
    assert.deepEqual(await ask('a.test'), A, 'expired: served, and refreshed behind it');
    last('a.test').fail('EAI_AGAIN');
    await settled();
    clock.now = ANSWER_MS + 5_000 - 1;
    assert.deepEqual(await ask('a.test'), A, 'held, and its kept answer served');
    assert.equal(callsFor('a.test').length, 2, 'not asked again while held');
    clock.now = ANSWER_MS + 5_000;
    assert.deepEqual(await ask('a.test'), A);
    assert.equal(callsFor('a.test').length, 3, 'asked again once the hold was over');
  });

  it('for 5 s after EAI_AGAIN, doubling to 60 s, failing checks at once, and asked again only when a check asks', async () => {
    const { ask, last, clock, callsFor } = make();
    const steps = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    let at = 0;
    for (const [n, step] of steps.entries()) {
      clock.now = at;
      const asked = ask('down.test');
      assert.equal(
        callsFor('down.test').length,
        n + 1,
        `asked once the hold of ${String(n)} ended`,
      );
      last('down.test').fail('EAI_AGAIN');
      await assert.rejects(asked, (error) => codeOf(error) === 'EAI_AGAIN');
      clock.now = at + step - 1;
      await assert.rejects(ask('down.test'), (error: Error) => {
        assert.equal(codeOf(error), RESOLVER_HELD);
        assert.match(
          error.message,
          /^down\.test is held for \d+ s more: getaddrinfo said EAI_AGAIN$/u,
        );
        return true;
      });
      assert.equal(
        callsFor('down.test').length,
        n + 1,
        `not asked while held for ${String(step)} ms`,
      );
      at += step;
    }
    // Nothing asks it again by itself once the hold is over.
    clock.now = at + HOLD_MAX_MS;
    await pastStuck();
    assert.equal(callsFor('down.test').length, steps.length, 'retried only when a check asks');
  });

  it('is moved by up to a fifth either way, so names held together are not asked together', async () => {
    for (const [random, expected] of [
      [0, 4_000],
      [0.999_999, 6_000],
    ] as const) {
      const { ask, last, clock, callsFor } = make({ random: () => random });
      const asked = ask('down.test');
      last('down.test').fail('EAI_AGAIN');
      await assert.rejects(asked);
      clock.now = expected - 1;
      await assert.rejects(ask('down.test'), (error) => codeOf(error) === RESOLVER_HELD);
      clock.now = expected;
      void ask('down.test').catch(() => undefined);
      assert.equal(callsFor('down.test').length, 2, `retried at ${String(expected)} ms`);
    }
  });

  it('when its lookup runs past the bound for stuck: new checks fail at once, and one already waiting keeps its bound', async () => {
    // `P-426`'s review: a resolver that answers in two seconds answered a check with ten, before
    // this resolver; failing it at the bound for stuck turned an answer into an outage.
    const { ask, last, callsFor } = make();
    const waiting = ask('slow.test', 4, { waitMs: 10_000 });
    await pastStuck();
    assert.equal(await isSettled(waiting), false, 'still waiting, past the bound for stuck');
    const started = performance.now();
    await assert.rejects(ask('slow.test'), (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_HELD);
      assert.match(error.message, /a lookup for slow\.test has run \d+ s without an answer/u);
      return true;
    });
    assert.ok(performance.now() - started < 20, 'a new check fails at once');
    assert.equal(callsFor('slow.test').length, 1, 'held: not asked again');
    // The lookup answers at last, inside the first check's bound: it is answered, and the name is
    // no longer held.
    last('slow.test').answer();
    assert.deepEqual(await within(1_000, 'the waiting check’s answer', waiting), A);
    assert.deepEqual(await ask('slow.test'), A);
  });

  it('when a lookup never answers, a check waiting for it ends at its own bound', async () => {
    const { ask } = make();
    const started = performance.now();
    await assert.rejects(
      within(2_000, 'the check’s bound', ask('silent.test', 4, { waitMs: 200 })),
      (error) => codeOf(error) === RESOLVER_LATE,
    );
    const took = performance.now() - started;
    assert.ok(took >= 200, `${took.toFixed(0)} ms: not at the bound for stuck`);
  });

  it('is let go by any answer: the next failure holds it for 5 s again', async () => {
    const { ask, last, clock, callsFor } = make();
    const one = ask('flaky.test');
    last('flaky.test').fail('EAI_AGAIN');
    await assert.rejects(one);
    clock.now = 5_000;
    const two = ask('flaky.test');
    last('flaky.test').fail('EAI_AGAIN');
    await assert.rejects(two);
    clock.now = 15_000;
    const three = ask('flaky.test');
    last('flaky.test').answer();
    assert.deepEqual(await three, A);
    // Long enough later that nothing of the answer is kept, so the next lookup is a check's.
    clock.now = 15_000 + ANSWER_MS + STALE_MS;
    const four = ask('flaky.test');
    last('flaky.test').fail('EAI_AGAIN');
    await assert.rejects(four);
    const failedAt = clock.now;
    clock.now = failedAt + 5_000 - 1;
    await assert.rejects(ask('flaky.test'), (error) => codeOf(error) === RESOLVER_HELD);
    clock.now = failedAt + 5_000;
    void ask('flaky.test').catch(() => undefined);
    assert.equal(callsFor('flaky.test').length, 5, 'held for the first step again, not the third');
  });
});

describe('the resolver’s lanes (P-426)', () => {
  it('runs 4 first lookups, keeps 1 lane for refreshes and 1 for a held name’s retry', async () => {
    // Nothing here runs long enough to be stuck: the lanes are the classes' alone.
    const { ask, last, clock, callsFor, resolver } = make({ stuckMs: 60_000 });
    // Two names answered and two held, before anything else runs.
    for (const name of ['r1.test', 'r2.test']) {
      const asked = ask(name);
      last(name).answer();
      await asked;
    }
    for (const name of ['h1.test', 'h2.test']) {
      const asked = ask(name);
      last(name).fail('EAI_AGAIN');
      await assert.rejects(asked);
    }
    const asked = (name: string): boolean => callsFor(name).length > 0;
    const runs = (name: string): number => callsFor(name).length;

    // Five names asked for the first time: four run, one waits.
    const firsts = ['f1', 'f2', 'f3', 'f4', 'f5'].map((name) => `${name}.test`);
    const waiting = firsts.map((name) => ask(name, 4, { waitMs: 60_000 }).catch(() => undefined));
    assert.deepEqual(firsts.map(asked), [true, true, true, true, false]);

    // A refresh takes the lane kept for refreshes; a second waits behind the five shared.
    clock.now = ANSWER_MS + 1;
    assert.deepEqual(await ask('r1.test'), A);
    assert.deepEqual(await ask('r2.test'), A);
    assert.equal(runs('r1.test'), 2, 'the refresh runs');
    assert.equal(runs('r2.test'), 1, 'the second refresh waits');

    // A held name's retry takes its own lane, though every shared one is taken; a second waits.
    const h1 = ask('h1.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const h2 = ask('h2.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    assert.equal(runs('h1.test'), 2, 'the retry runs');
    assert.equal(runs('h2.test'), 1, 'one retry at a time');
    assert.deepEqual(resolver.stats(), { running: 6, queued: 3, entries: 9 });

    // A refresh lane freed goes to the waiting refresh, never to the first lookup: f5 is held to
    // four.
    last('r1.test').answer();
    await settled();
    assert.equal(runs('r2.test'), 2);
    assert.equal(asked('f5.test'), false);
    // The retry lane freed goes to the next retry.
    last('h1.test').answer();
    await settled();
    assert.equal(runs('h2.test'), 2);
    // And a first lane freed to the waiting first lookup.
    last('f1.test').answer();
    await settled();
    assert.equal(asked('f5.test'), true);

    for (const name of [...firsts, 'r2.test', 'h2.test']) last(name).answer();
    await Promise.all([...waiting, h1, h2]);
    assert.deepEqual(resolver.stats(), { running: 0, queued: 0, entries: 9 });
  });

  it('fails a check at once when every lane its lookup could use is stuck; the lookup stays queued', async () => {
    const { ask, last, callsFor } = make();
    const stuck = ['s1', 's2', 's3', 's4'].map((name) => `${name}.test`);
    // Their own checks wait out their bound, as a check already waiting does.
    const held = stuck.map((name) => ask(name, 4, { waitMs: 60_000 }).catch(() => undefined));
    // Asked before the lanes were stuck: waits, and is failed the moment they are.
    const early = ask('early.test', 4, { waitMs: 60_000 });
    const failedEarly = assert.rejects(early, (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_STUCK);
      assert.match(
        error.message,
        /every lane a lookup for early\.test could use is held by a lookup that has run past 40 ms \(s1\.test, s2\.test, s3\.test\); it stays queued/u,
      );
      return true;
    });
    await pastStuck();
    await within(1_000, 'the waiting check to fail once the lanes were stuck', failedEarly);
    // Asked after: fails at once.
    const started = performance.now();
    await assert.rejects(
      within(
        1_000,
        'a check behind stuck lanes to fail at once',
        ask('late.test', 4, { waitMs: 60_000 }),
      ),
      (error) => codeOf(error) === RESOLVER_STUCK,
    );
    assert.ok(performance.now() - started < 20, 'at once');
    assert.equal(callsFor('early.test').length, 0, 'not run yet');
    // A lane comes back: the queued lookup runs, and its answer is kept for the next check.
    last('s1.test').answer();
    await settled();
    assert.equal(callsFor('early.test').length, 1, 'it stayed queued, and ran');
    last('early.test').answer();
    await settled();
    assert.deepEqual(await ask('early.test'), A);
    for (const name of stuck.slice(1)) last(name).answer();
    assert.deepEqual(await within(1_000, 'the stuck lanes’ own checks', Promise.all(held)), [
      A,
      A,
      A,
      A,
    ]);
  });

  it('keeps a shared lane for first lookups: refreshes take at most 4 of the 5', async () => {
    // `P-426`'s second review: a warm zone gone silent filled all five shared lanes with its first
    // refreshes, and every first lookup and "Check now" queued behind them failed at once.
    const { ask, last, clock, callsFor } = make({ stuckMs: 60_000 });
    const warm = ['w1', 'w2', 'w3', 'w4', 'w5'].map((name) => `${name}.zone-b.test`);
    for (const name of warm) {
      const asked = ask(name);
      last(name).answer();
      await asked;
    }
    clock.now = ANSWER_MS;
    for (const name of warm) assert.deepEqual(await ask(name), A, 'served, and refreshed behind');
    assert.deepEqual(
      warm.map((name) => callsFor(name).length),
      [2, 2, 2, 2, 1],
      'four refreshes run, and the fifth waits',
    );
    const first = ask('new.zone-a.test', 4, { waitMs: 60_000 });
    assert.equal(callsFor('new.zone-a.test').length, 1, 'a first lookup takes the fifth');
    last('new.zone-a.test').answer();
    assert.deepEqual(await first, A);
    assert.equal(callsFor('w5.zone-b.test').length, 1, 'which a refresh does not, freed');
    for (const name of warm.slice(0, 4)) last(name).answer();
    await settled();
    assert.equal(callsFor('w5.zone-b.test').length, 2, 'until a refresh lane comes back');
    last('w5.zone-b.test').answer();
  });

  it('fails a check at once behind every refresh lane stuck, though a first lookup’s lane is not', async () => {
    // A refresh queued while the refreshes hold all the lanes they may can only take one of
    // theirs: a first lookup's lane, running and not stuck, is not a lane it could get.
    const { ask, last, clock, callsFor } = make();
    const warm = ['r1', 'r2', 'r3', 'r4', 'late'].map((name) => `${name}.test`);
    for (const name of warm) {
      const asked = ask(name);
      last(name).answer();
      await asked;
    }
    clock.now = ANSWER_MS;
    for (const name of warm) await ask(name);
    assert.equal(callsFor('late.test').length, 1, 'late’s refresh queued behind the four');
    // late's kept answer is past its grace now, so a check of it waits for that refresh.
    clock.now = ANSWER_MS + STALE_MS;
    await pastStuck();
    const first = ask('first.test', 4, { waitMs: 60_000 });
    assert.equal(callsFor('first.test').length, 1, 'a first lookup runs, not yet stuck');
    const behind = ask('late.test', 4, { waitMs: 60_000 });
    assert.equal(await isSettled(behind), true, 'at once');
    await assert.rejects(behind, (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_STUCK);
      assert.match(error.message, /\(r1\.test, r2\.test, r3\.test\); it stays queued/u);
      return true;
    });
    last('first.test').answer();
    assert.deepEqual(await first, A);
    for (const name of warm.slice(0, 4)) last(name).answer();
    await settled();
    assert.equal(callsFor('late.test').length, 2, 'it stayed queued, and ran');
    last('late.test').answer();
  });

  it('refuses a lookup when its queue is full, naming the resolver', async () => {
    const { ask } = make({ lanes: 3, maxQueued: 1 });
    // Three lanes: one first, one shared kept for refreshes, one retry.
    void ask('one.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    void ask('two.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    await assert.rejects(ask('three.test', 4, { waitMs: 60_000 }), (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_FULL);
      assert.match(error.message, /already has 1 lookups queued, its most/u);
      return true;
    });
  });

  it('takes as many of libuv’s lanes as leave it 2, from 3 to 6', () => {
    assert.equal(threadpoolSize(undefined), 4, 'libuv’s default');
    assert.equal(threadpoolSize('16'), 16);
    assert.equal(threadpoolSize('0'), 1);
    assert.equal(threadpoolSize('nonsense'), 1);
    assert.equal(threadpoolSize('5000'), 1_024);
    assert.equal(lookupLanes(16), 8);
    assert.equal(lookupLanes(4), 2);
    assert.equal(resolverLanes(lookupLanes(16)), 6, 'UV_THREADPOOL_SIZE 16: 6 of 8');
    assert.equal(resolverLanes(lookupLanes(64)), 6, 'never more than 6');
    assert.equal(resolverLanes(lookupLanes(12)), 4);
    assert.equal(resolverLanes(lookupLanes(4)), 3, 'never fewer than its classes need');
  });
});

describe('which queued lookup a lane takes (P-426’s review)', () => {
  it('reads a name’s domain as the name less its first label', () => {
    assert.equal(domainOf('dev-4.Zone-B.example.'), 'zone-b.example');
    assert.equal(domainOf('switch'), '', 'one label: the search list’s');
  });

  it('retries a name of a domain that answers, held once, before a silent domain’s held names', async () => {
    // A silent zone keeps about one retry queued a name, each holding the one retry lane for
    // getaddrinfo's whole timeout. Served in arrival order, an answering zone's name held once by
    // a passing EAI_AGAIN waited behind every one: 25 minutes at 50 names and 30 s.
    const { ask, last, clock, callsFor } = make({ stuckMs: 60_000 });
    const answered = async (name: string): Promise<void> => {
      const asked = ask(name);
      last(name).answer();
      await asked;
    };
    const fails = async (name: string): Promise<void> => {
      const asked = ask(name);
      last(name).fail('EAI_AGAIN');
      await assert.rejects(asked);
    };
    const zoneB = ['b1', 'b2', 'b3', 'b4', 'b5'].map((n) => `${n}.zone-b.test`);
    const zoneA = ['a1', 'a2', 'a3', 'a4', 'a5'].map((n) => `${n}.zone-a.test`);
    for (const name of zoneA) await answered(name);
    for (const name of zoneB) await fails(name);
    // a1 held once by a passing failure of its refresh.
    clock.now = ANSWER_MS;
    assert.deepEqual(await ask('a1.zone-a.test'), A, 'expired: served, and refreshed');
    last('a1.zone-a.test').fail('EAI_AGAIN');
    await settled();

    // Every hold over: b1's retry takes the retry lane, b2..b5's queue, then a1's, last.
    clock.now = ANSWER_MS + 10_000;
    const waiting = zoneB.map((name) => ask(name, 4, { waitMs: 60_000 }).catch(() => undefined));
    assert.deepEqual(await ask('a1.zone-a.test'), A, 'its kept answer, and its retry queued');
    assert.equal(callsFor('a1.zone-a.test').length, 2, 'queued, behind the lane');
    // The retry lane comes back: a1 is next, not b2.
    last('b1.zone-b.test').fail('EAI_AGAIN');
    await settled();
    assert.equal(callsFor('a1.zone-a.test').length, 3, 'a1 retried next');
    assert.equal(callsFor('b2.zone-b.test').length, 1, 'b2 still waiting');
    last('a1.zone-a.test').answer();
    await settled();
    assert.equal(callsFor('b2.zone-b.test').length, 2, 'then the silent zone, in its order');
    for (const name of zoneB.slice(1)) {
      last(name).fail('EAI_AGAIN');
      await settled();
    }
    await Promise.all(waiting);
  });

  it('among one domain’s held names, retries the one with fewer failures in a row first', async () => {
    const { ask, last, clock, callsFor } = make({ stuckMs: 60_000 });
    const fails = async (name: string): Promise<void> => {
      const asked = ask(name, 4, { waitMs: 60_000 });
      last(name).fail('EAI_AGAIN');
      await assert.rejects(asked);
    };
    // b1 has failed twice in a row, b2 once.
    await fails('b1.zone-b.test');
    clock.now = 10_000;
    await fails('b1.zone-b.test');
    await fails('b2.zone-b.test');
    clock.now = 100_000;
    void ask('b0.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    last('b0.zone-b.test').fail('EAI_AGAIN');
    await settled();
    // b0's retry holds the lane; b1's is queued before b2's.
    clock.now = 200_000;
    void ask('b0.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const b1 = ask('b1.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const b2 = ask('b2.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    last('b0.zone-b.test').fail('EAI_AGAIN');
    await settled();
    assert.equal(callsFor('b2.zone-b.test').length, 2, 'b2, failed once, first');
    assert.equal(callsFor('b1.zone-b.test').length, 2, 'b1 not yet');
    last('b2.zone-b.test').answer();
    await settled();
    assert.equal(callsFor('b1.zone-b.test').length, 3);
    last('b1.zone-b.test').answer();
    await Promise.all([b1, b2]);
  });

  it('refreshes a domain that answers before a domain with names failing', async () => {
    // A zone silent once warm: its names' first refreshes took the shared lanes for getaddrinfo's
    // timeout each, and an answering zone's refreshes waited behind them in arrival order until
    // their kept answers were past the grace.
    // Four lanes: three shared, at most two refreshes and two first lookups, and one retry.
    const { ask, last, clock, callsFor } = make({ lanes: 4, stuckMs: 60_000 });
    for (const name of ['b1', 'b2', 'b3', 'b4']
      .map((n) => `${n}.zone-b.test`)
      .concat('a1.zone-a.test')) {
      const asked = ask(name);
      last(name).answer();
      await asked;
    }
    // b4 failing, so the domain is.
    clock.now = ANSWER_MS;
    void ask('b4.zone-b.test');
    last('b4.zone-b.test').fail('EAI_AGAIN');
    await settled();
    // b1 and b2 take the two lanes refreshes may; b3, then a1, queue.
    for (const name of ['b1', 'b2', 'b3'].map((n) => `${n}.zone-b.test`)) {
      assert.deepEqual(await ask(name), A);
    }
    assert.deepEqual(await ask('a1.zone-a.test'), A);
    assert.equal(callsFor('b3.zone-b.test').length, 1, 'b3 queued');
    assert.equal(callsFor('a1.zone-a.test').length, 1, 'a1 queued');
    last('b1.zone-b.test').fail('EAI_AGAIN');
    await settled();
    assert.equal(callsFor('a1.zone-a.test').length, 2, 'a1 refreshed first');
    assert.equal(callsFor('b3.zone-b.test').length, 1);
    last('a1.zone-a.test').answer();
    await settled();
    assert.equal(callsFor('b3.zone-b.test').length, 2, 'then b3');
    last('b2.zone-b.test').answer();
    last('b3.zone-b.test').answer();
  });

  /** A name answered at once, and kept. */
  const answering = (made: ReturnType<typeof make>) => async (name: string) => {
    const asked = made.ask(name);
    made.last(name).answer();
    await asked;
  };
  /** A kept name asked again past its expiry: served, and its refresh (or retry) settled so. */
  const refreshing =
    (made: ReturnType<typeof make>, settle: 'answer' | 'fail') => async (name: string) => {
      assert.deepEqual(await made.ask(name), A);
      if (settle === 'answer') made.last(name).answer();
      else made.last(name).fail('EAI_AGAIN');
      await settled();
    };

  it('retries a name held once in a domain of its own before a large domain’s few failing names', async () => {
    // `P-426`'s second review: counted with its own failure, a one-name domain held once scored a
    // half, and a 200-name silent zone ranked ahead of it until 101 of its names had failed,
    // past the grace.
    const made = make({ stuckMs: 60_000 });
    const { ask, last, clock, callsFor } = made;
    const zone = Array.from({ length: 20 }, (_, i) => `b${String(i + 1)}.zone-b.test`);
    for (const name of [...zone, 'www.vendor.test']) await answering(made)(name);
    // b1, b2 and b3 of the twenty, and the vendor's one name, each held once by a refresh.
    const held = [...zone.slice(0, 3), 'www.vendor.test'];
    clock.now = ANSWER_MS;
    for (const name of held) await refreshing(made, 'fail')(name);
    // Every hold over: b1's retry takes the lane; b2's, b3's and then the vendor's queue.
    clock.now = ANSWER_MS + 10_000;
    for (const name of held) assert.deepEqual(await ask(name), A);
    assert.equal(callsFor('b1.zone-b.test').length, 3, 'b1 retried');
    assert.equal(callsFor('www.vendor.test').length, 2, 'the vendor’s retry queued, last');
    last('b1.zone-b.test').fail('EAI_AGAIN');
    await settled();
    assert.equal(callsFor('www.vendor.test').length, 3, 'the vendor’s next: no failing zone');
    assert.equal(callsFor('b2.zone-b.test').length, 2, 'b2 still queued');
    last('www.vendor.test').answer();
    await settled();
    assert.equal(callsFor('b2.zone-b.test').length, 3, 'then the twenty’s');
    last('b2.zone-b.test').answer();
    await settled();
    last('b3.zone-b.test').answer();
  });

  it('among one domain’s names held as often, retries the one that answered lately before those that never did', async () => {
    // Names of one domain, or of one label under a search list, tie on their domain's share: in
    // arrival order, a name held once by a passing failure waited behind every silent name's
    // retry queued before it (`P-426`'s second review).
    const made = make({ stuckMs: 60_000 });
    const { ask, last, clock, callsFor } = made;
    const silentNames = ['s0', 's1', 's2', 's3'];
    for (const name of silentNames) {
      const asked = ask(name, 4, { waitMs: 60_000 });
      last(name).fail('EAI_AGAIN');
      await assert.rejects(asked);
    }
    await answering(made)('v');
    clock.now = ANSWER_MS;
    await refreshing(made, 'fail')('v');
    // Every hold over: s0's retry takes the lane; s1's, s2's and s3's queue before v's.
    clock.now = ANSWER_MS + 10_000;
    const waiting = silentNames.map((name) =>
      ask(name, 4, { waitMs: 60_000 }).catch(() => undefined),
    );
    assert.deepEqual(await ask('v'), A, 'its kept answer, and its retry queued');
    assert.equal(callsFor('v').length, 2);
    last('s0').fail('EAI_AGAIN');
    await settled();
    assert.equal(callsFor('v').length, 3, 'v next: it answered lately');
    assert.equal(callsFor('s1').length, 1, 's1 still queued');
    last('v').answer();
    await settled();
    assert.equal(callsFor('s1').length, 2, 'then the silent names, in their order');
    for (const name of silentNames.slice(1)) {
      last(name).fail('EAI_AGAIN');
      await settled();
    }
    await Promise.all(waiting);
  });

  it('keeps that order once the name’s kept answer has run out', async () => {
    // What it answered is dropped past the grace, which is when its sensors fail: the order holds
    // by when it last answered, which is kept.
    const made = make({ stuckMs: 60_000 });
    const { ask, last, clock, callsFor } = made;
    await answering(made)('v');
    clock.now = ANSWER_MS;
    await refreshing(made, 'fail')('v');
    // Long past v's grace, the silent names fail their first lookups.
    clock.now = 390_000;
    const silentNames = ['s0', 's1', 's2', 's3'];
    for (const name of silentNames) {
      const asked = ask(name, 4, { waitMs: 60_000 });
      last(name).fail('EAI_AGAIN');
      await assert.rejects(asked);
    }
    clock.now = 400_000;
    const waiting = [...silentNames, 'v'].map((name) =>
      ask(name, 4, { waitMs: 60_000 }).catch(() => undefined),
    );
    assert.equal(callsFor('v').length, 2, 'v’s retry queued last, with nothing kept for it');
    last('s0').fail('EAI_AGAIN');
    await settled();
    assert.equal(callsFor('v').length, 3, 'v next: it answered, if long ago');
    last('v').answer();
    await settled();
    for (const name of silentNames.slice(1)) {
      last(name).fail('EAI_AGAIN');
      await settled();
    }
    await Promise.all(waiting);
  });

  it('stops counting a failing name no check asks about against its domain, and counts it again when one does', async () => {
    // `P-426`'s second review: a dead zone's deleted devices kept their domain failing for good,
    // so a device added there later always ranked last. Three lanes: one refresh at a time.
    const made = make({ lanes: 3, stuckMs: 60_000 });
    const { ask, last, clock, callsFor } = made;
    const b = ['b1', 'b2'].map((name) => `${name}.zone-b.test`);
    const c = ['c1', 'c2', 'c3'].map((name) => `${name}.zone-c.test`);
    for (const name of [...b, ...c, 'x.zone-x.test']) await answering(made)(name);
    // b1 and c1 fail at 30 s. b1 is never asked about again; c1 is, at 300 s.
    clock.now = ANSWER_MS;
    await refreshing(made, 'fail')('b1.zone-b.test');
    await refreshing(made, 'fail')('c1.zone-c.test');
    clock.now = 300_000;
    for (const name of ['b2.zone-b.test', 'c2.zone-c.test', 'c3.zone-c.test', 'x.zone-x.test']) {
      await refreshing(made, 'answer')(name);
    }
    await refreshing(made, 'fail')('c1.zone-c.test');

    /** x's refresh holds the one refresh lane while the two given queue, in that order. */
    const nextOf = async (queued: readonly string[]): Promise<string | undefined> => {
      assert.deepEqual(await ask('x.zone-x.test'), A);
      const before = queued.map((name) => callsFor(name).length);
      for (const name of queued) assert.deepEqual(await ask(name), A);
      assert.deepEqual(
        queued.map((name) => callsFor(name).length),
        before,
        'queued behind x’s refresh',
      );
      last('x.zone-x.test').answer();
      await settled();
      const taken = queued.find((name, i) => callsFor(name).length > (before[i] ?? 0));
      for (const name of queued) {
        if (name !== taken) continue;
        last(name).answer();
        await settled();
      }
      for (const name of queued) {
        if (name === taken) continue;
        last(name).answer();
        await settled();
      }
      return taken;
    };

    // b1 not asked about for 400 s: zone B no longer counts it, so b2's refresh, at a share of
    // none, goes before c2's at a third, though queued after it.
    clock.now = 430_000;
    assert.equal(await nextOf(['c2.zone-c.test', 'b2.zone-b.test']), 'b2.zone-b.test');
    // b1 asked about again: zone B counts it, half its names failing, and c2 goes first, though
    // queued after b2.
    clock.now = 460_000;
    void ask('b1.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    assert.equal(callsFor('b1.zone-b.test').length, 3, 'its retry runs');
    assert.equal(await nextOf(['b2.zone-b.test', 'c2.zone-c.test']), 'c2.zone-c.test');
    last('b1.zone-b.test').answer();
  });
});

describe('a failure that says nothing about the name (P-426’s review)', () => {
  it('keeps nothing of it: the kept answer is still served, and the next check asks again', async () => {
    // EMFILE, an fd spike, kept as a 30 s denial, dropped the kept answer and failed every check
    // of the name for 30 s after the spike had passed.
    const { ask, last, clock, callsFor } = make();
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = ANSWER_MS;
    assert.deepEqual(await ask('a.test'), A, 'expired: served, and refreshed');
    last('a.test').fail('EMFILE');
    await settled();
    clock.now = ANSWER_MS + 1;
    assert.deepEqual(await ask('a.test'), A, 'still served');
    assert.equal(callsFor('a.test').length, 3, 'and asked again, not denied');
    last('a.test').answer(B);
    await settled();
    assert.deepEqual(await ask('a.test'), B);
  });

  it('fails the check waiting with it, names it, and is asked again at the next check', async () => {
    const { ask, last, callsFor } = make();
    const first = ask('new.test');
    last('new.test').fail('EAI_MEMORY');
    await assert.rejects(first, (error) => codeOf(error) === 'EAI_MEMORY');
    const again = ask('new.test');
    assert.equal(callsFor('new.test').length, 2, 'not denied');
    last('new.test').fail('ENODATA');
    await assert.rejects(again, (error) => codeOf(error) === 'ENODATA');
    await assert.rejects(ask('new.test'), (error) => codeOf(error) === 'ENODATA');
    assert.equal(callsFor('new.test').length, 2, 'ENODATA is an answer: kept');
  });
});

describe('“Check now” (P-426)', () => {
  it('asks the resolver, not what is kept, once for any number at once', async () => {
    const { ask, last, callsFor, clock } = make();
    const first = ask('a.test');
    last('a.test').answer(A);
    await first;
    clock.now = 1;
    const now = [ask('a.test', 4, { fresh: true }), ask('a.test', 4, { fresh: true })];
    assert.equal(callsFor('a.test').length, 2, 'asked again, once');
    assert.deepEqual(await ask('a.test'), A, 'a scan is still answered from what was kept');
    last('a.test').answer(B);
    for (const answer of await Promise.all(now)) assert.deepEqual(answer, B);
  });

  it('uses the kept answer only when the resolver does not answer, and says so', async () => {
    const { resolver, last, clock } = make();
    const posted: (ResolveAck | ResolveReply)[] = [];
    const first = resolver.resolve('a.test', 4, {});
    last('a.test').answer();
    await first;
    clock.now = 12_000;
    resolver.handle(
      { type: 'resolve', id: 7, host: 'a.test', family: 4, waitMs: 5_000, fresh: true },
      (message) => posted.push(message),
    );
    await pollWithin(2_000, 'the reply', () => posted.length === 2);
    assert.deepEqual(posted[0], { type: 'resolve-ack', id: 7 });
    const reply = posted[1];
    assert.ok(reply?.type === 'resolved' && reply.ok, JSON.stringify(reply));
    assert.deepEqual(reply.addresses, A);
    assert.match(
      reply.note ?? '',
      /^the probe’s resolver did not answer for a\.test \(a lookup for a\.test has run 0 s without an answer\), so this check used the address it answered 12 s ago$/u,
    );
  });

  it('waits its bound, as a scan would, when there is no kept answer to use', async () => {
    const { resolver } = make();
    const started = performance.now();
    await assert.rejects(
      within(2_000, 'the bound', resolver.resolve('new.test', 4, { fresh: true, waitMs: 150 })),
      (error) => codeOf(error) === RESOLVER_LATE,
    );
    assert.ok(performance.now() - started >= 150, 'at its bound, not the bound for stuck');
    await assert.rejects(
      resolver.resolve('new.test', 4, {}),
      (error) => codeOf(error) === RESOLVER_HELD,
    );
  });

  /** "Check now" for a name, through a worker's request, and its reply. */
  async function checkNow(
    resolver: NameResolver,
    host: string,
    waitMs: number,
  ): Promise<ResolveReply> {
    const posted: (ResolveAck | ResolveReply)[] = [];
    resolver.handle({ type: 'resolve', id: 9, host, family: 4, waitMs, fresh: true }, (message) =>
      posted.push(message),
    );
    await pollWithin(waitMs + 1_000, 'the reply', () =>
      posted.some(({ type }) => type === 'resolved'),
    );
    const reply = posted.find((message): message is ResolveReply => message.type === 'resolved');
    assert.ok(reply !== undefined);
    return reply;
  }

  it('gets the kept answer, saying so, when the queue is full', async () => {
    // Three lanes: one first, one shared kept for refreshes, one retry; one lookup queued at most.
    const { resolver, ask, last, clock } = make({ lanes: 3, maxQueued: 1, stuckMs: 60_000 });
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = 10_000;
    void ask('one.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    void ask('two.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    await assert.rejects(
      ask('three.test', 4, { waitMs: 60_000 }),
      (error) => codeOf(error) === RESOLVER_FULL,
    );
    const reply = await checkNow(resolver, 'a.test', 5_000);
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.deepEqual(reply.addresses, A, 'the kept answer, not a refusal');
    assert.match(
      reply.note ?? '',
      /^the probe’s resolver did not answer for a\.test \(the probe’s resolver already has 1 lookups queued, its most\), so this check used the address it answered 10 s ago$/u,
    );
  });

  it('gets the kept answer before its bound behind lanes busy but not stuck', async () => {
    const { resolver, ask, last, clock } = make({ lanes: 3, stuckMs: 60_000 });
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = 3_000;
    // The one first lane, busy with a lookup that is slow but not stuck.
    void ask('busy.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const started = performance.now();
    const reply = await checkNow(resolver, 'a.test', 400);
    assert.ok(performance.now() - started < 400, 'inside its bound, with time for the reply');
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.deepEqual(reply.addresses, A);
    assert.match(
      reply.note ?? '',
      /^the probe’s resolver did not answer for a\.test \(a lookup for a\.test had not been answered within 300 ms\), so this check used the address it answered 3 s ago$/u,
    );
    last('busy.test').answer();
  });

  it('with a short bound, still asks for most of it before using the kept answer', async () => {
    // `P-426`'s second review: the kept answer came 250 ms before the bound, so with a bound of
    // 250 ms or less "Check now" used it at once, "within 0 ms", in effect asking nothing.
    const { resolver, ask, last, clock } = make({ lanes: 3, stuckMs: 60_000 });
    const first = ask('a.test');
    last('a.test').answer();
    await first;
    clock.now = 3_000;
    void ask('busy.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const started = performance.now();
    const reply = await checkNow(resolver, 'a.test', 200);
    assert.ok(performance.now() - started >= 100, 'after most of its bound');
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.match(reply.note ?? '', /\(a lookup for a\.test had not been answered within 150 ms\)/u);
    last('busy.test').answer();
  });

  it('is taken ahead of the lookups queued before it', async () => {
    // Three lanes: one first lookup at a time.
    const { ask, last, callsFor } = make({ lanes: 3, stuckMs: 60_000 });
    void ask('busy.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const queued = ask('queued.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    const now = ask('now.test', 4, { fresh: true, waitMs: 60_000 });
    assert.equal(callsFor('now.test').length, 0, 'behind the lane, as everything is');
    last('busy.test').answer();
    await settled();
    assert.equal(callsFor('now.test').length, 1, '"Check now" first');
    assert.equal(callsFor('queued.test').length, 0);
    last('now.test').answer();
    assert.deepEqual(await now, A);
    last('queued.test').answer();
    await queued;
  });

  it('is not queued behind held names’ retries: it takes a first lookup’s lane, ahead of the queue', async () => {
    // `P-426`'s review: on the one retry lane, "Check now" on a held name waited behind every
    // silent name's retry, and the operator could not see a fix take.
    const { ask, last, clock, callsFor } = make({ stuckMs: 60_000 });
    const fails = async (name: string): Promise<void> => {
      const asked = ask(name);
      last(name).fail('EAI_AGAIN');
      await assert.rejects(asked);
    };
    await fails('b1.zone-b.test');
    await fails('b2.zone-b.test');
    clock.now = 10_000;
    // b3 held now; b1's and b2's holds are over.
    await fails('b3.zone-b.test');
    // b1's retry holds the retry lane; b2's waits for it.
    void ask('b1.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    void ask('b2.zone-b.test', 4, { waitMs: 60_000 }).catch(() => undefined);
    assert.equal(callsFor('b1.zone-b.test').length, 2);
    assert.equal(callsFor('b2.zone-b.test').length, 1, 'queued for the retry lane');
    // "Check now" on b3, held and with nothing queued: asked at once.
    const b3 = ask('b3.zone-b.test', 4, { fresh: true, waitMs: 5_000 });
    assert.equal(callsFor('b3.zone-b.test').length, 2, 'asked at once, not behind b2');
    last('b3.zone-b.test').answer();
    assert.deepEqual(await b3, A);
    // And on b2, whose retry is queued: that retry is moved ahead, onto a first lookup's lane.
    const b2 = ask('b2.zone-b.test', 4, { fresh: true, waitMs: 5_000 });
    assert.equal(callsFor('b2.zone-b.test').length, 2, 'its queued retry run at once');
    last('b2.zone-b.test').answer();
    assert.deepEqual(await b2, A);
    last('b1.zone-b.test').answer();
  });

  it('asks a held name again, where a scan is failed at once', async () => {
    const { ask, last, clock, callsFor } = make();
    const first = ask('down.test');
    last('down.test').fail('EAI_AGAIN');
    await assert.rejects(first);
    clock.now = 1_000;
    await assert.rejects(ask('down.test'), (error) => codeOf(error) === RESOLVER_HELD);
    assert.equal(callsFor('down.test').length, 1);
    const now = ask('down.test', 4, { fresh: true });
    assert.equal(callsFor('down.test').length, 2, 'the DNS fix is asked about');
    last('down.test').answer();
    assert.deepEqual(await now, A);
  });
});

describe('the hosts file and resolv.conf (P-426)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-resolver-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  let made = 0;
  /** A hosts file and a resolv.conf of the test's own, and a resolver watching them. */
  function watched(options: Partial<NameResolverOptions> = {}) {
    made += 1;
    const hosts = join(dir, String(made), 'hosts');
    const resolvConf = join(dir, String(made), 'resolv.conf');
    mkdirSync(join(dir, String(made)));
    writeFileSync(hosts, '127.0.0.1 localhost\n');
    writeFileSync(resolvConf, 'nameserver 192.0.2.53\n');
    const made_ = make({ watch: { files: [hosts, resolvConf], everyMs: 60_000 }, ...options });
    return { ...made_, hosts, resolvConf };
  }

  it('reads a hosts file as getaddrinfo does: each name with its addresses, comments left out', () => {
    assert.deepEqual(
      [
        ...hostsNames(
          '127.0.0.1 localhost # the loopback\n' +
            '# 10.0.0.9 commented.test\n' +
            '10.0.0.5\tA.test a-alias.test.\n' +
            'not-an-address b.test\n' +
            '2001:db8::5 a.test\n',
        ),
      ],
      [
        ['localhost', '127.0.0.1'],
        ['a.test', '10.0.0.5 2001:db8::5'],
        ['a-alias.test', '10.0.0.5'],
      ],
    );
  });

  it('drops only the names a hosts edit moves, and nothing for a rewrite with the same contents', async () => {
    // `P-426`'s review: dropping every answer and hold on an edit, the usual fix in the middle of
    // a zone's outage, failed the zones that still answer while the silent zone held the lanes.
    const { resolver, ask, last, callsFor, hosts } = watched();
    assert.equal(await resolver.checkFiles(), false, 'the first look is the baseline');
    for (const name of ['a.test', 'b.test']) {
      const asked = ask(name);
      last(name).answer();
      await asked;
    }
    const held = ask('down.test');
    last('down.test').fail('EAI_AGAIN');
    await assert.rejects(held);

    // Written again as it was, as a DHCP client or a configuration tool does: nothing moves.
    writeFileSync(hosts, readFileSync(hosts, 'utf8'));
    assert.equal(await resolver.checkFiles(), false, 'the same contents: no change');
    assert.equal(resolver.stats().entries, 3);

    appendFileSync(hosts, '10.0.0.5 a.test\n');
    assert.equal(await resolver.checkFiles(), true);
    const again = ask('a.test');
    assert.equal(callsFor('a.test').length, 2, 'the name the edit gives is asked again');
    last('a.test').answer(B);
    assert.deepEqual(await again, B);
    assert.deepEqual(await ask('b.test'), A, 'another name keeps its answer');
    assert.equal(callsFor('b.test').length, 1);
    await assert.rejects(ask('down.test'), (error) => codeOf(error) === RESOLVER_HELD);
    assert.equal(callsFor('down.test').length, 1, 'and another its hold');

    // A line taken out moves its name too.
    writeFileSync(hosts, '127.0.0.1 localhost\n');
    assert.equal(await resolver.checkFiles(), true);
    void ask('a.test').catch(() => undefined);
    assert.equal(callsFor('a.test').length, 3);
  });

  it('on a resolv.conf change asks every kept answer again, serving it meanwhile, and lets holds and denials go', async () => {
    const { resolver, ask, last, clock, callsFor, resolvConf } = watched();
    await resolver.checkFiles();
    const kept = ask('a.test');
    last('a.test').answer();
    await kept;
    const gone = ask('gone.test');
    last('gone.test').fail('ENOTFOUND');
    await assert.rejects(gone);
    const held = ask('down.test');
    last('down.test').fail('EAI_AGAIN');
    await assert.rejects(held);
    // A lookup under way when the configuration changes.
    const under = ask('c.test');

    clock.now = 1_000;
    writeFileSync(resolvConf, 'nameserver 192.0.2.54\n');
    assert.equal(await resolver.checkFiles(), true);
    assert.deepEqual(await ask('a.test'), A, 'its kept answer served at once');
    assert.equal(callsFor('a.test').length, 2, 'and asked again under the new configuration');
    void ask('gone.test').catch(() => undefined);
    assert.equal(callsFor('gone.test').length, 2, 'the denial let go');
    const retried = ask('down.test');
    assert.equal(callsFor('down.test').length, 2, 'the hold let go');
    // Its failures in a row are kept: failing again, it is held for the second step, 10 s.
    last('down.test').fail('EAI_AGAIN');
    await assert.rejects(retried);
    clock.now = 1_000 + 10_000 - 1;
    await assert.rejects(ask('down.test'), (error) => codeOf(error) === RESOLVER_HELD);

    // The lookup under way no longer stands for its name: a check now asks under the new, and
    // the old one's answer, arriving last, goes to its own check and is not kept over the new.
    const after = ask('c.test');
    assert.equal(callsFor('c.test').length, 2);
    callsFor('c.test')[1]?.answer(B);
    assert.deepEqual(await after, B);
    callsFor('c.test')[0]?.answer(A);
    assert.deepEqual(await under, A, 'its own check is answered');
    assert.deepEqual(await ask('c.test'), B, 'and the new answer is the one kept');
    assert.equal(callsFor('c.test').length, 2, 'kept as fresh: nothing asked');
    // With nothing kept, an old configuration's answer is kept, but as due: served, and asked
    // again under the new one.
    const lone = ask('d.test');
    writeFileSync(resolvConf, 'nameserver 192.0.2.55\n');
    assert.equal(await resolver.checkFiles(), true);
    last('d.test').answer(A);
    assert.deepEqual(await lone, A);
    assert.deepEqual(await ask('d.test'), A, 'served');
    assert.equal(callsFor('d.test').length, 2, 'and asked again');
    last('d.test').answer(B);
    last('a.test').answer();
  });

  it('keeps what the new configuration said over a late answer from the old: its denial, its hold and failures, its lookup under way', async () => {
    // `P-426`'s second review: an old configuration's answer arriving last was kept whenever no
    // answer was, over a denial or a hold the new configuration had given, which it let go with
    // the name's failures in a row.
    const { resolver, ask, last, clock, callsFor, resolvConf } = watched();
    await resolver.checkFiles();
    // failing.test has failed once, and its retry is under way when the configuration changes.
    await assert.rejects(
      (async () => {
        const asked = ask('failing.test');
        last('failing.test').fail('EAI_AGAIN');
        await asked;
      })(),
    );
    clock.now = 6_000;
    const names = ['denied.test', 'held.test', 'asking.test', 'failing.test'];
    const old = names.map((name) => ask(name, 4, { waitMs: 60_000 }));
    const oldLookups = names.map((name) => last(name));
    assert.equal(callsFor('failing.test').length, 2, 'its retry under way');

    writeFileSync(resolvConf, 'nameserver 192.0.2.54\n');
    assert.equal(await resolver.checkFiles(), true);
    clock.now = 7_000;
    // Under the new configuration: denied.test does not exist, held.test is not answered, and
    // asking.test's lookup is still running.
    const denied = ask('denied.test');
    last('denied.test').fail('ENOTFOUND');
    await assert.rejects(denied, (error) => codeOf(error) === 'ENOTFOUND');
    const held = ask('held.test');
    last('held.test').fail('EAI_AGAIN');
    await assert.rejects(held, (error) => codeOf(error) === 'EAI_AGAIN');
    const asking = ask('asking.test', 4, { waitMs: 60_000 });

    // The old configuration's lookups answer last, each to its own check.
    for (const lookup of oldLookups) lookup.answer(A);
    for (const answer of await Promise.all(old)) assert.deepEqual(answer, A);

    await assert.rejects(ask('denied.test'), (error) => codeOf(error) === 'ENOTFOUND');
    assert.equal(callsFor('denied.test').length, 2, 'the denial stands');
    await assert.rejects(ask('held.test'), (error) => codeOf(error) === RESOLVER_HELD);
    assert.equal(callsFor('held.test').length, 2, 'and the hold');
    const meanwhile = ask('asking.test', 4, { waitMs: 60_000 });
    assert.equal(await isSettled(meanwhile), false, 'nothing kept: it waits for the new lookup');
    last('asking.test').answer(B);
    assert.deepEqual(await asking, B);
    assert.deepEqual(await meanwhile, B);
    // failing.test, which the new configuration said nothing of, keeps the old answer, as due,
    // and its failures in a row: failing again, it is held for the second step, 10 s.
    assert.deepEqual(await ask('failing.test'), A, 'served');
    assert.equal(callsFor('failing.test').length, 3, 'and asked again: a retry');
    last('failing.test').fail('EAI_AGAIN');
    await settled();
    clock.now = 7_000 + 6_000;
    assert.deepEqual(await ask('failing.test'), A, 'served');
    assert.equal(callsFor('failing.test').length, 3, 'still held at 6 s: its second failure');
    // And once denied.test's denial runs out it is asked again, not served the old answer.
    clock.now = 7_000 + DENIAL_MS;
    const askedAgain = ask('denied.test', 4, { waitMs: 60_000 });
    assert.equal(await isSettled(askedAgain), false, 'asked, with nothing kept to serve');
    assert.equal(callsFor('denied.test').length, 3);
    last('denied.test').fail('ENOTFOUND');
    await assert.rejects(askedAgain, (error) => codeOf(error) === 'ENOTFOUND');
  });

  it('looks on its timer once started, and a file that appears is a change too', async () => {
    const { resolver, ask, last, callsFor, hosts, resolvConf } = watched({
      watch: { files: [], everyMs: 25 },
    });
    rmSync(resolvConf);
    const timed = make({ watch: { files: [hosts, resolvConf], everyMs: 25 } });
    timed.resolver.start();
    try {
      const asked = timed.ask('a.test');
      timed.last('a.test').answer();
      await asked;
      // Looked at a few times: nothing has changed, so the answer is kept.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(await timed.ask('a.test'), A);
      assert.equal(timed.callsFor('a.test').length, 1);
      writeFileSync(resolvConf, 'nameserver 192.0.2.53\n');
      await pollWithin(WATCH_EVERY_MS, 'the new file to be seen', () => {
        void timed.ask('a.test').catch(() => undefined);
        return timed.callsFor('a.test').length === 2;
      });
      timed.last('a.test').answer();
    } finally {
      timed.resolver.stop();
    }
    // One given no files looks at nothing, started or not.
    resolver.start();
    const kept = ask('a.test');
    last('a.test').answer();
    await kept;
    assert.equal(await resolver.checkFiles(), false);
    assert.equal(callsFor('a.test').length, 1);
    resolver.stop();
  });
});

describe('a worker’s request (P-426)', () => {
  const request = (id: number, host: string, waitMs = 5_000) => ({
    type: 'resolve',
    id,
    host,
    family: 4,
    waitMs,
    fresh: false,
  });

  it('is answered at once when the answer is kept, and acknowledged first when it must be asked', async () => {
    const { resolver, last } = make();
    const posted: (ResolveAck | ResolveReply)[] = [];
    resolver.handle(request(1, 'a.test'), (message) => posted.push(message));
    assert.deepEqual(posted, [{ type: 'resolve-ack', id: 1 }], 'acknowledged on receipt');
    last('a.test').answer();
    await settled();
    assert.deepEqual(posted[1], { type: 'resolved', id: 1, ok: true, addresses: A });
    resolver.handle(request(2, 'a.test'), (message) => posted.push(message));
    assert.deepEqual(posted[2], { type: 'resolved', id: 2, ok: true, addresses: A }, 'no ack');
  });

  it('forgets a waiter past its bound, and is no longer in flight once the lookup answers', async () => {
    const { resolver, last } = make({ stuckMs: 60_000 });
    const posted: (ResolveAck | ResolveReply)[] = [];
    resolver.handle(request(1, 'late.test', 30), (message) => posted.push(message));
    assert.deepEqual(resolver.stats(), { running: 1, queued: 0, entries: 1 });
    // The waiter goes at its bound and a little slack, with nothing posted: the worker settles
    // its own wait.
    await new Promise((resolve) => setTimeout(resolve, 30 + 400));
    assert.equal(posted.length, 1, 'only the ack');
    assert.equal(resolver.stats().running, 1, 'the lookup is still in flight');
    last('late.test').answer();
    await settled();
    assert.equal(posted.length, 1, 'never answered once forgotten');
    assert.deepEqual(resolver.stats(), { running: 0, queued: 0, entries: 1 });
  });

  it('turns a fault in its own code into a failed lookup naming it, and never throws', () => {
    let broken = false;
    const { resolver } = make({
      now: () => {
        if (broken) throw new Error('the clock broke');
        return 0;
      },
    });
    const posted: (ResolveAck | ResolveReply)[] = [];
    broken = true;
    assert.doesNotThrow(() => {
      resolver.handle(request(1, 'a.test'), (message) => posted.push(message));
    });
    assert.deepEqual(posted, [
      {
        type: 'resolved',
        id: 1,
        ok: false,
        code: RESOLVER_FAULT,
        message: 'the probe’s resolver failed on a.test: the clock broke',
      },
    ]);
    // And a request it cannot read, or a post that throws.
    resolver.handle({ type: 'resolve', id: 2, host: 42, family: 4 }, (message) =>
      posted.push(message),
    );
    assert.deepEqual(posted[1], {
      type: 'resolved',
      id: 2,
      ok: false,
      code: RESOLVER_FAULT,
      message: 'the probe’s resolver was sent a request it cannot read',
    });
    resolver.handle({ type: 'resolve' }, (message) => posted.push(message));
    assert.equal(posted.length, 2, 'no id: nothing to answer');
    broken = false;
    assert.doesNotThrow(() => {
      resolver.handle(request(3, '192.0.2.1'), () => {
        throw new Error('the worker is gone');
      });
    });
    assert.equal(RESOLVE_FAULT, RESOLVER_FAULT, 'the pool’s code for it is the same');
  });

  it('fails a lookup getaddrinfo threw on as a fault, and keeps nothing of it', async () => {
    let throws = true;
    const { resolver } = make({
      lookup: () => {
        if (throws) throw new TypeError('bad argument');
        return Promise.resolve(A);
      },
    });
    await assert.rejects(resolver.resolve('a.test', 4, {}), (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_FAULT);
      assert.match(error.message, /failed on a\.test: bad argument/u);
      return true;
    });
    throws = false;
    assert.deepEqual(await within(1_000, 'the answer', resolver.resolve('a.test', 4, {})), A);
  });

  it('serves the main thread’s own callers from the same entries', async () => {
    const { resolver, last, calls } = make();
    const direct = resolver.resolveHost('a.test', 4, { waitMs: 1_000 });
    last('a.test').answer();
    assert.deepEqual(await direct, A);
    const posted: (ResolveAck | ResolveReply)[] = [];
    resolver.handle(request(1, 'a.test'), (message) => posted.push(message));
    assert.equal(posted[0]?.type, 'resolved');
    assert.equal(calls.length, 1);
  });
});

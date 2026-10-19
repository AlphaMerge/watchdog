import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import {
  notAnswered,
  RESOLVER_FAULT,
  RESOLVER_HELD,
  RESOLVER_STUCK,
  RESOLVER_TOO_MANY,
  type ResolvedAddress,
} from '@ms/sensors';
import { FORWARD_HOLD_MS, ForwardBudget } from '../src/resolver/forward-budget.js';
import { HelperKeys } from '../src/resolver/lane-rule.js';
import { HELPER_LOST, HelperLookupError } from '../src/resolver/lookup-helper.js';
import {
  ANSWER_MS,
  HELPER_LOST_CODE,
  MAX_ADDRESSES,
  NameResolver,
  systemResolverFiles,
  type Family,
  type NameResolverOptions,
} from '../src/resolver/name-resolver.js';
import { FakeHelper, StubPolicy } from './support/fake-helper.js';

/**
 * The resolver in gate mode with the check off (`P-432` S3): what runs where in each of the
 * lookup helper's states, the helper's lanes and tokens, losses, detaching, isolation and poison,
 * and D24 on the probe's lanes. The helper is one the test plays (`FakeHelper`), and so is the
 * name policy; `getaddrinfo` on the probe's lanes is settled by hand, as in name-resolver.test.ts.
 */

const silent = pino({ level: 'silent' });
const STUCK = 40;

interface Call {
  readonly host: string;
  readonly family: Family;
  readonly answer: (addresses?: readonly ResolvedAddress[]) => void;
  readonly fail: (code: string) => void;
}

const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];
const B: readonly ResolvedAddress[] = [{ address: '192.0.2.11', family: 4 }];

function make(
  setup: {
    readonly route?: 'up' | 'rejoining' | 'down' | 'resting';
    readonly local?: (host: string) => boolean;
    readonly tickMs?: number;
    readonly realNow?: () => number;
  } = {},
  options: Partial<NameResolverOptions> = {},
) {
  const calls: Call[] = [];
  const clock = { now: 0 };
  const helper = new FakeHelper(() => clock.now);
  if (setup.route !== undefined) helper.route = setup.route;
  const policy = new StubPolicy();
  if (setup.local !== undefined) {
    const local = setup.local;
    policy.local = (host) => local(host);
  }
  const budget = new ForwardBudget({ now: () => clock.now });
  const keys = new HelperKeys();
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
    random: () => 0.5,
    stuckMs: STUCK,
    watch: { files: [], everyMs: 60_000 },
    gate: {
      helper,
      policy,
      budget,
      keys,
      tickMs: setup.tickMs ?? 3_600_000,
      ...(setup.realNow === undefined ? {} : { realNow: setup.realNow }),
    },
    ...options,
  });
  helper.onChange = (change) => {
    resolver.onHelperChange(change);
  };
  const callsFor = (host: string): Call[] => calls.filter((call) => call.host === host);
  const ask = (
    host: string,
    family: Family = 4,
    request: { waitMs?: number; fresh?: boolean } = {},
  ) => resolver.resolve(host, family, request);
  return { resolver, helper, policy, budget, keys, calls, callsFor, clock, ask };
}

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const pastStuck = (): Promise<void> => wait(STUCK * 3);

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;
const messageOf = (error: unknown): string => (error as Error).message;

/** A promise's outcome, without letting a rejection go unhandled. */
function outcome<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

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

describe('gate mode routes by the helper’s state (P-432 S3, §1.3)', () => {
  it('asks a name the policy cannot vouch for in the helper, and one glibc answers locally on the probe’s lanes', async () => {
    const { helper, calls, ask } = make({ local: (host) => host === 'gw.test' });
    const far = ask('dev-1.zone-a.test');
    const near = ask('gw.test');
    assert.equal(helper.asksFor('dev-1.zone-a.test').length, 1);
    assert.deepEqual(
      calls.map((call) => call.host),
      ['gw.test'],
      'getaddrinfo in the probe for the local name only',
    );
    const sent = helper.last('dev-1.zone-a.test');
    assert.equal(sent.max, MAX_ADDRESSES, 'the cap travels in the ask (O-OS-9)');
    assert.ok(sent.ref !== undefined, 'the lookup is its own reference across a loss');
    sent.answer(A);
    calls[0]?.answer(B);
    assert.deepEqual(await far, A);
    assert.deepEqual(await near, B);
  });

  it('judges the address cap on how many there were, not on what the child sent (O-OS-9)', async () => {
    const { helper, ask } = make();
    const over = outcome(ask('many.zone-a.test'));
    helper.last('many.zone-a.test').answer(A, MAX_ADDRESSES + 1);
    const got = await over;
    assert.ok(!got.ok);
    assert.equal(codeOf(got.error), RESOLVER_TOO_MANY);
    assert.match(messageOf(got.error), /65 addresses/u);
    const at = ask('enough.zone-a.test');
    helper.last('enough.zone-a.test').answer(A, MAX_ADDRESSES);
    assert.deepEqual(await at, A);
  });

  it('N1: down, a name goes to its P-426 class on the probe’s lanes; one the helper failed on fails at once', async () => {
    const { helper, calls, ask } = make({ route: 'down' });
    const routed = ask('dev-1.zone-b.test');
    assert.equal(helper.asks.length, 0, 'nothing asked of a helper that is down');
    assert.equal(calls.length, 1);
    calls[0]?.answer();
    assert.deepEqual(await routed, A);
    helper.avoided.add('4:crash.zone-b.test');
    const refused = await outcome(ask('crash.zone-b.test'));
    assert.ok(!refused.ok);
    assert.equal(codeOf(refused.error), RESOLVER_FAULT);
    assert.match(
      messageOf(refused.error),
      /does not ask its own getaddrinfo for crash\.zone-b\.test/u,
    );
    assert.equal(calls.length, 1, 'never in the probe’s own getaddrinfo');
    assert.equal(notAnswered(refused.error), false, 'N2: not counted as given up');
  });

  it('N1: resting, every name routes as system does, a name the helper failed on aside', async () => {
    const { helper, calls, ask } = make({ route: 'resting' });
    const routed = ask('dev-1.zone-b.test');
    assert.equal(calls.length, 1);
    assert.equal(helper.asks.length, 0);
    calls[0]?.answer();
    assert.deepEqual(await routed, A);
    helper.avoided.add('0:crash.zone-b.test');
    const refused = await outcome(ask('crash.zone-b.test', 0));
    assert.ok(!refused.ok && codeOf(refused.error) === RESOLVER_FAULT);
    assert.equal(calls.length, 1);
  });

  it('rejoining, a name waits for the next child rather than take a probe lane', async () => {
    const { helper, calls, ask } = make({ route: 'rejoining' });
    const waiting = ask('dev-1.zone-a.test', 4, { waitMs: 5_000 });
    assert.equal(calls.length, 0);
    assert.equal(helper.asks.length, 0);
    assert.equal(await isSettled(waiting), false);
    helper.move('up');
    assert.equal(helper.asks.length, 1, 'asked as soon as the helper is up');
    helper.last('dev-1.zone-a.test').answer();
    assert.deepEqual(await waiting, A);
  });

  it('N3: back up, the lookups queued on the probe’s lanes move into the helper and those running stay', async () => {
    const { helper, calls, ask } = make({ route: 'down' });
    // Six on the probe's lanes: four first lanes of zone-b's three (D24) and zone-a's.
    const names = Array.from(
      { length: 8 },
      (_, i) => `d${String(i)}.zone-${i < 4 ? 'b' : 'a'}.test`,
    );
    const waits = names.map((name) => outcome(ask(name, 4, { waitMs: 60_000 })));
    const onLanes = calls.map((call) => call.host);
    assert.ok(onLanes.length > 0 && onLanes.length < names.length);
    helper.move('up');
    const moved = helper.asks.map((sent) => sent.host);
    assert.deepEqual(
      moved.sort(),
      names.filter((name) => !onLanes.includes(name)).sort(),
      'the queued ones, and none running',
    );
    for (const call of calls) call.answer();
    for (const sent of helper.asks) sent.answer();
    for (const got of await Promise.all(waits)) assert.ok(got.ok);
  });

  it('a poison name fails at once in every state, and is never asked on a probe lane (D27)', async () => {
    for (const route of ['up', 'rejoining', 'down', 'resting'] as const) {
      const { helper, calls, ask } = make({ route });
      helper.markPoison('crash.zone-b.test', 4, 3_600_000);
      const refused = await outcome(ask('crash.zone-b.test'));
      assert.ok(!refused.ok, route);
      assert.equal(codeOf(refused.error), RESOLVER_FAULT, route);
      assert.match(messageOf(refused.error), /made the lookup helper fail \(SIGSEGV\)/u);
      assert.equal(calls.length + helper.asks.length, 0, `${route}: asked nowhere`);
    }
  });

  it('"Check now" on a poison name gets the kept answer, saying why', async () => {
    const { helper, ask, clock } = make();
    const first = ask('crash.zone-b.test');
    helper.last('crash.zone-b.test').answer(A);
    await first;
    helper.markPoison('crash.zone-b.test', 4, 3_600_000);
    clock.now = ANSWER_MS + 1;
    // Expired: a refresh would be asked, but a poison name is not.
    assert.deepEqual(await ask('crash.zone-b.test'), A);
    assert.equal(helper.asks.length, 1, 'no refresh for a poison name');
    assert.deepEqual(await ask('crash.zone-b.test', 4, { fresh: true }), A);
  });
});

describe('the helper’s lanes (P-432 S3, §1.8)', () => {
  it('K9: P-426’s caps in the helper: first at most 4, first and refresh 5, the retry lane its own', async () => {
    const { helper, ask, clock } = make();
    // zone-a answers in the helper, so its lookups are ungated.
    const seed = ask('a0.zone-a.test');
    helper.last('a0.zone-a.test').answer();
    await seed;
    const retry = outcome(ask('r.zone-a.test', 4, { waitMs: 60_000 }));
    helper.last('r.zone-a.test').fail('EAI_AGAIN');
    await retry;
    const firsts = Array.from({ length: 6 }, (_, i) =>
      outcome(ask(`f${String(i)}.zone-a.test`, 4, { waitMs: 60_000 })),
    );
    assert.equal(helper.inFlight().length, 4, 'four first lanes');
    clock.now = ANSWER_MS;
    await ask('a0.zone-a.test');
    assert.equal(helper.inFlight().length, 5, 'a refresh takes the fifth');
    void outcome(ask('b0.zone-a.test', 4, { waitMs: 60_000 }));
    clock.now = ANSWER_MS + 1;
    await ask('a0.zone-a.test');
    assert.equal(helper.inFlight().length, 5, 'no sixth for first lookups and refreshes');
    clock.now = 10_000 + ANSWER_MS;
    const again = outcome(ask('r.zone-a.test', 4, { waitMs: 60_000 }));
    assert.equal(helper.inFlight().length, 6, 'the retry lane, on the kept token');
    for (const sent of helper.inFlight()) sent.answer();
    await settled();
    for (const sent of helper.inFlight()) sent.answer();
    await settled();
    for (const sent of helper.inFlight()) sent.answer();
    assert.ok((await again).ok);
    for (const got of await Promise.all(firsts)) assert.ok(got.ok);
  });

  it('a zone never seen that does not answer holds at most 3 of the helper’s lanes, and another zone is asked beside it', async () => {
    const { helper, ask } = make();
    const silentZone = Array.from({ length: 6 }, (_, i) =>
      outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 })),
    );
    assert.equal(helper.inFlight().length, 3, 'its key’s three');
    const answering = ask('dev-1.zone-a.test');
    assert.equal(helper.inFlight().length, 4, 'a never-seen key’s first look beside them');
    helper.last('dev-1.zone-a.test').answer();
    assert.deepEqual(await answering, A);
    for (const sent of helper.inFlight()) sent.fail('ENOTFOUND');
    await settled();
    for (const sent of helper.inFlight()) sent.fail('ENOTFOUND');
    for (const got of await Promise.all(silentZone)) assert.ok(!got.ok);
  });

  it('K10, Q2: a check behind its key’s 3 stuck lookups fails at once, naming them and the rule', async () => {
    const { helper, ask } = make();
    const stuck = Array.from({ length: 3 }, (_, i) =>
      outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 })),
    );
    const queued = outcome(ask('dev-9.zone-b.test', 4, { waitMs: 60_000 }));
    assert.equal(await isSettled(queued.then(() => undefined)), false, 'waits while they run');
    for (const sent of helper.inFlight()) sent.stuck();
    const got = await queued;
    assert.ok(!got.ok);
    assert.equal(codeOf(got.error), RESOLVER_STUCK);
    assert.match(
      messageOf(got.error),
      /^every lane a lookup for dev-9\.zone-b\.test could use is held by a lookup that has run past 40 ms \(dev-0\.zone-b\.test, dev-1\.zone-b\.test, dev-2\.zone-b\.test\): no name of zone-b\.test has answered in the lookup helper/u,
    );
    const fresh = await outcome(ask('dev-8.zone-b.test', 4, { waitMs: 60_000 }));
    assert.ok(!fresh.ok && codeOf(fresh.error) === RESOLVER_STUCK, 'a new one fails as it asks');
    for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
    for (const one of await Promise.all(stuck)) assert.ok(!one.ok);
  });

  it('Q3: "Check now" passes a silent zone’s 3 stuck lookups on an urgent token', async () => {
    const { helper, ask } = make();
    for (let i = 0; i < 3; i += 1)
      void outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 }));
    for (const sent of helper.inFlight()) sent.stuck();
    const now = ask('dev-9.zone-b.test', 4, { fresh: true, waitMs: 60_000 });
    assert.equal(helper.asksFor('dev-9.zone-b.test').length, 1, 'asked at once');
    helper.last('dev-9.zone-b.test').answer(B);
    assert.deepEqual(await now, B);
    for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
  });

  it('K6: a stuck lookup that answers makes its key answering; one that gives up caps its unit until the class answers', async () => {
    const { helper, ask, keys } = make();
    const name = (i: number): string => `dev-${String(i)}.zone-b.test`;
    const waits = [0, 1, 2, 3, 4].map((i) => outcome(ask(name(i), 4, { waitMs: 60_000 })));
    for (const sent of helper.inFlight()) sent.stuck();
    assert.equal(helper.inFlight().length, 3, 'a quiet key’s three');
    helper.last(name(0)).answer();
    await settled();
    assert.equal(keys.quiet('d:zone-b.test'), false, 'it answers again');
    assert.deepEqual(
      helper.inFlight().map((sent) => sent.host),
      [name(1), name(2), name(3)],
      'judged by its unit now, capped at 3 while two are stuck',
    );
    helper.last(name(1)).fail('EAI_AGAIN');
    helper.last(name(2)).fail('EAI_AGAIN');
    await settled();
    assert.equal(keys.capped('d:zone-b.test', 'first'), true, 'gave up since the class answered');
    waits.push(outcome(ask(name(5), 4, { waitMs: 60_000 })));
    waits.push(outcome(ask(name(6), 4, { waitMs: 60_000 })));
    waits.push(outcome(ask(name(7), 4, { waitMs: 60_000 })));
    assert.deepEqual(
      helper.inFlight().map((sent) => sent.host),
      [name(3), name(4), name(5)],
      'still 3',
    );
    helper.last(name(3)).answer();
    await settled();
    assert.equal(keys.capped('d:zone-b.test', 'first'), false);
    assert.equal(helper.inFlight().length, 4, 'the class answered: its cap is the class’s');
    for (const sent of helper.inFlight()) sent.answer();
    await Promise.all(waits);
  });

  it('Q1, Q2: with no token free a lookup stays queued, and its check fails at once only while every holder is stuck', async () => {
    const { helper, ask, calls, clock } = make();
    for (const host of ['a0.zone-a.test', 'c0.zone-c.test']) {
      const seed = ask(host);
      helper.last(host).answer();
      await seed;
    }
    helper.move('down');
    const lanes = uOfFive(ask, clock);
    await pastStuck();
    await settled();
    helper.move('up');
    const kept = outcome(ask('a1.zone-a.test', 4, { waitMs: 60_000 }));
    assert.equal(helper.asksFor('a1.zone-a.test').length, 1, 'the kept token');
    // Another zone that answers: ungated, so held by nothing but the token.
    const waiting = outcome(ask('c1.zone-c.test', 4, { waitMs: 60_000 }));
    assert.equal(helper.asksFor('c1.zone-c.test').length, 0, 'no token: queued');
    assert.equal(
      await isSettled(waiting.then(() => undefined)),
      false,
      'the kept token’s holder is not stuck: it waits',
    );
    helper.last('a1.zone-a.test').stuck();
    const got = await waiting;
    assert.ok(!got.ok && codeOf(got.error) === RESOLVER_STUCK);
    assert.match(
      messageOf(got.error),
      /could use is held by a lookup that has run past 40 ms \(a1\.zone-a\.test\), and every lane of the lookup helper is taken/u,
    );
    helper.last('a1.zone-a.test').answer();
    await settled();
    assert.equal(
      helper.asksFor('c1.zone-c.test').length,
      1,
      'still queued: asked once a token is free',
    );
    helper.last('c1.zone-c.test').answer();
    for (const call of calls) call.answer();
    await Promise.all([kept, ...lanes]);
  });

  it('K16, Q4: U from the probe’s lanes takes the shared tokens, and a key that has answered starts on the kept one', async () => {
    const { helper, ask, calls, budget, clock } = make();
    const seed = ask('a0.zone-a.test');
    helper.last('a0.zone-a.test').answer();
    await seed;
    helper.move('down');
    const lanes = uOfFive(ask, clock);
    assert.equal(calls.length, 5, 'the seed’s refresh and four first lookups');
    await pastStuck();
    await settled();
    assert.equal(budget.untokened(), 5, 'the five lookups past the bound after polls');
    assert.equal(budget.available('shared'), 0);
    helper.move('up');
    const answering = ask('a1.zone-a.test');
    assert.equal(helper.asksFor('a1.zone-a.test').length, 1, 'at once');
    assert.deepEqual(budget.stats().held, { shared: 0, kept: 1, urgent: 0 });
    helper.last('a1.zone-a.test').answer();
    assert.deepEqual(await answering, A);
    const gated = await outcome(ask('new.zone-n.test', 4, { waitMs: 60_000 }));
    assert.ok(!gated.ok && codeOf(gated.error) === RESOLVER_STUCK, 'every token’s room is U’s');
    assert.equal(helper.asksFor('new.zone-n.test').length, 0, 'never on the kept token');
    for (const call of calls) call.answer();
    await settled();
    assert.equal(budget.untokened(), 0, 'U ends with them');
    assert.equal(helper.asksFor('new.zone-n.test').length, 1, 'its lookup stayed queued');
    helper.last('new.zone-n.test').answer();
    await Promise.all(lanes);
  });
});

/**
 * Five lookups on the probe's lanes while the helper is down, every one a DNS lookup: a refresh of
 * `a0.zone-a.test`, kept, and four first lookups of four zones, the most the first lanes take.
 */
function uOfFive(
  ask: (
    host: string,
    family?: Family,
    request?: { waitMs?: number; fresh?: boolean },
  ) => Promise<readonly ResolvedAddress[]>,
  clock: { now: number },
): Promise<unknown>[] {
  clock.now = ANSWER_MS;
  const waits: Promise<unknown>[] = [outcome(ask('a0.zone-a.test'))];
  for (let i = 0; i < 4; i += 1)
    waits.push(outcome(ask(`dev.zone-${String(i)}.test`, 4, { waitMs: 60_000 })));
  return waits;
}

describe('losing the helper (P-432 S3, §1.11)', () => {
  it('N4, Q5: lookups stuck at a loss are held, never asked on a probe lane, and leave ghosts for 10 s', async () => {
    const { helper, ask, calls, budget, clock } = make();
    const waits = Array.from({ length: 3 }, (_, i) =>
      outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 })),
    );
    for (const sent of helper.inFlight()) sent.stuck();
    helper.lose('exit', 'down');
    for (const got of await Promise.all(waits)) {
      assert.ok(!got.ok);
      assert.equal(codeOf(got.error), RESOLVER_HELD);
      assert.match(messageOf(got.error), /when the helper was lost \(exit\)/u);
    }
    await settled();
    assert.equal(calls.length, 0, 'none on any probe lane');
    assert.equal(budget.ghosts('shared'), 3);
    assert.equal(budget.questionsOpen(), 3);
    const held = await outcome(ask('dev-0.zone-b.test'));
    assert.ok(
      !held.ok && codeOf(held.error) === RESOLVER_HELD,
      'held, as for EAI_AGAIN after stuck',
    );
    clock.now = FORWARD_HOLD_MS;
    assert.equal(budget.ghosts('shared'), 0);
  });

  it('N5, Q5: unstuck lookups lost inside the rejoin window are asked again in the next child with their tokens', async () => {
    const { helper, ask, calls, budget } = make();
    const waits = Array.from({ length: 2 }, (_, i) =>
      outcome(ask(`dev-${String(i)}.zone-a.test`, 4, { waitMs: 60_000 })),
    );
    helper.lose('exit', 'rejoining');
    await settled();
    assert.equal(calls.length, 0);
    assert.deepEqual(budget.stats().held, { shared: 2, kept: 0, urgent: 0 }, 'carried');
    assert.equal(budget.stats().ledgerGhostQuestions, 2, 'what the forwarder may still hold');
    helper.move('up');
    const again = helper.inFlight();
    assert.equal(again.length, 2, 'asked again, first');
    assert.deepEqual(budget.stats().held, { shared: 2, kept: 0, urgent: 0 }, 'on the same tokens');
    for (const sent of again) sent.answer();
    for (const got of await Promise.all(waits)) assert.ok(got.ok);
    assert.deepEqual(budget.stats().held, { shared: 0, kept: 0, urgent: 0 });
  });

  it('N6: a check bounded at 2,500 ms is answered when the helper is back within its bound', async () => {
    const { helper, ask } = make();
    const waiting = ask('dev-1.zone-a.test', 4, { waitMs: 2_500 });
    helper.lose('exit', 'rejoining');
    await settled();
    helper.move('up');
    helper.last('dev-1.zone-a.test').answer();
    assert.deepEqual(await waiting, A);
  });

  it('Q7: after the window, what was asked again leaves the helper for its P-426 class, its token released', async () => {
    const { helper, ask, calls, budget } = make();
    const waiting = ask('dev-1.zone-a.test', 4, { waitMs: 60_000 });
    helper.lose('exit', 'rejoining');
    await settled();
    assert.equal(budget.stats().held.shared, 1);
    helper.move('down');
    assert.equal(budget.stats().held.shared, 0, 'released as it left');
    assert.equal(calls.length, 1, 'on its P-426 class');
    calls[0]?.answer();
    assert.deepEqual(await waiting, A);
  });

  it('N13: a hung child’s lookups fail at once with no hold, are never asked again, and leave ghosts', async () => {
    const { helper, ask, calls, budget } = make();
    const waits = Array.from({ length: 2 }, (_, i) =>
      outcome(ask(`dev-${String(i)}.zone-a.test`, 4, { waitMs: 60_000 })),
    );
    helper.lose('hung', 'rejoining');
    for (const got of await Promise.all(waits)) {
      assert.ok(!got.ok);
      assert.equal(codeOf(got.error), RESOLVER_FAULT);
      assert.match(
        messageOf(got.error),
        /stopped answering while asking for dev-\d\.zone-a\.test/u,
      );
    }
    await settled();
    assert.equal(budget.ghosts('shared'), 2, 'every lookup of a hung child is treated as stuck');
    helper.move('up');
    assert.equal(helper.inFlight().length, 0, 'never asked again');
    assert.equal(calls.length, 0);
    const next = ask('dev-0.zone-a.test');
    assert.equal(helper.inFlight().length, 1, 'no hold: the next check asks');
    helper.last('dev-0.zone-a.test').answer();
    assert.deepEqual(await next, A);
  });

  it('N10: a quiet child’s lookups are detached: a new check asks again, and the detached EAI_AGAIN holds nothing', async () => {
    const { helper, ask, calls } = make();
    const first = outcome(ask('dev-1.zone-a.test', 4, { waitMs: 60_000 }));
    const detached = helper.last('dev-1.zone-a.test');
    helper.goQuiet();
    const second = outcome(ask('dev-1.zone-a.test', 4, { waitMs: 60_000 }));
    assert.equal(calls.length, 1, 'its own lookup, on the probe’s lanes while the helper is down');
    detached.fail('EAI_AGAIN');
    const gotFirst = await first;
    assert.ok(!gotFirst.ok, 'its own waiters are told');
    calls[0]?.answer(B);
    const gotSecond = await second;
    assert.ok(gotSecond.ok && gotSecond.value[0]?.address === B[0]?.address);
    assert.deepEqual(await ask('dev-1.zone-a.test'), B, 'kept, and nothing held');
  });

  it('a lost child’s late answer settles a lookup still queued to be asked again, once', async () => {
    const { helper, ask, resolver, budget } = make();
    const waiting = ask('dev-1.zone-a.test', 4, { waitMs: 60_000 });
    const sent = helper.last('dev-1.zone-a.test');
    helper.lose('exit', 'rejoining');
    await settled();
    assert.ok(sent.ref !== undefined);
    resolver.onHelperLateAnswer(sent.ref, {
      ok: true,
      answer: { addresses: B, total: 1, ranMs: 3 },
    });
    assert.deepEqual(await waiting, B);
    assert.equal(budget.stats().held.shared, 0, 'its carried token released');
    resolver.onHelperLateAnswer(sent.ref, {
      ok: true,
      answer: { addresses: A, total: 1, ranMs: 3 },
    });
    helper.move('up');
    assert.equal(helper.inFlight().length, 0, 'not asked again');
    assert.deepEqual(await resolver.resolve('dev-1.zone-a.test', 4, {}), B);
  });

  it('N14: stopping, the queued lookups fail saying so, and what ran is not asked again', async () => {
    const { helper, ask } = make();
    for (let i = 0; i < 3; i += 1)
      void outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 }));
    const queued = outcome(ask('dev-9.zone-b.test', 4, { waitMs: 60_000 }));
    const running = outcome(ask('dev-0.zone-b.test', 4, { waitMs: 60_000 }));
    await helper.stop();
    const got = await queued;
    assert.ok(!got.ok && codeOf(got.error) === RESOLVER_FAULT);
    assert.match(messageOf(got.error), /the probe is stopping/u);
    const ran = await running;
    assert.ok(!ran.ok && /the probe is stopping/u.test(messageOf(ran.error)));
  });

  it('knows the helper’s lost code by its value: the module cannot import it', () => {
    assert.equal(HELPER_LOST_CODE, HELPER_LOST);
  });
});

describe('isolation and poison (P-432 S3, D27)', () => {
  it('N11: sends the suspects alone, one at a time, then the rest once isolation ends', async () => {
    const { helper, ask } = make();
    const names = ['s1.zone-a.test', 's2.zone-a.test', 'other.zone-c.test'];
    const waits = names.map((name) => outcome(ask(name, 4, { waitMs: 60_000 })));
    helper.isolatingNow = true;
    helper.lose('exit', 'rejoining', { suspects: true });
    await settled();
    const later = outcome(ask('later.zone-d.test', 4, { waitMs: 60_000 }));
    helper.move('up');
    assert.equal(helper.inFlight().length, 1, 'one suspect alone');
    assert.equal(helper.inFlight()[0]?.suspect, true);
    helper.inFlight()[0]?.answer();
    await settled();
    assert.equal(helper.inFlight().length, 1, 'the next, alone');
    helper.inFlight()[0]?.stuck();
    await settled();
    assert.equal(helper.inFlight().length, 2, 'stuck: the next may go');
    helper.inFlight()[1]?.answer();
    await settled();
    assert.equal(helper.isolatingNow, true, 'a suspect is still in flight, stuck');
    helper.inFlight()[0]?.answer();
    await settled();
    assert.equal(helper.endedIsolation, 1, 'no suspect left: ended');
    assert.ok(helper.asksFor('later.zone-d.test').length === 1, 'and the rest go');
    helper.last('later.zone-d.test').answer();
    for (const got of await Promise.all([...waits, later])) assert.ok(got.ok);
  });

  it('N11: a stuck suspect holds its lane: the next suspect goes only within its class’s cap (LR7 I3)', async () => {
    const { helper, ask, clock, resolver } = make();
    const names = ['r1.zone-a.test', 'r2.zone-b.test'];
    // Each held once, so that it is asked again on the retry lane.
    for (const name of names) {
      const first = outcome(ask(name));
      helper.last(name).fail('EAI_AGAIN');
      await first;
    }
    // Each lost with a child while isolating, so a suspect, and held again by its late answer.
    for (const name of names) {
      clock.now += 120_000;
      const asked = outcome(ask(name, 4, { waitMs: 60_000 }));
      const sent = helper.last(name);
      helper.isolatingNow = true;
      helper.lose('exit', 'rejoining', { suspects: true });
      await settled();
      assert.ok(sent.ref !== undefined);
      resolver.onHelperLateAnswer(sent.ref, {
        ok: false,
        error: new HelperLookupError(`getaddrinfo EAI_AGAIN ${name}`, 'EAI_AGAIN', 3),
      });
      await asked;
      helper.move('up');
    }
    // Both asked again: two suspects of the retry class, sent alone while isolating.
    clock.now += 120_000;
    helper.isolatingNow = true;
    helper.move('rejoining', { state: 'backoff' });
    const waits = names.map((name) => outcome(ask(name, 4, { waitMs: 60_000 })));
    helper.move('up');
    assert.equal(helper.inFlight().length, 1, 'one suspect alone');
    const [sent] = helper.inFlight();
    assert.ok(sent?.suspect === true);
    sent.stuck();
    await settled();
    assert.equal(helper.inFlight().length, 1, 'stuck, yet the retry lane is still its');
    sent.answer();
    await settled();
    assert.equal(helper.inFlight().length, 1, 'its end lets the next go');
    assert.equal(helper.inFlight()[0]?.suspect, true);
    helper.inFlight()[0]?.answer();
    const [one, two] = await Promise.all(waits);
    assert.ok(one?.ok === true);
    // The second's check stopped waiting once its one lane's holder was stuck (§1.8's fail fast).
    assert.ok(two?.ok === false && codeOf(two.error) === RESOLVER_STUCK);
  });

  it('N11: the one charged fails naming the crash, and while the helper rests its name fails at once', async () => {
    const { helper, ask, calls } = make();
    const crash = outcome(ask('crash.zone-a.test', 4, { waitMs: 60_000 }));
    const charged = helper.last('crash.zone-a.test');
    helper.lose('exit', 'resting', { charged, ends: true });
    const got = await crash;
    assert.ok(!got.ok && codeOf(got.error) === RESOLVER_FAULT);
    assert.match(messageOf(got.error), /made the lookup helper fail/u);
    helper.markPoison('crash.zone-a.test', 4, 3_600_000);
    const again = await outcome(ask('crash.zone-a.test'));
    assert.ok(!again.ok && codeOf(again.error) === RESOLVER_FAULT);
    assert.equal(calls.length, 0, 'never on a probe lane, resting included');
    const other = ask('fine.zone-a.test');
    assert.equal(calls.length, 1, 'resting routes as system does');
    calls[0]?.answer();
    assert.deepEqual(await other, A);
  });

  it('asks a poison name again hourly, alone, once nothing else runs in the helper', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    try {
      helper.markPoison('crash.zone-a.test', 4, 1_000);
      const busy = outcome(ask('busy.zone-c.test', 4, { waitMs: 60_000 }));
      clock.now = 1_000;
      await wait(40);
      assert.equal(helper.asksFor('crash.zone-a.test').length, 0, 'not beside another lookup');
      const next = outcome(ask('next.zone-d.test', 4, { waitMs: 60_000 }));
      assert.equal(
        helper.asksFor('next.zone-d.test').length,
        0,
        'nothing new starts while it waits',
      );
      helper.last('busy.zone-c.test').answer();
      await busy;
      assert.equal(helper.asksFor('crash.zone-a.test').length, 1, 'asked');
      assert.equal(helper.inFlight().length, 1, 'alone');
      helper.last('crash.zone-a.test').answer(B);
      await settled();
      assert.equal(helper.asksFor('next.zone-d.test').length, 1, 'and the rest go');
      helper.last('next.zone-d.test').answer();
      assert.ok((await next).ok);
    } finally {
      resolver.stop();
    }
  });
});

describe('the probe’s lanes in gate mode (P-432 S3, D24, D25)', () => {
  it('K18: down, 40 queued zone-b first lookups handed over at once start at most 3, and zone-a’s at once', async () => {
    for (const route of ['up', 'resting'] as const) {
      const { helper, ask, calls } = make({ route: route === 'up' ? 'up' : 'resting' });
      const waits: Promise<unknown>[] = [];
      for (let i = 0; i < 40; i += 1) {
        waits.push(outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 })));
      }
      if (route === 'up') {
        assert.equal(helper.inFlight().length, 3);
        helper.move('down');
      }
      const zoneB = calls.filter((call) => call.host.endsWith('zone-b.test'));
      assert.equal(zoneB.length, 3, `${route}: a domain not known to answer holds 3`);
      const answering = ask('dev-1.zone-a.test');
      assert.equal(calls.filter((call) => call.host === 'dev-1.zone-a.test').length, 1, route);
      calls.find((call) => call.host === 'dev-1.zone-a.test')?.answer();
      assert.deepEqual(await answering, A);
      for (const sent of helper.inFlight()) sent.fail('ENOTFOUND');
      for (let round = 0; round < 20; round += 1) {
        for (const call of calls) call.fail('ENOTFOUND');
        await settled();
      }
      await Promise.all(waits);
    }
  });

  it('D24: a domain’s helper lookup said stuck caps its first lookups on the probe’s lanes to 3', async () => {
    const { helper, ask, calls } = make({ local: (host) => host.startsWith('l') });
    const seed = ask('l0.zone-b.test');
    calls[0]?.answer();
    await seed;
    const far = outcome(ask('h0.zone-b.test', 4, { waitMs: 60_000 }));
    helper.last('h0.zone-b.test').stuck();
    const near = [1, 2, 3, 4, 5].map((i) =>
      outcome(ask(`l${String(i)}.zone-b.test`, 4, { waitMs: 60_000 })),
    );
    assert.equal(calls.length - 1, 3, 'capped: one of its lookups is stuck, in the helper');
    helper.last('h0.zone-b.test').answer();
    await settled();
    assert.equal(calls.length - 1, 4, 'no longer: all four first lanes');
    for (let round = 0; round < 3; round += 1) {
      for (const call of calls) call.answer();
      await settled();
    }
    await Promise.all([far, ...near]);
  });

  it('D25: a local lookup past the bound on the probe’s lanes is passed-stuck, after polls, unless its timer fired late', async () => {
    const real = { now: 0, late: 0 };
    const { resolver, ask, calls } = make({
      local: () => true,
      realNow: () => real.now + real.late,
    });
    const first = outcome(ask('gw.test', 4, { waitMs: 60_000 }));
    await pastStuck();
    await settled();
    assert.equal(resolver.gateHealth()?.passedStuck, 1);
    real.late = 500;
    const second = outcome(ask('gw2.test', 4, { waitMs: 60_000 }));
    real.late = 500 + 1_000;
    await pastStuck();
    await settled();
    assert.equal(resolver.gateHealth()?.passedStuck, 1, 'a stall’s timer is no evidence');
    for (const call of calls) call.answer();
    await Promise.all([first, second]);
  });

  it('D25: a local lookup is never in U; one not local is, late or not, until it ends', async () => {
    const { ask, calls, budget } = make({ local: (host) => host === 'gw.test', route: 'down' });
    const waits = [outcome(ask('gw.test', 0)), outcome(ask('dev.zone-a.test', 0))];
    await pastStuck();
    await settled();
    assert.equal(budget.untokened(), 1);
    assert.equal(budget.questionsOpen(), 2, 'family 0: two questions');
    for (const call of calls) call.answer();
    await settled();
    assert.equal(budget.untokened(), 0);
    await Promise.all(waits);
  });

  it('a lookup that ends before polls sets no mark', async () => {
    const { resolver, ask, calls, budget } = make({
      local: (host) => host === 'gw.test',
      route: 'down',
    });
    const near = outcome(ask('gw.test'));
    const far = outcome(ask('dev.zone-a.test'));
    const answered = new Promise<void>((resolve) => {
      setTimeout(() => {
        // In the same timers phase as the stuck timers, after them, before their polls.
        for (const call of calls) call.answer();
        resolve();
      }, STUCK + 1);
    });
    // A stall: both timers are due when the loop comes back.
    const until = Date.now() + STUCK + 30;
    while (Date.now() < until) {
      // the main thread is blocked
    }
    await answered;
    await settled();
    await settled();
    assert.equal(resolver.gateHealth()?.passedStuck, 0);
    assert.equal(budget.untokened(), 0);
    await Promise.all([near, far]);
  });
});

describe('gate mode’s start, watch and health (P-432 S3)', () => {
  it('loads the policy from the watch’s own first reading of the hosts file, and looks only once at start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-gate-'));
    try {
      const hosts = join(dir, 'hosts');
      const gai = join(dir, 'gai.conf');
      writeFileSync(hosts, '192.0.2.5 printer.test\n');
      const { resolver, policy } = make(
        {},
        { watch: { files: [hosts, join(dir, 'resolv.conf'), gai], everyMs: 60_000 } },
      );
      await resolver.firstLook();
      assert.deepEqual(policy.loads, [{ hosts: '192.0.2.5 printer.test\n' }]);
      assert.equal(policy.looks.length, 1, 'told of the first look after it loaded');
      assert.deepEqual(
        policy.looks[0]?.map((reading) => reading.file),
        [hosts, join(dir, 'resolv.conf'), gai],
      );
      resolver.start();
      await settled();
      assert.equal(policy.looks.length, 1, 'start does not look again at once');
      resolver.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('watches the policy’s files beside the three P-438 does', async () => {
    const policy = new StubPolicy();
    policy.watched = ['/nonexistent/ms-gate/gai.conf'];
    const helper = new FakeHelper();
    const made = new NameResolver({
      logger: silent,
      lookup: () => Promise.resolve(A),
      gate: { helper, policy, tickMs: 3_600_000 },
    });
    await made.firstLook();
    assert.deepEqual(
      policy.looks.at(-1)?.map((reading) => reading.file),
      [...systemResolverFiles(), '/nonexistent/ms-gate/gai.conf'],
    );
  });

  it('N12: a read-once file that moved skews the helper; another that moved does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-gate-'));
    try {
      const gai = join(dir, 'gai.conf');
      const resolv = join(dir, 'resolv.conf');
      writeFileSync(gai, '');
      writeFileSync(resolv, 'nameserver 192.0.2.53\n');
      const { resolver, policy, helper } = make(
        {},
        { watch: { files: [resolv, gai], everyMs: 60_000 } },
      );
      policy.readOnce = [gai];
      await resolver.firstLook();
      writeFileSync(resolv, 'nameserver 192.0.2.54\n');
      policy.moved = [resolv];
      await resolver.checkFiles();
      assert.deepEqual(helper.skewed, [], 'resolv.conf is read again by a new child');
      writeFileSync(gai, 'precedence ::ffff:0:0/96 100\n');
      policy.moved = [gai];
      await resolver.checkFiles();
      assert.deepEqual(helper.skewed, [gai]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts the time with the check on and the helper up, the helper’s stuck lookups, and the mode', async () => {
    const { resolver, policy, helper, clock, ask } = make();
    policy.off = undefined;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 0);
    clock.now = 5_000;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 5);
    clock.now = 6_000;
    helper.move('down');
    clock.now = 9_000;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 6, 'up until it went down');
    clock.now = 20_000;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 6, 'not while down');
    helper.move('up');
    clock.now = 21_000;
    policy.off = { code: 'nsswitch', why: 'test' };
    resolver.gateHealth();
    clock.now = 30_000;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 7, 'not while the check is off');
    // S4's 'slow': a look past its bound turns the check off until the next look, and that
    // stretch is off too, though the view keeps load's reading.
    policy.off = undefined;
    resolver.gateHealth();
    clock.now = 32_000;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 9, 'on again once the check is');
    policy.off = { code: 'slow', why: 'a look past its bound' };
    resolver.gateHealth();
    clock.now = 40_000;
    assert.equal(resolver.gateHealth()?.checkOnSeconds, 9, 'not while the look is slow');
    policy.off = { code: 'nsswitch', why: 'test' };
    assert.equal(resolver.gateHealth()?.mode, 2);
    const waiting = outcome(ask('dev.zone-b.test', 4, { waitMs: 60_000 }));
    helper.last('dev.zone-b.test').stuck();
    assert.equal(resolver.gateHealth()?.helperStuck, 1);
    helper.last('dev.zone-b.test').answer();
    await waiting;
    helper.move('resting');
    assert.equal(resolver.gateHealth()?.mode, 3, 'resting: resolving as system does');
  });

  it('takes the peak of the questions open since the last take', async () => {
    const { resolver, ask, helper } = make();
    const a = outcome(ask('a.zone-a.test', 0, { waitMs: 60_000 }));
    const b = outcome(ask('b.zone-b.test', 0, { waitMs: 60_000 }));
    assert.equal(resolver.takeQuestionsPeak(), 4);
    for (const sent of helper.inFlight()) sent.answer();
    await Promise.all([a, b]);
    assert.equal(resolver.takeQuestionsPeak(), 4, 'a take starts from what was open at it');
    assert.equal(resolver.takeQuestionsPeak(), 0);
  });

  it('counts both lane sets in flight for Probe Health', () => {
    const { resolver, ask } = make({ local: (host) => host === 'gw.test' });
    void outcome(ask('gw.test', 4, { waitMs: 60_000 }));
    for (let i = 0; i < 5; i += 1)
      void outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 }));
    assert.deepEqual(resolver.stats(), { running: 4, queued: 2, entries: 6 });
  });
});

describe('the domains not answering, for Probe Health (P-441)', () => {
  it('names the domains with the most names failing, most first, at most three', async () => {
    const { resolver, ask, helper } = make();
    const fail = async (host: string): Promise<void> => {
      const got = outcome(ask(host, 4, { waitMs: 60_000 }));
      helper.last(host).fail('EAI_AGAIN');
      await got;
    };
    for (const host of ['a.zone-b.test', 'b.zone-b.test', 'c.zone-b.test']) await fail(host);
    for (const host of ['a.zone-c.test', 'b.zone-c.test']) await fail(host);
    await fail('a.zone-d.test');
    await fail('sw-b1');
    assert.deepEqual(
      resolver.notAnswering(),
      ['zone-b.test', 'zone-c.test', ''],
      'a tie by name: a single label’s domain is the empty one',
    );
    assert.deepEqual(resolver.notAnswering(5), ['zone-b.test', 'zone-c.test', '', 'zone-d.test']);
    assert.deepEqual(resolver.notAnswering(1), ['zone-b.test']);
  });
});

describe('system mode builds none of it (P-432 S3)', () => {
  it('has no gate health, no peak, and calls nothing of a helper', async () => {
    const resolver = new NameResolver({
      logger: silent,
      lookup: () => Promise.resolve(A),
      watch: { files: [], everyMs: 60_000 },
    });
    assert.equal(resolver.gateHealth(), undefined);
    assert.equal(resolver.takeQuestionsPeak(), undefined);
    resolver.onHelperChange({ state: 'up', previous: 'starting', route: 'up', isolating: false });
    resolver.onHelperLateAnswer({}, { ok: true, answer: { addresses: B, total: 1, ranMs: 1 } });
    assert.deepEqual(await resolver.resolve('dev.zone-a.test', 4, {}), A);
    await resolver.firstLook();
  });
});

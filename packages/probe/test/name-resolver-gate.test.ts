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
import {
  HELPER_LOST,
  HelperLookupError,
  LookupHelper,
  type HelperLimits,
} from '../src/resolver/lookup-helper.js';
import {
  ANSWER_MS,
  GATE_SUMMARY_MS,
  HELPER_LOST_CODE,
  MAX_ADDRESSES,
  NameResolver,
  STALE_MS,
  systemResolverFiles,
  type Family,
  type NameResolverOptions,
} from '../src/resolver/name-resolver.js';
import { GlibcNamePolicy, SYSTEM_FILES } from '../src/resolver/system-names.js';
import { FakeHelper, StubPolicy } from './support/fake-helper.js';
import { pollWithin, within } from './support/within.js';
import { zoneFork, type ZoneAnswer } from './support/zone-helper.js';

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

const SUMMARY = 'the probe’s resolver in gate mode, this hour';

/** What a gate summary says, by the fields the tests read (`P-463` fix rounds 1 and 2). */
interface Summary {
  readonly stopping?: unknown;
  readonly routed?: { readonly faulted?: unknown };
  readonly checksFaulted?: unknown;
  readonly helper?: { readonly quiets?: unknown; readonly keptOffPeak?: unknown };
}

/** A logger at `info` whose lines the test reads, and the gate summaries among them. */
function captured() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const summaries = (): Summary[] => lines.filter((line) => line['msg'] === SUMMARY);
  return { logger, lines, summaries };
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

  it('N1: down, a suspect not yet asked again fails at once, on the resolver’s own word, and never reaches the probe’s lanes (D27)', async () => {
    const { helper, callsFor, ask } = make();
    const got = outcome(ask('sus.zone-a.test', 4, { waitMs: 5_000 }));
    assert.equal(helper.asksFor('sus.zone-a.test').length, 1);
    // A crash while isolating: it is to be asked again alone, and the next child is not up.
    helper.isolatingNow = true;
    helper.lose('exit', 'rejoining', { suspects: true });
    await settled();
    assert.equal(helper.avoidsSystem('sus.zone-a.test', 4), false, 'the helper says nothing of it');
    helper.move('down');
    const said = await within(2_000, 'the suspect’s check', got);
    assert.ok(!said.ok);
    assert.equal(codeOf(said.error), RESOLVER_FAULT);
    assert.match(messageOf(said.error), /does not ask its own getaddrinfo for sus\.zone-a\.test/u);
    assert.equal(callsFor('sus.zone-a.test').length, 0, 'never in the probe’s own getaddrinfo');
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

  it('K1: a warm zone of 500 names gone silent, check off: at most 4 of its refreshes run, 3 once it has given up, and another zone’s first lookup starts at once', async () => {
    const { helper, ask, clock, keys } = make();
    const names = Array.from({ length: 500 }, (_, i) => `dev-${String(i)}.zone-b.test`);
    // Warm: every name asked and answered in the helper.
    const warm = names.map((name) => outcome(ask(name, 4, { waitMs: 60_000 })));
    for (let round = 0; round < 1_000 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.answer();
      await settled();
    }
    for (const got of await Promise.all(warm)) assert.ok(got.ok);
    // Silent: past their answers' life, each is served what it had while it is refreshed.
    clock.now = ANSWER_MS + 1;
    let most = 0;
    for (const name of names) {
      assert.deepEqual(await ask(name), A, `${name} served its kept answer`);
      most = Math.max(most, helper.inFlight().length);
    }
    assert.equal(most, 4, 'the 4 refresh lanes, and never a fifth');
    // The child says each has run past its bound: the zone's key is quiet again and its refresh
    // unit capped. One gives up, EAI_AGAIN after stuck, and none starts in its place: a quiet key
    // runs 3.
    for (const sent of helper.inFlight()) sent.stuck();
    assert.equal(keys.capped('d:zone-b.test', 'refresh'), true);
    const [first, second] = helper.inFlight();
    first?.fail('EAI_AGAIN');
    await settled();
    assert.equal(keys.quiet('d:zone-b.test'), true);
    assert.equal(helper.inFlight().length, 3, 'none starts for the one that gave up');
    second?.fail('EAI_AGAIN');
    await settled();
    assert.equal(helper.inFlight().length, 3, 'one starts for the next, to 3 and no more');
    const other = ask('dev-1.zone-a.test');
    assert.ok(
      helper.inFlight().some((sent) => sent.host === 'dev-1.zone-a.test'),
      'another zone’s first lookup starts at once',
    );
    helper.last('dev-1.zone-a.test').answer();
    assert.deepEqual(await other, A);
  });

  it('K4: single labels, check off: each is a key of its own, so 3 silent ones do not hold a fourth label back; a fourth silent one fills the first lanes, as system mode’s rule does', async () => {
    const { helper, ask } = make();
    const silentOnes = ['sw-b1', 'sw-b2', 'sw-b3'].map((name) =>
      outcome(ask(name, 4, { waitMs: 60_000 })),
    );
    assert.equal(helper.inFlight().length, 3);
    // Were single labels one key (the design's `''`), the key rule would hold this one back as
    // its fourth lookup.
    const answering = ask('sw-a1');
    assert.equal(helper.inFlight().length, 4, 'sw-a1 is asked beside them at once');
    helper.last('sw-a1').answer();
    assert.deepEqual(await answering, A);
    // A fourth silent label takes the last first lane, and a never-seen label waits for one: in
    // `system` mode every single label is the domain `''`, held to 3, and waits as well.
    void outcome(ask('sw-b4', 4, { waitMs: 60_000 }));
    assert.equal(helper.inFlight().length, 4);
    const waiting = outcome(ask('sw-a2', 4, { waitMs: 60_000 }));
    assert.equal(
      helper.inFlight().some((sent) => sent.host === 'sw-a2'),
      false,
      'the first lookups’ cap of 4',
    );
    helper.last('sw-b1').fail('EAI_AGAIN');
    await settled();
    assert.ok(
      helper.inFlight().some((sent) => sent.host === 'sw-a2'),
      'asked once a lane is free',
    );
    helper.last('sw-a2').answer();
    assert.ok((await waiting).ok);
    for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
    for (const got of await Promise.all(silentOnes)) assert.ok(!got.ok);
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

  it('N10: a quiet child’s lookups are detached: a new check asks again, never on the probe’s lanes (P-463), and the detached EAI_AGAIN holds nothing', async () => {
    const { helper, ask, calls, callsFor } = make();
    const first = outcome(ask('dev-1.zone-a.test', 4, { waitMs: 60_000 }));
    const detached = helper.last('dev-1.zone-a.test');
    helper.goQuiet();
    // In flight as the child went quiet, it may be what quieted it (D27): while the helper is down
    // its new check fails at once rather than ask the probe's own getaddrinfo.
    const refused = await outcome(ask('dev-1.zone-a.test', 4, { waitMs: 60_000 }));
    assert.ok(!refused.ok && codeOf(refused.error) === RESOLVER_FAULT);
    assert.match(
      messageOf(refused.error),
      /does not ask its own getaddrinfo for dev-1\.zone-a\.test/u,
    );
    // A name the child was not asking goes to its P-426 class there.
    const other = outcome(ask('dev-2.zone-a.test', 4, { waitMs: 60_000 }));
    assert.deepEqual(
      calls.map((call) => call.host),
      ['dev-2.zone-a.test'],
    );
    detached.fail('EAI_AGAIN');
    const gotFirst = await first;
    assert.ok(!gotFirst.ok, 'its own waiters are told');
    callsFor('dev-2.zone-a.test')[0]?.answer();
    assert.ok((await other).ok);
    // Heard again: a new check starts its own lookup, in the helper, and nothing holds it.
    helper.move('up');
    const second = outcome(ask('dev-1.zone-a.test', 4, { waitMs: 60_000 }));
    assert.equal(helper.asksFor('dev-1.zone-a.test').length, 2, 'its own lookup, in the helper');
    helper.last('dev-1.zone-a.test').answer(B);
    const gotSecond = await second;
    assert.ok(gotSecond.ok && gotSecond.value[0]?.address === B[0]?.address);
    assert.deepEqual(await ask('dev-1.zone-a.test'), B, 'kept, and nothing held');
    assert.equal(callsFor('dev-1.zone-a.test').length, 0, 'never in the probe’s own getaddrinfo');
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

  it('N14: once the resolver has stopped, a helper going down settles what is queued for it, and none of it runs on the probe’s lanes', async () => {
    // The real helper's stop takes its child, says `stopping` with the route down, and says
    // `stopped` only once the child has exited: between the two, what was queued for the helper
    // fell back to the probe's lanes, after the pool had drained (SC10 found it).
    const { helper, ask, calls, resolver } = make();
    for (let i = 0; i < 3; i += 1)
      void outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 }));
    const queued = outcome(ask('dev-9.zone-b.test', 4, { waitMs: 60_000 }));
    assert.equal(
      helper.inFlight().length,
      3,
      'the domain’s three first lookups run, a fourth queued',
    );
    resolver.stop();
    helper.move('down', { state: 'stopping' });
    const got = await queued;
    assert.ok(!got.ok && codeOf(got.error) === RESOLVER_FAULT);
    assert.match(messageOf(got.error), /the probe is stopping/u);
    assert.equal(calls.length, 0, 'nothing asked on the probe’s lanes');
  });

  it('N14: while the pool drains, a lost child’s queued lookups still fall back to the probe’s lanes', async () => {
    const { helper, ask, calls } = make();
    for (let i = 0; i < 3; i += 1)
      void outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 }));
    const queued = ask('dev-9.zone-b.test', 4, { waitMs: 60_000 });
    assert.equal(helper.inFlight().length, 3);
    helper.move('down', { state: 'stopping' });
    assert.deepEqual(
      calls.map(({ host }) => host),
      ['dev-9.zone-b.test'],
      'asked on the probe’s lanes, under D24',
    );
    calls[0]?.answer(B);
    assert.deepEqual(await queued, B);
  });

  it('knows the helper’s lost code by its value: the module cannot import it', () => {
    assert.equal(HELPER_LOST_CODE, HELPER_LOST);
  });
});

describe('isolation and poison (P-432 S3, D27)', () => {
  it('N11: sends the suspects alone, one at a time; isolation ends once the last is said stuck, and the rest go', async () => {
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
    assert.equal(helper.asksFor('later.zone-d.test').length, 0, 'nothing beside a suspect unsaid');
    helper.inFlight()[1]?.stuck();
    await settled();
    assert.equal(helper.endedIsolation, 1, 'the last suspect said stuck: isolation is over');
    assert.equal(helper.asksFor('later.zone-d.test').length, 1, 'and the rest go beside them');
    for (const sent of helper.inFlight()) sent.answer();
    for (const got of await Promise.all([...waits, later])) assert.ok(got.ok);
  });

  it('N11: a suspect whose getaddrinfo never returns holds the helper only until the child says it is stuck', async () => {
    const { helper, ask } = make();
    const hung = outcome(ask('hang.zone-a.test', 4, { waitMs: 60_000 }));
    helper.isolatingNow = true;
    helper.lose('exit', 'rejoining', { suspects: true });
    await settled();
    helper.move('up');
    const [suspect] = helper.inFlight();
    assert.ok(suspect?.suspect === true);
    const other = outcome(ask('dev-1.zone-c.test', 4, { waitMs: 60_000 }));
    const checkNow = outcome(ask('dev-2.zone-c.test', 4, { waitMs: 60_000, fresh: true }));
    assert.equal(helper.inFlight().length, 1, 'alone while the child has said nothing of it');
    // Said stuck, and never answering: the helper goes on without it.
    suspect.stuck();
    await settled();
    assert.equal(helper.endedIsolation, 1);
    assert.deepEqual(
      helper
        .inFlight()
        .map((sent) => sent.host)
        .sort(),
      ['dev-1.zone-c.test', 'dev-2.zone-c.test', 'hang.zone-a.test'],
    );
    helper.last('dev-1.zone-c.test').answer();
    helper.last('dev-2.zone-c.test').answer();
    assert.ok((await other).ok);
    assert.ok((await checkNow).ok, '"Check now" too');
    const more = outcome(ask('dev-3.zone-c.test', 4, { waitMs: 60_000 }));
    assert.equal(helper.asksFor('dev-3.zone-c.test').length, 1, 'and what is asked after');
    helper.last('dev-3.zone-c.test').answer();
    assert.ok((await more).ok);
    suspect.fail('EAI_AGAIN');
    assert.ok(!(await hung).ok);
  });

  it('D27: a suspect held at the second crash keeps isolation on until it is asked again alone, once its hold ends', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    try {
      const slow = outcome(ask('slow.zone-a.test', 4, { waitMs: 60_000 }));
      const fine = outcome(ask('fine.zone-b.test', 4, { waitMs: 60_000 }));
      const fine2 = outcome(ask('fine-2.zone-b.test', 4, { waitMs: 60_000 }));
      helper.last('slow.zone-a.test').stuck();
      // The second crash: the stuck lookup held, the others asked again, all three suspects.
      helper.isolatingNow = true;
      helper.lose('exit', 'rejoining', { suspects: true });
      const held = await slow;
      assert.ok(!held.ok && codeOf(held.error) === RESOLVER_HELD);
      assert.deepEqual(helper.held, [5_005], 'the helper told: its hold, and a tick to ask it in');
      helper.move('up');
      const [one] = helper.inFlight();
      assert.equal(helper.inFlight().length, 1, 'one suspect alone');
      assert.ok(one?.suspect === true);
      one.answer();
      await settled();
      const [two] = helper.inFlight();
      assert.equal(helper.inFlight().length, 1, 'then the other, alone');
      assert.ok(two?.suspect === true && two.host !== one.host);
      // Ticks while the second is in flight: the first, asked and answered, is owed no more.
      await wait(30);
      two.answer();
      for (const got of await Promise.all([fine, fine2])) assert.ok(got.ok);
      await wait(30);
      assert.equal(helper.asksFor(one.host).length, 2, 'a suspect asked is not asked again');
      assert.equal(helper.asksFor(two.host).length, 2);
      assert.equal(helper.endedIsolation, 0, 'the held suspect is still to be asked');
      const meanwhile = outcome(ask('meanwhile.zone-c.test', 4, { waitMs: 60_000 }));
      assert.equal(
        helper.asksFor('meanwhile.zone-c.test').length,
        1,
        'a suspect held holds nothing back',
      );
      helper.last('meanwhile.zone-c.test').answer();
      assert.ok((await meanwhile).ok);
      assert.equal(helper.asksFor('slow.zone-a.test').length, 1, 'not before its hold ends');
      clock.now += 5_000;
      await pollWithin(
        1_000,
        'the held suspect asked again',
        () => helper.asksFor('slow.zone-a.test').length === 2,
        5,
      );
      const again = helper.last('slow.zone-a.test');
      assert.equal(again.suspect, true, 'alone, as a suspect, though no check asked for it');
      const blocked = outcome(ask('blocked.zone-d.test', 4, { waitMs: 60_000 }));
      assert.equal(helper.asksFor('blocked.zone-d.test').length, 0, 'nothing beside it');
      // It crashes the child again, alone: charged, as D27 means it to be.
      helper.lose('exit', 'rejoining', { charged: again, suspects: true });
      await settled();
      helper.move('up');
      assert.equal(helper.endedIsolation, 1, 'none left: over');
      helper.last('blocked.zone-d.test').answer();
      assert.ok((await blocked).ok);
    } finally {
      resolver.stop();
    }
  });

  it('D27: tells the helper how long a suspect is held, and nothing of a name held outside isolation', async () => {
    const { helper, ask, clock } = make({ tickMs: 5 });
    const first = outcome(ask('slow.zone-a.test', 4, { waitMs: 60_000 }));
    helper.last('slow.zone-a.test').stuck();
    helper.lose('exit', 'rejoining');
    assert.ok(!(await first).ok);
    assert.deepEqual(helper.held, [], 'not a suspect');
    helper.move('up');
    clock.now += 30_000;
    const second = outcome(ask('slow.zone-a.test', 4, { waitMs: 60_000 }));
    helper.last('slow.zone-a.test').stuck();
    helper.isolatingNow = true;
    helper.lose('exit', 'rejoining', { suspects: true });
    assert.ok(!(await second).ok);
    // Held again, twice as long: 10 s, and the gate's tick to ask it in.
    assert.deepEqual(helper.held, [10_005]);
  });

  it('D27: a suspect let go when the child was judged quiet holds back no other once it is heard again', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    try {
      const slow = outcome(ask('slow.zone-a.test', 4, { waitMs: 60_000 }));
      void outcome(ask('quiet.zone-b.test', 4, { waitMs: 60_000 }));
      helper.last('slow.zone-a.test').stuck();
      helper.isolatingNow = true;
      helper.lose('exit', 'rejoining', { suspects: true });
      const held = await slow;
      assert.ok(!held.ok && codeOf(held.error) === RESOLVER_HELD);
      helper.move('up');
      const quiet = helper.last('quiet.zone-b.test');
      assert.equal(quiet.suspect, true, 'alone');
      // Judged quiet with it in flight (D26): let go, then heard again, the same child.
      helper.goQuiet();
      helper.move('up');
      clock.now += 5_000;
      await pollWithin(
        1_000,
        'the held suspect asked again',
        () => helper.asksFor('slow.zone-a.test').length === 2,
        5,
      );
      assert.equal(helper.last('slow.zone-a.test').suspect, true, 'alone, beside one let go');
      quiet.answer();
      helper.last('slow.zone-a.test').answer();
    } finally {
      resolver.stop();
    }
  });

  it('D27: isolation ended by the helper leaves no suspect owed: a name held is asked as any other', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    try {
      const slow = outcome(ask('slow.zone-a.test', 4, { waitMs: 60_000 }));
      const fine = outcome(ask('fine.zone-b.test', 4, { waitMs: 60_000 }));
      helper.last('slow.zone-a.test').stuck();
      helper.isolatingNow = true;
      helper.lose('exit', 'rejoining', { suspects: true });
      await slow;
      helper.move('up');
      helper.last('fine.zone-b.test').answer();
      assert.ok((await fine).ok);
      assert.equal(helper.endedIsolation, 0, 'the held suspect is still owed');
      // The helper's own lapse (8 s after the crash): its change says isolation is over.
      helper.isolatingNow = false;
      helper.move('up');
      clock.now += 5_000;
      await wait(30);
      assert.equal(helper.asksFor('slow.zone-a.test').length, 1, 'not asked again for isolation');
      const again = outcome(ask('slow.zone-a.test', 4, { waitMs: 60_000 }));
      assert.equal(helper.last('slow.zone-a.test').suspect, false, 'a name like any other');
      helper.last('slow.zone-a.test').answer();
      assert.ok((await again).ok);
      // A later isolation owes nothing for it: with nothing to send, it ends at the next pick.
      helper.isolatingNow = true;
      helper.move('up');
      const next = outcome(ask('next.zone-c.test', 4, { waitMs: 60_000 }));
      assert.equal(helper.endedIsolation, 1);
      helper.last('next.zone-c.test').answer();
      assert.ok((await next).ok);
    } finally {
      resolver.stop();
    }
  });

  it('D27: at the helper’s lapse a suspect still queued goes as any lookup, beside the one in flight', async () => {
    const { helper, ask } = make();
    const first = outcome(ask('s1.zone-a.test', 4, { waitMs: 60_000 }));
    const second = outcome(ask('s2.zone-b.test', 4, { waitMs: 60_000 }));
    helper.isolatingNow = true;
    helper.lose('exit', 'rejoining', { suspects: true });
    await settled();
    helper.move('up');
    assert.deepEqual(
      helper.inFlight().map((sent) => sent.host),
      ['s1.zone-a.test'],
    );
    // 8 s after the crash, the first never said stuck: the helper's change ends isolation.
    helper.isolatingNow = false;
    helper.move('up');
    assert.equal(helper.last('s2.zone-b.test').suspect, false, 'a suspect no more');
    assert.equal(helper.inFlight().length, 2);
    for (const sent of helper.inFlight()) sent.answer();
    for (const got of await Promise.all([first, second])) assert.ok(got.ok);
  });

  it('D27: a poison name due while the helper isolates waits for isolation to end', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    try {
      helper.markPoison('crash.zone-a.test', 4, 1_000);
      const first = outcome(ask('s1.zone-b.test', 4, { waitMs: 60_000 }));
      helper.isolatingNow = true;
      helper.lose('exit', 'rejoining', { suspects: true });
      await settled();
      clock.now = 1_000;
      helper.move('up');
      assert.deepEqual(
        helper.inFlight().map((sent) => [sent.host, sent.suspect]),
        [['s1.zone-b.test', true]],
        'the suspect alone, and no poison ask before it',
      );
      await wait(30);
      assert.equal(helper.asksFor('crash.zone-a.test').length, 0, 'nor beside it');
      helper.last('s1.zone-b.test').answer();
      assert.ok((await first).ok);
      await pollWithin(
        1_000,
        'the poison ask once isolation is over',
        () => helper.asksFor('crash.zone-a.test').length === 1,
        5,
      );
      assert.equal(helper.endedIsolation, 1);
      assert.equal(helper.inFlight().length, 1, 'alone as it starts');
      helper.last('crash.zone-a.test').answer(B);
    } finally {
      resolver.stop();
    }
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

  it('asks a poison name again at a moment nothing is in flight, and holds nothing back (D27)', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    try {
      helper.markPoison('crash.zone-a.test', 4, 1_000);
      const busy = outcome(ask('busy.zone-c.test', 4, { waitMs: 60_000 }));
      clock.now = 1_000;
      await wait(40);
      assert.equal(helper.asksFor('crash.zone-a.test').length, 0, 'not beside another lookup');
      const next = outcome(ask('next.zone-d.test', 4, { waitMs: 60_000 }));
      assert.equal(helper.asksFor('next.zone-d.test').length, 1, 'nothing waits for it');
      helper.last('busy.zone-c.test').answer();
      assert.ok((await busy).ok);
      assert.equal(helper.asksFor('crash.zone-a.test').length, 0, 'one is still in flight');
      helper.last('next.zone-d.test').answer();
      assert.ok((await next).ok);
      await settled();
      assert.equal(helper.asksFor('crash.zone-a.test').length, 1, 'asked as the helper fell idle');
      assert.equal(helper.inFlight().length, 1, 'alone as it starts');
      const beside = outcome(ask('beside.zone-e.test', 4, { waitMs: 60_000 }));
      assert.equal(helper.asksFor('beside.zone-e.test').length, 1, 'and it holds nothing back');
      helper.last('crash.zone-a.test').answer(B);
      helper.last('beside.zone-e.test').answer();
      assert.ok((await beside).ok);
    } finally {
      resolver.stop();
    }
  });
});

/** The child's bound for stuck in the tests with the real helper: real time, kept short. */
const REAL_STUCK = 150;

/**
 * The resolver with the real lookup helper, on real time, its children played in process
 * (`support/zone-helper.ts`) with short bounds: what the two do together at a crash, a hold and
 * isolation's lapse, which the fake helper here and the scripted child there cannot show alone.
 * The helper's liveness tick is out of the way: a zone child beats only when told.
 */
function realGate(answer: (host: string) => ZoneAnswer, limits: Partial<HelperLimits> = {}) {
  /** Each lookup the children began, and whether it was alone in its child as it began. */
  const asked: { readonly host: string; readonly alone: boolean }[] = [];
  const { fork, children } = zoneFork({
    answer,
    began: (host) => {
      asked.push({ host, alone: children.at(-1)?.inFlight() === 1 });
    },
  });
  /** Each name asked on the probe's own lanes, with the helper's state and route then. */
  const probeAsked: string[] = [];
  const box: { resolver?: NameResolver } = {};
  const helper = new LookupHelper({
    logger: silent,
    fork,
    limits: {
      stuckMs: REAL_STUCK,
      isolationMaxMs: 200,
      tickMs: 600_000,
      backoffMs: [0, 0, 0, 0],
      restFirstMs: 300,
      ...limits,
    },
    onChange: (change) => {
      box.resolver?.onHelperChange(change);
    },
    onLateAnswer: (ref, late) => {
      box.resolver?.onHelperLateAnswer(ref, late);
    },
  });
  const resolver = new NameResolver({
    logger: silent,
    lookup: (host) => {
      probeAsked.push(`${host}: the helper ${helper.state}, route ${helper.routeState()}`);
      return Promise.resolve(A);
    },
    random: () => 0.5,
    stuckMs: REAL_STUCK,
    holdFirstMs: 400,
    watch: { files: [], everyMs: 60_000 },
    gate: { helper, policy: new StubPolicy(), tickMs: 5 },
  });
  box.resolver = resolver;
  /** The newest child killed from outside, and the next one up. */
  const kill = async (): Promise<void> => {
    const before = children.length;
    const child = children.at(-1);
    assert.ok(child?.alive === true && helper.state === 'up', `a child to kill: ${helper.state}`);
    child.die('SIGSEGV');
    await pollWithin(
      5_000,
      () => `the helper after a kill: ${helper.state}`,
      () =>
        helper.state === 'resting' ||
        (helper.state === 'up' && children.length > before && children.at(-1)?.alive === true),
      5,
    );
  };
  const start = async (): Promise<void> => {
    assert.equal(await within(5_000, 'the helper up', helper.start()), true);
    resolver.start();
  };
  const stop = async (): Promise<void> => {
    resolver.stop();
    await within(5_000, 'the helper stopped', helper.stop());
  };
  return { helper, resolver, children, asked, probeAsked, kill, start, stop };
}

describe('isolation with the real lookup helper (P-432 S3, D27; real time)', () => {
  /** Said stuck at `REAL_STUCK`, then the child crashes: a crash on a slow reply. */
  const slowCrash =
    (name: string) =>
    (host: string): ZoneAnswer =>
      host === name ? { kind: 'crash', afterMs: 3 * REAL_STUCK } : { kind: 'answer', addresses: A };

  it('a suspect held longer than the lapse is still asked alone while isolating, and charged', async () => {
    const host = 'slow.zone-a.test';
    const gate = realGate(slowCrash(host));
    await gate.start();
    try {
      await gate.kill();
      // The second crash, on its slow reply: isolating, and it is held 400 ms, past the lapse.
      const first = await outcome(gate.resolver.resolve(host, 4, { waitMs: 5_000 }));
      assert.ok(!first.ok);
      await pollWithin(5_000, 'isolating', () => gate.helper.isolating(), 5);
      await pollWithin(
        5_000,
        () => `${host} charged: asked ${JSON.stringify(gate.asked)}`,
        () => gate.helper.poison(host, 4) !== undefined,
        5,
      );
      assert.deepEqual(
        gate.asked.filter((one) => one.host === host).map((one) => one.alone),
        [true, true],
        'asked again alone, once its hold ended',
      );
      assert.deepEqual(gate.probeAsked, []);
    } finally {
      await gate.stop();
    }
  });

  it('the five-crash sequence: a name that crashes the child on a slow reply is charged, and never reaches the probe’s lanes', async () => {
    const host = 'x.zone-a.test';
    const other = 'dev-1.zone-b.test';
    // A lapse longer than its hold: it is asked alone within isolation, and said stuck.
    const gate = realGate(slowCrash(host), { isolationMaxMs: 2_000 });
    await gate.start();
    const neverOnTheLanes = (when: string): void => {
      assert.deepEqual(
        gate.probeAsked.filter((line) => line.startsWith(`${host}:`)),
        [],
        `${host} on the probe’s lanes ${when}`,
      );
    };
    /** A check of it fails at once: held from its last crash, then poison, in every state. */
    const failsAtOnce = async (when: string): Promise<void> => {
      const got = await within(
        1_000,
        `${host}’s check ${when}`,
        outcome(gate.resolver.resolve(host, 4, { waitMs: 5_000 })),
      );
      assert.ok(
        !got.ok && [RESOLVER_HELD, RESOLVER_FAULT].includes(String(codeOf(got.error))),
        `${when}: ${got.ok ? 'answered' : `${String(codeOf(got.error))} ${messageOf(got.error)}`}`,
      );
      neverOnTheLanes(when);
    };
    try {
      await gate.kill();
      // The second crash isolates; held, it is asked again alone, said stuck, and isolation ends
      // with it in flight: its crash then is still its own.
      assert.ok(!(await outcome(gate.resolver.resolve(host, 4, { waitMs: 5_000 }))).ok);
      await pollWithin(
        5_000,
        () => `${host} charged: the helper ${gate.helper.state}`,
        () => gate.helper.poison(host, 4) !== undefined,
        5,
      );
      assert.equal(gate.asked.filter((one) => one.host === host).length, 2);
      await pollWithin(5_000, 'the helper up', () => gate.helper.state === 'up', 5);
      await failsAtOnce('with the helper up');
      // Three more losses, five not charged in ten minutes: the helper rests.
      for (let kill = 0; kill < 3; kill += 1) await gate.kill();
      assert.equal(gate.helper.state, 'resting');
      await failsAtOnce('while it rests');
      assert.ok((await gate.resolver.resolve(other, 4, { waitMs: 5_000 })).length > 0);
      assert.equal(gate.probeAsked.filter((line) => line.startsWith(`${other}:`)).length, 1);
      // The rest over, a child starting: then up, lost within ten minutes, and resting again.
      await pollWithin(5_000, 'the rest over', () => gate.helper.state !== 'resting', 5);
      await failsAtOnce(`as the helper is ${gate.helper.state}`);
      await pollWithin(5_000, 'the helper up after its rest', () => gate.helper.state === 'up', 5);
      await gate.kill();
      assert.equal(gate.helper.state, 'resting');
      await failsAtOnce('in its second rest');
      assert.equal(gate.asked.filter((one) => one.host === host).length, 2, 'never asked again');
    } finally {
      await gate.stop();
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

  it('says which helper change it failed on, and which files the policy could not be told of', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'error' },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    );
    const dir = mkdtempSync(join(tmpdir(), 'ms-gate-logs-'));
    try {
      const hosts = join(dir, 'hosts');
      writeFileSync(hosts, '127.0.0.1 localhost\n');
      const { helper, policy, resolver } = make(
        {},
        { logger, watch: { files: [hosts], everyMs: 60_000 } },
      );
      policy.checkOn = () => {
        throw new Error('a policy that fails');
      };
      helper.lose('exit', 'rejoining');
      await settled();
      const change = lines.find(
        (line) => line['msg'] === 'the probe’s resolver failed on a lookup helper change',
      )?.['change'] as Record<string, unknown> | undefined;
      assert.ok(change !== undefined, 'logged');
      assert.equal(change['loss'], 'exit');
      assert.equal(change['route'], 'rejoining');
      assert.equal(change['previous'], 'up');
      policy.looked = () => Promise.reject(new Error('a policy that cannot be told'));
      await resolver.checkFiles();
      const told = lines.find(
        (line) => line['msg'] === 'what a watched file says could not reach the name policy',
      );
      assert.deepEqual(told?.['files'], [hosts]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts the time with the check on in this build: the real policy on a stock shape says on, and not built where a test says so', async () => {
    const stock: Record<string, string | null> = {
      [SYSTEM_FILES.resolvConf]: 'nameserver 192.0.2.53\n',
      [SYSTEM_FILES.nsswitchConf]: 'hosts: files dns\n',
      [SYSTEM_FILES.hosts]: '127.0.0.1 localhost\n',
      [SYSTEM_FILES.gaiConf]: '',
      [SYSTEM_FILES.ldSoPreload]: null,
    };
    const seconds = async (checkBuilt: boolean | undefined): Promise<number | undefined> => {
      const policy = new GlibcNamePolicy({
        logger: silent,
        platform: 'linux',
        env: {},
        glibcVersion: () => '2.39',
        nodeVersion: 'v24.0.0-test',
        hostname: () => 'probe-1',
        readText: (path) => Promise.resolve(stock[path] ?? null),
        socketExists: () => Promise.resolve(false),
        moduleLook: () => Promise.resolve({ state: 'installed' }),
        ...(checkBuilt === undefined ? {} : { checkBuilt }),
      });
      await policy.load();
      assert.equal(policy.view().off, undefined, 'a shape the check would take');
      const clock = { now: 0 };
      const helper = new FakeHelper(() => clock.now);
      const resolver = new NameResolver({
        logger: silent,
        lookup: () => Promise.reject(new Error('no lookup in this test')),
        now: () => clock.now,
        watch: { files: [], everyMs: 60_000 },
        gate: { helper, policy, tickMs: 3_600_000 },
      });
      helper.onChange = (change) => {
        resolver.onHelperChange(change);
      };
      helper.move('up');
      clock.now = 60_000;
      return resolver.gateHealth()?.checkOnSeconds;
    };
    assert.equal(await seconds(undefined), 60, 'this build (S6): on, the helper up a minute');
    assert.equal(await seconds(false), 0, 'a build without the check: off');
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

  it('keeps the helper’s lanes at risk at their most since the start, and how many the gate admitted: a stuck lookup that started ungated is overshoot (P-465)', async () => {
    const { resolver, helper, ask, clock } = make();
    assert.deepEqual(resolver.riskSeen(), { atRisk: 0, overshoot: 0, admitted: 0 });
    const seed = ask('a0.zone-a.test');
    helper.last('a0.zone-a.test').answer();
    assert.deepEqual(await seed, A);
    // Four never-seen zones' first looks, each gated on a shared token as it starts.
    const silentOnes = [0, 1, 2, 3].map((i) =>
      outcome(ask(`dev.zone-${String(i)}.test`, 4, { waitMs: 60_000 })),
    );
    assert.equal(helper.inFlight().length, 4);
    assert.deepEqual(resolver.riskSeen(), { atRisk: 4, overshoot: 0, admitted: 4 });
    // The answering zone's refresh starts ungated on the last shared token; said stuck, it is at
    // risk, and not one the gate admitted at risk.
    clock.now = ANSWER_MS + 1;
    assert.deepEqual(await ask('a0.zone-a.test'), A, 'served what it had while refreshed');
    assert.equal(helper.asksFor('a0.zone-a.test').length, 2, 'its refresh, in the helper');
    helper.last('a0.zone-a.test').stuck();
    await settled();
    assert.deepEqual(resolver.riskSeen(), { atRisk: 5, overshoot: 1, admitted: 4 });
    // Never reset: the most since the start, once every lookup has ended.
    for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
    await settled();
    for (const got of await Promise.all(silentOnes)) assert.ok(!got.ok);
    assert.deepEqual(resolver.riskSeen(), { atRisk: 5, overshoot: 1, admitted: 4 });
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
  it('K14: has no gate health, no peak, and calls nothing of a helper; P-426’s and P-438’s cases are name-resolver.test.ts’s, unchanged', async () => {
    const resolver = new NameResolver({
      logger: silent,
      lookup: () => Promise.resolve(A),
      watch: { files: [], everyMs: 60_000 },
    });
    assert.equal(resolver.gateHealth(), undefined);
    assert.equal(resolver.takeQuestionsPeak(), undefined);
    assert.equal(resolver.riskSeen(), undefined);
    resolver.onHelperChange({ state: 'up', previous: 'starting', route: 'up', isolating: false });
    resolver.onHelperLateAnswer({}, { ok: true, answer: { addresses: B, total: 1, ranMs: 1 } });
    assert.deepEqual(await resolver.resolve('dev.zone-a.test', 4, {}), A);
    await resolver.firstLook();
  });
});

/**
 * D27 when the asking check's own pump starts a lookup, the check off (`P-432` gate, fix round 1):
 * name-resolver-check's table covers "Check now" exempting a lookup from `P-438`'s rule; these are
 * the two other ways a lookup queued on the probe's lanes starts in its check's own ask. "Check
 * now" moves a held name's retry, queued behind another's on the retry lane, to a free first lane;
 * and a plain check joins a lookup that the `STUCK_MS` after a stuck end held back, the window over
 * by the clock and its timer not yet run. The helper rests, so every name is routed as `system`
 * routes it; the name has since become one the probe may not ask. Each check fails at once, with
 * the refusal, as the one already waiting does.
 */
describe('D27 when a check starts a lookup in its own ask, check off (P-432 gate, fix round 1)', () => {
  const X = 'x.zone-a.test';
  const AVOIDED_X =
    /^the probe’s resolver does not ask its own getaddrinfo for x\.zone-a\.test: .* is resting$/u;

  /** A promise's outcome as soon as it has one: read after a turn, to tell at once from later. */
  function seen(promise: Promise<unknown>): { got?: { ok: true } | { ok: false; error: unknown } } {
    const box: { got?: { ok: true } | { ok: false; error: unknown } } = {};
    void outcome(promise).then((got) => {
      box.got = got.ok ? { ok: true } : { ok: false, error: got.error };
    });
    return box;
  }

  /** Both checks, told at once that the probe does not ask its own getaddrinfo for X. */
  function toldAtOnce(checks: Record<string, ReturnType<typeof seen>>): void {
    for (const [what, box] of Object.entries(checks)) {
      const got = box.got;
      assert.ok(got !== undefined, `${what}: told at once, not at its bound`);
      assert.ok(!got.ok, `${what}: failed`);
      assert.equal(codeOf(got.error), RESOLVER_FAULT, `${what}: ${messageOf(got.error)}`);
      assert.match(messageOf(got.error), AVOIDED_X, what);
    }
  }

  it('"Check now" moving a held name’s retry ahead of the one on the retry lane fails at once, saying why, one lookup refused and two checks', async () => {
    const { logger, summaries } = captured();
    const { resolver, helper, callsFor, clock, ask } = make({ route: 'resting' }, { logger });
    resolver.start();
    const other = 'r.zone-b.test';
    for (const host of [other, X]) {
      const once = outcome(ask(host, 4, { waitMs: 60_000 }));
      callsFor(host)[0]?.fail('EAI_AGAIN');
      assert.equal((await once).ok, false, `${host} failed once`);
    }
    // Past both holds: each name's next lookup is a retry.
    clock.now += 10_000;
    const retried = outcome(ask(other, 4, { waitMs: 10_000 }));
    const waiting = seen(ask(X, 4, { waitMs: 10_000 }));
    assert.equal(callsFor(other).length, 2, 'its retry on the retry lane');
    assert.equal(callsFor(X).length, 1, 'X’s retry queued behind it');
    helper.avoided.add(`4:${X}`);
    const checkNow = seen(ask(X, 4, { fresh: true, waitMs: 1_000 }));
    await settled();
    toldAtOnce({ 'the waiting check': waiting, 'Check now': checkNow });
    assert.equal(callsFor(X).length, 1, 'never again on the probe’s own getaddrinfo');
    callsFor(other)[1]?.answer();
    assert.ok((await retried).ok);
    // `#offProbe` refused one lookup, and failed the check waiting on it; Check now, told by the
    // words it kept, is a second check (`P-463` fix round 2), not a second lookup.
    resolver.stop();
    const said = summaries().at(-1);
    assert.equal(said?.routed?.faulted, 1, JSON.stringify(said));
    assert.equal(said.checksFaulted, 2);
  });

  it('a check joining a lookup the window after a stuck end held back, the window over and its timer not run, fails at once, saying why', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { helper, callsFor, clock, ask } = make({ route: 'resting' });
    const last = (host: string): Call => {
      const call = callsFor(host).at(-1);
      assert.ok(call !== undefined, `a lookup for ${host}`);
      return call;
    };
    const answered = async (
      host: string,
      request: { waitMs?: number; fresh?: boolean } = {},
    ): Promise<void> => {
      const asked = ask(host, 4, request);
      last(host).answer();
      assert.deepEqual(await asked, A);
    };
    const s = (n: number): string => `s${String(n)}.silent.test`;
    const a = (n: number): string => `a${String(n)}.zone-a.test`;
    // Zone S's four names kept, and zone A known to answer.
    for (const name of [1, 2, 3, 4].map(s)) await answered(name);
    clock.now = ANSWER_MS;
    await answered(a(0));
    // One of zone A's lookups ends stuck without an answer, and another of its names answers
    // after it: zone A is held only by the STUCK_MS after that end.
    const ended = outcome(ask(a(1), 4, { waitMs: 60_000 }));
    t.mock.timers.tick(STUCK);
    last(a(1)).fail('EAI_AGAIN');
    assert.equal((await ended).ok, false);
    await answered(a(2), { fresh: true, waitMs: 60_000 });
    // Zone S's four refreshes fill the refresh lanes: X is held back from the last shared lane.
    for (const name of [1, 2, 3, 4].map(s)) assert.deepEqual(await ask(name), A);
    const waiting = seen(ask(X, 4, { waitMs: 60_000 }));
    await settled();
    assert.equal(waiting.got, undefined, 'its check waits: no lane it could take is stuck');
    assert.equal(callsFor(X).length, 0, 'held back beside a free first lane');
    helper.avoided.add(`4:${X}`);
    // The window over, and nothing starts or ends: no timer runs here, so only the check asking
    // lets the lookup go.
    clock.now += STUCK;
    const joined = seen(ask(X, 4, { waitMs: 60_000 }));
    await settled();
    toldAtOnce({ 'the waiting check': waiting, 'the joining check': joined });
    assert.equal(callsFor(X).length, 0, 'never on the probe’s own getaddrinfo');
    for (const name of [1, 2, 3, 4].map(s)) last(name).answer();
  });
});

describe('a slow first read of the name settings (P-432 gate, fix round 1)', () => {
  /**
   * The real policy on a stock shape, its load bounded at 50 ms and its read of resolv.conf held
   * until `release`, and a resolver in gate mode whose start loads it from its first look.
   */
  function slowStart() {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stock: Record<string, string | null> = {
      [SYSTEM_FILES.resolvConf]: 'nameserver 192.0.2.53\n',
      [SYSTEM_FILES.nsswitchConf]: 'hosts: files dns\n',
      [SYSTEM_FILES.hosts]: '127.0.0.1 localhost\n',
      [SYSTEM_FILES.gaiConf]: '',
      [SYSTEM_FILES.ldSoPreload]: null,
    };
    const policy = new GlibcNamePolicy({
      logger: silent,
      platform: 'linux',
      env: {},
      glibcVersion: () => '2.39',
      nodeVersion: 'v24.0.0-test',
      hostname: () => 'probe-1',
      readText: async (path) => {
        if (path === SYSTEM_FILES.resolvConf) await held;
        return stock[path] ?? null;
      },
      socketExists: () => Promise.resolve(false),
      moduleLook: () => Promise.resolve({ state: 'installed' }),
      loadMs: 50,
    });
    const resolver = new NameResolver({
      logger: silent,
      lookup: () => Promise.reject(new Error('no lookup in this test')),
      watch: { files: [], everyMs: 60_000 },
      gate: { helper: new FakeHelper(), policy, tickMs: 3_600_000 },
    });
    return {
      policy,
      resolver,
      release: () => {
        release();
      },
    };
  }

  it('is off for now: the start’s own look does not judge it, and one that ends before the next look turns the check on', async () => {
    const { policy, resolver, release } = slowStart();
    await within(2_000, 'the start’s first look', resolver.firstLook());
    assert.equal(policy.view().off?.code, 'slow', 'not a hang: its own look is not the next');
    release();
    await pollWithin(1_000, 'the load, ended', () => policy.view().off === undefined, 5);
    await within(2_000, 'the next look', resolver.checkFiles());
    assert.equal(policy.view().off, undefined, 'on, and the next look keeps it on');
  });

  it('is a hang once the look after the start’s finds it still reading: off until restart', async () => {
    const { policy, resolver, release } = slowStart();
    await within(2_000, 'the start’s first look', resolver.firstLook());
    assert.equal(policy.view().off?.code, 'slow');
    await within(2_000, 'the next look', resolver.checkFiles());
    assert.equal(policy.view().off?.code, 'fault');
    assert.match(policy.view().off?.why ?? '', /did not end within 50 ms, nor by the next look/u);
    release();
    await settled();
    assert.equal(policy.view().off?.code, 'fault', 'until restart');
  });
});

describe('a poison name’s re-ask ended from outside, isolation off (P-432 gate, fix round 1)', () => {
  it('is asked again first in the next child, as its hourly re-ask is, at a moment nothing else is in flight, and what is queued starts beside it', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    const crash = 'crash.zone-a.test';
    try {
      const mark = helper.markPoison(crash, 4, 1_000);
      clock.now = 1_000;
      await pollWithin(1_000, 'the re-ask', () => helper.asksFor(crash).length === 1, 2);
      assert.equal(helper.inFlight().length, 1, 'alone as it starts');
      // As the real helper does as it asks: not due again for its retry, so no tick asks it anew.
      mark.nextAskAt = clock.now + mark.retryMs;
      // Killed from outside with no loss before it: not charged, and no suspect, since the helper
      // does not isolate at its first loss in ten minutes. Asked again, its token with it.
      helper.lose('exit', 'rejoining');
      await settled();
      const queued = ['q1.zone-c.test', 'q2.zone-d.test'];
      const waits = queued.map((host) => outcome(ask(host, 4, { waitMs: 60_000 })));
      assert.equal(helper.asks.length, 1, 'all of it queued for the next child');
      helper.move('up');
      await settled();
      assert.deepEqual(
        helper.asks.slice(1).map((asked) => asked.host),
        [crash, ...queued],
        'the re-ask first, and what was queued beside it',
      );
      assert.equal(
        helper.last(crash).suspect,
        false,
        'not sent alone: the helper is not isolating',
      );
      helper.last(crash).answer(B);
      for (const host of queued) helper.last(host).answer();
      for (const got of await Promise.all(waits)) assert.ok(got.ok);
    } finally {
      resolver.stop();
    }
  });

  it('with nothing queued for the next child, starts there alone, so that a crash is its own, and a check asked after it starts beside it', async () => {
    const { helper, ask, clock, resolver } = make({ tickMs: 5 });
    resolver.start();
    const crash = 'crash.zone-a.test';
    try {
      const mark = helper.markPoison(crash, 4, 1_000);
      clock.now = 1_000;
      await pollWithin(1_000, 'the re-ask', () => helper.asksFor(crash).length === 1, 2);
      // As the real helper does as it asks: not due again for its retry, so no tick asks it anew.
      mark.nextAskAt = clock.now + mark.retryMs;
      helper.lose('exit', 'rejoining');
      await settled();
      assert.equal(helper.asks.length, 1, 'nothing asked while the next child comes');
      helper.move('up');
      await settled();
      assert.equal(
        helper.asksFor(crash).length,
        2,
        'asked again in the next child, its hour moved',
      );
      assert.deepEqual(
        helper.inFlight().map((asked) => asked.host),
        [crash],
        'alone: nothing was queued for the next child',
      );
      assert.equal(helper.last(crash).suspect, false, 'not a suspect: the helper is not isolating');
      const later = 'l1.zone-c.test';
      const wait = outcome(ask(later, 4, { waitMs: 60_000 }));
      await settled();
      assert.deepEqual(
        helper.inFlight().map((asked) => asked.host),
        [crash, later],
        'a check asked after it starts beside it: it holds nothing back',
      );
      helper.last(crash).answer(B);
      helper.last(later).answer();
      assert.ok((await wait).ok);
    } finally {
      resolver.stop();
    }
  });
});

describe('what the gate’s refusals cost, as its summary counts it (P-463 fix round 2)', () => {
  const X = 'x.zone-a.test';
  const KEPT_OFF_X = /does not ask its own getaddrinfo for x\.zone-a\.test/u;

  /** zone-a answered in the helper, so its lookups are ungated, and its four first lanes full. */
  async function lanesFull(made: ReturnType<typeof make>) {
    const { helper, ask } = made;
    const seed = ask('a0.zone-a.test');
    helper.last('a0.zone-a.test').answer();
    await seed;
    const firsts = [0, 1, 2, 3].map((i) =>
      outcome(ask(`f${String(i)}.zone-a.test`, 4, { waitMs: 60_000 })),
    );
    assert.equal(helper.inFlight().length, 4, 'the four first lanes');
    return firsts;
  }

  it('two checks of one kept-off name waiting on its lookup, refused at the quiet: one lookup, two checks', async () => {
    const { logger, summaries } = captured();
    const made = make({}, { logger });
    const { resolver, helper, ask } = made;
    resolver.start();
    try {
      const firsts = await lanesFull(made);
      // Kept off by an earlier quiet whose ten minutes have not run: asked in the helper only.
      helper.avoided.add(`4:${X}`);
      const ping = outcome(ask(X, 4, { waitMs: 60_000 }));
      const http = outcome(ask(X, 4, { waitMs: 60_000 }));
      assert.equal(helper.asksFor(X).length, 0, 'one lookup for both, queued in the helper');
      helper.goQuiet();
      for (const [what, got] of [
        ['the ping check', ping],
        ['the HTTP check', http],
      ] as const) {
        const told = await within(2_000, what, got);
        assert.ok(!told.ok, what);
        assert.equal(codeOf(told.error), RESOLVER_FAULT, what);
        assert.match(messageOf(told.error), KEPT_OFF_X, what);
      }
      resolver.stop();
      const said = summaries().at(-1);
      assert.equal(said?.stopping, true, JSON.stringify(said));
      assert.equal(said.routed?.faulted, 1, 'one lookup refused');
      assert.equal(said.checksFaulted, 2, 'two checks failed at once');
      for (const asked of helper.inFlight()) asked.answer();
      for (const got of await Promise.all(firsts)) assert.ok(got.ok);
    } finally {
      resolver.stop();
    }
  });

  it('a refresh nobody waits for, refused at the quiet, is a lookup and no check, and the next check is served the kept answer', async () => {
    const { logger, summaries } = captured();
    const made = make({}, { logger });
    const { resolver, helper, ask, clock } = made;
    resolver.start();
    try {
      const kept = ask(X);
      helper.last(X).answer(B);
      assert.deepEqual(await kept, B);
      const firsts = await lanesFull(made);
      clock.now = ANSWER_MS;
      await ask('a0.zone-a.test');
      assert.equal(helper.inFlight().length, 5, 'a refresh takes the fifth lane');
      helper.avoided.add(`4:${X}`);
      assert.deepEqual(await ask(X), B, 'served its kept answer, in its grace');
      assert.equal(helper.asksFor(X).length, 1, 'its refresh queued in the helper, no sixth');
      helper.goQuiet();
      await settled();
      assert.deepEqual(await ask(X), B, 'the next check is served the kept answer');
      assert.equal(helper.asksFor(X).length, 1, 'and nothing asked for it');
      resolver.stop();
      const said = summaries().at(-1);
      assert.equal(said?.routed?.faulted, 1, `the refresh refused: ${JSON.stringify(said)}`);
      assert.equal(said.checksFaulted, 0, 'no check failed');
      for (const asked of helper.inFlight()) asked.answer();
      for (const got of await Promise.all(firsts)) assert.ok(got.ok);
    } finally {
      resolver.stop();
    }
  });

  it('a check refused as it asks is one of each; "Check now" served its kept answer is a lookup refused and no check', async () => {
    const { logger, summaries } = captured();
    const { resolver, helper, ask, clock } = make({}, { logger });
    resolver.start();
    try {
      const kept = ask(X);
      helper.last(X).answer(B);
      await kept;
      helper.avoided.add(`4:${X}`);
      helper.goQuiet();
      clock.now = ANSWER_MS + 1;
      assert.deepEqual(await ask(X, 4, { fresh: true }), B, 'Check now: the kept answer');
      clock.now = ANSWER_MS + STALE_MS + 1;
      const refused = await outcome(ask(X));
      assert.ok(!refused.ok && codeOf(refused.error) === RESOLVER_FAULT);
      assert.match(messageOf(refused.error), KEPT_OFF_X);
      assert.equal(helper.asksFor(X).length, 1, 'neither asked anywhere');
      resolver.stop();
      const said = summaries().at(-1);
      assert.equal(said?.routed?.faulted, 2, JSON.stringify(said));
      assert.equal(said.checksFaulted, 1);
    } finally {
      resolver.stop();
    }
  });

  it('"Check now" waiting on a lookup refused as the rejoin window ends is served its kept answer, and is no check faulted', async () => {
    const { logger, summaries } = captured();
    const { resolver, helper, ask, clock } = make({}, { logger });
    resolver.start();
    try {
      const kept = ask(X);
      helper.last(X).answer(B);
      await kept;
      helper.move('rejoining');
      helper.avoided.add(`4:${X}`);
      clock.now = ANSWER_MS + 1;
      const checkNow = outcome(ask(X, 4, { fresh: true, waitMs: 60_000 }));
      assert.equal(await isSettled(checkNow), false, 'waiting for the next child');
      helper.move('down');
      const got = await within(2_000, 'Check now', checkNow);
      assert.ok(got.ok && got.value[0]?.address === B[0]?.address, 'the kept answer');
      resolver.stop();
      const said = summaries().at(-1);
      assert.equal(said?.routed?.faulted, 1, `its lookup refused: ${JSON.stringify(said)}`);
      assert.equal(said.checksFaulted, 0, 'and its check passed');
    } finally {
      resolver.stop();
    }
  });

  it('a stop whose summary fails still stops, saying so', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'error' },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    );
    const { resolver, helper } = make({}, { logger });
    resolver.start();
    helper.stats = () => {
      throw new Error('a helper whose stats fail');
    };
    resolver.stop();
    assert.deepEqual(
      lines.map((line) => line['msg']),
      ['the probe’s resolver failed on its last summary'],
    );
    resolver.stop();
    assert.equal(lines.length, 1, 'stopped: the tick is gone, and nothing more is tried');
  });

  it('the stop says the hour so far, once, with what the hour’s summary had not said, and nothing the stop itself fails', async () => {
    const { logger, summaries } = captured();
    const { resolver, helper, ask, clock } = make({ route: 'down', tickMs: 5 }, { logger });
    resolver.stop();
    assert.equal(summaries().length, 0, 'never started: nothing to say');
    resolver.start();
    try {
      helper.avoided.add(`4:${X}`);
      assert.equal((await outcome(ask(X))).ok, false);
      clock.now += GATE_SUMMARY_MS;
      await pollWithin(1_000, 'the hour’s summary', () => summaries().length === 1, 5);
      const hour = summaries()[0];
      assert.ok(hour !== undefined);
      assert.equal(hour.stopping, undefined, 'the hour’s own is not the stop’s');
      assert.equal(hour.routed?.faulted, 1);
      assert.equal(hour.checksFaulted, 1);
      // Two more refused in the part of the next hour before the stop.
      assert.equal((await outcome(ask(X))).ok, false);
      assert.equal((await outcome(ask(X))).ok, false);
      helper.quiets = 3;
      helper.keptOffPeak = 5;
      // Back up, three lookups in flight in a zone not known to answer, and a fourth queued.
      helper.move('up');
      for (let i = 0; i < 3; i += 1)
        void outcome(ask(`dev-${String(i)}.zone-b.test`, 4, { waitMs: 60_000 }));
      const queued = outcome(ask('dev-9.zone-b.test', 4, { waitMs: 60_000 }));
      assert.equal(helper.inFlight().length, 3);
      resolver.stop();
      const said = summaries();
      assert.equal(said.length, 2, 'said as it stopped');
      const last = said[1];
      assert.equal(last?.stopping, true);
      assert.equal(last.routed?.faulted, 2, 'the two since the hour’s summary, not three');
      assert.equal(last.checksFaulted, 2);
      assert.equal(last.helper?.quiets, 3, 'the helper’s count since the probe started');
      assert.equal(last.helper.keptOffPeak, 5);
      // The helper stops after the resolver: what it then fails is in no summary.
      await helper.stop();
      const got = await queued;
      assert.ok(!got.ok && /the probe is stopping/u.test(messageOf(got.error)));
      resolver.stop();
      assert.equal(summaries().length, 2, 'a second stop says nothing more');
    } finally {
      resolver.stop();
    }
  });
});

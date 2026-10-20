import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { DnsSimulator, replies } from '@ms/simulators';
import {
  caresAsker,
  DEFER_QUIET_MS,
  DnsCheck,
  KEY_FRESH_MS,
  KEY_SAMPLE_MS,
  KEY_SETTLE_MS,
  REWALK_MAX_MS,
  SKIP_MS,
  STAND_DOWN_FIRST_MS,
  stepEndOf,
  type CheckAsk,
  type CheckRoute,
  type DnsCheckOptions,
} from '../src/resolver/dns-check.js';
import { ForwardBudget } from '../src/resolver/forward-budget.js';
import { CONF, ScriptedAsker, WalkPolicy } from './support/fake-dns.js';
import { pollWithin, within } from './support/within.js';

/**
 * The name check (`P-432` S6, §1.3–§1.5, §1.10): where a lookup runs, by what DNS said to a walk
 * of what glibc would ask. A scripted asker plays DNS, on a clock the test moves; the routing
 * wait is a real 60 ms. The c-ares asker is held to the DNS simulator at the end.
 */

const silent = pino({ level: 'silent' });
const ROUTE = 60;

/** A log line, by the fields the test reads. */
interface Line {
  readonly level?: unknown;
  readonly host?: unknown;
  readonly route?: unknown;
  readonly key?: unknown;
  readonly keys?: unknown;
  readonly walkKeys?: unknown;
  readonly why?: unknown;
  readonly server?: unknown;
  readonly pool?: unknown;
  readonly deferred?: unknown;
}

/** A logger whose lines the test reads. */
function captured() {
  const lines: Line[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Line) },
  );
  return { logger, lines };
}

/** The warn lines said, by a field of theirs. */
const warns = (lines: readonly Line[], field: keyof Line): unknown[] =>
  lines.filter((line) => line.level === 40 && field in line).map((line) => line[field]);

function make(options: Partial<DnsCheckOptions> = {}, setup: { proven?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const asker = new ScriptedAsker();
  const policy = new WalkPolicy();
  const budget = new ForwardBudget({ now: () => clock.now });
  const silentKeys: string[] = [];
  const check = new DnsCheck({
    logger: silent,
    policy,
    budget,
    asker,
    now: () => clock.now,
    random: () => 0.5,
    routeMs: ROUTE,
    missMs: 80,
    onKeySilent: (key) => {
      silentKeys.push(key);
    },
    ...options,
  });
  const route = (host: string, ask: Partial<Omit<CheckAsk, 'host'>> = {}): Promise<CheckRoute> =>
    Promise.resolve(
      check.route({
        host,
        family: ask.family ?? 4,
        refresh: ask.refresh ?? false,
        known: ask.known ?? false,
        lastRanMs: ask.lastRanMs,
        boundMs: ask.boundMs ?? 2_000,
        ref: ask.ref ?? {},
      }),
    );
  const prove = async (): Promise<void> => {
    check.start();
    await pollWithin(1_000, 'the canary', () => check.stats().proven, 2);
  };
  const ready = setup.proven === false ? Promise.resolve() : prove();
  return { check, asker, policy, budget, clock, route, silentKeys, ready };
}

const zoneA = (host: string): boolean => host.endsWith('zone-a.test');

describe('the name check routes by the walk’s verdict (P-432 S6, §1.3)', () => {
  it('runs a name every step of whose walk answered on the probe’s lanes, and one not answered in the helper, keyed by its zone', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = (_server, name) => (zoneA(name) ? 'answer' : 'silent');
    const heard = await route('dev-1.zone-a.test');
    assert.deepEqual(heard, { route: 'heard', key: 'd:zone-a.test', keys: ['d:zone-a.test'] });
    const started = performance.now();
    const quiet = await route('dev-1.zone-b.test');
    assert.equal(quiet.route, 'silent');
    assert.equal(quiet.key, 'd:zone-b.test');
    assert.deepEqual(
      quiet.evidence,
      { kind: 'asked', waitMs: ROUTE },
      'its own step, unanswered within its routing wait',
    );
    assert.ok(performance.now() - started >= ROUTE - 5, 'not heard is judged at the deadline');
    assert.deepEqual(asker.names(), ['dev-1.zone-a.test A', 'dev-1.zone-b.test A']);
    check.stop();
  });

  it('walks nothing for a lookup whose routing wait would be under 50 ms, and counts it deferred (§1.3 row 6)', async () => {
    const { check, asker, budget, route, ready } = make();
    await ready;
    const asked = asker.asked.length;
    assert.deepEqual(await route('dev-9.zone-a.test', { boundMs: 199 }), {
      route: 'unvouched',
      key: 'd:zone-a.test',
      why: 'budget',
    });
    assert.equal(asker.asked.length, asked, 'nothing asked');
    assert.equal(budget.stats().deferred.budget, 1);
    assert.equal(
      (await route('dev-9.zone-a.test', { boundMs: 200 })).route,
      'heard',
      '50 ms is walked',
    );
    check.stop();
  });

  it('freshens a key only by a probe-lane answer within the routing wait, and a fresh key’s names ask both types at once (§1.5)', async () => {
    const { check, asker, route, clock, ready } = make({ routeMs: 400 });
    await ready;
    asker.rule = (_server, _name, type) =>
      type === 'A' ? { reply: 'answer', delayMs: 150 } : 'answer';
    assert.equal((await route('dev-1.zone-f.test')).route, 'heard');
    clock.now += KEY_FRESH_MS + 1;
    check.answered('d:zone-f.test', 401);
    // Not fresh: the discovery pool, A first and AAAA only after its reply.
    const second = route('dev-2.zone-f.test', { family: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(asker.names().slice(-1), ['dev-2.zone-f.test A'], 'nothing yet past A');
    assert.equal(asker.askedFor('dev-2.zone-f.test').length, 1, 'A alone');
    assert.equal((await second).route, 'heard');
    clock.now += KEY_FRESH_MS + 1;
    check.answered('d:zone-f.test', 400);
    const third = route('dev-3.zone-f.test', { family: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      asker.askedFor('dev-3.zone-f.test').length,
      2,
      'fresh: the heard pool, both at once',
    );
    assert.equal((await third).route, 'heard');
    check.stop();
  });

  it('asks family 0 for A and AAAA, and hears it only when both answered', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = (_server, _name, type) => (type === 'AAAA' ? 'silent' : 'answer');
    const half = await route('dev-2.zone-a.test', { family: 0 });
    assert.equal(half.route, 'silent', 'AAAA unanswered: not every type was');
    assert.deepEqual(asker.names(), ['dev-2.zone-a.test A', 'dev-2.zone-a.test AAAA']);
    check.stop();
  });

  it('sends nothing for a name of a silent key until its walk again is due, then walks it again', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    // Two scouts: the key's first verdicts.
    await Promise.all([route('dev-1.zone-b.test'), route('dev-2.zone-b.test')]);
    const before = asker.asked.length;
    const later = await route('dev-3.zone-b.test');
    assert.deepEqual(later, {
      route: 'silent',
      key: 'd:zone-b.test',
      miss: undefined,
      evidence: { kind: 'zone', since: clock.now },
    });
    assert.equal(asker.asked.length, before, 'keySilent: nothing sent');
    // Two NotHeards: the second a step further, 10 s; a minute is past any step.
    clock.now += REWALK_MAX_MS + 1;
    await route('dev-4.zone-b.test');
    assert.equal(asker.asked.length, before + 1, 'its walk again, once due');
    const after = await route('dev-5.zone-b.test');
    assert.equal(after.route, 'silent');
    assert.equal(asker.asked.length, before + 1, 'and the next one further off');
    check.stop();
  });

  it('sends at most two scouts for a key never heard of, and the names behind them route by their verdict', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    const held: (() => void)[] = [];
    asker.rule = () => 'silent';
    const first = route('dev-1.zone-a.test');
    const second = route('dev-2.zone-a.test');
    const third = route('dev-3.zone-a.test');
    await pollWithin(1_000, 'two scouts', () => asker.asked.length >= 3, 2);
    assert.deepEqual(
      asker.names(),
      ['dev-1.zone-a.test A', 'dev-2.zone-a.test A'],
      'the third waits on the scouts',
    );
    for (const question of asker.asked) {
      held.push(() => {
        question.release('answer');
      });
    }
    asker.rule = () => 'answer';
    for (const release of held) release();
    assert.equal((await first).route, 'heard');
    assert.equal((await second).route, 'heard');
    const routed = await third;
    assert.equal(routed.route, 'heard', 'woken by the heard verdict, and walked in the heard pool');
    assert.deepEqual(asker.names().at(-1), 'dev-3.zone-a.test A');
    check.stop();
  });

  it('routes a name waiting on scouts that never answer unvouched at its deadline (scoutWait), counted', async () => {
    const { check, asker, route, budget, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const [, , third] = await Promise.all([
      route('dev-1.zone-c.test'),
      route('dev-2.zone-c.test'),
      // A quarter of its bound, 55 ms, before the scouts' 60.
      route('dev-3.zone-c.test', { boundMs: 220 }),
    ]);
    assert.deepEqual(third, { route: 'unvouched', key: 'd:zone-c.test', why: 'scoutWait' });
    assert.equal(budget.stats().deferred.scoutWait, 1);
    check.stop();
  });
});

describe('a key’s phase comes from its verdict times (D18)', () => {
  it('is mixed once both kinds of verdict are within a minute, walks every name of it, and never says keySilent', async () => {
    const { check, asker, route, clock, silentKeys, ready } = make();
    await ready;
    const cached = (name: string): boolean => /dev-[13]\./u.test(name);
    asker.rule = (_server, name) => (cached(name) ? 'answer' : 'silent');
    assert.equal((await route('dev-1.zone-b.test')).route, 'heard');
    assert.equal((await route('dev-2.zone-b.test')).route, 'silent');
    assert.deepEqual(silentKeys, ['d:zone-b.test'], 'mixed: its sampled lookups would move');
    assert.equal(check.stats().mixedKeys, 1);
    const asked = asker.asked.length;
    assert.equal((await route('dev-3.zone-b.test', { known: true })).route, 'heard');
    clock.now += 1;
    assert.equal((await route('dev-4.zone-b.test')).route, 'silent');
    assert.equal(asker.asked.length, asked + 2, 'each name walked, none keySilent');
    // A minute on, the heard verdict is past settling: only NotHeard is newer, and it is silent.
    clock.now += KEY_SETTLE_MS + 1;
    assert.equal(check.stats().mixedKeys, 0);
    assert.equal(check.stats().silentKeys, 1);
    check.stop();
  });

  it('ignores a NotHeard only against a newer Heard of the same name', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-d.test');
    // The same name stuck since it was heard: its zone is silent for none of it.
    check.sampledStuck('d:zone-d.test', clock.now - 1, 'dev-1.zone-d.test');
    assert.equal(check.stats().silentKeys + check.stats().mixedKeys, 0);
    // Another name's says nothing of this one: counted.
    check.sampledStuck('d:zone-d.test', clock.now - 1, 'dev-2.zone-d.test');
    assert.equal(check.stats().mixedKeys, 1);
    check.stop();
  });

  it('releases a scout whose verdict is dropped by a stall, and its waiters route unvouched (D31)', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const scouts = [route('dev-1.zone-e.test'), route('dev-2.zone-e.test')];
    const waiting = route('dev-3.zone-e.test');
    // Every question out and its deadline armed, then the main thread blocked well past it: every
    // timer fires late.
    await new Promise((resolve) => setImmediate(resolve));
    const until = performance.now() + ROUTE + 250;
    while (performance.now() < until) {
      // A stall, as P-243's.
    }
    const routed = await Promise.all([...scouts, waiting]);
    assert.deepEqual(
      routed.map((one) => (one.route === 'unvouched' ? one.why : one.route)),
      ['stall', 'stall', 'stall'],
    );
    assert.equal(check.stats().silentKeys, 0, 'no verdict taken on a stall');
    // The next lookup scouts again: no scout outlived its verdict.
    asker.rule = () => 'answer';
    assert.equal((await route('dev-4.zone-e.test')).route, 'heard');
    check.stop();
  });
});

describe('the walk follows res_send and __res_context_search (§1.4)', () => {
  it('ends a step as glibc does, from what each server said', () => {
    assert.equal(stepEndOf([['answer']]), 'answered');
    assert.equal(stepEndOf([['answer', 'servfail']]), 'answered', 'family 0: server 1’s A stands');
    assert.equal(stepEndOf([['nxdomain']]), 'next');
    assert.equal(stepEndOf([['nodata', 'nxdomain']]), 'next');
    assert.equal(stepEndOf([['nxdomain', 'servfail']]), 'next', 'the name error’s buffer');
    assert.equal(stepEndOf([['formerr']]), 'done', 'FORMERR is the step’s reply (O-OS-8)');
    assert.equal(stepEndOf([['servfail'], ['servfail']]), 'next');
    assert.equal(stepEndOf([['refused'], ['notimp']]), 'done');
    assert.equal(stepEndOf([['refused'], ['servfail']]), 'next', 'the last reply glibc kept');
    assert.equal(
      stepEndOf([['connrefused'], ['connrefused']]),
      'answered',
      'glibc returns at once',
    );
    assert.equal(stepEndOf([['connrefused'], ['servfail']]), 'next');
    assert.equal(stepEndOf([['bad']]), 'bad');
  });

  it('asks the next server only after a fast failure, never after FORMERR', async () => {
    const { check, asker, policy, route, ready } = make();
    policy.conf = { ...CONF, servers: ['10.0.0.53', '10.0.0.54'] };
    await ready;
    asker.rule = (server, name) =>
      server === '10.0.0.53' ? (name.startsWith('fe.') ? 'formerr' : 'servfail') : 'answer';
    assert.equal((await route('sf.zone-a.test')).route, 'heard');
    assert.deepEqual(
      asker.askedFor('sf.zone-a.test').map((q) => q.server),
      ['10.0.0.53', '10.0.0.54'],
    );
    assert.equal((await route('fe.zone-a.test')).route, 'heard');
    assert.deepEqual(
      asker.askedFor('fe.zone-a.test').map((q) => q.server),
      ['10.0.0.53'],
      'FORMERR asks no second server',
    );
    check.stop();
  });

  it('walks the search list on name errors, and is silent where a later candidate is', async () => {
    const { check, asker, policy, route, clock, ready } = make();
    policy.conf = { ...CONF, search: ['a.corp', 'b.corp'], searchFrom: 'search' };
    await ready;
    asker.rule = (_server, name) =>
      name === 'sw-b3.a.corp' ? 'nxdomain' : name === 'sw-b3.b.corp' ? 'silent' : 'answer';
    const routed = await route('sw-b3');
    assert.equal(routed.route, 'silent');
    assert.equal(routed.key, 'd:b.corp', 'keyed by the candidate that went unanswered');
    assert.deepEqual(asker.names(), ['sw-b3.a.corp A', 'sw-b3.b.corp A']);
    // b.corp's walk again due: a name of it is asked again, and answers.
    clock.now += REWALK_MAX_MS + 1;
    asker.rule = (_server, name) => (name === 'sw-a1' ? 'answer' : 'nxdomain');
    const heard = await route('sw-a1');
    assert.ok(heard.route === 'heard', heard.route);
    assert.deepEqual(heard.keys, ['d:a.corp', 'd:b.corp', 'n:sw-a1']);
    check.stop();
  });

  it('ends the search on REFUSED exhausted, and still asks the name as it is', async () => {
    const { check, asker, policy, route, ready } = make();
    policy.conf = { ...CONF, search: ['a.corp', 'b.corp'], searchFrom: 'search' };
    await ready;
    asker.rule = (_server, name) => (name === 'sw-c1.a.corp' ? 'refused' : 'answer');
    assert.equal((await route('sw-c1')).route, 'heard');
    assert.deepEqual(asker.names(), ['sw-c1.a.corp A', 'sw-c1 A'], 'b.corp skipped, as is asked');
    check.stop();
  });

  it('listens to an identical question still open rather than asking it again', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const [one, two] = await Promise.all([route('dev-9.zone-f.test'), route('dev-9.zone-f.test')]);
    assert.equal(one.route, 'silent');
    assert.equal(two.route, 'silent');
    assert.equal(asker.askedFor('dev-9.zone-f.test').length, 1, 'one question once');
    check.stop();
  });
});

describe('the budgets: the pools and each server’s rate (§1.6, D19)', () => {
  it('lets key walks take a server’s last 5 questions and stops name walks there, routing them rate', async () => {
    const { check, asker, route, budget, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    // The canary took one. A heard zone's names walk by name.
    await route('dev-0.zone-g.test');
    let routedRate = 0;
    for (let device = 1; device <= 20; device++) {
      const routed = await route(`dev-${String(device)}.zone-g.test`);
      if (routed.route === 'unvouched' && routed.why === 'rate') routedRate += 1;
    }
    // 20 a burst: the canary 1, the scout 1, then names while more than 5 are left: 13.
    assert.equal(routedRate, 20 - 13);
    assert.equal(budget.stats().deferred.rate, routedRate);
    // A key walk still finds room.
    assert.equal((await route('dev-1.zone-h.test')).route, 'heard');
    check.stop();
  });

  it('holds a step short of room in its pool until its deadline, then routes it budget', async () => {
    const { check, asker, route, budget, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    // Discovery holds 4: two zones' two scouts each.
    const scouts = ['i', 'j'].flatMap((zone) => [
      route(`dev-1.zone-${zone}.test`),
      route(`dev-2.zone-${zone}.test`),
    ]);
    await pollWithin(1_000, 'four scouts', () => budget.walkOpen('discovery') === 4, 2);
    const short = await route('dev-1.zone-k.test');
    assert.deepEqual(short, { route: 'unvouched', key: 'd:zone-k.test', why: 'budget' });
    assert.equal(budget.stats().deferred.budget, 1);
    await Promise.all(scouts);
    check.stop();
  });

  it('routes a step still short of room at its lookup’s own, nearer deadline budget, never silent: nothing was asked', async () => {
    const { logger, lines } = captured();
    const { check, asker, route, budget, ready } = make({ logger });
    await ready;
    asker.rule = () => 'silent';
    const scouts = ['i', 'j'].flatMap((zone) => [
      route(`dev-1.zone-${zone}.test`),
      route(`dev-2.zone-${zone}.test`),
    ]);
    await pollWithin(1_000, 'four scouts', () => budget.walkOpen('discovery') === 4, 2);
    // A routing wait of 55 ms: the lookup's deadline comes before its step's 60.
    const short = await route('dev-1.zone-k.test', { boundMs: 220 });
    assert.deepEqual(short, { route: 'unvouched', key: 'd:zone-k.test', why: 'budget' });
    assert.equal(asker.askedFor('dev-1.zone-k.test').length, 0, 'nothing asked for it');
    assert.equal(budget.stats().deferred.budget, 1, 'counted for the hourly summary');
    assert.deepEqual(warns(lines, 'pool'), ['discovery'], 'the episode said, with its pool');
    await Promise.all(scouts);
    check.stop();
  });

  it('warns at the start of each episode of deferred walks, per server for its rate, with the count so far (S-F10)', async () => {
    const { logger, lines } = captured();
    const { check, asker, policy, route, clock, budget, ready } = make({ logger });
    await ready;
    asker.rule = () => 'answer';
    const burst = async (from: number): Promise<void> => {
      for (let device = from; device < from + 20; device++) {
        await route(`dev-${String(device)}.zone-g.test`);
      }
    };
    await route('dev-0.zone-g.test');
    await burst(1);
    assert.equal(budget.stats().deferred.rate, 7);
    const rated = (): Line[] => lines.filter((line) => line.level === 40 && line.why === 'rate');
    assert.deepEqual(
      rated().map((line) => [line.server, line.deferred]),
      [['10.0.0.53', 1]],
      'one line for the episode, at its first',
    );
    // Another server's rate within the minute: an episode of its own.
    policy.conf = { ...policy.conf, servers: ['10.0.0.54'] };
    await burst(100);
    assert.deepEqual(
      rated().map((line) => line.server),
      ['10.0.0.53', '10.0.0.54'],
    );
    // A minute with none for the first server: its next deferral starts another.
    policy.conf = { ...policy.conf, servers: ['10.0.0.53'] };
    clock.now += DEFER_QUIET_MS;
    await burst(200);
    const said = rated();
    assert.equal(said.length, 3);
    assert.equal(said[2]?.server, '10.0.0.53');
    assert.ok(Number(said[2].deferred) > 7, 'the count so far');
    check.stop();
  });
});

describe('refresh sampling (D20)', () => {
  const ref = (): object => ({});

  it('lets a refresh ride its zone’s heard walk from the last second, at most two since its last answer', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    const asked = asker.asked.length;
    const refs = [ref(), ref(), ref()];
    const ride = (i: number) =>
      route(`dev-${String(i + 2)}.zone-a.test`, {
        refresh: true,
        lastRanMs: 3,
        ref: refs[i] ?? ref(),
      });
    assert.equal((await ride(0)).route, 'sampled');
    assert.equal((await ride(1)).route, 'sampled');
    assert.equal((await ride(2)).route, 'heard', 'a third is walked');
    assert.equal(asker.asked.length, asked + 1);
    // One answers: the zone's later sampled lookups count from there.
    check.answered('d:zone-a.test', 2);
    assert.equal((await ride(2)).route, 'sampled');
    // Past a second since the newest heard step, none rides.
    clock.now += KEY_SAMPLE_MS + 1;
    assert.equal(
      (await route('dev-9.zone-a.test', { refresh: true, lastRanMs: 3, ref: ref() })).route,
      'heard',
    );
    check.stop();
  });

  it('never samples a first lookup, a slow name, a single label or an unsafe zone', async () => {
    const { check, asker, policy, route, ready } = make();
    policy.conf = { ...CONF, search: ['a.corp'], searchFrom: 'search' };
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    for (const [why, host, ask] of [
      ['not a refresh', 'dev-2.zone-a.test', { refresh: false, lastRanMs: 3 }],
      ['its own last getaddrinfo slow', 'dev-3.zone-a.test', { refresh: true, lastRanMs: 251 }],
      ['never answered', 'dev-4.zone-a.test', { refresh: true }],
    ] as const) {
      assert.equal((await route(host, { ...ask, ref: ref() })).route, 'heard', why);
    }
    await route('sw-a1.a.corp');
    // A single label's first candidate is a search domain's: never asked as it is first.
    assert.notEqual(
      (await route('sw-a1', { refresh: true, lastRanMs: 3, ref: ref() })).route,
      'sampled',
    );
    check.markUnsafe(['d:zone-a.test']);
    assert.deepEqual(
      await route('dev-5.zone-a.test', { refresh: true, lastRanMs: 3, ref: ref() }),
      {
        route: 'unvouched',
        key: 'd:zone-a.test',
        why: 'unsafe',
      },
    );
    check.stop();
  });

  it('records NotHeard for a zone whose sampled lookup stuck, never unsafe, and moves its queued sampled lookups', async () => {
    const { check, asker, route, clock, silentKeys, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    check.sampledStuck('d:zone-a.test', clock.now, 'dev-7.zone-a.test');
    assert.deepEqual(silentKeys, ['d:zone-a.test']);
    assert.equal(
      (await route('dev-8.zone-a.test', { refresh: true, lastRanMs: 3, ref: ref() })).route,
      'heard',
      'mixed: walked, not ridden',
    );
    check.stop();
  });
});

describe('proven, misses and the stand-down (§1.10, N8)', () => {
  it('walks nothing until the canary or a walk is answered, and asks the canary of the first server', async () => {
    const { check, asker, route } = make({}, { proven: false });
    asker.rule = () => 'silent';
    check.start();
    assert.deepEqual(await route('dev-1.zone-a.test'), {
      route: 'unvouched',
      key: 'd:zone-a.test',
      why: 'unproven',
    });
    assert.equal(check.state(), 3);
    assert.deepEqual(
      asker.asked.map((q) => `${q.server} ${q.name} ${q.type}`),
      ['10.0.0.53 localhost. A'],
    );
    asker.asked[0]?.release('nxdomain');
    await pollWithin(1_000, 'proven', () => check.stats().proven, 2);
    assert.equal(check.state(), 1);
    check.stop();
  });

  it('skips a name the helper answered and the walk missed, then its zone after three, and stands down after three zones, doubling within a day', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const missed = async (host: string): Promise<void> => {
      const routed = await route(host);
      assert.ok(routed.route === 'silent' && routed.miss !== undefined, `${host} watched`);
      check.helperAnswered(routed.miss, 5);
    };
    const zones = ['m', 'n', 'o'];
    // Three names of each zone, each its key's walk again, due a minute at most after the last.
    const round = async (first: number): Promise<void> => {
      for (const zone of zones) {
        for (let device = first; device < first + 3; device++) {
          clock.now += REWALK_MAX_MS + 1;
          await missed(`dev-${String(device)}.zone-${zone}.test`);
        }
      }
    };
    await round(1);
    await pollWithin(2_000, 'nine misses', () => check.stats().misses === 9, 5);
    assert.deepEqual((await route('dev-1.zone-m.test')).route, 'unvouched');
    assert.equal(check.state(), 4, 'stood down');
    assert.deepEqual(await route('dev-1.zone-z.test'), {
      route: 'unvouched',
      key: 'd:zone-z.test',
      why: 'standDown',
    });
    clock.now += STAND_DOWN_FIRST_MS + 1;
    assert.equal(check.state(), 1, 'over after an hour');
    assert.equal(check.stats().standDowns, 1);
    // A watched-file change clears every skip; a second stand-down within a day lasts two hours.
    asker.rule = (_server, name) => (name === 'localhost.' ? 'nxdomain' : 'silent');
    check.reset();
    await pollWithin(1_000, 'proven again', () => check.stats().proven, 2);
    await round(4);
    await pollWithin(2_000, 'nine more', () => check.stats().misses === 18, 5);
    assert.equal(check.state(), 4);
    clock.now += STAND_DOWN_FIRST_MS + 1;
    assert.equal(check.state(), 4, 'doubled: still down after an hour');
    clock.now += STAND_DOWN_FIRST_MS;
    assert.equal(check.state(), 1);
    void SKIP_MS;
    check.stop();
  });

  it('skips a missed name for an hour, and its zone once three of its names were missed, walking its other names meanwhile', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const miss = async (host: string): Promise<void> => {
      clock.now += REWALK_MAX_MS + 1;
      const routed = await route(host);
      assert.ok(routed.route === 'silent' && routed.miss !== undefined, `${host} walked`);
      const misses = check.stats().misses;
      check.helperAnswered(routed.miss, 5);
      await pollWithin(1_000, `${host} missed`, () => check.stats().misses === misses + 1, 5);
    };
    const skipped = { route: 'unvouched', key: 'd:zone-s.test', why: 'skip' };
    await miss('dev-1.zone-s.test');
    clock.now += REWALK_MAX_MS + 1;
    assert.deepEqual(await route('dev-1.zone-s.test'), skipped, 'the name skips');
    await miss('dev-2.zone-s.test');
    await miss('dev-3.zone-s.test');
    clock.now += REWALK_MAX_MS + 1;
    assert.deepEqual(await route('dev-4.zone-s.test'), skipped, 'the zone skips');
    assert.equal(check.state(), 1, 'one zone: no stand-down');
    clock.now += SKIP_MS;
    assert.equal((await route('dev-4.zone-s.test')).route, 'silent', 'walked again after the hour');
    check.stop();
  });

  it('skips a missed name asked with a trailing dot, as the resolver keys it', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const routed = await route('dev-1.zone-t.test.');
    assert.ok(routed.route === 'silent' && routed.miss !== undefined, 'walked');
    check.helperAnswered(routed.miss, 5);
    await pollWithin(1_000, 'missed', () => check.stats().misses === 1, 5);
    clock.now += REWALK_MAX_MS + 1;
    const walks = asker.asked.length;
    assert.deepEqual(await route('dev-1.zone-t.test.'), {
      route: 'unvouched',
      key: 'd:zone-t.test',
      why: 'skip',
    });
    assert.equal(asker.asked.length, walks, 'not walked again');
    check.stop();
  });

  it('counts no miss when the walk’s question was answered after all, or the helper was slow', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const late = await route('dev-1.zone-p.test');
    assert.ok(late.route === 'silent' && late.miss !== undefined);
    check.helperAnswered(late.miss, 5);
    asker.askedFor('dev-1.zone-p.test')[0]?.release('answer');
    const slow = await route('dev-1.zone-p2.test');
    assert.ok(slow.route === 'silent' && slow.miss !== undefined);
    check.helperAnswered(slow.miss, 1_001);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(check.stats().misses, 0);
    check.stop();
  });
});

describe('the OS’s own evidence and the gate’s marks (§1.5, D25)', () => {
  it('takes a never-walked helper lookup said stuck as NotHeard for a key never heard of', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    check.helperStuck('dev-1.zone-q.test', 4, true);
    assert.equal(check.stats().silentKeys, 0, 'a walked lookup is not the OS’s evidence');
    check.helperStuck('dev-1.zone-q.test', 4, false);
    assert.equal(check.stats().silentKeys, 1);
    assert.equal((await route('dev-2.zone-q.test')).route, 'silent', 'keySilent');
    // A key heard of already is not judged by it.
    await route('dev-1.zone-r.test');
    check.helperStuck('dev-2.zone-r.test', 4, false);
    assert.equal(check.stats().silentKeys, 1);
    check.stop();
  });

  it('says each zone marked unsafe, a second zone within the minute as well as the first', async () => {
    const { logger, lines } = captured();
    const { check, ready } = make({ logger });
    await ready;
    check.markUnsafe(['d:zone-u.test']);
    check.markUnsafe(['d:zone-v.test', 'd:zone-u.test']);
    check.markUnsafe(['d:zone-u.test']);
    assert.deepEqual(warns(lines, 'keys'), [['d:zone-u.test'], ['d:zone-v.test']]);
    check.stop();
  });

  it('walks a local name that passed stuck, keyed by its own name, for an hour', async () => {
    const { check, asker, policy, route, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    policy.local = (host) => host === 'gw.zone-a.test';
    assert.equal((await route('gw.zone-a.test')).route, 'local');
    check.markWalked('gw.zone-a.test');
    const walked = await route('gw.zone-a.test');
    assert.deepEqual(walked, {
      route: 'heard',
      key: 'n:gw.zone-a.test',
      keys: ['n:gw.zone-a.test'],
    });
    check.stop();
  });

  it('routes every name unvouched while the policy’s check is off, and asks no canary', async () => {
    const { check, asker, policy, route } = make({}, { proven: false });
    policy.off = { code: 'nsswitch', why: 'a test' };
    check.start();
    assert.equal(check.state(), 2);
    assert.deepEqual(await route('dev-1.zone-a.test'), {
      route: 'unvouched',
      key: 'd:zone-a.test',
      why: 'off',
    });
    assert.deepEqual(asker.asked, []);
    check.stop();
  });
});

describe('c-ares as the check asks with it, against the DNS simulator (§1.4)', () => {
  it('reads each reply as the walk does, one fresh channel per server, and routes a walk by it', async (t) => {
    const sim = await DnsSimulator.start({
      zones: {
        'zone-a.test': { reply: replies.addresses('192.0.2.10', '2001:db8::10') },
        'zone-b.test': { reply: replies.silent },
      },
      names: {
        'nodata.zone-a.test': { reply: replies.nodata },
        'servfail.test': { reply: replies.servfail },
        'refused.test': { reply: replies.refused },
        'notimp.test': { reply: replies.notimp },
        'formerr.test': { reply: replies.formerr },
      },
      ipv6: false,
    });
    t.after(() => sim.stop());
    const { port, ipv4 } = sim.server();
    const asker = caresAsker({ port, timeoutMs: 300 });
    const ask = async (name: string, type: 'A' | 'AAAA' = 'A') => {
      const channel = asker.channel(ipv4);
      try {
        return await within(2_000, name, channel.ask(name, type));
      } finally {
        channel.close();
      }
    };
    assert.equal(await ask('dev-1.zone-a.test'), 'answer');
    assert.equal(await ask('dev-1.zone-a.test', 'AAAA'), 'answer');
    assert.equal(await ask('nodata.zone-a.test'), 'nodata');
    assert.equal(await ask('nowhere.test'), 'nxdomain');
    assert.equal(await ask('servfail.test'), 'servfail');
    assert.equal(await ask('refused.test'), 'refused');
    assert.equal(await ask('notimp.test'), 'notimp');
    assert.equal(await ask('formerr.test'), 'formerr');
    assert.equal(await ask('dev-1.zone-b.test'), 'timeout');
    // A server with nothing bound: ECONNREFUSED.
    const dead = await DnsSimulator.start({
      servers: [{ name: 'dead', dead: 'refused' }],
      ipv6: false,
    });
    t.after(() => dead.stop());
    const refusing = caresAsker({ port: dead.server().port, timeoutMs: 300 }).channel('127.0.0.1');
    assert.equal(await within(2_000, 'refused', refusing.ask('x.test', 'A')), 'connrefused');
    refusing.close();

    // The check over the simulator: zone A heard, zone B silent, each asked once.
    const policy = new WalkPolicy();
    policy.conf = { ...CONF, servers: [ipv4] };
    const check = new DnsCheck({
      logger: silent,
      policy,
      budget: new ForwardBudget({ now: () => performance.now() }),
      asker: caresAsker({ port }),
      now: () => performance.now(),
    });
    check.start();
    await pollWithin(2_000, 'the canary', () => check.stats().proven, 5);
    const at = (host: string) =>
      Promise.resolve(
        check.route({
          host,
          family: 0,
          refresh: false,
          known: false,
          lastRanMs: undefined,
          boundMs: 2_000,
          ref: {},
        }),
      );
    assert.equal((await at('dev-2.zone-a.test')).route, 'heard');
    assert.equal((await at('dev-2.zone-b.test')).route, 'silent');
    check.stop();
    const log = await sim.log();
    assert.deepEqual(
      log
        .filter((entry) => entry.qname.startsWith('dev-2.'))
        .map((entry) => `${entry.qname} ${entry.qtype}`),
      ['dev-2.zone-a.test A', 'dev-2.zone-a.test AAAA', 'dev-2.zone-b.test A'],
      'discovery asks A first, AAAA after its reply: a silent zone holds one question',
    );
  });
});

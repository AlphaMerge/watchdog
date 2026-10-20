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
  SAMPLED_PER_KEY,
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
/**
 * How late a deadline's timer may fire here before its verdict is dropped as a stall (D31): a
 * minute. A loaded test host fires a timer over `LATE_MS` late now and then, which is not a stalled
 * probe, and a test whose silence came back `stall` failed for it (`P-470`). The stall's own test
 * runs on the check's default, `LATE_MS`, so that the probe's own threshold is held by it.
 */
const LATE = 60_000;

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

/**
 * A check over a scripted asker. `defaultLate` leaves `lateMs` unset, so the check takes the
 * probe's own `LATE_MS`; otherwise the file's minute.
 */
function make(
  options: Partial<DnsCheckOptions> = {},
  setup: { proven?: boolean; defaultLate?: boolean } = {},
) {
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
    ...(setup.defaultLate === true ? {} : { lateMs: LATE }),
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
    // The scouts' verdict at 5 s, their own lookups routed at a quarter of their 400 ms bound:
    // only a verdict wakes the third, and none comes near its deadline. With the scouts' verdict
    // 5 ms after it (60 ms against 55), a loaded host that paused 5 ms between the test's calls
    // put the verdict first, and the third routed silent (`P-470`).
    const { check, asker, route, budget, ready } = make({ routeMs: 5_000 });
    await ready;
    asker.rule = () => 'silent';
    const [, , third] = await Promise.all([
      route('dev-1.zone-c.test', { boundMs: 400 }),
      route('dev-2.zone-c.test', { boundMs: 400 }),
      // A quarter of its bound, 55 ms.
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
    // A silent name's route can come before its key's NotHeard (`P-470`). The step takes the
    // verdict at a deadline read from the clock as it is sent, and the lookup routes at one read
    // as it was asked; the two are one only within `SAME_DEADLINE_MS`, which a loaded host's pause
    // between the reads exceeds. Each NotHeard here, mixed, says `onKeySilent`: the test reads
    // the verdicts once that many have been taken. A Heard comes with its route, its reply first.
    const notHeards = (count: number): Promise<void> =>
      pollWithin(1_000, `NotHeard verdict ${String(count)}`, () => silentKeys.length === count, 2);
    assert.equal((await route('dev-1.zone-b.test')).route, 'heard');
    assert.equal((await route('dev-2.zone-b.test')).route, 'silent');
    await notHeards(1);
    assert.deepEqual(silentKeys, ['d:zone-b.test'], 'mixed: its sampled lookups would move');
    assert.equal(check.stats().mixedKeys, 1);
    const asked = asker.asked.length;
    assert.equal((await route('dev-3.zone-b.test', { known: true })).route, 'heard');
    clock.now += 1;
    assert.equal((await route('dev-4.zone-b.test')).route, 'silent');
    await notHeards(2);
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
    // `lateMs` left unset: the probe's own threshold, so that its default is held here too.
    const { check, asker, route, ready } = make({}, { defaultLate: true });
    await ready;
    asker.rule = () => 'silent';
    const scouts = [route('dev-1.zone-e.test'), route('dev-2.zone-e.test')];
    const waiting = route('dev-3.zone-e.test');
    // Every question out and its deadline armed, then the main thread blocked well past it: every
    // timer fires about 250 ms late, past the probe's `LATE_MS` (100 ms). The stall is a fixed
    // length, so that a default raised past it fails here too.
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

  it('takes the verdict of a timer late by less than its `lateMs`, as these tests set it (`P-470`)', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = () => 'silent';
    const scouts = [route('dev-1.zone-u.test'), route('dev-2.zone-u.test')];
    // The same stall as above, against a minute.
    await new Promise((resolve) => setImmediate(resolve));
    const until = performance.now() + ROUTE + 250;
    while (performance.now() < until) {
      // A stall.
    }
    const routed = await Promise.all(scouts);
    assert.deepEqual(
      routed.map((one) => one.route),
      ['silent', 'silent'],
    );
    // Its NotHeards, which can come after their routes, as the first test here says.
    await pollWithin(1_000, 'the verdicts taken', () => check.stats().silentKeys === 1, 2);
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

/**
 * A refresh as the resolver asks the check for one (§1.3): its last `getaddrinfo` answered in 3 ms,
 * nobody waiting on it. Routed as the resolver routes it, so a route given at once is not a promise.
 */
function refresh(
  check: DnsCheck,
  host: string,
  ref: object = {},
): CheckRoute | Promise<CheckRoute> {
  return check.route({
    host,
    family: 4,
    refresh: true,
    known: true,
    lastRanMs: 3,
    boundMs: undefined,
    ref,
  });
}

/** Each kind of route, counted: `unvouched` by why. */
function kinds(routes: readonly CheckRoute[]): Record<string, number> {
  const counted: Record<string, number> = {};
  for (const one of routes) {
    const kind = one.route === 'unvouched' ? `unvouched:${one.why}` : one.route;
    counted[kind] = (counted[kind] ?? 0) + 1;
  }
  return counted;
}

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * The wheel's burst (`P-477`): a zone's refreshes routed in one turn, before any of their answers,
 * as each second's due checks reach the pool together. Each one that runs on the probe's lanes,
 * riding or walked, answers a macrotask after it is routed, as `getaddrinfo` does, and the check is
 * told as the resolver's `#gateSettled` tells it: a rider's place given back, then the zone's
 * answer. `atOnce` is how many were routed in the turn itself.
 */
function burst(check: DnsCheck, hosts: readonly string[]) {
  const routed = hosts.map((host) => {
    const ref = {};
    return { ref, now: refresh(check, host, ref) };
  });
  const atOnce = routed.filter(({ now }) => !(now instanceof Promise)).length;
  const settled = Promise.all(
    routed.map(async ({ ref, now }) => {
      const one = await now;
      if (one.route === 'sampled' || one.route === 'heard') {
        setImmediate(() => {
          if (one.route === 'sampled') check.sampledEnded(one.key, ref);
          check.answered(one.key, 2);
        });
      }
      return one;
    }),
  );
  return { atOnce, settled };
}

describe('refresh sampling (D20)', () => {
  const ref = (): object => ({});

  it('lets a refresh ride its zone’s heard walk from the last second, at most two since its last answer: a third waits for the zone’s next answer, then rides', async () => {
    const { check, asker, route, clock, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    const asked = asker.asked.length;
    const [two, three, four, five, six] = [ref(), ref(), ref(), ref(), ref()] as const;
    const atOnce = (routed: CheckRoute | Promise<CheckRoute>): CheckRoute => {
      assert.ok(!(routed instanceof Promise), 'routed at once');
      return routed;
    };
    assert.equal(atOnce(refresh(check, 'dev-2.zone-a.test', two)).route, 'sampled');
    assert.equal(atOnce(refresh(check, 'dev-3.zone-a.test', three)).route, 'sampled');
    // Each is told in the turn it is routed in: no timer can have fired between.
    const third = refresh(check, 'dev-4.zone-a.test', four);
    assert.ok(third instanceof Promise, 'a third waits');
    assert.equal(asker.asked.length, asked, 'and walks nothing meanwhile');
    // Another lookup of the zone answers on the probe's lanes: the two out count no more.
    check.answered('d:zone-a.test', 2);
    assert.equal(
      (await third).route,
      'sampled',
      'a third waits for the zone’s next answer, then rides',
    );
    // Counted from that answer: one more rides, and the next waits until one of the two is let go.
    assert.equal(atOnce(refresh(check, 'dev-5.zone-a.test', five)).route, 'sampled');
    const fifth = refresh(check, 'dev-6.zone-a.test', six);
    assert.ok(fifth instanceof Promise, 'two out since the answer: the next waits');
    check.sampledEnded('d:zone-a.test', four);
    assert.equal((await fifth).route, 'sampled', 'a rider settled: its place is free');
    assert.equal(asker.asked.length, asked, 'none of them walked');
    // Past a second since the newest heard step, the window is closed: one walks, the zone's pilot.
    clock.now += KEY_SAMPLE_MS + 1;
    assert.equal(
      (await route('dev-9.zone-a.test', { refresh: true, lastRanMs: 3, ref: ref() })).route,
      'heard',
    );
    assert.equal(asker.asked.length, asked + 1);
    check.stop();
  });

  it('holds a burst of a heard zone’s refreshes routed in one turn to the design’s count: none walked in an open window, one pilot in a closed one, the rest riding (P-477)', async () => {
    // The routing wait 5 s: a wait is ended by the zone, never by a loaded host's pause.
    const { check, asker, clock, route, ready } = make({ routeMs: 5_000 });
    await ready;
    asker.rule = () => 'answer';
    assert.equal((await route('dev-1.zone-a.test')).route, 'heard');
    const hosts = (from: number): string[] =>
      Array.from({ length: 12 }, (_, i) => `dev-${String(from + i)}.zone-a.test`);
    const asked = asker.names().length;
    const open = burst(check, hosts(2));
    assert.equal(open.atOnce, SAMPLED_PER_KEY, 'two ride at once, the rest wait');
    assert.equal(asker.names().length, asked, 'nothing walked in the turn');
    assert.deepEqual(kinds(await open.settled), { sampled: 12 });
    assert.equal(asker.names().length, asked, 'the window open: no question');
    await macrotask();
    // A second on: no heard step of the zone sent within it.
    clock.now += KEY_SAMPLE_MS + 1;
    const closed = burst(check, hosts(20));
    assert.equal(closed.atOnce, 0, 'none rides a closed window');
    assert.equal(asker.names().length, asked + 1, 'one walks, as the zone’s pilot');
    assert.deepEqual(kinds(await closed.settled), { heard: 1, sampled: 11 });
    assert.equal(asker.names().length, asked + 1, 'the window closed: the pilot’s one question');
    await macrotask();
    // The next closed window has a pilot of its own: the last one's verdict let it go.
    clock.now += KEY_SAMPLE_MS + 1;
    const again = burst(check, hosts(40));
    assert.deepEqual(kinds(await again.settled), { heard: 1, sampled: 11 });
    assert.equal(asker.names().length, asked + 2);
    check.stop();
  });

  it('walks at most 1 + keys × q questions a second over 90 simulated seconds of the wheel’s bursts, two zones refreshed (§7.6, P-477)', async (t) => {
    // The check's clock is the test's: each simulated second moves it, and the routing wait of
    // 5 s is never reached, so no real time passes but what the bursts take.
    const { check, asker, clock, route, ready } = make({ routeMs: 5_000 });
    await ready;
    asker.rule = () => 'answer';
    assert.equal((await route('dev-0.zone-a.test')).route, 'heard');
    assert.equal((await route('dev-0.zone-b.test')).route, 'heard');
    const before = asker.names().length;
    const SECONDS = 90;
    const keys = 2;
    // Family 4: one question a walk.
    const q = 1;
    // Each tick some ms off a second from the last, as the wheel's are, so that a zone's window is
    // closed at some of its bursts and open at others.
    const jitter = (second: number): number => (second * 13) % 29;
    // A zone of 120 names and one of 20, each name refreshed every 10 s.
    const names = (zone: string, size: number, count: number, second: number): string[] =>
      Array.from(
        { length: count },
        (_, i) => `dev-${String(((second * count + i) % size) + 1)}.${zone}.test`,
      );
    const routes: CheckRoute[] = [];
    let closed = 0;
    for (let second = 1; second <= SECONDS; second++) {
      const step = 1_000 + jitter(second) - jitter(second - 1);
      clock.now += step;
      if (step > KEY_SAMPLE_MS) closed += 1;
      const a = burst(check, names('zone-a', 120, 12, second));
      const b = burst(check, names('zone-b', 20, 2, second));
      routes.push(...(await a.settled), ...(await b.settled));
      await macrotask();
    }
    assert.ok(closed > 0 && closed < SECONDS, 'some ticks past a second from the last, some short');
    const walked = asker.names().length - before;
    t.diagnostic(
      `${String(walked)} questions in ${String(SECONDS)} s, ${String(closed)} ticks past a second from the last`,
    );
    assert.ok(
      walked <= (1 + keys * q) * SECONDS,
      `${String(walked)} questions in ${String(SECONDS)} s, past 1 + ${String(keys)} keys × q a second`,
    );
    assert.deepEqual(
      Object.keys(kinds(routes)).sort(),
      ['heard', 'sampled'],
      'every refresh rode its zone or walked as its pilot',
    );
    assert.equal(kinds(routes)['heard'], walked, 'each walk a pilot’s');
    check.stop();
  });

  it('holds a zone to two riders in an outage, and once a stuck rider makes it not heard, its waiting refreshes walk by name and none rides (D20, P-477)', async () => {
    const riders: object[] = [];
    let moved = 0;
    const told: { check?: DnsCheck } = {};
    const { check, asker, clock, route, ready } = make({
      // As the resolver's `#keySilent`: the zone's sampled lookups still queued go to the helper,
      // and give back their places. The first rider runs; the second is queued.
      onKeySilent: (key) => {
        for (const rider of riders.slice(1)) {
          told.check?.sampledEnded(key, rider);
          moved += 1;
        }
      },
    });
    told.check = check;
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    // The zone stops answering, and its refreshes' getaddrinfo with it: no rider answers.
    asker.rule = () => 'silent';
    const walked = check.stats().walked;
    const asked = asker.names().length;
    const hosts = Array.from({ length: 12 }, (_, i) => `dev-${String(i + 2)}.zone-a.test`);
    const routed = hosts.map((host) => {
      const one = {};
      return { one, now: refresh(check, host, one) };
    });
    const atOnce = routed.filter(({ now }) => !(now instanceof Promise));
    assert.equal(atOnce.length, SAMPLED_PER_KEY, 'two ride, whatever the burst');
    assert.equal(asker.names().length, asked, 'the rest wait, and walk nothing');
    riders.push(...atOnce.map(({ one }) => one));
    // In the same turn, the first rider passes stuck: NotHeard for its zone, as of its start.
    check.sampledStuck('d:zone-a.test', clock.now, 'dev-2.zone-a.test');
    assert.equal(moved, 1, 'the queued rider moved, its place given back');
    const routes = await Promise.all(routed.map(({ now }) => Promise.resolve(now)));
    assert.deepEqual(kinds(routes.slice(0, 2)), { sampled: 2 });
    const waited = routes.slice(2);
    assert.equal(kinds(waited)['sampled'], undefined, 'none rides a zone not heard');
    assert.equal(
      check.stats().walked,
      walked + waited.length,
      'each walked by its own name, as a mixed zone’s names are',
    );
    assert.equal(check.stats().mixedKeys, 1);
    check.stop();
  });

  it('routes a refresh still waiting at its deadline unvouched, as a stall, counted, with nothing walked for it (D31, P-477)', async () => {
    const { check, asker, budget, route, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    const asked = asker.names().length;
    // Two riders that never answer, and a third waiting on them.
    void refresh(check, 'dev-2.zone-a.test');
    void refresh(check, 'dev-3.zone-a.test');
    assert.deepEqual(await refresh(check, 'dev-4.zone-a.test'), {
      route: 'unvouched',
      key: 'd:zone-a.test',
      why: 'stall',
    });
    assert.equal(budget.stats().deferred.stall, 1, 'counted with the walks deferred');
    assert.equal(asker.names().length, asked, 'nothing walked for it');
    check.stop();
  });

  it('routes a refresh woken to ride just before the check starts again from nothing as a stall, walking nothing (§1.12, P-477)', async () => {
    const { check, asker, route, ready } = make();
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    void refresh(check, 'dev-2.zone-a.test');
    void refresh(check, 'dev-3.zone-a.test');
    const third = refresh(check, 'dev-4.zone-a.test');
    assert.ok(third instanceof Promise, 'waiting for a place');
    // The zone answers, and in the same turn a watched file changes.
    check.answered('d:zone-a.test', 2);
    check.reset();
    assert.deepEqual(await third, { route: 'unvouched', key: 'd:zone-a.test', why: 'stall' });
    assert.equal(asker.askedFor('dev-4.zone-a.test').length, 0, 'nothing walked');
    check.stop();
  });

  it('routes a waiting refresh released with under 50 ms of its routing wait left as a stall, with no walk (§1.3 row 6, P-477)', async () => {
    // The check's real clock is the test's: what is left of a wait is set, not slept for.
    const real = { now: 0 };
    const { check, asker, budget, clock, route, ready } = make({
      routeMs: 5_000,
      realNow: () => real.now,
    });
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    asker.rule = () => 'silent';
    void refresh(check, 'dev-2.zone-a.test');
    void refresh(check, 'dev-3.zone-a.test');
    const third = refresh(check, 'dev-4.zone-a.test');
    assert.ok(third instanceof Promise, 'waiting for a place');
    // 40 ms of its 5 s left when a stuck rider makes the zone not heard, and the wait ends.
    real.now += 5_000 - 40;
    check.sampledStuck('d:zone-a.test', clock.now, 'dev-2.zone-a.test');
    assert.deepEqual(await third, { route: 'unvouched', key: 'd:zone-a.test', why: 'stall' });
    assert.equal(asker.askedFor('dev-4.zone-a.test').length, 0, 'nothing walked');
    assert.equal(budget.stats().deferred.stall, 1);
    check.stop();
  });

  it('routes the refreshes waiting on a pilot whose walk was refused as stalls at once, and the next closed window has a pilot of its own (D31, P-477)', async () => {
    const { check, asker, clock, route, ready } = make({ routeMs: 5_000 });
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    await route('dev-1.zone-h.test');
    clock.now += KEY_SAMPLE_MS + 1;
    // Another zone's names spend the server's questions down to the 5 kept for key walks (D19).
    let spent = false;
    for (let device = 2; device < 40 && !spent; device++) {
      const one = await route(`dev-${String(device)}.zone-h.test`);
      spent = one.route === 'unvouched' && one.why === 'rate';
    }
    assert.ok(spent, 'the server’s rate spent');
    const asked = asker.names().length;
    const routed = ['dev-2', 'dev-3', 'dev-4'].map((device) =>
      Promise.resolve(refresh(check, `${device}.zone-a.test`)),
    );
    let settled = 0;
    for (const one of routed) {
      void one.then(() => {
        settled += 1;
      });
    }
    // Before any timer: the pilot's verdict dropped wakes them, not their deadlines.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, 3, 'every one routed before a timer fired');
    assert.deepEqual(kinds(await Promise.all(routed)), {
      'unvouched:rate': 1,
      'unvouched:stall': 2,
    });
    assert.equal(asker.names().length, asked, 'nothing asked');
    // A second on, the server has questions again, and the zone's window is still closed.
    clock.now += KEY_SAMPLE_MS + 1;
    assert.equal((await refresh(check, 'dev-5.zone-a.test')).route, 'heard', 'a pilot of its own');
    check.stop();
  });

  it('keeps a refresh waiting for a place while another walk of its zone is deferred: only a scout’s or a pilot’s lost verdict is waited on (P-477)', async () => {
    const { check, asker, route, ready } = make({ routeMs: 5_000 });
    await ready;
    asker.rule = () => 'answer';
    await route('dev-1.zone-a.test');
    await route('dev-1.zone-h.test');
    // Down to the server's last 5 questions, with the zone's window still open.
    let spent = false;
    for (let device = 2; device < 40 && !spent; device++) {
      const one = await route(`dev-${String(device)}.zone-h.test`);
      spent = one.route === 'unvouched' && one.why === 'rate';
    }
    assert.ok(spent, 'the server’s rate spent');
    void refresh(check, 'dev-2.zone-a.test');
    void refresh(check, 'dev-3.zone-a.test');
    const third = refresh(check, 'dev-4.zone-a.test');
    assert.ok(third instanceof Promise, 'waiting for a place');
    // A first lookup of the zone is walked by name, and the server's rate refuses it.
    assert.deepEqual(await route('dev-5.zone-a.test'), {
      route: 'unvouched',
      key: 'd:zone-a.test',
      why: 'rate',
    });
    check.answered('d:zone-a.test', 2);
    assert.equal(
      (await third).route,
      'sampled',
      'still waiting, and riding once the zone answered',
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
      lateMs: LATE,
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

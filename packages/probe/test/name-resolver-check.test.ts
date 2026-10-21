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
  type ResolvedAddress,
} from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { REWALK_FIRST_MS, REWALK_JITTER } from '../src/resolver/dns-check.js';
import { FORWARD_HOLD_MS, ForwardBudget, WALK_QUESTIONS } from '../src/resolver/forward-budget.js';
import { HelperKeys } from '../src/resolver/lane-rule.js';
import {
  ANSWER_MS,
  CHECK_STATE_SAID,
  GATE_SUMMARY_MS,
  NameResolver,
  STALE_MS,
  SUMMARY_LISTED,
  type Family,
} from '../src/resolver/name-resolver.js';
import { HelperLostError } from '../src/resolver/lookup-helper.js';
import { ScriptedAsker, WalkPolicy, type ScriptedReply } from './support/fake-dns.js';
import { FakeHelper } from './support/fake-helper.js';
import { pollWithin, within } from './support/within.js';

/**
 * The resolver in gate mode with the name check built (`P-432` S6, §1.3): a lookup whose walk was
 * heard runs on the probe's lanes, one whose walk went unanswered in the helper, and only there,
 * a refresh rides its zone's heard walk, and a name heard that then sticks on a lane makes its
 * zone unsafe. And the helper's lanes with the check on (D23, `P-478`): a key the walk vouches for
 * is ungated there, any other is held to 3, no key runs every first lane (`P-483`), and the last
 * first lane and last shared lane are kept for lookups the gate does not hold. DNS is a scripted asker, the helper a fake one, and
 * `getaddrinfo` on the probe's lanes is settled by hand; the routing wait is a real 60 ms.
 */

const silent = pino({ level: 'silent' });
const STUCK = 40;
const ROUTE = 60;
/** When a silent walk's question is judged a miss: well before the helper's answer could be slow. */
const MISS = 80;

interface Call {
  readonly host: string;
  readonly answer: (addresses?: readonly ResolvedAddress[]) => void;
}

const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];

/** A log line, by the fields the test reads. */
interface Line {
  readonly [field: string]: unknown;
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

/** What a check that failed was told: its code and words. */
const failed = (got: Promise<unknown>): Promise<{ code: unknown; message: string }> =>
  got.then(
    () => ({ code: undefined, message: 'answered' }),
    (error: unknown) => ({
      code: (error as { code?: unknown }).code,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

async function make(
  setup: {
    readonly route?: 'up' | 'down';
    readonly files?: readonly string[];
    readonly stuckMs?: number;
    readonly tickMs?: number;
    readonly maxQueued?: number;
    readonly logger?: Logger;
    /** The check's routing wait, and its miss a little after it: `ROUTE` and `MISS` unless set. */
    readonly routeMs?: number;
    /** D19's bucket, `WALK_RATE`'s unless set: refilled on the test's clock. */
    readonly rate?: {
      readonly perSecond: number;
      readonly burst: number;
      readonly reserve: number;
    };
  } = {},
) {
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };
  const helper = new FakeHelper(() => clock.now);
  if (setup.route !== undefined) helper.route = setup.route;
  const policy = new WalkPolicy();
  const asker = new ScriptedAsker();
  asker.rule = (_server, name) => (name.endsWith('zone-b.test') ? 'silent' : 'answer');
  const budget = new ForwardBudget({
    now: () => clock.now,
    ...(setup.rate === undefined ? {} : { rate: setup.rate }),
  });
  const resolver = new NameResolver({
    logger: setup.logger ?? silent,
    lookup: (host) =>
      new Promise((resolve) => {
        calls.push({
          host,
          answer: (addresses = A) => {
            resolve(addresses);
          },
        });
      }),
    now: () => clock.now,
    random: () => 0.5,
    stuckMs: setup.stuckMs ?? STUCK,
    ...(setup.maxQueued === undefined ? {} : { maxQueued: setup.maxQueued }),
    watch: { files: [...(setup.files ?? [])], everyMs: 60_000 },
    gate: {
      helper,
      policy,
      budget,
      keys: new HelperKeys(),
      tickMs: setup.tickMs ?? 3_600_000,
      check: {
        asker,
        routeMs: setup.routeMs ?? ROUTE,
        missMs: setup.routeMs === undefined ? MISS : setup.routeMs + MISS - ROUTE,
      },
    },
  });
  helper.onChange = (change) => {
    resolver.onHelperChange(change);
  };
  // The watch's baseline before the start, as the probe takes it.
  if (setup.files !== undefined) await resolver.firstLook();
  resolver.start();
  await pollWithin(1_000, 'the check proven', () => resolver.gateHealth()?.checkState === 1, 2);
  const ask = (
    host: string,
    request: { waitMs?: number; fresh?: boolean } = {},
    family: Family = 4,
  ) => resolver.resolve(host, family, request);
  const callsFor = (host: string): Call[] => calls.filter((call) => call.host === host);
  return { resolver, helper, policy, asker, budget, calls, callsFor, clock, ask };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const SUMMARY = 'the probe’s resolver in gate mode, this hour';

/**
 * The next hour's summary: the clock moved on an hour, and the line the gate's tick then logs,
 * the one after the `seen` already logged.
 */
async function summaryAfter(
  lines: readonly Line[],
  clock: { now: number },
  seen: number,
): Promise<Line> {
  clock.now += GATE_SUMMARY_MS;
  const summaries = (): Line[] => lines.filter((line) => line['msg'] === SUMMARY);
  await pollWithin(1_000, `summary ${String(seen + 1)}`, () => summaries().length > seen, 5);
  const line = summaries()[seen];
  assert.ok(line !== undefined);
  return line;
}

describe('gate mode with the name check routes by the walk (P-432 S6, §1.3)', () => {
  it('runs a heard name on the probe’s lanes and a silent one in the helper, and counts each', async () => {
    const { resolver, helper, calls, callsFor, ask } = await make();
    const heard = ask('dev-1.zone-a.test');
    const quiet = ask('dev-1.zone-b.test');
    await pollWithin(1_000, 'both routed', () => calls.length === 1 && helper.asks.length === 1, 2);
    assert.deepEqual(
      calls.map((call) => call.host),
      ['dev-1.zone-a.test'],
      'getaddrinfo on the probe’s lanes for the heard name only',
    );
    assert.equal(helper.last('dev-1.zone-b.test').host, 'dev-1.zone-b.test');
    callsFor('dev-1.zone-a.test')[0]?.answer();
    helper.last('dev-1.zone-b.test').answer(A);
    assert.deepEqual(await heard, A);
    assert.deepEqual(await quiet, A);
    const health = resolver.gateHealth();
    assert.ok(health !== undefined);
    assert.equal(health.lookupsHeard, 1);
    assert.equal(health.lookupsToHelper, 1);
    assert.equal(health.checkState, 1);
    resolver.stop();
  });

  it('counts a lookup still being walked as in flight, in no lane yet', async () => {
    const { resolver, ask } = await make();
    const quiet = ask('dev-2.zone-b.test', { waitMs: 2_000 });
    assert.equal(resolver.stats().queued, 1, 'scouting');
    assert.equal(resolver.stats().running, 0);
    await wait(ROUTE * 2);
    assert.equal(resolver.stats().running, 1, 'in the helper once its walk went unanswered');
    resolver.stop();
    void quiet.catch(() => undefined);
  });

  it('fails a check for a silent name at once while the helper is down, keeps it queued, and asks it in the helper once up', async () => {
    const { resolver, helper, calls, ask } = await make();
    helper.move('down');
    await wait(0);
    const first = await ask('dev-3.zone-b.test').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((first as { code?: unknown }).code, RESOLVER_FAULT);
    assert.match((first as Error).message, /asked only in the helper; it stays queued/u);
    assert.equal(notAnswered(first), false, 'not counted as given up');
    // Asked again while still down: at once, from the queue, never on the probe's lanes.
    const again = await ask('dev-3.zone-b.test').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((again as { code?: unknown }).code, RESOLVER_FAULT);
    assert.deepEqual(calls, [], 'nothing on the probe’s lanes');
    helper.move('up');
    await pollWithin(1_000, 'asked in the helper', () => helper.asks.length === 1, 2);
    helper.last('dev-3.zone-b.test').answer(A);
    await pollWithin(1_000, 'answered', () => resolver.stats().running === 0, 2);
    assert.deepEqual(await ask('dev-3.zone-b.test'), A);
    resolver.stop();
  });

  it('lets a refresh ride its zone’s heard walk from the last second, with no walk of its own (D20)', async () => {
    const { resolver, asker, callsFor, clock, ask } = await make();
    const first = ask('dev-4.zone-a.test');
    await pollWithin(1_000, 'on a lane', () => callsFor('dev-4.zone-a.test').length === 1, 2);
    callsFor('dev-4.zone-a.test')[0]?.answer();
    await first;
    clock.now += ANSWER_MS + 1;
    // Another name of the zone walked and heard now: its zone's sample.
    const other = ask('dev-5.zone-a.test');
    await pollWithin(
      1_000,
      'the other on a lane',
      () => callsFor('dev-5.zone-a.test').length === 1,
      2,
    );
    callsFor('dev-5.zone-a.test')[0]?.answer();
    await other;
    const walked = asker.askedFor('dev-4.zone-a.test').length;
    // Expired: served at once, and refreshed behind it on the probe's lanes, riding the sample.
    assert.deepEqual(await ask('dev-4.zone-a.test'), A);
    assert.equal(callsFor('dev-4.zone-a.test').length, 2, 'refreshed on the probe’s lanes at once');
    assert.equal(asker.askedFor('dev-4.zone-a.test').length, walked, 'with no walk of its own');
    callsFor('dev-4.zone-a.test')[1]?.answer();
    assert.equal(resolver.gateHealth()?.lookupsHeard, 3, 'a sampled lookup counts as heard');
    resolver.stop();
  });

  it('marks every key a heard walk asked unsafe when its lookup sticks on a lane, and sends the zone’s next name to the helper (D25)', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, callsFor, ask } = await make({ logger });
    const stuck = ask('dev-6.zone-a.test', { waitMs: 2_000 });
    await pollWithin(1_000, 'on a lane', () => callsFor('dev-6.zone-a.test').length === 1, 2);
    await pollWithin(1_000, 'passed stuck', () => resolver.gateHealth()?.passedStuck === 1, 5);
    const said = lines.find(
      (line) => line.level === 40 && line.host === 'dev-6.zone-a.test' && line.route !== undefined,
    );
    assert.deepEqual(
      said === undefined ? undefined : [said.route, said.key, said.walkKeys],
      ['heard', 'd:zone-a.test', ['d:zone-a.test']],
      'a warn naming the host, its key and the keys its walk asked',
    );
    void ask('dev-7.zone-a.test', { waitMs: 2_000 }).catch(() => undefined);
    await pollWithin(1_000, 'the next name in the helper', () => helper.asks.length === 1, 2);
    assert.equal(helper.last('dev-7.zone-a.test').host, 'dev-7.zone-a.test');
    assert.equal(callsFor('dev-7.zone-a.test').length, 0, 'never on the probe’s lanes');
    callsFor('dev-6.zone-a.test')[0]?.answer();
    assert.deepEqual(await stuck, A);
    resolver.stop();
  });

  it('counts a miss when the helper answers a name whose walk went unanswered (§1.10)', async () => {
    const { resolver, helper, ask } = await make();
    const quiet = ask('dev-10.zone-b.test');
    await pollWithin(1_000, 'in the helper', () => helper.asks.length === 1, 2);
    helper.last('dev-10.zone-b.test').answer(A);
    assert.deepEqual(await quiet, A);
    assert.equal(resolver.gateHealth()?.misses, 0, 'judged at its question’s send plus 80 ms');
    await pollWithin(1_000, 'the miss', () => resolver.gateHealth()?.misses === 1, 5);
    resolver.stop();
  });

  it('takes a sampled refresh stuck on a lane as its zone not heard, so the zone’s next refresh walks (D20, D25)', async () => {
    const { logger, lines } = captured();
    const { resolver, asker, callsFor, clock, ask } = await make({ logger });
    const names = ['dev-11.zone-a.test', 'dev-12.zone-a.test'];
    const first = names.map((name) => ask(name));
    await pollWithin(1_000, 'both on lanes', () => names.every((n) => callsFor(n).length === 1), 2);
    for (const name of names) callsFor(name)[0]?.answer();
    await Promise.all(first);
    clock.now += ANSWER_MS + 1;
    // The zone heard in the last second, by a third name's walk.
    const third = ask('dev-13.zone-a.test');
    await pollWithin(
      1_000,
      'the third on a lane',
      () => callsFor('dev-13.zone-a.test').length === 1,
      2,
    );
    callsFor('dev-13.zone-a.test')[0]?.answer();
    await third;
    // The first's refresh rides the sample, and sticks.
    assert.deepEqual(await ask('dev-11.zone-a.test'), A);
    assert.equal(callsFor('dev-11.zone-a.test').length, 2, 'refreshed on a lane');
    assert.equal(asker.askedFor('dev-11.zone-a.test').length, 1, 'sampled: no walk of its own');
    await pollWithin(1_000, 'passed stuck', () => resolver.gateHealth()?.passedStuck === 1, 5);
    const said = lines.find(
      (line) => line.level === 40 && line.host === 'dev-11.zone-a.test' && line.route !== undefined,
    );
    assert.deepEqual(
      said === undefined ? undefined : [said.route, said.key],
      ['sampled', 'd:zone-a.test'],
      'a warn naming the host and its zone',
    );
    // The second's refresh no longer rides: the zone is not heard as of the stuck one's start.
    const walked = asker.askedFor('dev-12.zone-a.test').length;
    assert.deepEqual(await ask('dev-12.zone-a.test'), A);
    await pollWithin(
      1_000,
      'the second walked',
      () => asker.askedFor('dev-12.zone-a.test').length === walked + 1,
      2,
    );
    callsFor('dev-11.zone-a.test')[1]?.answer();
    resolver.stop();
  });

  it('moves a sampled refresh still queued on the probe’s lanes to the helper when its zone stops answering every name (D20)', async () => {
    // Stuck far later than the case takes: the lanes it fills are busy, not stuck.
    const { helper, asker, callsFor, clock, ask, resolver } = await make({ stuckMs: 5_000 });
    const others = [0, 1, 2, 3].map((zone) => `dev-1.zone-c${String(zone)}.test`);
    const kept = 'dev-20.zone-a.test';
    for (const name of [...others, kept]) {
      const first = ask(name);
      await pollWithin(1_000, `${name} on a lane`, () => callsFor(name).length === 1, 2);
      callsFor(name)[0]?.answer();
      await first;
    }
    clock.now += ANSWER_MS + 1;
    // Four refreshes walked, heard and left running: the refresh lanes are full.
    for (const name of others) {
      assert.deepEqual(await ask(name), A);
      await pollWithin(1_000, `${name} refreshing`, () => callsFor(name).length === 2, 2);
    }
    // Zone A heard this second, by a new name on a first lane.
    const fresh = ask('dev-21.zone-a.test');
    await pollWithin(
      1_000,
      'the new name on a lane',
      () => callsFor('dev-21.zone-a.test').length === 1,
      2,
    );
    callsFor('dev-21.zone-a.test')[0]?.answer();
    await fresh;
    // The kept name's refresh rides the sample, and waits for a refresh lane.
    assert.deepEqual(await ask(kept), A);
    assert.equal(callsFor(kept).length, 1, 'queued, not running');
    assert.equal(asker.askedFor(kept).length, 1, 'sampled: no walk of its own');
    // A name of zone A goes unanswered: the zone is mixed, and the queued sample is not vouched for.
    asker.rule = (_server, name) => (name === 'dev-22.zone-a.test' ? 'silent' : 'answer');
    void ask('dev-22.zone-a.test', { waitMs: 2_000 }).catch(() => undefined);
    await pollWithin(
      1_000,
      'the kept name’s refresh in the helper',
      () => helper.asks.some((asked) => asked.host === kept),
      2,
    );
    assert.equal(callsFor(kept).length, 1, 'never on the probe’s lanes');
    for (const name of others) callsFor(name)[1]?.answer();
    resolver.stop();
  });

  it('walks a local name that passed stuck on a lane, from its next lookup (D25)', async () => {
    const { resolver, policy, asker, callsFor, clock, ask } = await make();
    policy.local = (host) => host === 'gw.test';
    const local = ask('gw.test', { waitMs: 2_000 });
    await pollWithin(1_000, 'on a lane', () => callsFor('gw.test').length === 1, 2);
    assert.equal(asker.askedFor('gw.test').length, 0, 'the hosts file’s: not walked');
    await pollWithin(1_000, 'passed stuck', () => resolver.gateHealth()?.passedStuck === 1, 5);
    callsFor('gw.test')[0]?.answer();
    assert.deepEqual(await local, A);
    clock.now += ANSWER_MS + STALE_MS + 1;
    const again = ask('gw.test');
    await pollWithin(1_000, 'walked', () => asker.askedFor('gw.test').length === 1, 2);
    await pollWithin(1_000, 'on a lane again', () => callsFor('gw.test').length === 2, 2);
    callsFor('gw.test')[1]?.answer();
    assert.deepEqual(await again, A);
    resolver.stop();
  });

  it('asks Check now in the helper with no walk, as with the check off (cut 5)', async () => {
    const { resolver, helper, asker, calls, ask } = await make();
    const now = ask('dev-8.zone-a.test', { fresh: true });
    await pollWithin(1_000, 'in the helper', () => helper.asks.length === 1, 2);
    assert.equal(asker.askedFor('dev-8.zone-a.test').length, 0, 'no walk');
    assert.deepEqual(calls, []);
    helper.last('dev-8.zone-a.test').answer(A);
    assert.deepEqual(await now, A);
    resolver.stop();
  });

  it('says the check’s state and counts in the hour’s summary: walks deferred past the pool, and 0 while the helper rests (P-467)', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, asker, clock, ask } = await make({ logger, tickMs: 5 });
    asker.rule = () => 'silent';
    // Six zones none of which has been heard: the discovery pool holds 4 open, and the rest wait
    // out their routing wait for room, then go to the helper unwalked.
    for (let zone = 0; zone < 6; zone += 1) {
      void ask(`dev-1.zone-q${String(zone)}.test`, { waitMs: 2_000 }).catch(() => undefined);
    }
    await pollWithin(1_000, 'two deferred', () => resolver.gateHealth()?.walksDeferred === 2, 2);
    await wait(ROUTE * 2);
    const said = resolver.gateHealth();
    assert.ok(said !== undefined);
    assert.equal(said.walksDeferred, 2, 'two past the pool’s 4, and no more');
    assert.equal(said.misses, 0);
    // Six never-seen keys, none heard: 3 of the first lanes, the fourth kept for a zone the walk
    // heard (`P-478`).
    assert.equal(said.lookupsToHelper, 3, 'in the helper');
    assert.equal(helper.asks.length, 3);
    assert.equal(said.checkState, 1);
    // Probe Health has no channel for these (OPEN-5): the hour's summary says them.
    const first = await summaryAfter(lines, clock, 0);
    assert.equal((first['hour'] as Record<string, unknown>)['walksDeferred'], 2);
    assert.equal((first['walksDeferred'] as Record<string, unknown>)['total'], 2);
    const check = first['check'] as Record<string, unknown>;
    assert.equal(check['state'], 1);
    assert.equal(check['said'], 'on');
    assert.equal('off' in check, false, 'no reason while it is on');
    helper.move('resting');
    assert.equal(resolver.gateHealth()?.checkState, 0, 'resting: the check routes nothing');
    assert.equal(resolver.gateHealth()?.mode, 3);
    const resting = (await summaryAfter(lines, clock, 1))['check'] as Record<string, unknown>;
    assert.equal(resting['state'], 0);
    assert.equal(resting['said'], CHECK_STATE_SAID[0]);
    resolver.stop();
  });

  it('starts the check again from nothing when resolv.conf changes: unproven until a reply, and every name to the helper (§1.12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-check-'));
    try {
      const resolv = join(dir, 'resolv.conf');
      writeFileSync(resolv, 'nameserver 10.0.0.53\n');
      const { resolver, helper, asker, calls, ask } = await make({ files: [resolv] });
      assert.equal(resolver.gateHealth()?.checkState, 1);
      asker.rule = () => 'silent';
      writeFileSync(resolv, 'nameserver 10.0.0.54\n');
      assert.equal(await resolver.checkFiles(), true);
      assert.equal(resolver.gateHealth()?.checkState, 3, 'unproven again');
      void ask('dev-9.zone-a.test', { waitMs: 2_000 }).catch(() => undefined);
      await pollWithin(1_000, 'in the helper', () => helper.asks.length === 1, 2);
      assert.deepEqual(calls, [], 'a zone heard before the change is not heard after it');
      resolver.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * D19's bucket with room for the canary and one scout, and refilled never, since the test's clock
 * stands still: zone a's scout is heard, and every walk after it is refused and routes `rate`,
 * unwalked, to the helper, as most first lookups do at a cold start's burst (§3).
 */
const COLD_BURST = { perSecond: 0, burst: 2, reserve: 5 } as const;

/** A check's outcome, without letting a rejection go unhandled. */
const ended = (got: Promise<unknown>): Promise<boolean> =>
  got.then(
    () => true,
    () => false,
  );

/** Zone a's scout, `dev-0.zone-a.test`, heard and answered on the probe's lanes: zone a vouched. */
async function scoutZoneA(
  calls: readonly Call[],
  ask: (host: string, request?: { waitMs?: number }) => Promise<readonly ResolvedAddress[]>,
): Promise<void> {
  const scout = ask('dev-0.zone-a.test');
  await pollWithin(1_000, 'zone a’s scout heard', () => calls.length === 1, 2);
  calls[0]?.answer();
  assert.deepEqual(await scout, A);
}

describe('the helper’s lanes with the name check on (P-432 D23, P-478)', () => {
  it('K2: a partial outage, check on, cached names among silent ones: the key goes mixed, the cached names run on the probe’s lanes and answer, and the silent ones stay in the helper, at most 3', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, asker, calls, ask } = await make({ logger });
    // Zone b's authoritative servers are down; its recursor still has dev-c0 to dev-c3 cached.
    asker.rule = (_server, name) => (name.startsWith('dev-s') ? 'silent' : 'answer');
    const cached = [0, 1, 2, 3].map((i) => `dev-c${String(i)}.zone-b.test`);
    const uncached = [0, 1, 2, 3, 4, 5].map((i) => `dev-s${String(i)}.zone-b.test`);
    // Asked at one instant, the two kinds in turn: a cached name scouts first, and an uncached one.
    const hosts = [0, 1, 2, 3, 4, 5].flatMap((i) =>
      i < cached.length
        ? [`dev-c${String(i)}.zone-b.test`, `dev-s${String(i)}.zone-b.test`]
        : [`dev-s${String(i)}.zone-b.test`],
    );
    const waits = hosts.map((host) => ({ host, got: ended(ask(host, { waitMs: 60_000 })) }));
    let most = 0;
    const inHelper = (): number => {
      const now = helper.inFlight().filter((sent) => uncached.includes(sent.host)).length;
      most = Math.max(most, now);
      return now;
    };
    // The cached names heard, each on the probe's lanes as a lane is free: a domain not yet known
    // to answer there holds 3 of its first lanes (`P-438`).
    await pollWithin(
      2_000,
      () =>
        `every name routed: ${String(calls.length)} on lanes, ${String(helper.asks.length)} in the helper`,
      () => {
        inHelper();
        for (const call of calls) call.answer();
        return calls.length === cached.length && helper.asks.length === 3;
      },
      2,
    );
    assert.deepEqual(
      calls.map((call) => call.host).sort(),
      [...cached].sort(),
      'the cached names, heard, on the probe’s lanes, and nothing else',
    );
    for (const { host, got } of waits.filter(({ host }) => cached.includes(host))) {
      assert.equal(await got, true, `${host} answered`);
    }
    // The uncached ones in the helper, 3 at a time, each failing after it hangs.
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      assert.ok(inHelper() <= 3);
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    assert.equal(most, 3, 'at most 3 of the silent names in the helper at once');
    for (const { host, got } of waits.filter(({ host }) => uncached.includes(host))) {
      assert.equal(await got, false, `${host} not answered`);
    }
    assert.ok(
      helper.asks.every((sent) => uncached.includes(sent.host)),
      'only the uncached names in the helper',
    );
    assert.ok(
      lines.some(
        (line) =>
          line['msg'] === 'a DNS zone the check walks is not answering every name' &&
          line.key === 'd:zone-b.test' &&
          line['phase'] === 'mixed',
      ),
      'd:zone-b.test mixed',
    );
    resolver.stop();
  });

  it('K17: vouched keys at a cold start, D19 refusing their walks: ungated in the helper and counted at no risk, never a key’s fourth first lane though nothing else waits (P-483), and held to 3 once one sticks', async () => {
    const { resolver, helper, calls, ask } = await make({ rate: COLD_BURST });
    await scoutZoneA(calls, ask);
    const names = [1, 2, 3, 4, 5, 6].map((i) => `dev-${String(i)}.zone-a.test`);
    const waits = names.map((host) => ended(ask(host, { waitMs: 60_000 })));
    await pollWithin(
      1_000,
      () => `zone a’s walks refused: ${String(resolver.gateHealth()?.walksDeferred)}`,
      () => resolver.gateHealth()?.walksDeferred === names.length,
      2,
    );
    await wait(0);
    const inFlight = (): string[] => helper.inFlight().map((sent) => sent.host);
    assert.equal(calls.length, 1, 'no walk heard: none on the probe’s lanes');
    assert.deepEqual(
      inFlight(),
      names.slice(0, 3),
      'vouched, with nothing else queued: 3 of the 4 first lanes, never the fourth',
    );
    assert.equal(helper.asksFor('dev-4.zone-a.test').length, 0);
    assert.equal(resolver.riskSeen()?.atRisk, 0, 'ungated: none of them at risk');
    // One sticks: the key is no longer vouched, so the key rule holds it to 3 of every class.
    helper.last('dev-1.zone-a.test').stuck();
    helper.last('dev-2.zone-a.test').answer();
    await pollWithin(
      1_000,
      'the one that answered replaced',
      () => helper.asksFor('dev-4.zone-a.test').length === 1,
      2,
    );
    await wait(0);
    assert.deepEqual(
      inFlight(),
      ['dev-1.zone-a.test', 'dev-3.zone-a.test', 'dev-4.zone-a.test'],
      'held to 3, the stuck one among them',
    );
    assert.equal(helper.asksFor('dev-5.zone-a.test').length, 0);
    // Vouched again once that one ends: the next starts, to 3 first lanes, and not the fourth.
    helper.last('dev-1.zone-a.test').answer();
    await pollWithin(1_000, 'vouched again: the next starts', () => helper.asks.length === 5, 2);
    await wait(0);
    assert.deepEqual(inFlight(), ['dev-3.zone-a.test', 'dev-4.zone-a.test', 'dev-5.zone-a.test']);
    assert.equal(helper.asksFor('dev-6.zone-a.test').length, 0, 'not the fourth first lane');
    helper.last('dev-3.zone-a.test').answer();
    await pollWithin(1_000, 'the last starts', () => helper.asks.length === 6, 2);
    // Three said stuck and Check now answering after them: the key answers in the helper, but
    // the walk vouches for it no more, so its 3 hold, and a check behind them fails at once.
    const now = ask('dev-2.zone-a.test', { fresh: true });
    await pollWithin(
      1_000,
      'Check now in the helper',
      () => helper.asksFor('dev-2.zone-a.test').length === 2,
      2,
    );
    for (const host of ['dev-4', 'dev-5', 'dev-6']) helper.last(`${host}.zone-a.test`).stuck();
    helper.last('dev-2.zone-a.test').answer();
    assert.deepEqual(await now, A);
    await wait(0);
    const held = await failed(ask('dev-7.zone-a.test', { waitMs: 2_000 }));
    assert.equal(held.code, RESOLVER_STUCK, held.message);
    assert.match(
      held.message,
      /\(dev-4\.zone-a\.test, dev-5\.zone-a\.test, dev-6\.zone-a\.test\): the DNS check does not vouch for zone-a\.test now, so it holds at most 3 of the helper’s lanes; it stays queued$/u,
    );
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.answer();
      await wait(0);
    }
    for (const got of waits) assert.equal(await got, true);
    resolver.stop();
  });

  it('P-483: a key the walk heard through one cached scout, four of its first lookups asked at once with nothing else queued: the fourth does not start, and another key’s lookup asked after them takes the last first lane', async () => {
    // Room for the canary, zone a's scout and one walk of zone b, refilled never: every walk after
    // them is refused and routes `rate`, unwalked, to the helper.
    const { resolver, helper, asker, calls, ask } = await make({
      rate: { perSecond: 0, burst: 3, reserve: 0 },
    });
    asker.rule = (_server, name) => (name.startsWith('dev-s') ? 'silent' : 'answer');
    await scoutZoneA(calls, ask);
    // Zone b heard through one name its recursor caches, answered on the probe's lanes.
    const scout = ask('dev-c0.zone-b.test');
    await pollWithin(
      1_000,
      'zone b’s scout heard',
      () => calls.some((call) => call.host === 'dev-c0.zone-b.test'),
      2,
    );
    calls.find((call) => call.host === 'dev-c0.zone-b.test')?.answer();
    assert.deepEqual(await scout, A, 'zone b’s scout answered on the probe’s lanes');
    assert.equal(helper.asks.length, 0, 'nothing in the helper yet');
    // Four of its first lookups at once, three silent names and one cached, as the run had them.
    const four = ['dev-s0', 'dev-s1', 'dev-c1', 'dev-s2'].map((name) => `${name}.zone-b.test`);
    const fourWaits = four.map((host) => ended(ask(host, { waitMs: 60_000 })));
    await pollWithin(
      1_000,
      () => `zone b’s walks refused: ${String(resolver.gateHealth()?.walksDeferred)}`,
      () => resolver.gateHealth()?.walksDeferred === four.length,
      2,
    );
    await wait(0);
    const inFlight = (): string[] => helper.inFlight().map((sent) => sent.host);
    assert.deepEqual(
      inFlight(),
      four.slice(0, 3),
      'vouched, with nothing stuck and nothing else queued: 3 of the 4 first lanes',
    );
    assert.equal(helper.asksFor('dev-s2.zone-b.test').length, 0, 'the fourth does not start');
    // Another key's name, its walk refused too, takes the last first lane at once.
    const other = ended(ask('dev-1.zone-a.test', { waitMs: 60_000 }));
    await pollWithin(
      1_000,
      () => `zone a in the helper: ${inFlight().join(', ')}`,
      () => helper.asksFor('dev-1.zone-a.test').length === 1,
      2,
    );
    assert.deepEqual(inFlight(), [...four.slice(0, 3), 'dev-1.zone-a.test']);
    // It ends, and nothing of another key's waits: zone b still does not take its fourth.
    helper.last('dev-1.zone-a.test').answer();
    assert.equal(await other, true);
    await wait(0);
    assert.deepEqual(inFlight(), four.slice(0, 3), 'with none waiting, not the fourth either');
    assert.equal(helper.asksFor('dev-s2.zone-b.test').length, 0);
    // One of its own ends: the fourth name takes its lane, zone b again at 3.
    helper.last('dev-c1.zone-b.test').answer();
    await pollWithin(
      1_000,
      'the fourth name started',
      () => helper.asksFor('dev-s2.zone-b.test').length === 1,
      2,
    );
    assert.deepEqual(inFlight(), [
      'dev-s0.zone-b.test',
      'dev-s1.zone-b.test',
      'dev-s2.zone-b.test',
    ]);
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    assert.deepEqual(await Promise.all(fourWaits), [false, false, true, false]);
    resolver.stop();
  });

  it('P-481: a key the walk heard through two cached names, four of its silent names asked at once and another key’s answering name queued: that name takes the last first lane, and the key never its fourth while it runs the other 3 (P-483)', async () => {
    // Room for the canary, zone a's scout and two walks of zone b, refilled never: every walk
    // after them is refused and routes `rate`, unwalked, to the helper.
    const { resolver, helper, asker, calls, ask } = await make({
      rate: { perSecond: 0, burst: 4, reserve: 0 },
    });
    asker.rule = (_server, name) => (name.startsWith('dev-s') ? 'silent' : 'answer');
    await scoutZoneA(calls, ask);
    // Zone b heard through two names its recursor caches, each answered on the probe's lanes.
    for (const host of ['dev-c0.zone-b.test', 'dev-c1.zone-b.test']) {
      const cached = ask(host);
      await pollWithin(1_000, `${host} heard`, () => calls.some((call) => call.host === host), 2);
      calls.find((call) => call.host === host)?.answer();
      assert.deepEqual(await cached, A, `${host} answered on the probe’s lanes`);
    }
    assert.equal(helper.asks.length, 0, 'nothing in the helper yet');
    // A name of zone a in the helper first, its walk refused: it holds one first lane.
    const filler = ended(ask('dev-1.zone-a.test', { waitMs: 60_000 }));
    await pollWithin(1_000, 'zone a in the helper', () => helper.inFlight().length === 1, 2);
    const silentNames = [0, 1, 2, 3].map((i) => `dev-s${String(i)}.zone-b.test`);
    const silentOnes = silentNames.map((host) => ended(ask(host, { waitMs: 60_000 })));
    const zoneB = (): string[] =>
      helper
        .inFlight()
        .map((sent) => sent.host)
        .filter((host) => host.endsWith('.zone-b.test'));
    await pollWithin(1_000, 'zone b in the helper', () => zoneB().length === 3, 2);
    // Its walk refused too, zone a's answering name queued behind zone b's fourth.
    const answering = ended(ask('dev-2.zone-a.test', { waitMs: 60_000 }));
    await pollWithin(
      1_000,
      () => `every walk refused: ${String(resolver.gateHealth()?.walksDeferred)}`,
      () => resolver.gateHealth()?.walksDeferred === 6,
      2,
    );
    await wait(0);
    assert.deepEqual(zoneB(), silentNames.slice(0, 3), 'vouched: past the 3, with nothing stuck');
    assert.equal(helper.inFlight().length, 4, 'every first lane held');
    assert.equal(helper.asksFor('dev-2.zone-a.test').length, 0);
    // A lane ends: zone b runs the other 3 and zone a's name waits, so that name takes it.
    helper.last('dev-1.zone-a.test').answer();
    assert.equal(await filler, true);
    await pollWithin(
      1_000,
      () =>
        `a lane taken: ${helper
          .inFlight()
          .map((sent) => sent.host)
          .join(', ')}`,
      () => helper.inFlight().length === 4,
      2,
    );
    assert.equal(helper.asksFor('dev-2.zone-a.test').length, 1, 'the other key’s name took it');
    assert.deepEqual(zoneB(), silentNames.slice(0, 3), 'not zone b’s fourth');
    // With none of another key's waiting, zone b still does not take its fourth (P-483).
    helper.last('dev-2.zone-a.test').answer();
    assert.equal(await answering, true);
    await wait(0);
    assert.deepEqual(zoneB(), silentNames.slice(0, 3), 'not its fourth, with none waiting');
    assert.equal(helper.asksFor('dev-s3.zone-b.test').length, 0);
    assert.equal(helper.inFlight().length, 3, 'the last first lane left free');
    // One of its own ends: its fourth name takes that one's lane.
    helper.last('dev-s0.zone-b.test').fail('EAI_AGAIN');
    await pollWithin(
      1_000,
      'zone b’s fourth name',
      () => helper.asksFor('dev-s3.zone-b.test').length === 1,
      2,
    );
    assert.deepEqual(zoneB(), silentNames.slice(1));
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    for (const got of silentOnes) assert.equal(await got, false);
    resolver.stop();
  });

  it('P-481: the rule is the first lanes’: a vouched key running 3 of them refreshes in the helper while another key’s first lookup waits', async () => {
    const { resolver, helper, calls, clock, ask } = await make({ rate: COLD_BURST });
    await scoutZoneA(calls, ask);
    // A name of zone a answered in the helper, its walk refused.
    const seed = ask('dev-1.zone-a.test');
    await pollWithin(1_000, 'in the helper', () => helper.asks.length === 1, 2);
    helper.last('dev-1.zone-a.test').answer();
    assert.deepEqual(await seed, A);
    // Another key's first lookup holds a first lane, zone a's 3 the others, and another of that
    // key's waits for one.
    const others = [ended(ask('dev-0.k0.zone-b.test', { waitMs: 60_000 }))];
    await pollWithin(1_000, 'k0 in the helper', () => helper.inFlight().length === 1, 2);
    const firsts = [2, 3, 4].map((i) =>
      ended(ask(`dev-${String(i)}.zone-a.test`, { waitMs: 60_000 })),
    );
    await pollWithin(1_000, 'every first lane held', () => helper.inFlight().length === 4, 2);
    others.push(ended(ask('dev-1.k0.zone-b.test', { waitMs: 60_000 })));
    await pollWithin(
      1_000,
      () => `every walk refused: ${String(resolver.gateHealth()?.walksDeferred)}`,
      () => resolver.gateHealth()?.walksDeferred === 6,
      2,
    );
    // Its answer expired: served at once, and refreshed in the helper behind it, on a shared lane.
    clock.now += ANSWER_MS + 1;
    assert.deepEqual(await ask('dev-1.zone-a.test'), A);
    await pollWithin(
      1_000,
      () => `refreshed: ${String(helper.asksFor('dev-1.zone-a.test').length)} asked`,
      () => helper.asksFor('dev-1.zone-a.test').length === 2,
      2,
    );
    assert.equal(helper.inFlight().length, 5);
    assert.equal(helper.asksFor('dev-1.k0.zone-b.test').length, 0, 'the first lanes all held');
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.answer();
      await wait(0);
    }
    for (const got of [...firsts, ...others]) assert.equal(await got, true);
    resolver.stop();
  });

  it('P-478: the check turned off, a key it heard is vouched no more and no lane is kept: held to 3, and a never-seen key’s first look takes the fourth, as system mode’s does', async () => {
    const { resolver, helper, policy, calls, ask } = await make();
    await scoutZoneA(calls, ask);
    policy.off = { code: 'env', why: 'the test turned the check off' };
    const names = [1, 2, 3, 4, 5].map((i) => `dev-${String(i)}.zone-a.test`);
    const waits = names.map((host) => ended(ask(host, { waitMs: 60_000 })));
    await pollWithin(1_000, 'zone a in the helper', () => helper.inFlight().length === 3, 2);
    await wait(0);
    assert.deepEqual(
      helper.inFlight().map((sent) => sent.host),
      names.slice(0, 3),
      'its walk heard it, but the check is off: held to 3',
    );
    const other = ended(ask('dev.k0.zone-b.test', { waitMs: 60_000 }));
    await pollWithin(
      1_000,
      () =>
        `the never-seen key asked: ${helper
          .inFlight()
          .map((s) => s.host)
          .join(', ')}`,
      () => helper.asksFor('dev.k0.zone-b.test').length === 1,
      2,
    );
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.answer();
      await wait(0);
    }
    assert.equal(await other, true);
    for (const got of waits) assert.equal(await got, true);
    resolver.stop();
  });

  it('P-478: a name its recursor caches, answering in the helper, does not lift its zone’s 3, check on: a vouched zone takes the fourth first lane at once', async () => {
    const { resolver, helper, asker, calls, ask } = await make({ rate: COLD_BURST });
    asker.rule = (_server, name) => (name.startsWith('dev-s') ? 'silent' : 'answer');
    await scoutZoneA(calls, ask);
    // Zone b's cached name, its walk refused, answers in the helper: its key is not quiet.
    const cached = ask('dev-c0.zone-b.test', { waitMs: 60_000 });
    await pollWithin(1_000, 'in the helper', () => helper.asks.length === 1, 2);
    helper.last('dev-c0.zone-b.test').answer();
    assert.deepEqual(await cached, A);
    const zoneB = (): number =>
      helper.inFlight().filter((sent) => sent.host.endsWith('.zone-b.test')).length;
    const uncached = [0, 1, 2, 3, 4].map((i) =>
      ended(ask(`dev-s${String(i)}.zone-b.test`, { waitMs: 60_000 })),
    );
    // Its walk and theirs refused: each routed to the helper unwalked.
    await pollWithin(
      1_000,
      () => `zone b’s walks refused: ${String(resolver.gateHealth()?.walksDeferred)}`,
      () => resolver.gateHealth()?.walksDeferred === 6,
      2,
    );
    await wait(0);
    assert.equal(zoneB(), 3, 'held to 3 though it answered there, not the 4 first lanes');
    const answering = ended(ask('dev-1.zone-a.test', { waitMs: 60_000 }));
    await pollWithin(
      1_000,
      () =>
        `zone a asked in the helper: ${helper
          .inFlight()
          .map((s) => s.host)
          .join(', ')}`,
      () => helper.asksFor('dev-1.zone-a.test').length === 1,
      2,
    );
    assert.equal(zoneB(), 3);
    helper.last('dev-1.zone-a.test').answer();
    assert.equal(await answering, true);
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
      assert.ok(zoneB() <= 3);
    }
    for (const got of uncached) assert.equal(await got, false);
    resolver.stop();
  });

  it('P-478: many small silent keys, check on: they hold at most 3 first lanes, and a vouched zone takes the fourth at once', async () => {
    const { resolver, helper, calls, ask } = await make({ rate: COLD_BURST });
    await scoutZoneA(calls, ask);
    // Six keys of one name each: no key's 3 can bind, and each is a never-seen key's first look.
    const keys = [0, 1, 2, 3, 4, 5].map((i) => `dev.k${String(i)}.zone-b.test`);
    const silentOnes = keys.map((host) => ended(ask(host, { waitMs: 60_000 })));
    await pollWithin(
      1_000,
      () => `the keys’ walks refused: ${String(resolver.gateHealth()?.walksDeferred)}`,
      () => resolver.gateHealth()?.walksDeferred === keys.length,
      2,
    );
    await wait(0);
    const silentNow = (): number =>
      helper.inFlight().filter((sent) => keys.includes(sent.host)).length;
    assert.equal(silentNow(), 3, 'the fourth first lane kept for a zone the walk heard');
    const answering = ended(ask('dev-1.zone-a.test', { waitMs: 60_000 }));
    await pollWithin(
      1_000,
      () =>
        `zone a asked in the helper: ${helper
          .inFlight()
          .map((s) => s.host)
          .join(', ')}`,
      () => helper.asksFor('dev-1.zone-a.test').length === 1,
      2,
    );
    assert.equal(silentNow(), 3);
    helper.last('dev-1.zone-a.test').answer();
    assert.equal(await answering, true);
    // Its 3 said stuck, another such key's check fails at once, naming the lane kept.
    for (const sent of helper.inFlight()) sent.stuck();
    const refused = await failed(ask('dev.k6.zone-b.test', { waitMs: 2_000 }));
    assert.equal(refused.code, RESOLVER_STUCK, refused.message);
    assert.match(
      refused.message,
      /: the lookup helper keeps its last lane for names the DNS check has heard answer, or that answer there; it stays queued$/u,
    );
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
      assert.ok(silentNow() <= 3);
    }
    for (const got of silentOnes) assert.equal(await got, false);
    resolver.stop();
  });
});

/** The test's one DNS server (`CONF`). */
const SERVER = '10.0.0.53';

/** D19's bucket emptied while the test's clock stands still: every walk routes `rate`, unwalked. */
function spend(budget: ForwardBudget): void {
  let left = true;
  while (left) left = budget.serverTake(SERVER, 1, 'key');
}

/** Zone b's rule: its servers down, its recursor still caching every name but `dev-s*`. */
const partly = (_server: string, name: string): ScriptedReply =>
  name.startsWith('dev-s') ? 'silent' : 'answer';

/**
 * `P-480`'s world: K2's partial outage at a cold start, with a bucket the test refills on the
 * resolver's clock. Zone b's three silent names stuck in the helper, which holds the zone to them;
 * each of `queued` asked behind them with D19's bucket spent, so that it goes to the helper
 * unwalked and its check fails at once, behind the cap; then the bucket refilled and the zone made
 * mixed: `dev-c0` heard and answered on the probe's lanes, `dev-s3` walked and not heard.
 */
async function coldPartial(queued: readonly string[]) {
  const made = await make();
  const { helper, asker, budget, callsFor, clock, ask } = made;
  asker.rule = partly;
  spend(budget);
  const stuck = [0, 1, 2].map((i) => `dev-s${String(i)}.zone-b.test`);
  const held = stuck.map((host) => ended(ask(host, { waitMs: 60_000 })));
  await pollWithin(1_000, 'the three in the helper', () => helper.inFlight().length === 3, 2);
  for (const host of stuck) helper.last(host).stuck();
  for (const host of queued) {
    const first = await failed(ask(host, { waitMs: 2_000 }));
    assert.equal(first.code, RESOLVER_STUCK, `${host}: ${first.message}`);
    assert.match(first.message, /no name of zone-b\.test has answered in the lookup helper since/u);
    assert.equal(helper.asksFor(host).length, 0, `${host} queued in the helper`);
  }
  assert.equal(
    asker.asked.filter((question) => queued.includes(question.name)).length,
    0,
    'none of them walked: D19 refused each',
  );
  clock.now += 2_000;
  const c0 = ask('dev-c0.zone-b.test', { waitMs: 2_000 });
  await pollWithin(1_000, 'dev-c0 heard', () => callsFor('dev-c0.zone-b.test').length === 1, 2);
  callsFor('dev-c0.zone-b.test')[0]?.answer();
  assert.deepEqual(await c0, A);
  const s3 = await failed(ask('dev-s3.zone-b.test', { waitMs: 2_000 }));
  assert.equal(s3.code, RESOLVER_STUCK, `walked, not heard, and behind the cap: ${s3.message}`);
  assert.equal(asker.askedFor('dev-s3.zone-b.test').length, 1);
  return { ...made, stuck, held };
}

/**
 * `P-480`'s world with its zone's first walked name silent: `dev-s0` scouts zone b and is not
 * heard, so the key goes silent, and `dev-s1`, `dev-s2` and then each of `queued` route silent on
 * the zone's evidence alone, nothing asked for their names. The three silent names stuck in the
 * helper hold the zone to them, and each of `queued` fails at once behind them. Then the key's
 * walk again, due 5 s on (±20%), takes `dev-c0`, a cached name: heard, it answers on the probe's
 * lanes, and the key is mixed.
 */
async function silentFirst(queued: readonly string[]) {
  const made = await make();
  const { helper, asker, callsFor, clock, ask } = made;
  asker.rule = partly;
  const scout = ended(ask('dev-s0.zone-b.test', { waitMs: 60_000 }));
  await pollWithin(
    1_000,
    'dev-s0 not heard, in the helper',
    () => helper.asksFor('dev-s0.zone-b.test').length === 1,
    2,
  );
  const stuck = [0, 1, 2].map((i) => `dev-s${String(i)}.zone-b.test`);
  const held = [scout, ...stuck.slice(1).map((host) => ended(ask(host, { waitMs: 60_000 })))];
  await pollWithin(1_000, 'the three in the helper', () => helper.inFlight().length === 3, 2);
  for (const host of stuck) helper.last(host).stuck();
  for (const host of [...stuck.slice(1), ...queued]) {
    if (queued.includes(host)) {
      const first = await failed(ask(host, { waitMs: 2_000 }));
      assert.equal(first.code, RESOLVER_STUCK, `${host}: ${first.message}`);
      assert.match(
        first.message,
        /no name of zone-b\.test has answered in the lookup helper since/u,
      );
    }
    assert.equal(asker.askedFor(host).length, 0, `${host}: not asked, its zone silent`);
  }
  // Past the key's walk again, 5 s with up to a fifth's jitter either way.
  clock.now += REWALK_FIRST_MS * (1 + REWALK_JITTER);
  const c0 = ask('dev-c0.zone-b.test', { waitMs: 2_000 });
  await pollWithin(1_000, 'dev-c0 heard', () => callsFor('dev-c0.zone-b.test').length === 1, 2);
  callsFor('dev-c0.zone-b.test')[0]?.answer();
  assert.deepEqual(await c0, A);
  return { ...made, stuck, held };
}

describe('a queued helper lookup’s own walk, once its key is heard again (P-480, D18)', () => {
  it('walks a cached name the cold burst sent to the helper unwalked once its zone is mixed: heard, it answers on the probe’s lanes; a silent one is walked once and stays in the helper', async () => {
    const { resolver, helper, asker, callsFor, ask, stuck, held } = await coldPartial([
      'dev-c1.zone-b.test',
      'dev-s4.zone-b.test',
    ]);
    // Its next check: one walk of its own, heard, and the lookup on the probe's lanes.
    const c1 = ask('dev-c1.zone-b.test', { waitMs: 2_000 });
    await pollWithin(
      1_000,
      'dev-c1 on the probe’s lanes',
      () => callsFor('dev-c1.zone-b.test').length === 1,
      2,
    );
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 1, 'one walk of its own');
    callsFor('dev-c1.zone-b.test')[0]?.answer();
    assert.deepEqual(await c1, A);
    assert.equal(helper.asksFor('dev-c1.zone-b.test').length, 0, 'never asked in the helper');
    // A silent name queued as it was: walked once, not heard, and kept for the helper.
    const s4 = await failed(ask('dev-s4.zone-b.test', { waitMs: 2_000 }));
    assert.equal(s4.code, RESOLVER_STUCK, s4.message);
    assert.match(s4.message, /no name of zone-b\.test has answered in the lookup helper since/u);
    assert.equal(asker.askedFor('dev-s4.zone-b.test').length, 1, 'walked once');
    const again = await failed(ask('dev-s4.zone-b.test', { waitMs: 2_000 }));
    assert.equal(again.code, RESOLVER_STUCK, again.message);
    assert.equal(asker.askedFor('dev-s4.zone-b.test').length, 1, 'not walked a second time');
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    for (const got of held) assert.equal(await got, false);
    for (const host of [...stuck, 'dev-s3.zone-b.test', 'dev-s4.zone-b.test']) {
      assert.equal(callsFor(host).length, 0, `${host} never on the probe’s lanes`);
    }
    resolver.stop();
  });

  it('walks a cached name its zone’s silence sent to the helper unwalked once the zone is mixed: heard, it answers on the probe’s lanes; a silent one sent so is walked once and stays', async () => {
    const cached = ['dev-c1.zone-b.test', 'dev-c2.zone-b.test'];
    const { resolver, helper, asker, callsFor, ask, stuck, held } = await silentFirst([
      ...cached,
      'dev-s4.zone-b.test',
    ]);
    for (const host of cached) {
      const got = ask(host, { waitMs: 2_000 });
      await pollWithin(1_000, `${host} on the probe’s lanes`, () => callsFor(host).length === 1, 2);
      assert.equal(asker.askedFor(host).length, 1, `${host}: one walk of its own`);
      callsFor(host)[0]?.answer();
      assert.deepEqual(await got, A);
      assert.equal(helper.asksFor(host).length, 0, `${host} never asked in the helper`);
    }
    const s4 = await failed(ask('dev-s4.zone-b.test', { waitMs: 2_000 }));
    assert.equal(s4.code, RESOLVER_STUCK, s4.message);
    assert.equal(asker.askedFor('dev-s4.zone-b.test').length, 1, 'walked once, not heard');
    const again = await failed(ask('dev-s4.zone-b.test', { waitMs: 2_000 }));
    assert.equal(again.code, RESOLVER_STUCK, again.message);
    assert.equal(asker.askedFor('dev-s4.zone-b.test').length, 1, 'not walked a second time');
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    for (const got of held) assert.equal(await got, false);
    for (const host of [...stuck, 'dev-s4.zone-b.test']) {
      assert.equal(callsFor(host).length, 0, `${host} never on the probe’s lanes`);
    }
    resolver.stop();
  });

  it('never walks again a queued lookup its own walk left unanswered, though its zone is mixed and it fails at once behind the cap (D18)', async () => {
    const { resolver, helper, asker, callsFor, clock, ask, held } = await silentFirst([]);
    // Walked by name in the mixed zone, not heard: silent on its own step, queued behind the cap.
    const first = await failed(ask('dev-s5.zone-b.test', { waitMs: 2_000 }));
    assert.equal(first.code, RESOLVER_STUCK, first.message);
    assert.equal(asker.askedFor('dev-s5.zone-b.test').length, 1, 'its own walk');
    // Past that question's hold, so that a walk now would ask the server again, not join it.
    clock.now += FORWARD_HOLD_MS;
    for (const round of [1, 2]) {
      const later = await failed(ask('dev-s5.zone-b.test', { waitMs: 2_000 }));
      assert.equal(later.code, RESOLVER_STUCK, `check ${String(round)}: ${later.message}`);
      assert.equal(asker.askedFor('dev-s5.zone-b.test').length, 1, 'not walked again');
    }
    assert.equal(callsFor('dev-s5.zone-b.test').length, 0, 'never on the probe’s lanes');
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    for (const got of held) assert.equal(await got, false);
    resolver.stop();
  });

  it('walks no queued lookup of a suspect’s name, nor any while the helper is not up, nor one walked already, and moves none whose helper stopped being up during its walk', async () => {
    const { resolver, helper, asker, callsFor, ask } = await coldPartial([
      'dev-c1.zone-b.test',
      'dev-c2.zone-b.test',
      'dev-c3.zone-b.test',
    ]);
    // dev-c1's family-0 lookup was in flight at a crash: a suspect, kept off the probe's lanes.
    helper.avoided.add('0:dev-c1.zone-b.test');
    const suspect = await failed(ask('dev-c1.zone-b.test', { waitMs: 2_000 }));
    assert.equal(suspect.code, RESOLVER_STUCK, suspect.message);
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 0, 'a suspect’s name is not walked');
    // The helper rejoining: nothing walked.
    helper.move('rejoining');
    const rejoining = await failed(ask('dev-c2.zone-b.test', { waitMs: 2_000 }));
    assert.equal(rejoining.code, RESOLVER_STUCK, rejoining.message);
    assert.equal(asker.askedFor('dev-c2.zone-b.test').length, 0, 'not walked while rejoining');
    helper.move('up');
    // Up as its walk starts, rejoining by its verdict: heard, and left where it is.
    asker.rule = (server, name) =>
      name === 'dev-c3.zone-b.test' ? { reply: 'answer', delayMs: 20 } : partly(server, name);
    const c3 = failed(ask('dev-c3.zone-b.test', { waitMs: 2_000 }));
    await pollWithin(
      1_000,
      'dev-c3 walked',
      () => asker.askedFor('dev-c3.zone-b.test').length === 1,
      2,
    );
    helper.move('rejoining');
    const moved = await c3;
    assert.equal(moved.code, RESOLVER_STUCK, moved.message);
    helper.move('up');
    const later = await failed(ask('dev-c3.zone-b.test', { waitMs: 2_000 }));
    assert.equal(later.code, RESOLVER_STUCK, later.message);
    assert.equal(asker.askedFor('dev-c3.zone-b.test').length, 1, 'its one walk taken');
    // Walked already, its reply unreadable: in the helper unvouched, and not walked again.
    asker.rule = (server, name) => (name === 'dev-c6.zone-b.test' ? 'bad' : partly(server, name));
    const unread = await failed(ask('dev-c6.zone-b.test', { waitMs: 2_000 }));
    assert.equal(unread.code, RESOLVER_STUCK, unread.message);
    asker.rule = partly;
    const walked = await failed(ask('dev-c6.zone-b.test', { waitMs: 2_000 }));
    assert.equal(walked.code, RESOLVER_STUCK, walked.message);
    assert.equal(asker.askedFor('dev-c6.zone-b.test').length, 1, 'walked once, as it was asked');
    for (const host of ['dev-c1', 'dev-c2', 'dev-c3', 'dev-c6']) {
      assert.equal(callsFor(`${host}.zone-b.test`).length, 0, `${host} not on the probe’s lanes`);
    }
    resolver.stop();
  });

  it('walks no queued lookup while the walk has not heard its zone, unknown or silent: its check fails at once behind the cap', async () => {
    const { resolver, helper, asker, budget, callsFor, clock, ask } = await make();
    asker.rule = partly;
    spend(budget);
    const stuck = [0, 1, 2].map((i) => `dev-s${String(i)}.zone-b.test`);
    const held = stuck.map((host) => ended(ask(host, { waitMs: 60_000 })));
    await pollWithin(1_000, 'the three in the helper', () => helper.inFlight().length === 3, 2);
    for (const host of stuck) helper.last(host).stuck();
    const first = await failed(ask('dev-c1.zone-b.test', { waitMs: 2_000 }));
    assert.equal(first.code, RESOLVER_STUCK, first.message);
    clock.now += 2_000;
    // Unknown: none of zone b's names walked yet, the bucket full again.
    const unknown = await failed(ask('dev-c1.zone-b.test', { waitMs: 2_000 }));
    assert.equal(unknown.code, RESOLVER_STUCK, unknown.message);
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 0, 'not walked: its zone unknown');
    // Silent: its scout, dev-s3, walked and not heard.
    const s3 = await failed(ask('dev-s3.zone-b.test', { waitMs: 2_000 }));
    assert.equal(s3.code, RESOLVER_STUCK, s3.message);
    assert.equal(asker.askedFor('dev-s3.zone-b.test').length, 1, 'the zone’s scout');
    const quiet = await failed(ask('dev-c1.zone-b.test', { waitMs: 2_000 }));
    assert.equal(quiet.code, RESOLVER_STUCK, quiet.message);
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 0, 'not walked: its zone silent');
    assert.equal(callsFor('dev-c1.zone-b.test').length, 0);
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    for (const got of held) assert.equal(await got, false);
    resolver.stop();
  });

  it('walks no queued lookup held by anything but its key’s cap: behind lanes other zones’ stuck lookups hold, it fails at once unwalked', async () => {
    const { resolver, helper, asker, budget, calls, callsFor, clock, ask } = await make();
    asker.rule = partly;
    await scoutZoneA(calls, ask);
    spend(budget);
    // Zone b's three silent names take 3 lanes, zone a's dev-1 the fourth, vouched: all stuck.
    const stuck = [0, 1, 2].map((i) => `dev-s${String(i)}.zone-b.test`);
    const held = [...stuck, 'dev-1.zone-a.test'].map((host) =>
      ended(ask(host, { waitMs: 60_000 })),
    );
    await pollWithin(1_000, 'four in the helper', () => helper.inFlight().length === 4, 2);
    for (const sent of helper.inFlight()) sent.stuck();
    const first = await failed(ask('dev-2.zone-a.test', { waitMs: 2_000 }));
    assert.equal(first.code, RESOLVER_STUCK, first.message);
    assert.doesNotMatch(first.message, /so it holds at most|until one answers/u, first.message);
    clock.now += 2_000;
    const again = await failed(ask('dev-2.zone-a.test', { waitMs: 2_000 }));
    assert.equal(again.code, RESOLVER_STUCK, again.message);
    assert.equal(again.message, first.message);
    assert.equal(asker.askedFor('dev-2.zone-a.test').length, 0, 'not walked: not its key’s cap');
    assert.equal(callsFor('dev-2.zone-a.test').length, 0);
    for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
      for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
      await wait(0);
    }
    for (const got of held) assert.equal(await got, false);
    resolver.stop();
  });

  it('gives back the token a lookup carries when it moves, asked again after a loss during its walk (P1, P5)', async () => {
    const { resolver, helper, asker, budget, callsFor, ask, stuck } = await coldPartial([
      'dev-c5.zone-b.test',
    ]);
    asker.rule = (server, name) =>
      name === 'dev-c5.zone-b.test' ? { reply: 'answer', delayMs: 30 } : partly(server, name);
    const held = (): number => {
      const tokens = budget.stats().held;
      return tokens.shared + tokens.kept + tokens.urgent;
    };
    const c5 = ask('dev-c5.zone-b.test', { waitMs: 2_000 });
    await pollWithin(
      1_000,
      'dev-c5 walked',
      () => asker.askedFor('dev-c5.zone-b.test').length === 1,
      2,
    );
    // A lane frees while it is walked: it runs in the helper, on a token.
    const before = held();
    helper.last(stuck[0] ?? '').answer(A);
    await pollWithin(
      1_000,
      'dev-c5 in the helper',
      () => helper.asksFor('dev-c5.zone-b.test').length === 1,
      2,
    );
    assert.equal(held(), before, 'the token dev-s0 gave back, dev-c5 took');
    // Lost with a child and asked again, it carries its token, queued.
    helper.last('dev-c5.zone-b.test').reject(
      new HelperLostError('the test lost it (exit)', {
        reason: 'exit',
        stuck: false,
        detached: false,
        started: true,
        charged: false,
        requeue: true,
        suspect: false,
        pid: 4242,
      }),
    );
    await wait(0);
    assert.equal(held(), before, 'carried');
    const released = budget.stats().released;
    await pollWithin(
      1_000,
      'dev-c5 on the probe’s lanes',
      () => callsFor('dev-c5.zone-b.test').length === 1,
      2,
    );
    assert.equal(budget.stats().released, released + 1, 'its token given back as it moved');
    // The lane it left taken by dev-s3: every token held is a lookup in the helper.
    assert.equal(held(), helper.inFlight().length);
    callsFor('dev-c5.zone-b.test')[0]?.answer();
    assert.deepEqual(await c5, A);
    resolver.stop();
  });
});

/** The words a check gives up with behind zone b's three stuck silent names (`P-478`). */
const CAP_WORDS = /no name of zone-b\.test has answered in the lookup helper since/u;

/** Every lookup left in the helper failed, and the held checks seen to end unanswered. */
async function drain(
  helper: FakeHelper,
  held: readonly Promise<boolean>[],
  resolver: NameResolver,
): Promise<void> {
  for (let round = 0; round < 10 && helper.inFlight().length > 0; round += 1) {
    for (const sent of helper.inFlight()) sent.fail('EAI_AGAIN');
    await wait(0);
  }
  for (const got of held) assert.equal(await got, false);
  resolver.stop();
}

describe('a queued helper lookup’s own walk: its places, the walk again it carries, the stuck flush (P-484)', () => {
  it('walks a cached name’s own walk in one of heard’s places while its zone’s silent names’ own walks fill discovery: heard, it answers on the probe’s lanes, never deferred', async () => {
    const silentNames = [4, 5, 6, 7].map((i) => `dev-s${String(i)}.zone-b.test`);
    const { resolver, helper, asker, budget, callsFor, ask, held } = await coldPartial([
      ...silentNames,
      'dev-c1.zone-b.test',
    ]);
    // Each silent name's next check walks it, not heard, in a discovery place held 10 s.
    for (const host of silentNames) {
      const got = await failed(ask(host, { waitMs: 2_000 }));
      assert.equal(got.code, RESOLVER_STUCK, got.message);
      assert.equal(asker.askedFor(host).length, 1, `${host} walked once`);
    }
    assert.equal(budget.walkOpen('discovery'), WALK_QUESTIONS.discovery, 'discovery full of them');
    const deferred = resolver.gateHealth()?.walksDeferred;
    // The cached name's own walk takes one of heard's at once: heard, it moves and answers.
    const c1 = ask('dev-c1.zone-b.test', { waitMs: 2_000 });
    await pollWithin(
      1_000,
      'dev-c1 on the probe’s lanes',
      () => callsFor('dev-c1.zone-b.test').length === 1,
      2,
    );
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 1, 'one walk of its own');
    callsFor('dev-c1.zone-b.test')[0]?.answer();
    assert.deepEqual(await c1, A);
    assert.equal(resolver.gateHealth()?.walksDeferred, deferred, 'its walk not deferred');
    assert.equal(helper.asksFor('dev-c1.zone-b.test').length, 0, 'never asked in the helper');
    await drain(helper, held, resolver);
  });

  it('carries its silent zone’s walk again on a held lookup’s own walk once that is due, and not before: a cached name, heard, answers on the probe’s lanes, and the zone is mixed', async () => {
    const { resolver, helper, asker, callsFor, clock, ask } = await make();
    asker.rule = partly;
    // dev-s0 scouts zone b, not heard: the key silent, its walk again 5 s on (±20%).
    const scout = ended(ask('dev-s0.zone-b.test', { waitMs: 60_000 }));
    await pollWithin(
      1_000,
      'dev-s0 not heard, in the helper',
      () => helper.asksFor('dev-s0.zone-b.test').length === 1,
      2,
    );
    const stuck = [0, 1, 2].map((i) => `dev-s${String(i)}.zone-b.test`);
    const held = [scout, ...stuck.slice(1).map((host) => ended(ask(host, { waitMs: 60_000 })))];
    await pollWithin(1_000, 'the three in the helper', () => helper.inFlight().length === 3, 2);
    for (const host of stuck) helper.last(host).stuck();
    // dev-c1 routed silent on its zone's evidence, held behind the cap, its zone's walk again not
    // due: two checks, neither walking it.
    for (const round of [1, 2]) {
      const early = await failed(ask('dev-c1.zone-b.test', { waitMs: 2_000 }));
      assert.equal(early.code, RESOLVER_STUCK, `check ${String(round)}: ${early.message}`);
      assert.match(early.message, CAP_WORDS);
      assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 0, 'not walked: not due');
    }
    // Past the zone's walk again: dev-c1's next check walks it, as the zone's walk again.
    clock.now += REWALK_FIRST_MS * (1 + REWALK_JITTER);
    const c1 = ask('dev-c1.zone-b.test', { waitMs: 2_000 });
    await pollWithin(
      1_000,
      'dev-c1 on the probe’s lanes',
      () => callsFor('dev-c1.zone-b.test').length === 1,
      2,
    );
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 1, 'one question, the walk again');
    callsFor('dev-c1.zone-b.test')[0]?.answer();
    assert.deepEqual(await c1, A);
    assert.equal(helper.asksFor('dev-c1.zone-b.test').length, 0, 'never asked in the helper');
    // Heard, so the zone is mixed: a new cached name is walked by name and heard.
    const c2 = ask('dev-c2.zone-b.test', { waitMs: 2_000 });
    await pollWithin(
      1_000,
      'dev-c2 on the probe’s lanes',
      () => callsFor('dev-c2.zone-b.test').length === 1,
      2,
    );
    callsFor('dev-c2.zone-b.test')[0]?.answer();
    assert.deepEqual(await c2, A);
    await drain(helper, held, resolver);
  });

  it('walks the queued lookups the stuck flush would fail, as a fresh check would: a cached name waiting behind its zone’s 3 when they stick is heard and answers on the probe’s lanes, a silent one is failed once its walk ends, and one its own step left unanswered at once', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, asker, budget, callsFor, clock, ask } = await make({ logger });
    asker.rule = partly;
    spend(budget);
    const stuck = [0, 1, 2].map((i) => `dev-s${String(i)}.zone-b.test`);
    const held = stuck.map((host) => ended(ask(host, { waitMs: 60_000 })));
    await pollWithin(1_000, 'the three in the helper', () => helper.inFlight().length === 3, 2);
    // The zone made mixed: dev-c0 heard on the probe's lanes, then dev-s3 walked and not heard,
    // queued behind the three, none of them stuck yet. Mixed, the zone is vouched for no more.
    clock.now += 2_000;
    const c0 = ask('dev-c0.zone-b.test', { waitMs: 2_000 });
    await pollWithin(1_000, 'dev-c0 heard', () => callsFor('dev-c0.zone-b.test').length === 1, 2);
    callsFor('dev-c0.zone-b.test')[0]?.answer();
    assert.deepEqual(await c0, A);
    const s3 = failed(ask('dev-s3.zone-b.test', { waitMs: 10_000 }));
    await pollWithin(
      1_000,
      'dev-s3 not heard: zone b mixed',
      () =>
        lines.some(
          (line) =>
            line['msg'] === 'a DNS zone the check walks is not answering every name' &&
            line.key === 'd:zone-b.test' &&
            line['phase'] === 'mixed',
        ),
      2,
    );
    assert.equal(asker.askedFor('dev-s3.zone-b.test').length, 1);
    // dev-c1 and dev-s4, D19 refusing their walks, wait behind the three too.
    spend(budget);
    const deferred = resolver.gateHealth()?.walksDeferred ?? 0;
    const c1 = failed(ask('dev-c1.zone-b.test', { waitMs: 10_000 }));
    const s4 = failed(ask('dev-s4.zone-b.test', { waitMs: 10_000 }));
    await pollWithin(
      1_000,
      'dev-c1 and dev-s4 routed rate',
      () => resolver.gateHealth()?.walksDeferred === deferred + 2,
      2,
    );
    for (const host of ['dev-c1', 'dev-s4']) {
      assert.equal(asker.askedFor(`${host}.zone-b.test`).length, 0, `${host} not walked yet`);
      assert.equal(helper.asksFor(`${host}.zone-b.test`).length, 0, `${host} queued`);
    }
    // The three stick, D19's bucket refilled: the flush walks dev-c1 first, heard, and it
    // answers on the probe's lanes.
    clock.now += 2_000;
    for (const host of stuck) helper.last(host).stuck();
    await pollWithin(
      1_000,
      'dev-c1 on the probe’s lanes',
      () => callsFor('dev-c1.zone-b.test').length === 1,
      2,
    );
    assert.equal(asker.askedFor('dev-c1.zone-b.test').length, 1, 'its own walk');
    callsFor('dev-c1.zone-b.test')[0]?.answer();
    assert.deepEqual(await c1, { code: undefined, message: 'answered' });
    // dev-s4 walked by the flush too, not heard: failed as its walk ends, in the cap's words.
    const s4Got = await s4;
    assert.equal(s4Got.code, RESOLVER_STUCK, s4Got.message);
    assert.match(s4Got.message, CAP_WORDS);
    assert.equal(asker.askedFor('dev-s4.zone-b.test').length, 1, 'walked once');
    // dev-s3, its own step left unanswered: not walked again, failed at once.
    const s3Got = await s3;
    assert.equal(s3Got.code, RESOLVER_STUCK, s3Got.message);
    assert.equal(asker.askedFor('dev-s3.zone-b.test').length, 1, 'not walked again');
    for (const host of [...stuck, 'dev-s3.zone-b.test', 'dev-s4.zone-b.test']) {
      assert.equal(callsFor(host).length, 0, `${host} never on the probe’s lanes`);
    }
    await drain(helper, held, resolver);
  });
});

describe('gate mode with the name check keeps an avoided name off the probe’s lanes (P-432 S6, D27)', () => {
  it('asks a held suspect again in the helper once its hold ends, unwalked, though its servers now answer', async () => {
    const { resolver, helper, asker, callsFor, clock, ask } = await make({ tickMs: 5 });
    asker.rule = () => 'silent';
    const slow = failed(ask('slow.zone-b.test', { waitMs: 60_000 }));
    const fine = ask('fine.zone-b.test', { waitMs: 60_000 });
    await pollWithin(1_000, 'both in the helper', () => helper.asks.length === 2, 2);
    helper.last('slow.zone-b.test').stuck();
    // The second crash: the stuck lookup held, the other asked again, both suspects.
    helper.isolatingNow = true;
    helper.lose('exit', 'rejoining', { suspects: true });
    assert.equal((await slow).code, RESOLVER_HELD);
    helper.move('up');
    await pollWithin(
      1_000,
      'the other alone',
      () => helper.asksFor('fine.zone-b.test').length === 2,
      2,
    );
    helper.last('fine.zone-b.test').answer(A);
    assert.deepEqual(await fine, A);
    // Its servers answer now: a walk would hear it, and run it on the probe's lanes.
    asker.rule = () => 'answer';
    const walks = asker.askedFor('slow.zone-b.test').length;
    clock.now += 5_000;
    await pollWithin(
      1_000,
      'the held suspect asked again',
      () => helper.asksFor('slow.zone-b.test').length === 2,
      5,
    );
    assert.equal(helper.last('slow.zone-b.test').suspect, true, 'alone, as a suspect');
    assert.equal(asker.askedFor('slow.zone-b.test').length, walks, 'not walked');
    assert.equal(callsFor('slow.zone-b.test').length, 0, 'never on the probe’s lanes');
    helper.last('slow.zone-b.test').answer(A);
    resolver.stop();
  });

  it('sends a name the probe must not ask, poison in a family a lookup of it asks, to the helper unwalked while it is up', async () => {
    const { resolver, helper, asker, callsFor, ask } = await make();
    // The helper's word for family 0 covers a mark under family 4 (`avoidsSystem`).
    helper.avoided.add('0:dev-30.zone-a.test');
    const got = ask('dev-30.zone-a.test', { waitMs: 2_000 }, 0);
    await pollWithin(
      1_000,
      'in the helper',
      () => helper.asksFor('dev-30.zone-a.test').length === 1,
      2,
    );
    assert.equal(asker.askedFor('dev-30.zone-a.test').length, 0, 'not walked');
    assert.equal(callsFor('dev-30.zone-a.test').length, 0, 'never on the probe’s lanes');
    helper.last('dev-30.zone-a.test').answer(A);
    assert.deepEqual(await got, A);
    resolver.stop();
  });

  it('sends a name its walk heard to the helper when a crash during the walk made it one the probe must not ask', async () => {
    const { resolver, helper, asker, callsFor, ask } = await make();
    asker.rule = () => ({ reply: 'answer', delayMs: 20 });
    const got = ask('dev-31.zone-a.test', { waitMs: 2_000 });
    await pollWithin(1_000, 'walked', () => asker.askedFor('dev-31.zone-a.test').length === 1, 2);
    helper.avoided.add('4:dev-31.zone-a.test');
    await pollWithin(
      1_000,
      'in the helper',
      () => helper.asksFor('dev-31.zone-a.test').length === 1,
      2,
    );
    assert.equal(callsFor('dev-31.zone-a.test').length, 0, 'never on the probe’s lanes');
    helper.last('dev-31.zone-a.test').answer(A);
    assert.deepEqual(await got, A);
    resolver.stop();
  });

  it('fails the check of a name avoided during its walk at once when the helper went down meanwhile', async () => {
    const { resolver, helper, asker, callsFor, ask } = await make();
    asker.rule = () => ({ reply: 'answer', delayMs: 20 });
    const got = failed(ask('dev-32.zone-a.test', { waitMs: 2_000 }));
    await pollWithin(1_000, 'walked', () => asker.askedFor('dev-32.zone-a.test').length === 1, 2);
    helper.avoided.add('4:dev-32.zone-a.test');
    helper.move('down');
    const said = await got;
    assert.equal(said.code, RESOLVER_FAULT);
    assert.match(said.message, /does not ask its own getaddrinfo for dev-32\.zone-a\.test/u);
    await wait(ROUTE);
    assert.equal(callsFor('dev-32.zone-a.test').length, 0, 'never on the probe’s lanes');
    assert.equal(resolver.gateHealth()?.lookupsHeard, 0);
    resolver.stop();
  });
});

describe('gate mode with the name check: a rest, a full queue and a silent name’s words (P-432 S6)', () => {
  it('moves a silent lookup queued on the probe’s lanes in a rest into the helper once it is up', async () => {
    const { resolver, helper, calls, callsFor, ask } = await make({ stuckMs: 5_000 });
    // Four heard names, each of its own zone, hold the probe's first lanes.
    const held = [0, 1, 2, 3].map((zone) => ask(`dev-1.zone-c${String(zone)}.test`));
    await pollWithin(1_000, 'four on lanes', () => calls.length === 4, 2);
    const quiet = ask('dev-50.zone-b.test', { waitMs: 2_000 });
    // The helper rests during the walk: its silent verdict queues on the probe's lanes.
    helper.move('resting');
    // Its verdict taken: queued on the probe's lanes, behind the four.
    await wait(ROUTE * 3);
    assert.equal(resolver.stats().queued, 1, 'queued on a probe lane');
    assert.equal(helper.asksFor('dev-50.zone-b.test').length, 0);
    helper.move('up');
    await pollWithin(
      1_000,
      'in the helper',
      () => helper.asksFor('dev-50.zone-b.test').length === 1,
      2,
    );
    for (const call of [...calls]) call.answer();
    await Promise.all(held);
    helper.last('dev-50.zone-b.test').answer(A);
    assert.deepEqual(await quiet, A);
    assert.equal(callsFor('dev-50.zone-b.test').length, 0, 'never on the probe’s lanes');
    resolver.stop();
  });

  it('walks nothing for a lookup a full queue may refuse: it goes unwalked, to a lane free now', async () => {
    const { resolver, helper, asker, ask } = await make({ maxQueued: 1 });
    asker.rule = () => 'silent';
    // Walking, the queue's one.
    const first = ask('dev-40.zone-b.test', { waitMs: 2_000 });
    assert.equal(resolver.stats().queued, 1);
    const next = ask('dev-41.zone-b.test', { waitMs: 2_000 });
    await pollWithin(
      1_000,
      'in the helper',
      () => helper.asksFor('dev-41.zone-b.test').length === 1,
      2,
    );
    await wait(ROUTE * 2);
    assert.equal(asker.askedFor('dev-41.zone-b.test').length, 0, 'never walked');
    for (const asked of helper.inFlight()) asked.answer(A);
    await pollWithin(1_000, 'both asked', () => helper.asks.length === 2, 2);
    for (const asked of helper.inFlight()) asked.answer(A);
    assert.deepEqual(await next, A);
    assert.deepEqual(await first, A);
    resolver.stop();
  });

  it('says what a silent name’s failed check rests on: the wait its own walk had, or its zone found silent before', async () => {
    const { resolver, helper, asker, ask } = await make();
    helper.move('down');
    await wait(0);
    // A check of 220 ms: a routing wait of 55.
    const own = await failed(ask('dev-60.zone-b.test', { waitMs: 220 }));
    assert.equal(own.code, RESOLVER_FAULT);
    assert.match(own.message, /no DNS server answered the name within 55 ms/u);
    // The zone's own verdict, at its step's 60 ms.
    await wait(ROUTE);
    // The zone is silent, its walk again not due: the next name is not asked at all.
    const zone = await failed(ask('dev-61.zone-b.test', { waitMs: 2_000 }));
    assert.equal(zone.code, RESOLVER_FAULT);
    assert.match(
      zone.message,
      /its zone zone-b\.test did not answer the check 0 s ago, and the name was not asked/u,
    );
    assert.equal(asker.askedFor('dev-61.zone-b.test').length, 0);
    resolver.stop();
  });
});

/**
 * D27 over every path to the probe's own `getaddrinfo` (`P-432` gate, round 2): a name the probe
 * may not ask, by a crash of its family-4 lookup in the helper while it is asked for family 0, or
 * by poison in its own family, becomes so at its ask (`start`), while its walk is out (`verdict`),
 * or while its lookup, heard, waits on the probe's lanes behind four others (`pump`), with the
 * helper up, rejoining, down or resting, and the resolver stopped or not. In no row is it asked on
 * the probe's lanes; the check is answered in the helper, or fails at once saying why.
 *
 * The routing wait is the probe's own 250 ms here, not `ROUTE`: a row whose walk is heard must be
 * heard on a loaded machine too, or a `verdict` row is routed silent instead and tests nothing.
 */
const D27_ROUTE = 250;
const X = 'x.zone-a.test';
const AVOIDED = /does not ask its own getaddrinfo for x\.zone-a\.test/u;
const POISON = /asking getaddrinfo for x\.zone-a\.test made the lookup helper fail/u;
const STOPPING = /^the probe is stopping: x\.zone-a\.test was not answered$/u;

interface D27Row {
  readonly path: 'start' | 'verdict' | 'pump';
  readonly kind: 'crashed' | 'poison';
  readonly route: 'up' | 'rejoining' | 'down' | 'resting';
  /** The resolver stopped, as the probe's shutdown stops it, once the name is avoided. */
  readonly stopped?: true;
  /** Queued for the helper while it rejoins, the helper then goes down. */
  readonly then?: 'down';
  /** Answered in the helper, or failed at once in these words. */
  readonly expect: 'helper' | RegExp;
}

const D27_ROWS: readonly D27Row[] = [
  { path: 'start', kind: 'crashed', route: 'up', expect: 'helper' },
  { path: 'start', kind: 'crashed', route: 'rejoining', expect: 'helper' },
  { path: 'start', kind: 'crashed', route: 'down', expect: AVOIDED },
  { path: 'start', kind: 'crashed', route: 'resting', expect: AVOIDED },
  { path: 'start', kind: 'poison', route: 'up', expect: POISON },
  { path: 'start', kind: 'poison', route: 'resting', expect: POISON },
  { path: 'verdict', kind: 'crashed', route: 'up', expect: 'helper' },
  { path: 'verdict', kind: 'crashed', route: 'rejoining', expect: 'helper' },
  { path: 'verdict', kind: 'crashed', route: 'rejoining', then: 'down', expect: AVOIDED },
  { path: 'verdict', kind: 'crashed', route: 'down', expect: AVOIDED },
  { path: 'verdict', kind: 'crashed', route: 'resting', expect: AVOIDED },
  { path: 'verdict', kind: 'poison', route: 'up', expect: POISON },
  { path: 'verdict', kind: 'crashed', route: 'up', stopped: true, expect: STOPPING },
  { path: 'verdict', kind: 'crashed', route: 'down', stopped: true, expect: STOPPING },
  { path: 'verdict', kind: 'crashed', route: 'resting', stopped: true, expect: STOPPING },
  { path: 'pump', kind: 'crashed', route: 'up', expect: 'helper' },
  { path: 'pump', kind: 'crashed', route: 'rejoining', expect: 'helper' },
  { path: 'pump', kind: 'crashed', route: 'rejoining', then: 'down', expect: AVOIDED },
  { path: 'pump', kind: 'crashed', route: 'down', expect: AVOIDED },
  { path: 'pump', kind: 'crashed', route: 'resting', expect: AVOIDED },
  { path: 'pump', kind: 'poison', route: 'up', expect: POISON },
  { path: 'pump', kind: 'poison', route: 'down', expect: POISON },
  { path: 'pump', kind: 'crashed', route: 'up', stopped: true, expect: STOPPING },
  { path: 'pump', kind: 'crashed', route: 'down', stopped: true, expect: STOPPING },
];

const titleOf = (row: D27Row): string =>
  `${row.path}, ${row.kind}, ${row.route}${row.then === undefined ? '' : ` then ${row.then}`}` +
  `${row.stopped === true ? ', stopped' : ''}: ` +
  (row.expect === 'helper' ? 'asked in the helper' : `fails at once (${row.expect.source})`);

/** One row: what X's check is told, and every call of the probe's own getaddrinfo for X. */
async function d27(row: D27Row): Promise<void> {
  const made = await make({ stuckMs: 5_000, routeMs: D27_ROUTE });
  const { resolver, helper, asker, calls, callsFor, clock, ask } = made;
  const title = titleOf(row);
  const avoid = (): void => {
    if (row.kind === 'crashed') helper.avoided.add(`4:${X}`);
    else helper.markPoison(X, 0, clock.now + 3_600_000);
    if (row.route !== 'up') helper.move(row.route);
    if (row.stopped === true) resolver.stop();
  };
  // Four heard names of four zones hold the probe's first lanes: a lookup queued there waits.
  const held =
    row.path === 'start'
      ? []
      : [0, 1, 2, 3].map((zone) =>
          ask(`dev-1.zone-c${String(zone)}.test`, { waitMs: 10_000 }).catch(() => undefined),
        );
  await pollWithin(1_000, `${title}: four on lanes`, () => calls.length === held.length, 2);
  let got: Promise<{ code: unknown; message: string }>;
  if (row.path === 'start') {
    avoid();
    got = failed(ask(X, { waitMs: 2_000 }, 0));
    assert.equal(asker.askedFor(X).length, 0, `${title}: never walked`);
  } else if (row.path === 'verdict') {
    asker.rule = () => ({ reply: 'answer', delayMs: 30 });
    got = failed(ask(X, { waitMs: 2_000 }, 0));
    await pollWithin(1_000, `${title}: walked`, () => asker.askedFor(X).length > 0, 1);
    avoid();
  } else {
    got = failed(ask(X, { waitMs: 2_000 }, 0));
    await pollWithin(
      1_000,
      `${title}: heard`,
      () => asker.askedFor(X).length > 0 && asker.askedFor(X).every((q) => q.replied !== undefined),
      2,
    );
    await wait(ROUTE);
    assert.equal(resolver.stats().queued, 1, `${title}: queued on a probe lane`);
    avoid();
    // A lane free: X is the next to leave the probe's queue.
    calls[0]?.answer();
  }
  if (row.then === 'down') {
    await wait(ROUTE * 2);
    assert.equal(helper.asksFor(X).length, 0, `${title}: queued for the next child`);
    helper.move('down');
  }
  if (row.expect === 'helper') {
    if (row.route === 'rejoining') {
      await wait(ROUTE * 2);
      assert.equal(helper.asksFor(X).length, 0, `${title}: waits for the next child`);
      helper.move('up');
    }
    await pollWithin(1_000, `${title}: in the helper`, () => helper.asksFor(X).length === 1, 2);
    assert.equal(helper.last(X).family, 0, title);
    helper.last(X).answer(A);
    const said = await within(5_000, title, got);
    assert.equal(said.message, 'answered', title);
  } else {
    const said = await within(5_000, title, got);
    assert.equal(said.code, RESOLVER_FAULT, `${title}: ${said.message}`);
    assert.match(said.message, row.expect, title);
  }
  assert.equal(callsFor(X).length, 0, `${title}: never on the probe’s own getaddrinfo`);
  for (const call of calls) call.answer();
  await Promise.all(held);
  resolver.stop();
}

describe('D27 at every path to the probe’s own getaddrinfo (P-432 gate, round 2)', () => {
  for (const row of D27_ROWS) {
    it(titleOf(row), async () => {
      await d27(row);
    });
  }
});

describe('D27 as a lookup leaves the probe’s queues: what else it settles (P-432 gate, round 2)', () => {
  it('a sampled refresh moved off the probe’s lanes no longer counts against its zone’s samples (D20)', async () => {
    const { helper, asker, callsFor, clock, ask, resolver } = await make({ stuckMs: 5_000 });
    const others = [0, 1, 2, 3].map((zone) => `dev-1.zone-c${String(zone)}.test`);
    const kept = ['dev-23.zone-a.test', 'dev-24.zone-a.test', 'dev-25.zone-a.test'];
    for (const name of [...others, ...kept]) {
      const first = ask(name);
      await pollWithin(1_000, `${name} on a lane`, () => callsFor(name).length === 1, 2);
      callsFor(name)[0]?.answer();
      await first;
    }
    clock.now += ANSWER_MS + 1;
    // Four refreshes walked, heard and left running: the refresh lanes are full.
    for (const name of others) {
      assert.deepEqual(await ask(name), A);
      await pollWithin(1_000, `${name} refreshing`, () => callsFor(name).length === 2, 2);
    }
    // Zone A heard this second, by a new name on a first lane.
    const fresh = ask('dev-26.zone-a.test');
    await pollWithin(1_000, 'the new name', () => callsFor('dev-26.zone-a.test').length === 1, 2);
    callsFor('dev-26.zone-a.test')[0]?.answer();
    await fresh;
    // Two refreshes ride the zone's sample, its two, and wait for a refresh lane.
    const [one, two, three] = kept as [string, string, string];
    for (const name of [one, two]) {
      assert.deepEqual(await ask(name), A);
      assert.equal(asker.askedFor(name).length, 1, `${name} sampled: no walk of its own`);
    }
    // Both become names the probe may not ask, and two refresh lanes come free.
    helper.avoided.add(`4:${one}`);
    helper.avoided.add(`4:${two}`);
    callsFor(others[0] ?? '')[1]?.answer();
    callsFor(others[1] ?? '')[1]?.answer();
    await pollWithin(1_000, 'both in the helper', () => helper.asks.length === 2, 2);
    assert.deepEqual(
      helper.asks.map((asked) => asked.host),
      [one, two],
    );
    assert.equal(
      callsFor(one).length + callsFor(two).length,
      2,
      'never again on the probe’s lanes',
    );
    // Their samples ended as they left: a third refresh of the zone still rides one.
    assert.deepEqual(await ask(three), A);
    await pollWithin(1_000, 'the third refreshing', () => callsFor(three).length === 2, 2);
    assert.equal(asker.askedFor(three).length, 1, 'sampled, not walked');
    for (const asked of helper.inFlight()) asked.answer(A);
    for (const name of [...others, three]) for (const call of callsFor(name)) call.answer();
    resolver.stop();
  });

  /** Each of a zone's names asked once and answered, then stale, and the zone heard this second. */
  async function zoneRidden(
    made: Awaited<ReturnType<typeof make>>,
    devices: readonly number[],
    fresh: number,
  ): Promise<string[]> {
    const { callsFor, clock, ask } = made;
    const names = devices.map((device) => `dev-${String(device)}.zone-a.test`);
    for (const name of names) {
      const first = ask(name);
      await pollWithin(1_000, `${name} on a lane`, () => callsFor(name).length === 1, 2);
      callsFor(name)[0]?.answer();
      await first;
    }
    clock.now += ANSWER_MS + 1;
    // Zone A heard this second, by a new name on a first lane.
    const heard = `dev-${String(fresh)}.zone-a.test`;
    const asked = ask(heard);
    await pollWithin(1_000, 'the new name', () => callsFor(heard).length === 1, 2);
    callsFor(heard)[0]?.answer();
    await asked;
    return names;
  }

  for (const down of [false, true]) {
    it(`a refresh that waited to ride its zone gives its place back when it may not run on the probe’s lanes: ${down ? 'failed, the helper down' : 'moved to the helper'} (D20, D27, P-477)`, async () => {
      // Stuck far later than the case takes: the riders' lanes are busy, not stuck. The routing
      // wait 5 s: the third's wait is ended by a rider's answer, never by the clock (fix round 1).
      const { logger, lines } = captured();
      const made = await make({ stuckMs: 5_000, routeMs: 5_000, tickMs: 5, logger });
      const { helper, asker, callsFor, clock, ask, resolver } = made;
      const names = await zoneRidden(made, [40, 41, 42, 43, 44], 45);
      const [one, two, three, four, five] = names as [string, string, string, string, string];
      // Two refreshes ride the zone's sample, its two, on refresh lanes at once.
      for (const name of [one, two]) {
        assert.deepEqual(await ask(name), A);
        assert.equal(callsFor(name).length, 2, `${name} riding`);
      }
      // A third waits for a place, and becomes a name the probe may not ask while it waits.
      assert.deepEqual(await ask(three), A);
      assert.equal(callsFor(three).length, 1, 'waiting, on no lane');
      assert.equal(resolver.stats().queued, 1, 'in flight while it waits');
      helper.avoided.add(`4:${three}`);
      if (down) helper.move('down');
      // The first rider answers: the third takes its place, and may not run as sampled.
      callsFor(one)[1]?.answer();
      if (down) {
        await pollWithin(1_000, 'the third failed', () => resolver.stats().queued === 0, 2);
      } else {
        await pollWithin(
          1_000,
          'the third in the helper',
          () => helper.asksFor(three).length === 1,
          2,
        );
      }
      assert.equal(callsFor(three).length, 1, 'never on the probe’s lanes');
      // Its place given back as it left: the next refresh of the zone rides at once, beside two.
      assert.deepEqual(await ask(four), A);
      assert.equal(callsFor(four).length, 2, 'the fourth riding at once');
      assert.equal(asker.askedFor(four).length, 1, 'the fourth not walked');
      // Two out, the second and the fourth: the fifth waits until one of them settles (held per
      // outage), and rides then.
      assert.deepEqual(await ask(five), A);
      assert.equal(callsFor(five).length, 1, 'the fifth waiting, on no lane');
      callsFor(two)[1]?.answer();
      await pollWithin(1_000, 'the fifth riding', () => callsFor(five).length === 2, 2);
      assert.equal(asker.askedFor(five).length, 1, 'the fifth not walked');
      for (const asked of helper.inFlight()) asked.answer(A);
      for (const name of [four, five]) for (const call of callsFor(name)) call.answer();
      // Every one of the five rode, the third included: none of them waited out its routing wait.
      const said = (await summaryAfter(lines, clock, 0))['check'] as
        { readonly sampled?: unknown; readonly waited?: unknown } | undefined;
      assert.deepEqual(
        { sampled: said?.sampled, waited: said?.waited },
        { sampled: 5, waited: 0 },
        'the third rode, then left the probe’s lanes',
      );
      resolver.stop();
    });
  }

  it('a rider that settles slower than ROUTE_MS still gives its place to a refresh waiting on its zone: only a rider’s own end frees one, at any speed (D20, P-477 fix round 1)', async () => {
    const made = await make({ stuckMs: 5_000, routeMs: 5_000 });
    const { asker, callsFor, clock, ask, resolver } = made;
    const names = await zoneRidden(made, [50, 51, 52], 53);
    const [one, two, three] = names as [string, string, string];
    for (const name of [one, two]) {
      assert.deepEqual(await ask(name), A);
      assert.equal(callsFor(name).length, 2, `${name} riding`);
    }
    assert.deepEqual(await ask(three), A);
    assert.equal(callsFor(three).length, 1, 'the third waiting, on no lane');
    // The first rider answers 400 ms on, by the resolver's clock: past ROUTE_MS, inside the window.
    clock.now += 400;
    callsFor(one)[1]?.answer();
    await pollWithin(1_000, 'the third riding', () => callsFor(three).length === 2, 2);
    assert.equal(asker.askedFor(three).length, 1, 'the third not walked');
    for (const name of [two, three]) for (const call of callsFor(name)) call.answer();
    resolver.stop();
  });

  it('a name failed as it leaves the probe’s queues is counted in the hour’s summary as faulted', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, calls, clock, ask } = await make({
      stuckMs: 5_000,
      tickMs: 5,
      logger,
      routeMs: D27_ROUTE,
    });
    const held = [0, 1, 2, 3].map((zone) =>
      ask(`dev-1.zone-c${String(zone)}.test`, { waitMs: 10_000 }).catch(() => undefined),
    );
    await pollWithin(1_000, 'four on lanes', () => calls.length === 4, 2);
    const got = failed(ask(X, { waitMs: 2_000 }, 0));
    await wait(ROUTE * 2);
    helper.avoided.add(`4:${X}`);
    helper.move('down');
    calls[0]?.answer();
    assert.equal((await got).code, RESOLVER_FAULT);
    clock.now += GATE_SUMMARY_MS;
    await pollWithin(
      1_000,
      'the hour’s summary',
      () => lines.some((line) => line['msg'] === 'the probe’s resolver in gate mode, this hour'),
      5,
    );
    const summary = lines.find(
      (line) => line['msg'] === 'the probe’s resolver in gate mode, this hour',
    );
    assert.equal((summary?.['routed'] as { faulted?: unknown } | undefined)?.faulted, 1);
    assert.equal(summary?.['checksFaulted'], 1, 'and its one check');
    for (const call of calls) call.answer();
    await Promise.all(held);
    resolver.stop();
  });

  it('the hour’s summary carries the helper’s quiets and the most names it kept off the probe’s lanes at once (P-463 fix round 1)', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, clock } = await make({ tickMs: 5, logger });
    helper.quiets = 4;
    helper.keptOffPeak = 9;
    clock.now += GATE_SUMMARY_MS;
    const SUMMARY = 'the probe’s resolver in gate mode, this hour';
    await pollWithin(
      1_000,
      'the hour’s summary',
      () => lines.some((line) => line['msg'] === SUMMARY),
      5,
    );
    const summary = lines.find((line) => line['msg'] === SUMMARY);
    const said = summary?.['helper'] as
      { readonly quiets?: unknown; readonly keptOffPeak?: unknown } | undefined;
    assert.equal(said?.quiets, 4, JSON.stringify(summary));
    assert.equal(said.keptOffPeak, 9);
    resolver.stop();
  });
});

/**
 * D27 when the asking check's own pump starts the lookup (`P-432` gate, fix round 1). X is heard
 * and queued on the probe's lanes, held back by `P-438`'s rule for a domain not known to answer
 * (zone A's three names hold the 3 first lanes it may) beside a free fourth, and a first check
 * waits for it. Then X becomes a name the probe may not ask, and "Check now" joins it: promoted,
 * it is exempt from the rule, so the pump in that same ask starts it, and `#offProbe` refuses it
 * there or moves it to the helper. Refused, it fails the check asking at once with the refusal,
 * as it fails the one waiting, and on a worker's port with a reply and no acknowledgement; not
 * after the check's whole bound, on a lookup already settled (`RESOLVER_LATE`).
 */
interface JoinedRow {
  readonly kind: 'crashed' | 'poison';
  readonly route: 'up' | 'down' | 'resting';
  /** The resolver stopped, as the probe's shutdown stops it, once the name is avoided. */
  readonly stopped?: true;
  /** "Check now" as a worker asks, on its port (`handle`), rather than by `resolve`. */
  readonly port?: true;
  /** Both answered in the helper, or both failed at once in these words. */
  readonly expect: 'helper' | RegExp;
}

const JOINED_ROWS: readonly JoinedRow[] = [
  { kind: 'crashed', route: 'up', expect: 'helper' },
  { kind: 'crashed', route: 'down', expect: AVOIDED },
  { kind: 'crashed', route: 'down', port: true, expect: AVOIDED },
  { kind: 'crashed', route: 'resting', expect: AVOIDED },
  { kind: 'poison', route: 'up', expect: POISON },
  { kind: 'poison', route: 'down', expect: POISON },
  { kind: 'crashed', route: 'up', stopped: true, expect: STOPPING },
  { kind: 'crashed', route: 'down', stopped: true, expect: STOPPING },
];

/** The "Check now"'s bound: a check left waiting on a settled lookup is told only after it. */
const CHECK_NOW_MS = 1_500;

const joinedTitle = (row: JoinedRow): string =>
  `${row.kind}, ${row.route}${row.stopped === true ? ', stopped' : ''}` +
  `${row.port === true ? ', on a worker’s port' : ''}: ` +
  (row.expect === 'helper'
    ? 'both asked in the helper'
    : `both fail at once (${row.expect.source})`);

/** A worker's request on its port: what was posted, and what the reply told its check. */
function onPort(
  resolver: NameResolver,
  request: { readonly host: string; readonly family: Family; readonly waitMs: number },
): { readonly posted: string[]; readonly got: Promise<{ code: unknown; message: string }> } {
  const posted: string[] = [];
  const got = new Promise<{ code: unknown; message: string }>((resolve) => {
    resolver.handle({ type: 'resolve', id: 1, fresh: true, ...request }, (message) => {
      posted.push(message.type);
      if (message.type !== 'resolved') return;
      resolve(
        message.ok
          ? { code: undefined, message: 'answered' }
          : { code: message.code, message: message.message },
      );
    });
  });
  return { posted, got };
}

async function joined(row: JoinedRow): Promise<void> {
  const { resolver, helper, asker, callsFor, clock, ask } = await make({
    stuckMs: 5_000,
    routeMs: D27_ROUTE,
  });
  const title = joinedTitle(row);
  const zone = ['dev-1.zone-a.test', 'dev-2.zone-a.test', 'dev-3.zone-a.test'];
  const held: Promise<unknown>[] = [];
  for (const name of zone) {
    held.push(ask(name, { waitMs: 10_000 }).catch(() => undefined));
    await pollWithin(1_000, `${title}: ${name} on a lane`, () => callsFor(name).length === 1, 2);
  }
  const first = failed(ask(X, { waitMs: 4_000 }, 0));
  await pollWithin(
    1_000,
    `${title}: heard`,
    () => asker.askedFor(X).length > 0 && asker.askedFor(X).every((q) => q.replied !== undefined),
    2,
  );
  await wait(ROUTE);
  assert.equal(resolver.stats().queued, 1, `${title}: queued on a probe lane`);
  assert.equal(resolver.stats().running, 3, `${title}: held back beside a free first lane`);
  assert.equal(helper.asksFor(X).length, 0, `${title}: not in the helper`);
  if (row.kind === 'crashed') helper.avoided.add(`4:${X}`);
  else helper.markPoison(X, 0, clock.now + 3_600_000);
  if (row.route !== 'up') helper.move(row.route);
  if (row.stopped === true) resolver.stop();
  const port =
    row.port === true ? onPort(resolver, { host: X, family: 0, waitMs: CHECK_NOW_MS }) : undefined;
  const now = port?.got ?? failed(ask(X, { fresh: true, waitMs: CHECK_NOW_MS }, 0));
  if (row.expect === 'helper') {
    await pollWithin(1_000, `${title}: in the helper`, () => helper.asksFor(X).length === 1, 2);
    helper.last(X).answer(A);
    assert.equal((await within(2_000, `${title}: Check now`, now)).message, 'answered', title);
    assert.equal((await within(2_000, `${title}: the first`, first)).message, 'answered', title);
  } else {
    // At once: well inside the bound, which a check left waiting on the settled lookup outlives.
    const said = await within(CHECK_NOW_MS / 3, `${title}: Check now at once`, now);
    assert.equal(said.code, RESOLVER_FAULT, `${title}: ${said.message}`);
    assert.match(said.message, row.expect, title);
    const before = await within(1_000, `${title}: the first check`, first);
    assert.equal(before.code, RESOLVER_FAULT, `${title}: ${before.message}`);
    assert.match(before.message, row.expect, title);
    if (port !== undefined) {
      assert.deepEqual(port.posted, ['resolved'], `${title}: a reply, no acknowledgement`);
    }
  }
  assert.equal(callsFor(X).length, 0, `${title}: never on the probe’s own getaddrinfo`);
  for (const name of zone) for (const call of callsFor(name)) call.answer();
  await Promise.all(held);
  resolver.stop();
}

describe('D27 when "Check now" starts a lookup in its own ask (P-432 gate, fix round 1)', () => {
  for (const row of JOINED_ROWS) {
    it(joinedTitle(row), async () => {
      await joined(row);
    });
  }
});

/**
 * The hour's summary (`P-467`), where the field test reads what Probe Health no longer carries
 * since the user's decision of 2026-10-18 (OPEN-5): six name fields at protocol 38, not fourteen.
 */
describe('gate mode’s hourly summary (P-432, P-467)', () => {
  /**
   * What Probe Health carried before the user's decision of 2026-10-18 (OPEN-5) and does not now,
   * the hour's summary says (`P-467`): the helper's changes of state and its losses, each loss with
   * its reason and how its child ended, read once its exit says; its resident memory now; the
   * check's state, and why when it is off; and the lookups heard, in the helper, the misses and
   * the walks deferred, this hour and since the start. Each hour starts its own lists and counts.
   */
  it('says in the hour’s summary what Probe Health does not carry: the helper’s changes and losses, its memory, the check’s state, and the hour’s counts (P-467)', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, policy, callsFor, clock, ask } = await make({ logger, tickMs: 5 });
    helper.rss = 52_428_800;
    const heard = ask('dev-21.zone-a.test');
    const quiet = ask('dev-21.zone-b.test');
    // Answered at once on the probe's lanes, so that it never runs past the bound for stuck.
    await pollWithin(1_000, 'heard', () => callsFor('dev-21.zone-a.test').length === 1, 1);
    callsFor('dev-21.zone-a.test')[0]?.answer();
    await pollWithin(1_000, 'in the helper', () => helper.asks.length === 1, 2);
    helper.last('dev-21.zone-b.test').answer(A);
    assert.deepEqual(await heard, A);
    assert.deepEqual(await quiet, A);
    await pollWithin(1_000, 'the miss', () => resolver.gateHealth()?.misses === 1, 5);
    // A crash, its signal read with the loss; then a hang, whose child exits after it.
    helper.lose('exit', 'rejoining', { signal: 'SIGSEGV' });
    await wait(1);
    helper.move('up');
    helper.lose('hung', 'rejoining');
    await wait(1);
    const lastLoss = helper.lastLoss;
    assert.ok(lastLoss !== undefined);
    lastLoss.signal = 'SIGKILL';

    const first = await summaryAfter(lines, clock, 0);
    assert.equal(first['level'], 30, 'info');
    assert.deepEqual(first['hour'], {
      lookupsHeard: 1,
      lookupsToHelper: 1,
      misses: 1,
      walksDeferred: 0,
      passedStuck: 0,
      helperStuck: 0,
    });
    assert.equal(first['lookupsHeard'], 1);
    assert.equal(first['lookupsToHelper'], 1);
    assert.equal(first['misses'], 1);
    const check = first['check'] as Record<string, unknown>;
    assert.equal(check['state'], 1);
    assert.equal(check['misses'], 1);
    const said = first['helper'] as Record<string, unknown>;
    assert.equal(said['state'], 'backoff');
    assert.equal(said['rss'], 52_428_800, 'its resident memory now, in bytes');
    assert.deepEqual(said['losses'], { start: 0, skew: 0, exit: 1, hung: 1, memory: 0, total: 2 });
    const changes = said['changes'] as Record<string, unknown>[];
    assert.deepEqual(
      changes.map(({ at: _at, ...change }) => change),
      [
        { from: 'up', to: 'backoff', loss: 'exit' },
        { from: 'backoff', to: 'up' },
        { from: 'up', to: 'backoff', loss: 'hung' },
      ],
    );
    for (const change of changes) assert.ok(!Number.isNaN(Date.parse(String(change['at']))));
    const lost = said['lost'] as Record<string, unknown>[];
    assert.deepEqual(
      lost.map(({ at: _at, ...loss }) => loss),
      [
        {
          reason: 'exit',
          pid: 4242,
          why: 'the test lost it (exit)',
          signal: 'SIGSEGV',
          exitCode: null,
        },
        {
          reason: 'hung',
          pid: 4242,
          why: 'the test lost it (hung)',
          signal: 'SIGKILL',
          exitCode: null,
        },
      ],
      'each loss with its reason, and the hang’s signal read after it',
    );
    assert.equal('changesNotListed' in said, false);

    // The next hour starts its own: nothing happened in it. With no child, its memory is null.
    helper.rss = undefined;
    policy.off = { code: 'env', why: 'RES_OPTIONS is set' };
    const second = await summaryAfter(lines, clock, 1);
    assert.deepEqual(second['hour'], {
      lookupsHeard: 0,
      lookupsToHelper: 0,
      misses: 0,
      walksDeferred: 0,
      passedStuck: 0,
      helperStuck: 0,
    });
    assert.equal(second['misses'], 1, 'the running total stands');
    const next = second['helper'] as Record<string, unknown>;
    assert.deepEqual(next['changes'], []);
    assert.deepEqual(next['lost'], []);
    assert.equal(next['rss'], null);
    const off = second['check'] as Record<string, unknown>;
    assert.equal(off['state'], 2);
    assert.equal(off['said'], CHECK_STATE_SAID[2]);
    assert.deepEqual(off['off'], { code: 'env', why: 'RES_OPTIONS is set' });
    resolver.stop();
  });

  it('lists the first of the helper’s changes and losses in an hour, and counts the rest (P-467)', async () => {
    const { logger, lines } = captured();
    const { resolver, helper, clock } = await make({ logger, tickMs: 5 });
    for (let loss = 0; loss < SUMMARY_LISTED + 2; loss += 1) {
      helper.lose('exit', 'rejoining', { exitCode: 1 });
      await wait(0);
      helper.move('up');
    }
    await wait(1);
    const said = (await summaryAfter(lines, clock, 0))['helper'] as Record<string, unknown>;
    assert.equal((said['changes'] as unknown[]).length, SUMMARY_LISTED);
    assert.equal(said['changesNotListed'], (SUMMARY_LISTED + 2) * 2 - SUMMARY_LISTED);
    assert.equal((said['lost'] as unknown[]).length, SUMMARY_LISTED);
    assert.equal(said['lostNotListed'], 2);
    assert.equal((said['losses'] as Record<string, unknown>)['total'], SUMMARY_LISTED + 2);
    resolver.stop();
  });
});

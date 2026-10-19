import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { notAnswered, RESOLVER_FAULT, RESOLVER_HELD, type ResolvedAddress } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { ForwardBudget } from '../src/resolver/forward-budget.js';
import { HelperKeys } from '../src/resolver/lane-rule.js';
import { ANSWER_MS, NameResolver, STALE_MS, type Family } from '../src/resolver/name-resolver.js';
import { ScriptedAsker, WalkPolicy } from './support/fake-dns.js';
import { FakeHelper } from './support/fake-helper.js';
import { pollWithin } from './support/within.js';

/**
 * The resolver in gate mode with the name check built (`P-432` S6, §1.3): a lookup whose walk was
 * heard runs on the probe's lanes, one whose walk went unanswered in the helper, and only there,
 * a refresh rides its zone's heard walk, and a name heard that then sticks on a lane makes its
 * zone unsafe. DNS is a scripted asker, the helper a fake one, and `getaddrinfo` on the probe's
 * lanes is settled by hand; the routing wait is a real 60 ms.
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
  } = {},
) {
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };
  const helper = new FakeHelper(() => clock.now);
  if (setup.route !== undefined) helper.route = setup.route;
  const policy = new WalkPolicy();
  const asker = new ScriptedAsker();
  asker.rule = (_server, name) => (name.endsWith('zone-b.test') ? 'silent' : 'answer');
  const budget = new ForwardBudget({ now: () => clock.now });
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
      check: { asker, routeMs: ROUTE, missMs: MISS },
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

  it('says the check’s state and counts for Probe Health: walks deferred past the pool, and 0 while the helper rests', async () => {
    const { resolver, helper, asker, ask } = await make();
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
    assert.ok(said.lookupsToHelper >= 4, 'in the helper');
    assert.ok(helper.asks.length >= 4);
    assert.equal(said.checkState, 1);
    helper.move('resting');
    assert.equal(resolver.gateHealth()?.checkState, 0, 'resting: the check routes nothing');
    assert.equal(resolver.gateHealth()?.mode, 3);
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

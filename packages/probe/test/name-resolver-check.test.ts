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
import {
  ANSWER_MS,
  CHECK_STATE_SAID,
  GATE_SUMMARY_MS,
  NameResolver,
  STALE_MS,
  SUMMARY_LISTED,
  type Family,
} from '../src/resolver/name-resolver.js';
import { ScriptedAsker, WalkPolicy } from './support/fake-dns.js';
import { FakeHelper } from './support/fake-helper.js';
import { pollWithin, within } from './support/within.js';

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
    assert.ok(said.lookupsToHelper >= 4, 'in the helper');
    assert.ok(helper.asks.length >= 4);
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

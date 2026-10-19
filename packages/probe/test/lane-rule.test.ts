import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  firstLoad,
  gateFirstRule,
  heldBy,
  mayStart,
  probeFirstRule,
  type DomainHistory,
  type HeldBy,
  type KeyLoad,
  type KeyRule,
  type RunningLookup,
} from '../src/resolver/lane-rule.js';

/**
 * `P-432`'s lane rule (S1): `mayStart`'s truth table (LR1), the probe's first-lane rule held to
 * `P-438`'s as built (LR2), and the gate's (LR2b). LR2 and LR2b are exhaustive over a grid of
 * domains, lookups in flight, histories and lane sets, against `P-438`'s `#heldBack` written out
 * again below as it was built (`d94ac497`), so that any change to what the rule decides shows here
 * before it shows in a scenario.
 */

const INF = Number.POSITIVE_INFINITY;
const DOMAIN = 'zone-b.test';
const OTHER = 'zone-a.test';
const NOW = 100_000;
const STUCK = 1_000;

type Held = 'domain' | 'shared' | undefined;

/** A domain's count as `P-438` keeps it, with what `#answering` says of it. */
interface Count extends DomainHistory {
  readonly answers: boolean;
}

/** Everything `P-438`'s `#heldBack` reads once a first lookup of `DOMAIN` is past its exemptions. */
interface World {
  /** `P-426`'s lane set: the first lanes, the refresh lanes, and the lanes the two share. */
  readonly firstCap: number;
  readonly refreshCap: number;
  readonly sharedCap: number;
  readonly count: Count | undefined;
  readonly first: readonly RunningLookup[];
  readonly refresh: readonly RunningLookup[];
  readonly retry: readonly RunningLookup[];
  readonly refreshQueued: number;
  /** The domain's helper lookups the child reported stuck: gate mode only (LR2b). */
  readonly helperStuck: number;
}

/** How often `#answering` was asked. */
interface Asked {
  count: number;
}

/**
 * `P-438`'s `#heldBack` as built (`d94ac497`), from the line after its exemptions ("Check now", and
 * a name the hosts file gives), over a world. Its own `silentSoFar` and `#stuckLately` are written
 * out here too, so the lane rule's copies are held to these. In gate mode (D24) a helper lookup
 * stuck is one more lookup stuck. Its `domain` is named for the lane rule as the limit that held
 * it: `cappedLanes` when the domain had a lookup stuck, `unacked` when it was not known to answer.
 */
function p438(world: World, asked: Asked): HeldBy | undefined {
  const { firstCap, sharedCap, refreshCap } = world;
  const domainFirstCap = Math.max(1, firstCap - 1);
  const count = world.count;
  const now = NOW;
  const silentSoFar = (running: RunningLookup): boolean =>
    running.stuck && (count === undefined || count.slowSeq <= running.startedSeq);
  const stuckLately = (kept: Count): boolean => {
    if (kept.stuckSeq > kept.answeredSeq) return true;
    return kept.stuckAt !== undefined && now - kept.stuckAt < STUCK;
  };
  const answering = (kept: Count): boolean => {
    asked.count += 1;
    return kept.answers;
  };
  const named = (held: Held, stuck: boolean): HeldBy | undefined =>
    held === 'domain' ? (stuck ? 'cappedLanes' : 'unacked') : held;
  let held = 0;
  let stuck = count !== undefined && stuckLately(count);
  for (const running of world.first) {
    if (running.entry.domain !== DOMAIN) continue;
    held += 1;
    if (silentSoFar(running)) stuck = true;
  }
  for (const running of [...world.refresh, ...world.retry]) {
    if (running.entry.domain === DOMAIN && silentSoFar(running)) stuck = true;
  }
  if (world.helperStuck > 0) stuck = true;
  if (!stuck && count !== undefined && answering(count)) return undefined;
  if (held >= domainFirstCap) return named('domain', stuck);
  if (!stuck) return undefined;
  const refreshes = Math.min(refreshCap, world.refresh.length + world.refreshQueued);
  if (world.first.length + 1 + refreshes >= sharedCap) return 'shared';
  return undefined;
}

/** What `NameResolver.#heldBack` now decides for the same world: the lane rule with `rule`. */
function laneRule(world: World, rule: KeyRule, asked: Asked): HeldBy | undefined {
  return heldBy(
    firstLoad({
      domain: DOMAIN,
      history: world.count,
      now: NOW,
      stuckMs: STUCK,
      running: {
        first: new Set(world.first),
        refresh: new Set(world.refresh),
        retry: new Set(world.retry),
      },
      refreshQueued: world.refreshQueued,
      refreshCap: world.refreshCap,
      helperStuck: world.helperStuck,
      answering: (count) => {
        asked.count += 1;
        return count.answers;
      },
    }),
    rule,
  );
}

function lookup(domain: string, stuck: boolean, startedSeq: number): RunningLookup {
  return { entry: { domain }, stuck, startedSeq };
}

/**
 * Lookups of `DOMAIN` in flight, by how they bear on it: not stuck; stuck with no slow answer since
 * it started (silent so far); stuck, started before the slow answer at `slowSeq` 5 (slow, not
 * silent); and stuck, started at that answer's event (silent: the answer is not after it).
 */
const ok = (): RunningLookup => lookup(DOMAIN, false, 10);
const silent = (): RunningLookup => lookup(DOMAIN, true, 10);
const slow = (): RunningLookup => lookup(DOMAIN, true, 2);
const atSlow = (): RunningLookup => lookup(DOMAIN, true, 5);
/** Another domain's, stuck: never its neighbour's evidence. */
const otherStuck = (): RunningLookup => lookup(OTHER, true, 10);

/** Domain histories, each with the event of its last slow answer at 5 where it has one. */
const HISTORIES: Readonly<Record<string, DomainHistory | undefined>> = {
  /** No name of it kept. */
  none: undefined,
  /** Kept, never answered, never stuck. */
  quiet: { answeredSeq: 0, slowSeq: 0, stuckAt: undefined, stuckSeq: 0 },
  answered: { answeredSeq: 6, slowSeq: 5, stuckAt: undefined, stuckSeq: 0 },
  /** L4: a lookup ended stuck after its last answer, long ago. */
  stuckSinceAnswer: { answeredSeq: 6, slowSeq: 5, stuckAt: NOW - 5 * STUCK, stuckSeq: 7 },
  /** L4: one ended stuck within `STUCK_MS`, with an answer since. */
  stuckWithin: { answeredSeq: 8, slowSeq: 5, stuckAt: NOW - STUCK / 2, stuckSeq: 7 },
  /** One ended stuck `STUCK_MS` ago exactly, with an answer since: no longer lately. */
  stuckAtEdge: { answeredSeq: 8, slowSeq: 5, stuckAt: NOW - STUCK, stuckSeq: 7 },
  stuckLongAgo: { answeredSeq: 8, slowSeq: 5, stuckAt: NOW - 5 * STUCK, stuckSeq: 7 },
  /** Never answered, and one of its lookups ended stuck long ago. */
  neverAnsweredStuck: { answeredSeq: 0, slowSeq: 0, stuckAt: NOW - 5 * STUCK, stuckSeq: 3 },
};

function counted(history: DomainHistory | undefined, answers: boolean): Count | undefined {
  return history === undefined ? undefined : { ...history, answers };
}

/**
 * The lane sets of the grid: `P-426`'s first lanes 1 to 6 (3 to 8 lanes), each with its refresh
 * lanes, and the shared lanes as `P-426` has them (one more than the first lanes) and one more
 * again, so that a rule which works the shared lanes out from the first ones fails.
 */
const LANE_SETS: readonly (readonly [firstCap: number, sharedCap: number])[] = [
  1, 2, 3, 4, 5, 6,
].flatMap((firstCap): (readonly [number, number])[] => [
  [firstCap, firstCap + 1],
  [firstCap, firstCap + 2],
]);

/** The grid's worlds per lane set: 19 first-lane patterns × 2 × 5 × 2 × 4 × 5 × 15 histories. */
const PER_LANE_SET = 19 * 2 * 5 * 2 * 4 * 5 * 15;

/**
 * Every world of the grid, each once: each lane set; the domain holding 0 to 6 first lanes, the
 * first of them not stuck, silent so far or slow; another domain's stuck first lookups; the
 * domain's refreshes and retries in each state, and another's; refreshes queued; each history; and
 * known to answer or not, for a history kept (with none kept, `#answering` is never asked).
 */
function* grid(helperStuck: number): Generator<World> {
  const firstOf = (held: number, pattern: () => RunningLookup): RunningLookup[] =>
    Array.from({ length: held }, (_, i) => (i === 0 ? pattern() : ok()));
  const refreshes: (() => RunningLookup[])[] = [
    () => [],
    () => [ok()],
    () => [silent()],
    () => [slow()],
    () => [ok(), silent()],
  ];
  const retries: (() => RunningLookup[])[] = [
    () => [],
    () => [ok()],
    () => [silent()],
    () => [slow()],
    () => [otherStuck()],
  ];
  for (const [firstCap, sharedCap] of LANE_SETS) {
    for (let held = 0; held <= 6; held += 1) {
      for (const pattern of held === 0 ? [ok] : [ok, silent, slow]) {
        for (const others of [0, 2]) {
          for (const refresh of refreshes) {
            for (const otherRefreshes of [0, 2]) {
              for (const refreshQueued of [0, 1, 3, 6]) {
                for (const retry of retries) {
                  for (const history of Object.values(HISTORIES)) {
                    for (const answers of history === undefined ? [false] : [true, false]) {
                      yield {
                        firstCap,
                        refreshCap: firstCap,
                        sharedCap,
                        count: counted(history, answers),
                        first: [
                          ...firstOf(held, pattern),
                          ...Array.from({ length: others }, otherStuck),
                        ],
                        refresh: [
                          ...refresh(),
                          ...Array.from({ length: otherRefreshes }, otherStuck),
                        ],
                        retry: retry(),
                        refreshQueued,
                        helperStuck,
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

/** A world of `P-426`'s 6 lanes with nothing in flight, `DOMAIN` answered and known to answer. */
function world(overrides: Partial<World>): World {
  return {
    firstCap: 4,
    refreshCap: 4,
    sharedCap: 5,
    count: counted(HISTORIES['answered'], true),
    first: [],
    refresh: [],
    retry: [],
    refreshQueued: 0,
    helperStuck: 0,
    ...overrides,
  };
}

/** `P-426`'s 6 lanes: 4 first, and 5 shared by first lookups and refreshes. */
const SIX = probeFirstRule(4, 5);

/** Both the rule as built and the lane rule say `expected`, asking `#answering` as often. */
function bothSay(subject: World, rule: KeyRule, expected: HeldBy | undefined, why: string): void {
  const before: Asked = { count: 0 };
  const now: Asked = { count: 0 };
  assert.equal(p438(subject, before), expected, `P-438 as built: ${why}`);
  assert.equal(laneRule(subject, rule, now), expected, `the lane rule: ${why}`);
  assert.equal(now.count, before.count, `#answering asked as often: ${why}`);
}

/**
 * Every world of the grid decides alike, naming the same limit, and every outcome is reached with
 * every lane set. Returns how many worlds there were.
 */
function sweep(
  helperStuck: number,
  ruleFor: (firstCap: number, sharedCap: number) => KeyRule,
): number {
  let worlds = 0;
  const seen = new Map<string, Set<string>>();
  for (const subject of grid(helperStuck)) {
    const before: Asked = { count: 0 };
    const now: Asked = { count: 0 };
    const expected = p438(subject, before);
    const actual = laneRule(subject, ruleFor(subject.firstCap, subject.sharedCap), now);
    if (actual !== expected || now.count !== before.count) {
      assert.fail(
        `${String(actual)} (asked ${String(now.count)}) where P-438 says ${String(expected)} ` +
          `(asked ${String(before.count)}) for ${JSON.stringify(subject)}`,
      );
    }
    const set = `${String(subject.firstCap)}/${String(subject.sharedCap)}`;
    const outcomes = seen.get(set) ?? new Set<string>();
    outcomes.add(String(expected));
    if (before.count > 0) outcomes.add('asked');
    seen.set(set, outcomes);
    worlds += 1;
  }
  for (const [firstCap, sharedCap] of LANE_SETS) {
    const set = `${String(firstCap)}/${String(sharedCap)}`;
    const outcomes = [...(seen.get(set) ?? [])].sort();
    const want =
      helperStuck > 0
        ? ['cappedLanes', 'shared', 'undefined']
        : ['asked', 'cappedLanes', 'shared', 'unacked', 'undefined'];
    assert.deepEqual(outcomes, want, `every outcome reached with the lane set ${set}`);
  }
  return worlds;
}

describe('the lane rule (P-432 S1)', () => {
  describe('LR1: mayStart', () => {
    const rule: KeyRule = { lanes: 4, cappedLanes: 3, unacked: 3, sharedLanes: 5 };
    const helper: KeyRule = { lanes: INF, cappedLanes: 3, unacked: INF, sharedLanes: INF };
    const none: KeyRule = { lanes: INF, cappedLanes: INF, unacked: INF, sharedLanes: INF };
    const load = (running: number, unacked: number, capped: boolean, sharedTaken = 0): KeyLoad => ({
      running,
      unacked,
      capped,
      sharedTaken,
    });
    const rows: readonly (readonly [string, KeyLoad, KeyRule, HeldBy | undefined])[] = [
      ['uncapped, nothing running', load(0, 0, false), rule, undefined],
      ['uncapped, one below its lanes', load(3, 0, false), rule, undefined],
      ['uncapped, at its lanes', load(4, 0, false), rule, 'lanes'],
      ['uncapped, at its lanes and its unacked: its lanes named', load(4, 4, false), rule, 'lanes'],
      ['uncapped, unacked one below', load(3, 2, false), rule, undefined],
      ['uncapped, at its unacked', load(3, 3, false), rule, 'unacked'],
      ['uncapped, the last shared lane is anyone’s', load(2, 2, false, 4), rule, undefined],
      ['capped, one below its capped lanes', load(2, 0, true), rule, undefined],
      ['capped, at its capped lanes though below its lanes', load(3, 0, true), rule, 'cappedLanes'],
      ['capped, its unacked not asked', load(2, 3, true), rule, undefined],
      ['capped, taking the last shared lane', load(2, 0, true, 4), rule, 'shared'],
      ['capped, its own lanes asked before the shared', load(3, 0, true, 4), rule, 'cappedLanes'],
      ['capped, a shared lane besides the last', load(0, 0, true, 3), rule, undefined],
      ['the helper’s: uncapped, any number', load(100, 100, false, 100), helper, undefined],
      ['the helper’s: capped, at 3', load(3, 0, true, 100), helper, 'cappedLanes'],
      ['the helper’s: capped, below 3, no shared lanes', load(2, 0, true, 100), helper, undefined],
      // A limit that is not finite is no limit, whatever the load says; a finite one holds an
      // infinite load.
      [
        'uncapped, an infinite unacked against no unacked limit',
        load(1, INF, false),
        helper,
        undefined,
      ],
      ['uncapped, an infinite unacked against a finite one', load(1, INF, false), rule, 'unacked'],
      [
        'uncapped, infinitely many running against no lanes limit',
        load(INF, 0, false),
        none,
        undefined,
      ],
      [
        'uncapped, infinitely many running against finite lanes',
        load(INF, 0, false),
        rule,
        'lanes',
      ],
      [
        'capped, infinitely many running against no capped limit',
        load(INF, 0, true),
        none,
        undefined,
      ],
      [
        'capped, infinitely many running against finite capped lanes',
        load(INF, 0, true),
        rule,
        'cappedLanes',
      ],
      [
        'capped, infinitely many shared taken against no shared lanes',
        load(0, 0, true, INF),
        none,
        undefined,
      ],
      [
        'capped, infinitely many shared taken against finite shared lanes',
        load(0, 0, true, INF),
        rule,
        'shared',
      ],
    ];
    for (const [why, subject, keyRule, expected] of rows) {
      it(`${why}: ${expected ?? 'may start'}`, () => {
        assert.equal(heldBy(subject, keyRule), expected);
        assert.equal(mayStart(subject, keyRule), expected === undefined);
      });
    }

    it('is the design’s rule wherever there is no shared-lane rule, and the shared lane binds only a capped key', () => {
      let cases = 0;
      for (const lanes of [0, 1, 4, INF]) {
        for (const cappedLanes of [0, 1, 3, INF]) {
          for (const unacked of [0, 1, 3, INF]) {
            for (const sharedLanes of [0, 3, 5, INF]) {
              const keyRule: KeyRule = { lanes, cappedLanes, unacked, sharedLanes };
              for (let running = 0; running <= 6; running += 1) {
                for (let unackedNow = 0; unackedNow <= running; unackedNow += 1) {
                  for (const capped of [false, true]) {
                    for (let sharedTaken = 0; sharedTaken <= 7; sharedTaken += 1) {
                      const subject = load(running, unackedNow, capped, sharedTaken);
                      const held = heldBy(subject, keyRule);
                      assert.equal(mayStart(subject, keyRule), held === undefined);
                      if (held === 'shared') assert.ok(capped, 'shared only while capped');
                      const design = capped
                        ? running < cappedLanes
                        : running < lanes && unackedNow < unacked;
                      const own = capped ? 'cappedLanes' : running >= lanes ? 'lanes' : 'unacked';
                      if (sharedLanes === INF) assert.equal(held === undefined, design);
                      else assert.equal(held !== undefined && held !== 'shared', !design);
                      if (!design) assert.equal(held, own, 'the limit it is at, named');
                      cases += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
      assert.equal(cases, 4 * 4 * 4 * 4 * 28 * 2 * 8);
    });
  });

  describe('LR2: probeFirstRule is P-438’s rule as built', () => {
    it('holds a domain known to answer, with nothing stuck, to nothing but its class', () => {
      for (let held = 0; held <= 6; held += 1) {
        bothSay(
          world({ first: Array.from({ length: held }, ok) }),
          SIX,
          undefined,
          `${String(held)} held`,
        );
      }
    });

    it('holds a domain not known to answer to 3 of 4 first lanes, with nothing stuck, by its unacked', () => {
      for (const name of ['quiet', 'answered', 'stuckLongAgo'] as const) {
        const count = counted(HISTORIES[name], false);
        bothSay(world({ count, first: [ok(), ok()] }), SIX, undefined, '2 held');
        bothSay(world({ count, first: [ok(), ok(), ok()] }), SIX, 'unacked', '3 held');
      }
    });

    it('caps a domain known to answer with a lookup in flight silent so far, of any class', () => {
      const three = [silent(), ok(), ok()];
      bothSay(world({ first: three }), SIX, 'cappedLanes', 'a first lookup');
      bothSay(
        world({ first: [ok(), ok(), ok()], refresh: [silent()] }),
        SIX,
        'cappedLanes',
        'a refresh',
      );
      bothSay(
        world({ first: [ok(), ok(), ok()], retry: [silent()] }),
        SIX,
        'cappedLanes',
        'a retry',
      );
    });

    it('slow: a lookup past STUCK_MS that started before a slow answer does not cap; one started at it does', () => {
      bothSay(world({ first: [slow(), ok(), ok()] }), SIX, undefined, 'started before');
      bothSay(
        world({ first: [ok(), ok(), ok()], refresh: [slow()] }),
        SIX,
        undefined,
        'a refresh, before',
      );
      bothSay(world({ first: [atSlow(), ok(), ok()] }), SIX, 'cappedLanes', 'started at it');
    });

    it('never counts another domain’s stuck lookups', () => {
      bothSay(
        world({
          first: [ok(), ok(), ok(), otherStuck()],
          refresh: [otherStuck()],
          retry: [otherStuck()],
        }),
        SIX,
        undefined,
        'its neighbour stuck',
      );
    });

    it('L4: caps a domain whose lookup ended stuck since its last answer, or within STUCK_MS', () => {
      const three = (): RunningLookup[] => [ok(), ok(), ok()];
      for (const [name, expected] of [
        ['stuckSinceAnswer', 'cappedLanes'],
        ['stuckWithin', 'cappedLanes'],
        ['neverAnsweredStuck', 'cappedLanes'],
        ['stuckAtEdge', undefined],
        ['stuckLongAgo', undefined],
      ] as const) {
        bothSay(
          world({ count: counted(HISTORIES[name], true), first: three() }),
          SIX,
          expected,
          name,
        );
      }
    });

    it('L2: a capped domain never takes the last shared lane, counting the refreshes queued', () => {
      const count = counted(HISTORIES['stuckWithin'], true);
      const others = [lookup(OTHER, false, 10)];
      bothSay(world({ count, first: others, refreshQueued: 3 }), SIX, 'shared', '1 + 1 + 3 queued');
      bothSay(
        world({ count, first: others, refreshQueued: 2 }),
        SIX,
        undefined,
        '1 + 1 + 2 queued',
      );
      bothSay(
        world({ count, first: others, refresh: [lookup(OTHER, false, 10)], refreshQueued: 2 }),
        SIX,
        'shared',
        '1 + 1 + 1 running + 2 queued',
      );
      bothSay(
        world({ count: counted(HISTORIES['quiet'], false), first: others, refreshQueued: 3 }),
        SIX,
        undefined,
        'uncapped, the last shared lane is anyone’s',
      );
    });

    it('takes the shared lanes from the lane set it is given, not from its first lanes', () => {
      assert.equal(probeFirstRule(4, 5).sharedLanes, 5);
      assert.equal(probeFirstRule(4, 7).sharedLanes, 7);
      const count = counted(HISTORIES['stuckWithin'], true);
      const others = [lookup(OTHER, false, 10)];
      // 1 first lookup running + this one + 3 refreshes queued: the last of 5 shared lanes, and
      // the fifth of 6.
      bothSay(
        world({ count, first: others, refreshQueued: 3 }),
        probeFirstRule(4, 5),
        'shared',
        '5 shared',
      );
      bothSay(
        world({ count, first: others, refreshQueued: 3, sharedCap: 6 }),
        probeFirstRule(4, 6),
        undefined,
        '6 shared',
      );
    });

    it('asks nothing of a domain with no name kept, and counts every stuck lookup of it silent', () => {
      bothSay(world({ count: undefined, first: [ok(), ok()] }), SIX, undefined, '2 held');
      bothSay(world({ count: undefined, first: [ok(), ok(), ok()] }), SIX, 'unacked', '3 held');
      bothSay(
        world({ count: undefined, first: [slow()], refreshQueued: 4 }),
        SIX,
        'shared',
        'slow',
      );
    });

    it('with 3 lanes, holds a domain to 1, and one whose refresh is stuck to none', () => {
      const three = { firstCap: 1, refreshCap: 1, sharedCap: 2 };
      bothSay(
        world({ ...three, count: counted(HISTORIES['quiet'], false), first: [ok()] }),
        probeFirstRule(1, 2),
        'unacked',
        '1 held',
      );
      bothSay(
        world({ ...three, first: [], refresh: [silent()] }),
        probeFirstRule(1, 2),
        'shared',
        'its refresh stuck',
      );
    });

    it('decides as P-438 does over every world of the grid, 1,368,000 of them, each once', () => {
      const worlds = sweep(0, probeFirstRule);
      assert.equal(worlds, LANE_SETS.length * PER_LANE_SET);
      assert.equal(worlds, 1_368_000);
    });
  });

  describe('LR2b: gateFirstRule', () => {
    it('is P-438’s rule: one lane rule, with no unacked of the gate’s own', () => {
      for (const [firstCap, sharedCap] of LANE_SETS) {
        assert.deepEqual(gateFirstRule(firstCap, sharedCap), probeFirstRule(firstCap, sharedCap));
      }
    });

    it('unacked: a domain not known to answer, nothing stuck, holds one fewer than all first lanes, and never none', () => {
      const holds = new Map([
        [1, 1],
        [2, 1],
        [3, 2],
        [4, 3],
        [5, 4],
        [6, 5],
      ]);
      for (const [firstCap, most] of holds) {
        const lanes = { firstCap, refreshCap: firstCap, sharedCap: firstCap + 1 };
        const count = counted(HISTORIES['quiet'], false);
        const below = world({ ...lanes, count, first: Array.from({ length: most - 1 }, ok) });
        const at = world({ ...lanes, count, first: Array.from({ length: most }, ok) });
        const rule = gateFirstRule(firstCap, firstCap + 1);
        assert.equal(laneRule(below, rule, { count: 0 }), undefined);
        assert.equal(laneRule(at, rule, { count: 0 }), 'unacked');
      }
    });

    it('caps a domain known to answer while one of its helper lookups is stuck, never asking whether it answers', () => {
      const asked: Asked = { count: 0 };
      const gate = gateFirstRule(4, 5);
      const helper = (overrides: Partial<World>): World => world({ helperStuck: 1, ...overrides });
      assert.equal(laneRule(helper({ first: [ok(), ok()] }), gate, asked), undefined);
      assert.equal(laneRule(helper({ first: [ok(), ok(), ok()] }), gate, asked), 'cappedLanes');
      assert.equal(
        laneRule(helper({ first: [ok(), ok()], refreshQueued: 2 }), gate, asked),
        'shared',
      );
      assert.equal(asked.count, 0);
      assert.equal(laneRule(world({ first: [ok(), ok(), ok()] }), gate, asked), undefined);
      assert.equal(asked.count, 1);
    });

    it('decides as P-438 does with each helper lookup stuck one more stuck, over every world of the grid', () => {
      const worlds = sweep(1, gateFirstRule);
      assert.equal(worlds, 1_368_000);
    });
  });
});

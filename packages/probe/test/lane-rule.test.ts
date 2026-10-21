import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  admitHelper,
  candidateKey,
  firstLoad,
  gateFirstRule,
  heldBy,
  HELPER_UNIT_RULE,
  HelperKeys,
  helperAnsweringOk,
  helperClassOk,
  helperKeyOk,
  helperRiskOk,
  helperSpare,
  helperUngated,
  KEY_QUIET,
  keyWords,
  mayStart,
  probeFirstRule,
  RISK_F,
  RISK_T,
  type DomainHistory,
  type HeldBy,
  type HelperAdmitAsk,
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

describe('the lookup helper’s lane rule (P-432 S3)', () => {
  it('is built to the numbers decided: a quiet key holds 3, T is 4, F is 1, a capped unit 3', () => {
    assert.equal(KEY_QUIET, 3);
    assert.equal(RISK_T, 4);
    assert.equal(RISK_F, 1);
    assert.deepEqual(HELPER_UNIT_RULE, {
      lanes: INF,
      cappedLanes: 3,
      unacked: INF,
      sharedLanes: INF,
    });
  });

  describe('LR3: candidateKey', () => {
    it('keys a name by its domain, a single label by itself, and never by nothing', () => {
      const keys: [string, string][] = [
        ['dev-4.zone-b.test', 'd:zone-b.test'],
        ['DEV-4.Zone-B.Test', 'd:zone-b.test'],
        ['dev-4.zone-b.test.', 'd:zone-b.test'],
        [' dev-4.zone-b.test ', 'd:zone-b.test'],
        ['a.b.c.d', 'd:b.c.d'],
        ['sw-b1', 'n:sw-b1'],
        ['SW-B1.', 'n:sw-b1'],
        ['localhost', 'n:localhost'],
        ['.', 'n:.'],
        ['', 'n:'],
        ['.leading.test', 'n:.leading.test'],
        ['trailing.', 'n:trailing'],
        ['x..test', 'd:.test'],
      ];
      for (const [name, key] of keys) assert.equal(candidateKey(name), key, name);
      for (const [name] of keys) {
        assert.notEqual(candidateKey(name), '', name);
        assert.notEqual(candidateKey(name), 'd:', name);
      }
    });

    it('names a key in a message by its domain or its label', () => {
      assert.equal(keyWords('d:zone-b.test'), 'zone-b.test');
      assert.equal(keyWords('n:sw-b1'), 'sw-b1');
    });
  });

  describe('LR4: what the helper knows of each key', () => {
    it('is new until it answers or sticks, quiet while stuck since its last answer', () => {
      const keys = new HelperKeys();
      const k = 'd:zone-b.test';
      assert.equal(keys.isNew(k), true);
      assert.equal(keys.quiet(k), true);
      const one = {};
      keys.started(one, k, 'first');
      assert.equal(keys.running(k), 1);
      assert.equal(keys.unitRunning(k, 'first'), 1);
      assert.equal(keys.unitRunning(k, 'refresh'), 0);
      assert.equal(keys.isNew(k), true, 'running is not evidence');
      keys.ended(one, 'answer');
      assert.equal(keys.isNew(k), false);
      assert.equal(keys.quiet(k), false, 'it answered');
      const two = {};
      keys.started(two, k, 'refresh');
      keys.stuck(two);
      assert.equal(keys.quiet(k), true, 'stuck since its last answer');
      assert.equal(keys.capped(k, 'refresh'), true, 'a stuck lookup of the class runs');
      assert.equal(keys.capped(k, 'first'), false, 'per class');
      const three = {};
      keys.started(three, k, 'first');
      keys.ended(three, 'answer');
      assert.equal(keys.quiet(k), false, 'an answer after the stuck one');
      keys.ended(two, 'giveUp');
      assert.equal(keys.capped(k, 'refresh'), true, 'gave up since the class last answered');
      assert.equal(keys.isStuck(two), false, 'ended');
      const four = {};
      keys.started(four, k, 'refresh');
      keys.ended(four, 'answer');
      assert.equal(keys.capped(k, 'refresh'), false, 'the class answered since');
      assert.deepEqual(keys.size(), { keys: 1, lookups: 0 });
    });

    it('a stuck lookup that answers makes its key answering; a neutral end says nothing (K6)', () => {
      const keys = new HelperKeys();
      const k = 'd:zone-b.test';
      const slow = {};
      keys.started(slow, k, 'first');
      keys.stuck(slow);
      assert.equal(keys.isNew(k), false, 'stuck is evidence');
      assert.equal(keys.quiet(k), true);
      keys.ended(slow, 'answer');
      assert.equal(keys.quiet(k), false);
      assert.equal(keys.capped(k, 'first'), false);
      const lost = {};
      keys.started(lost, 'd:other.test', 'first');
      keys.ended(lost, 'neutral');
      assert.equal(keys.isNew('d:other.test'), true, 'a neutral end is no evidence');
    });

    it('orders events by a counter, never the clock: stuck then answered in one instant is not quiet', () => {
      const keys = new HelperKeys();
      const k = 'n:sw-b1';
      const a = {};
      const b = {};
      keys.started(a, k, 'first');
      keys.started(b, k, 'first');
      keys.stuck(a);
      keys.ended(b, 'answer');
      assert.equal(keys.quiet(k), false);
      keys.stuck(a);
      assert.equal(keys.quiet(k), false, 'said stuck once only');
    });

    it('forgets the least recently used key with nothing running past its bound', () => {
      const keys = new HelperKeys({ maxKeys: 2 });
      const held = {};
      keys.started(held, 'd:a.test', 'first');
      for (const name of ['d:b.test', 'd:c.test', 'd:d.test']) {
        const one = {};
        keys.started(one, name, 'first');
        keys.ended(one, 'answer');
      }
      assert.equal(keys.size().keys, 2);
      assert.equal(keys.running('d:a.test'), 1, 'a key with a lookup running is kept');
      assert.equal(keys.isNew('d:b.test'), true, 'forgotten');
    });
  });

  describe('LR5: the gates', () => {
    /** A lookup asking to start: a never-seen key, nothing running, every token free. */
    const asking = (overrides: Partial<HelperAdmitAsk> = {}): HelperAdmitAsk => ({
      urgent: false,
      overflow: false,
      stuckAnywhere: false,
      keyNew: true,
      keyQuiet: true,
      keyRunning: 0,
      vouched: false,
      nameAnswering: false,
      keyAnsweringQueued: false,
      keyFailingRunning: 0,
      unitRunning: 0,
      unitCapped: false,
      atRisk: 0,
      classOk: true,
      classSpare: true,
      keepLast: false,
      urgentAvailable: 2,
      sharedAvailable: 5,
      keptAvailable: 1,
      ...overrides,
    });

    it('keyOk: a key the walk does not vouch for runs at most 3, quiet or not; a vouched one by its unit (P-478)', () => {
      for (let running = 0; running <= 5; running += 1) {
        assert.equal(
          helperKeyOk(asking({ keyRunning: running, unitRunning: running })),
          running < 3,
          'quiet',
        );
        // T1: one answer from a name its recursor still caches lifts the key's quiet, and its unit
        // is not capped until a lookup of it is said stuck: still 3.
        const answering = asking({ keyNew: false, keyQuiet: false, keyRunning: running });
        assert.equal(
          helperKeyOk({ ...answering, unitRunning: running }),
          running < 3,
          'answering in the helper, not vouched',
        );
        assert.equal(
          helperKeyOk({ ...answering, unitRunning: running, unitCapped: true }),
          running < 3,
          'a capped unit',
        );
        const vouched = { ...answering, vouched: true };
        assert.equal(helperKeyOk({ ...vouched, unitRunning: running }), true, 'vouched: no limit');
        assert.equal(
          helperKeyOk({ ...vouched, unitRunning: running, unitCapped: true }),
          running < 3,
          'vouched, its unit capped: 3',
        );
        assert.equal(
          helperKeyOk(asking({ keyRunning: running, unitRunning: running, vouched: true })),
          true,
          'vouched though quiet: judged by its unit',
        );
      }
      // The edge, as T1 states it.
      const t1 = asking({ keyNew: false, keyQuiet: false, keyRunning: 3, unitRunning: 3 });
      assert.equal(helperKeyOk(t1), false);
      assert.equal(helperKeyOk({ ...t1, vouched: true }), true);
      assert.equal(helperKeyOk({ ...t1, keyRunning: 2, unitRunning: 2 }), true);
    });

    it('keyOk keeps the last of a key’s 3 for its names that answer: while one is queued, those failing or never answered hold at most 2 (P-478 fix round 1)', () => {
      // Two of the key's 3 run for names that do not answer, and one that answers waits.
      const held = asking({
        keyNew: false,
        keyQuiet: false,
        keyRunning: 2,
        unitRunning: 2,
        keyFailingRunning: 2,
        keyAnsweringQueued: true,
      });
      assert.equal(helperAnsweringOk(held), false);
      assert.equal(helperKeyOk(held), false, 'a name failing, or never answered: the last is kept');
      assert.equal(admitHelper(held), undefined);
      assert.equal(
        admitHelper({ ...held, nameAnswering: true }),
        'shared',
        'the name that answers',
      );
      assert.equal(
        helperKeyOk({ ...held, nameAnswering: true, keyRunning: 3, unitRunning: 3 }),
        false,
        'the cap stays 3 for it too',
      );
      assert.equal(helperKeyOk({ ...held, keyAnsweringQueued: false }), true, 'none waits: 3');
      assert.equal(
        helperKeyOk({ ...held, keyFailingRunning: 1 }),
        true,
        'one of the two answers: a second that does not is its key’s 2nd',
      );
      assert.equal(helperKeyOk({ ...held, keyQuiet: true }), false, 'quiet or not');
      assert.equal(helperKeyOk({ ...held, keyFailingRunning: 3, keyRunning: 3 }), false);
      // Vouched (D23): not held to 3, so nothing is kept of 3.
      assert.equal(helperKeyOk({ ...held, vouched: true }), true, 'vouched: its unit alone');
      assert.equal(
        admitHelper({ ...held, urgent: true, urgentAvailable: 1 }),
        'urgent',
        '"Check now" on an urgent token, under no key rule',
      );
      assert.equal(
        admitHelper({ ...held, urgent: true, urgentAvailable: 0 }),
        undefined,
        '"Check now" with no urgent token is under the key rule',
      );
      for (let failing = 0; failing <= 3; failing += 1) {
        for (const answering of [false, true]) {
          for (const queued of [false, true]) {
            const a = { ...held, keyFailingRunning: failing, nameAnswering: answering };
            assert.equal(
              helperAnsweringOk({ ...a, keyAnsweringQueued: queued }),
              answering || !queued || failing < 2,
              `failing ${String(failing)}, answering ${String(answering)}, queued ${String(queued)}`,
            );
          }
        }
      }
    });

    it('classOk: with the check on, a lookup the gate holds never takes the last first or shared lane; one it does not hold may (P-478)', () => {
      const gated = asking({ keepLast: true, classSpare: false });
      assert.equal(helperUngated(gated), false);
      assert.equal(helperClassOk(gated), false, 'gated: the last lane is kept');
      assert.equal(admitHelper(gated), undefined);
      assert.equal(admitHelper({ ...gated, classSpare: true }), 'shared', 'a lane to spare');
      assert.equal(admitHelper({ ...gated, keepLast: false }), 'shared', 'the check off');
      const vouched = { ...gated, vouched: true };
      assert.equal(admitHelper(vouched), 'shared', 'vouched: the last lane is its');
      const answering = { ...gated, keyNew: false, keyQuiet: false };
      assert.equal(admitHelper(answering), 'shared', 'answering in the helper, its unit free');
      assert.equal(
        admitHelper({ ...answering, unitCapped: true }),
        undefined,
        'a capped unit is gated',
      );
      assert.equal(
        admitHelper({ ...gated, keyRunning: 0, keyNew: true }),
        undefined,
        'a never-seen key’s first look does not take it with the check on',
      );
      assert.equal(admitHelper({ ...gated, classOk: false, keepLast: false }), undefined);
      assert.equal(
        admitHelper({ ...vouched, classOk: false }),
        undefined,
        'its class’s cap holds the ungated',
      );
      assert.equal(
        admitHelper({ ...gated, urgent: true, urgentAvailable: 0 }),
        'shared',
        '"Check now" takes no lane of a class',
      );
      assert.equal(
        admitHelper({ ...gated, overflow: true, keyNew: false, keyQuiet: false }),
        undefined,
        'overflow is gated',
      );
    });

    it('riskOk: a gated start waits at T, a never-seen key’s first look at T + F, an ungated one never', () => {
      for (let atRisk = 0; atRisk <= 7; atRisk += 1) {
        assert.equal(helperRiskOk(asking({ atRisk })), atRisk < 5, 'first look');
        assert.equal(helperRiskOk(asking({ atRisk, keyRunning: 1 })), atRisk < 4, 'second');
        assert.equal(helperRiskOk(asking({ atRisk, keyNew: false })), atRisk < 4, 'quiet');
        assert.equal(
          helperRiskOk(asking({ atRisk, keyNew: false, keyQuiet: false })),
          true,
          'ungated: its key answers',
        );
        assert.equal(helperRiskOk(asking({ atRisk, vouched: true })), true, 'ungated: vouched');
        assert.equal(
          helperRiskOk(asking({ atRisk, keyNew: false, keyQuiet: false, unitCapped: true })),
          atRisk < 4,
          'a capped unit is gated',
        );
      }
    });

    it('an ungated (vouched) lookup passes T and takes the kept token when no shared one is free', () => {
      const vouched = asking({ vouched: true, atRisk: 6, sharedAvailable: 0 });
      assert.equal(helperUngated(vouched), true);
      assert.equal(admitHelper(vouched), 'kept');
      assert.equal(admitHelper({ ...vouched, sharedAvailable: 1 }), 'shared', 'shared first');
      assert.equal(admitHelper({ ...vouched, keptAvailable: 0 }), undefined);
    });

    it('never gives the kept token to a gated lookup, an overflow or "Check now"', () => {
      assert.equal(admitHelper(asking({ sharedAvailable: 0 })), undefined, 'gated');
      assert.equal(
        admitHelper(asking({ overflow: true, keyNew: false, keyQuiet: false, sharedAvailable: 0 })),
        undefined,
        'overflow',
      );
      assert.equal(
        admitHelper(
          asking({ urgent: true, urgentAvailable: 0, sharedAvailable: 0, keyQuiet: false }),
        ),
        undefined,
        '"Check now"',
      );
    });

    it('overflow is T-gated, never ungated, and refused once its key is stuck anywhere', () => {
      const overflow = asking({ overflow: true, keyNew: false, keyQuiet: false });
      assert.equal(helperUngated(overflow), false);
      assert.equal(admitHelper(overflow), 'shared');
      assert.equal(admitHelper({ ...overflow, atRisk: 3 }), 'shared');
      assert.equal(admitHelper({ ...overflow, atRisk: 4 }), undefined, 'at T');
      assert.equal(
        admitHelper({ ...overflow, keyNew: true, keyRunning: 0, atRisk: 4 }),
        undefined,
        'no T + F for overflow',
      );
      assert.equal(admitHelper({ ...overflow, stuckAnywhere: true }), undefined);
    });

    it('"Check now" takes an urgent token past every rule, else a shared one under the key rule and T, not its class', () => {
      const urgent = asking({ urgent: true, keyRunning: 3, unitRunning: 3, atRisk: 9 });
      assert.equal(admitHelper({ ...urgent, classOk: false }), 'urgent');
      const noUrgent = { ...urgent, urgentAvailable: 0 };
      assert.equal(admitHelper(noUrgent), undefined, 'a silent key at 3');
      const first = asking({ urgent: true, urgentAvailable: 0, classOk: false });
      assert.equal(admitHelper(first), 'shared', 'as its key’s first look, class caps aside');
      assert.equal(admitHelper({ ...first, atRisk: 5 }), undefined, 'T + F applies');
    });

    it('a lookup its class may not run waits, whatever its tokens', () => {
      assert.equal(admitHelper(asking({ classOk: false })), undefined);
      assert.equal(
        admitHelper(asking({ classOk: false, keyQuiet: false, keyNew: false })),
        undefined,
      );
    });

    it('spare: one more leaves the last free first lane and the last free shared lane, at P-426’s 6 lanes; the retry lane keeps nothing (P-478)', () => {
      const caps = { firstCap: 4, refreshCap: 4, sharedCap: 5 };
      for (let first = 0; first <= 4; first += 1) {
        for (let refresh = 0; refresh <= 4; refresh += 1) {
          if (first + refresh > 5) continue;
          const lanes = { ...caps, first, refresh };
          assert.equal(
            helperSpare(lanes, 'first'),
            first < 3 && first + refresh < 4,
            `first with ${String(first)} first and ${String(refresh)} refreshes`,
          );
          assert.equal(
            helperSpare(lanes, 'refresh'),
            refresh < 4 && first + refresh < 4,
            `refresh with ${String(first)} first and ${String(refresh)} refreshes`,
          );
          assert.equal(helperSpare(lanes, 'retry'), true);
        }
      }
      // From the lane set, not worked out from P-426's 6.
      assert.equal(
        helperSpare({ firstCap: 6, refreshCap: 6, sharedCap: 7, first: 4, refresh: 0 }, 'first'),
        true,
      );
      assert.equal(
        helperSpare({ firstCap: 6, refreshCap: 6, sharedCap: 7, first: 5, refresh: 0 }, 'first'),
        false,
      );
      assert.equal(
        helperSpare({ firstCap: 6, refreshCap: 6, sharedCap: 7, first: 2, refresh: 4 }, 'refresh'),
        false,
      );
    });

    it('every start it admits satisfies keyOk, riskOk, its class and a token of the kind named', () => {
      let seen = 0;
      for (const urgent of [false, true])
        for (const overflow of [false, true])
          for (const keyNew of [false, true])
            for (const keyQuiet of [false, true])
              for (const vouched of [false, true])
                for (const unitCapped of [false, true])
                  for (const classOk of [false, true])
                    for (const [classSpare, keepLast] of [
                      [true, false],
                      [false, false],
                      [true, true],
                      [false, true],
                    ] as const)
                      for (const [nameAnswering, keyAnsweringQueued, keyFailingRunning] of [
                        [false, false, 2],
                        [false, true, 1],
                        [false, true, 2],
                        [true, true, 2],
                      ] as const)
                        for (const keyRunning of [0, 1, 2, 3])
                          for (const atRisk of [0, 3, 4, 5])
                            for (const urgentAvailable of [0, 1])
                              for (const sharedAvailable of [0, 1])
                                for (const keptAvailable of [0, 1]) {
                                  const a = asking({
                                    urgent,
                                    overflow,
                                    keyNew,
                                    keyQuiet,
                                    vouched,
                                    unitCapped,
                                    classOk,
                                    classSpare,
                                    keepLast,
                                    nameAnswering,
                                    keyAnsweringQueued,
                                    keyFailingRunning,
                                    keyRunning,
                                    unitRunning: keyRunning,
                                    atRisk,
                                    urgentAvailable,
                                    sharedAvailable,
                                    keptAvailable,
                                  });
                                  const token = admitHelper(a);
                                  seen += 1;
                                  if (token === undefined) continue;
                                  if (token === 'urgent') {
                                    assert.ok(urgent && urgentAvailable > 0);
                                    continue;
                                  }
                                  assert.ok(helperKeyOk(a) && helperRiskOk(a));
                                  // P-478's fix round 1: the last of a key's 3 is its answering names'.
                                  assert.ok(
                                    overflow ||
                                      vouched ||
                                      nameAnswering ||
                                      keyFailingRunning < 2 ||
                                      !keyAnsweringQueued,
                                  );
                                  assert.ok(urgent || classOk);
                                  assert.ok(urgent || !keepLast || classSpare || helperUngated(a));
                                  if (token === 'shared') assert.ok(sharedAvailable > 0);
                                  if (token === 'kept') {
                                    assert.ok(keptAvailable > 0 && sharedAvailable === 0);
                                    assert.ok(helperUngated(a) && !urgent && !overflow);
                                  }
                                }
      assert.equal(seen, 2 ** 7 * 4 * 4 * 4 * 4 * 2 ** 3);
    });

    it('the unit’s rule is mayStart’s with no shared lane and no unacked', () => {
      for (let running = 0; running <= 5; running += 1) {
        for (const capped of [false, true]) {
          const load: KeyLoad = { running, unacked: 0, capped, sharedTaken: 0 };
          assert.equal(mayStart(load, HELPER_UNIT_RULE), !capped || running < 3);
          assert.equal(
            heldBy(load, HELPER_UNIT_RULE),
            capped && running >= 3 ? 'cappedLanes' : undefined,
          );
        }
      }
    });
  });

  describe('LR6: detachAll and detach', () => {
    it('lets go of every key, and lookups running then count against none and say nothing', () => {
      const keys = new HelperKeys();
      const k = 'd:zone-b.test';
      const stuck = {};
      const other = {};
      keys.started(stuck, k, 'first');
      keys.started(other, k, 'refresh');
      keys.stuck(stuck);
      assert.equal(keys.quiet(k), true);
      keys.detachAll();
      assert.equal(keys.isNew(k), true, 'forgotten');
      assert.equal(keys.running(k), 0);
      keys.ended(stuck, 'giveUp');
      keys.ended(other, 'answer');
      assert.equal(keys.isNew(k), true, 'their ends say nothing of the key now');
      assert.equal(keys.capped(k, 'first'), false);
      assert.deepEqual(keys.size(), { keys: 0, lookups: 0 });
      const later = {};
      keys.started(later, k, 'first');
      assert.equal(keys.running(k), 1, 'a new lookup counts from nothing');
    });

    it('detaches one lookup when the helper goes quiet: off its key, its stuck with it', () => {
      const keys = new HelperKeys();
      const k = 'd:zone-b.test';
      const quiet = {};
      const kept = {};
      keys.started(quiet, k, 'first');
      keys.started(kept, k, 'first');
      keys.stuck(quiet);
      assert.equal(keys.capped(k, 'first'), true);
      keys.detach(quiet);
      assert.equal(keys.running(k), 1);
      assert.equal(keys.unitRunning(k, 'first'), 1);
      assert.equal(keys.capped(k, 'first'), false, 'its stuck no longer caps the unit');
      assert.equal(keys.quiet(k), true, 'what it said before stands');
      keys.ended(quiet, 'answer');
      assert.equal(keys.quiet(k), true, 'its answer says nothing');
      keys.ended(kept, 'answer');
      assert.equal(keys.quiet(k), false);
    });
  });
});

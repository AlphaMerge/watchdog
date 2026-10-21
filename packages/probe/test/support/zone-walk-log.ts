import { HEARD_A_ZONE, WALKING_AGAIN, ZONE_VERDICT } from '../../src/resolver/dns-check.js';
import { OWN_WALK_DEFERRED } from '../../src/resolver/name-resolver.js';
import type { WalkAgainSeen, WorldFacts, ZoneVerdict, ZoneWalks } from './name-gate-judge.js';

/**
 * What the arms read of a key's own walks from the gate's debug log (`P-484`, `P-485`): when the
 * check heard each key from unknown or silent (`HEARD_A_ZONE`), each walk again as it was sent
 * (`WALKING_AGAIN`), each scout's and walk again's verdict (`ZONE_VERDICT`), and each queued helper
 * lookup's own walk deferred, by name and why (`OWN_WALK_DEFERRED`). Times are the lines' own, on
 * the resolver's clock, which in the arms is `performance.now`, the arm's; `zone` turns them into
 * ms from the arm's start. Pure, so that a unit test reaches what a full-size arm alone would run.
 */
/** A name as the arm's names are: lower case, no trailing dot. */
const asNamed = (name: string): string => name.toLowerCase().replace(/\.$/u, '');

export class ZoneWalkLog {
  readonly #heard = new Map<string, number[]>();
  readonly #again = new Map<string, Sent[]>();
  readonly #verdicts = new Map<string, Said[]>();
  readonly #deferred = new Map<string, { readonly why: string; readonly at: number }[]>();

  /** Reads one line of the log: true if it was one of these, so that the caller need not. */
  read(line: string): boolean {
    if (line.includes(`"msg":"${HEARD_A_ZONE}"`)) {
      const said = parsed(line);
      push(this.#heard, String(said['key']), Number(said['at']));
      return true;
    }
    if (line.includes(`"msg":"${WALKING_AGAIN}"`)) {
      const said = parsed(line);
      push(this.#again, String(said['key']), {
        carrier: String(said['name']),
        own: said['own'] === true,
        step: Number(said['step']),
        dueAt: Number(said['dueAt']),
        notHeardAt: typeof said['notHeardAt'] === 'number' ? said['notHeardAt'] : undefined,
        sentAt: Number(said['sentAt']),
      });
      return true;
    }
    if (line.includes(`"msg":"${ZONE_VERDICT}"`)) {
      const said = parsed(line);
      const verdict = said['verdict'];
      push(this.#verdicts, String(said['key']), {
        by: said['by'] === 'scout' ? 'scout' : 'walkAgain',
        name: String(said['name']),
        sentAt: Number(said['sentAt']),
        at: Number(said['at']),
        verdict: verdict === 'heard' || verdict === 'notHeard' ? verdict : 'none',
        dueAt: typeof said['dueAt'] === 'number' ? said['dueAt'] : undefined,
      });
      return true;
    }
    if (line.includes(`"msg":"${OWN_WALK_DEFERRED}"`)) {
      const said = parsed(line);
      push(this.#deferred, asNamed(String(said['host'])), {
        why: String(said['why']),
        at: Number(said['at']),
      });
      return true;
    }
    return false;
  }

  /** When the check first heard a key, heard or mixed, on the resolver's clock; undefined if never. */
  firstHeard(key: string): number | undefined {
    return this.#heard.get(key)?.[0];
  }

  /**
   * A key's own walks, in ms from the arm's start (`startedAt`, on the same clock): when it was
   * first heard, every time it was heard from unknown or silent, its scouts' and walks again's
   * verdicts, and its walks again, each joined to its verdict by when it was sent.
   */
  zone(key: string, startedAt: number): { readonly keyHeardMs: number | undefined } & ZoneWalks {
    const first = this.firstHeard(key);
    const verdicts: ZoneVerdict[] = (this.#verdicts.get(key) ?? []).map((said) => ({
      by: said.by,
      name: said.name,
      sentMs: said.sentAt - startedAt,
      atMs: said.at - startedAt,
      verdict: said.verdict,
      dueMs: said.dueAt === undefined ? undefined : said.dueAt - startedAt,
    }));
    const byWalk = new Map<number, Said>();
    for (const said of this.#verdicts.get(key) ?? []) {
      if (said.by === 'walkAgain') byWalk.set(said.sentAt, said);
    }
    const walksAgain: WalkAgainSeen[] = (this.#again.get(key) ?? []).map((sent) => {
      const verdict = byWalk.get(sent.sentAt);
      return {
        carrier: sent.carrier,
        own: sent.own,
        step: sent.step,
        dueMs: sent.dueAt - startedAt,
        notHeardMs: sent.notHeardAt === undefined ? undefined : sent.notHeardAt - startedAt,
        sentMs: sent.sentAt - startedAt,
        verdict: verdict?.verdict,
        atMs: verdict === undefined ? undefined : verdict.at - startedAt,
      };
    });
    return {
      keyHeardMs: first === undefined ? undefined : first - startedAt,
      heardMs: (this.#heard.get(key) ?? []).map((at) => at - startedAt),
      verdicts,
      walksAgain,
    };
  }

  /**
   * When a name's own walks were deferred for `why` (`rate` is D19's refusal), in ms from the arm's
   * start.
   */
  deferredMs(host: string, why: string, startedAt: number): number[] {
    return (this.#deferred.get(asNamed(host)) ?? [])
      .filter((one) => one.why === why)
      .map((one) => one.at - startedAt);
  }
}

/** A walk again as its line said it, on the resolver's clock. */
interface Sent {
  readonly carrier: string;
  readonly own: boolean;
  readonly step: number;
  readonly dueAt: number;
  readonly notHeardAt: number | undefined;
  readonly sentAt: number;
}

/** A verdict as its line said it, on the resolver's clock. */
interface Said {
  readonly by: 'scout' | 'walkAgain';
  readonly name: string;
  readonly sentAt: number;
  readonly at: number;
  readonly verdict: 'heard' | 'notHeard' | 'none';
  readonly dueAt: number | undefined;
}

function parsed(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function push<T>(into: Map<string, T[]>, key: string, value: T): void {
  const list = into.get(key) ?? [];
  list.push(value);
  into.set(key, list);
}

/** What `partial`'s cached facts are read from, as the arm holds it at its end (`P-485`). */
export interface PartialRead {
  /** The arm's start, on the arm's clock, which every time here is on. */
  readonly startedAt: number;
  readonly intervalMs: number;
  /** The event loop's longest turn, in ms; undefined if it was not measured. */
  readonly lagMs: number | undefined;
  /** The silent zone's names, by what they do: cached, or silent. */
  readonly cached: readonly string[];
  readonly silent: readonly string[];
  /** The silent zone's key, as the check keys its names. */
  readonly key: string;
  /** When each of a name's checks was asked. */
  readonly asksOf: (name: string) => readonly number[];
  /** When each of a name's lookups answered. */
  readonly answersOf: (name: string) => readonly number[];
  /** Each cached check given up: its name, when it was asked, and its words. */
  readonly givenUp: readonly {
    readonly name: string;
    readonly at: number;
    readonly message: string;
  }[];
  /** Each of the walk's questions: the name asked, and when it was sent. */
  readonly questions: readonly { readonly name: string; readonly at: number }[];
  /** The gate's debug lines, read. */
  readonly log: ZoneWalkLog;
  /** How long a silent lookup holds its lane: the world's resolv.conf. */
  readonly silentHoldMs: number;
}

/**
 * `partial`'s cached facts (`P-478`, `P-480`, `P-484`, `P-485`), in ms from the arm's start, from
 * what the arm read: the cached names' first answers, their checks given up, their first asks and
 * every check, the silent names asked, the silent hold, the time the check first heard the zone,
 * each cached name's own walks D19 refused, the walk's questions for each of the zone's names, and
 * the zone's scouts and walks again. Pure: the judge block holds it to a log it writes.
 */
export function partialFacts(read: PartialRead): NonNullable<WorldFacts['cachedGivenUp']> {
  const { startedAt } = read;
  const fromStart = (times: readonly number[]): number[] =>
    [...times].sort((a, b) => a - b).map((at) => at - startedAt);
  const zone = read.log.zone(read.key, startedAt);
  const zoneNames = new Set([...read.cached, ...read.silent]);
  const questions: Record<string, number[]> = {};
  for (const { name, at } of read.questions) {
    const named = asNamed(name);
    if (!zoneNames.has(named)) continue;
    (questions[named] ??= []).push(at - startedAt);
  }
  const answered = read.cached.flatMap((name) => {
    const first = fromStart(read.answersOf(name))[0];
    return first === undefined ? [] : [[name, first] as const];
  });
  const asked = read.cached.flatMap((name) => {
    const first = fromStart(read.asksOf(name))[0];
    return first === undefined ? [] : [[name, first] as const];
  });
  return {
    intervalMs: read.intervalMs,
    lagMs: read.lagMs,
    firstAnswerMs: Object.fromEntries(answered),
    checks: read.givenUp.map(({ name, at, message }) => ({
      name,
      askedMs: at - startedAt,
      message,
    })),
    firstAskedMs: Object.fromEntries(asked),
    // Each arm starts its probe cold: every silent name it asks is one never yet tried.
    silentUntried: read.silent.filter((name) => read.asksOf(name).length > 0).length,
    silentHoldMs: read.silentHoldMs,
    ...(zone.keyHeardMs === undefined ? {} : { keyHeardMs: zone.keyHeardMs }),
    checksAtMs: Object.fromEntries(
      read.cached.map((name) => [name, fromStart(read.asksOf(name))] as const),
    ),
    ownRefusedMs: Object.fromEntries(
      read.cached.map((name) => [name, read.log.deferredMs(name, 'rate', startedAt)] as const),
    ),
    zoneQuestionsMs: questions,
    zoneWalks: { heardMs: zone.heardMs, verdicts: zone.verdicts, walksAgain: zone.walksAgain },
  };
}

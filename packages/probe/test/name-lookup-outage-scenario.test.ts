import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { probeHealth, type ResolvedAddress } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { AnswerFile, answerFilePath } from '../src/resolver/answer-file.js';
import { buildNameResolution, type NameResolution } from '../src/resolver/name-resolution.js';
import {
  ANSWER_MS,
  NameResolver,
  RESOLVER_LANES,
  STALE_MS,
  type NameResolverOptions,
} from '../src/resolver/name-resolver.js';
import { CheckPool } from '../src/runner/index.js';
import { pollWithin, within } from './support/within.js';
import {
  ScenarioTimers,
  zoneFork,
  type ZoneAnswer,
  type ZoneChild,
} from './support/zone-helper.js';

/**
 * One zone of ten stops answering, on a probe whose resolver has every name kept (`P-426`, the
 * `M-17` kind): what the sensors' states do, which is what an operator is paged on.
 *
 * **One outage, one alarm.** The answering zone's sensors must not change state at all: not while
 * the silent zone's lookups hold lanes, not when its kept answers run out, and not when the probe
 * restarts in the middle of it with nothing kept. The silent zone's sensors stay Up on the answers
 * kept for them for five minutes past their expiry (the user's decision of 2026-10-17), then go
 * Down once, failing at once each scan, naming the resolver, rather than each waiting out its
 * bound, and stay Down across the restart. Only the first scan after the restart waits: its checks
 * are each waiting for a lookup of their own, and a check already waiting keeps its bound.
 *
 * Real workers, the real catalogue and guard (`support/lookup-registry.ts`) and the real
 * `NameResolver`, whose `getaddrinfo` is the test's: zone A answers at once, and zone B answers
 * until it goes silent, after which its lookups never end, as a resolver timing out on every
 * server does for longer than any scan. The resolver's clock is moved a scan interval at a time;
 * its bound for stuck is a real 50 ms. A sensor's state follows `docs/state-machine.md §2.1` at its
 * default: Up after a scan that answered, Warning after one failure, Down after two.
 *
 * Two names are silent, fewer than the resolver's four first-lookup lanes, so a cold restart
 * leaves the answering zone lanes to be asked on.
 *
 * **And a cold start with more silent names than the lanes** (`P-438`), asked at once, before any
 * of their lookups is stuck, as a tick of the wheel asks a hundred names in `test:perf`'s cold zone
 * arm: a domain none of whose names has answered holds at most 3 of the 4 first-lookup lanes, and
 * the answering zone is asked on the fourth from its first scan. `getaddrinfo` cannot be
 * cancelled, so without that the silent names took all four until their lookups ended. Its bound
 * for stuck is a second, far longer than the scan takes to hand out, so that what holds the silent
 * zone to 3 is that none of its names has answered, whatever the host's speed.
 *
 * **And a hosts edit in the middle of it** (`P-426`'s review), on a probe with more silent names
 * than those four lanes: the operator gives one silent device its address in the hosts file, and
 * later resolv.conf is rewritten. Neither may change anything for the answering zone.
 *
 * **And a warm zone going silent** (`P-426`'s second review): its names' first refreshes may not
 * take every lane a first lookup could use, so a sensor of the answering zone whose kept answer ran
 * out between its scans is still asked, and answered. Both these cases run silent lookups longer
 * than the time between scans, on a pool of more workers than the first lookups' lanes, so that
 * zone A's checks are asked while silent lookups hold lanes.
 *
 * **And a restart in the middle of it, from the answer file** (`P-438`), with two silent zones of
 * ten names each: the probe that stops writes the answers it keeps, and the one that starts loads
 * them before its first scan, so the answering zone is answered from that scan. Two silent domains
 * held to 3 each take the 4 first-lookup lanes between them, which the cap does not prevent: the
 * same restart with no file fails the answering zone's checks behind them.
 *
 * **And the same outages in gate mode** (`P-432` S3, its §7.4's SC1b, SC7, SC8, SC8b, SC10–SC12
 * and SC17), at the end: the lookup helper carries every name not in the hosts file, so a cold
 * probe no longer fails the answering zone's first scans, and the helper's own faults raise one
 * Warning and change no sensor's state. Its probes are built as `main.ts` builds them.
 */

const silent = pino({ level: 'silent' });
const LOOKUPS = join(import.meta.dirname, 'support', 'lookup-registry.js');

const DEVICES = 20;
const SENSORS_PER_DEVICE = 2;
const INTERVAL_MS = 60_000;
/** SNMP's own timeout, of which the lookup has half. */
const SNMP_TIMEOUT_MS = 4_000;
const BOUND_MS = SNMP_TIMEOUT_MS / 2;

/** Zone B is one device in ten; with two silent zones, zone C is another. */
const zoneOf = (device: number, silentZones = 1): 'a' | 'b' | 'c' =>
  device % 10 === 0 ? 'b' : silentZones === 2 && device % 10 === 5 ? 'c' : 'a';
const hostOf = (device: number, silentZones = 1): string =>
  `dev-${String(device)}.zone-${zoneOf(device, silentZones)}.test`;
const deviceOf = (sensorId: number): number => Math.floor((sensorId - 1) / SENSORS_PER_DEVICE);

type State = 'up' | 'warning' | 'down';

interface Change {
  readonly sensorId: number;
  readonly at: number;
  readonly from: State;
  readonly to: State;
}

const pools: CheckPool[] = [];
after(async () => {
  await within(60_000, 'every pool to stop', Promise.all(pools.map((pool) => pool.stop())));
});

/** What one zone's lookups did, as the test's `getaddrinfo` saw them. */
interface Lookups {
  asked: number;
  answered: number;
  /** Ended with `EAI_AGAIN`. */
  failed: number;
  /** Asked and not ended: each holds one of the resolver's lanes. */
  inFlight: number;
  /** The most in flight at once. */
  peak: number;
}

/**
 * The probe: a resolver over the zones, and a pool whose workers ask it. Every wait on its
 * workers or its files is bounded, and says what it waited for and the resolver's state then:
 * `state()`, which a failed check's result also carries, as `stateAt`, from when it arrived.
 */
/** The zones a probe asks, as DNS answers them: which names are silent, and which crash a helper. */
interface Zones {
  bSilent: boolean;
  /** Zone C silent too. */
  readonly cSilent?: boolean;
  /** Which names are silent, in place of the zones': a partial outage, or single labels. */
  silentName?: (host: string) => boolean;
  /** How long a silent lookup runs before `EAI_AGAIN`; never, unless set. */
  readonly hangMs?: number;
  /** What the test's hosts file gives, which `getaddrinfo` reads ahead of DNS. */
  readonly hosts?: Map<string, string>;
  /** Names that crash the lookup helper's child when it asks them (`P-432` D27). */
  readonly crash?: ReadonlySet<string>;
}

/** A name's zone: `dev-1.zone-a.test`'s `a`, or the single label `sw-b3`'s `b`. */
const zoneLetterOf = (host: string): string =>
  /\.zone-([a-z])\.test$/u.exec(host)?.[1] ?? /^sw-([a-z])\d/u.exec(host)?.[1] ?? '?';

const isSilent = (zones: Zones, host: string): boolean =>
  zones.silentName !== undefined
    ? zones.silentName(host)
    : (zones.bSilent && host.endsWith('.zone-b.test')) ||
      (zones.cSilent === true && host.endsWith('.zone-c.test'));

const addressOf = (host: string): readonly ResolvedAddress[] => {
  const device = Number(/(\d+)(?:\.|$)/u.exec(host)?.[1] ?? '0');
  return [{ address: `192.0.2.${String((device % 250) + 1)}`, family: 4 }];
};

/** What a lookup helper adds to a probe: its parts, its children, and the scenario's hand on them. */
interface GateRun {
  readonly names: NameResolution;
  readonly children: readonly ZoneChild[];
  readonly timers: ScenarioTimers;
  /** The helper's lookups by zone, as its children saw them, with the most each ran at once. */
  readonly helperLookups: Map<string, Lookups>;
  /** The latch's value at every look the scenario took, with the clock then. */
  readonly trouble: { readonly at: number; readonly value: 0 | 1 }[];
  /** The child killed from outside, then the helper settled: up again, or resting. */
  kill(): Promise<void>;
  /** The clock moved: long timers due fired, a beat and a tick, and the helper settled. */
  onClock(): Promise<void>;
  /** The latch read, and kept in `trouble`. */
  look(): 0 | 1;
}

async function probe(
  zones: Zones,
  clock: { now: number },
  watch: readonly string[] = [],
  size = 2,
  stuckMs = 50,
  mode: 'system' | 'gate' = 'system',
) {
  const lookups = new Map<string, Lookups>();
  /** One more lookup asked, counted by its zone, or as the hosts file's. */
  const asked = (key: string): Lookups => {
    const seen = lookups.get(key) ?? { asked: 0, answered: 0, failed: 0, inFlight: 0, peak: 0 };
    lookups.set(key, seen);
    seen.asked += 1;
    return seen;
  };
  /** In gate mode, each name asked on the probe's own lanes, when, and the helper's route then. */
  const probeAsked: string[] = [];
  /** `getaddrinfo` on the probe's own lanes. */
  const lookup = (host: string): Promise<readonly ResolvedAddress[]> => {
    const helper = gate?.names.gate?.helper;
    if (helper !== undefined) {
      probeAsked.push(
        `${host} at ${String(clock.now)} ms, the helper ${helper.state}, route ${helper.routeState()}`,
      );
    }
    const listed = zones.hosts?.get(host);
    if (listed !== undefined) {
      asked('the hosts file').answered += 1;
      return Promise.resolve([{ address: listed, family: 4 }]);
    }
    const seen = asked(`zone ${zoneLetterOf(host)}`);
    if (isSilent(zones, host)) {
      const hangMs = zones.hangMs;
      seen.inFlight += 1;
      seen.peak = Math.max(seen.peak, seen.inFlight);
      return new Promise<readonly ResolvedAddress[]>((_resolve, reject) => {
        if (hangMs === undefined) return;
        setTimeout(() => {
          seen.inFlight -= 1;
          seen.failed += 1;
          reject(Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' }));
        }, hangMs);
      });
    }
    seen.answered += 1;
    return Promise.resolve(addressOf(host));
  };
  const resolverOptions = {
    logger: silent,
    now: () => clock.now,
    stuckMs,
    random: () => 0.5,
    lookup,
  };
  let gate: GateRun | undefined;
  let resolver: NameResolver;
  let gateDir: string | undefined;
  if (mode === 'system') {
    resolver = new NameResolver({ ...resolverOptions, watch: { files: watch, everyMs: 60_000 } });
  } else {
    gate = await gateRun(zones, clock, watch, stuckMs, resolverOptions, (dir) => {
      gateDir = dir;
    });
    resolver = gate.names.resolver;
  }
  const results: CheckResult[] = [];
  /** A failed check's result, and the state when it arrived. */
  const stateAt = new WeakMap<CheckResult, string>();
  const pool: CheckPool = new CheckPool({
    logger: silent,
    size,
    minSize: size,
    registryModule: LOOKUPS,
    resolver,
    onResult: (result) => {
      results.push(result);
      if (result.outcome !== 'ok') stateAt.set(result, state());
    },
  });
  /** The resolver's lanes and the lookups on them by zone, and the pool's workers, now. */
  const state = (): string => {
    const { running, queued, entries } = resolver.stats();
    const zonesSaid = [...lookups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, seen]) =>
          `${key}: ${String(seen.asked)} asked, ${String(seen.answered)} answered, ` +
          `${String(seen.failed)} EAI_AGAIN, ${String(seen.inFlight)} in flight, at most ` +
          String(seen.peak),
      )
      .join('; ');
    const p = pool.stats();
    const helperSaid =
      gate === undefined
        ? ''
        : `; the helper ${gate.names.gate?.helper.state ?? '?'}, route ` +
          `${gate.names.gate?.helper.routeState() ?? '?'}, trouble ` +
          `${String(gate.names.gate?.latch.value())}, ${String(gate.children.length)} children; its ` +
          `lookups ${
            [...gate.helperLookups]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(
                ([key, seen]) =>
                  `${key}: ${String(seen.asked)} asked, ${String(seen.answered)} answered, ` +
                  `${String(seen.failed)} EAI_AGAIN, ${String(seen.inFlight)} in flight, at most ` +
                  String(seen.peak),
              )
              .join('; ') || 'none'
          }`;
    return (
      `at ${String(clock.now)} ms on the resolver’s clock: ${String(running)} of ` +
      `${String(RESOLVER_LANES)} lanes running, ${String(queued)} lookups queued (held back or ` +
      `waiting for a lane), ${String(entries)} names kept; lookups ${zonesSaid || 'none'}; the ` +
      `pool ${String(p.size)} workers, ${String(p.busy)} busy, ${String(p.queued)} queued, ` +
      `${String(p.completed)} completed, ${String(p.timedOut)} timed out, ${String(p.deferred)} ` +
      `deferred, ${String(p.refused)} refused, ${String(p.workerCrashes)} crashes` +
      (p.disabled ? ', disabled' : '') +
      helperSaid
    );
  };
  pools.push(pool);
  await within(
    30_000,
    () => `the pool’s ${String(size)} workers to start: ${state()}`,
    pool.start(),
  );
  return {
    pool,
    results,
    resolver,
    state,
    stateAt,
    lookups,
    probeAsked,
    gate,
    /** The pool stopped, as the service manager stops it, then the gate's parts. */
    stop: async () => {
      await within(30_000, () => `the pool to stop: ${state()}`, pool.stop());
      if (gate !== undefined) {
        await within(30_000, () => `the gate to stop: ${state()}`, gate.names.stop());
      }
      if (gateDir !== undefined) rmSync(gateDir, { recursive: true, force: true });
    },
    /** One look at the watched files. */
    checkFiles: () =>
      within(5_000, () => `the watched files to be read: ${state()}`, resolver.checkFiles()),
  };
}

/**
 * Gate mode's parts, built as `main.ts` builds them (`buildNameResolution`): the real name policy
 * over the scenario's own system files (`hosts: files dns`, two search domains), with its name
 * check off in this build, so every name not in the hosts file is asked in the lookup helper; the
 * real `LookupHelper` and its trouble latch, on the scenario's clock; and children that answer as
 * the zones do (`support/zone-helper.ts`).
 */
async function gateRun(
  zones: Zones,
  clock: { now: number },
  watch: readonly string[],
  stuckMs: number,
  resolverOptions: Partial<NameResolverOptions>,
  made: (dir: string) => void,
): Promise<GateRun> {
  const dir = mkdtempSync(join(tmpdir(), 'ms-outage-gate-'));
  made(dir);
  const files = {
    hosts: join(dir, 'hosts'),
    resolvConf: join(dir, 'resolv.conf'),
    nsswitchConf: join(dir, 'nsswitch.conf'),
    gaiConf: join(dir, 'gai.conf'),
    ldSoPreload: join(dir, 'ld.so.preload'),
    nscdSocket: join(dir, 'nscd.socket'),
  };
  writeFileSync(
    files.hosts,
    '127.0.0.1 localhost\n' +
      [...(zones.hosts ?? [])].map(([name, address]) => `${address} ${name}\n`).join(''),
  );
  writeFileSync(files.resolvConf, 'nameserver 192.0.2.53\nsearch a.corp b.corp\n');
  writeFileSync(files.nsswitchConf, 'hosts: files dns\n');
  const helperLookups = new Map<string, Lookups>();
  const counted = (host: string): Lookups => {
    const key = `zone ${zoneLetterOf(host)}`;
    const seen = helperLookups.get(key) ?? {
      asked: 0,
      answered: 0,
      failed: 0,
      inFlight: 0,
      peak: 0,
    };
    helperLookups.set(key, seen);
    return seen;
  };
  const { fork, children } = zoneFork({
    hangMs: zones.hangMs,
    answer: (host): ZoneAnswer =>
      zones.crash?.has(host) === true
        ? { kind: 'crash' }
        : isSilent(zones, host)
          ? { kind: 'silent' }
          : { kind: 'answer', addresses: addressOf(host) },
    began: (host) => {
      const seen = counted(host);
      seen.asked += 1;
      seen.inFlight += 1;
      seen.peak = Math.max(seen.peak, seen.inFlight);
    },
    ended: (host, how) => {
      const seen = counted(host);
      seen.inFlight -= 1;
      if (how === 'answered') seen.answered += 1;
      if (how === 'failed') seen.failed += 1;
    },
  });
  const timers = new ScenarioTimers(clock);
  const names = buildNameResolution({
    mode: 'gate',
    logger: silent,
    lanes: RESOLVER_LANES,
    spoolDir: dir,
    now: () => clock.now,
    resolver: {
      ...resolverOptions,
      watch: {
        files: [
          files.hosts,
          files.resolvConf,
          files.nsswitchConf,
          files.gaiConf,
          files.ldSoPreload,
          ...watch,
        ],
        everyMs: 60_000,
      },
    },
    helper: { fork, timers, limits: { stuckMs } },
    policy: { files, platform: 'linux', env: {} },
  });
  const parts = names.gate;
  assert.ok(parts !== undefined);
  const { helper, latch } = parts;
  await within(30_000, () => `the gate to start: the helper ${helper.state}`, names.start());
  assert.equal(helper.state, 'up', 'the helper up before the first scan');
  const trouble: { at: number; value: 0 | 1 }[] = [];
  const look = (): 0 | 1 => {
    const value = latch.value();
    trouble.push({ at: clock.now, value });
    return value;
  };
  /** Up on a child newer than `before`, or resting. */
  const settled = (what: string, before: number) =>
    pollWithin(
      10_000,
      () => `${what}: the helper ${helper.state}, ${String(children.length)} children`,
      () =>
        helper.state === 'resting' ||
        (helper.state === 'up' && children.length > before && children.at(-1)?.alive === true),
      5,
    );
  return {
    names,
    children,
    timers,
    helperLookups,
    trouble,
    look,
    kill: async () => {
      const child = children.at(-1);
      assert.ok(child?.alive === true && helper.state === 'up', `a child to kill: ${helper.state}`);
      const before = children.length;
      child.die('SIGKILL');
      await settled('the helper after a kill', before);
      look();
    },
    onClock: async () => {
      const before = children.length;
      // Read through a call: the rest's timer changes the state, which a narrowed read would hide.
      const stateNow = (): string => helper.state;
      const resting = stateNow() === 'resting';
      timers.fireDue();
      if (resting && stateNow() !== 'resting') await settled('the helper after its rest', before);
      children.at(-1)?.beat();
      timers.tick();
      look();
    },
  };
}

/** How long a silent lookup runs before `EAI_AGAIN`, in the hosts-edit and warm-zone cases. */
const HANG_MS = 1_500;
/** Real time between those cases' scans: less than a silent lookup runs. */
const SCAN_SPACING_MS = 400;
/** A sensor of the answering zone on a device of its own, scanned less often than the rest. */
const RARE = { sensorId: 1_000, host: 'dev-rare.zone-a.test' } as const;

/** The sensors' states, kept across a restart: the core's, not the probe's. */
function tracking() {
  return {
    states: new Map<number, State>(),
    failures: new Map<number, number>(),
    changes: [] as Change[],
    /** Why each change: the check's result, and the resolver's state then. */
    reasons: new WeakMap<Change, string>(),
  };
}

/**
 * Scans of every device's sensor (sensor `device + 1`), and of any others asked for, and the
 * states they leave, by `docs/state-machine.md §2.1` at its default.
 */
function scanner(
  running: Awaited<ReturnType<typeof probe>>,
  clock: { now: number },
  devices: number,
  track: ReturnType<typeof tracking> = tracking(),
  silentZones = 1,
  /** Each device's name, in place of `hostOf`'s. */
  hostFor: (device: number) => string = (device) => hostOf(device, silentZones),
  /** How long a scan may take for every result to arrive. */
  scanBoundMs = 10_000,
) {
  const { states, failures, changes, reasons } = track;
  const results: CheckResult[] = [];
  /** What each scan left for Probe Health: its checks given up so far, and the latch. */
  const health: HealthSample[] = [];
  /** Each scan's results by sensor, and the state when the scan's last result was in. */
  const scans = new Map<
    number,
    { readonly bySensor: Map<number, CheckResult>; readonly state: string }
  >();
  /** What a check said at a scan, and the state when it said it, or when its scan ended. */
  const said = (sensorId: number, at: number): string => {
    const scan = scans.get(at);
    const result = scan?.bySensor.get(sensorId);
    if (scan === undefined || result === undefined) return `no result at ${String(at)} ms`;
    const words = result.outcome === 'ok' ? 'ok' : `${result.outcome}: ${result.message}`;
    return (
      `at ${String(at)} ms ${words} (${String(result.durationMs)} ms); then ` +
      (running.stateAt.get(result) ?? `at the scan’s end ${scan.state}`)
    );
  };
  /** One scan at `at` on the resolver's clock, then the real time between scans. */
  const scanAt = async (
    at: number,
    also: readonly { readonly sensorId: number; readonly host: string }[] = [],
    /** Done once the scan's checks are handed out, before their results are waited for. */
    during?: () => Promise<void>,
  ): Promise<void> => {
    clock.now = at;
    await running.gate?.onClock();
    const before = running.results.length;
    const sensors = [
      ...Array.from({ length: devices }, (_, device) => ({
        sensorId: device + 1,
        host: hostFor(device),
      })),
      ...also,
    ];
    for (const { sensorId, host } of sensors) {
      const taken = running.pool.submit({
        sensorId,
        sensorType: 'test.named',
        target: { host, ipVersion: 'auto' },
        params: { timeoutMs: SNMP_TIMEOUT_MS },
        timeoutMs: 10_000,
      });
      assert.equal(
        taken,
        'accepted',
        `the pool did not take sensor ${String(sensorId)}’s check at ${String(at)} ms: ${taken}; ${running.state()}`,
      );
    }
    await during?.();
    await pollWithin(
      scanBoundMs,
      () => {
        const arrived = new Set(running.results.slice(before).map(({ sensorId }) => sensorId));
        const waiting = sensors.filter(({ sensorId }) => !arrived.has(sensorId));
        return (
          `the scan at ${String(at)} ms: ${String(arrived.size)} of ${String(sensors.length)} ` +
          `results, none yet for ${waiting
            .slice(0, 10)
            .map(({ host }) => host)
            .join(', ')}${waiting.length > 10 ? ' …' : ''}; ${running.state()}`
        );
      },
      () => running.results.length - before === sensors.length,
      5,
    );
    const bySensor = new Map<number, CheckResult>();
    const changed: Change[] = [];
    for (const result of running.results.slice(before)) {
      results.push(result);
      bySensor.set(result.sensorId, result);
      const count = result.outcome === 'ok' ? 0 : (failures.get(result.sensorId) ?? 0) + 1;
      failures.set(result.sensorId, count);
      const to: State = count === 0 ? 'up' : count === 1 ? 'warning' : 'down';
      const from = states.get(result.sensorId);
      if (from !== undefined && from !== to) {
        const change = { sensorId: result.sensorId, at, from, to };
        changes.push(change);
        changed.push(change);
      }
      states.set(result.sensorId, to);
    }
    scans.set(at, { bySensor, state: running.state() });
    for (const change of changed) reasons.set(change, said(change.sensorId, at));
    health.push({
      at,
      givenUp: running.pool.lookupCounters()?.givenUp ?? 0,
      trouble: running.gate?.look(),
    });
    // Less than a silent lookup runs, so those one scan started still hold lanes at the next.
    await new Promise((resolve) => setTimeout(resolve, SCAN_SPACING_MS));
  };
  /**
   * Why each state changed: the check's result at that scan, and the resolver's state; and, for a
   * sensor whose first check failed, what that check said and the state when it said it, since its
   * first scan is no change and says nothing of its own.
   */
  const why = (list: readonly Change[]): string =>
    list.length === 0
      ? 'none'
      : list
          .map((change) => {
            const first = [...scans].find(([, scan]) => scan.bySensor.has(change.sensorId));
            const firstSaid =
              first !== undefined && first[1].bySensor.get(change.sensorId)?.outcome !== 'ok'
                ? `; its first check, ${said(change.sensorId, first[0])}`
                : '';
            return (
              `sensor ${String(change.sensorId)} ${change.from} to ${change.to} ` +
              (reasons.get(change) ?? `at ${String(change.at)} ms, not said`) +
              firstSaid
            );
          })
          .join(' | ');
  /** A sensor's every result, by scan, and its changes. */
  const history = (sensorId: number): string =>
    [...scans]
      .filter(([, scan]) => scan.bySensor.has(sensorId))
      .map(([at, scan]) => {
        const result = scan.bySensor.get(sensorId);
        return `${String(at)}: ${result?.outcome === 'ok' ? 'ok' : `${String(result?.outcome)} (${String(result?.message)})`}`;
      })
      .join(', ');
  return { scanAt, states, changes, results, why, history, health };
}

/** What a probe's report gives Probe Health after a scan: as `lookupsGivenUp` and the latch. */
interface HealthSample {
  readonly at: number;
  /** The checks given up for want of an answer since the probe started. */
  readonly givenUp: number;
  /** `lookupHelperTrouble`: gate mode only. */
  readonly trouble: 0 | 1 | undefined;
}

/** Probe Health's limit on the checks given up in five minutes (`P-441`), as the type declares it. */
const GIVEN_UP_LIMIT = ((): number => {
  const channel = probeHealth.channels({}).find(({ key }) => key === 'lookupsGivenUpRecently');
  const limit = channel?.limits?.upperWarning;
  assert.ok(limit !== undefined, 'lookupsGivenUpRecently has a Warning limit');
  return limit;
})();

/**
 * Probe Health's Warnings over a run, as the core judges its reports (`P-441`, `P-432` §5): a
 * Warning while the checks given up in the last five minutes are past `GIVEN_UP_LIMIT`
 * (`RECENT_TOTALS`, counted where each report arrives), or while `lookupHelperTrouble` is 1. How
 * many times it went into Warning, and what each scan read.
 */
function healthWarnings(samples: readonly HealthSample[]): {
  readonly warnings: number;
  readonly said: string;
} {
  let warnings = 0;
  let warned = false;
  const said: string[] = [];
  for (const [i, sample] of samples.entries()) {
    let count = 0;
    for (let j = i; j >= 0; j -= 1) {
      const one = samples[j];
      if (one === undefined || one.at <= sample.at - 300_000) break;
      count += one.givenUp - (samples[j - 1]?.givenUp ?? 0);
    }
    const warning = count > GIVEN_UP_LIMIT || sample.trouble === 1;
    if (warning && !warned) warnings += 1;
    warned = warning;
    said.push(
      `${String(sample.at)}: ${String(count)} given up in 5 min` +
        (sample.trouble === 1 ? ', trouble' : '') +
        (warning ? ', Warning' : ''),
    );
  }
  return { warnings, said: said.join('; ') };
}

describe('one zone of ten stops answering (P-426)', () => {
  it('pages the silent zone’s sensors once, after the kept answers run out, and nothing else, across a restart', async () => {
    const zones = { bSilent: false };
    const states = new Map<number, State>();
    const failures = new Map<number, number>();
    const changes: Change[] = [];
    const reasons = new WeakMap<Change, string>();
    const failed: { readonly result: CheckResult; readonly at: number }[] = [];

    /** One scan of every sensor at `at` on the resolver's clock, and the states it leaves. */
    async function scan(
      running: Awaited<ReturnType<typeof probe>>,
      clock: { now: number },
      at: number,
    ) {
      clock.now = at;
      const before = running.results.length;
      const sensors = DEVICES * SENSORS_PER_DEVICE;
      for (let sensorId = 1; sensorId <= sensors; sensorId += 1) {
        const taken = running.pool.submit({
          sensorId,
          sensorType: 'test.named',
          target: { host: hostOf(deviceOf(sensorId)), ipVersion: 'auto' },
          params: { timeoutMs: SNMP_TIMEOUT_MS },
          timeoutMs: 10_000,
        });
        assert.equal(
          taken,
          'accepted',
          `the pool did not take sensor ${String(sensorId)}’s check at ${String(at)} ms: ${taken}; ${running.state()}`,
        );
      }
      await pollWithin(
        10_000,
        () =>
          `the scan at ${String(at)} ms: ${String(running.results.length - before)} of ` +
          `${String(sensors)} results; ${running.state()}`,
        () => running.results.length - before === sensors,
        5,
      );
      for (const result of running.results.slice(before)) {
        const count = result.outcome === 'ok' ? 0 : (failures.get(result.sensorId) ?? 0) + 1;
        failures.set(result.sensorId, count);
        if (result.outcome !== 'ok') failed.push({ result, at });
        const to: State = count === 0 ? 'up' : count === 1 ? 'warning' : 'down';
        const from = states.get(result.sensorId);
        if (from !== undefined && from !== to) {
          const change = { sensorId: result.sensorId, at, from, to };
          changes.push(change);
          reasons.set(
            change,
            `${result.outcome}${result.outcome === 'ok' ? '' : `: ${result.message}`}; then ` +
              (running.stateAt.get(result) ?? running.state()),
          );
        }
        states.set(result.sensorId, to);
      }
    }
    const why = (list: readonly Change[]): string =>
      list
        .map(
          (change) =>
            `sensor ${String(change.sensorId)} ${change.from} to ${change.to} at ` +
            `${String(change.at)} ms: ${reasons.get(change) ?? 'not said'}`,
        )
        .join(' | ') || 'none';

    // Warm: every name answered and kept.
    const clock = { now: 0 };
    const first = await probe(zones, clock);
    await scan(first, clock, 0);
    assert.ok(
      [...states.values()].every((state) => state === 'up'),
      'every sensor Up',
    );

    // Zone B goes silent, and stays silent past the grace and through a restart.
    zones.bSilent = true;
    const expiredAt = ANSWER_MS;
    const graceEnds = expiredAt + STALE_MS;
    let at = 0;
    for (at = INTERVAL_MS; at <= graceEnds + 2 * INTERVAL_MS; at += INTERVAL_MS) {
      await scan(first, clock, at);
    }
    await first.stop();

    // A restart in the middle of it: nothing kept.
    const restartedClock = { now: 0 };
    const second = await probe(zones, restartedClock);
    const restartedAt = at;
    for (let round = 0; round < 2; round += 1, at += INTERVAL_MS) {
      await scan(second, restartedClock, at);
    }

    // The answering zone: no state change at all.
    const answering = changes.filter(({ sensorId }) => zoneOf(deviceOf(sensorId)) === 'a');
    assert.deepEqual(answering, [], `zone A never changed state: ${why(answering)}`);

    // The silent zone: Up on its kept answers until five minutes past their expiry, then Warning
    // and Down, once each, and no change across the restart.
    const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
    const silentSensors = Array.from(
      { length: DEVICES * SENSORS_PER_DEVICE },
      (_, i) => i + 1,
    ).filter((sensorId) => zoneOf(deviceOf(sensorId)) === 'b');
    assert.equal(silentSensors.length, 4);
    for (const sensorId of silentSensors) {
      const its = changes.filter((change) => change.sensorId === sensorId);
      assert.deepEqual(
        its,
        [
          { sensorId, at: firstFailing, from: 'up', to: 'warning' },
          { sensorId, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
        ],
        `sensor ${String(sensorId)}: ${why(its)}`,
      );
      assert.equal(states.get(sensorId), 'down');
    }

    // Each failing scan failed naming the resolver, and at once, not at the lookup's bound: all
    // but the first after the restart, whose checks were each already waiting for a lookup of
    // their own, and keep their bound (`P-426`'s review).
    assert.equal(
      failed.length,
      silentSensors.length * 4,
      'two scans before the restart, two after',
    );
    for (const { result, at: scannedAt } of failed) {
      assert.match(result.message, /the probe’s resolver is not answering/u);
      const limit = scannedAt === restartedAt ? BOUND_MS + 500 : BOUND_MS / 2;
      assert.ok(
        result.durationMs < limit,
        `${String(result.durationMs)} ms at ${String(scannedAt)}, against ${String(limit)} ms: ${result.message}`,
      );
    }
  });

  it('changes nothing for the answering zone when the hosts file is edited and resolv.conf rewritten in the middle of it', async () => {
    // Ten silent names, more than the four first-lookup lanes, each of whose lookups runs longer
    // than the time between scans and then says EAI_AGAIN, as a resolver timing out does; a pool
    // of eight, so checks of the answering zone are asked while silent lookups hold lanes; and a
    // sensor of the answering zone whose kept answer runs out between its scans, so it needs a
    // lane (`P-426`'s second review: with a pool of four, as many as the lanes, nothing of zone
    // A ever waited for one, and dropping every answer and hold on the edit failed nothing).
    const dir = mkdtempSync(join(tmpdir(), 'ms-outage-'));
    try {
      const hostsFile = join(dir, 'hosts');
      const resolvConf = join(dir, 'resolv.conf');
      const nsswitchConf = join(dir, 'nsswitch.conf');
      writeFileSync(hostsFile, '127.0.0.1 localhost\n');
      writeFileSync(resolvConf, 'nameserver 192.0.2.53\n');
      writeFileSync(nsswitchConf, 'hosts: files dns\n');
      const devices = 100;
      const fixed = 0;
      const zones = { bSilent: false, hangMs: HANG_MS, hosts: new Map<string, string>() };
      const clock = { now: 0 };
      const running = await probe(zones, clock, [hostsFile, resolvConf, nsswitchConf], 8);
      assert.equal(await running.checkFiles(), false, 'the baseline');
      const { scanAt, changes, states, why, history } = scanner(running, clock, devices);

      await scanAt(0, [RARE]);
      zones.bSilent = true;
      for (let at = INTERVAL_MS; at <= 3 * INTERVAL_MS; at += INTERVAL_MS) await scanAt(at);
      // The operator's fix for one silent device: its address in the hosts file.
      zones.hosts.set(hostOf(fixed), '192.0.2.200');
      writeFileSync(hostsFile, `127.0.0.1 localhost\n192.0.2.200 ${hostOf(fixed)}\n`);
      assert.equal(await running.checkFiles(), true, `the edit seen: ${running.state()}`);
      await scanAt(4 * INTERVAL_MS);
      // And later resolv.conf rewritten with a second server, as a DHCP lease can.
      writeFileSync(resolvConf, 'nameserver 192.0.2.53\nnameserver 192.0.2.54\n');
      assert.equal(await running.checkFiles(), true, `the rewrite seen: ${running.state()}`);
      const graceEnds = ANSWER_MS + STALE_MS;
      for (let at = 5 * INTERVAL_MS; at <= graceEnds + 2 * INTERVAL_MS; at += INTERVAL_MS) {
        // RARE's answer, from 0 s, has run out by 360 s: asked for the first time again.
        await scanAt(at, at === 6 * INTERVAL_MS ? [RARE] : []);
      }

      const answering = changes.filter(
        ({ sensorId }) => sensorId === RARE.sensorId || zoneOf(sensorId - 1) === 'a',
      );
      assert.deepEqual(answering, [], `zone A never changed state: ${why(answering)}`);
      assert.equal(
        states.get(RARE.sensorId),
        'up',
        `the sensor asked for the first time again: ${history(RARE.sensorId)}`,
      );
      const fixedChanges = changes.filter(({ sensorId }) => sensorId - 1 === fixed);
      assert.deepEqual(
        fixedChanges,
        [],
        `the device the hosts file now gives never changed state either: ${why(fixedChanges)}`,
      );
      const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
      const stillSilent = Array.from({ length: devices }, (_, device) => device).filter(
        (device) => zoneOf(device) === 'b' && device !== fixed,
      );
      assert.equal(stillSilent.length, 9);
      for (const device of stillSilent) {
        const its = changes.filter(({ sensorId }) => sensorId - 1 === device);
        assert.deepEqual(
          its,
          [
            { sensorId: device + 1, at: firstFailing, from: 'up', to: 'warning' },
            { sensorId: device + 1, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
          ],
          `device ${String(device)}: Up on its kept answer through both edits, then Down once; ` +
            `its checks ${history(device + 1)}; its changes ${why(its)}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a lane for first lookups when a warm zone goes silent, so a sensor whose answer ran out between its scans is asked', async () => {
    // `P-426`'s second review: the silent zone's ten names, each with an answer kept and so each
    // refreshed rather than retried, filled all five shared lanes with their first refreshes, for
    // longer than the time between scans. A sensor of the answering zone scanned less often than
    // its answer is kept (330 s with the grace) needs a first lookup at each scan: queued behind
    // those five, it failed at once, Warning, and at its next scan Down.
    const devices = 100;
    const zones = { bSilent: false, hangMs: HANG_MS };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 8);
    const { scanAt, changes, states, results, why, history } = scanner(running, clock, devices);

    // Warm: every name answered, and refreshed each scan until 300 s.
    await scanAt(0, [RARE]);
    for (let at = INTERVAL_MS; at <= 5 * INTERVAL_MS; at += INTERVAL_MS) await scanAt(at);
    zones.bSilent = true;
    const graceEnds = 5 * INTERVAL_MS + ANSWER_MS + STALE_MS;
    const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
    // RARE every six minutes: at 360 s its answer from 0 s has run out, as zone B's first
    // refreshes start, and at 720 s again.
    for (let at = 6 * INTERVAL_MS; at <= firstFailing + INTERVAL_MS; at += INTERVAL_MS) {
      await scanAt(at, at % (6 * INTERVAL_MS) === 0 ? [RARE] : []);
    }

    const rare = results.filter(({ sensorId }) => sensorId === RARE.sensorId);
    assert.deepEqual(
      rare.map(({ outcome, message }) => `${outcome}${outcome === 'ok' ? '' : `: ${message}`}`),
      ['ok', 'ok', 'ok'],
      `asked at each of its three scans, and answered: ${history(RARE.sensorId)}`,
    );
    assert.equal(states.get(RARE.sensorId), 'up');
    const answering = changes.filter(
      ({ sensorId }) => sensorId === RARE.sensorId || zoneOf(sensorId - 1) === 'a',
    );
    assert.deepEqual(answering, [], `zone A never changed state: ${why(answering)}`);
    const silentDevices = Array.from({ length: devices }, (_, device) => device).filter(
      (device) => zoneOf(device) === 'b',
    );
    assert.equal(silentDevices.length, 10);
    for (const device of silentDevices) {
      const its = changes.filter(({ sensorId }) => sensorId - 1 === device);
      assert.deepEqual(
        its,
        [
          { sensorId: device + 1, at: firstFailing, from: 'up', to: 'warning' },
          { sensorId: device + 1, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
        ],
        `device ${String(device)}: Up on its kept answer, then Down once; its checks ` +
          `${history(device + 1)}; its changes ${why(its)}`,
      );
    }
  });

  it('asks the answering zone on a lane of its own from the first scan of a probe started cold in the middle of it (P-438)', async () => {
    // Ten silent names, more than the four first-lookup lanes, each of whose lookups runs longer
    // than the time between scans before EAI_AGAIN, and a pool of eight, every device handed to
    // it at once: the silent zone's names are asked together, before any of their lookups is
    // stuck. None of them has answered, so the zone holds 3 lanes and its fourth name is held
    // back, failing its check once the three are stuck, while every answering name is asked on the
    // lane left. Not held back, the fourth took the last lane, and every answering device after
    // it failed until the first silent lookup ended. Stuck after a second, not 50 ms, so that the
    // scan is handed out long before any silent lookup is stuck (`P-438`'s review): what holds
    // zone B to 3 is that none of its names has answered, not a lookup stuck.
    const devices = 100;
    const zones = { bSilent: true, hangMs: HANG_MS };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 8, 1_000);
    const { scanAt, changes, states, results, why, history } = scanner(running, clock, devices);
    for (let at = 0; at <= 2 * INTERVAL_MS; at += INTERVAL_MS) await scanAt(at);

    const answering = results.filter(({ sensorId }) => zoneOf(sensorId - 1) === 'a');
    assert.equal(answering.length, 3 * 90);
    assert.deepEqual(
      answering
        .filter(({ outcome }) => outcome !== 'ok')
        .map(
          (result) =>
            `${String(result.sensorId)}: ${result.message}; then ${String(running.stateAt.get(result))}`,
        ),
      [],
      'zone A answered from the first scan',
    );
    for (const { sensorId, durationMs } of answering) {
      assert.ok(
        durationMs < BOUND_MS / 2,
        `sensor ${String(sensorId)} took ${String(durationMs)} ms: it waited for a lane; ` +
          running.state(),
      );
    }
    const answeringChanges = changes.filter(({ sensorId }) => zoneOf(sensorId - 1) === 'a');
    assert.deepEqual(answeringChanges, [], `zone A never changed state: ${why(answeringChanges)}`);
    // The silent zone, with nothing kept for it: failing from its first scan, Down at its second,
    // and Down since.
    const silentDevices = Array.from({ length: devices }, (_, device) => device).filter(
      (device) => zoneOf(device) === 'b',
    );
    assert.equal(silentDevices.length, 10);
    for (const device of silentDevices) {
      const its = changes.filter(({ sensorId }) => sensorId - 1 === device);
      assert.deepEqual(
        its,
        [{ sensorId: device + 1, at: INTERVAL_MS, from: 'warning', to: 'down' }],
        `device ${String(device)}: its checks ${history(device + 1)}; its changes ${why(its)}`,
      );
      assert.equal(states.get(device + 1), 'down');
    }
  });

  it('answers the answering zone from the first scan of a probe restarted in the middle of two zones’ outage, from the answers the one before kept, where a cold start fails it (P-438)', async () => {
    // Two silent zones of ten names each, whose lookups run longer than the time between scans,
    // and a pool of eight. Each is held to 3 first-lookup lanes, and the two take the 4 between
    // them (`P-438`'s review, F1): restarted with nothing kept, a probe asks every name for the
    // first time, and the answering zone's checks fail behind the silent zones' first lookups.
    // From the file the probe before it wrote at stop, every name it kept is served what it had
    // while it is asked again, and the silent zones go Down once, when they would have without the
    // restart.
    const dir = mkdtempSync(join(tmpdir(), 'ms-outage-'));
    try {
      const path = answerFilePath(dir);
      const devices = 100;
      const zones = { bSilent: false, cSilent: false, hangMs: HANG_MS };
      const track = tracking();
      /** The wall clock at 0 on the first probe's clock. */
      const wall = Date.UTC(2026, 9, 18, 12, 0, 0);
      /** When the second probe starts, on the first's clock: its own starts at 0 again. */
      const restartAt = 4 * INTERVAL_MS;
      const silentDevices = Array.from({ length: devices }, (_, device) => device).filter(
        (device) => zoneOf(device, 2) !== 'a',
      );
      assert.equal(silentDevices.length, 20);

      // Warm, then zones B and C silent, on a probe that found no file: its first start.
      const clockA = { now: 0 };
      const a = await probe(zones, clockA, [], 8);
      const fileA = new AnswerFile({
        path,
        resolver: a.resolver,
        logger: silent,
        wallNow: () => wall + clockA.now,
      });
      assert.equal(
        await within(5_000, () => `the first probe’s file to load: ${a.state()}`, fileA.load()),
        0,
      );
      const scanA = scanner(a, clockA, devices, track, 2);
      await scanA.scanAt(0);
      zones.bSilent = true;
      zones.cSilent = true;
      for (let at = INTERVAL_MS; at <= 3 * INTERVAL_MS; at += INTERVAL_MS) await scanA.scanAt(at);
      // The refreshes the silent zones' held up have run: on this test's clock a silent lookup
      // outlives three scans, where on a probe's `getaddrinfo` gives up within one, and stopped
      // before they ran, the answering zone's answers the file kept were from its first scan,
      // their grace over before the second probe's third.
      await pollWithin(
        20 * HANG_MS,
        () => `the first probe’s lookups to end: ${a.state()}`,
        () => a.resolver.stats().running === 0 && a.resolver.stats().queued === 0,
        10,
      );
      // Stopped in the middle of it, as the service manager stops it: the pool, then the file.
      clockA.now = 3 * INTERVAL_MS + 20_000;
      await a.stop();
      const saved = await within(
        5_000,
        () => `the first probe’s file to be written: ${a.state()}`,
        fileA.stop(),
      );
      assert.equal(saved?.saved, devices, `every name, the silent ones too: ${a.state()}`);

      // The same restart with no file: every name asked for the first time.
      const clockCold = { now: 0 };
      const cold = await probe(zones, clockCold, [], 8);
      const scanCold = scanner(cold, clockCold, devices, tracking(), 2);
      await scanCold.scanAt(0);
      const coldFailed = scanCold.results.filter(
        ({ sensorId, outcome }) => zoneOf(sensorId - 1, 2) === 'a' && outcome !== 'ok',
      );
      assert.ok(
        coldFailed.length > 0,
        'started cold, the answering zone’s checks fail behind the two silent zones’ 4 first ' +
          `lookups: ${cold.state()}`,
      );
      await cold.stop();

      const clockB = { now: 0 };
      const b = await probe(zones, clockB, [], 8);
      const fileB = new AnswerFile({
        path,
        resolver: b.resolver,
        logger: silent,
        wallNow: () => wall + restartAt + clockB.now,
      });
      assert.equal(
        await within(5_000, () => `the second probe’s file to load: ${b.state()}`, fileB.load()),
        devices,
      );
      const scanB = scanner(b, clockB, devices, track, 2);
      await scanB.scanAt(0);
      const first = scanB.results.filter(({ sensorId }) => zoneOf(sensorId - 1, 2) === 'a');
      assert.equal(first.length, 80);
      assert.deepEqual(
        first
          .filter(({ outcome }) => outcome !== 'ok')
          .map(
            (result) =>
              `${String(result.sensorId)}: ${result.message}; then ${String(b.stateAt.get(result))}`,
          ),
        [],
        'zone A answered from the first scan',
      );
      for (const { sensorId, durationMs } of first) {
        assert.ok(
          durationMs < BOUND_MS / 2,
          `sensor ${String(sensorId)} took ${String(durationMs)} ms: it waited for a lookup; ` +
            b.state(),
        );
      }
      // Zones B and C's answers, from 0 s, are kept until 330 s on the first probe's clock.
      const graceEnds = ANSWER_MS + STALE_MS;
      for (let at = INTERVAL_MS; restartAt + at <= graceEnds + 2 * INTERVAL_MS; at += INTERVAL_MS) {
        await scanB.scanAt(at);
      }

      const answering = track.changes.filter(({ sensorId }) => zoneOf(sensorId - 1, 2) === 'a');
      assert.deepEqual(
        answering,
        [],
        `zone A never changed state, across the restart: ${scanB.why(answering)}`,
      );
      // The second probe's clock: 360 s on the first's is its 120 s.
      const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS - restartAt;
      for (const device of silentDevices) {
        const its = track.changes.filter(({ sensorId }) => sensorId - 1 === device);
        assert.deepEqual(
          its,
          [
            { sensorId: device + 1, at: firstFailing, from: 'up', to: 'warning' },
            { sensorId: device + 1, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
          ],
          `device ${String(device)}: Up on the answer kept across the restart, then Down once; ` +
            `its checks before ${scanA.history(device + 1)}, after ${scanB.history(device + 1)}; ` +
            `its changes ${scanB.why(its)}`,
        );
        assert.equal(track.states.get(device + 1), 'down');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * **The gate with its name check off** (`P-432` S3, §7.4): every name not in the hosts file is
 * asked in the lookup helper, whose lanes keep a silent zone to its share, so that one zone's
 * outage costs the zones that answer nothing, with no c-ares at all; and the helper's own faults
 * raise one Warning, from its latch, and change no sensor's state.
 *
 * As the cases above: real workers, the real catalogue and guard, the real `NameResolver`, and here
 * the real name policy, `LookupHelper` and trouble latch, built as `main.ts` builds them; the
 * helper's children are the zones' (`support/zone-helper.ts`), and its long timers (a rest) run on
 * the scenario's clock.
 */
describe('the gate with its name check off: one zone stops answering (P-432 S3)', () => {
  /** One device in ten in zone A, the rest in zone B. */
  const mostlyB = (device: number): string =>
    `dev-${String(device)}.zone-${device % 10 === 9 ? 'a' : 'b'}.test`;

  /** SC10's script, in either mode: warm, then zone B silent past its answers' grace. */
  async function warmOutage(mode: 'system' | 'gate') {
    const devices = 500;
    const zones: Zones = { bSilent: false, hangMs: HANG_MS };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 8, 50, mode);
    const scan = scanner(running, clock, devices, tracking(), 1, mostlyB);
    try {
      for (let at = 0; at <= 5 * INTERVAL_MS; at += INTERVAL_MS) await scan.scanAt(at);
      zones.bSilent = true;
      const graceEnds = 5 * INTERVAL_MS + ANSWER_MS + STALE_MS;
      const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
      for (let at = 6 * INTERVAL_MS; at <= firstFailing + 2 * INTERVAL_MS; at += INTERVAL_MS) {
        await scan.scanAt(at);
      }
      return { running, scan, firstFailing, devices };
    } finally {
      await running.stop();
    }
  }

  it('SC10: a warm outage of a 450-name zone changes nothing for zone A, holds zone B to 4 helper lanes, and gives one Probe Health Warning, as system mode does', async () => {
    const gate = await warmOutage('gate');
    const { running, scan, firstFailing, devices } = gate;
    const inA = (sensorId: number): boolean => (sensorId - 1) % 10 === 9;
    const answering = scan.changes.filter(({ sensorId }) => inA(sensorId));
    assert.deepEqual(answering, [], `zone A never changed state: ${scan.why(answering)}`);
    const silentSensors = Array.from({ length: devices }, (_, i) => i + 1).filter(
      (sensorId) => !inA(sensorId),
    );
    assert.equal(silentSensors.length, 450);
    for (const sensorId of silentSensors) {
      const its = scan.changes.filter((change) => change.sensorId === sensorId);
      assert.deepEqual(
        its,
        [
          { sensorId, at: firstFailing, from: 'up', to: 'warning' },
          { sensorId, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
        ],
        `sensor ${String(sensorId)}: ${scan.history(sensorId)}; ${scan.why(its)}`,
      );
    }
    const zoneB = running.gate?.helperLookups.get('zone b');
    assert.ok(zoneB !== undefined, running.state());
    assert.ok(zoneB.peak <= 4, `zone B on at most 4 helper lanes at once: ${running.state()}`);
    assert.deepEqual(running.probeAsked, [], 'none on the probe’s lanes: the check is off');
    const gateHealth = healthWarnings(scan.health);
    assert.equal(gateHealth.warnings, 1, `one Probe Health Warning: ${gateHealth.said}`);
    assert.ok(
      running.gate?.trouble.every(({ value }) => value === 0),
      'the latch never set: the helper carried the outage',
    );

    // The same script in system mode (S-F9): the same one Warning, from P-441's count.
    const system = await warmOutage('system');
    const systemHealth = healthWarnings(system.scan.health);
    assert.equal(
      systemHealth.warnings,
      gateHealth.warnings,
      `as many in system mode: ${systemHealth.said}`,
    );
  });

  /** The latch's readings, each kept only where it differs from the one before. */
  const transitions = (
    readings: readonly { readonly at: number; readonly value: 0 | 1 }[],
  ): { readonly at: number; readonly value: 0 | 1 }[] =>
    readings.filter((reading, i) => i === 0 || readings[i - 1]?.value !== reading.value);

  /** The helper of a gate probe, which must have one. */
  const helperOf = (running: Awaited<ReturnType<typeof probe>>) => {
    const gate = running.gate;
    const helper = gate?.names.gate?.helper;
    assert.ok(gate !== undefined && helper !== undefined, 'a gate probe');
    return { gate, helper };
  };

  const inZoneA = (sensorId: number): boolean => zoneOf(sensorId - 1) === 'a';

  it('SC1b: a cold start into an outage of 10 names, the helper killed at 5 s and at 95 s: zone A is answered from the first scan and never changes state, zone B goes Down once, none of it on the probe’s lanes, and the latch stays 0', async () => {
    const devices = 100;
    const zones: Zones = { bSilent: true, hangMs: HANG_MS };
    const clock = { now: 0 };
    // Stuck after a second, as in P-438's cold case: the scan is handed out before any is stuck.
    const running = await probe(zones, clock, [], 8, 1_000, 'gate');
    const { gate } = helperOf(running);
    const scan = scanner(running, clock, devices);
    try {
      await scan.scanAt(0, [], async () => {
        clock.now = 5_000;
        await gate.kill();
      });
      await scan.scanAt(INTERVAL_MS);
      clock.now = 95_000;
      await gate.kill();
      for (let at = 2 * INTERVAL_MS; at <= 3 * INTERVAL_MS; at += INTERVAL_MS) {
        await scan.scanAt(at);
      }
    } finally {
      await running.stop();
    }
    assert.equal(gate.children.length, 3, 'two kills, a child after each');
    const answering = scan.results.filter(({ sensorId }) => inZoneA(sensorId));
    assert.equal(answering.length, 4 * 90);
    assert.deepEqual(
      answering
        .filter(({ outcome }) => outcome !== 'ok')
        .map(
          (result) =>
            `${String(result.sensorId)}: ${result.message}; then ${String(running.stateAt.get(result))}`,
        ),
      [],
      'zone A answered at every scan, the first included',
    );
    // At once, not after a silent lookup ended (1.5 s): answered on a lane of its own.
    for (const { sensorId, durationMs } of answering) {
      assert.ok(
        durationMs < BOUND_MS / 2,
        `sensor ${String(sensorId)} took ${String(durationMs)} ms: it waited for a lane; ` +
          running.state(),
      );
    }
    const changesA = scan.changes.filter(({ sensorId }) => inZoneA(sensorId));
    assert.deepEqual(changesA, [], `zone A never changed state: ${scan.why(changesA)}`);
    const silentDevices = Array.from({ length: devices }, (_, device) => device).filter(
      (device) => zoneOf(device) === 'b',
    );
    for (const device of silentDevices) {
      const its = scan.changes.filter(({ sensorId }) => sensorId - 1 === device);
      assert.deepEqual(
        its,
        [{ sensorId: device + 1, at: INTERVAL_MS, from: 'warning', to: 'down' }],
        `device ${String(device)}: ${scan.history(device + 1)}; ${scan.why(its)}`,
      );
    }
    assert.deepEqual(running.probeAsked, [], 'nothing on the probe’s lanes');
    assert.deepEqual(transitions(gate.trouble), [{ at: 0, value: 0 }], 'the latch stays 0');
  });

  it('SC7: the helper killed every 90 s for 10 minutes: trouble 0, then 1 at the third loss, then 0 ten minutes after its rest ends, and no sensor changes state', async () => {
    const devices = 20;
    const zones: Zones = { bSilent: false };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 2, 50, 'gate');
    const { gate, helper } = helperOf(running);
    const scan = scanner(running, clock, devices);
    const kills: number[] = [];
    let backAt: number | undefined;
    try {
      // Every 30 s on the clock: a scan each minute, a kill each 90 s while there is a child.
      for (let at = 0; at <= 1_800_000; at += 30_000) {
        if (at % INTERVAL_MS === 0) {
          await scan.scanAt(at);
        } else {
          clock.now = at;
          await gate.onClock();
        }
        if (backAt === undefined && kills.length === 5 && helper.state === 'up') backAt = at;
        if (at > 0 && at % 90_000 === 0 && at <= 600_000 && helper.state === 'up') {
          await gate.kill();
          kills.push(at);
        }
      }
    } finally {
      await running.stop();
    }
    assert.deepEqual(
      kills,
      [90_000, 180_000, 270_000, 360_000, 450_000],
      'the fifth loss rests it, so there is no child to kill at 540 s',
    );
    assert.equal(backAt, 450_000 + 600_000, 'back when its first rest of 10 minutes ends');
    assert.deepEqual(transitions(gate.trouble), [
      { at: 0, value: 0 },
      { at: 270_000, value: 1 },
      { at: 450_000 + 600_000 + 600_000, value: 0 },
    ]);
    assert.deepEqual(scan.changes, [], `no sensor changed state: ${scan.why(scan.changes)}`);
    const health = healthWarnings(scan.health);
    assert.equal(health.warnings, 1, `one Probe Health Warning: ${health.said}`);
  });

  it('SC8: five losses rest the helper: names are asked as system mode asks them until the rest ends, then in the helper again; no sensor changes state, and one Warning', async () => {
    const devices = 20;
    const zones: Zones = { bSilent: false };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 2, 50, 'gate');
    const { gate, helper } = helperOf(running);
    const scan = scanner(running, clock, devices);
    let resting = 0;
    let back = 0;
    try {
      await scan.scanAt(0);
      for (let i = 1; i <= 5; i += 1) {
        clock.now = i * 10_000;
        await gate.kill();
      }
      assert.equal(helper.state, 'resting');
      assert.equal(gate.names.modeValue(), 3, 'resting: resolving as system does');
      // Resting from 50 s for 10 minutes: every scan to 600 s is in it.
      for (let at = INTERVAL_MS; at <= 10 * INTERVAL_MS; at += INTERVAL_MS) await scan.scanAt(at);
      resting = running.probeAsked.length;
      const helperAsked = gate.helperLookups.get('zone a')?.asked ?? 0;
      for (let at = 11 * INTERVAL_MS; at <= 13 * INTERVAL_MS; at += INTERVAL_MS) {
        await scan.scanAt(at);
      }
      back = (gate.helperLookups.get('zone a')?.asked ?? 0) - helperAsked;
      assert.equal(helper.state, 'up');
      assert.equal(gate.names.modeValue(), 2);
    } finally {
      await running.stop();
    }
    assert.ok(
      resting >= devices,
      `every name asked on the probe’s lanes while resting: ${String(resting)}`,
    );
    assert.ok(
      running.probeAsked.slice(0, resting).every((line) => line.endsWith('route resting')),
      running.probeAsked.join('; '),
    );
    assert.equal(running.probeAsked.length, resting, 'none on the probe’s lanes once it is back');
    assert.ok(back > 0, 'asked in the helper again');
    assert.deepEqual(scan.changes, [], `no sensor changed state: ${scan.why(scan.changes)}`);
    const health = healthWarnings(scan.health);
    assert.equal(health.warnings, 1, `one Probe Health Warning: ${health.said}`);
  });

  it('SC8b: a rest in a cold outage: zone A’s first lookups in the next 30 s are answered, and zone B holds at most 3 of the probe’s first lanes (D24)', async () => {
    const devices = 100;
    const zones: Zones = { bSilent: true, hangMs: HANG_MS };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 8, 1_000, 'gate');
    const { gate, helper } = helperOf(running);
    const scan = scanner(running, clock, devices);
    const added = Array.from({ length: 10 }, (_, i) => ({
      sensorId: 1_000 + i,
      host: `dev-new-${String(i)}.zone-a.test`,
    }));
    /** Zone B's most at once in the first scan, when every lookup of it is a first lookup. */
    let firstScanPeak: number | undefined;
    try {
      for (let i = 1; i <= 5; i += 1) {
        clock.now = i * 500;
        await gate.kill();
      }
      assert.equal(helper.state, 'resting');
      await scan.scanAt(5_000);
      firstScanPeak = running.lookups.get('zone b')?.peak;
      await scan.scanAt(30_000, added);
      await scan.scanAt(65_000, added);
    } finally {
      await running.stop();
    }
    const answering = scan.results.filter(({ sensorId }) => sensorId >= 1_000 || inZoneA(sensorId));
    assert.equal(answering.length, 3 * 90 + 2 * 10);
    assert.deepEqual(
      answering
        .filter(({ outcome }) => outcome !== 'ok')
        .map(
          (result) =>
            `${String(result.sensorId)}: ${result.message}; then ${String(running.stateAt.get(result))}`,
        ),
      [],
      'zone A answered, its new names included',
    );
    for (const { sensorId, durationMs } of answering) {
      assert.ok(
        durationMs < BOUND_MS / 2,
        `sensor ${String(sensorId)} took ${String(durationMs)} ms: it waited for a lane; ` +
          running.state(),
      );
    }
    const changesA = scan.changes.filter(({ sensorId }) => sensorId >= 1_000 || inZoneA(sensorId));
    assert.deepEqual(changesA, [], `zone A never changed state: ${scan.why(changesA)}`);
    assert.equal(firstScanPeak, 3, `zone B on 3 of the 4 first lanes: ${running.state()}`);
    // Later, as its names fail, its retries take the one retry lane too.
    const zoneB = running.lookups.get('zone b');
    assert.ok(zoneB !== undefined && zoneB.peak <= 4, `and the retry lane: ${running.state()}`);
    assert.equal(gate.helperLookups.size, 0, 'nothing asked in the helper: it rested throughout');
  });

  it('SC11: a partial outage, check off: zone B’s names still answered and zone A never change state, and its silent names go Warning, then Down, once', async () => {
    const devices = 100;
    const zones: Zones = { bSilent: false, hangMs: HANG_MS };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 8, 50, 'gate');
    const scan = scanner(running, clock, devices);
    /** Half of zone B's devices: 0, 20, 40, 60 and 80. The others its servers still answer. */
    const goesSilent = (device: number): boolean => zoneOf(device) === 'b' && device % 20 === 0;
    try {
      for (let at = 0; at <= 5 * INTERVAL_MS; at += INTERVAL_MS) await scan.scanAt(at);
      zones.silentName = (host) => goesSilent(Number(/^dev-(\d+)\./u.exec(host)?.[1] ?? '-1'));
      const graceEnds = 5 * INTERVAL_MS + ANSWER_MS + STALE_MS;
      const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
      for (let at = 6 * INTERVAL_MS; at <= firstFailing + 2 * INTERVAL_MS; at += INTERVAL_MS) {
        await scan.scanAt(at);
      }
      const still = scan.changes.filter(({ sensorId }) => !goesSilent(sensorId - 1));
      assert.deepEqual(still, [], `none but the silent names changed state: ${scan.why(still)}`);
      for (const device of [0, 20, 40, 60, 80]) {
        const its = scan.changes.filter(({ sensorId }) => sensorId - 1 === device);
        assert.deepEqual(
          its,
          [
            { sensorId: device + 1, at: firstFailing, from: 'up', to: 'warning' },
            { sensorId: device + 1, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
          ],
          `device ${String(device)}: ${scan.history(device + 1)}; ${scan.why(its)}`,
        );
      }
    } finally {
      await running.stop();
    }
    assert.deepEqual(running.probeAsked, [], 'nothing on the probe’s lanes');
  });

  /** SC12's script, in either mode: single labels, cold, with every `silentEvery`th silent. */
  async function singleLabels(mode: 'system' | 'gate', devices: number, silentEvery: number) {
    const labelOf = (device: number): string =>
      device % silentEvery === silentEvery - 1 ? `sw-b${String(device)}` : `sw-a${String(device)}`;
    const zones: Zones = {
      bSilent: false,
      hangMs: HANG_MS,
      silentName: (host) => host.startsWith('sw-b'),
    };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 8, 1_000, mode);
    // Every silent label's check waits out its bound in `system` mode: 40 of them on 8 workers.
    const scan = scanner(running, clock, devices, tracking(), 1, labelOf, 30_000);
    try {
      for (let at = 0; at <= 2 * INTERVAL_MS; at += INTERVAL_MS) await scan.scanAt(at);
    } finally {
      await running.stop();
    }
    const inA = (sensorId: number): boolean => labelOf(sensorId - 1).startsWith('sw-a');
    return { running, scan, inA };
  }

  it('SC12: single labels, cold, check off, 3 silent: the sw-a sensors never change state, whatever order their lookups come in; with 40 silent, they change no more than in system mode', async () => {
    // Three silent labels, each a key of its own, hold 3 of the helper's 4 first lanes while they
    // hang, so every answering label has the fourth whichever order the 8 workers' lookups arrive
    // in, and sw-a36 to sw-a43 are asked after all three are held (K4). Four silent labels fill
    // the four: an answering label asked after the fourth waits behind four lookups said stuck,
    // and its check fails at once, as K4 pins. This was 44 labels with every eleventh silent, the
    // fourth silent one last, which held only while sw-b43's lookup came after sw-a42's; on 8
    // workers it now and then came first, and sw-a42 failed its cold first check.
    const few = await singleLabels('gate', 44, 12);
    const silentPeak = few.running.gate?.helperLookups.get('zone b')?.peak ?? 0;
    assert.ok(
      silentPeak >= 3,
      `the three silent labels held three of the helper’s lanes at once: ${few.running.state()}`,
    );
    const fewA = few.scan.changes.filter(({ sensorId }) => few.inA(sensorId));
    assert.deepEqual(fewA, [], `sw-a never changed state: ${few.scan.why(fewA)}`);
    for (const { sensorId, durationMs, outcome } of few.scan.results) {
      if (!few.inA(sensorId)) continue;
      assert.equal(outcome, 'ok');
      assert.ok(
        durationMs < BOUND_MS / 2,
        `sw-a${String(sensorId - 1)} took ${String(durationMs)} ms: it waited for a lane; ` +
          few.running.state(),
      );
    }
    assert.deepEqual(few.running.probeAsked, [], 'nothing on the probe’s lanes');

    const gate = await singleLabels('gate', 80, 2);
    const system = await singleLabels('system', 80, 2);
    const gateA = gate.scan.changes.filter(({ sensorId }) => gate.inA(sensorId));
    const systemA = system.scan.changes.filter(({ sensorId }) => system.inA(sensorId));
    assert.ok(
      gateA.length <= systemA.length,
      `gate ${String(gateA.length)}: ${gate.scan.why(gateA)}; system ${String(systemA.length)}: ` +
        system.scan.why(systemA),
    );
  });

  it('SC17: a name that crashes the helper is charged and kept off every lane: one Warning, no other sensor changes state, and the probe goes on, resting included', async () => {
    const devices = 20;
    const CRASH = { sensorId: 1_000, host: 'dev-crash.zone-c.test' } as const;
    const zones: Zones = { bSilent: false, crash: new Set([CRASH.host]) };
    const clock = { now: 0 };
    const running = await probe(zones, clock, [], 2, 50, 'gate');
    const { gate, helper } = helperOf(running);
    const scan = scanner(running, clock, devices);
    let marked: boolean | undefined;
    let kills = 0;
    try {
      for (let at = 0; at <= 5 * INTERVAL_MS; at += INTERVAL_MS) await scan.scanAt(at, [CRASH]);
      marked = helper.poison(CRASH.host, 4) !== undefined;
      // Then the helper killed until it rests: the name still never reaches the probe's lanes.
      for (let i = 1; i <= 5 && helper.state === 'up'; i += 1) {
        clock.now = 5 * INTERVAL_MS + i * 1_000;
        await gate.kill();
        kills += 1;
      }
      assert.equal(helper.state, 'resting', `rested after ${String(kills)} kills`);
      for (let at = 6 * INTERVAL_MS; at <= 30 * INTERVAL_MS; at += INTERVAL_MS) {
        await scan.scanAt(at, [CRASH]);
      }
    } finally {
      await running.stop();
    }
    assert.equal(marked, true, `poison: ${running.state()}`);
    assert.deepEqual(
      running.probeAsked.filter((line) => line.startsWith(CRASH.host)),
      [],
      'never on the probe’s lanes',
    );
    const others = scan.changes.filter(({ sensorId }) => sensorId !== CRASH.sensorId);
    assert.deepEqual(others, [], `no other sensor changed state: ${scan.why(others)}`);
    const rises = transitions(gate.trouble).filter(({ value }) => value === 1);
    assert.equal(rises.length, 1, JSON.stringify(transitions(gate.trouble)));
    assert.equal(transitions(gate.trouble).at(-1)?.value, 0, 'cleared by the end');
    const health = healthWarnings(scan.health);
    assert.equal(health.warnings, 1, `one Probe Health Warning: ${health.said}`);
    assert.equal(running.pool.stats().workerCrashes, 0, 'the probe never crashed');
  });
});

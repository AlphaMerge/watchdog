import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { ResolvedAddress } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { AnswerFile, answerFilePath } from '../src/resolver/answer-file.js';
import {
  ANSWER_MS,
  NameResolver,
  RESOLVER_LANES,
  STALE_MS,
} from '../src/resolver/name-resolver.js';
import { CheckPool } from '../src/runner/index.js';
import { pollWithin, within } from './support/within.js';

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
}

/**
 * The probe: a resolver over the zones, and a pool whose workers ask it. Every wait on its
 * workers or its files is bounded, and says what it waited for and the resolver's state then:
 * `state()`, which a failed check's result also carries, as `stateAt`, from when it arrived.
 */
async function probe(
  zones: {
    bSilent: boolean;
    /** Zone C silent too. */
    readonly cSilent?: boolean;
    /** How long a silent lookup runs before `EAI_AGAIN`; never, unless set. */
    readonly hangMs?: number;
    /** What the test's hosts file gives, which `getaddrinfo` reads ahead of DNS. */
    readonly hosts?: Map<string, string>;
  },
  clock: { now: number },
  watch: readonly string[] = [],
  size = 2,
  stuckMs = 50,
) {
  const lookups = new Map<string, Lookups>();
  /** One more lookup asked, counted by its zone, or as the hosts file's. */
  const asked = (key: string): Lookups => {
    const seen = lookups.get(key) ?? { asked: 0, answered: 0, failed: 0, inFlight: 0 };
    lookups.set(key, seen);
    seen.asked += 1;
    return seen;
  };
  const resolver = new NameResolver({
    logger: silent,
    now: () => clock.now,
    stuckMs,
    random: () => 0.5,
    watch: { files: watch, everyMs: 60_000 },
    lookup: (host) => {
      const listed = zones.hosts?.get(host);
      if (listed !== undefined) {
        asked('the hosts file').answered += 1;
        return Promise.resolve([{ address: listed, family: 4 }]);
      }
      const seen = asked(`zone ${/\.zone-([a-z])\.test$/u.exec(host)?.[1] ?? '?'}`);
      if (
        (zones.bSilent && host.endsWith('.zone-b.test')) ||
        (zones.cSilent === true && host.endsWith('.zone-c.test'))
      ) {
        const hangMs = zones.hangMs;
        seen.inFlight += 1;
        return new Promise<readonly ResolvedAddress[]>((_resolve, reject) => {
          if (hangMs === undefined) return;
          setTimeout(() => {
            seen.inFlight -= 1;
            seen.failed += 1;
            reject(
              Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' }),
            );
          }, hangMs);
        });
      }
      seen.answered += 1;
      const device = Number(/^dev-(\d+)\./u.exec(host)?.[1] ?? '0');
      return Promise.resolve([{ address: `192.0.2.${String((device % 250) + 1)}`, family: 4 }]);
    },
  });
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
          `${String(seen.failed)} EAI_AGAIN, ${String(seen.inFlight)} in flight`,
      )
      .join('; ');
    const p = pool.stats();
    return (
      `at ${String(clock.now)} ms on the resolver’s clock: ${String(running)} of ` +
      `${String(RESOLVER_LANES)} lanes running, ${String(queued)} lookups queued (held back or ` +
      `waiting for a lane), ${String(entries)} names kept; lookups ${zonesSaid || 'none'}; the ` +
      `pool ${String(p.size)} workers, ${String(p.busy)} busy, ${String(p.queued)} queued, ` +
      `${String(p.completed)} completed, ${String(p.timedOut)} timed out, ${String(p.deferred)} ` +
      `deferred, ${String(p.refused)} refused, ${String(p.workerCrashes)} crashes` +
      (p.disabled ? ', disabled' : '')
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
    /** The pool stopped, as the service manager stops it. */
    stop: () => within(30_000, () => `the pool to stop: ${state()}`, pool.stop()),
    /** One look at the watched files. */
    checkFiles: () =>
      within(5_000, () => `the watched files to be read: ${state()}`, resolver.checkFiles()),
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
) {
  const { states, failures, changes, reasons } = track;
  const results: CheckResult[] = [];
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
  ): Promise<void> => {
    clock.now = at;
    const before = running.results.length;
    const sensors = [
      ...Array.from({ length: devices }, (_, device) => ({
        sensorId: device + 1,
        host: hostOf(device, silentZones),
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
    await pollWithin(
      10_000,
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
    // Less than a silent lookup runs, so those one scan started still hold lanes at the next.
    await new Promise((resolve) => setTimeout(resolve, SCAN_SPACING_MS));
  };
  /** Why each state changed: the check's result at that scan, and the resolver's state. */
  const why = (list: readonly Change[]): string =>
    list.length === 0
      ? 'none'
      : list
          .map(
            (change) =>
              `sensor ${String(change.sensorId)} ${change.from} to ${change.to} ` +
              (reasons.get(change) ?? `at ${String(change.at)} ms, not said`),
          )
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
  return { scanAt, states, changes, results, why, history };
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

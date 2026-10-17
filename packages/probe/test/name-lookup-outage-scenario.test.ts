import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { ResolvedAddress } from '@ms/sensors';
import type { CheckResult } from '@ms/shared';
import { ANSWER_MS, NameResolver, STALE_MS } from '../src/resolver/name-resolver.js';
import { CheckPool } from '../src/runner/index.js';
import { pollWithin } from './support/within.js';

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
 * leaves the answering zone lanes to be asked on. With more silent names than that, a cold probe
 * fails the answering zone's first scans too until the silent lookups end: `getaddrinfo` cannot be
 * cancelled. That is what `test:perf`'s cold zone arm reads.
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
 */

const silent = pino({ level: 'silent' });
const LOOKUPS = join(import.meta.dirname, 'support', 'lookup-registry.js');

const DEVICES = 20;
const SENSORS_PER_DEVICE = 2;
const INTERVAL_MS = 60_000;
/** SNMP's own timeout, of which the lookup has half. */
const SNMP_TIMEOUT_MS = 4_000;
const BOUND_MS = SNMP_TIMEOUT_MS / 2;

const zoneOf = (device: number): 'a' | 'b' => (device % 10 === 0 ? 'b' : 'a');
const hostOf = (device: number): string => `dev-${String(device)}.zone-${zoneOf(device)}.test`;
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
  await Promise.all(pools.map((pool) => pool.stop()));
});

/** The probe: a resolver over the zones, and a pool whose workers ask it. */
async function probe(
  zones: {
    bSilent: boolean;
    /** How long a silent lookup runs before `EAI_AGAIN`; never, unless set. */
    readonly hangMs?: number;
    /** What the test's hosts file gives, which `getaddrinfo` reads ahead of DNS. */
    readonly hosts?: Map<string, string>;
  },
  clock: { now: number },
  watch: readonly string[] = [],
  size = 2,
) {
  const resolver = new NameResolver({
    logger: silent,
    now: () => clock.now,
    stuckMs: 50,
    random: () => 0.5,
    watch: { files: watch, everyMs: 60_000 },
    lookup: (host) => {
      const listed = zones.hosts?.get(host);
      if (listed !== undefined) return Promise.resolve([{ address: listed, family: 4 }]);
      if (zones.bSilent && host.endsWith('.zone-b.test')) {
        const hangMs = zones.hangMs;
        return new Promise<readonly ResolvedAddress[]>((_resolve, reject) => {
          if (hangMs === undefined) return;
          setTimeout(() => {
            reject(
              Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' }),
            );
          }, hangMs);
        });
      }
      const device = Number(/^dev-(\d+)\./u.exec(host)?.[1] ?? '0');
      return Promise.resolve([{ address: `192.0.2.${String((device % 250) + 1)}`, family: 4 }]);
    },
  });
  const results: CheckResult[] = [];
  const pool = new CheckPool({
    logger: silent,
    size,
    minSize: size,
    registryModule: LOOKUPS,
    resolver,
    onResult: (result) => results.push(result),
  });
  pools.push(pool);
  await pool.start();
  return { pool, results, resolver };
}

/** How long a silent lookup runs before `EAI_AGAIN`, in the hosts-edit and warm-zone cases. */
const HANG_MS = 1_500;
/** Real time between those cases' scans: less than a silent lookup runs. */
const SCAN_SPACING_MS = 400;
/** A sensor of the answering zone on a device of its own, scanned less often than the rest. */
const RARE = { sensorId: 1_000, host: 'dev-rare.zone-a.test' } as const;

/**
 * Scans of every device's sensor (sensor `device + 1`), and of any others asked for, and the
 * states they leave, by `docs/state-machine.md §2.1` at its default.
 */
function scanner(
  running: Awaited<ReturnType<typeof probe>>,
  clock: { now: number },
  devices: number,
) {
  const states = new Map<number, State>();
  const failures = new Map<number, number>();
  const changes: Change[] = [];
  const results: CheckResult[] = [];
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
        host: hostOf(device),
      })),
      ...also,
    ];
    for (const { sensorId, host } of sensors) {
      running.pool.submit({
        sensorId,
        sensorType: 'test.named',
        target: { host, ipVersion: 'auto' },
        params: { timeoutMs: SNMP_TIMEOUT_MS },
        timeoutMs: 10_000,
      });
    }
    await pollWithin(
      10_000,
      () => `the scan at ${String(at)} ms: ${String(running.results.length - before)}`,
      () => running.results.length - before === sensors.length,
      5,
    );
    for (const result of running.results.slice(before)) {
      results.push(result);
      const count = result.outcome === 'ok' ? 0 : (failures.get(result.sensorId) ?? 0) + 1;
      failures.set(result.sensorId, count);
      const to: State = count === 0 ? 'up' : count === 1 ? 'warning' : 'down';
      const from = states.get(result.sensorId);
      if (from !== undefined && from !== to) {
        changes.push({ sensorId: result.sensorId, at, from, to });
      }
      states.set(result.sensorId, to);
    }
    // Less than a silent lookup runs, so those one scan started still hold lanes at the next.
    await new Promise((resolve) => setTimeout(resolve, SCAN_SPACING_MS));
  };
  return { scanAt, states, changes, results };
}

describe('one zone of ten stops answering (P-426)', () => {
  it('pages the silent zone’s sensors once, after the kept answers run out, and nothing else, across a restart', async () => {
    const zones = { bSilent: false };
    const states = new Map<number, State>();
    const failures = new Map<number, number>();
    const changes: Change[] = [];
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
        running.pool.submit({
          sensorId,
          sensorType: 'test.named',
          target: { host: hostOf(deviceOf(sensorId)), ipVersion: 'auto' },
          params: { timeoutMs: SNMP_TIMEOUT_MS },
          timeoutMs: 10_000,
        });
      }
      await pollWithin(
        10_000,
        () =>
          `the scan at ${String(at)} ms: ${String(running.results.length - before)} of ${String(sensors)}`,
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
          changes.push({ sensorId: result.sensorId, at, from, to });
        }
        states.set(result.sensorId, to);
      }
    }

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
    await first.pool.stop();

    // A restart in the middle of it: nothing kept.
    const restartedClock = { now: 0 };
    const second = await probe(zones, restartedClock);
    const restartedAt = at;
    for (let round = 0; round < 2; round += 1, at += INTERVAL_MS) {
      await scan(second, restartedClock, at);
    }

    // The answering zone: no state change at all.
    const answering = changes.filter(({ sensorId }) => zoneOf(deviceOf(sensorId)) === 'a');
    assert.deepEqual(answering, [], 'zone A never changed state');

    // The silent zone: Up on its kept answers until five minutes past their expiry, then Warning
    // and Down, once each, and no change across the restart.
    const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
    const silentSensors = Array.from(
      { length: DEVICES * SENSORS_PER_DEVICE },
      (_, i) => i + 1,
    ).filter((sensorId) => zoneOf(deviceOf(sensorId)) === 'b');
    assert.equal(silentSensors.length, 4);
    for (const sensorId of silentSensors) {
      assert.deepEqual(
        changes.filter((change) => change.sensorId === sensorId),
        [
          { sensorId, at: firstFailing, from: 'up', to: 'warning' },
          { sensorId, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
        ],
        `sensor ${String(sensorId)}`,
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
      writeFileSync(hostsFile, '127.0.0.1 localhost\n');
      writeFileSync(resolvConf, 'nameserver 192.0.2.53\n');
      const devices = 100;
      const fixed = 0;
      const zones = { bSilent: false, hangMs: HANG_MS, hosts: new Map<string, string>() };
      const clock = { now: 0 };
      const running = await probe(zones, clock, [hostsFile, resolvConf], 8);
      assert.equal(await running.resolver.checkFiles(), false, 'the baseline');
      const { scanAt, changes, states } = scanner(running, clock, devices);

      await scanAt(0, [RARE]);
      zones.bSilent = true;
      for (let at = INTERVAL_MS; at <= 3 * INTERVAL_MS; at += INTERVAL_MS) await scanAt(at);
      // The operator's fix for one silent device: its address in the hosts file.
      zones.hosts.set(hostOf(fixed), '192.0.2.200');
      writeFileSync(hostsFile, `127.0.0.1 localhost\n192.0.2.200 ${hostOf(fixed)}\n`);
      assert.equal(await running.resolver.checkFiles(), true, 'the edit seen');
      await scanAt(4 * INTERVAL_MS);
      // And later resolv.conf rewritten with a second server, as a DHCP lease can.
      writeFileSync(resolvConf, 'nameserver 192.0.2.53\nnameserver 192.0.2.54\n');
      assert.equal(await running.resolver.checkFiles(), true, 'the rewrite seen');
      const graceEnds = ANSWER_MS + STALE_MS;
      for (let at = 5 * INTERVAL_MS; at <= graceEnds + 2 * INTERVAL_MS; at += INTERVAL_MS) {
        // RARE's answer, from 0 s, has run out by 360 s: asked for the first time again.
        await scanAt(at, at === 6 * INTERVAL_MS ? [RARE] : []);
      }

      const answering = changes.filter(
        ({ sensorId }) => sensorId === RARE.sensorId || zoneOf(sensorId - 1) === 'a',
      );
      assert.deepEqual(answering, [], 'zone A never changed state');
      assert.equal(states.get(RARE.sensorId), 'up', 'the sensor asked for the first time again');
      assert.deepEqual(
        changes.filter(({ sensorId }) => sensorId - 1 === fixed),
        [],
        'the device the hosts file now gives never changed state either',
      );
      const firstFailing = Math.ceil(graceEnds / INTERVAL_MS) * INTERVAL_MS;
      const stillSilent = Array.from({ length: devices }, (_, device) => device).filter(
        (device) => zoneOf(device) === 'b' && device !== fixed,
      );
      assert.equal(stillSilent.length, 9);
      for (const device of stillSilent) {
        assert.deepEqual(
          changes.filter(({ sensorId }) => sensorId - 1 === device),
          [
            { sensorId: device + 1, at: firstFailing, from: 'up', to: 'warning' },
            { sensorId: device + 1, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
          ],
          `device ${String(device)}: Up on its kept answer through both edits, then Down once`,
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
    const { scanAt, changes, states, results } = scanner(running, clock, devices);

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
      'asked at each of its three scans, and answered',
    );
    assert.equal(states.get(RARE.sensorId), 'up');
    const answering = changes.filter(
      ({ sensorId }) => sensorId === RARE.sensorId || zoneOf(sensorId - 1) === 'a',
    );
    assert.deepEqual(answering, [], 'zone A never changed state');
    const silentDevices = Array.from({ length: devices }, (_, device) => device).filter(
      (device) => zoneOf(device) === 'b',
    );
    assert.equal(silentDevices.length, 10);
    for (const device of silentDevices) {
      assert.deepEqual(
        changes.filter(({ sensorId }) => sensorId - 1 === device),
        [
          { sensorId: device + 1, at: firstFailing, from: 'up', to: 'warning' },
          { sensorId: device + 1, at: firstFailing + INTERVAL_MS, from: 'warning', to: 'down' },
        ],
        `device ${String(device)}: Up on its kept answer, then Down once`,
      );
    }
  });
});

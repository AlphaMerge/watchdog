import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { DnsSimulator, replies } from '@ms/simulators';
import type { ResolvedAddress } from '@ms/sensors';
import { caresAsker } from '../src/resolver/dns-check.js';
import { buildNameResolution, olderCoreWarning } from '../src/resolver/name-resolution.js';
import type { SystemFiles } from '../src/resolver/system-names.js';
import { pollWithin, within } from './support/within.js';

/**
 * `probe.nameResolver` as `main.ts` builds it (`P-432` S3, §1.2): in `system` mode nothing of the
 * gate is built, read or forked (N9); in gate mode the policy loads from the resolver's first look,
 * the helper starts on its snapshot before the pool, a local name runs on the probe's lanes and
 * every other in the helper's child, and stop takes the child down.
 */

const CHILD = join(import.meta.dirname, 'support', 'scripted-helper-child.js');
const WAIT = 30_000;
const dir = mkdtempSync(join(tmpdir(), 'ms-name-resolution-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PROBE_LANES: readonly ResolvedAddress[] = [{ address: '192.0.2.99', family: 4 }];

function logged() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

describe('probe.nameResolver as main.ts builds it (P-432 S3)', () => {
  it('N9: system builds nothing of the gate: no policy reads a file and no child is forked', async () => {
    const { logger } = logged();
    let forked = 0;
    let read = 0;
    const asked: string[] = [];
    const spoolDir = mkdtempSync(join(dir, 'system-'));
    const names = buildNameResolution({
      mode: 'system',
      logger,
      lanes: 6,
      spoolDir,
      helper: {
        fork: () => {
          forked += 1;
          throw new Error('system mode forks nothing');
        },
      },
      policy: {
        readText: () => {
          read += 1;
          return Promise.resolve(null);
        },
      },
      resolver: {
        lookup: (host) => {
          asked.push(host);
          return Promise.resolve(PROBE_LANES);
        },
        watch: { files: [], everyMs: 60_000 },
      },
    });
    assert.equal(names.gate, undefined);
    await names.start();
    assert.deepEqual(await names.resolver.resolve('dev-1.zone-a.test', 4, {}), PROBE_LANES);
    assert.deepEqual(asked, ['dev-1.zone-a.test'], 'on the probe’s own lanes');
    assert.equal(names.resolver.gateHealth(), undefined);
    assert.equal(names.resolver.takeQuestionsPeak(), undefined);
    assert.equal(names.modeValue(), 1);
    assert.deepEqual(names.health(), { mode: 1, notAnswering: [] }, 'no gate fields to send');
    assert.equal(names.questionsPeak, undefined);
    await names.stop();
    assert.equal(forked, 0);
    assert.equal(read, 0);
  });

  it('gate: the policy loads from the first look, the helper starts on its snapshot, and each name runs where it is routed', async () => {
    const { logger, lines } = logged();
    const base = mkdtempSync(join(dir, 'gate-'));
    const files: SystemFiles = {
      hosts: join(base, 'hosts'),
      resolvConf: join(base, 'resolv.conf'),
      nsswitchConf: join(base, 'nsswitch.conf'),
      gaiConf: join(base, 'gai.conf'),
      ldSoPreload: join(base, 'ld.so.preload'),
      nscdSocket: join(base, 'nscd.socket'),
    };
    writeFileSync(files.hosts, '127.0.0.1 localhost\n192.0.2.7 gw.test\n');
    writeFileSync(files.resolvConf, 'nameserver 192.0.2.53\n');
    writeFileSync(files.nsswitchConf, 'hosts: files dns\n');
    const asked: string[] = [];
    const names = buildNameResolution({
      mode: 'gate',
      logger,
      lanes: 6,
      spoolDir: base,
      helper: { childModule: CHILD },
      // The check not built, as S3 had it: every name not the hosts file's goes to the helper.
      policy: { files, platform: 'linux', env: {}, checkBuilt: false },
      resolver: {
        lookup: (host) => {
          asked.push(host);
          return Promise.resolve(PROBE_LANES);
        },
        watch: {
          files: [
            files.hosts,
            files.resolvConf,
            files.nsswitchConf,
            files.gaiConf,
            files.ldSoPreload,
          ],
          everyMs: 60_000,
        },
      },
    });
    const gate = names.gate;
    assert.ok(gate !== undefined);
    try {
      await within(WAIT, 'the start', names.start());
      assert.equal(gate.helper.state, 'up', 'up before the pool starts');
      assert.equal(names.modeValue(), 2);
      assert.equal(gate.latch.value(), 0);
      const described = lines.find((line) =>
        String(line['msg']).startsWith('probe.nameResolver is gate'),
      );
      assert.ok(described !== undefined, 'the policy is described at start');
      // Found by its component, as the runbook's drill and the administration guide find it.
      assert.equal(described['component'], 'name-resolver');
      assert.deepEqual(described['hostsLine'], 'files dns');
      // `gw.test` is the hosts file's: glibc answers it without the network, on the probe's lanes.
      assert.deepEqual(await names.resolver.resolve('gw.test', 4, {}), PROBE_LANES);
      assert.deepEqual(asked, ['gw.test']);
      // Anything else is asked in the helper's child, which the script answers.
      const far = await within(
        WAIT,
        'the helper’s answer',
        names.resolver.resolve('delay-5.ok.test', 4, {}),
      );
      assert.deepEqual(far, [{ address: '192.0.2.1', family: 4 }]);
      assert.deepEqual(asked, ['gw.test'], 'never on the probe’s lanes');
      assert.equal(names.resolver.gateHealth()?.mode, 2);
      const health = names.health();
      assert.equal(health.mode, 2);
      assert.equal(health.gate?.trouble, 0);
      assert.deepEqual(health.notAnswering, []);
      assert.ok(names.questionsPeak !== undefined);
      assert.ok(names.questionsPeak.peek() >= 1, 'the helper’s lookup held a question');
      assert.ok(names.questionsPeak.take() >= 1);
      assert.equal(names.questionsPeak.take(), 0, 'nothing open since');
    } finally {
      await within(WAIT, 'the stop', names.stop());
    }
    assert.equal(gate.helper.state, 'stopped');
    assert.equal(gate.helper.pid(), undefined, 'the child is gone');
  });
});

describe('probe.nameResolver gate with its name check built (P-432 S6)', () => {
  it('asks DNS with c-ares first: a name its server answers runs on the probe’s lanes, one it does not in the helper, and the resolver counts each', async (t) => {
    const sim = await DnsSimulator.start({
      zones: {
        'zone-a.test': { reply: replies.addresses('192.0.2.10') },
        'ok.test': { reply: replies.silent },
      },
      ipv6: false,
    });
    t.after(() => sim.stop());
    const { port, ipv4 } = sim.server();
    const { logger } = logged();
    const base = mkdtempSync(join(dir, 'check-'));
    const files: SystemFiles = {
      hosts: join(base, 'hosts'),
      resolvConf: join(base, 'resolv.conf'),
      nsswitchConf: join(base, 'nsswitch.conf'),
      gaiConf: join(base, 'gai.conf'),
      ldSoPreload: join(base, 'ld.so.preload'),
      nscdSocket: join(base, 'nscd.socket'),
    };
    writeFileSync(files.hosts, '127.0.0.1 localhost\n');
    writeFileSync(files.resolvConf, `nameserver ${ipv4}\n`);
    writeFileSync(files.nsswitchConf, 'hosts: files dns\n');
    const asked: string[] = [];
    const names = buildNameResolution({
      mode: 'gate',
      logger,
      lanes: 6,
      spoolDir: base,
      helper: { childModule: CHILD },
      policy: { files, platform: 'linux', env: {} },
      check: { asker: caresAsker({ port }) },
      resolver: {
        lookup: (host) => {
          asked.push(host);
          return Promise.resolve(PROBE_LANES);
        },
        watch: { files: [files.hosts, files.resolvConf, files.nsswitchConf], everyMs: 60_000 },
      },
    });
    try {
      await within(WAIT, 'the start', names.start());
      await pollWithin(
        WAIT,
        'the canary answered',
        () => names.resolver.gateHealth()?.checkState === 1,
        5,
      );
      assert.deepEqual(
        await within(WAIT, 'the heard name', names.resolver.resolve('dev-1.zone-a.test', 4, {})),
        PROBE_LANES,
        'getaddrinfo on the probe’s lanes',
      );
      assert.deepEqual(
        await within(WAIT, 'the silent name', names.resolver.resolve('delay-5.ok.test', 4, {})),
        [{ address: '192.0.2.1', family: 4 }],
        'the helper’s child’s answer',
      );
      assert.deepEqual(asked, ['dev-1.zone-a.test'], 'the silent name never on the probe’s lanes');
      const counted = names.resolver.gateHealth();
      assert.ok(counted !== undefined);
      assert.equal(counted.checkState, 1);
      assert.equal(counted.lookupsHeard, 1);
      assert.equal(counted.lookupsToHelper, 1);
      // Probe Health is sent the latch and three counts of the gate, and none of the eight S6
      // built (OPEN-5, `P-467`): those are the log's.
      const said = names.health().gate;
      assert.ok(said !== undefined);
      assert.deepEqual(Object.keys(said).sort(), [
        'checkOnSeconds',
        'helperStuck',
        'passedStuck',
        'trouble',
      ]);
      assert.equal(said.trouble, 0);
      const log = await sim.log();
      assert.deepEqual(
        log.filter((entry) => !entry.qname.startsWith('localhost')).map((entry) => entry.qname),
        ['dev-1.zone-a.test', 'delay-5.ok.test'],
        'each name walked once, on port 53’s stand-in',
      );
    } finally {
      await within(WAIT, 'the stop', names.stop());
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('a gate probe meeting a core below protocol 38 (P-432, S-F11)', () => {
  it('warns once a session that the helper’s health does not reach it, and never in system mode', () => {
    const { logger, lines } = logged();
    const warned = (): string[] =>
      lines.filter((line) => line['level'] === 40).map((line) => String(line['msg']));
    const gate = olderCoreWarning(logger, 'gate');
    gate.heartbeat(37);
    gate.heartbeat(37);
    assert.deepEqual(warned(), [
      'this core is older than protocol 38: the lookup helper’s health does not reach it',
    ]);
    // Under the resolver's component, so that step 4's warnings of the gate include it.
    assert.equal(lines.find((line) => line['level'] === 40)?.['component'], 'name-resolver');
    gate.disconnected();
    gate.heartbeat(37);
    assert.equal(warned().length, 2, 'the next session says it again');
    gate.disconnected();
    gate.heartbeat(38);
    assert.equal(warned().length, 2, 'a core at 38 is told');
    olderCoreWarning(logger, 'system').heartbeat(30);
    assert.equal(warned().length, 2, 'system mode has no helper to report');
  });
});

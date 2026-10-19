import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { ResolvedAddress } from '@ms/sensors';
import { buildNameResolution } from '../src/resolver/name-resolution.js';
import type { SystemFiles } from '../src/resolver/system-names.js';
import { within } from './support/within.js';

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
      policy: { files, platform: 'linux', env: {} },
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
    } finally {
      await within(WAIT, 'the stop', names.stop());
    }
    assert.equal(gate.helper.state, 'stopped');
    assert.equal(gate.helper.pid(), undefined, 'the child is gone');
  });
});

import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION, type ProbeHealthReport } from '@ms/shared';
import { HELPER_TITLE } from '../src/resolver/lookup-helper-child.js';
import {
  FakeCore,
  generateCerts,
  opensslAvailable,
  startProbe,
  type RunningProbe,
} from './support/probe-process.js';
import { pollWithin } from './support/within.js';

/**
 * `probe.nameResolver` in the probe as a service manager runs it (`P-432` S3, the end to end):
 * in gate mode the probe starts one lookup helper child, `ms-probe: lookups`, before it reports,
 * and the child is gone after the probe stops: within 500 ms of its exit after SIGTERM, its
 * shutdown having stopped it, and within 1 s after SIGKILL (§7.4). In `system` mode there is none. The heartbeat says which mode ran, and
 * a gate probe meeting a core below 38 says that core cannot be told its helper's health.
 */

const WAIT = 30_000;
const onLinux = process.platform === 'linux';
const skip = !opensslAvailable
  ? 'openssl is not on PATH'
  : !onLinux
    ? 'reads the process table from /proc'
    : false;

/** The probe's children that carry the lookup helper's title, from /proc. */
function helpersOf(pid: number | undefined): number[] {
  if (pid === undefined) return [];
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid !== pid) continue;
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (cmdline.startsWith(HELPER_TITLE)) found.push(Number(name));
    } catch {
      // Gone between the listing and the read.
    }
  }
  return found;
}

/** A process that has exited and been reaped, or exited and not reaped: never one running. */
function dead(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === 'Z' || state === 'X';
  } catch {
    return true;
  }
}

describe('probe.nameResolver in the probe as a service manager runs it (P-432 S3)', () => {
  let dir = '';
  let core: FakeCore | undefined;
  let corePort = 0;
  const running: RunningProbe[] = [];
  before(async () => {
    if (skip !== false) return;
    dir = mkdtempSync(join(tmpdir(), 'ms-probe-names-'));
    generateCerts(dir);
    ({ core, port: corePort } = await FakeCore.start(dir, []));
  });
  after(async () => {
    for (const probe of running) await probe.stop().catch(() => undefined);
    await core?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  const start = (nameResolver: 'system' | 'gate' | undefined): RunningProbe => {
    const probe = startProbe({
      dir,
      corePort,
      // The name check off for the environment, whatever the container's resolver is: an end to
      // end with no live DNS. `RES_OPTIONS` is the policy's rule 3, and asks glibc nothing new.
      env: { RES_OPTIONS: 'ndots:1' },
      config: {
        probe: {
          displayName: 'probe under test',
          spoolDir: join(dir, `spool-${String(process.hrtime.bigint())}`),
          workerPoolSize: 2,
          workerPoolMinSize: 1,
          ...(nameResolver === undefined ? {} : { nameResolver }),
        },
      },
    });
    running.push(probe);
    return probe;
  };

  const heartbeat = (from: number, pick: (health: ProbeHealthReport) => boolean) => {
    assert.ok(core !== undefined);
    return core.waitFor(
      'a heartbeat',
      (message) =>
        message.type === 'heartbeat' && message.health !== undefined && pick(message.health)
          ? message.health
          : undefined,
      { from },
    );
  };

  it(
    'gate: starts one lookup helper before it reports, and it is gone after SIGTERM',
    { skip },
    async () => {
      assert.ok(core !== undefined);
      core.protocolVersion = PROTOCOL_VERSION;
      const from = core.received.length;
      const probe = start('gate');
      const health = await heartbeat(from, (one) => one.nameResolverMode !== undefined);
      assert.equal(health.nameResolverMode, 2);
      assert.equal(health.lookupHelperTrouble, 0);
      assert.deepEqual(health.lookupsNotAnswering, []);
      const helpers = helpersOf(probe.pid);
      assert.equal(helpers.length, 1, `one ${HELPER_TITLE} child of the probe`);
      const [helper] = helpers;
      assert.ok(helper !== undefined);
      // The check is built (S6): off at start for this environment's `RES_OPTIONS`, so the reason
      // is the system's and not the build's, and no time on.
      const said = probe
        .logs()
        .find((line) => String(line['msg']).startsWith('probe.nameResolver is gate'));
      assert.equal(said?.['check'], 'off');
      assert.equal((said['off'] as { code?: unknown } | undefined)?.code, 'env');
      const later = await heartbeat(from, (one) => (one.uptimeSeconds ?? 0) >= 3);
      assert.equal(later.nameCheckOnSeconds, 0, 'the helper up 3 s, the check off throughout');
      // Six name fields at protocol 38 (OPEN-5, `P-467`): what S6's eight carried is the log's.
      assert.deepEqual(
        Object.keys(later)
          .filter((key) => /^(name|lookupHelper)/u.test(key))
          .sort(),
        [
          'lookupHelperTrouble',
          'nameCheckOnSeconds',
          'nameHelperStuck',
          'namePassedStuck',
          'nameQuestionsOpen',
          'nameResolverMode',
        ],
      );
      assert.equal(await probe.stop(), 0);
      // The shutdown stopped the names: the resolver, then the helper and the answer file, which
      // says so as it saves. A child never stopped would still die by its own backstop.
      assert.ok(
        probe
          .logs()
          .some(
            (line) =>
              line['msg'] === 'the probe’s resolver saved the answers it keeps' &&
              line['when'] === 'stop',
          ),
        'the shutdown stopped the names',
      );
      // The design's bound (§7.4): gone within 500 ms of the probe's exit.
      await pollWithin(500, 'the helper gone within 500 ms of the probe', () => dead(helper), 10);
      assert.equal(core.refused.length, 0, core.refused.join('\n'));
    },
  );

  it('gate: the helper is gone after the probe is killed with SIGKILL', { skip }, async () => {
    assert.ok(core !== undefined);
    const from = core.received.length;
    const probe = start('gate');
    await heartbeat(from, (one) => one.nameResolverMode === 2);
    const [helper] = helpersOf(probe.pid);
    assert.ok(helper !== undefined, 'a helper to outlive');
    probe.signal('SIGKILL');
    await probe.exited;
    // The child's own backstop: it kills itself when its channel to the probe closes, within the
    // design's 1 s (§7.4).
    await pollWithin(1_000, 'the helper gone within 1 s of its parent', () => dead(helper), 10);
  });

  it(
    'system, the default: no helper child, and only the mode of the gate’s fields',
    { skip },
    async () => {
      assert.ok(core !== undefined);
      const from = core.received.length;
      const probe = start(undefined);
      const health = await heartbeat(from, (one) => one.nameResolverMode !== undefined);
      assert.equal(health.nameResolverMode, 1);
      for (const field of [
        'lookupHelperTrouble',
        'nameCheckOnSeconds',
        'namePassedStuck',
        'nameHelperStuck',
        'nameQuestionsOpen',
      ]) {
        assert.equal(field in health, false, `${field} in system mode`);
      }
      assert.deepEqual(helpersOf(probe.pid), []);
      assert.equal(
        probe.logs().some((line) => String(line['msg']).startsWith('probe.nameResolver is gate')),
        false,
      );
      assert.equal(await probe.stop(), 0);
    },
  );

  it(
    'gate with a core below 38: says the helper’s health does not reach it, and sends none',
    { skip },
    async () => {
      assert.ok(core !== undefined);
      core.protocolVersion = 37;
      try {
        const from = core.received.length;
        const probe = start('gate');
        const health = await heartbeat(from, (one) => one.answersLoaded !== undefined);
        assert.equal('nameResolverMode' in health, false, 'stripped for a core at 37');
        // The service's logger writes the level by its name.
        await pollWithin(WAIT, 'the warning', () =>
          probe
            .logs()
            .some(
              (line) =>
                line['level'] === 'warn' &&
                line['msg'] ===
                  'this core is older than protocol 38: the lookup helper’s health does not reach it',
            ),
        );
        assert.equal(await probe.stop(), 0);
      } finally {
        core.protocolVersion = PROTOCOL_VERSION;
      }
    },
  );
});

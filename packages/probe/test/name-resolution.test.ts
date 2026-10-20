import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { DnsSimulator, replies } from '@ms/simulators';
import type { ResolvedAddress } from '@ms/sensors';
import { caresAsker } from '../src/resolver/dns-check.js';
import { buildNameResolution, olderCoreWarning } from '../src/resolver/name-resolution.js';
import { GATE_SUMMARY_MS } from '../src/resolver/name-resolver.js';
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

/**
 * The field-test runbook tells a start of `ms-probe` that ended without saying its counts by its
 * start line, not by its last summary (`P-463` fix round 3). Fix round 2 keyed the rule on a
 * start's last summary, so a start killed or crashed before its first hourly summary, which has a
 * start line and no summary, was never named, and the checks it failed at once and the quiets it
 * saw dropped out of the week unsaid. The rule also excepts the start still running at the end
 * reading, which has no `stopping` summary because it has not stopped.
 *
 * The runbook's command and rule are applied here to the lines `buildNameResolution` logs, as
 * journald holds them: four starts in a row, one stopped after an hour, one killed before its
 * first summary, one killed after it, and one running at the end reading.
 */
describe('the field-test runbook’s ends that said nothing (P-463 fix round 3)', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  /** What step 4 says of the gate's summary, from its heading to the next criterion. */
  async function section(): Promise<string> {
    const runbook = await readFile(join(repoRoot, 'docs', 'runbook-field-test.md'), 'utf8');
    const start = runbook.indexOf("- **What a quiet helper cost is in the gate's summary**");
    const end = runbook.indexOf('- `namePassedStuck`', start);
    assert.ok(start >= 0 && end > start, 'step 4 has no criterion for the gate’s summary');
    return runbook.slice(start, end);
  }

  /** One start of the probe in gate mode: its raw log lines up to its end. */
  async function life(hours: number, end: 'stopped' | 'killed' | 'running'): Promise<string[]> {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(line.trimEnd());
        },
      },
    );
    const base = mkdtempSync(join(dir, 'life-'));
    const files: SystemFiles = {
      hosts: join(base, 'hosts'),
      resolvConf: join(base, 'resolv.conf'),
      nsswitchConf: join(base, 'nsswitch.conf'),
      gaiConf: join(base, 'gai.conf'),
      ldSoPreload: join(base, 'ld.so.preload'),
      nscdSocket: join(base, 'nscd.socket'),
    };
    writeFileSync(files.hosts, '127.0.0.1 localhost\n');
    writeFileSync(files.resolvConf, 'nameserver 192.0.2.53\n');
    writeFileSync(files.nsswitchConf, 'hosts: files dns\n');
    const clock = { now: 0 };
    const names = buildNameResolution({
      mode: 'gate',
      logger,
      lanes: 6,
      spoolDir: base,
      helper: { childModule: CHILD },
      policy: { files, platform: 'linux', env: {}, checkBuilt: false },
      resolver: {
        lookup: () => Promise.resolve(PROBE_LANES),
        now: () => clock.now,
        watch: { files: [files.hosts, files.resolvConf, files.nsswitchConf], everyMs: 60_000 },
      },
    });
    const summaries = (): number =>
      lines.filter((line) => line.includes('the probe’s resolver in gate mode, this hour')).length;
    let ended = 0;
    try {
      await within(WAIT, 'the start', names.start());
      for (let hour = 1; hour <= hours; hour += 1) {
        clock.now += GATE_SUMMARY_MS;
        await pollWithin(WAIT, `the summary of hour ${String(hour)}`, () => summaries() === hour);
      }
      ended = lines.length;
    } finally {
      await within(WAIT, 'the stop', names.stop());
      rmSync(base, { recursive: true, force: true });
    }
    // A probe killed, or one still running, logs nothing after that moment.
    return end === 'stopped' ? lines : lines.slice(0, ended);
  }

  it('names a start killed before its first summary, and not the one running at the end reading', async () => {
    const text = await section();
    const flat = text.replace(/\s+/g, ' ');

    // The rule, keyed on the start line.
    const startLine = /A start is its `([^`]+)` line/.exec(flat)?.[1];
    assert.equal(startLine, 'probe.nameResolver is gate', 'what the runbook calls a start');
    assert.match(
      flat,
      /A start whose summaries do not end with a `stopping` one, none at all included, ended without stopping/,
      'the rule for an end that said nothing does not cover a start with no summary',
    );
    assert.match(flat, /since its start line if it said none/, 'what such a start leaves unsaid');
    assert.match(
      flat,
      /The start running at the end reading is not an end/,
      'the rule names the start still running at the end reading',
    );
    assert.ok(
      !flat.includes('A start whose last summary has no `stopping`'),
      'fix round 2’s rule, which keys on a last summary a start may never have said',
    );

    // The command that lists the starts and summaries, in order.
    const block = /```bash\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
    assert.match(
      block,
      /journalctl -u ms-probe /,
      'the starts and summaries come from the journal',
    );
    assert.match(block, /grep -F /, 'patterns read as fixed strings, as `includes` reads them');
    const patterns = [...block.matchAll(/-e '([^']+)'/g)].map((match) => match[1] ?? '');
    assert.ok(patterns.includes(startLine), 'the command lists the start lines');
    const grep = (line: string): boolean => patterns.some((pattern) => line.includes(pattern));

    // Four starts as journald holds them, the last still running at the end reading.
    const journal = [
      ...(await life(1, 'stopped')),
      ...(await life(0, 'killed')),
      ...(await life(1, 'killed')),
      ...(await life(1, 'running')),
    ];
    const listed = journal.filter(grep).map((line) => JSON.parse(line) as Record<string, unknown>);

    // Step 1 quotes the start line the probe logs.
    const said = listed.filter((line) => String(line['msg']).startsWith(startLine));
    assert.equal(said.length, 4, 'one start line for each start');
    const runbook = (
      await readFile(join(repoRoot, 'docs', 'runbook-field-test.md'), 'utf8')
    ).replace(/\s+/g, ' ');
    assert.ok(runbook.includes(`*${String(said[0]?.['msg'])}*`), 'step 1 quotes the start line');

    // Each summary is the start's above it.
    const starts: Record<string, unknown>[][] = [];
    for (const line of listed) {
      if (String(line['msg']).startsWith(startLine)) starts.push([]);
      else starts.at(-1)?.push(line);
    }
    assert.deepEqual(
      starts.map((summaries) => summaries.length),
      [2, 0, 1, 1],
      'the hour’s summary and the stop’s; none; one; one',
    );
    const unsaid = starts
      .map((summaries, at) => ({ summaries, at }))
      .filter(
        ({ summaries, at }) => at < starts.length - 1 && summaries.at(-1)?.['stopping'] !== true,
      )
      .map(({ at }) => at);
    assert.deepEqual(unsaid, [1, 2], 'the two starts killed, the one with no summary included');
  });

  /**
   * The two counts the rule leaves out, named so the write-up says them (`P-463` round 3's review,
   * items 9 and 10, fixed at the `integ/r7-1020` integration). The start running at the end reading
   * is excepted from the ends, so its time from its last summary to the end reading, up to an hour
   * on every probe, was in no sum and named nowhere. And a not-answering line's `alsoNotAnswering`
   * counts the quiets held back since the line before, up to a minute, so the first line after a
   * summary can count quiets that summary's `quiets` already holds.
   */
  it('names the running start’s time since its last summary, and the quiets a first line can count twice', async () => {
    const flat = (await section()).replace(/\s+/g, ' ');
    assert.match(
      flat,
      /Its time from its last summary before the end reading to the end reading, up to an hour on every probe, is in no sum either: the write-up names it as uncounted/,
      'the running start’s tail is in no sum and not named',
    );
    assert.match(
      flat,
      /on the first line after a start's last summary it can include quiets held back in the minute after the line said before that summary, which that summary's `quiets` holds already if they came before it/,
      'a first line’s alsoNotAnswering can count quiets the summary holds',
    );
    assert.match(
      flat,
      /quiets held back after the last line are on no line/,
      'quiets held back after the last line are on none',
    );
  });
});

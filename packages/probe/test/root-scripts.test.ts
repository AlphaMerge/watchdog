import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProbeConfig } from '@ms/shared';
import { dispatchTables, probeCatalogue } from '../src/catalogue.js';
import { buildFindings } from '../src/config-problems.js';
import { rootScripts, rootScriptsNote, type RootScripts } from '../src/root-scripts.js';
import {
  FakeCore,
  generateCerts,
  opensslAvailable,
  startProbe,
  within,
  type RunningProbe,
} from './support/probe-process.js';

/**
 * A probe that runs as root and would run its scripts as root (`P-276`).
 *
 * `P-266`'s checks before it ends a dead check's script groups compare against the user checks run
 * as, which without `processUid` is the probe's own: as root, every root process on the host. The
 * table is the rule; the verb is what a person running `config check` reads; the last cases start
 * `dist/src/main.js` as the development container runs it, as root, and are skipped elsewhere.
 */

/** At runtime this file is `dist/test/root-scripts.test.js`. */
const MAIN = join(import.meta.dirname, '..', 'src', 'main.js');

type Settings = Pick<ProbeConfig['probe'], 'processUid' | 'scriptDir' | 'allowScriptsAsRoot'>;
const settings = (over: Partial<Settings> = {}): Settings => ({
  processUid: 0,
  scriptDir: '/srv/scripts',
  allowScriptsAsRoot: false,
  ...over,
});

const messageOf = (verdict: RootScripts): string => ('message' in verdict ? verdict.message : '');

describe('a probe whose scripts would run as root (`P-276`)', () => {
  describe('the rule', () => {
    const cases: readonly {
      name: string;
      probe: Settings;
      euid: number | undefined;
      kind: RootScripts['kind'];
    }[] = [
      { name: 'root, scripts, no processUid', probe: settings(), euid: 0, kind: 'refused' },
      {
        name: 'root, scripts, a processUid',
        probe: settings({ processUid: 998 }),
        euid: 0,
        kind: 'fine',
      },
      {
        name: 'root, scripts, a processUid and the opt-out',
        probe: settings({ processUid: 998, allowScriptsAsRoot: true }),
        euid: 0,
        kind: 'fine',
      },
      {
        name: 'root, scripts, the opt-out',
        probe: settings({ allowScriptsAsRoot: true }),
        euid: 0,
        kind: 'allowed',
      },
      {
        name: 'root, no scripts',
        probe: settings({ scriptDir: '' }),
        euid: 0,
        kind: 'no-scripts',
      },
      { name: 'not root, scripts', probe: settings(), euid: 998, kind: 'fine' },
      {
        name: 'not root, scripts, the opt-out',
        probe: settings({ allowScriptsAsRoot: true }),
        euid: 998,
        kind: 'fine',
      },
      // Windows: no `process.geteuid`, `processUid` ignored, the account is WinSW's.
      { name: 'no POSIX user at all', probe: settings(), euid: undefined, kind: 'fine' },
    ];
    for (const one of cases) {
      it(`${one.name}: ${one.kind}`, () => {
        assert.equal(rootScripts(one.probe, one.euid).kind, one.kind);
      });
    }

    it('names the setting, the directory, the fix and the opt-out when it refuses', () => {
      const verdict = rootScripts(settings(), 0);
      assert.equal(verdict.kind, 'refused');
      const message = messageOf(verdict);
      // The setting first, the way the loader names one.
      assert.match(message, /^probe\.processUid: is not set, and this probe runs as root/);
      assert.match(message, /\(probe\.scriptDir: \/srv\/scripts\)/);
      assert.match(message, /set probe\.processUid \(and probe\.processGid\)/);
      assert.match(message, /probe\.allowScriptsAsRoot: true/);
    });

    it('says what the opt-out costs, at every start', () => {
      const verdict = rootScripts(settings({ allowScriptsAsRoot: true }), 0);
      assert.equal(verdict.kind, 'allowed');
      const message = messageOf(verdict);
      assert.match(
        message,
        /^probe\.allowScriptsAsRoot: is true, so every script in \/srv\/scripts runs as root/,
      );
    });
  });

  describe('what `config check` says', () => {
    const v1 = dispatchTables(probeCatalogue('v1')).listenerFor;
    const findings = (probe: Settings): ReturnType<typeof buildFindings> =>
      buildFindings(
        {
          flowListener: {
            enabled: false,
            port: 2055,
            address: '0.0.0.0',
            ipVersion: 'udp4',
            exporters: [],
            bufferSize: 20_000,
          },
          probe,
        },
        v1,
        'v1',
      );

    it('notes the refusal, and never as a problem or a warning the installer would show', () => {
      const { notes = [], warnings = [], problems = [] } = findings(settings());
      assert.equal(notes.length, 1);
      assert.match(
        notes[0] ?? '',
        /^started as root, this probe would refuse to start: probe\.processUid/,
      );
      assert.match(notes[0] ?? '', /The packaged ms-probe\.service runs it as ms-probe/);
      assert.deepEqual(warnings, []);
      assert.deepEqual(problems, []);
    });

    it('notes nothing on Windows, where there is no root to start as', () => {
      assert.equal(rootScriptsNote(settings(), 'win32'), undefined);
      assert.notEqual(rootScriptsNote(settings(), 'linux'), undefined);
    });

    it('notes nothing where root would start it', () => {
      for (const probe of [
        settings({ processUid: 998 }),
        settings({ allowScriptsAsRoot: true }),
        settings({ scriptDir: '' }),
      ]) {
        assert.equal(rootScriptsNote(probe), undefined);
        assert.deepEqual(findings(probe).notes ?? [], []);
      }
    });

    describe('through the verb', () => {
      let dir: string;
      before(() => {
        dir = mkdtempSync(join(tmpdir(), 'ms-probe-root-check-'));
      });
      after(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      const check = (
        probe: Record<string, unknown>,
      ): { status: number | null; stdout: string; stderr: string } => {
        const file = join(dir, `probe-${String(process.hrtime.bigint())}.json`);
        writeFileSync(file, JSON.stringify({ probe }), 'utf8');
        const env: NodeJS.ProcessEnv = {};
        for (const [name, value] of Object.entries(process.env)) {
          if (!name.startsWith('MS_')) env[name] = value;
        }
        const run = spawnSync(process.execPath, [MAIN, 'config', 'check', '--config', file], {
          env,
          encoding: 'utf8',
          // Its own bound: a verb that fell through to the server would otherwise run for ever.
          timeout: 60_000,
        });
        return { status: run.status, stdout: run.stdout, stderr: run.stderr };
      };

      it(
        'passes, and says on stdout that root would refuse it, whoever runs the check',
        { timeout: 150_000 },
        () => {
          // `ms-setup` runs exactly this as root for a unit that runs the probe as ms-probe, so
          // the exit code and stderr, which it acts on and shows, must be untouched.
          const run = check({ scriptDir: dir });
          assert.equal(run.status, 0, run.stderr);
          assert.match(run.stdout, /configuration is valid for ms-probe/);
          assert.match(
            run.stdout,
            /^note: started as root, this probe would refuse to start: probe\.processUid: is not set/m,
          );
          assert.doesNotMatch(run.stderr, /processUid|warning/);
        },
      );

      it('says nothing of it with a processUid, or with the opt-out', { timeout: 150_000 }, () => {
        for (const probe of [
          { scriptDir: dir, processUid: 65_534 },
          { scriptDir: dir, allowScriptsAsRoot: true },
        ]) {
          const run = check(probe);
          assert.equal(run.status, 0, run.stderr);
          assert.match(run.stdout, /configuration is valid for ms-probe/);
          assert.doesNotMatch(run.stdout, /note:/);
        }
      });
    });
  });

  describe('a probe started as root', () => {
    const asRoot = process.geteuid?.() === 0;
    const skip = !asRoot
      ? 'needs root, as the development container runs the probe'
      : !opensslAvailable
        ? 'openssl is not on PATH'
        : false;

    let dir = '';
    let core: FakeCore | undefined;
    let corePort = 0;
    const running: RunningProbe[] = [];
    before(async () => {
      if (skip !== false) return;
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-root-'));
      generateCerts(dir);
      ({ core, port: corePort } = await FakeCore.start(dir, []));
    });
    after(async () => {
      for (const probe of running) await probe.stop().catch(() => undefined);
      await core?.stop();
      if (dir !== '') await rm(dir, { recursive: true, force: true });
    });

    const start = (probe: Record<string, unknown>): RunningProbe => {
      const one = startProbe({ dir, corePort, config: { probe: { ...base(), ...probe } } });
      running.push(one);
      return one;
    };
    // `startProbe` spreads `config` over its own sections, so the probe section is whole here.
    const base = (): Record<string, unknown> => ({
      displayName: 'probe under test',
      spoolDir: join(dir, `spool-${String(process.hrtime.bigint())}`),
      workerPoolSize: 2,
      workerPoolMinSize: 1,
    });

    /** The first log line the picker accepts, waited for with its own bound. */
    const line = async (
      probe: RunningProbe,
      what: string,
      pick: (one: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> => {
      // An object, so the loop reads what `finally` wrote rather than what it was when narrowed.
      const waiting = { over: false };
      try {
        return await within(
          60_000,
          what,
          (async () => {
            for (;;) {
              const found = probe.logs().find(pick);
              if (found !== undefined || waiting.over) return found ?? {};
              await delay(25);
            }
          })(),
        );
      } finally {
        waiting.over = true;
      }
    };
    const said = (pattern: RegExp) => (one: Record<string, unknown>) =>
      typeof one['msg'] === 'string' && pattern.test(one['msg']);

    it(
      'refuses with exit 78 and the reason, before it opens anything',
      { skip, timeout: 150_000 },
      async () => {
        const probe = start({ scriptDir: dir });
        const status = await within(60_000, 'the probe to refuse', probe.exited);
        const logs = probe.logs();
        assert.equal(status, 78, JSON.stringify(logs));
        assert.ok(
          logs.some(
            said(
              /^Configuration error: probe\.processUid: is not set, and this probe runs as root/,
            ),
          ),
          JSON.stringify(logs),
        );
        assert.ok(!logs.some(said(/^ready$/)), 'a refused probe said it was ready');
      },
    );

    it(
      'starts with the opt-out, and warns that its scripts run as root',
      { skip, timeout: 150_000 },
      async () => {
        const probe = start({ scriptDir: dir, allowScriptsAsRoot: true });
        const warned = await line(
          probe,
          'the warning',
          said(/^probe\.allowScriptsAsRoot: is true/),
        );
        assert.equal(warned['level'], 'warn');
        await line(probe, 'the probe to be ready', said(/^ready$/));
        assert.equal(await probe.stop(), 0);
      },
    );

    it(
      'starts with a processUid, and says nothing of root',
      { skip, timeout: 150_000 },
      async () => {
        const probe = start({ scriptDir: dir, processUid: 65_534, processGid: 65_534 });
        await line(probe, 'the probe to be ready', said(/^ready$/));
        const logs = probe.logs();
        assert.ok(!logs.some(said(/as root/)), JSON.stringify(logs));
        assert.equal(await probe.stop(), 0);
      },
    );

    it(
      'starts with no script directory, and says it runs as root',
      { skip, timeout: 150_000 },
      async () => {
        const probe = start({});
        const warned = await line(
          probe,
          'the warning',
          said(/^this probe runs as root\. It runs no scripts/),
        );
        assert.equal(warned['level'], 'warn');
        await line(probe, 'the probe to be ready', said(/^ready$/));
        assert.equal(await probe.stop(), 0);
      },
    );
  });
});

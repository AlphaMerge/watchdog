import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ProbeConfig } from '@ms/shared';
import { dispatchTables, probeCatalogue } from '../src/catalogue.js';
import { buildProblems, carriesFlow } from '../src/config-problems.js';

/**
 * `ms-probe config check` and a setting this build does nothing with (`B-08`).
 *
 * A v1 probe with `flowListener.enabled` set starts, warns once in its log and binds nothing
 * (`B-07`), and the operator learns it from a flow sensor's first failed scan. The check is what a
 * person runs, so the check says it. The last cases run `dist/src/main.js` itself: a finding that
 * was computed and never handed to the verb is the shape `B-07` was.
 */

/** At runtime this file is `dist/test/config-problems.test.js`. */
const MAIN = join(import.meta.dirname, '..', 'src', 'main.js');

const flow = (enabled: boolean): Pick<ProbeConfig, 'flowListener'> => ({
  flowListener: {
    enabled,
    port: 2055,
    address: '0.0.0.0',
    ipVersion: 'udp4',
    exporters: [],
    bufferSize: 20_000,
  },
});

describe('what a probe build cannot do with a valid configuration (`B-08`)', () => {
  const v1 = dispatchTables(probeCatalogue('v1')).listenerFor;
  const full = dispatchTables(probeCatalogue('full')).listenerFor;

  it('knows which builds carry a flow sensor type, from their own catalogues', () => {
    assert.equal(carriesFlow(full), true);
    assert.equal(carriesFlow(v1), false);
    // Not "any listener at all": a v1 probe does feed traps and syslog.
    assert.ok(v1.size > 0, 'the v1 profile maps no listener, so the case above proves nothing');
  });

  it('reports the flow collector switched on in a build that has none', () => {
    const problems = buildProblems(flow(true), v1, 'v1');
    assert.equal(problems.length, 1);
    // The setting first, the way the loader names one, so the two read as one list.
    assert.match(problems[0] ?? '', /^flowListener\.enabled: is true/);
    assert.match(problems[0] ?? '', /the v1 profile\) carries no flow sensor type/);
    assert.match(problems[0] ?? '', /open no flow port \(2055\)/);
  });

  it('says nothing where the setting does what it says, or is off', () => {
    assert.deepEqual(buildProblems(flow(true), full, 'full'), []);
    assert.deepEqual(buildProblems(flow(false), v1, 'v1'), []);
    assert.deepEqual(buildProblems(flow(false), full, 'full'), []);
  });

  describe('through the verb', () => {
    let dir: string;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-check-'));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const check = (
      config: Record<string, unknown>,
      profile: 'v1' | 'full',
    ): { status: number | null; stdout: string; stderr: string } => {
      const file = join(dir, `probe-${profile}-${String(process.hrtime.bigint())}.json`);
      writeFileSync(file, JSON.stringify(config), 'utf8');
      // The caller's environment without its `MS_*`: the container sets some, and this is a check
      // of the file.
      const env: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (!name.startsWith('MS_')) env[name] = value;
      }
      env['MS_BUILD_PROFILE'] = profile;
      const run = spawnSync(process.execPath, [MAIN, 'config', 'check', '--config', file], {
        env,
        encoding: 'utf8',
        // Its own bound: a verb that fell through to the server would otherwise run for ever.
        timeout: 60_000,
      });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    };

    it(
      'fails a v1 probe’s check on `flowListener.enabled`, naming it',
      { timeout: 150_000 },
      () => {
        const run = check({ flowListener: { enabled: true, port: 9995 } }, 'v1');
        assert.equal(run.status, 1, run.stderr);
        assert.match(
          run.stderr,
          /flowListener\.enabled: is true, and this build \(the v1 profile\)/,
        );
        assert.match(run.stderr, /\(9995\)/);
        assert.doesNotMatch(run.stdout, /configuration is valid/);
      },
    );

    it(
      'passes that file in a build that carries flow, and a v1 one with it off',
      { timeout: 150_000 },
      () => {
        const on = check({ flowListener: { enabled: true, port: 9995 } }, 'full');
        assert.equal(on.status, 0, on.stderr);
        assert.match(on.stdout, /configuration is valid for ms-probe/);

        const off = check({ flowListener: { enabled: false } }, 'v1');
        assert.equal(off.status, 0, off.stderr);
        assert.match(off.stdout, /configuration is valid for ms-probe/);
      },
    );
  });
});

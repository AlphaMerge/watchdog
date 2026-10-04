import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CONFIG_WARNING_PREFIX, runConfigCheck, type ConfigFindings } from '../src/config/check.js';
import { coreConfigSchema, probeConfigSchema } from '../src/config/schema.js';

/**
 * `config check` — the upgrade question, asked before the upgrade (`H-03`).
 *
 * **What this is for is a specific moment**: `install.sh` has laid the new application down, the
 * old service is still running, and the question is whether the configuration on disk — written
 * for the previous build, and never clobbered by the installer — is one the new build can read.
 * Answering it afterwards, from `journalctl`, is answering it too late.
 *
 * So the properties that matter are the exit code, that it reports *every* problem rather than
 * the first, and that it touches nothing: no database, no port, no file written. It runs against
 * a live installation.
 */

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ms-check-'));
  const path = join(dir, 'core.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

function check(
  argv: readonly string[],
  schema = coreConfigSchema,
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runConfigCheck({
    schema,
    service: 'ms-core',
    version: '9.9.9',
    argv,
    env,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });
  return { code, out, err };
}

describe('checking a configuration', () => {
  it('accepts a file this build can read, and says which file', () => {
    const path = tempFile(JSON.stringify({ api: { port: 9090 } }));
    const { code, out, err } = check(['--config', path]);

    assert.equal(code, 0);
    assert.equal(err.length, 0);
    assert.ok(out[0]?.includes('ms-core 9.9.9'));
    assert.ok(
      out.some((line) => line.includes(path)),
      'the file it actually read',
    );
  });

  it('refuses a file this build cannot, with a non-zero exit', () => {
    // The exit code is the whole interface: `install.sh` branches on it and never parses the
    // text.
    const path = tempFile(JSON.stringify({ api: { port: 'not-a-number' } }));
    const { code, err } = check(['--config', path]);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /api\.port/);
  });

  it('refuses what only a rule across two settings can see (A-38)', () => {
    // An idle timeout longer than the absolute one is two valid numbers that make no sense
    // together — the schema cannot say so, and an install should not find out after the restart.
    const path = tempFile(
      JSON.stringify({ sessions: { idleTimeoutMinutes: 20_160, absoluteTimeoutHours: 168 } }),
    );
    const { code, err } = check(['--config', path]);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /sessions\.idleTimeoutMinutes: 20160 minutes is longer than/);
  });

  it('refuses a trusted proxy that is not an address, before a restart finds it (A-36)', () => {
    const path = tempFile(JSON.stringify({ api: { trustedProxies: ['ms-proxy.example.com'] } }));
    const { code, err } = check(['--config', path]);

    assert.equal(code, 1);
    assert.match(err.join('\n'), /api\.trustedProxies: "ms-proxy\.example\.com" is not an address/);
  });

  it('reports every problem at once, not just the first', () => {
    // Somebody fixing a configuration during an upgrade window should not have to run this five
    // times to find five mistakes.
    // `webRoot` is an object rather than a number: the loader coerces types, so `5` would
    // quietly become "5" and this test would be asserting two problems while claiming three.
    const path = tempFile(JSON.stringify({ api: { port: 'no', webRoot: {}, nonsense: 1 } }));
    const { code, err } = check(['--config', path]);

    assert.equal(code, 1);
    const message = err.join('\n');
    for (const expected of ['api.port', 'api.webRoot', 'nonsense']) {
      assert.match(message, new RegExp(expected.replace('.', '\\.')));
    }
  });

  it('fails on a file that is not there rather than passing on defaults', () => {
    // A path typo must not read as "your configuration is fine": it would be, and the service
    // would then start on schema defaults pointing at no database.
    const { code, err } = check(['--config', '/no/such/core.json']);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /core\.json/);
  });

  it('fails when it read no file at all, rather than passing on the defaults', () => {
    // `H-21`. The schema's defaults always validate, so with no file this said "valid" and exited
    // 0 — and `ms-core config check` with no flag was the pre-restart check the docs gave.
    const { code, out, err } = check([]);
    assert.equal(code, 1);
    assert.equal(out.length, 0, 'nothing that reads as a pass');
    assert.match(err.join('\n'), /no configuration file was read/);
    assert.match(err.join('\n'), /--config/);

    // Not rescued by an environment layer, which is overrides for a file and not a configuration.
    const envOnly = check([], coreConfigSchema, { MS_API__PORT: '7070' });
    assert.equal(envOnly.code, 1);

    // And the variable the service itself uses is a file as good as the flag.
    const path = tempFile(JSON.stringify({}));
    assert.equal(check([], coreConfigSchema, { MS_CONFIG_FILE: path }).code, 0);
  });

  it('fails on JSON that does not parse, saying so', () => {
    const path = tempFile('{ "api": { "port": 8080, }');
    const { code, err } = check(['--config', path]);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /JSON/i);
  });

  it('reads the environment layer, because the service will', () => {
    // A configuration that is only valid *with* an `MS_*` override is valid, and one that a
    // stray override breaks is broken. Checking the file alone would answer a different
    // question from the one the service asks at start-up.
    const path = tempFile(JSON.stringify({}));
    const bad = check(['--config', path], coreConfigSchema, { MS_API__PORT: 'seventy' });
    assert.equal(bad.code, 1);
    assert.match(bad.err.join('\n'), /api\.port/);

    const good = check(['--config', path], coreConfigSchema, { MS_API__PORT: '7070' });
    assert.equal(good.code, 0);
    assert.ok(
      good.out.some((line) => line.includes('MS_API__PORT')),
      'and says it was applied',
    );
  });

  it('names the MS_ variables it ignored, since a misspelt section is silent otherwise', () => {
    const path = tempFile(JSON.stringify({}));
    const { code, out } = check(['--config', path], coreConfigSchema, { MS_APIS__PORT: '7070' });

    assert.equal(code, 0, 'an unknown section is not an error — a harness’s own knob is ordinary');
    assert.ok(
      out.some((line) => line.includes('MS_APIS__PORT')),
      'but it is shown, because it looks exactly like a typo and behaves like one',
    );
  });

  it('names none the launcher sets, and still names a typo beside them (`H-32`)', () => {
    // What `/opt/ms/bin/ms-core` exports. Every check on every installation listed it.
    const launcher = { MS_BUILD_VERSION: '1.0.0', MS_NODE: '/usr/bin/node' };
    const path = tempFile(JSON.stringify({}));
    const clean = check(['--config', path], coreConfigSchema, launcher);
    assert.equal(clean.code, 0);
    assert.deepEqual(
      clean.out.filter((line) => line.includes('ignored MS_')),
      [],
    );

    const typo = check(['--config', path], coreConfigSchema, {
      ...launcher,
      MS_DATABSE__PASSWORD: 'secret',
    });
    assert.equal(typo.code, 0);
    assert.deepEqual(
      typo.out.filter((line) => line.includes('ignored MS_')),
      ['  ignored MS_*    MS_DATABSE__PASSWORD'],
    );
  });

  it('passes the shipped core.json, relay and all, as an operator first finds it (`H-33`)', () => {
    const example = fileURLToPath(
      new URL('../../../../deploy/examples/core.json', import.meta.url),
    );
    const { code, out, err } = check(['--config', example]);
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(err, []);
    assert.equal(out[0], 'configuration is valid for ms-core 9.9.9');
  });

  it('checks a probe configuration with the probe schema', () => {
    // The probe had no command-line verbs before `H-03`, so `ms-probe config check` would have
    // started a second probe on a host that already had one running.
    const path = tempFile(JSON.stringify({ core: { host: '10.0.0.1' } }));
    const out: string[] = [];
    const code = runConfigCheck({
      schema: probeConfigSchema,
      service: 'ms-probe',
      version: '9.9.9',
      argv: ['--config', path],
      env: {},
      write: (line) => out.push(line),
      writeError: () => undefined,
    });
    assert.equal(code, 0);
    assert.ok(out[0]?.includes('ms-probe'));
  });

  describe('what only the build can know (`B-08`)', () => {
    // The schema accepts `flowListener.enabled` in every build, and a v1 probe does nothing with
    // it. The service asks its own build and hands the check what it found, as problems that
    // fail it or as warnings that do not: the installer gates an upgrade on the exit code.
    type Flow = { flowListener: { enabled: boolean } };
    const probeCheck = (
      argv: readonly string[],
      findings: (config: Flow) => ConfigFindings,
    ): { code: number; out: string[]; err: string[] } => {
      const out: string[] = [];
      const err: string[] = [];
      const code = runConfigCheck({
        schema: probeConfigSchema,
        service: 'ms-probe',
        version: '9.9.9',
        argv,
        env: {},
        findings,
        write: (line) => out.push(line),
        writeError: (line) => err.push(line),
      });
      return { code, out, err };
    };

    it('fails on every problem the build reports, and says nothing that reads as a pass', () => {
      const path = tempFile(JSON.stringify({ flowListener: { enabled: true } }));
      const { code, out, err } = probeCheck(['--config', path], (config) =>
        config.flowListener.enabled ? { problems: ['first: no', 'second: no'] } : {},
      );
      assert.equal(code, 1);
      assert.deepEqual(err, ['first: no', 'second: no']);
      assert.deepEqual(out, [], 'a failed check printed "configuration is valid"');
    });

    it('passes on warnings, each on stderr and marked as one', () => {
      // What `place-release.sh` branches on is the exit code, so this is the upgrade going ahead.
      const path = tempFile(JSON.stringify({ flowListener: { enabled: true } }));
      const { code, out, err } = probeCheck(['--config', path], (config) =>
        config.flowListener.enabled ? { warnings: ['first: odd', 'second: odd'] } : {},
      );
      assert.equal(code, 0);
      assert.deepEqual(err, ['warning: first: odd', 'warning: second: odd']);
      assert.equal(CONFIG_WARNING_PREFIX, 'warning: ');
      assert.ok(out[0]?.includes('configuration is valid'), 'a warning stopped the pass line');
    });

    it('fails on a problem whatever the warnings, and still gives the warnings', () => {
      const path = tempFile(JSON.stringify({}));
      const { code, out, err } = probeCheck(['--config', path], () => ({
        problems: ['broken: yes'],
        warnings: ['odd: yes'],
      }));
      assert.equal(code, 1);
      assert.deepEqual(err, ['warning: odd: yes', 'broken: yes']);
      assert.deepEqual(out, []);
    });

    it('is handed the configuration as loaded, defaults and all, and passes when it is fine', () => {
      const path = tempFile(JSON.stringify({}));
      const seen: boolean[] = [];
      const { code, out, err } = probeCheck(['--config', path], (config) => {
        seen.push(config.flowListener.enabled);
        return { problems: [], warnings: [] };
      });
      assert.equal(code, 0);
      assert.deepEqual(seen, [false], 'the default the file did not spell out');
      assert.deepEqual(err, []);
      assert.ok(out[0]?.includes('configuration is valid'));
    });

    it('is not asked about a file that did not load', () => {
      const path = tempFile(JSON.stringify({ flowListener: { enabled: 'perhaps' } }));
      let asked = 0;
      const { code, err } = probeCheck(['--config', path], () => {
        asked += 1;
        return { problems: ['never'], warnings: ['nor this'] };
      });
      assert.equal(code, 1);
      assert.equal(asked, 0);
      assert.match(err.join('\n'), /flowListener\.enabled/);
      assert.ok(!err.some((line) => line.includes('never') || line.includes('nor this')));
    });
  });
});

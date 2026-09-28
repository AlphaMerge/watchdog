import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runConfigCheck } from '../src/config/check.js';
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

    assert.equal(code, 0, 'an unknown section is not an error — MS_BUILD_VERSION is ordinary');
    assert.ok(
      out.some((line) => line.includes('MS_APIS__PORT')),
      'but it is shown, because it looks exactly like a typo and behaves like one',
    );
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
});

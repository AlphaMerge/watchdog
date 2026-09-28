import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/load.js';
import { coreConfigSchema, probeConfigSchema } from '../src/config/schema.js';
import { ConfigError } from '../src/errors/app-error.js';

/** `assert.throws` returns nothing, so capture the error when the message matters. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ms-config-'));
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loadConfig', () => {
  it('applies schema defaults when nothing is supplied', () => {
    const { config, sources } = loadConfig({ schema: coreConfigSchema, env: {}, argv: [] });

    assert.equal(config.service.name, 'ms-core');
    assert.equal(config.service.logLevel, 'info');
    assert.equal(config.service.shutdownTimeoutMs, 20_000);
    assert.equal(config.api.port, 8080);
    // **The default is the enforcing one, and an existing config file has no such key** (`R11`).
    // The `A-11` authorisation layer was written, tested, and left switched off in the only
    // production wiring for two tickets — with a comment saying it would be flipped when `A-03`
    // landed, which it did. It is a key now, and the default is what every installation that
    // does not mention it gets, so this is the assertion that carries the fix.
    assert.equal(config.api.requireAuthentication, true);
    assert.equal(config.database.port, 5432);
    assert.equal(config.probeEndpoint.port, 23560);
    assert.equal(sources.file, null);
    assert.deepEqual(sources.envOverrides, []);
  });

  it('layers file over defaults and environment over file', () => {
    const path = tempFile(
      'core.json',
      JSON.stringify({ api: { port: 9090 }, database: { host: 'db.internal', poolSize: 30 } }),
    );

    const { config, sources } = loadConfig({
      schema: coreConfigSchema,
      configFile: path,
      env: { MS_DATABASE__POOL_SIZE: '55' },
      argv: [],
    });

    assert.equal(config.api.port, 9090, 'file layer wins over the default');
    assert.equal(config.database.host, 'db.internal');
    assert.equal(config.database.poolSize, 55, 'env layer wins over the file');
    assert.equal(config.service.logLevel, 'info', 'untouched defaults survive');
    assert.equal(sources.file, path);
    assert.deepEqual(sources.envOverrides, ['MS_DATABASE__POOL_SIZE']);
  });

  it('coerces environment strings to the schema type', () => {
    const { config } = loadConfig({
      schema: coreConfigSchema,
      env: { MS_API__PORT: '8443', MS_DATABASE__SSL: 'true', MS_SERVICE__LOG_PRETTY: 'false' },
      argv: [],
    });

    assert.equal(config.api.port, 8443);
    assert.equal(typeof config.api.port, 'number');
    assert.equal(config.database.ssl, true);
    assert.equal(config.service.logPretty, false);
  });

  it('reads secrets out of files so they never enter the environment', () => {
    const secret = tempFile('db-password', 'hunter2\n');

    const { config } = loadConfig({
      schema: coreConfigSchema,
      env: { MS_DATABASE__PASSWORD__FROM_FILE: secret },
      argv: [],
    });

    assert.equal(config.database.password, 'hunter2');
  });

  it('takes the config path from --config', () => {
    const path = tempFile('core.json', JSON.stringify({ api: { host: '10.0.0.1' } }));
    const { config, sources } = loadConfig({
      schema: coreConfigSchema,
      env: {},
      argv: ['--config', path],
    });

    assert.equal(config.api.host, '10.0.0.1');
    assert.equal(sources.file, path);
  });

  it('reports every problem at once, not just the first', () => {
    const path = tempFile(
      'core.json',
      JSON.stringify({ api: { port: 70_000 }, service: { logLevel: 'chatty' } }),
    );

    const error = captureError(() =>
      loadConfig({ schema: coreConfigSchema, configFile: path, env: {}, argv: [] }),
    );

    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /api\.port/);
    assert.match(error.message, /service\.logLevel/);
    assert.equal(error.code, 'CONFIG_INVALID');
  });

  it('rejects unknown settings instead of silently ignoring a typo', () => {
    const path = tempFile('core.json', JSON.stringify({ api: { prot: 8080 } }));

    const error = captureError(() =>
      loadConfig({ schema: coreConfigSchema, configFile: path, env: {}, argv: [] }),
    );

    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /unknown setting "prot"/);
  });

  it('fails with a readable message on malformed JSON', () => {
    const path = tempFile('core.json', '{ "api": ');

    const error = captureError(() =>
      loadConfig({ schema: coreConfigSchema, configFile: path, env: {}, argv: [] }),
    );

    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /not valid JSON/);
  });

  it('fails when the config file does not exist', () => {
    assert.throws(
      () =>
        loadConfig({
          schema: coreConfigSchema,
          configFile: '/nonexistent/ms-core.json',
          env: {},
          argv: [],
        }),
      ConfigError,
    );
  });

  it('loads the shipped examples under this build', () => {
    // `deploy/examples` is what an operator copies. An example this build refuses is a first
    // start that fails — and nothing else reads them.
    const example = (name: string): string =>
      fileURLToPath(new URL(`../../../../deploy/examples/${name}`, import.meta.url));
    const core = loadConfig({
      schema: coreConfigSchema,
      env: {},
      argv: ['--config', example('core.json')],
    });
    assert.equal(core.config.sessions.idleTimeoutMinutes, 720);
    loadConfig({ schema: probeConfigSchema, env: {}, argv: ['--config', example('probe.json')] });
  });

  it('loads the probe schema with its own defaults', () => {
    const { config } = loadConfig({
      schema: probeConfigSchema,
      env: { MS_CORE__HOST: 'core.example.net' },
      argv: [],
    });

    assert.equal(config.service.name, 'ms-probe');
    assert.equal(config.core.host, 'core.example.net');
    assert.equal(config.core.port, 23560);
    assert.equal(config.probe.workerPoolSize, 0);
    assert.equal(config.core.heartbeatIntervalMs, 10_000);
  });
});

describe('how long a session lasts (A-38)', () => {
  const load = (sessions: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
    loadConfig({
      schema: coreConfigSchema,
      env,
      argv: ['--config', tempFile('core.json', JSON.stringify({ sessions }))],
    });

  it('is twelve hours idle and seven days at most unless it is set', () => {
    const { config } = loadConfig({ schema: coreConfigSchema, env: {}, argv: [] });
    assert.deepEqual(config.sessions, { idleTimeoutMinutes: 720, absoluteTimeoutHours: 168 });
  });

  it('takes both from the file or the environment', () => {
    const { config } = load(
      { idleTimeoutMinutes: 4_320 },
      { MS_SESSIONS__ABSOLUTE_TIMEOUT_HOURS: '720' },
    );
    assert.deepEqual(config.sessions, { idleTimeoutMinutes: 4_320, absoluteTimeoutHours: 720 });
  });

  it('refuses either outside its bounds', () => {
    for (const sessions of [
      { idleTimeoutMinutes: 4 },
      { idleTimeoutMinutes: 43_201 },
      { absoluteTimeoutHours: 0 },
      { absoluteTimeoutHours: 2_161 },
      { idleTimeoutMinutes: 90.5 },
    ]) {
      const error = captureError(() => load(sessions));
      assert.ok(error instanceof ConfigError, JSON.stringify(sessions));
      assert.match(error.message, /sessions\./, JSON.stringify(sessions));
    }
  });

  it('refuses an idle timeout longer than the absolute one, naming both', () => {
    // A session would reach its ceiling first every time, so the idle setting would be a number
    // that looks like it does something and never does.
    const error = captureError(() => load({ idleTimeoutMinutes: 1_441, absoluteTimeoutHours: 24 }));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /sessions\.idleTimeoutMinutes: 1441 minutes is longer than/);
    assert.match(error.message, /sessions\.absoluteTimeoutHours \(24 hours\)/);

    // Equal is fine: the idle timeout and the ceiling arrive together.
    const { config } = load({ idleTimeoutMinutes: 1_440, absoluteTimeoutHours: 24 });
    assert.equal(config.sessions.idleTimeoutMinutes, 1_440);
  });
});

describe('which proxies are believed (A-36)', () => {
  const load = (trustedProxies: unknown) =>
    loadConfig({
      schema: coreConfigSchema,
      env: {},
      argv: ['--config', tempFile('core.json', JSON.stringify({ api: { trustedProxies } }))],
    });

  it('is nobody unless it is set', () => {
    const { config } = loadConfig({ schema: coreConfigSchema, env: {}, argv: [] });
    assert.deepEqual(config.api.trustedProxies, []);
  });

  it('takes addresses, ranges and loopback', () => {
    const entries = ['loopback', '10.0.4.7', '10.0.4.0/28', '::1', 'fd00::/8'];
    assert.deepEqual(load(entries).config.api.trustedProxies, entries);
  });

  it('refuses what is not one of those, naming every entry', () => {
    const error = captureError(() => load(['ms-proxy', '10.0.4.0/33', '192.0.2.10']));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /api\.trustedProxies: "ms-proxy" is not an address/);
    assert.match(error.message, /api\.trustedProxies: "10\.0\.4\.0\/33" is not an address/);
    assert.equal(error.message.includes('192.0.2.10'), false, 'and not the one that is fine');
  });

  it('refuses the names for every private address, since the browsers are there too', () => {
    // A browser inside a trusted range writes its own X-Forwarded-For and is counted as whoever
    // it names, which makes the login throttle's address the attacker's choice.
    const error = captureError(() => load(['uniquelocal']));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /"uniquelocal" names every private address/);
  });
});

describe('loadConfig environment scoping', () => {
  it('ignores MS_ variables that do not name a configuration section', () => {
    // Regression: the release launcher exports MS_BUILD_VERSION and honours MS_NODE, and the
    // test harness sets MS_TEST_DB_HOST. All three share the config prefix, and unknown
    // settings are a hard error, so each one in turn stopped the service from starting.
    const { config, sources } = loadConfig({
      schema: coreConfigSchema,
      env: {
        MS_BUILD_VERSION: '1.2.3',
        MS_NODE: '/usr/local/bin/node',
        MS_TEST_DB_HOST: 'postgres',
        MS_API__PORT: '9000',
      },
      argv: [],
    });

    assert.equal(config.api.port, 9000);
    assert.deepEqual(sources.envOverrides, ['MS_API__PORT']);
    assert.deepEqual(sources.ignoredEnv, ['MS_BUILD_VERSION', 'MS_NODE', 'MS_TEST_DB_HOST']);
  });

  it('still rejects a misspelt setting inside a real section', () => {
    const error = captureError(() =>
      loadConfig({ schema: coreConfigSchema, env: { MS_API__PROT: '9000' }, argv: [] }),
    );

    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /unknown setting "prot"/);
  });

  it('scopes sections to the schema it was given', () => {
    // `probe` and `core` are sections of the probe schema, not the core schema.
    const { config, sources } = loadConfig({
      schema: probeConfigSchema,
      env: { MS_PROBE__DISPLAY_NAME: 'Branch office probe', MS_API__PORT: '9000' },
      argv: [],
    });

    assert.equal(config.probe.displayName, 'Branch office probe');
    assert.deepEqual(sources.ignoredEnv, ['MS_API__PORT']);
  });
});

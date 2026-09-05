import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

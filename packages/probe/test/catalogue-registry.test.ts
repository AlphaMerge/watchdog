import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import registry from '../src/runner/catalogue-registry.js';

/**
 * The registry every worker and every child process runs a check through (`S-19`).
 *
 * The scrubbing itself is `@ms/sensors`' and is tested there. What is pinned here is that a probe
 * actually goes through it: a registry that called the type directly would pass every sensors test
 * and put a script's secret in the state log all the same.
 */
describe('the probe’s check registry', () => {
  let dir = '';
  const saved = process.env['MS_SCRIPT_DIR'];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-registry-'));
    const path = join(dir, 'leak.sh');
    writeFileSync(path, '#!/bin/sh\necho "request failed with $MS_SECRET" >&2\nexit 2\n', 'utf8');
    chmodSync(path, 0o755);
    process.env['MS_SCRIPT_DIR'] = dir;
  });

  after(() => {
    if (saved === undefined) delete process.env['MS_SCRIPT_DIR'];
    else process.env['MS_SCRIPT_DIR'] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a check’s secret out of its message', async () => {
    await assert.rejects(
      () =>
        registry.execute('exe.script', {
          sensorId: 1,
          target: { host: 'device.example.invalid', ipVersion: 'auto' },
          params: { program: 'leak.sh', secret: 'api-key-1234', timeoutMs: 10_000 },
          credentials: {},
          signal: new AbortController().signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exited with code 2: request failed with ••••••$/);
        return true;
      },
    );
  });
});

import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CREDENTIALS_WITHHELD as SENSORS_CREDENTIALS_WITHHELD } from '@ms/sensors';
import registry from '../src/runner/catalogue-registry.js';
import { CREDENTIALS_WITHHELD } from '../src/runner/types.js';

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

  it('refuses a check outside its credentials’ targets, in the code the runners read (A-41c)', async () => {
    // The real registry, so the real catalogue: what is pinned is that a probe's checks pass
    // through `pinTarget`, and that its refusal carries the code `check-worker` looks for. An
    // address outside the targets needs nothing resolved and nothing sent.
    assert.equal(CREDENTIALS_WITHHELD, SENSORS_CREDENTIALS_WITHHELD);
    await assert.rejects(
      () =>
        registry.execute('snmp.uptime', {
          sensorId: 9,
          target: { host: '192.0.2.9', ipVersion: 'auto' },
          params: { port: 161 },
          credentials: {
            snmp: { version: 'v2c', community: 'public', allowedTargets: ['10.0.0.0/8'] },
          },
          signal: new AbortController().signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: unknown }).code, CREDENTIALS_WITHHELD);
        assert.equal((error as { sensorId?: unknown }).sensorId, 9);
        assert.match(error.message, /^Not scanned: 192\.0\.2\.9 is outside the allowed targets/);
        return true;
      },
    );
  });

  it('refuses a device on a metadata address as an ordinary failed check (A-57)', async () => {
    // The real registry again: a probe's checks are held to its target policy, on a transport
    // that had no guard before, and the refusal carries no code a runner reads. It is a failed
    // check, so the sensor reads Down by the ordinary path, not Unknown. Nothing is resolved
    // and nothing is sent: the address is refused as it stands.
    for (const [type, params] of [
      ['port.tcp', { port: 80 }],
      ['tls.certificate', { port: 443 }],
    ] as const) {
      await assert.rejects(
        () =>
          registry.execute(type, {
            sensorId: 9,
            target: { host: '169.254.169.254', ipVersion: 'auto' },
            params,
            credentials: {},
            signal: new AbortController().signal,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: unknown }).code, undefined);
          assert.match(
            error.message,
            /^refusing to connect to 169\.254\.169\.254, which is link-local .* target policy \(link-local\)/,
          );
          return true;
        },
      );
    }
  });

  it('refuses a device host beginning with "-" before ping is spawned (S-20)', async () => {
    // What this replaces is ping's own "Destination address required", which says nothing about
    // the device's host being the problem.
    await assert.rejects(
      () =>
        registry.execute('icmp.ping', {
          sensorId: 1,
          target: { host: '-f', ipVersion: 'auto' },
          params: {},
          credentials: {},
          signal: new AbortController().signal,
        }),
      /this device's host "-f" begins with "-".*correct the device’s host/,
    );
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SensorCatalogue } from '../src/catalogue.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import {
  MIN_SCRUBBED_LENGTH,
  SCRUBBED,
  scrubSecrets,
  secretsOfCheck,
} from '../src/support/secrets.js';
import { snmpType } from './support/example-types.js';

/**
 * `S-19`: a check's message leaves the probe without the secrets the check held.
 *
 * The message is the most widely read thing a check produces — the state log, every notification,
 * a report — and it is very often somebody else's words: a driver's error, a script's output, a
 * server's banner. So the catalogue scrubs every message, for every type, of every `writeOnly`
 * parameter and every secret credential field, and this file pins exactly what that means and
 * where it stops.
 */

const SSH = { username: 'monitor', password: 'hunter2-long', privateKey: 'KEY-MATERIAL' };

/** `snmpType`'s secrets (`community`, `auth.privKey`), plus an SSH credential. */
function leaky(behaviour: (context: CheckContext) => Promise<CheckExecution>): SensorCatalogue {
  const type: SensorType = {
    ...snmpType,
    id: 'test.leaky',
    credentialKinds: ['ssh'],
    execute: behaviour,
  };
  return new SensorCatalogue().register(type).seal();
}

const context = (params: Record<string, unknown>): CheckContext => ({
  sensorId: 1,
  target: { host: 'device.example.invalid', ipVersion: 'auto' },
  params,
  credentials: { ssh: SSH },
  signal: new AbortController().signal,
});

const PARAMS = { community: 'c0mmunity-s3cret', auth: { user: 'u', privKey: 'priv-key-value' } };

describe('what a check may say', () => {
  it('scrubs a thrown error of every secret the check held, and keeps the error what it was', async () => {
    class DriverError extends Error {
      readonly code = 'EAUTH';
    }
    const catalogue = leaky((ctx) =>
      Promise.reject(
        new DriverError(
          `login as ${String(ctx.credentials['ssh']?.['username'])} with ` +
            `${String(ctx.credentials['ssh']?.['password'])} refused; community ` +
            `${String(ctx.params['community'])}, key priv-key-value`,
        ),
      ),
    );

    await assert.rejects(
      () => catalogue.execute('test.leaky', context(PARAMS)),
      (error: unknown) => {
        assert.ok(error instanceof DriverError, 'the class survives');
        assert.equal(error.code, 'EAUTH', 'and so does the code the caller reads');
        assert.equal(
          error.message,
          `login as monitor with ${SCRUBBED} refused; community ${SCRUBBED}, key ${SCRUBBED}`,
          'the username is not a secret and stays: it is half the diagnosis',
        );
        assert.ok(!(error.stack ?? '').includes('hunter2-long'), 'nor is it in the stack');
        return true;
      },
    );
  });

  it('scrubs the message of a check that succeeded, and leaves its readings alone', async () => {
    const catalogue = leaky(() =>
      Promise.resolve({
        channels: [{ key: 'in', value: 12 }],
        message: 'banner: welcome KEY-MATERIAL',
      }),
    );
    const execution = await catalogue.execute('test.leaky', context(PARAMS));
    assert.equal(execution.message, `banner: welcome ${SCRUBBED}`);
    assert.deepEqual(execution.channels, [{ key: 'in', value: 12 }]);
  });

  it('scrubs a string that was thrown rather than an error', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
    const catalogue = leaky(() => Promise.reject('c0mmunity-s3cret was refused'));
    await assert.rejects(
      () => catalogue.execute('test.leaky', context(PARAMS)),
      (error: unknown) => error instanceof Error && error.message === `${SCRUBBED} was refused`,
    );
  });

  it('replaces exact values and nothing else — the limits it states', () => {
    const secrets = ['abc', 'hunter2-long'];
    // Shorter than the floor: left, so ordinary text is not mangled.
    assert.equal(MIN_SCRUBBED_LENGTH, 4);
    assert.equal(scrubSecrets('abcdef', secrets), 'abcdef');
    // Encoded or partial: not caught, and not claimed to be.
    assert.equal(
      scrubSecrets(Buffer.from('hunter2-long').toString('base64'), secrets),
      Buffer.from('hunter2-long').toString('base64'),
    );
    assert.equal(scrubSecrets('hunter2-', secrets), 'hunter2-');
    // Longest first, so a secret containing another goes whole.
    assert.equal(scrubSecrets('x hunter2-long y', ['hunter2', 'hunter2-long']), `x ${SCRUBBED} y`);
  });

  it('finds the secrets: writeOnly params, nested ones, and secret credential fields', () => {
    const found = secretsOfCheck(['community', 'auth.privKey', 'missing.path'], PARAMS, {
      ssh: SSH,
      'from-a-newer-build': { anything: 'unknown-kind-value' },
    }).sort();
    assert.deepEqual(found, [
      'KEY-MATERIAL',
      'c0mmunity-s3cret',
      'hunter2-long',
      'priv-key-value',
      // A kind this build does not know is one nobody said was safe to print.
      'unknown-kind-value',
    ]);
    assert.ok(!found.includes('monitor'), 'a username is not a secret field');
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SensorCatalogue } from '../src/catalogue.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import {
  encodedForms,
  MIN_SCRUBBED_LENGTH,
  SCRUBBED,
  scrubSecrets,
  secretsOfCheck,
} from '../src/support/secrets.js';
import { snmpType } from './support/example-types.js';
import * as shared from '@ms/shared';

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
    secretDestinations: { ...snmpType.secretDestinations, 'kind:ssh': [] },
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

  it('refuses a host beginning with "-" before any type sees it (S-20)', async () => {
    // A device stored before the core refused such a host. A type handing it to a program would
    // have it read as an option; here it is refused, naming the host, whatever the type.
    let ran = false;
    const catalogue = leaky(() => {
      ran = true;
      return Promise.resolve({ channels: [] });
    });
    await assert.rejects(
      () =>
        catalogue.execute('test.leaky', {
          ...context(PARAMS),
          target: { host: '-c100000', ipVersion: 'auto' },
        }),
      /^Error: this device's host "-c100000" begins with "-", which no address or name does/,
    );
    assert.equal(ran, false);
  });

  it('scrubs with the one scrubber, which lives in @ms/shared since A-44', () => {
    // Re-exported rather than copied, so every type that imports it from here scrubs exactly as
    // a notification program's output is scrubbed in the core.
    assert.equal(scrubSecrets, shared.scrubSecrets);
    assert.equal(SCRUBBED, shared.SCRUBBED);
    assert.equal(MIN_SCRUBBED_LENGTH, shared.MIN_SCRUBBED_LENGTH);
  });

  it('replaces the values it is given and nothing else — the limits it states', () => {
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
    const exact = [
      'KEY-MATERIAL',
      'c0mmunity-s3cret',
      'hunter2-long',
      'priv-key-value',
      // A kind this build does not know is one nobody said was safe to print.
      'unknown-kind-value',
    ];
    // Each, and the forms a server echoes it in (`A-42`), and nothing besides.
    assert.deepEqual(found, [...new Set(exact.flatMap(encodedForms))].sort());
    assert.ok(!found.some((one) => one.includes('monitor')), 'a username is not a secret field');
  });
});

describe('an echo the check did not write (`A-42`)', () => {
  // A server reflects what it was sent as the request carried it. Each form below is the secret
  // to anybody who decodes it, so each is scrubbed as the secret is.
  const SECRET = 'hunter 2&"x/y';
  const forms = (text: string): string =>
    scrubSecrets(
      text,
      secretsOfCheck(
        [],
        {},
        {
          ssh: { password: SECRET },
        },
      ),
    );

  it('scrubs a secret percent-encoded, form-encoded, in base64, HTML-escaped and JSON-escaped', () => {
    const echoes = {
      percent: encodeURIComponent(SECRET),
      lowerHex: encodeURIComponent(SECRET).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
      form: new URLSearchParams({ p: SECRET }).toString().slice(2),
      base64: Buffer.from(SECRET).toString('base64'),
      unpadded: Buffer.from(SECRET).toString('base64').replace(/=+$/, ''),
      base64url: Buffer.from(SECRET).toString('base64url'),
      html: SECRET.replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
      json: JSON.stringify({ p: SECRET }).slice(6, -2),
    };
    for (const [how, echo] of Object.entries(echoes)) {
      assert.equal(forms(`a server said ${echo} back`), `a server said ${SCRUBBED} back`, how);
    }
  });

  it('scrubs the pair basic authentication sends, which is no one field', () => {
    const basic = Buffer.from('ops:hunter2-long').toString('base64');
    const found = secretsOfCheck([], {}, { http: { username: 'ops', password: 'hunter2-long' } });
    assert.ok(found.includes(basic), 'the pair as the header carries it');
    assert.equal(
      scrubSecrets(`authorization: Basic ${basic}`, found),
      `authorization: Basic ${SCRUBBED}`,
    );
    // A token is sent as itself, and needs nothing more.
    assert.ok(
      !secretsOfCheck([], {}, { http: { token: 'tok-long-enough' } }).some((one) =>
        one.startsWith('Bearer'),
      ),
    );
  });

  it('does not catch what it does not claim to: hex, twice-encoded, shifted base64, a part', () => {
    const missed = {
      hex: Buffer.from(SECRET).toString('hex'),
      twice: encodeURIComponent(encodeURIComponent(SECRET)),
      // The secret base64-encoded after one other byte: its bytes land across different sextets.
      shifted: Buffer.from(`!${SECRET}`).toString('base64'),
      part: SECRET.slice(0, 6),
      numericEntity: SECRET.replace(/"/g, '&#x22;'),
    };
    for (const [how, echo] of Object.entries(missed)) {
      assert.equal(forms(echo), echo, how);
    }
  });

  it('adds no forms for a value too short to scrub at all', () => {
    assert.deepEqual(secretsOfCheck([], {}, { ssh: { password: 'abc' } }), ['abc']);
  });
});

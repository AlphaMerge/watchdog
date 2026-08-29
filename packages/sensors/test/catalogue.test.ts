import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SensorCatalogue, SensorTypeError } from '../src/catalogue.js';
import type { SensorType } from '../src/contract.js';
import { standardCatalogue } from '../src/index.js';
import { exampleTypes, pingType, snmpType } from './support/example-types.js';

function catalogue(): SensorCatalogue {
  const c = new SensorCatalogue();
  for (const type of exampleTypes()) c.register(type);
  return c;
}

/** A type built from `pingType` with one thing changed. */
function variant(patch: Partial<SensorType>): SensorType {
  return { ...pingType, ...patch };
}

describe('registration', () => {
  it('refuses an id that is not dotted and lowercase', () => {
    for (const id of ['Ping', 'icmp', 'icmp.Ping', 'icmp ping', '']) {
      assert.throws(
        () => new SensorCatalogue().register(variant({ id })),
        (error: unknown) => error instanceof SensorTypeError && error.code === 'BAD_SENSOR_TYPE',
        `"${id}" should have been refused`,
      );
    }
  });

  it('refuses a duplicate id rather than letting one shadow the other', () => {
    const c = new SensorCatalogue();
    c.register(pingType);
    assert.throws(() => {
      c.register(variant({ category: 'Something else' }));
    }, /already registered/);
  });

  it('refuses two primary channels', () => {
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({
            channels: () => [
              { key: 'a', name: 'A', isPrimary: true },
              { key: 'b', name: 'B', isPrimary: true },
            ],
          }),
        ),
      /at most one/,
    );
  });

  it('refuses a repeated channel key', () => {
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({
            channels: () => [
              { key: 'rtt', name: 'A' },
              { key: 'rtt', name: 'B' },
            ],
          }),
        ),
      /twice/,
    );
  });

  /**
   * Declared thresholds (`S-18`).
   *
   * Refused at registration rather than at the first reading, because all four of these read as
   * configured and do nothing — and the ordering one is the mistake that would actually be made,
   * since "warn at 80, fail at 95" is easy to type in the wrong order.
   */
  it('refuses declared limits with no bound in them', () => {
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({ channels: () => [{ key: 'a', name: 'A', limits: { errorMessage: 'oh' } }] }),
        ),
      /no bound in them/,
    );
  });

  it('refuses a declared bound that is not a number', () => {
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({ channels: () => [{ key: 'a', name: 'A', limits: { upperError: NaN } }] }),
        ),
      /not a number/,
    );
  });

  it('refuses a warning bound the error bound has already passed', () => {
    // The warning would be unreachable: every reading past it is already an error.
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({
            channels: () => [{ key: 'a', name: 'A', limits: { upperWarning: 95, upperError: 80 } }],
          }),
        ),
      /upper warning above its upper error/,
    );
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({
            channels: () => [{ key: 'a', name: 'A', limits: { lowerError: 9, lowerWarning: 5 } }],
          }),
        ),
      /lower error above its lower warning/,
    );
  });

  it('refuses a band that is upside down', () => {
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({
            channels: () => [
              { key: 'a', name: 'A', limits: { lowerWarning: 90, upperWarning: 10 } },
            ],
          }),
        ),
      /lower warning above its upper warning/,
    );
  });

  it('takes a one-sided declaration, which is what a counter wants', () => {
    // "Any rate above zero is a fault" has no lower bound and no warning, and refusing it would
    // push every such channel into inventing numbers to satisfy a shape.
    assert.doesNotThrow(() =>
      new SensorCatalogue().register(
        variant({ channels: () => [{ key: 'a', name: 'A', limits: { upperError: 0.000_01 } }] }),
      ),
    );
  });

  it('refuses a paramsSchema Ajv cannot compile', () => {
    assert.throws(
      () => new SensorCatalogue().register(variant({ paramsSchema: { type: 'not-a-type' } })),
      /unusable paramsSchema/,
    );
  });

  it('stops accepting types once sealed', () => {
    const c = standardCatalogue([pingType]);
    assert.equal(c.sealed, true);
    assert.throws(() => c.register(snmpType), /sealed/);
  });

  it('lists what it has, sorted', () => {
    assert.deepEqual(catalogue().ids(), ['icmp.ping', 'snmp.traffic']);
  });
});

describe('parameter validation', () => {
  it('fills in the defaults a type declares', () => {
    const result = catalogue().validate('icmp.ping', {});
    assert.ok(result.valid);
    assert.deepEqual(result.params, { count: 4, timeoutMs: 2_000 });
  });

  it('does not mutate the caller’s object while doing it', () => {
    const params = {};
    catalogue().validate('icmp.ping', params);
    assert.deepEqual(params, {}, 'defaults were written into the input');
  });

  it('reports every problem, not just the first', () => {
    const result = catalogue().validate('icmp.ping', { count: 99, timeoutMs: 1 });
    assert.ok(!result.valid);
    assert.equal(result.problems.length, 2);
    assert.deepEqual(result.problems.map((p) => p.path).sort(), ['/count', '/timeoutMs']);
  });

  it('rejects an unknown parameter rather than storing it', () => {
    const result = catalogue().validate('icmp.ping', { count: 4, colour: 'blue' });
    assert.ok(!result.valid);
  });

  it('rejects a missing required parameter', () => {
    const result = catalogue().validate('snmp.traffic', { port: 161 });
    assert.ok(!result.valid);
  });

  it('reports an unknown type as a problem rather than throwing', () => {
    const result = catalogue().validate('nope.missing', {});
    assert.ok(!result.valid);
    assert.match(result.problems[0]?.message ?? '', /unknown sensor type/);
  });
});

describe('writeOnly redaction', () => {
  it('finds writeOnly parameters, including nested ones', () => {
    assert.deepEqual([...catalogue().writeOnlyPaths('snmp.traffic')].sort(), [
      'auth.privKey',
      'community',
    ]);
  });

  it('removes the value rather than masking it', () => {
    const { params, redacted } = catalogue().redact('snmp.traffic', {
      community: 'public-but-secret',
      port: 161,
      auth: { user: 'ops', privKey: 'hunter2' },
    });

    assert.equal(Object.hasOwn(params, 'community'), false, 'the key is gone, not blanked');
    assert.deepEqual(params, { port: 161, auth: { user: 'ops' } });
    assert.deepEqual([...redacted].sort(), ['auth.privKey', 'community']);
    assert.ok(!JSON.stringify(params).includes('hunter2'));
    assert.ok(!JSON.stringify(params).includes('public-but-secret'));
  });

  it('reports only the paths that actually held a value', () => {
    const { redacted } = catalogue().redact('snmp.traffic', { port: 161 });
    assert.deepEqual(redacted, [], 'nothing was set, so nothing is "set but hidden"');
  });

  it('does not mutate the params it was given', () => {
    const params = { community: 'secret', port: 161 };
    catalogue().redact('snmp.traffic', params);
    assert.equal(params.community, 'secret');
  });

  it('leaves a type with no secrets untouched', () => {
    const { params, redacted } = catalogue().redact('icmp.ping', { count: 4 });
    assert.deepEqual(params, { count: 4 });
    assert.deepEqual(redacted, []);
  });

  // The case the guard exists for: a secret behind a combinator cannot be redacted without
  // evaluating which branch matched, and guessing either leaks it or deletes a live value.
  it('refuses at registration a writeOnly hidden inside a combinator', () => {
    assert.throws(
      () =>
        new SensorCatalogue().register(
          variant({
            paramsSchema: {
              type: 'object',
              properties: {
                auth: {
                  oneOf: [
                    { type: 'object', properties: { token: { type: 'string', writeOnly: true } } },
                    { type: 'object', properties: { none: { type: 'boolean' } } },
                  ],
                },
              },
            },
          }),
        ),
      /combinator/,
    );
  });
});

describe('lookup', () => {
  it('throws a typed error for an unknown type', () => {
    assert.throws(
      () => catalogue().type('nope.missing'),
      (error: unknown) => error instanceof SensorTypeError && error.code === 'UNKNOWN_SENSOR_TYPE',
    );
  });

  it('summarises without exposing execute', () => {
    const summary = catalogue()
      .summaries()
      .find((s) => s.id === 'snmp.traffic');
    assert.ok(summary);
    assert.equal(summary.category, 'SNMP');
    assert.equal(summary.costHint, 'medium');
    assert.equal(Object.hasOwn(summary, 'execute'), false);
  });

  it('declares channels, with exactly one primary', () => {
    const defs = catalogue().channelsFor('icmp.ping', { count: 4 });
    assert.deepEqual(
      defs.filter((d) => d.isPrimary === true).map((d) => d.key),
      ['rtt'],
    );
  });
});

describe('the built-in catalogue', () => {
  it('registers what ships, and registers it cleanly', () => {
    // Building it at all is the assertion: `register` enforces the id format, one primary
    // channel, no duplicate keys and no unreachable `writeOnly`, and throws on any of them. A
    // type that breaks a rule fails here rather than on an operator's first sensor.
    // Sorted by id, not by registration order.
    assert.deepEqual(standardCatalogue().ids(), [
      'core.factory',
      'db.mssql',
      'db.mysql',
      'db.postgresql',
      'dns.blocklist',
      'dns.record',
      'exe.script',
      'exe.script.advanced',
      'http.advanced',
      'http.content',
      'http.request',
      'http.transaction',
      'icmp.jitter',
      'icmp.ping',
      'mail.imap',
      'mail.pop3',
      'mail.roundtrip',
      'mail.smtp',
      'ms.core.health',
      'ms.probe.health',
      'port.range',
      'port.tcp',
      'rest.custom',
      'snmp.cpu',
      'snmp.custom',
      'snmp.custom.string',
      'snmp.diskfree',
      'snmp.memory',
      'snmp.table',
      'snmp.traffic',
      'snmp.trap',
      'snmp.uptime',
      'ssh.diskfree',
      'ssh.load',
      'ssh.meminfo',
      'ssh.script',
      'syslog.receiver',
      'tls.certificate',
      'tls.security',
      'windows.cpu',
      'windows.memory',
      'windows.service',
      'windows.volume',
    ]);
  });

  it('is sealed, so nothing can register a type after boot', () => {
    assert.equal(standardCatalogue().sealed, true);
  });

  it('ships thresholds only on the sensors that watch this system', () => {
    // A default threshold on a monitored device's channel would be a guess about somebody else's
    // network. On our own numbers it is a statement about this software, which is the only place
    // the same number means the same thing on every installation (`S-18`).
    const catalogue = standardCatalogue();
    const withLimits = catalogue
      .ids()
      .filter((id) =>
        catalogue.channelsFor(id, {}).some((channel) => channel.limits !== undefined),
      );
    assert.deepEqual(withLimits, ['ms.core.health', 'ms.probe.health']);
  });

  it('declares exactly one primary channel per shipped type', () => {
    const catalogue = standardCatalogue();
    for (const id of catalogue.ids()) {
      const primary = catalogue.channelsFor(id, {}).filter((channel) => channel.isPrimary === true);
      assert.equal(primary.length, 1, `${id} has ${String(primary.length)} primary channels`);
    }
  });

  it('validates every shipped type against its own declared defaults', () => {
    // A schema whose *defaults* do not satisfy it is a type nobody can fill in — a `default` of
    // 0 under a `minimum: 1`, an enum default that is not in the enum.
    //
    // Missing required properties are excluded, and that is not a loophole: `snmp.custom` has to
    // have an OID and there is no sensible default for one, so "an empty form is valid" would
    // rule out a whole legitimate shape of sensor. What is being asserted is that every problem
    // with an empty form is "you have not typed this yet" and never "the value we put there for
    // you is wrong".
    const catalogue = standardCatalogue();
    for (const id of catalogue.ids()) {
      const result = catalogue.validate(id, {});
      const bad = result.valid
        ? []
        : result.problems.filter((problem) => !/required/i.test(problem.message));
      assert.deepEqual(bad, [], `${id} rejects its own defaults`);
    }
  });
});

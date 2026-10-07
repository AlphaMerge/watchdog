import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SensorCatalogue, SensorTypeError } from '../src/catalogue.js';
import type { ChannelDef, SensorType } from '../src/contract.js';
import {
  sensorTypesFor,
  standardCatalogue,
  WITHHELD_FROM_V1,
  withheldReason,
} from '../src/index.js';
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

  it('refuses a type the core evaluates that does not say what it reads (A-29)', () => {
    // The core evaluates exactly the types whose readings come from what it already holds, and
    // a sensor republishes its readings to whoever can read it. So one of these that declared
    // nothing would be a way to read anything the core holds from wherever one could be put.
    assert.throws(
      () => new SensorCatalogue().register(variant({ evaluatedBy: 'core' })),
      (error: unknown) =>
        error instanceof SensorTypeError &&
        error.code === 'BAD_SENSOR_TYPE' &&
        /has to declare what it reads/.test(error.message),
    );
    // Either declaration is enough, and a probe's type needs neither.
    new SensorCatalogue().register(variant({ evaluatedBy: 'core', requires: 'installation' }));
    new SensorCatalogue().register(variant({ evaluatedBy: 'core', references: () => [] }));
    new SensorCatalogue().register(variant({}));
  });

  it('refuses a recovery hold that is not whole seconds up to a day (M-18)', () => {
    for (const recoveryHoldSeconds of [-1, 1.5, 86_401, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new SensorCatalogue().register(variant({ recoveryHoldSeconds })),
        (error: unknown) =>
          error instanceof SensorTypeError &&
          error.code === 'BAD_SENSOR_TYPE' &&
          /recovery hold/.test(error.message),
        String(recoveryHoldSeconds),
      );
    }
    for (const recoveryHoldSeconds of [0, 300, 86_400]) {
      new SensorCatalogue().register(variant({ recoveryHoldSeconds }));
    }
  });

  it('holds a return for Probe Health alone among the shipped types (M-18)', () => {
    // Every other type ends its alarm at the return, as before: the hold is for outages that
    // come in bursts the core samples between, and today that is a restarting probe.
    const shipped = standardCatalogue();
    const holding = shipped
      .ids()
      .map((id) => [id, shipped.type(id).recoveryHoldSeconds ?? 0] as const)
      .filter(([, hold]) => hold > 0);
    assert.deepEqual(holding, [['ms.probe.health', 300]]);
  });

  it('has every shipped type the core evaluates say what it reads (A-29)', () => {
    const catalogue = standardCatalogue();
    const declared = catalogue
      .ids()
      .filter((id) => catalogue.declaration(id).evaluatedBy === 'core')
      .map((id) => {
        const type = catalogue.declaration(id);
        return [id, type.requires ?? (type.references === undefined ? 'nothing' : 'references')];
      });
    assert.deepEqual(declared, [
      ['core.factory', 'references'],
      ['ms.core.health', 'installation'],
      ['ms.probe.health', 'references'],
    ]);
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
        variant({
          fixedChannels: true,
          channels: () => [{ key: 'a', name: 'A', limits: { upperError: 0.000_01 } }],
        }),
      ),
    );
  });

  /**
   * Declared limits only where `{}` answers for every sensor (`P-293`).
   *
   * The start-up pass keeps declared limits in step from a type's `channels({})`, which is every
   * sensor's answer only for a type whose channels do not depend on its parameters. So that is
   * the only kind of type allowed to declare them, and it is held to the promise as far as the
   * catalogue can see: at registration with `{}` and the schema's defaults, and at every
   * `channelsFor` after.
   */
  describe('limits and fixed channels (P-293)', () => {
    const LIMITED = { key: 'a', name: 'A', isPrimary: true, limits: { upperError: 1 } } as const;
    const PLAIN = { key: 'a', name: 'A', isPrimary: true } as const;
    /** A schema with a parameter, and one with a default, for the cases that need them. */
    const WITH_PARAM = {
      type: 'object',
      additionalProperties: false,
      properties: { extra: { type: 'boolean' } },
    } as const;
    const WITH_DEFAULT = {
      type: 'object',
      additionalProperties: false,
      properties: { extra: { type: 'boolean', default: true } },
    } as const;
    /** `extra: true` adds a channel, with limits on it or not. */
    const growing =
      (limited: boolean) =>
      (params: Readonly<Record<string, unknown>>): readonly ChannelDef[] => [
        PLAIN,
        ...(params['extra'] === true
          ? [{ key: 'b', name: 'B', ...(limited ? { limits: { upperError: 2 } } : {}) }]
          : []),
      ];

    interface Registration {
      readonly name: string;
      readonly type: Partial<SensorType>;
      /** The refusal, or null for a type that registers. */
      readonly refused: RegExp | null;
    }

    const registrations: readonly Registration[] = [
      {
        name: 'limits on a channel `{}` names, without the flag',
        type: { channels: () => [LIMITED] },
        refused: /declares limits on channel "a" without `fixedChannels`/,
      },
      {
        name: 'limits on a channel `{}` names, with a parameter and without the flag',
        type: { paramsSchema: WITH_PARAM, channels: () => [LIMITED] },
        refused: /without `fixedChannels`/,
      },
      {
        name: 'the flag, with `channels({})` throwing',
        type: {
          fixedChannels: true,
          channels: () => {
            throw new Error('needs a table');
          },
        },
        refused: /`channels\(\{\}\)` threw: Error: needs a table/,
      },
      {
        name: 'the flag, with the defaults giving other channels',
        type: { fixedChannels: true, paramsSchema: WITH_DEFAULT, channels: growing(false) },
        refused: /its schema’s defaults give it other channels/,
      },
      {
        name: 'the flag and limits',
        type: { fixedChannels: true, channels: () => [LIMITED] },
        refused: null,
      },
      {
        name: 'the flag and limits, with a parameter that chooses no channel',
        type: { fixedChannels: true, paramsSchema: WITH_PARAM, channels: () => [LIMITED] },
        refused: null,
      },
      {
        name: 'the flag and no limits',
        type: { fixedChannels: true, channels: () => [PLAIN] },
        refused: null,
      },
      {
        name: 'no flag, no limits, channels from parameters',
        type: { paramsSchema: WITH_PARAM, channels: growing(false) },
        refused: null,
      },
      {
        // Seen only at `channelsFor`: registration cannot reach a channel `{}` does not name.
        name: 'no flag, limits only real parameters produce',
        type: { paramsSchema: WITH_PARAM, channels: growing(true) },
        refused: null,
      },
      {
        name: 'no flag, `channels({})` throwing',
        type: {
          channels: () => {
            throw new Error('needs a table');
          },
        },
        refused: null,
      },
    ];

    for (const one of registrations) {
      it(`at registration: ${one.name}`, () => {
        const register = (): unknown => new SensorCatalogue().register(variant(one.type));
        if (one.refused === null) {
          assert.doesNotThrow(register);
        } else {
          assert.throws(
            register,
            (error: unknown) =>
              error instanceof SensorTypeError &&
              error.code === 'BAD_SENSOR_TYPE' &&
              one.refused !== null &&
              one.refused.test(error.message),
          );
        }
      });
    }

    interface Lookup {
      readonly name: string;
      readonly type: Partial<SensorType>;
      readonly params: Readonly<Record<string, unknown>>;
      /** The refusal, or the keys of the channels answered. */
      readonly answer: RegExp | readonly string[];
    }

    const lookups: readonly Lookup[] = [
      {
        // The case registration cannot see, and the one the pass would have got wrong.
        name: 'no flag, limits on a channel only real parameters produce',
        type: { paramsSchema: WITH_PARAM, channels: growing(true) },
        params: { extra: true },
        answer: /declares limits on channel "b" without `fixedChannels`/,
      },
      {
        name: 'no flag, the same type with parameters that produce no limit',
        type: { paramsSchema: WITH_PARAM, channels: growing(true) },
        params: {},
        answer: ['a'],
      },
      {
        name: 'no flag, no limits, a channel from parameters',
        type: { paramsSchema: WITH_PARAM, channels: growing(false) },
        params: { extra: true },
        answer: ['a', 'b'],
      },
      {
        // Past what registration could check: no default sets `extra`, a sensor does.
        name: 'the flag, with parameters that give other channels',
        type: { fixedChannels: true, paramsSchema: WITH_PARAM, channels: growing(false) },
        params: { extra: true },
        answer: /says its channels do not depend on its parameters/,
      },
      {
        name: 'the flag, with parameters that give the same channels',
        type: { fixedChannels: true, paramsSchema: WITH_PARAM, channels: growing(false) },
        params: { extra: false },
        answer: ['a'],
      },
    ];

    for (const one of lookups) {
      it(`at channelsFor: ${one.name}`, () => {
        const c = new SensorCatalogue().register(variant(one.type));
        const lookup = (): readonly ChannelDef[] => c.channelsFor(pingType.id, one.params);
        if (one.answer instanceof RegExp) {
          const refusal = one.answer;
          assert.throws(
            lookup,
            (error: unknown) =>
              error instanceof SensorTypeError &&
              error.code === 'BAD_SENSOR_TYPE' &&
              refusal.test(error.message),
          );
        } else {
          assert.deepEqual(
            lookup().map((def) => def.key),
            one.answer,
          );
        }
      });
    }

    it('marks the two shipped types that declare limits, and Probe Health keeps its channels', () => {
      const c = standardCatalogue(sensorTypesFor('full'));
      const limited = c
        .ids()
        .filter((id) => c.channelsFor(id, {}).some((def) => def.limits !== undefined));
      assert.deepEqual(limited, ['ms.core.health', 'ms.probe.health']);
      for (const id of limited) assert.equal(c.declaration(id).fixedChannels, true, id);
      // `probeId` chooses the probe, never the channels.
      assert.deepEqual(
        c.channelsFor('ms.probe.health', { probeId: 7 }),
        c.channelsFor('ms.probe.health', {}),
      );
    });
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

describe('where a secret is sent (A-40)', () => {
  /** A type with one secret, a place it is sent, and one parameter that has nothing to do with it. */
  const withSecret = (secretDestinations?: Readonly<Record<string, readonly string[]>>) =>
    variant({
      ...(secretDestinations === undefined ? {} : { secretDestinations }),
      paramsSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', default: '' },
          token: { type: 'string', writeOnly: true },
          auth: {
            type: 'object',
            properties: { user: { type: 'string' }, key: { type: 'string', writeOnly: true } },
          },
          timeoutMs: { type: 'integer', default: 5_000 },
        },
      },
    });
  const refused = (type: SensorType, said: RegExp): void => {
    assert.throws(
      () => new SensorCatalogue().register(type),
      (error: unknown) =>
        error instanceof SensorTypeError &&
        error.code === 'BAD_SENSOR_TYPE' &&
        said.test(error.message),
    );
  };

  it('refuses a type with a secret it does not say the destination of', () => {
    refused(withSecret(), /"token" writeOnly but does not say where it is sent/);
    refused(withSecret({ token: ['url'] }), /"auth\.key" writeOnly but does not say/);
  });

  it('refuses a destination declared for a parameter that is not a secret', () => {
    refused(
      withSecret({ token: ['url'], 'auth.key': [], url: [] }),
      /where "url" is sent, but "url" is not a writeOnly/,
    );
  });

  it('refuses a destination that is a secret or holds one, since nobody can see it change', () => {
    refused(withSecret({ token: ['auth.key'], 'auth.key': [] }), /"auth\.key" is write-only/);
    refused(withSecret({ token: ['auth'], 'auth.key': [] }), /"auth\.key" is write-only/);
    refused(withSecret({ token: [], 'auth.key': ['token'] }), /"token" is write-only/);
  });

  it('refuses a destination its paramsSchema does not have', () => {
    refused(withSecret({ token: ['uri'], 'auth.key': [] }), /has no property "uri"/);
    refused(withSecret({ token: [''], 'auth.key': [] }), /has no property ""/);
  });

  it('accepts [] for a secret that goes only to the device, and a nested destination', () => {
    const c = new SensorCatalogue().register(
      withSecret({ token: ['url', 'auth.user'], 'auth.key': [] }),
    );
    const stored = { url: 'https://a.example', token: 't', auth: { user: 'u', key: 'k' } };

    const same = { url: 'https://a.example', auth: { user: 'u' } };
    assert.deepEqual(c.secretsLeftBehind('icmp.ping', same, stored), []);
    assert.deepEqual(c.carryWriteOnly('icmp.ping', same, stored), stored);
    const moved = { url: 'https://a.example', auth: { user: 'someone-else' } };
    assert.deepEqual(c.secretsLeftBehind('icmp.ping', moved, stored), ['token']);
    assert.deepEqual(c.carryWriteOnly('icmp.ping', moved, stored), {
      url: 'https://a.example',
      auth: { user: 'someone-else', key: 'k' },
    });
  });

  it('binds every shipped SNMP type’s community and keys to its port', () => {
    const c = standardCatalogue();
    const snmp = c.ids().filter((id) => c.writeOnlyPaths(id).includes('community'));
    assert.ok(snmp.length >= 8, 'the SNMP polling types carry a community in their parameters');
    for (const id of snmp) {
      assert.deepEqual([...c.writeOnlyPaths(id)].sort(), ['authKey', 'community', 'privKey'], id);
      const stored = { version: 'v3', community: 'c', authKey: 'a', privKey: 'p', port: 161 };
      assert.deepEqual(
        c.secretsLeftBehind(id, { version: 'v3', timeoutMs: 9_000 }, stored),
        [],
        id,
      );
      assert.deepEqual(
        [...c.secretsLeftBehind(id, { version: 'v3', port: 1161 }, stored)].sort(),
        ['authKey', 'community', 'privKey'],
        `${id}: a listener on another port is not where they were set for`,
      );
    }
  });

  it('refuses a type that uses a credential kind without saying where the set goes (A-41)', () => {
    const credentialed = (secretDestinations?: Readonly<Record<string, readonly string[]>>) =>
      variant({
        credentialKinds: ['ssh'],
        ...(secretDestinations === undefined ? {} : { secretDestinations }),
        paramsSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { port: { type: 'integer', default: 22 } },
        },
      });
    refused(credentialed(), /uses the "ssh" credential kind but does not say where it is sent/);
    refused(
      credentialed({ 'kind:ssh': [], 'kind:snmp': [] }),
      /where "kind:snmp" is sent, but it does not use that credential kind/,
    );
    refused(credentialed({ 'kind:ssh': ['portt'] }), /has no property "portt"/);
    assert.doesNotThrow(() => new SensorCatalogue().register(credentialed({ 'kind:ssh': [] })));
  });

  it('gives a sensor’s destination for a kind as its declared fields, sorted (A-41)', () => {
    const c = standardCatalogue();
    assert.deepEqual(
      c.credentialDestination('http.advanced', 'http', {
        verifyTls: false,
        scheme: 'https',
        port: 8443,
        path: '/not-a-destination',
      }),
      [
        ['port', 8443],
        ['scheme', 'https'],
        ['verifyTls', false],
      ],
    );
    assert.deepEqual(c.credentialDestination('ssh.load', 'snmp', { port: 22 }), [], 'not its kind');
    assert.deepEqual(
      c.credentialDestination('windows.cpu', 'windows', { host: '' }),
      [
        ['authentication', null],
        ['host', ''],
      ],
      'a field left out reads as null rather than disappearing',
    );
  });

  it('has every shipped type that uses a credential kind say where it goes (A-41)', () => {
    const c = standardCatalogue();
    for (const id of c.ids()) {
      for (const kind of c.declaration(id).credentialKinds ?? []) {
        assert.ok(
          Object.hasOwn(c.type(id).secretDestinations ?? {}, `kind:${kind}`),
          `${id} uses ${kind}`,
        );
      }
    }
  });

  it('reads a destination left out at its default as unchanged, the way it was stored', () => {
    const c = new SensorCatalogue().register(withSecret({ token: ['url'], 'auth.key': [] }));
    const stored = { url: '', token: 't', timeoutMs: 5_000 };
    assert.deepEqual(c.secretsLeftBehind('icmp.ping', { timeoutMs: 9_000 }, stored), []);
    assert.equal(c.carryWriteOnly('icmp.ping', { timeoutMs: 9_000 }, stored)['token'], 't');
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
      'flow.netflow',
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

  describe('the v1 build profile (`H-12`)', () => {
    // Named here rather than read back from `WITHHELD_FROM_V1`, so that withholding one more type,
    // or putting one back, is a line somebody has to change in a test as well as in the list.
    const withheld = [
      'flow.netflow',
      'windows.cpu',
      'windows.memory',
      'windows.service',
      'windows.volume',
    ];

    it('carries everything but flow and the Windows types', () => {
      const full = standardCatalogue(sensorTypesFor('full')).ids();
      const v1 = standardCatalogue(sensorTypesFor('v1')).ids();
      assert.deepEqual(
        full.filter((id) => !v1.includes(id)),
        withheld,
      );
      // And nothing in v1 that the full build lacks: a profile only ever takes away.
      assert.deepEqual(
        v1.filter((id) => !full.includes(id)),
        [],
      );
      assert.deepEqual([...WITHHELD_FROM_V1.keys()].sort(), withheld);
    });

    it('carries everything in the full profile, the working tree’s', () => {
      assert.deepEqual(standardCatalogue(sensorTypesFor('full')).ids(), standardCatalogue().ids());
    });

    it('says why a withheld type is missing, and only in v1', () => {
      for (const id of withheld) {
        assert.ok(withheldReason('v1', id), `${id} is withheld without a reason`);
        assert.equal(withheldReason('full', id), undefined);
      }
      assert.match(withheldReason('v1', 'windows.cpu') ?? '', /Windows is release 1\.1/);
      assert.match(withheldReason('v1', 'flow.netflow') ?? '', /flow monitoring is v2/);
      // A type nobody ever built is unknown, not withheld.
      assert.equal(withheldReason('v1', 'nope.missing'), undefined);
      assert.equal(withheldReason('v1', 'icmp.ping'), undefined);
    });
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

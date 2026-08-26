import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareOids,
  describeCredentials,
  formatOid,
  indexUnder,
  isPrefixOf,
  normaliseOid,
  OidError,
  parseOid,
  readCredentials,
  SnmpCredentialError,
  snmpParamsSchema,
  SNMP_CREDENTIAL_SCHEMA,
} from '../src/support/snmp/index.js';

describe('reading v1 and v2c credentials', () => {
  it('defaults to v2c, which is what devices speak', () => {
    const credentials = readCredentials({ community: 'public' });
    assert.deepEqual(credentials, { version: 'v2c', community: 'public' });
  });

  it('takes v1 when it is asked for', () => {
    assert.deepEqual(readCredentials({ version: 'v1', community: 'public' }), {
      version: 'v1',
      community: 'public',
    });
  });

  it('refuses a missing community rather than sending an empty one', () => {
    // An agent answers a wrong community with silence, so this would surface as a timeout
    // against a device that is up — the least diagnosable failure SNMP has.
    assert.throws(() => readCredentials({ version: 'v2c' }), SnmpCredentialError);
    assert.throws(() => readCredentials({ version: 'v2c', community: '' }), /needs a community/);
  });

  it('refuses a version that is not one', () => {
    assert.throws(() => readCredentials({ version: 'v2', community: 'x' }), /not an SNMP version/);
  });

  it('refuses a community that is not a string', () => {
    assert.throws(() => readCredentials({ community: 42 }), /must be a string/);
  });
});

describe('reading v3 credentials', () => {
  const base = { version: 'v3', username: 'ops' };

  it('defaults to authPriv with sha and aes', () => {
    // The safe end of the range. A default of noAuthNoPriv would silently downgrade anybody who
    // did not set a level, which is the wrong way round for a security setting.
    const credentials = readCredentials({ ...base, authKey: 'auth-key', privKey: 'priv-key' });
    assert.deepEqual(credentials, {
      version: 'v3',
      username: 'ops',
      level: 'authPriv',
      authProtocol: 'sha',
      authKey: 'auth-key',
      privProtocol: 'aes',
      privKey: 'priv-key',
    });
  });

  it('keeps the protocols it is given', () => {
    const credentials = readCredentials({
      ...base,
      level: 'authPriv',
      authProtocol: 'sha256',
      authKey: 'a',
      privProtocol: 'aes256b',
      privKey: 'p',
    });
    assert.equal(credentials.version === 'v3' && credentials.authProtocol, 'sha256');
    assert.equal(credentials.version === 'v3' && credentials.privProtocol, 'aes256b');
  });

  it('needs a user name', () => {
    assert.throws(() => readCredentials({ version: 'v3' }), /needs a user name/);
  });

  it('needs an authentication key at authNoPriv and authPriv', () => {
    assert.throws(
      () => readCredentials({ ...base, level: 'authNoPriv' }),
      /needs an authentication key/,
    );
    assert.throws(
      () => readCredentials({ ...base, level: 'authPriv', privKey: 'p' }),
      /needs an authentication key/,
    );
  });

  it('needs a privacy key at authPriv', () => {
    assert.throws(
      () => readCredentials({ ...base, level: 'authPriv', authKey: 'a' }),
      /needs a privacy key/,
    );
  });

  it('refuses keys the level would not send, rather than ignoring them', () => {
    // The failure this prevents: a key that is set and unused looks exactly like a key that is
    // set and used, so the sensor keeps failing authentication with nobody suspecting the level.
    assert.throws(
      () => readCredentials({ ...base, level: 'noAuthNoPriv', authKey: 'a' }),
      /sends no authentication key/,
    );
    assert.throws(
      () => readCredentials({ ...base, level: 'authNoPriv', authKey: 'a', privKey: 'p' }),
      /encrypts nothing/,
    );
  });

  it('drops the keys at noAuthNoPriv entirely', () => {
    const credentials = readCredentials({ ...base, level: 'noAuthNoPriv' });
    assert.deepEqual(credentials, { version: 'v3', username: 'ops', level: 'noAuthNoPriv' });
  });

  it('refuses a protocol this build does not implement', () => {
    assert.throws(
      () => readCredentials({ ...base, level: 'authNoPriv', authKey: 'a', authProtocol: 'sha3' }),
      /not an authentication protocol/,
    );
    assert.throws(
      () =>
        readCredentials({
          ...base,
          level: 'authPriv',
          authKey: 'a',
          privKey: 'p',
          privProtocol: 'blowfish',
        }),
      /not a privacy protocol/,
    );
  });

  it('carries a context only when one was given', () => {
    const without = readCredentials({ ...base, level: 'noAuthNoPriv' });
    assert.equal('context' in without, false);
    const with_ = readCredentials({ ...base, level: 'noAuthNoPriv', context: 'vrf-a' });
    assert.equal(with_.version === 'v3' && with_.context, 'vrf-a');
  });
});

describe('describing credentials', () => {
  it('never includes the secret', () => {
    // This string goes into log lines and error messages.
    assert.equal(describeCredentials({ version: 'v2c', community: 'top-secret' }), 'v2c');
    const described = describeCredentials({
      version: 'v3',
      username: 'ops',
      level: 'authPriv',
      authKey: 'top-secret',
      privKey: 'also-secret',
    });
    assert.equal(described, 'v3 user ops (authPriv)');
    assert.equal(described.includes('secret'), false);
  });
});

describe('the shared schema', () => {
  it('marks every secret write-only', () => {
    for (const key of ['community', 'authKey', 'privKey']) {
      assert.equal(
        SNMP_CREDENTIAL_SCHEMA[key]?.['writeOnly'],
        true,
        `${key} must be write-only, or the API returns it`,
      );
    }
  });

  it('keeps every secret a plain property, never inside a combinator', () => {
    // The catalogue refuses to register a type with a `writeOnly` inside oneOf/anyOf/allOf,
    // because the redactor cannot know which branch matched. The natural shape here *is* a union
    // — community for v1/v2c, user and keys for v3 — so this is the constraint most likely to be
    // broken by somebody tidying the schema up.
    const schema = snmpParamsSchema() as { properties: Record<string, Record<string, unknown>> };
    for (const key of ['community', 'authKey', 'privKey']) {
      const property = schema.properties[key];
      assert.ok(property, `${key} should be a plain property of the schema`);
      assert.equal(property['writeOnly'], true);
    }
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      assert.equal(
        combinator in schema,
        false,
        `${combinator} would make the secrets unredactable`,
      );
    }
  });

  it('composes a type’s own parameters alongside the shared ones', () => {
    const schema = snmpParamsSchema({ oid: { type: 'string' } }, ['oid']) as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.ok('oid' in schema.properties);
    assert.ok('community' in schema.properties);
    assert.ok('timeoutMs' in schema.properties);
    assert.deepEqual(schema.required, ['oid']);
    assert.equal(schema.additionalProperties, false);
  });
});

describe('OIDs', () => {
  it('parses and normalises, dropping a leading dot', () => {
    assert.deepEqual(parseOid('.1.3.6.1'), [1, 3, 6, 1]);
    assert.equal(normaliseOid(' .1.3.6.1.2.1.1.1.0 '), '1.3.6.1.2.1.1.1.0');
    assert.equal(formatOid([1, 3, 6]), '1.3.6');
  });

  it('refuses what is not an OID rather than querying something else', () => {
    assert.throws(() => parseOid(''), OidError);
    assert.throws(() => parseOid('1.3.six.1'), /not a number/);
    assert.throws(() => parseOid('1.3..1'), /not a number/);
    assert.throws(() => parseOid('1.3.9999999999999.1'), /too large/);
  });

  it('answers prefixes arc by arc, not by text', () => {
    // The bug this is here for: '1.3.6.1.2.1.2' is not a prefix of '1.3.6.1.2.1.25', but its
    // *text* is — a walk using startsWith returns a neighbouring subtree as if it were the one
    // that was asked for.
    const ifTable = parseOid('1.3.6.1.2.1.2');
    assert.equal(isPrefixOf(ifTable, parseOid('1.3.6.1.2.1.2.2.1.2.1')), true);
    assert.equal(isPrefixOf(ifTable, parseOid('1.3.6.1.2.1.25.1.1.0')), false);
    assert.equal(isPrefixOf(ifTable, ifTable), true);
    assert.equal(isPrefixOf(parseOid('1.3.6.1.2.1.2.2'), ifTable), false);
  });

  it('orders the way SNMP walks', () => {
    assert.ok(compareOids(parseOid('1.3.6.1.2'), parseOid('1.3.6.1.10')) < 0);
    assert.ok(compareOids(parseOid('1.3.6.1.10'), parseOid('1.3.6.1.2')) > 0);
    assert.equal(compareOids(parseOid('1.3.6.1'), parseOid('1.3.6.1')), 0);
    assert.ok(compareOids(parseOid('1.3.6.1'), parseOid('1.3.6.1.1')) < 0);
  });

  it('gives a row index below a table column', () => {
    assert.deepEqual(
      indexUnder(parseOid('1.3.6.1.2.1.2.2.1.2'), parseOid('1.3.6.1.2.1.2.2.1.2.3')),
      [3],
    );
    // A composite index — every arc of it, not just the first.
    assert.deepEqual(
      indexUnder(parseOid('1.3.6.1.2.1.4.22.1.2'), parseOid('1.3.6.1.2.1.4.22.1.2.5.10.0.0.1')),
      [5, 10, 0, 0, 1],
    );
    // Not under it at all is null, not row zero — the end of a table, not its first row.
    assert.equal(indexUnder(parseOid('1.3.6.1.2.1.2'), parseOid('1.3.6.1.2.1.25.1')), null);
  });
});

import { createHash } from 'node:crypto';

/**
 * What it takes to talk to an agent, and nothing about where it came from.
 *
 * **Deliberately an input to this layer rather than something it reads out of `params`.** SNMP
 * credentials belong on the *device*, inherited by every sensor under it (`CAPABILITIES.MD §10`,
 * and `credential_set` has existed since migration 001) — retyping a community string on forty
 * sensors and rotating it in forty places is the thing inheritance exists to prevent. The write
 * and decrypt half of that is `A-05`, which is still in Phase 9. Taking resolved credentials as
 * an argument means this layer is already correct for both: today a sensor type passes what its
 * own `writeOnly` parameters hold, and when `A-05` lands the caller changes and nothing here
 * does.
 */
export type SnmpVersion = 'v1' | 'v2c' | 'v3';

/** USM authentication. The names are `net-snmp`'s, which are the RFC's. */
export type SnmpAuthProtocol = 'md5' | 'sha' | 'sha224' | 'sha256' | 'sha384' | 'sha512';

/**
 * USM privacy.
 *
 * `aes256b` and `aes256r` are the two incompatible ways vendors extended AES to 256-bit keys —
 * Blumenthal and Reeder respectively. They are not interchangeable, there is no way to detect
 * which an agent wants, and picking the wrong one fails as a decryption error rather than as
 * anything readable. Both are offered because devices in the field disagree.
 */
export type SnmpPrivProtocol = 'des' | 'aes' | 'aes256b' | 'aes256r';

export type SnmpSecurityLevel = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';

export interface SnmpCommunityCredentials {
  readonly version: 'v1' | 'v2c';
  readonly community: string;
}

export interface SnmpV3Credentials {
  readonly version: 'v3';
  readonly username: string;
  readonly level: SnmpSecurityLevel;
  readonly authProtocol?: SnmpAuthProtocol;
  readonly authKey?: string;
  readonly privProtocol?: SnmpPrivProtocol;
  readonly privKey?: string;
  /** Context name, for an agent that proxies several contexts. Empty is the default context. */
  readonly context?: string;
}

export type SnmpCredentials = SnmpCommunityCredentials | SnmpV3Credentials;

export class SnmpCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnmpCredentialError';
  }
}

const VERSIONS = new Set<string>(['v1', 'v2c', 'v3']);
const LEVELS = new Set<string>(['noAuthNoPriv', 'authNoPriv', 'authPriv']);
const AUTH = new Set<string>(['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512']);
const PRIV = new Set<string>(['des', 'aes', 'aes256b', 'aes256r']);

function text(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new SnmpCredentialError(`"${key}" must be a string`);
  }
  return value;
}

/**
 * Credentials from a plain record — a sensor's parameters, or `A-05`'s decrypted secret.
 *
 * **Checked here as well as in the schema, and the duplication is the point.** A JSON Schema can
 * say `authKey` is a string; expressing "required when `level` is `authNoPriv` or `authPriv`,
 * forbidden when it is not" takes a nest of `if`/`then` that nobody reads and everybody copies
 * wrong into the next SNMP type. Saying it once here means every SNMP sensor gets the same
 * answer, and gets it as a sentence rather than as a failed decryption twenty seconds later.
 */
export function readCredentials(params: Readonly<Record<string, unknown>>): SnmpCredentials {
  const version = text(params, 'version') ?? 'v2c';
  if (!VERSIONS.has(version)) {
    throw new SnmpCredentialError(`"${version}" is not an SNMP version: use v1, v2c or v3`);
  }

  if (version !== 'v3') {
    const community = text(params, 'community') ?? '';
    if (community === '') {
      throw new SnmpCredentialError(`SNMP ${version} needs a community string`);
    }
    return { version: version as 'v1' | 'v2c', community };
  }

  const username = text(params, 'username') ?? '';
  if (username === '') {
    throw new SnmpCredentialError('SNMPv3 needs a user name');
  }

  const level = text(params, 'level') ?? 'authPriv';
  if (!LEVELS.has(level)) {
    throw new SnmpCredentialError(
      `"${level}" is not a security level: use noAuthNoPriv, authNoPriv or authPriv`,
    );
  }
  const security = level as SnmpSecurityLevel;
  const wantsAuth = security !== 'noAuthNoPriv';
  const wantsPriv = security === 'authPriv';

  const authProtocol = text(params, 'authProtocol');
  const authKey = text(params, 'authKey');
  const privProtocol = text(params, 'privProtocol');
  const privKey = text(params, 'privKey');

  if (wantsAuth) {
    if (authKey === undefined || authKey === '') {
      throw new SnmpCredentialError(`SNMPv3 at ${security} needs an authentication key`);
    }
    if (authProtocol !== undefined && !AUTH.has(authProtocol)) {
      throw new SnmpCredentialError(
        `"${authProtocol}" is not an authentication protocol: use ${[...AUTH].join(', ')}`,
      );
    }
  } else if (authKey !== undefined && authKey !== '') {
    // Refused rather than ignored. A key that is set and unused looks exactly like a key that is
    // set and used, and the sensor would keep failing authentication with the level nobody
    // noticed was wrong.
    throw new SnmpCredentialError(
      'SNMPv3 at noAuthNoPriv sends no authentication key — remove it or raise the level',
    );
  }

  if (wantsPriv) {
    if (privKey === undefined || privKey === '') {
      throw new SnmpCredentialError('SNMPv3 at authPriv needs a privacy key');
    }
    if (privProtocol !== undefined && !PRIV.has(privProtocol)) {
      throw new SnmpCredentialError(
        `"${privProtocol}" is not a privacy protocol: use ${[...PRIV].join(', ')}`,
      );
    }
  } else if (privKey !== undefined && privKey !== '') {
    throw new SnmpCredentialError(
      `SNMPv3 at ${security} encrypts nothing — remove the privacy key or raise the level`,
    );
  }

  return {
    version: 'v3',
    username,
    level: security,
    ...(wantsAuth ? { authProtocol: (authProtocol ?? 'sha') as SnmpAuthProtocol } : {}),
    ...(wantsAuth && authKey !== undefined ? { authKey } : {}),
    ...(wantsPriv ? { privProtocol: (privProtocol ?? 'aes') as SnmpPrivProtocol } : {}),
    ...(wantsPriv && privKey !== undefined ? { privKey } : {}),
    ...(() => {
      const context = text(params, 'context');
      return context === undefined || context === '' ? {} : { context };
    })(),
  };
}

/**
 * A stable key for "the same credentials", safe to keep in a Map and to print.
 *
 * **Hashed, because the pool's key would otherwise be the secret.** A plain
 * `v2c:public@host:161` key is a community string sitting in a data structure that any error
 * message, heap dump or debug log could reach, and CLAUDE.md's rule is that a monitored device's
 * credentials do not leave the place they are used. A digest keys the pool exactly as well: two
 * sensors share a session when their credentials match, and a rotated community produces a
 * different fingerprint and therefore a new session, which is the behaviour that matters.
 */
/**
 * The field separator inside a fingerprint's input.
 *
 * A character that cannot occur in any of the fields, written as an escape so this file stays
 * text rather than a literal control byte git treats as binary. A space would leave the parts
 * ambiguous: a user named `ops authPriv` and a user named `ops` at level `authPriv` would hash
 * to the same value, and therefore share a session.
 */
const SEPARATOR = '\u0000';

export function credentialFingerprint(credentials: SnmpCredentials): string {
  const hash = createHash('sha256');
  if (credentials.version === 'v3') {
    hash.update(
      [
        'v3',
        credentials.username,
        credentials.level,
        credentials.authProtocol ?? '',
        credentials.authKey ?? '',
        credentials.privProtocol ?? '',
        credentials.privKey ?? '',
        credentials.context ?? '',
      ].join(SEPARATOR),
    );
  } else {
    hash.update([credentials.version, credentials.community].join(SEPARATOR));
  }
  // Sixteen hex characters is 64 bits. The pool holds tens of entries, not billions, and a
  // collision would only mean two sets of credentials sharing a socket on one probe.
  return hash.digest('hex').slice(0, 16);
}

/** How to describe a session in a log or an error, with nothing secret in it. */
export function describeCredentials(credentials: SnmpCredentials): string {
  return credentials.version === 'v3'
    ? `v3 user ${credentials.username} (${credentials.level})`
    : credentials.version;
}

import { createHash } from 'node:crypto';
import type { HostKeyPolicy } from './host-key.js';

/**
 * The SSH credential set, as `A-05` resolved it for a sensor (`T-07`).
 *
 * Same shape and the same reasoning as the SNMP one: a flat record arrives from the vault, this
 * turns it into a discriminated union or throws a sentence, and nothing here is ever logged.
 * The union is decided by *what was filled in* rather than by a stored `method` field, because
 * the form is flat — the catalogue refuses a `writeOnly` inside a combinator, so the schema
 * cannot express "password or key" and this function has to.
 */

export type SshAuthMethod = 'password' | 'key';

interface SshCredentialsBase {
  readonly username: string;
  readonly hostKeyPolicy: HostKeyPolicy;
  /**
   * Every server key this set may be used with, `SHA256:…` each (`acceptedHostKeys`). Empty when
   * nothing has been recorded yet. Public, not a secret.
   */
  readonly hostKeys: readonly string[];
}

export interface SshPasswordCredentials extends SshCredentialsBase {
  readonly method: 'password';
  readonly password: string;
}

export interface SshKeyCredentials extends SshCredentialsBase {
  readonly method: 'key';
  /** PEM or OpenSSH format, as pasted. */
  readonly privateKey: string;
  readonly passphrase: string | undefined;
}

export type SshCredentials = SshPasswordCredentials | SshKeyCredentials;

export class SshCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshCredentialError';
  }
}

const text = (values: Readonly<Record<string, unknown>>, key: string): string => {
  const value = values[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** As above, but keeping interior whitespace — a private key is newline-significant. */
const block = (values: Readonly<Record<string, unknown>>, key: string): string => {
  const value = values[key];
  return typeof value === 'string' ? value : '';
};

/**
 * The server keys a set may be used with (`A-41b`): its one `hostKeyFingerprint` and every entry
 * of `hostKeys`, trimmed, without the empty ones, each once.
 *
 * **The only place the two are put together.** The transport checks a server against this, and
 * the vault and the probe configuration read the same list to decide whether a set is bound by
 * its keys (`restrictionOf`), so what a set is sent on and what the probe accepts cannot drift.
 */
export function acceptedHostKeys(values: Readonly<Record<string, unknown>>): string[] {
  const listed = Array.isArray(values['hostKeys']) ? (values['hostKeys'] as unknown[]) : [];
  const keys = [values['hostKeyFingerprint'], ...listed]
    .filter((key): key is string => typeof key === 'string')
    .map((key) => key.trim())
    .filter((key) => key !== '');
  return [...new Set(keys)];
}

/**
 * Reads a stored credential set, or says what is missing.
 *
 * **A key beats a password when both are set**, rather than being an error. An operator moving a
 * device from password to key authentication fills in the key and expects it to be used; failing
 * because the old password is still there would make the safer change the harder one. The
 * message says which was chosen.
 */
export function readCredentials(values: Readonly<Record<string, unknown>>): SshCredentials {
  const username = text(values, 'username');
  if (username === '') {
    throw new SshCredentialError('this SSH credential has no user name');
  }

  const policyRaw = text(values, 'hostKeyPolicy');
  const hostKeyPolicy: HostKeyPolicy = policyRaw === 'accept-any' ? 'accept-any' : 'strict';
  const hostKeys = acceptedHostKeys(values);

  const privateKey = block(values, 'privateKey');
  if (privateKey.trim() !== '') {
    const passphrase = block(values, 'passphrase');
    return {
      method: 'key',
      username,
      privateKey,
      passphrase: passphrase === '' ? undefined : passphrase,
      hostKeyPolicy,
      hostKeys,
    };
  }

  const password = block(values, 'password');
  if (password === '') {
    throw new SshCredentialError(
      `the SSH credential for "${username}" has neither a password nor a private key`,
    );
  }
  return { method: 'password', username, password, hostKeyPolicy, hostKeys };
}

// Written as an escape, not as a literal byte. A raw NUL in a source file is invisible in
// every editor, survives a diff unremarked, and makes some tools treat the file as binary —
// which is how the same character ended up in a `split(' ')` elsewhere and silently matched
// nothing (`S-17`). The value is unchanged.
const SEPARATOR = '\0';

/**
 * A digest identifying these credentials, for pooling.
 *
 * The pool keys connections by it so that rotating a password opens a new connection instead of
 * reusing one authenticated as the old identity — and so that the key it stores is not the
 * secret. Truncated because a pool key is not a security boundary; the full digest of a private
 * key would be a durable identifier for it in memory for no benefit.
 */
export function credentialFingerprint(credentials: SshCredentials): string {
  const parts =
    credentials.method === 'key'
      ? ['key', credentials.username, credentials.privateKey, credentials.passphrase ?? '']
      : ['password', credentials.username, credentials.password];
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex').slice(0, 16);
}

/** What a message may say about these credentials. Never the secret, and never the key. */
export function describeCredentials(credentials: SshCredentials): string {
  return credentials.method === 'key'
    ? `${credentials.username} with a private key`
    : `${credentials.username} with a password`;
}

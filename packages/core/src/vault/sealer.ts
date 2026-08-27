import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@ms/shared';
import type { VaultKeyring } from './keyring.js';

/**
 * Encryption for monitored-device credentials (`A-05`).
 *
 * AES-256-GCM, from Node's own `crypto` — no dependency, and an authenticated mode, which is the
 * part that matters. A ciphertext that is merely confidential can be *altered*: swap the bytes of
 * an SNMP community for another row's and the probe authenticates as something else without
 * anything noticing. GCM's tag means a modified record fails to open rather than opening as
 * something different.
 *
 * **The associated data binds a record to where it lives.** Object id, credential kind and the
 * record's own version go into the AAD but not the ciphertext, so a `secret` column value lifted
 * from one row into another fails to authenticate. Without it, an operator with database access
 * could grant a device the credentials of any other device by copying a cell — an attack that
 * needs no key at all.
 */

/** The record layout, so an old record stays readable when a newer format arrives. */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultSealError extends AppError {
  constructor(message: string, context: Record<string, string | number> = {}) {
    super('VAULT_SEAL_FAILED', message, { context });
    this.name = 'VaultSealError';
  }
}

/** What a sealed record is bound to. Not stored inside it — it is what proves where it belongs. */
export interface SealScope {
  readonly objectId: number;
  readonly kind: string;
}

export interface SealedRecord {
  readonly bytes: Buffer;
  readonly keyId: string;
}

function aad(scope: SealScope): Buffer {
  return Buffer.from(`v${String(VERSION)}:${String(scope.objectId)}:${scope.kind}`, 'utf8');
}

/**
 * Turns a credential's secret half into bytes for `credential_set.secret`.
 *
 * The plaintext is JSON of only the `writeOnly` fields; everything an operator may read back
 * lives in `public_params` beside it, in the clear, where a list view can show it.
 */
export class VaultSealer {
  readonly #keyring: VaultKeyring;

  constructor(keyring: VaultKeyring) {
    this.#keyring = keyring;
  }

  get currentKeyId(): string {
    return this.#keyring.currentId;
  }

  seal(secret: Readonly<Record<string, unknown>>, scope: SealScope): SealedRecord {
    const { id, key } = this.#keyring.current();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(scope));
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(secret), 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      bytes: Buffer.concat([Buffer.from([VERSION]), iv, tag, body]),
      keyId: id,
    };
  }

  open(record: Buffer, keyId: string, scope: SealScope): Record<string, unknown> {
    if (record.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new VaultSealError(
        `the stored credential for object ${String(scope.objectId)} (${scope.kind}) is ` +
          'truncated — it is shorter than a header',
        { objectId: scope.objectId, kind: scope.kind },
      );
    }
    const version = record[0];
    if (version !== VERSION) {
      throw new VaultSealError(
        `the stored credential for object ${String(scope.objectId)} (${scope.kind}) is format ` +
          `${String(version)}, and this build understands ${String(VERSION)}`,
        { objectId: scope.objectId, kind: scope.kind },
      );
    }

    const iv = record.subarray(1, 1 + IV_BYTES);
    const tag = record.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = record.subarray(1 + IV_BYTES + TAG_BYTES);

    const key = this.#keyring.byId(keyId);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(scope));
    decipher.setAuthTag(tag);

    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // Deliberately one message for every failure mode. Wrong key, altered ciphertext and a
      // record moved to another row are indistinguishable to GCM by design, and inventing a
      // distinction here would be guessing — the useful detail is which row could not be read.
      throw new VaultSealError(
        `the stored credential for object ${String(scope.objectId)} (${scope.kind}) could not ` +
          'be decrypted: it was encrypted with a different key, altered, or copied from another ' +
          'object',
        { objectId: scope.objectId, kind: scope.kind, keyId },
      );
    }

    try {
      const parsed: unknown = JSON.parse(plain.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, unknown>;
    } catch {
      /* c8 ignore next 5 -- only reachable if a sealed record was written by something else */
      throw new VaultSealError(
        `the stored credential for object ${String(scope.objectId)} (${scope.kind}) decrypted ` +
          'to something that is not a credential',
        { objectId: scope.objectId, kind: scope.kind },
      );
    }
  }

  /** Whether a record already uses the current key — what a rotation pass walks on. */
  isCurrent(keyId: string): boolean {
    const a = Buffer.from(keyId);
    const b = Buffer.from(this.#keyring.currentId);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
